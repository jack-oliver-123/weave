import type { Readable, Writable } from 'node:stream';
import type { CredentialStore } from '../security/credential-broker.js';

export interface CredentialCommand {
  readonly operation: 'set' | 'delete' | 'list';
  readonly reference?: string;
}

export async function runCredentialCommand(
  command: CredentialCommand,
  store: CredentialStore,
  input: NodeJS.ReadStream = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  if (command.operation === 'list') {
    const metadata = await store.list();
    for (const item of metadata) output.write(`${item.reference}\t${new Date(item.updatedAt).toISOString()}\n`);
    return;
  }
  const reference = command.reference;
  if (reference === undefined) throw new TypeError('Credential reference is required');
  if (command.operation === 'delete') {
    output.write(await store.delete(reference) ? `Deleted ${reference}\n` : `Not found: ${reference}\n`);
    return;
  }
  const secret = await readSecret(input, process.stderr);
  try {
    await store.set(reference, secret);
    output.write(`Stored ${reference}\n`);
  } finally {
    secret.fill(0);
  }
}

export async function readSecret(input: NodeJS.ReadStream, promptOutput: Writable): Promise<Buffer> {
  if (!input.isTTY) return readPipedSecret(input);
  if (typeof input.setRawMode !== 'function') throw new Error('HIDDEN_INPUT_UNAVAILABLE');
  promptOutput.write('Credential: ');
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      promptOutput.write('\n');
      if (error !== undefined) reject(error);
      else {
        const value = Buffer.concat(chunks);
        chunks.forEach((chunk) => chunk.fill(0));
        if (value.byteLength === 0) reject(new Error('Credential secret must not be empty'));
        else resolve(value);
      }
    };
    const onData = (chunk: Buffer) => {
      if (chunk.includes(3)) { finish(new Error('Credential input cancelled')); return; }
      const newline = chunk.findIndex((value) => value === 10 || value === 13);
      if (newline >= 0) { if (newline > 0) chunks.push(Buffer.from(chunk.subarray(0, newline))); finish(); return; }
      size += chunk.byteLength;
      if (size > 64 * 1024) { finish(new Error('Credential secret is too large')); return; }
      chunks.push(Buffer.from(chunk));
    };
    input.on('data', onData);
  });
}

async function readPipedSecret(input: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
    size += bytes.byteLength;
    if (size > 64 * 1024) throw new Error('Credential secret is too large');
    chunks.push(bytes);
  }
  const combined = Buffer.concat(chunks);
  chunks.forEach((chunk) => chunk.fill(0));
  let end = combined.byteLength;
  while (end > 0 && (combined[end - 1] === 10 || combined[end - 1] === 13)) end -= 1;
  if (end === 0) { combined.fill(0); throw new Error('Credential secret must not be empty'); }
  const value = Buffer.from(combined.subarray(0, end));
  combined.fill(0);
  return value;
}

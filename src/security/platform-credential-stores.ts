import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { CredentialMetadata, CredentialStore } from './credential-broker.js';
import { validateReference } from './credential-broker.js';

export interface NativeCommandResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export class UnavailableCredentialStore implements CredentialStore {
  async set(): Promise<void> { throw new Error('CREDENTIAL_STORE_UNAVAILABLE'); }
  async delete(): Promise<boolean> { throw new Error('CREDENTIAL_STORE_UNAVAILABLE'); }
  async list(): Promise<readonly CredentialMetadata[]> { throw new Error('CREDENTIAL_STORE_UNAVAILABLE'); }
  async withSecret<T>(): Promise<T> { throw new Error('CREDENTIAL_STORE_UNAVAILABLE'); }
}

export type NativeCommandRunner = (
  executable: string,
  args: readonly string[],
  stdin: Uint8Array,
) => Promise<NativeCommandResult>;

export const runNativeCredentialCommand: NativeCommandRunner = (executable, args, stdin) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: credentialCommandEnvironment(),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.once('error', reject);
  child.once('close', (status) => resolve({
    status: status ?? -1,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  }));
  child.stdin.end(stdin);
});

export class WindowsCredentialManagerStore implements CredentialStore {
  constructor(private readonly run: NativeCommandRunner = runNativeCredentialCommand) {}

  async set(reference: string, secret: Uint8Array): Promise<void> {
    validateSecret(reference, secret);
    await this.invoke({ operation: 'set', reference, secret: Buffer.from(secret).toString('base64') });
  }

  async delete(reference: string): Promise<boolean> {
    validateReference(reference);
    const result = await this.invoke({ operation: 'delete', reference }) as { deleted: boolean };
    return result.deleted;
  }

  async list(): Promise<readonly CredentialMetadata[]> {
    const result = await this.invoke({ operation: 'list' }) as { credentials?: CredentialMetadata[] };
    return Object.freeze((result.credentials ?? []).map((item) => Object.freeze({ ...item })));
  }

  async withSecret<T>(reference: string, operation: (secret: Uint8Array) => Promise<T>): Promise<T> {
    validateReference(reference);
    const result = await this.invoke({ operation: 'get', reference }) as { secret: string };
    const secret = Buffer.from(result.secret, 'base64');
    try { return await operation(secret); }
    finally { secret.fill(0); }
  }

  private async invoke(input: object): Promise<unknown> {
    if (platform() !== 'win32') throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
    const bytes = Buffer.from(JSON.stringify(input), 'utf8');
    const result = await this.run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREDENTIAL_SCRIPT], bytes);
    bytes.fill(0);
    if (result.status !== 0) throw new Error(classifyCredentialCommandError(result.stderr));
    try { return JSON.parse(result.stdout.toString('utf8')) as unknown; }
    catch { throw new Error('CREDENTIAL_STORE_PROTOCOL_ERROR'); }
  }
}

export class LinuxSecretServiceStore implements CredentialStore {
  constructor(private readonly run: NativeCommandRunner = runNativeCredentialCommand) {}

  async set(reference: string, secret: Uint8Array): Promise<void> {
    validateSecret(reference, secret);
    const result = await this.run('secret-tool', ['store', '--label=Weave credential', 'application', 'weave', 'reference', reference], secret);
    if (result.status !== 0) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
  }

  async delete(reference: string): Promise<boolean> {
    validateReference(reference);
    const existing = await this.has(reference);
    if (!existing) return false;
    const result = await this.run('secret-tool', ['clear', 'application', 'weave', 'reference', reference], new Uint8Array());
    if (result.status !== 0) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
    return true;
  }

  async list(): Promise<readonly CredentialMetadata[]> {
    const result = await this.run('secret-tool', ['search', '--all', 'application', 'weave'], new Uint8Array());
    if (result.status !== 0) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
    const matches = [...result.stdout.toString('utf8').matchAll(/attribute\.reference\s*=\s*([^\r\n]+)/g)];
    return Object.freeze([...new Set(matches.map((match) => match[1]!.trim()))].sort().map((reference) => Object.freeze({
      reference, createdAt: 0, updatedAt: 0,
    })));
  }

  async withSecret<T>(reference: string, operation: (secret: Uint8Array) => Promise<T>): Promise<T> {
    validateReference(reference);
    const result = await this.run('secret-tool', ['lookup', 'application', 'weave', 'reference', reference], new Uint8Array());
    if (result.status !== 0 || result.stdout.byteLength === 0) throw new Error('CREDENTIAL_NOT_FOUND');
    const secret = Buffer.from(result.stdout.toString('utf8').replace(/[\r\n]+$/, ''), 'utf8');
    result.stdout.fill(0);
    try { return await operation(secret); }
    finally { secret.fill(0); }
  }

  private async has(reference: string): Promise<boolean> {
    const result = await this.run('secret-tool', ['lookup', 'application', 'weave', 'reference', reference], new Uint8Array());
    result.stdout.fill(0);
    return result.status === 0 && result.stdout.byteLength > 0;
  }
}

export interface CredentialProxyTransport {
  exchange(request: Uint8Array): Promise<Uint8Array>;
}

export class WslHostCredentialProxyStore implements CredentialStore {
  constructor(
    private readonly transport: CredentialProxyTransport,
    private readonly authenticationKey: Uint8Array,
    private readonly now: () => number = Date.now,
    private readonly nonce: () => string = () => randomBytes(16).toString('base64url'),
  ) {
    if (authenticationKey.byteLength < 32) throw new TypeError('Credential proxy key must be at least 32 bytes');
  }

  async set(reference: string, secret: Uint8Array): Promise<void> {
    validateSecret(reference, secret);
    await this.call('set', reference, Buffer.from(secret).toString('base64'));
  }
  async delete(reference: string): Promise<boolean> {
    validateReference(reference);
    return (await this.call('delete', reference) as { deleted: boolean }).deleted;
  }
  async list(): Promise<readonly CredentialMetadata[]> {
    const response = await this.call('list') as { credentials: CredentialMetadata[] };
    return Object.freeze(response.credentials.map((item) => Object.freeze({ ...item })));
  }
  async withSecret<T>(reference: string, operation: (secret: Uint8Array) => Promise<T>): Promise<T> {
    validateReference(reference);
    const response = await this.call('get', reference) as { secret: string };
    const secret = Buffer.from(response.secret, 'base64');
    try { return await operation(secret); }
    finally { secret.fill(0); }
  }

  private async call(operation: string, reference?: string, secret?: string): Promise<unknown> {
    const payload = { version: 1, operation, timestamp: this.now(), nonce: this.nonce(), ...(reference === undefined ? {} : { reference }), ...(secret === undefined ? {} : { secret }) };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
    const request = Buffer.from(JSON.stringify({ payload, mac: mac(encoded, this.authenticationKey) }), 'utf8');
    encoded.fill(0);
    const responseBytes = await this.transport.exchange(request);
    request.fill(0);
    let envelope: { payload: unknown; mac: string };
    try { envelope = JSON.parse(Buffer.from(responseBytes).toString('utf8')) as typeof envelope; }
    catch { throw new Error('CREDENTIAL_PROXY_PROTOCOL_ERROR'); }
    const responsePayload = Buffer.from(JSON.stringify(envelope.payload), 'utf8');
    const expected = Buffer.from(mac(responsePayload, this.authenticationKey), 'base64url');
    const actual = Buffer.from(envelope.mac, 'base64url');
    responsePayload.fill(0);
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) throw new Error('CREDENTIAL_PROXY_AUTH_FAILED');
    return envelope.payload;
  }
}

export function createPlatformCredentialStore(): CredentialStore {
  if (platform() === 'win32') return new WindowsCredentialManagerStore();
  if (platform() === 'linux' && process.env.WSL_DISTRO_NAME === undefined) return new LinuxSecretServiceStore();
  return new UnavailableCredentialStore();
}

function validateSecret(reference: string, secret: Uint8Array): void {
  validateReference(reference);
  if (secret.byteLength === 0) throw new TypeError('Credential secret must not be empty');
}

function mac(payload: Uint8Array, key: Uint8Array): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function credentialCommandEnvironment(): NodeJS.ProcessEnv {
  if (platform() !== 'win32') return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    PATH: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0`,
  };
}

function classifyCredentialCommandError(stderr: Buffer): string {
  const value = stderr.toString('utf8');
  if (value.includes('CREDENTIAL_NOT_FOUND')) return 'CREDENTIAL_NOT_FOUND';
  return 'CREDENTIAL_STORE_UNAVAILABLE';
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeaveCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL c, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredEnumerate(string filter, UInt32 flags, out UInt32 count, out IntPtr credentials);
  [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
'@
$inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = if ($inputValue.reference) { 'Weave:' + [string]$inputValue.reference } else { $null }
switch ($inputValue.operation) {
  'set' {
    $bytes=[Convert]::FromBase64String([string]$inputValue.secret); $ptr=[Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
    try {
      [Runtime.InteropServices.Marshal]::Copy($bytes,0,$ptr,$bytes.Length)
      $c=New-Object WeaveCred+CREDENTIAL; $c.Type=1; $c.TargetName=$target; $c.UserName='weave'; $c.Persist=2; $c.CredentialBlob=$ptr; $c.CredentialBlobSize=$bytes.Length
      if (-not [WeaveCred]::CredWrite([ref]$c,0)) { throw 'CREDENTIAL_STORE_UNAVAILABLE' }
      @{ok=$true} | ConvertTo-Json -Compress
    } finally { [Array]::Clear($bytes,0,$bytes.Length); [Runtime.InteropServices.Marshal]::FreeCoTaskMem($ptr) }
  }
  'get' {
    $ptr=[IntPtr]::Zero
    if (-not [WeaveCred]::CredRead($target,1,0,[ref]$ptr)) { throw 'CREDENTIAL_NOT_FOUND' }
    try { $c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][WeaveCred+CREDENTIAL]); $bytes=New-Object byte[] $c.CredentialBlobSize; [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$bytes,0,$bytes.Length); @{secret=[Convert]::ToBase64String($bytes)} | ConvertTo-Json -Compress; [Array]::Clear($bytes,0,$bytes.Length) } finally { [WeaveCred]::CredFree($ptr) }
  }
  'delete' { $deleted=[WeaveCred]::CredDelete($target,1,0); @{deleted=$deleted} | ConvertTo-Json -Compress }
  'list' {
    $count=0; $ptr=[IntPtr]::Zero; $items=@()
    if ([WeaveCred]::CredEnumerate('Weave:*',0,[ref]$count,[ref]$ptr)) {
      try { $epoch=New-Object DateTime 1970,1,1,0,0,0,([DateTimeKind]::Utc); for($i=0;$i -lt $count;$i++){ $cp=[Runtime.InteropServices.Marshal]::ReadIntPtr($ptr,$i*[IntPtr]::Size); $c=[Runtime.InteropServices.Marshal]::PtrToStructure($cp,[type][WeaveCred+CREDENTIAL]); $ticks=([int64]$c.LastWritten.dwHighDateTime -shl 32) -bor [uint32]$c.LastWritten.dwLowDateTime; $ms=[DateTime]::FromFileTimeUtc($ticks).Subtract($epoch).TotalMilliseconds; $items+=@{reference=$c.TargetName.Substring(6);createdAt=[int64]$ms;updatedAt=[int64]$ms} } } finally { [WeaveCred]::CredFree($ptr) }
    }
    @{credentials=$items} | ConvertTo-Json -Compress -Depth 4
  }
  default { throw 'CREDENTIAL_STORE_PROTOCOL_ERROR' }
}
`;

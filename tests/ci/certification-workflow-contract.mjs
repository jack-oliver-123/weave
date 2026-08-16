import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

for (const name of ['certify-linux.yml', 'certify-windows.yml']) {
  const source = await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
  const workflow = parse(source);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.on.workflow_dispatch !== undefined, `${name} must support explicit certification`);
  assert.match(source, /WEAVE_CERTIFICATION_SIGNING_KEY:\s*\$\{\{ secrets\.WEAVE_CERTIFICATION_SIGNING_KEY \}\}/);
  assert.doesNotMatch(
    source.replace(/secrets\.WEAVE_CERTIFICATION_SIGNING_KEY/g, ''),
    /secrets\.|continue-on-error:|smoke:live|--unsafe/,
  );
  assert.match(source, /write-certification-evidence\.mjs/);
  assert.match(source, /upload-artifact@[0-9a-f]{40}/);
  for (const action of source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    assert.match(action[1], /@[0-9a-f]{40}$/, `${action[1]} must use a full commit SHA`);
  }
}

const windows = await readFile(new URL('../../.github/workflows/certify-windows.yml', import.meta.url), 'utf8');
assert.match(windows, /self-hosted, Windows, X64, WSL2/);
assert.match(windows, /self-hosted, Windows, X64, windows-sandbox-24h2/);
assert.match(windows, /tests\/certification\/windows-sandbox\.test\.ts/);
assert.match(windows, /FilesystemRead/);
assert.match(windows, /windows_registry_hidden/);

process.stdout.write('Certification workflow contracts are valid\n');

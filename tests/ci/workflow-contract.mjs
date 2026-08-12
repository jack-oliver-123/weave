import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const workflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const workflow = await readFile(workflowUrl, 'utf8');
const document = parse(workflow);

assert.equal(document.name, 'CI');
assert.deepEqual(document.on.pull_request.branches, ['main']);
assert.deepEqual(document.on.push.branches, ['main']);
assert.doesNotMatch(workflow, /^\s*paths(?:-ignore)?:/m);

assert.deepEqual(document.permissions, { contents: 'read' });
assert.match(document.concurrency.group, /github\.event\.pull_request\.number/);
assert.match(document.concurrency.group, /github\.ref/);
assert.equal(document.concurrency['cancel-in-progress'], true);

for (const action of workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
  assert.match(action[1], /@[0-9a-f]{40}$/, `${action[1]} must use a full commit SHA`);
}

for (const job of ['code-quality', 'tests', 'docs-and-openspec']) {
  const definition = document.jobs[job];
  assert.ok(definition, `${job} job is required`);
  assert.equal(definition['runs-on'], 'ubuntu-latest');
  assert.equal(definition['timeout-minutes'], 15);
  assert.equal(definition.steps[1].with['node-version'], '22.x');
  assert.ok(definition.steps.some((step) => step.run === 'npm ci'));
}

const commandsFor = (job) => document.jobs[job].steps.flatMap((step) => step.run ?? []);
assert.deepEqual(commandsFor('code-quality'), [
  'npm ci',
  'npm run typecheck',
  'npm run build',
]);
assert.deepEqual(commandsFor('tests'), ['npm ci', 'npm test']);
assert.deepEqual(commandsFor('docs-and-openspec'), [
  'npm ci',
  'npm run docs:link',
  'npm run docs:build',
  'npm run spec:validate',
]);

const ciGate = document.jobs['ci-gate'];
assert.equal(ciGate.name, 'CI Gate');
assert.deepEqual(ciGate.needs, ['code-quality', 'tests', 'docs-and-openspec']);
assert.equal(ciGate.if, 'always()');
assert.equal(ciGate['timeout-minutes'], 5);

const resultVariables = ciGate.steps[0].env;
for (const [name, result] of Object.entries({
  CODE_QUALITY_RESULT: 'needs.code-quality.result',
  TESTS_RESULT: 'needs.tests.result',
  DOCS_AND_OPENSPEC_RESULT: 'needs.docs-and-openspec.result',
})) {
  assert.match(resultVariables[name], new RegExp(result.replaceAll('.', '\\.')));
  assert.match(ciGate.steps[0].run, new RegExp(`test "\\$${name}" = "success"`));
}

for (const forbidden of [
  /secrets\./,
  /continue-on-error:/,
  /npm audit/,
  /coverage/,
  /smoke:live/,
  /e2e:tui/,
  /merge_group:/,
]) {
  assert.doesNotMatch(workflow, forbidden);
}

process.stdout.write('CI workflow contract is valid\n');

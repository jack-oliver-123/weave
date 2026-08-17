import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const managedSkills = ['ask-matt', 'implement'];
const contents = new Map();
const workflow = await readFile(new URL('../../docs/agents/openspec-workflow.md', import.meta.url), 'utf8');

for (const skill of managedSkills) {
  const agents = await readFile(new URL(`../../.agents/skills/${skill}/SKILL.md`, import.meta.url), 'utf8');
  const claude = await readFile(new URL(`../../.claude/skills/${skill}/SKILL.md`, import.meta.url), 'utf8');
  assert.equal(claude, agents, `${skill} must have identical .agents and .claude contracts`);
  contents.set(skill, agents);
}

const askMatt = contents.get('ask-matt');
assert.match(askMatt, /docs\/agents\/openspec-workflow\.md/);
assert.match(askMatt, /sole authority/);
assert.match(askMatt, /Hand the work to the project workflow/);
assert.doesNotMatch(askMatt, /\/to-spec/);

const implement = contents.get('implement');
assert.match(implement, /docs\/agents\/openspec-workflow\.md/);
assert.match(implement, /sole authority/);
assert.match(implement, /`openspec-apply-change`/);
assert.match(implement, /completion boundary defined there/);
assert.doesNotMatch(implement, /\bcommit(?:ting)?\b/i);

assert.match(workflow, /`\/to-spec`[^\n]*不采用 OpenSpec 的轻量任务/);
assert.match(workflow, /### Quick[\s\S]*TDD[\s\S]*code-review[\s\S]*完整质量门禁/);
assert.match(workflow, /### Standard[\s\S]*完整 OpenSpec 流程/);
assert.match(workflow, /### Large[\s\S]*Wayfinder[\s\S]*OpenSpec changes[\s\S]*Standard 流程/);
assert.match(workflow, /## Apply[\s\S]*OpenSpec apply instructions[\s\S]*TDD/);
assert.match(workflow, /## Review 与验证[\s\S]*code-review[\s\S]*OpenSpec Verify/);
assert.match(workflow, /## 交付授权[\s\S]*commit[\s\S]*相互独立/);

process.stdout.write('Engineering Skills contract is valid\n');

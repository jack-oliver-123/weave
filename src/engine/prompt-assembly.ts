import { createHash } from 'node:crypto';
import type {
  CapabilityChangeContext, ChatMessage, EnvironmentContext, ProfileSummary, PromptAssembly, PromptAudit, PromptCompletionAudit,
  RuntimeStateContext, StableSystemPrompt, SystemReminder, SystemReminderFragment, TokenUsage, ToolDefinition,
} from '../shared/types.js';
import { buildRegisteredStableSystemPrompt } from './static-prompt-registry.js';

export interface AssemblePromptInput {
  readonly runtime: RuntimeStateContext;
  readonly environment?: EnvironmentContext;
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly ChatMessage[];
  readonly extensions?: readonly Extract<SystemReminderFragment, { kind: 'activated_skill' | 'project_instructions' | 'memory' }>[];
}

export function buildStableSystemPrompt(): StableSystemPrompt {
  return buildRegisteredStableSystemPrompt();
}

export function assemblePrompt(input: AssemblePromptInput): PromptAssembly {
  const stable = buildStableSystemPrompt();
  const fragments: SystemReminderFragment[] = [runtimeFragment(input.runtime)];
  if (input.environment !== undefined) fragments.push(environmentFragment(input.environment));
  fragments.push(...(input.extensions ?? []));
  fragments.forEach(validateFragment);
  const dynamicMessages = fragments
    .filter((item) => serializeFragmentContent(item).length > 0)
    .map(serializeUntrustedFragment);
  const tools = Object.freeze([...input.tools]);
  const messages = Object.freeze([...dynamicMessages, ...input.messages]);
  const assemblyHash = hash(stableJson({
    stable: stable.text,
    tools,
    messages,
  }));
  return Object.freeze({
    system: Object.freeze({ stable }),
    tools,
    messages,
    audit: Object.freeze({
      promptVersion: stable.promptVersion,
      stableHash: stable.hash,
      assemblyHash,
      modules: Object.freeze(stable.modules.map((item) => Object.freeze({ id: item.id, version: item.version, characters: item.content.length }))),
      fragments: Object.freeze(fragments.map((item) => Object.freeze({
        kind: item.kind, source: item.source, trust: 'untrusted_context' as const, characters: serializeFragmentContent(item).length,
      }))),
    }),
  });
}

function serializeUntrustedFragment(fragment: SystemReminderFragment): ChatMessage {
  const content = stableJson({
    kind: fragment.kind,
    source: fragment.source,
    trust: 'untrusted_context',
    content: fragment.content,
  }).replaceAll('&', '\\u0026').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return Object.freeze({ role: 'user', content });
}

export function buildPromptCompletionAudit(audit: PromptAudit, profile: ProfileSummary, usage?: TokenUsage): PromptCompletionAudit {
  return Object.freeze({ ...audit, protocol: profile.protocol, model: profile.model, ...(usage === undefined ? {} : { usage: Object.freeze({ ...usage }) }) });
}

export function buildSystemReminder(fragments: readonly SystemReminderFragment[]): SystemReminder {
  fragments.forEach(validateFragment);
  const order = new Map([['runtime_state', 10], ['environment', 20], ['activated_skill', 30], ['project_instructions', 40], ['memory', 50]]);
  const sorted = [...fragments]
    .filter((item) => serializeFragmentContent(item).length > 0)
    .sort((left, right) => order.get(left.kind)! - order.get(right.kind)!);
  const body = sorted.map((item) => {
    const content = escapeXml(serializeFragmentContent(item));
    return `<fragment kind="${item.kind}" source="${escapeXml(item.source)}" trust="${item.trust}">${content}</fragment>`;
  }).join('\n');
  return Object.freeze({
    fragments: Object.freeze(sorted),
    text: sorted.length === 0 ? '' : `<system-reminder>\n${body}\n</system-reminder>`,
  });
}

export function runtimeFragment(content: RuntimeStateContext): Extract<SystemReminderFragment, { kind: 'runtime_state' }> {
  return Object.freeze({ kind: 'runtime_state', source: 'weave-runtime', trust: 'trusted_runtime', content });
}

export function capabilityChangeFragment(content: CapabilityChangeContext): Extract<SystemReminderFragment, { kind: 'runtime_state' }> {
  if (content.affectedTools.length === 0 || content.impact.trim().length === 0) {
    throw new TypeError('capability_change 必须说明受影响工具及其对当前任务的影响。');
  }
  return Object.freeze({ kind: 'runtime_state', source: 'weave-runtime', trust: 'trusted_runtime', content: Object.freeze({
    ...content, affectedTools: Object.freeze([...content.affectedTools]),
  }) });
}

export function environmentFragment(content: EnvironmentContext): Extract<SystemReminderFragment, { kind: 'environment' }> {
  return Object.freeze({ kind: 'environment', source: 'weave-environment', trust: 'trusted_runtime', content: Object.freeze({
    cwd: content.cwd,
    workspaceRoots: Object.freeze([...content.workspaceRoots]),
    os: content.os,
    shell: content.shell,
    currentDate: content.currentDate,
    timezone: content.timezone,
  }) });
}

function validateFragment(fragment: SystemReminderFragment): void {
  if (fragment.kind === 'runtime_state') {
    if (fragment.source !== 'weave-runtime' || fragment.trust !== 'trusted_runtime') throw new TypeError('运行时片段来源或信任级别无效。');
    if (fragment.content.type === 'capability_change' && (fragment.content.affectedTools.length === 0 || fragment.content.impact.trim().length === 0)) {
      throw new TypeError('capability_change 必须影响当前任务。');
    }
  }
  if (fragment.kind === 'environment' && (fragment.source !== 'weave-environment' || fragment.trust !== 'trusted_runtime')) {
    throw new TypeError('环境片段来源或信任级别无效。');
  }
}

function serializeFragmentContent(fragment: SystemReminderFragment): string {
  if (typeof fragment.content === 'string') return fragment.content;
  return stableJson(fragment.content);
}

function escapeXml(value: string): string {
  if (/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD]/u.test(value)) throw new TypeError('SystemReminder 包含无效控制字符。');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, normalize(child)]));
}

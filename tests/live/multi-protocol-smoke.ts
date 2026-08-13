import { pathToFileURL } from 'node:url';
import { loadConfig, type ResolvedProfile } from '../../src/config/index.js';
import { ConversationManager } from '../../src/engine/conversation-manager.js';
import { createLlmClient } from '../../src/engine/llm/factory.js';
import { InMemoryConversationStore } from '../../src/memory/conversation-store.js';
import type { LlmClient, TokenUsage, TurnCompletionStatus } from '../../src/shared/types.js';

interface SmokeTurnSummary {
  readonly turn: number;
  readonly fragments: number;
  readonly status: TurnCompletionStatus;
  readonly usage?: TokenUsage;
}

export interface SmokeSummary {
  readonly profile: string;
  readonly protocol: string;
  readonly model: string;
  readonly turns: readonly SmokeTurnSummary[];
}

export async function runSmoke(profile: ResolvedProfile, client: LlmClient = createLlmClient(profile)): Promise<SmokeSummary> {
  const manager = new ConversationManager(client, new InMemoryConversationStore(), { maxTokens: profile.maxTokens });
  const prompts = [
    '请用纯文本列出十五条编写可靠软件测试的原则，每条单独一行，并为每条补充一句简短解释。',
    '基于上一轮内容，再补充十条不同的原则，每条单独一行，并为每条补充一句简短解释。',
  ];
  const turns: SmokeTurnSummary[] = [];

  for (let index = 0; index < prompts.length; index += 1) {
    let fragments = 0;
    let terminal: SmokeTurnSummary | undefined;
    for await (const event of manager.submit({ mode: 'react', content: prompts[index] ?? '' })) {
      if (event.type === 'text_delta') fragments += 1;
      if (event.type === 'turn_error') throw new Error(`live smoke 失败：${event.error.code}`);
      if (event.type === 'turn_cancelled') throw new Error('live smoke 被取消');
      if (event.type === 'turn_complete') {
        terminal = {
          turn: index + 1,
          fragments,
          status: event.status,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
        };
      }
    }
    if (terminal === undefined || terminal.status !== 'completed' || terminal.fragments < 1) {
      throw new Error(
        `live smoke 第 ${index + 1} 轮未达到多片段正常终止门槛（fragments=${terminal?.fragments ?? fragments}, status=${terminal?.status ?? 'missing'}）`,
      );
    }
    turns.push(terminal);
  }

  return { profile: profile.name, protocol: profile.protocol, model: profile.model, turns };
}

function parseArgs(args: readonly string[]): { configPath?: string; profileName: string } {
  let configPath: string | undefined;
  let profileName: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--config') configPath = args[++index];
    else if (argument === '--profile') profileName = args[++index];
    else throw new Error(`未知参数：${argument}`);
  }
  if (profileName === undefined || profileName.length === 0) {
    throw new Error('必须显式提供 --profile <name>');
  }
  return { configPath, profileName };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig({ configPath: args.configPath, profileName: args.profileName });
  const summary = await runSmoke(config.selected);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'live smoke 失败'}\n`);
    process.exitCode = 1;
  });
}

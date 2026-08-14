#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cwd } from 'node:process';
import { parseCliArgs, assertSupportedNodeVersion, helpText } from './config/cli.js';
import { loadConfig } from './config/index.js';
import { resolveWorkspace } from './config/workspace.js';
import { ConversationManager } from './engine/conversation-manager.js';
import { createEnvironmentContext } from './engine/prompt-environment.js';
import { createLlmClient } from './engine/llm/factory.js';
import { runTui } from './interaction/weave-tui.js';
import { InMemoryConversationStore } from './memory/conversation-store.js';
import { createCoreToolRegistry, registryDispatcher, ToolCallScheduler, Workspace } from './tool/index.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };

export async function main(args = process.argv.slice(2)): Promise<void> {
  const cli = parseCliArgs(args);
  if (cli.action === 'help') {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (cli.action === 'version') {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  assertSupportedNodeVersion();
  const config = await loadConfig({
    configPath: cli.configPath,
    profileName: cli.profileName,
    toolsEnabled: cli.toolsEnabled,
  });
  const workspaceConfig = await resolveWorkspace(cli.workspacePath, cwd());
  const client = createLlmClient(config.selected);
  const store = new InMemoryConversationStore();
  let tools;
  if (config.toolsEnabled) {
    const registry = createCoreToolRegistry(await Workspace.create(workspaceConfig.root));
    tools = { definitions: registry.listDefinitions(), scheduler: new ToolCallScheduler(registryDispatcher(registry)) };
  }
  const conversation = new ConversationManager(client, store, {
    maxTokens: config.selected.maxTokens,
    environment: createEnvironmentContext(workspaceConfig.root),
    ...(tools === undefined ? {} : { tools }),
  });
  await runTui({
    conversation,
    profile: client.profile,
    cwd: workspaceConfig.root,
    version: packageJson.version,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '启动失败。';
    process.stderr.write(`错误：${message}\n`);
    process.exitCode = 1;
  });
}

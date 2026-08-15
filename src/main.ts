#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cwd } from 'node:process';
import { parseCliArgs, assertSupportedNodeVersion, helpText } from './config/cli.js';
import { runCredentialCommand } from './config/credential-cli.js';
import { loadConfig } from './config/index.js';
import { resolveWorkspace } from './config/workspace.js';
import { ConversationManager } from './engine/conversation-manager.js';
import { createEnvironmentContext } from './engine/prompt-environment.js';
import { createLlmClient } from './engine/llm/factory.js';
import { runTui } from './interaction/weave-tui.js';
import { InMemoryAuthorizedMemoryStore, InMemoryConversationStore } from './memory/index.js';
import { createModelActionGateway } from './engine/model-action-gateway.js';
import {
  createCertifiedReadRunnerRuntime,
  createCertifiedWindowsRunnerRuntimeFromLocalArtifact,
  MemoryActionRunnerParticipant,
  memoryToolDefinitions,
} from './runner/index.js';
import {
  DailyJsonlAuditSink,
  defaultSecurityInternalRoots,
  EnvironmentMigrationCredentialStore,
  createPlatformCredentialStore,
  ProviderCredentialBroker,
} from './security/index.js';

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
  if (cli.action === 'credential') {
    await runCredentialCommand(cli, createPlatformCredentialStore());
    return;
  }
  const config = await loadConfig({
    configPath: cli.configPath,
    profileName: cli.profileName,
    toolsEnabled: cli.toolsEnabled,
  });
  const workspaceConfig = await resolveWorkspace(cli.workspacePath, cwd());
  const credentialBroker = new ProviderCredentialBroker(
    new EnvironmentMigrationCredentialStore(createPlatformCredentialStore()),
  );
  const client = createLlmClient(config.selected, credentialBroker);
  const store = new InMemoryConversationStore();
  const audit = new DailyJsonlAuditSink({ retention: config.auditRetention });
  const runnerRuntime = config.toolsEnabled
    ? await createRunnerOrPureText(workspaceConfig.root, config.sandboxBackend)
    : undefined;
  const memoryStore = new InMemoryAuthorizedMemoryStore();
  const securedRunner = runnerRuntime === undefined
    ? undefined
    : new MemoryActionRunnerParticipant(runnerRuntime.runner, memoryStore);
  const actionGateway = createModelActionGateway(client, {
    audit,
    ...(securedRunner === undefined ? {} : { runner: securedRunner }),
  });
  for (const warning of config.warnings) process.stderr.write(`Warning: ${warning}\n`);
  const conversation = new ConversationManager(client, store, {
    maxTokens: config.selected.maxTokens,
    modelOrigin: config.selected.baseUrl,
    credentialRef: config.selected.credentialRef,
    environment: createEnvironmentContext(workspaceConfig.root),
    workspaceRoot: workspaceConfig.root,
    audit,
    actionGateway,
    availableTools: runnerRuntime === undefined ? [] : memoryToolDefinitions(runnerRuntime.definitions),
    securityInternalRoots: defaultSecurityInternalRoots(),
  });
  await runTui({
    conversation,
    profile: client.profile,
    cwd: workspaceConfig.root,
    version: packageJson.version,
  });
}

async function createRunnerOrPureText(
  workspaceRoot: string,
  backend?: 'wsl2' | 'windows-sandbox',
) {
  try {
    if (backend === 'windows-sandbox') {
      return await createCertifiedWindowsRunnerRuntimeFromLocalArtifact(workspaceRoot);
    }
    if (backend === 'wsl2' && process.platform !== 'win32') return undefined;
    return await createCertifiedReadRunnerRuntime(workspaceRoot);
  } catch {
    return undefined;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '启动失败。';
    process.stderr.write(`错误：${message}\n`);
    process.exitCode = 1;
  });
}

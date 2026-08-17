import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createModelActionGateway } from '../../../src/engine/model-action-gateway.js';
import { ConversationManager } from '../../../src/engine/conversation-manager.js';
import { InMemoryConversationStore } from '../../../src/memory/conversation-store.js';
import { FakeLlmClient, fakeProfile } from '../../fixtures/fake-llm-client.js';

describe('Production Runner boundary', () => {
  it('does not import or construct the host tool execution stack from the production entry point', async () => {
    const source = await readFile(new URL('../../../src/main.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/tool\//);
    expect(source).not.toMatch(/\bcreateCoreToolRegistry\b/);
    expect(source).not.toMatch(/\bWorkspace\.create\b/);
    expect(source).not.toMatch(/\bToolCallScheduler\b/);
    expect(source).not.toMatch(/\bregistryDispatcher\b/);
    expect(source).toMatch(/createCertifiedReadRunnerRuntime/);
  });

  it('keeps host workspace writes behind the Commit Broker in the production Runner', async () => {
    const backend = await readFile(new URL('../../../src/runner/linux-backend.ts', import.meta.url), 'utf8');
    expect(backend).toMatch(/WorkspaceCommitBroker/);
    expect(backend).not.toMatch(/from ['"]\.\.\/tool\/(?:workspace|atomic-write)/);
    expect(backend).not.toMatch(/\batomicCreate\b|\batomicReplace\b/);
    expect(backend).not.toMatch(/writeFile\([^)]*hostWorkspace/);
    expect(backend).not.toMatch(/spawn\(\s*['"](?:bash|bash\.exe)['"]/);
  });

  it('opens a pure-text ActionTask when no backend is certified', async () => {
    const client = new FakeLlmClient(fakeProfile, [[
      { event: { type: 'tool_calls', calls: [{
        callId: 'complete', providerCallId: 'provider-complete', name: 'complete_task',
        input: { result: 'pure text', verificationSummary: 'none' },
      }] } },
      { event: { type: 'stream_complete', finishReason: 'stop' } },
    ]]);
    const manager = new ConversationManager(client, new InMemoryConversationStore(), {
      maxTokens: 100,
      actionGateway: createModelActionGateway(client),
      availableTools: [],
      workspaceRoot: process.cwd(),
    });

    const events = [];
    for await (const event of manager.submit({ content: 'hello', mode: 'react' })) events.push(event);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.prompt.tools.map((tool) => tool.name)).toEqual(['complete_task', 'request_user_input']);
    expect(events.some((event) => 'toolName' in event && event.toolName === 'read_file')).toBe(false);
  });
});

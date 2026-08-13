import { describe, expect, it } from 'vitest';
import { runSmoke } from '../live/multi-protocol-smoke.js';
import { FakeLlmClient } from '../fixtures/fake-llm-client.js';
import type { ResolvedProfile } from '../../src/config/index.js';

const profile: ResolvedProfile = {
  name: 'safe-name', protocol: 'openai-responses', model: 'safe-model',
  baseUrl: 'https://example.test/v1', apiKey: 'sk-secret-never-log', thinking: false, maxTokens: 64,
};

describe('live smoke 汇总', () => {
  it('只汇总脱敏元数据、两轮片段数、终态和 usage', async () => {
    const client = new FakeLlmClient(profile, [1, 2].map((turn) => [
      { event: { type: 'stream_start' } },
      { event: { type: 'tool_calls', calls: [{ callId: `c${turn}`, providerCallId: `p${turn}`, name: 'complete_task', input: { result: '不应记录的回答一\n不应记录的回答二', verificationSummary: '验证完成' } }] } },
      { event: { type: 'stream_complete', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } } },
    ]));
    const summary = await runSmoke(profile, client);
    expect(summary.turns).toEqual([
      { turn: 1, fragments: 1, status: 'completed', usage: { inputTokens: 3, outputTokens: 2 } },
      { turn: 2, fragments: 1, status: 'completed', usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(profile.apiKey);
    expect(serialized).not.toContain('不应记录的回答');
    expect(serialized).not.toContain('编写可靠软件测试');
  });
});

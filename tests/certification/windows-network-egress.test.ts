import { describe, expect, it } from 'vitest';
import { BrokeredFetchTransport, EgressBroker } from '../../src/security/egress-broker.js';

const suite = describe.runIf(process.platform === 'win32' && process.env.WEAVE_NETWORK_CERTIFICATION === 'windows');

suite('Windows controlled network egress certification', () => {
  it('uses native TLS with pinned public DNS and enforces private-target denial', async () => {
    const transport = new BrokeredFetchTransport();
    const response = await transport.fetch(
      'https://example.com/',
      { method: 'GET', redirect: 'manual' },
      { scheme: 'https:', host: 'example.com', port: 443 },
      128 * 1024,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Example Domain');

    const privateBroker = new EgressBroker(async () => [{ address: '169.254.169.254', family: 4 }]);
    await expect(privateBroker.authorize(
      'https://metadata.invalid/',
      { scheme: 'https:', host: 'metadata.invalid', port: 443 },
      1024,
    )).rejects.toThrow('NETWORK_TARGET_FORBIDDEN');
  }, 30_000);
});

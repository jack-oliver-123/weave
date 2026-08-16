import { describe, expect, it, vi } from 'vitest';
import {
  BrokeredFetchTransport,
  CapabilityTicketIssuer,
  CapabilityTicketVerifier,
  createPinnedLookup,
  EgressBroker,
  isForbiddenAddress,
} from '../../../src/security/index.js';

describe('Egress Broker', () => {
  it('binds exact scheme/host/port and rechecks the connected address', async () => {
    const broker = new EgressBroker(async () => [{ address: '93.184.216.34', family: 4 }]);
    const authorization = await broker.authorize('https://example.com/path', {
      scheme: 'https:', host: 'example.com', port: 443,
    }, 1024);
    expect(() => broker.assertConnectedAddress(authorization, '93.184.216.34')).not.toThrow();
    expect(() => broker.assertConnectedAddress(authorization, '127.0.0.1')).toThrow('DNS_REBINDING_BLOCKED');
    await expect(broker.authorize('http://example.com/path', authorization.target, 1024)).rejects.toThrow('NETWORK_TARGET_MISMATCH');
  });

  it.each([
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '100.64.0.1', '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1',
  ])('blocks private, metadata, local, and reserved address %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it('fails the whole authorization when DNS returns one forbidden address', async () => {
    const broker = new EgressBroker(async () => [
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
    ]);
    await expect(broker.authorize('https://example.com', { scheme: 'https:', host: 'example.com', port: 443 }, 10))
      .rejects.toThrow('NETWORK_TARGET_FORBIDDEN');
  });

  it('pins the authorized DNS address and enforces the combined byte budget', async () => {
    const sender = vi.fn(async (
      request: Request,
      body: Buffer,
      selected: { address: string },
      authorization: Awaited<ReturnType<EgressBroker['authorize']>>,
      broker: EgressBroker,
      responseBudget: number,
    ) => {
      expect(request.url).toBe('https://example.com/v1');
      expect(body.toString()).toBe('request');
      expect(selected.address).toBe('93.184.216.34');
      expect(responseBudget).toBe(9);
      broker.assertConnectedAddress(authorization, selected.address);
      return new Response('response');
    });
    const transport = new BrokeredFetchTransport(
      async () => [{ address: '93.184.216.34', family: 4 }],
      sender,
    );
    await expect(transport.fetch('https://example.com/v1', { method: 'POST', body: 'request' }, undefined, 16))
      .resolves.toHaveProperty('status', 200);
    await expect(transport.fetch('https://example.com/v1', { method: 'POST', body: 'too-large' }, undefined, 2))
      .rejects.toThrow('NETWORK_BUDGET_EXCEEDED');
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('supports the Node 22 all-address lookup callback without losing the pinned address', async () => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 });
    const addresses = await new Promise<unknown>((resolve, reject) => {
      (lookup as (...args: unknown[]) => void)('example.com', { all: true }, (error: Error | null, value: unknown) => {
        if (error !== null) reject(error);
        else resolve(value);
      });
    });
    expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('merges init headers for Request inputs and validates a bound capability ticket', async () => {
    const sender = vi.fn(async (request: Request) => {
      expect(request.headers.get('authorization')).toBe('Bearer canary');
      return new Response('{}');
    });
    const transport = new BrokeredFetchTransport(
      async () => [{ address: '93.184.216.34', family: 4 }],
      sender,
    );
    await transport.fetch(new Request('https://example.com/v1'), { headers: { authorization: 'Bearer canary' } });

    const issuer = new CapabilityTicketIssuer();
    const binding = {
      runnerId: 'runner', sandboxId: 'sandbox', taskId: 'task', runId: 'run', callId: 'call',
      actionDigest: 'action', capabilityDigest: 'capability', policyVersion: 'policy',
      revocationVersion: 0, authorizationEpoch: 1,
    };
    const ticket = issuer.issue({ ...binding, ticketId: 'ticket', nonce: 'nonce', issuedAt: 1, expiresAt: 1000 });
    const broker = new EgressBroker(async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(broker.authorizeWithTicket({
      ticket, verifier: new CapabilityTicketVerifier(issuer.publicKey, () => 10), binding,
      url: 'https://example.com', expected: { scheme: 'https:', host: 'example.com', port: 443 }, maxBytes: 10,
    })).resolves.toMatchObject({ maxBytes: 10 });
    await expect(broker.authorizeWithTicket({
      ticket, verifier: new CapabilityTicketVerifier(issuer.publicKey, () => 10),
      binding: { ...binding, callId: 'other' },
      url: 'https://example.com', expected: { scheme: 'https:', host: 'example.com', port: 443 }, maxBytes: 10,
    })).rejects.toThrow('Capability ticket binding mismatch');
  });
});

import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { CapabilityTicket } from './domain.js';
import type { CapabilityTicketBinding, CapabilityTicketVerifier } from './tickets.js';

export interface EgressTarget {
  readonly scheme: 'http:' | 'https:';
  readonly host: string;
  readonly port: number;
}

export interface EgressResolution {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface EgressAuthorization {
  readonly target: EgressTarget;
  readonly addresses: readonly EgressResolution[];
  readonly maxBytes: number;
}

export type EgressSender = (
  request: Request,
  body: Buffer,
  selected: EgressResolution,
  authorization: EgressAuthorization,
  broker: EgressBroker,
  responseBudget: number,
) => Promise<Response>;

export class EgressBroker {
  constructor(private readonly resolveHost: (host: string) => Promise<readonly EgressResolution[]>) {}

  async authorize(urlValue: string, expected: EgressTarget, maxBytes: number): Promise<EgressAuthorization> {
    const url = new URL(urlValue);
    if (url.username !== '' || url.password !== '') throw new Error('NETWORK_TARGET_FORBIDDEN');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (url.protocol !== expected.scheme || url.hostname.toLowerCase() !== expected.host.toLowerCase() || port !== expected.port) {
      throw new Error('NETWORK_TARGET_MISMATCH');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('Network budget must be positive');
    const addresses = await this.resolveHost(url.hostname);
    if (addresses.length === 0 || addresses.some((item) => isForbiddenAddress(item.address))) {
      throw new Error('NETWORK_TARGET_FORBIDDEN');
    }
    return Object.freeze({ target: Object.freeze({ ...expected }), addresses: Object.freeze([...addresses]), maxBytes });
  }

  async authorizeWithTicket(input: {
    readonly ticket: CapabilityTicket;
    readonly verifier: CapabilityTicketVerifier;
    readonly binding: CapabilityTicketBinding;
    readonly url: string;
    readonly expected: EgressTarget;
    readonly maxBytes: number;
  }): Promise<EgressAuthorization> {
    input.verifier.verify(input.ticket, input.binding);
    return this.authorize(input.url, input.expected, input.maxBytes);
  }

  assertConnectedAddress(authorization: EgressAuthorization, address: string): void {
    const normalized = normalizeAddress(address);
    if (!authorization.addresses.some((item) => normalizeAddress(item.address) === normalized) || isForbiddenAddress(normalized)) {
      throw new Error('DNS_REBINDING_BLOCKED');
    }
  }
}

export class BrokeredFetchTransport {
  private readonly broker: EgressBroker;

  constructor(
    resolveHost: (host: string) => Promise<readonly EgressResolution[]> = resolvePublicHost,
    private readonly sender: EgressSender = sendHttpRequest,
  ) {
    this.broker = new EgressBroker(resolveHost);
  }

  async fetch(
    input: string | URL | Request,
    init: RequestInit = {},
    expectedTarget?: EgressTarget,
    maxBytes = 8 * 1024 * 1024,
  ): Promise<Response> {
    const requestValue = new Request(input, init);
    const url = new URL(requestValue.url);
    const target = expectedTarget ?? targetFromUrl(url);
    const authorization = await this.broker.authorize(url.href, target, maxBytes);
    const body = await requestBody(requestValue);
    if (body.byteLength > maxBytes) throw new Error('NETWORK_BUDGET_EXCEEDED');
    const selected = authorization.addresses[0];
    if (selected === undefined) throw new Error('NETWORK_TARGET_FORBIDDEN');
    return this.sender(requestValue, body, selected, authorization, this.broker, maxBytes - body.byteLength);
  }
}

export function createBrokeredFetchTransport(maxBytes = 8 * 1024 * 1024): typeof fetch {
  const transport = new BrokeredFetchTransport();
  return ((input: string | URL | Request, init?: RequestInit) => transport.fetch(input, init, undefined, maxBytes)) as typeof fetch;
}

export function isForbiddenAddress(address: string): boolean {
  address = normalizeAddress(address);
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168) || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8:');
  }
  return true;
}

async function resolvePublicHost(host: string): Promise<readonly EgressResolution[]> {
  if (isIP(host) !== 0) return [{ address: host, family: isIP(host) as 4 | 6 }];
  const values = await lookup(host, { all: true, verbatim: true });
  return values.map((value) => ({ address: value.address, family: value.family as 4 | 6 }));
}

function targetFromUrl(url: URL): EgressTarget {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('NETWORK_TARGET_MISMATCH');
  return {
    scheme: url.protocol,
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  };
}

async function requestBody(request: Request): Promise<Buffer> {
  if (request.body === null) return Buffer.alloc(0);
  return Buffer.from(await request.arrayBuffer());
}

function sendHttpRequest(
  request: Request,
  body: Buffer,
  selected: EgressResolution,
  authorization: EgressAuthorization,
  broker: EgressBroker,
  responseBudget: number,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: authorization.target.port,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      lookup: createPinnedLookup(selected),
      signal: request.signal,
    };
    const start = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = start(options, (incoming) => {
      const chunks: Buffer[] = [];
      let received = 0;
      incoming.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > responseBudget) {
          outgoing.destroy(new Error('NETWORK_BUDGET_EXCEEDED'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      incoming.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const status = incoming.statusCode ?? 502;
        const responseBody = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
        resolve(new Response(responseBody, { status, statusText: incoming.statusMessage, headers }));
      });
    });
    outgoing.once('socket', (socket) => {
      socket.once('connect', () => {
        try { broker.assertConnectedAddress(authorization, socket.remoteAddress ?? ''); }
        catch (error) { outgoing.destroy(error as Error); }
      });
    });
    outgoing.once('error', reject);
    if (body.byteLength > 0) outgoing.write(body);
    outgoing.end();
  });
}

export function createPinnedLookup(selected: EgressResolution): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'object' && lookupOptions.all === true) {
      callback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped?.[1] ?? lower.split('%')[0]!;
}

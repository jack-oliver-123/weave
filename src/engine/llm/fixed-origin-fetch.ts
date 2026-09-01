export function createFixedOriginFetch(expectedOrigin: string, transport: typeof fetch = globalThis.fetch): typeof fetch {
  const expected = new URL(expectedOrigin);
  return async (input, init) => {
    const actual = new URL(input instanceof Request ? input.url : input.toString());
    if (actual.protocol !== 'https:' || actual.origin !== expected.origin) {
      throw new Error('MODEL_DESTINATION_MISMATCH');
    }
    const response = await transport(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new Error('PROVIDER_REDIRECT_REJECTED');
    return response;
  };
}

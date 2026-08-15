import type { ResolvedProfile } from '../../config/index.js';
import { FinalInputGuard } from '../../security/index.js';
import type { LlmRequest } from '../../shared/types.js';

const guard = new FinalInputGuard();
const authorizedSensitiveInputs = new WeakMap<LlmRequest, readonly string[]>();

export function bindAuthorizedSensitiveInput(request: LlmRequest, values: readonly string[]): LlmRequest {
  authorizedSensitiveInputs.set(request, Object.freeze([...values]));
  return request;
}

export function guardEncodedProviderRequest(
  profile: ResolvedProfile,
  request: Readonly<Record<string, unknown>>,
  sourceRequest?: LlmRequest,
): void {
  const destination = {
    profile: profile.name,
    protocol: profile.protocol,
    model: profile.model,
    origin: profile.baseUrl,
  };
  guard.assertAllowed({
    expectedDestination: destination,
    actualDestination: destination,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(request)),
    authorizedSensitiveValues: sourceRequest === undefined
      ? []
      : authorizedSensitiveInputs.get(sourceRequest) ?? [],
  });
}

import type { ResolvedProfile } from '../../config/index.js';
import { FinalInputGuard } from '../../security/index.js';

const guard = new FinalInputGuard();

export function guardEncodedProviderRequest(
  profile: ResolvedProfile,
  request: Readonly<Record<string, unknown>>,
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
    authorizedSensitiveValues: [],
  });
}

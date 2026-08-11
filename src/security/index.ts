import type { PermissionRequest, Decision } from '../shared/types.js';

export interface SecurityLayer {
  authorize(request: PermissionRequest): Decision;
}

export class SecurityLayerStub implements SecurityLayer {
  authorize(_request: PermissionRequest): Decision {
    throw new Error('not implemented');
  }
}

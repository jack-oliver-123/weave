import type { ConversationController, ProfileSummary } from './shared/types.js';

export interface AppPorts {
  readonly conversation: ConversationController;
  readonly profile: ProfileSummary;
  readonly cwd: string;
  readonly version: string;
}

import type { EnvironmentContext } from '../shared/types.js';

export function createEnvironmentContext(cwd: string, workspaceRoots: readonly string[] = [cwd], now = new Date()): EnvironmentContext {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return Object.freeze({
    cwd,
    workspaceRoots: Object.freeze([...workspaceRoots]),
    os: process.platform,
    shell: process.env.ComSpec ?? process.env.SHELL ?? (process.platform === 'win32' ? 'powershell' : 'sh'),
    currentDate: `${value('year')}-${value('month')}-${value('day')}`,
    timezone,
  });
}

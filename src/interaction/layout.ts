export interface LayoutMetrics {
  readonly headerHeight: number;
  readonly transcriptHeight: number;
  readonly composerHeight: number;
  readonly statusHeight: number;
}

export function calculateLayout(rows: number, composer: string): LayoutMetrics {
  const headerHeight = 5;
  const statusHeight = 1;
  const composerHeight = Math.min(7, Math.max(1, composer.split('\n').length) + 2);
  const transcriptHeight = Math.max(3, rows - headerHeight - composerHeight - statusHeight);
  return { headerHeight, transcriptHeight, composerHeight, statusHeight };
}

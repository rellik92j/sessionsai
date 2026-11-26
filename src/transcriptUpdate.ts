/**
 * What an open transcript tab needs to redraw when its log grows. The page is rendered as one block per transcript
 * entry; a later read of the log yields new blocks, and only the ones that differ go to the page.
 *
 * Entries are not append-only: a tool call's result arrives in a later record and lands on the earlier entry, and a
 * prompt gets its cost chip once the turn ends. So a block is compared by its rendered HTML, not just counted.
 */
export interface BlockPatch {
  /** Blocks to replace (an index the page already has) or add (one it does not), in ascending index order. */
  blocks: { index: number; html: string }[];
  /** How many blocks the page should end up with; blocks at or past this index are removed. */
  length: number;
  /** How many of `blocks` are past the end of what was shown before: new entries rather than changed ones. */
  added: number;
}

/** The blocks that differ between what the page shows and what the log now renders to; undefined when none do. */
export function diffBlocks(prev: readonly string[], next: readonly string[]): BlockPatch | undefined {
  const blocks: BlockPatch['blocks'] = [];
  for (let i = 0; i < next.length; i++) {
    if (i >= prev.length || prev[i] !== next[i]) {
      blocks.push({ index: i, html: next[i] });
    }
  }
  if (!blocks.length && next.length === prev.length) {
    return undefined;
  }
  return { blocks, length: next.length, added: Math.max(0, next.length - prev.length) };
}

/** Size and modification time of a log, to tell a log that changed from one that did not without reading it. */
export function logSignature(stat: { size: number; mtimeMs: number } | undefined): string {
  return stat ? `${stat.size}:${stat.mtimeMs}` : '';
}

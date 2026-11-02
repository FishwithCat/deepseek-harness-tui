/** Pure patch call previews and known applied diff metadata for Host and Web replay. */
import { parsePatch, PatchParseError } from '@deepseek-ai/dsh-fs-patch'
import type { DiffCallView, DiffResultView, FileDiff, ToolResult } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { diffsFromMeta, stoppedFromMeta } from './diff.ts'

/**
 * Parse a patch for display, leaving a rejected syntax to the caller's fallback.
 * @param patch - raw patch argument.
 * @returns the operations, or undefined when the syntax is invalid.
 */
function displayOperations(patch: string): ReturnType<typeof parsePatch> | undefined {
  try { return parsePatch(patch) } catch (error) {
    if (!(error instanceof PatchParseError)) throw error
    return undefined
  }
}

/**
 * Collect the distinct display paths a patch touches, including both endpoints of a move.
 * @param operations - parsed patch operations.
 * @returns the paths, in patch order.
 */
function patchPaths(operations: ReturnType<typeof parsePatch>): Set<string> {
  return new Set(operations.flatMap(operation =>
    operation.kind === 'update' && operation.moveTo !== undefined ? [operation.path, operation.moveTo] : [operation.path]))
}

/**
 * Title the card with its single path, or with the number of paths it spans.
 *
 * The terminal diff body omits a path row for a single-file card because the
 * heading names the file, so this title must carry that path.
 * @param paths - distinct display paths the patch touches.
 * @param stopped - whether the patch stopped before completing every operation.
 * @returns the card title.
 */
function patchTitle(paths: ReadonlySet<string>, stopped = false): string {
  const [only] = paths
  if (only !== undefined && paths.size === 1) return `Apply patch ${only}${stopped ? ' (stopped)' : ''}`
  const count = `${String(paths.size)} files`
  return stopped ? `Apply patch (${count}, stopped)` : `Apply patch (${count})`
}

/**
 * Preview the requested operations without resolving paths or reading the filesystem.
 * A deletion has no diff text to preview and appears only among the locations.
 * @param patch - raw patch argument.
 * @returns a diff call view, or undefined when syntax is invalid.
 */
export function presentPatchCall(patch: string): DiffCallView | undefined {
  const operations = displayOperations(patch)
  if (operations === undefined) return undefined
  const diffs = operations.flatMap((operation): FileDiff[] => {
    const path = operation.path
    switch (operation.kind) {
      case 'add': return [{ path, oldText: null, newText: operation.content }]
      case 'delete': return []
      case 'update': return [{ path, oldText: operation.hunks.flatMap(hunk => hunk.oldLines).join('\n') || null,
        newText: operation.hunks.flatMap(hunk => hunk.newLines).join('\n') }]
      /* v8 ignore next -- Exhaustive closed parser union. */
      default: return assertNever(operation)
    }
  })
  const paths = patchPaths(operations)
  return { card: 'diff', title: patchTitle(paths), diffs,
    locations: [...paths].map(path => ({ path })),
  }
}

/**
 * Present applied metadata under the title the patch arguments imply, so a
 * settled single-file card keeps naming its file; failed or missing metadata
 * uses generic result rendering.
 * @param patch - raw patch argument the call carried.
 * @param result - live or replayed tool result.
 * @returns known applied hunks with a stopped title where appropriate.
 */
export function presentPatchResult(patch: string, result: ToolResult): DiffResultView | undefined {
  if (result.isError) return undefined
  const diffs = diffsFromMeta(result.meta)
  if (diffs === undefined) return undefined
  const stopped = stoppedFromMeta(result.meta)
  const operations = displayOperations(patch)
  const title = operations === undefined
    ? stopped ? 'Apply patch (stopped)' : 'Apply patch'
    : patchTitle(patchPaths(operations), stopped)
  return { card: 'diff', title, diffs }
}

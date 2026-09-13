/**
 * Pure file-diff model for the transcript: turns the `FileDiff` hunks a
 * mutation Tool declared into the row list the terminal draws, recovering the
 * context/added/removed role of each line from the hunk's two sides.
 * @module @deepseek-ai/dsh-tui-app/diff
 */

import { diffLines } from 'diff'
import type { FileDiff } from '@deepseek-ai/dsh-tools'

/** Role of one rendered diff row. */
export type DiffRowKind = 'path' | 'gap' | 'context' | 'added' | 'removed'

/** One rendered diff row: its role and its verbatim text. */
export interface DiffRow {
  kind: DiffRowKind
  text: string
}

/** A file diff's complete body plus the heading figures. */
export interface DiffCard {
  /** Every body row, in file order, before any height fold. */
  rows: DiffRow[]
  /** Added lines across every hunk. */
  added: number
  /** Removed lines across every hunk. */
  removed: number
  /** Distinct paths the hunks touch. */
  files: number
}

/**
 * Split one side's text into content lines. Empty text is zero lines, and a
 * single trailing newline is a terminator rather than an extra empty line, so
 * an interior blank line survives.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * Recover the roles of one hunk's lines.
 *
 * The declared `FileDiff` carries the hunk's old and new sides as separate
 * texts, so the context-versus-change roles are recovered by diffing the two
 * sides again; `oldText: null` has nothing to compare against and every new
 * line is an addition.
 * @param diff - one declared hunk.
 * @returns the hunk's rows, in the order they render.
 */
function hunkRows(diff: FileDiff): DiffRow[] {
  if (diff.oldText === null) {
    return contentLines(diff.newText).map(text => ({ kind: 'added' as const, text }))
  }
  const rows: DiffRow[] = []
  for (const part of diffLines(diff.oldText, diff.newText)) {
    const kind: DiffRowKind = part.added ? 'added' : part.removed ? 'removed' : 'context'
    for (const text of contentLines(part.value)) rows.push({ kind, text })
  }
  return rows
}

/**
 * Build the body rows and heading figures for a list of declared hunks.
 *
 * A single-file card omits the path row because its heading already names the
 * file; a card spanning several files opens each file with its path, and a
 * later hunk of the same file opens with a gap marker, since the two hunks are
 * not adjacent lines.
 * @param diffs - the hunks a mutation Tool declared, in tool order.
 * @returns the rows, the +/- totals, and the distinct-file count.
 */
export function buildDiffCard(diffs: readonly FileDiff[]): DiffCard {
  const rows: DiffRow[] = []
  const paths = new Set<string>()
  for (const diff of diffs) paths.add(diff.path)
  const multiple = paths.size > 1
  let previousPath: string | undefined
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    if (multiple && diff.path !== previousPath) rows.push({ kind: 'path', text: diff.path })
    else if (diff.path === previousPath) rows.push({ kind: 'gap', text: '⋯' })
    previousPath = diff.path
    for (const row of hunkRows(diff)) {
      if (row.kind === 'added') added += 1
      else if (row.kind === 'removed') removed += 1
      rows.push(row)
    }
  }
  return { rows, added, removed, files: paths.size }
}

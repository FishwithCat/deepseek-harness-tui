/**
 * The pure diff model: declared hunks turned into renderable rows with their
 * context, added, and removed roles recovered.
 */

import { describe, expect, it } from 'vitest'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import { buildDiffCard } from '../src/diff.ts'

describe('buildDiffCard', () => {
  it('recovers context, removed, and added lines of one hunk', () => {
    const diffs: FileDiff[] = [{ path: 'a.ts', oldText: 'a\nb\nc\nd', newText: 'a\nb\nX\nd' }]
    expect(buildDiffCard(diffs)).toEqual({
      rows: [
        { kind: 'context', text: 'a' },
        { kind: 'context', text: 'b' },
        { kind: 'removed', text: 'c' },
        { kind: 'added', text: 'X' },
        { kind: 'context', text: 'd' },
      ],
      added: 1,
      removed: 1,
      files: 1,
    })
  })

  it('renders every line of a create as an addition', () => {
    const diffs: FileDiff[] = [{ path: 'new.txt', oldText: null, newText: 'hello\nworld\n' }]
    expect(buildDiffCard(diffs)).toEqual({
      rows: [
        { kind: 'added', text: 'hello' },
        { kind: 'added', text: 'world' },
      ],
      added: 2,
      removed: 0,
      files: 1,
    })
  })

  it('renders a full deletion and an empty change', () => {
    expect(buildDiffCard([{ path: 'a', oldText: 'a\nb', newText: '' }])).toEqual({
      rows: [
        { kind: 'removed', text: 'a' },
        { kind: 'removed', text: 'b' },
      ],
      added: 0,
      removed: 2,
      files: 1,
    })
    expect(buildDiffCard([{ path: 'a', oldText: '', newText: '' }])).toEqual({ rows: [], added: 0, removed: 0, files: 1 })
    expect(buildDiffCard([{ path: 'a', oldText: null, newText: '' }])).toEqual({ rows: [], added: 0, removed: 0, files: 1 })
  })

  it('keeps an interior blank line and drops the terminating newline', () => {
    const card = buildDiffCard([{ path: 'a', oldText: null, newText: 'one\n\ntwo\n' }])
    expect(card.rows).toEqual([
      { kind: 'added', text: 'one' },
      { kind: 'added', text: '' },
      { kind: 'added', text: 'two' },
    ])
    expect(card.added).toBe(3)
  })

  it('marks a later hunk of the same file with a gap and no repeated path', () => {
    const diffs: FileDiff[] = [
      { path: 'a.ts', oldText: 'one', newText: 'ONE' },
      { path: 'a.ts', oldText: 'two', newText: 'TWO' },
    ]
    expect(buildDiffCard(diffs)).toEqual({
      rows: [
        { kind: 'removed', text: 'one' },
        { kind: 'added', text: 'ONE' },
        { kind: 'gap', text: '⋯' },
        { kind: 'removed', text: 'two' },
        { kind: 'added', text: 'TWO' },
      ],
      added: 2,
      removed: 2,
      files: 1,
    })
  })

  it('opens every file with its path when a card spans several files', () => {
    const diffs: FileDiff[] = [
      { path: 'a.ts', oldText: null, newText: 'one' },
      { path: 'b.ts', oldText: null, newText: 'two' },
      { path: 'a.ts', oldText: 'x', newText: 'y' },
    ]
    expect(buildDiffCard(diffs)).toEqual({
      rows: [
        { kind: 'path', text: 'a.ts' },
        { kind: 'added', text: 'one' },
        { kind: 'path', text: 'b.ts' },
        { kind: 'added', text: 'two' },
        { kind: 'path', text: 'a.ts' },
        { kind: 'removed', text: 'x' },
        { kind: 'added', text: 'y' },
      ],
      added: 3,
      removed: 1,
      files: 2,
    })
  })
})

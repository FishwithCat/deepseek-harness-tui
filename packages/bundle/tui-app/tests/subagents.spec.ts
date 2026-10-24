/**
 * The pinned `/subagents` panel: summary, live rows, scrolling, and dismissal.
 */

import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { TuiMouseEvent } from '@earendil-works/pi-tui'
import { createTheme } from '../src/ansi.ts'
import { SubagentPanel } from '../src/subagents.ts'
import type { TuiSubagent } from '../src/session.ts'

const theme = createTheme({ enabled: false, palette: 'dark' })

/**
 * One list row.
 * @param index - identity and default label suffix.
 * @param overrides - row fields to replace.
 * @returns the row.
 */
function row(index: number, overrides: Partial<TuiSubagent> = {}): TuiSubagent {
  return {
    id: SessionId(`session-child-${String(index)}`),
    mode: 'one-shot',
    label: `task-${String(index)}`,
    depth: 1,
    running: false,
    ...overrides,
  }
}

/** One wheel event over the panel. */
function wheel(delta: number | undefined): TuiMouseEvent {
  return {
    type: 'wheel',
    button: 'none',
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 40,
    height: 12,
    shift: false,
    alt: false,
    ctrl: false,
    ...(delta === undefined ? {} : { wheelDelta: delta }),
  }
}

describe('SubagentPanel', () => {
  it('renders the summary, nested and external children, and a short fallback label', () => {
    const rows = [
      row(1, { label: 'explore', mode: 'continuable', running: true }),
      row(2, { label: 'leaf', depth: 2 }),
      row(3, { label: 'remote review', mode: 'external' }),
      {
        id: SessionId('session-unlabeled-child'),
        mode: 'one-shot',
        depth: 1,
        running: false,
      } satisfies TuiSubagent,
    ]
    const panel = new SubagentPanel(() => rows, () => undefined, 16, theme, () => {})
    const rendered = panel.render(100)
    expect(rendered[0]).toContain('subagents · 4 total · 1 running')
    expect(rendered[1]).toContain('● explore · continuable · dsh watch session-child-1')
    expect(rendered[2]).toContain('↳ ○ leaf')
    expect(rendered[3]).toContain('◇ remote review · external · no local session')
    expect(rendered[4]).toContain('abeled-child · one-shot · dsh watch session-unlabeled-child')
    const narrow = panel.render(30)
    expect(narrow.every(line => visibleWidth(line) <= 30)).toBe(true)
    expect(narrow.every(line => line.includes('…'))).toBe(true)
  })

  it('keeps a multiline label on one row', () => {
    const panel = new SubagentPanel(() => [row(1, { label: 'multi\nline' })], () => undefined, 6, theme, () => {})
    const rendered = panel.render(100)
    expect(rendered).toHaveLength(2)
    expect(rendered[1]).toContain('multi line')
    expect(rendered[1]).not.toContain('\n')
  })

  it('renders a catalog failure instead of rows and still closes', () => {
    const close = vi.fn()
    const panel = new SubagentPanel(() => [], () => 'catalog unavailable', 6, theme, () => {})
    expect(panel.render(100)).toEqual(['! catalog unavailable'])
    expect(panel.render(12)[0]).toContain('…')
    panel.onClose = close
    panel.handleInput('\r')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('renders an empty session', () => {
    const panel = new SubagentPanel(() => [], () => undefined, 16, theme, () => {})
    expect(panel.render(40)).toEqual(['no subagents in this session'])
  })

  it('scrolls the overflowing list by row and by page, clamping at both ends', () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(index + 1))
    const repaint = vi.fn()
    const panel = new SubagentPanel(() => rows, () => undefined, 6, theme, repaint)
    expect(panel.render(80)).toHaveLength(6)
    expect(panel.render(80).at(-1)).toContain('showing 1-4 of 8')
    panel.handleInput('\x1b[B')
    expect(repaint).toHaveBeenCalledTimes(1)
    expect(panel.render(80).at(-1)).toContain('showing 2-5 of 8')
    panel.handleInput('\x1b[6~')
    expect(panel.render(80).at(-1)).toContain('showing 5-8 of 8')
    panel.handleInput('\x1b[B')
    expect(repaint).toHaveBeenCalledTimes(2)
    panel.handleInput('\x1b[A')
    panel.handleInput('\x1b[A')
    panel.handleInput('\x1b[A')
    panel.handleInput('\x1b[A')
    panel.handleInput('\x1b[A')
    panel.handleInput('\x1b[5~')
    expect(panel.render(80).at(-1)).toContain('showing 1-4 of 8')
    const settled = repaint.mock.calls.length
    panel.handleInput('\x1b[A')
    expect(repaint).toHaveBeenCalledTimes(settled)
  })

  it('scrolls with the wheel only while the list overflows', () => {
    const short = new SubagentPanel(() => [row(1), row(2)], () => undefined, 6, theme, () => {})
    short.handleInput('\x1b[6~')
    expect(short.handleMouse(wheel(1))).toBeUndefined()
    expect(short.handleMouse(wheel(undefined))).toBeUndefined()
    expect(short.handleMouse({ ...wheel(1), type: 'click' })).toBeUndefined()
    const rows = Array.from({ length: 8 }, (_, index) => row(index + 1))
    const repaint = vi.fn()
    const panel = new SubagentPanel(() => rows, () => undefined, 6, theme, repaint)
    expect(panel.handleMouse(wheel(3))).toEqual({ handled: true })
    expect(panel.render(80).at(-1)).toContain('showing 4-7 of 8')
    expect(repaint).toHaveBeenCalledTimes(1)
  })

  it('closes on Enter and Ctrl+C and leaves other keys alone', () => {
    const close = vi.fn()
    const panel = new SubagentPanel(() => [row(1)], () => undefined, 6, theme, () => {})
    panel.onClose = close
    panel.handleInput('\r')
    panel.handleInput('\x03')
    expect(close).toHaveBeenCalledTimes(2)
    panel.handleInput('\x1b')
    panel.handleInput('x')
    expect(close).toHaveBeenCalledTimes(2)
    panel.invalidate()
  })

  it('reads the provider on every render so rows appear and disappear live', () => {
    const rows: TuiSubagent[] = [row(1)]
    const panel = new SubagentPanel(() => rows, () => undefined, 6, theme, () => {})
    expect(panel.render(80).join('\n')).toContain('task-1')
    expect(panel.render(80).join('\n')).not.toContain('task-2')
    rows.push(row(2))
    expect(panel.render(80).join('\n')).toContain('task-2')
    rows.length = 0
    expect(panel.render(80)).toEqual(['no subagents in this session'])
  })
})

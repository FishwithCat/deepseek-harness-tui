/**
 * The pinned `/subagents` panel: one line per delegated child, read from the
 * live session catalogs on every render and scrolled inside a fixed row budget.
 * The panel never writes a transcript row, so the main Agent can keep streaming
 * without moving it.
 * @module @deepseek-ai/dsh-tui-app/subagents
 */

import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui'
import type { TuiTheme } from './ansi.ts'
import type { TuiSubagent } from './session.ts'

/** Rows the summary line above the list spends. */
const SUMMARY_ROWS = 1
/** Rows the overflow hint under a scrolling list spends. */
const SCROLL_ROWS = 1

/**
 * A scrollable list of the session's delegated children.
 *
 * The row provider runs on every render, so a child that starts or settles
 * while the panel is open appears without reopening the command. The panel
 * owns only its scroll position; the transcript underneath keeps following the
 * Agent's output.
 */
export class SubagentPanel implements Component {
  /** Called when the user dismisses the panel with Enter or Ctrl+C. */
  onClose?: () => void
  /** First row of the list currently shown. */
  private offset = 0

  /**
   * @param read - cached children, read on every render and key event.
   * @param failure - why the last descendant read failed, if it did.
   * @param capacity - body rows the panel may draw, summary and scroll hint included.
   * @param theme - the surface theme.
   * @param repaint - requests a render after the panel scrolls itself.
   */
  constructor(
    private readonly read: () => readonly TuiSubagent[],
    private readonly failure: () => string | undefined,
    private readonly capacity: number,
    private readonly theme: TuiTheme,
    private readonly repaint: () => void,
  ) {}

  /**
   * Close on Enter or Ctrl+C, scroll the list on the arrow and page keys, and
   * leave every other key alone. Escape is the surrounding panel's skip.
   * @param data - raw key bytes.
   */
  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl('c'))) {
      this.onClose?.()
      return
    }
    if (matchesKey(data, Key.pageUp)) this.move(-this.viewport())
    else if (matchesKey(data, Key.pageDown)) this.move(this.viewport())
    else if (matchesKey(data, Key.up)) this.move(-1)
    else if (matchesKey(data, Key.down)) this.move(1)
  }

  /**
   * Scroll the overflowing list with the wheel; leave the wheel to the
   * transcript while every row fits.
   * @param event - the normalized mouse event.
   * @returns `handled` for a consumed wheel event, otherwise undefined.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel' || event.wheelDelta === undefined) return undefined
    if (this.rows().length <= this.capacity - SUMMARY_ROWS) return undefined
    this.move(event.wheelDelta)
    return { handled: true }
  }

  /** The panel keeps no cached render state. */
  invalidate(): void {}

  /**
   * Render the summary and the visible rows.
   * @param width - the viewport width in columns.
   * @returns the panel's rows, clipped to `width` by the surrounding panel.
   */
  render(width: number): string[] {
    const rows = this.rows()
    const failure = this.failure()
    if (failure !== undefined) {
      return [truncateToWidth(this.theme.error(`! ${failure}`), Math.max(1, width), '…')]
    }
    const lines: string[] = rows.length === 0
      ? [this.theme.dim('no subagents in this session')]
      : [this.summary(rows)]
    if (rows.length > 0) {
      const scrolling = rows.length > this.capacity - SUMMARY_ROWS
      const visible = Math.max(1, this.capacity - SUMMARY_ROWS - (scrolling ? SCROLL_ROWS : 0))
      this.offset = Math.min(this.offset, Math.max(0, rows.length - visible))
      const shown = rows.slice(this.offset, this.offset + visible)
      lines.push(...shown.map(row => this.row(row)))
      if (scrolling) {
        lines.push(this.theme.dim(
          `showing ${this.offset + 1}-${this.offset + shown.length} of ${rows.length} · ↑/↓ scroll`,
        ))
      }
    }
    return lines.map(line => truncateToWidth(line, Math.max(1, width), '…'))
  }

  /**
   * Read the cached children, or none while the last read failure stands.
   * @returns the children, or an empty list after a failure.
   */
  private rows(): readonly TuiSubagent[] {
    return this.failure() === undefined ? this.read() : []
  }

  /** Rows one page of the scroll spends. */
  private viewport(): number {
    const rows = this.rows()
    const scrolling = rows.length > this.capacity - SUMMARY_ROWS
    return Math.max(1, this.capacity - SUMMARY_ROWS - (scrolling ? SCROLL_ROWS : 0))
  }

  /**
   * Move the list by `delta` rows and request a repaint when the offset changes.
   * @param delta - signed row delta.
   */
  private move(delta: number): void {
    const rows = this.rows()
    const next = Math.min(
      Math.max(0, rows.length - this.viewport()),
      Math.max(0, this.offset + delta),
    )
    if (next === this.offset) return
    this.offset = next
    this.repaint()
  }

  /** The header naming the running and total counts. */
  private summary(rows: readonly TuiSubagent[]): string {
    const running = rows.filter(row => row.running).length
    return `${this.theme.bold('subagents')} · ${rows.length} total · ${running} running`
  }

  /** One child's row: state, label, mode, and the watch command. */
  private row(row: TuiSubagent): string {
    const indent = `${'  '.repeat(row.depth - 1)}${row.depth > 1 ? '↳ ' : ''}`
    const glyph = row.running
      ? this.theme.accent('●')
      : this.theme.dim(row.mode === 'external' ? '◇' : '○')
    const label = (row.label ?? String(row.id).slice(-12)).replace(/\s+/g, ' ')
    const detail = row.mode === 'external'
      ? 'external · no local session'
      : `${row.mode} · ${this.theme.accent(`dsh watch ${String(row.id)}`)}`
    return `${indent}${glyph} ${this.theme.bold(label)} · ${this.theme.dim(detail)}`
  }
}

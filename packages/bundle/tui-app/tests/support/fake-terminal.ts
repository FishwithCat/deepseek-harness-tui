/**
 * A deterministic in-memory Terminal for surface tests: captured output,
 * controllable dimensions, and an input feed that exercises the real key path.
 * @module @deepseek-ai/dsh-tui-app/tests/support/fake-terminal
 */

import type { Terminal } from '@earendil-works/pi-tui'

/** Terminal stand-in that records every write and replays fed input. */
export class FakeTerminal implements Terminal {
  /** Everything written to the terminal, in order. */
  output = ''
  /** Current viewport width in columns. */
  columns = 100
  /** Current viewport height in rows. */
  rows = 30
  /** Whether the kitty keyboard protocol is active; always false here. */
  kittyProtocolActive = false

  private input: ((data: string) => void) | undefined
  private resize: (() => void) | undefined

  /**
   * @param input - the stream the renderer hands input to.
   * @param resize - the callback the renderer registers for dimension changes.
   */
  start(input: (data: string) => void, resize: () => void): void {
    this.input = input
    this.resize = resize
  }

  stop(): void {
    this.input = undefined
    this.resize = undefined
  }

  /**
   * Do nothing: the fake has no pending input to drain.
   * @returns a promise that resolves immediately.
   */
  async drainInput(): Promise<void> {}

  /**
   * Append to the captured output.
   * @param data - the escape sequence or text written.
   */
  write(data: string): void {
    this.output += data
  }

  /**
   * Move the cursor; the fake records the bytes like a real terminal.
   * @param lines - signed row delta.
   */
  moveBy(lines: number): void {
    this.output += `\x1b[${String(lines)}${lines < 0 ? 'A' : 'B'}`
  }

  /** Record a cursor-hide sequence. */
  hideCursor(): void {
    this.output += '\x1b[?25l'
  }

  /** Record a cursor-show sequence. */
  showCursor(): void {
    this.output += '\x1b[?25h'
  }

  /** Record a line clear. */
  clearLine(): void {
    this.output += '\x1b[2K'
  }

  /** Record a clear-from-cursor. */
  clearFromCursor(): void {
    this.output += '\x1b[0J'
  }

  /** Record a screen clear. */
  clearScreen(): void {
    this.output += '\x1b[2J'
  }

  /**
   * Ignore a window title change.
   * @param title - the requested title.
   */
  setTitle(title: string): void {
    this.output += `\x1b]0;${title}\x07`
  }

  /**
   * Ignore a progress indicator change.
   * @param active - whether progress is active.
   */
  setProgress(active: boolean): void {
    this.output += active ? '\x1b]9;4;1\x07' : '\x1b]9;4;0\x07'
  }

  /**
   * Deliver input exactly as the terminal would.
   * @param data - raw key or paste bytes.
   */
  feed(data: string): void {
    this.input?.(data)
  }

  /** Notify the renderer of a dimension change. */
  resizeTo(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.resize?.()
  }
}

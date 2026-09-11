/**
 * The terminal application's deployment-varying settings.
 * @module @deepseek-ai/dsh-tui-app/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Where the TUI draws:
 *
 * - `'alternate'` — the alternate screen buffer with the app's own scroll
 *   window. The composer and status bar stay pinned and PageUp/PageDown scroll
 *   the transcript; the terminal's own scrollback is untouched.
 * - `'inline'` — the terminal's normal screen. The transcript grows past the
 *   viewport and the terminal's native scrollback keeps the history, while the
 *   composer stays at the bottom.
 */
export type TuiScreen = 'alternate' | 'inline'

/** The terminal application's settings. */
export interface Config {
  /** Screen strategy; see {@link TuiScreen}. */
  screen: TuiScreen
}

/** Validated settings for the `tui-app` row. */
export const Config: z<Config> = z.object({
  screen: z.union(['alternate', 'inline']).default('alternate'),
})

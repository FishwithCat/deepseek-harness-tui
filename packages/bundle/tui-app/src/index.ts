/**
 * @deepseek-ai/dsh-tui-app — the interactive terminal application over
 * `dsh-base`. The bundle patch mounts this row together with its command-line
 * provider; this module requires the launcher's exit request and the provider's
 * parsed invocation, then boots the pi-tui surface against one in-process Agent
 * and leaves process lifetime to the app's own exit request.
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import type { Context } from '@deepseek-ai/cordis'
// Empty type imports carry the Context merges for every service this row reads.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { internals, TuiApp } from './app.ts'
import { Config } from './config.ts'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import type { TuiStartupValues } from './startup.ts'

export { Config }
export type { TuiScreen } from './config.ts'
export { internals, TuiApp } from './app.ts'
export type { TuiAppOptions } from './app.ts'
export { TUI_STARTUP_SERVICE } from './startup.ts'
export type { TuiStartupValues } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-app'

/** Services required before the terminal UI can be built. */
export const inject = ['agents', 'agentDefaultModel', 'llm', 'sessions']

/**
 * Mount the interactive terminal application.
 * @param ctx - plugin context carrying the session, agent, and launcher services.
 * @param config - validated app settings.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-app: the launcher must provide ctx.appExit before the tree mounts')
  }
  const invocation = ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined
  if (invocation === undefined) {
    throw new Error('tui-app: the startup provider must publish tuiStartup before this row mounts')
  }
  void TuiApp.boot({ ctx, config, cwd: process.cwd(), invocation, exit }).catch((error: unknown) => {
    internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

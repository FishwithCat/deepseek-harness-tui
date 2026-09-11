/**
 * The terminal app's command-line provider: it parses the `dsh --profile tui`
 * flag family (`--resume`, `--provider`, `--model`) and its `--help` text, then
 * publishes the values as {@link TUI_STARTUP_SERVICE}. The TUI row injects that
 * service, so a help or usage invocation — which publishes nothing — mounts no
 * terminal UI.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI row. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the TUI row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Stored session id to resume, absent when this invocation starts a new session. */
  resume?: string | undefined
  /** Provider route this session starts on, absent when the deployment default applies. */
  provider?: string | undefined
  /** Model id this session starts on, absent when the deployment default applies. */
  model?: string | undefined
}

/** The flag family as commander parsed it. */
interface TuiOptions {
  model?: string
  provider?: string
  resume?: string
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Open the interactive terminal UI: one Agent, one session, driven in this process.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session-id>', 'resume a stored session instead of starting a new one')
    .option('--provider <provider>', 'provider route for this session (requires --model)')
    .option('--model <model>', 'model id for this session (requires --provider)')
    .addHelpText('after', `
Examples:
  dsh                                        open the TUI in the current directory
  dsh --profile tui --resume <session-id>    continue a stored session
  dsh --provider deepseek-official --model deepseek-v4-flash
`)
}

/**
 * Parse and publish the TUI invocation as an ordinary Cordis service. A partial
 * route is a usage error, so on rejection (and on `--help`) nothing is provided
 * and the TUI row stays pending.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<TuiOptions>()
    if ((options.provider === undefined) !== (options.model === undefined)) {
      program.error('error: --provider and --model must be given together')
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...options.resume === undefined ? {} : { resume: options.resume },
      ...options.provider === undefined ? {} : { provider: options.provider },
      ...options.model === undefined ? {} : { model: options.model },
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}

/**
 * Launcher decisions for the npm-installed terminal entry: argument
 * normalization, the fresh `tui` profile, and the CLI entry lookup.
 * @module @deepseek-ai/dsh-tui-launcher/launch
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'

/** Profile this launcher always boots. */
export const TUI_PROFILE = 'tui'

/** Bundle layers a launcher-created `tui` profile starts from. */
export const TUI_PROFILE_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-tui-app',
]

/** Launcher flags that would select a different profile. */
const PROFILE_FLAGS = new Set(['--profile', '--from-default-profile'])

/**
 * Turn the launcher arguments into the dsh CLI arguments.
 *
 * The launcher owns the profile, so profile-selection flags and plugin
 * management are rejected. `watch <id>` becomes the equivalent `--watch <id>`
 * application flag, which the CLI routes to the tui profile on its own.
 * @param argv - arguments after the `dsh-tui` command.
 * @returns the arguments for the dsh CLI.
 * @throws when a caller selects a profile or asks for plugin management.
 */
export function launcherCliArgs(argv: readonly string[]): string[] {
  for (const argument of argv) {
    const flag = argument.split('=', 1)[0]
    if (flag !== undefined && PROFILE_FLAGS.has(flag)) {
      throw new Error(`dsh-tui: ${flag} is fixed to "${TUI_PROFILE}"; run dsh directly to select another profile`)
    }
  }
  if (argv[0] === 'plugin') {
    throw new Error('dsh-tui: plugin management runs through dsh plugin --profile tui <pnpm arguments>')
  }
  if (argv[0] === 'watch') {
    const sessionId = argv[1]
    if (sessionId === undefined) throw new Error('dsh-tui: watch needs a session id')
    return ['--profile', TUI_PROFILE, '--watch', sessionId, ...argv.slice(2)]
  }
  return ['--profile', TUI_PROFILE, ...argv]
}

/**
 * Create the `tui` profile when the directory has no manifest yet.
 *
 * An existing profile is left untouched: it may carry the user's own patch
 * layer and plugin list, and the bundle names resolve from the launcher's
 * installation before the profile anyway.
 * @param dir - profile directory; defaults to `$DSH_HOME/profiles/tui`.
 * @returns the profile directory.
 */
export function ensureTuiProfile(dir: string = resolveProfileDir(TUI_PROFILE)): string {
  if (!existsSync(join(dir, 'package.json'))) initProfile(dir, TUI_PROFILE_BUNDLES)
  return dir
}

/**
 * Resolve the installed CLI entry from the launcher's own installation.
 * @param resolve - Node resolution function anchored at this launcher.
 * @returns the absolute path of the dsh bin script.
 */
export function resolveCliEntry(resolve: (specifier: string) => string): string {
  return resolve('@deepseek-ai/dsh/lib/bin.js')
}

/**
 * Whether the invocation only asks for the CLI version and must not create a
 * profile.
 * @param argv - normalized CLI arguments.
 * @returns true when the invocation carries a version flag.
 */
export function isVersionRequest(argv: readonly string[]): boolean {
  return argv.some(argument => argument === '--version' || argument === '-V')
}

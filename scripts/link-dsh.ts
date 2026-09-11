/**
 * Install, refresh, or remove the global `dsh` command that runs this
 * checkout's launcher.
 *
 * A fork cannot be installed from the npm registry: its `apps/cli` manifest
 * depends on `@deepseek-ai/dsh-tui-app`, which is not published, while
 * `workspace:^` ranges resolve to the upstream packages. Linking the built
 * launcher into a directory on `PATH` keeps every profile resolving the
 * checkout's own bundles, and the link is stable across branches because it
 * names the build output rather than a revision.
 *
 * Installation is idempotent and atomic: re-running refreshes the command in
 * place, a POSIX install never leaves a window where `dsh` is missing, and an
 * entry owned by another program — a regular file, a shim of another shape, or
 * a symlink whose target still exists — is refused and named rather than
 * overwritten. A dangling symlink is refreshed, which is what a moved or
 * cleaned checkout leaves behind.
 *
 * @module scripts/link-dsh
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this script's location. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The built launcher every installed command runs. */
export const CLI_BIN = join(ROOT, 'apps', 'cli', 'lib', 'bin.js')

/** Command name installed into the target directory. */
const COMMAND = 'dsh'

/** Environment variable that overrides the target bin directory. */
export const BIN_DIR_ENV = 'DSH_LINK_BIN_DIR'

/** What one parsed invocation asks for. */
export interface LinkInvocation {
  /** Remove an installed command instead of installing one. */
  remove: boolean
  /** Explicit target directory, or undefined to resolve the platform default. */
  dir: string | undefined
  /** Print usage instead of acting. */
  help: boolean
}

/** Inputs one install or removal needs; tests substitute every path. */
export interface CommandPaths {
  /** The launcher file the command must run. */
  binPath: string
  /** Directory that receives the command. */
  binDir: string
  /** Platform selector; `'win32'` selects the shim files instead of a symlink. */
  platform: NodeJS.Platform
}

/** Outcome of one install. */
export interface InstallResult {
  /** Absolute path of the installed command, or its primary shim on Windows. */
  path: string
  /** Whether the install wrote a symlink or Windows shims. */
  kind: 'symlink' | 'shim'
}

/** Outcome of one removal. */
export type RemoveResult = 'removed' | 'absent' | 'foreign'

/**
 * Parse the script arguments.
 * @param argv - arguments after the Node binary and script.
 * @returns the requested invocation.
 * @throws when an argument is unknown or `--dir` carries no path.
 */
export function parseArgs(argv: readonly string[]): LinkInvocation {
  let remove = false
  let dir: string | undefined
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--remove') remove = true
    else if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--dir') {
      const value = argv[index + 1]
      if (value === undefined || value === '') throw new Error('link-dsh: --dir needs a path')
      dir = value
      index += 1
    } else {
      throw new Error(`link-dsh: unknown argument ${JSON.stringify(argument)}`)
    }
  }
  return { remove, dir, help }
}

/**
 * Resolve the directory that receives the command.
 * @param env - the process environment, for {@link BIN_DIR_ENV} and `APPDATA`.
 * @param home - the user's home directory.
 * @param platform - the platform whose default applies.
 * @returns the absolute target directory (which may not exist yet).
 */
export function resolveBinDir(
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
): string {
  const configured = env[BIN_DIR_ENV]
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  if (platform === 'win32') {
    const roaming = env.APPDATA
    return join(roaming !== undefined && roaming !== '' ? roaming : join(home, 'AppData', 'Roaming'), 'npm')
  }
  return join(home, '.local', 'bin')
}

/**
 * Whether a directory appears on `PATH`.
 * @param pathValue - the raw `PATH` value.
 * @param binDir - the directory to look for.
 * @param platform - the platform whose separator and comparison apply.
 * @returns true when an entry resolves to the same directory.
 */
export function isOnPath(pathValue: string, binDir: string, platform: NodeJS.Platform): boolean {
  const separator = platform === 'win32' ? ';' : delimiter
  const normalize = (value: string): string => platform === 'win32'
    ? resolve(value).toLowerCase()
    : resolve(value)
  const target = normalize(binDir)
  return pathValue.split(separator).some(entry => entry !== '' && normalize(entry) === target)
}

/** The command file names this platform installs. */
function commandFiles(paths: CommandPaths): string[] {
  return paths.platform === 'win32'
    ? [join(paths.binDir, `${COMMAND}.cmd`), join(paths.binDir, `${COMMAND}.ps1`)]
    : [join(paths.binDir, COMMAND)]
}

/**
 * Whether a path is a symbolic link, including a dangling one.
 * @param path - the candidate path.
 * @returns true when the directory entry is a symlink.
 */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The Windows command shim that forwards to the launcher. */
function cmdShim(binPath: string): string {
  return `@ECHO OFF\r\nnode "${binPath}" %*\r\n`
}

/** The PowerShell shim that forwards to the launcher. */
function ps1Shim(binPath: string): string {
  return `node "${binPath}" @args\r\n`
}

/**
 * Whether a Windows shim has this script's shape, whatever launcher it names.
 * @param path - the existing shim file.
 * @returns true when the file is a forwarding shim this script may replace.
 */
function shimIsOurs(path: string): boolean {
  try {
    const content = readFileSync(path, 'utf8')
    return content.startsWith('@ECHO OFF\r\nnode "') || content.startsWith('node "')
  } catch {
    // An unreadable entry is not ours to replace.
    return false
  }
}

/**
 * Whether an existing entry is this script's to replace or remove: it names the
 * current launcher, it is a dangling link a moved checkout left behind, or it
 * is a Windows shim of this script's own shape.
 * @param path - the existing command file.
 * @param paths - the launcher path and platform.
 * @returns true when the entry is owned by this installer.
 */
function ownsEntry(path: string, paths: CommandPaths): boolean {
  if (isSymlink(path)) {
    if (paths.platform === 'win32') return false
    const target = resolve(readlinkSync(path))
    return target === resolve(paths.binPath) || !existsSync(target)
  }
  if (!existsSync(path)) return false
  return paths.platform === 'win32' && shimIsOurs(path)
}

/**
 * Existing command files this installer must not touch.
 * @param paths - the target directory, launcher path, and platform.
 * @returns the offending absolute paths, empty when every entry is ours or absent.
 */
function foreignEntries(paths: CommandPaths): string[] {
  return commandFiles(paths).filter(path => (existsSync(path) || isSymlink(path)) && !ownsEntry(path, paths))
}

/**
 * Write one file atomically, so a shell never observes a half-written shim.
 * @param path - the destination file.
 * @param content - the complete file content.
 */
function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.tmp-${String(process.pid)}`
  writeFileSync(temporary, content)
  renameSync(temporary, path)
}

/**
 * Install or refresh the command.
 * @param paths - the launcher path, target directory, and platform.
 * @returns what was installed and where.
 * @throws when the launcher is missing or the name belongs to another program.
 */
export function installCommand(paths: CommandPaths): InstallResult {
  if (!existsSync(paths.binPath)) {
    throw new Error(`link-dsh: ${paths.binPath} does not exist; build it first with 'pnpm run build'`)
  }
  const foreign = foreignEntries(paths)
  if (foreign.length > 0) {
    throw new Error(`link-dsh: ${foreign.join(', ')} belongs to another program; remove it yourself`)
  }
  mkdirSync(paths.binDir, { recursive: true })
  if (paths.platform === 'win32') {
    const cmd = join(paths.binDir, `${COMMAND}.cmd`)
    writeAtomic(cmd, cmdShim(paths.binPath))
    writeAtomic(join(paths.binDir, `${COMMAND}.ps1`), ps1Shim(paths.binPath))
    return { path: cmd, kind: 'shim' }
  }
  const link = join(paths.binDir, COMMAND)
  const temporary = `${link}.tmp-${String(process.pid)}`
  symlinkSync(paths.binPath, temporary)
  try {
    renameSync(temporary, link)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return { path: link, kind: 'symlink' }
}

/**
 * Remove an installed command that belongs to this checkout.
 * @param paths - the launcher path, target directory, and platform.
 * @returns `'removed'`, `'absent'` when nothing is installed, or `'foreign'` when another program owns the name.
 */
export function removeCommand(paths: CommandPaths): RemoveResult {
  const files = commandFiles(paths)
  const present = files.filter(path => existsSync(path) || isSymlink(path))
  if (present.length === 0) return 'absent'
  if (foreignEntries(paths).length > 0) return 'foreign'
  for (const path of present) rmSync(path, { force: true })
  return 'removed'
}

/** Usage text. */
const USAGE = `Usage: pnpm run link:dsh [-- --dir <path>]

Install or refresh a global 'dsh' command that runs this checkout's launcher.
The command links apps/cli/lib/bin.js, so build it first
('pnpm run build') and re-run this script after a rebuild.

Options:
  --dir <path>   install into <path> instead of the platform default
                 ($HOME/.local/bin, or %APPDATA%\\npm on Windows)
  --remove       remove a command this checkout installed
  -h, --help     show this help

Environment:
  ${BIN_DIR_ENV}   target directory, overridden by --dir
`

/**
 * Run the script.
 * @param argv - arguments after the Node binary and script.
 * @param env - the process environment.
 * @param home - the user's home directory.
 * @param platform - the platform whose command kind and defaults apply.
 * @param binPath - the launcher to install; defaults to this checkout's built bin.
 * @returns the process exit code.
 */
export function run(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform = process.platform,
  binPath: string = CLI_BIN,
): number {
  let invocation: LinkInvocation
  try {
    invocation = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  if (invocation.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const binDir = invocation.dir === undefined ? resolveBinDir(env, home, platform) : resolve(invocation.dir)
  const paths: CommandPaths = { binPath, binDir, platform }
  try {
    if (invocation.remove) {
      const outcome = removeCommand(paths)
      if (outcome === 'foreign') {
        process.stderr.write(`link-dsh: ${binDir}${sep}${COMMAND} belongs to another program; remove it yourself\n`)
        return 1
      }
      process.stdout.write(outcome === 'removed'
        ? `link-dsh: removed ${binDir}${sep}${COMMAND}\n`
        : `link-dsh: nothing installed in ${binDir}\n`)
      return 0
    }
    const installed = installCommand(paths)
    process.stdout.write(`link-dsh: installed ${installed.path} -> ${binPath}\n`)
    if (!isOnPath(env.PATH ?? '', binDir, platform)) {
      process.stdout.write(platform === 'win32'
        ? `link-dsh: add ${binDir} to PATH (for example: setx PATH "%PATH%;${binDir}")\n`
        : `link-dsh: add ${binDir} to PATH (for example: export PATH="${binDir}:$PATH")\n`)
    }
    process.stdout.write('link-dsh: run `dsh` in any directory; `pnpm run unlink:dsh` removes it\n')
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const invokedPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === invokedPath) {
  process.exitCode = run(process.argv.slice(2), process.env, homedir())
}

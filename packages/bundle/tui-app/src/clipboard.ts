/**
 * Native clipboard text writes and raster image reads.
 *
 * A terminal delivers pasted text through bracketed paste, but no terminal
 * protocol carries image bytes to a full-screen application, so the app asks
 * the platform's own clipboard reader and stages the result in a temporary
 * file. Each reader is a documented external program: `osascript` running the
 * JavaScript automation runtime reads `NSPasteboard` directly on macOS,
 * `System.Windows.Forms.Clipboard` through PowerShell on Windows and WSL,
 * `wl-paste` on Wayland, and `xclip` on X11. The declared media type is the
 * reader's, verified against the decoded bytes by the attachment service, so a
 * mislabeled payload is refused rather than stored.
 * @module @deepseek-ai/dsh-tui-app/clipboard
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Image media types this surface accepts, most preferred first. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** Longest one clipboard probe may run before it is abandoned. */
const READ_TIMEOUT_MS = 5_000
/** Longest one offered-media-type listing may run; a missing reader fails immediately. */
const LIST_TIMEOUT_MS = 1_000
/** Largest clipboard payload accepted from one child process. */
const MAX_CLIPBOARD_BYTES = 64 * 1024 * 1024

/** One raster image read from the system clipboard, before attachment admission. */
export interface ClipboardImage {
  /** Encoded image bytes exactly as the platform reader produced them. */
  data: Uint8Array
  /** Media type the reader declared; admission verifies it against the bytes. */
  mediaType: ImageMediaType
}

/**
 * Run one clipboard reader.
 * @param command - the reader program.
 * @param args - its arguments.
 * @param timeoutMs - how long the program may run.
 * @param input - optional UTF-8 text supplied on stdin.
 * @returns the program's stdout, or undefined when it is absent, fails, or times out.
 */
export type ClipboardCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  input?: string,
) => Promise<Buffer | undefined>

/** Process facts and readers a clipboard read may substitute. */
export interface ClipboardReadOptions {
  /** Platform to read from. */
  platform?: NodeJS.Platform
  /** Environment consulted for the display session. */
  env?: NodeJS.ProcessEnv
  /** Command runner. */
  run?: ClipboardCommandRunner
  /** Create the path a staging reader writes. */
  stagePath?: () => string
  /** Read and delete one staged file; undefined when the reader wrote no bytes. */
  readStaged?: (path: string) => Promise<Uint8Array | undefined>
}

/**
 * Run one child process without a shell, keeping binary stdout intact.
 * @param command - the program to run.
 * @param args - its arguments.
 * @param timeoutMs - how long it may run before it is killed.
 * @param input - optional UTF-8 text supplied on stdin.
 * @returns its stdout, or undefined when it cannot be run or exits non-zero.
 */
function runClipboardCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  input?: string,
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let inputFailed = false
    const child = execFile(command, [...args], {
      timeout: timeoutMs,
      maxBuffer: MAX_CLIPBOARD_BYTES,
      encoding: 'buffer',
    }, (error, stdout) => {
      resolve(error === null && !inputFailed ? stdout : undefined)
    })
    // A reader may exit before accepting stdin; contain EPIPE and report failure.
    child.stdin?.on('error', () => { inputFailed = true })
    child.stdin?.end(input)
  })
}

/**
 * A unique staging path under the system temporary directory.
 * @returns the path a file-staging reader writes.
 */
function clipboardStagePath(): string {
  return join(tmpdir(), `dsh-clipboard-${randomUUID()}.png`)
}

/**
 * Read and delete one staged clipboard file.
 * @param path - the staging path a reader wrote.
 * @returns the staged bytes, or undefined when the reader wrote nothing readable.
 */
async function readStagedClipboardFile(path: string): Promise<Uint8Array | undefined> {
  try {
    const data = await readFile(path)
    return data.byteLength === 0 ? undefined : new Uint8Array(data)
  } catch {
    // The reader wrote no file because the clipboard held no image; no other
    // failure reaches this call, which runs only after the reader reported success.
    return undefined
  } finally {
    try {
      await unlink(path)
    } catch {
      // Cleanup of a file the reader never created; the read path already answered.
    }
  }
}

/** This process's readers, used for every field a caller substitutes nothing for. */
export const systemClipboard: Required<ClipboardReadOptions> = {
  platform: process.platform,
  env: process.env,
  run: runClipboardCommand,
  stagePath: clipboardStagePath,
  readStaged: readStagedClipboardFile,
}

/**
 * Quote one path for a JavaScript string literal.
 * @param value - the path to embed.
 * @returns the quoted literal.
 */
function javaScriptString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Quote one path for a PowerShell single-quoted string literal.
 * @param value - the path to embed.
 * @returns the quoted literal.
 */
function powerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** The lower-case base media type of one offered clipboard type. */
function baseMediaType(offered: string): string {
  const separator = offered.indexOf(';')
  return (separator === -1 ? offered : offered.slice(0, separator)).trim().toLowerCase()
}

/**
 * Choose the offered clipboard type this surface accepts.
 * @param offered - media types the clipboard owner declared.
 * @returns the accepted media type, or undefined when the clipboard holds no accepted image.
 */
function preferredMediaType(offered: readonly string[]): ImageMediaType | undefined {
  for (const mediaType of IMAGE_MEDIA_TYPES) {
    if (offered.some(candidate => baseMediaType(candidate) === mediaType)) return mediaType
  }
  return undefined
}

/**
 * One reader's offered media types, one per line.
 * @param run - command runner.
 * @param command - the reader program.
 * @param args - its listing arguments.
 * @returns the declared media types, empty when the reader is absent.
 */
async function offeredMediaTypes(
  run: ClipboardCommandRunner,
  command: string,
  args: readonly string[],
): Promise<string[]> {
  const listing = await run(command, args, LIST_TIMEOUT_MS)
  if (listing === undefined) return []
  return listing.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/**
 * Read the macOS pasteboard PNG representation through `osascript`'s JavaScript
 * runtime, which reaches `NSPasteboard` without AppleScript's data coercion.
 * @param run - command runner.
 * @param stagePath - creates the staging path the script writes.
 * @param readStaged - reads and deletes the staged file.
 * @returns the clipboard image, or undefined when the pasteboard holds no image.
 */
async function readDarwin(
  run: ClipboardCommandRunner,
  stagePath: () => string,
  readStaged: (path: string) => Promise<Uint8Array | undefined>,
): Promise<ClipboardImage | undefined> {
  const path = stagePath()
  const script = [
    "ObjC.import('AppKit')",
    "const data = $.NSPasteboard.generalPasteboard.dataForType('public.png')",
    `if (data.isNil()) { 'empty' } else { data.writeToFileAtomically(${javaScriptString(path)}, true) ? 'ok' : 'failed' }`,
  ].join('\n')
  const status = await run('osascript', ['-l', 'JavaScript', '-e', script], READ_TIMEOUT_MS)
  if (status?.toString('utf8').trim() !== 'ok') return undefined
  const data = await readStaged(path)
  return data === undefined ? undefined : { data, mediaType: 'image/png' }
}

/**
 * Read a Windows clipboard image to `path` through PowerShell.
 * @param run - command runner.
 * @param path - the path PowerShell writes, expressed for the platform running it.
 * @param readStaged - reads and deletes the staged file.
 * @returns the clipboard image, or undefined when the clipboard holds no image.
 */
async function readPowerShell(
  run: ClipboardCommandRunner,
  path: string,
  readStaged: (path: string) => Promise<Uint8Array | undefined>,
): Promise<ClipboardImage | undefined> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$image = [System.Windows.Forms.Clipboard]::GetImage()',
    `if ($null -eq $image) { Write-Output 'empty' } else { $image.Save(${powerShellString(path)}, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' }`,
  ].join('; ')
  const status = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script], READ_TIMEOUT_MS)
  if (status?.toString('utf8').trim() !== 'ok') return undefined
  const data = await readStaged(path)
  return data === undefined ? undefined : { data, mediaType: 'image/png' }
}

/**
 * Read a Wayland clipboard image through `wl-paste`.
 * @param run - command runner.
 * @returns the clipboard image, or undefined when `wl-paste` is absent or offers no image.
 */
async function readWayland(run: ClipboardCommandRunner): Promise<ClipboardImage | undefined> {
  const offered = await offeredMediaTypes(run, 'wl-paste', ['--list-types'])
  const mediaType = preferredMediaType(offered)
  if (mediaType === undefined) return undefined
  const data = await run('wl-paste', ['--type', mediaType, '--no-newline'], READ_TIMEOUT_MS)
  if (data === undefined || data.byteLength === 0) return undefined
  return { data: new Uint8Array(data), mediaType }
}

/**
 * Read an X11 clipboard image through `xclip`.
 *
 * The owner may advertise nothing, so an empty target list still probes each
 * accepted type in preference order before the clipboard is called imageless.
 * @param run - command runner.
 * @returns the clipboard image, or undefined when `xclip` is absent or offers no image.
 */
async function readX11(run: ClipboardCommandRunner): Promise<ClipboardImage | undefined> {
  const offered = await offeredMediaTypes(run, 'xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'])
  const preferred = preferredMediaType(offered)
  const candidates = preferred === undefined
    ? IMAGE_MEDIA_TYPES
    : [preferred, ...IMAGE_MEDIA_TYPES.filter(mediaType => mediaType !== preferred)]
  for (const mediaType of candidates) {
    const data = await run('xclip', ['-selection', 'clipboard', '-t', mediaType, '-o'], READ_TIMEOUT_MS)
    if (data !== undefined && data.byteLength > 0) return { data: new Uint8Array(data), mediaType }
  }
  return undefined
}

/**
 * Whether this environment is a Windows Subsystem for Linux distribution.
 *
 * WSL publishes its distribution name to every shell; Linux clipboard owners do
 * not receive screenshots copied on the Windows side, so only the Windows
 * clipboard can answer there.
 * @param env - environment to read.
 * @returns whether to fall back to the Windows clipboard.
 */
function isWsl(env: NodeJS.ProcessEnv): boolean {
  return env.WSL_DISTRO_NAME !== undefined
}

/**
 * Read a Linux clipboard image from the Wayland or X11 owner.
 * @param run - command runner.
 * @param env - environment identifying the display session.
 * @param stagePath - creates the staging path used by the WSL fallback.
 * @param readStaged - reads and deletes the staged file.
 * @returns the clipboard image, or undefined when no reader offers one.
 */
async function readLinux(
  run: ClipboardCommandRunner,
  env: NodeJS.ProcessEnv,
  stagePath: () => string,
  readStaged: (path: string) => Promise<Uint8Array | undefined>,
): Promise<ClipboardImage | undefined> {
  const wayland = env.WAYLAND_DISPLAY !== undefined
  if (wayland) {
    const image = await readWayland(run)
    if (image !== undefined) return image
  }
  if (wayland || env.DISPLAY !== undefined) {
    const image = await readX11(run)
    if (image !== undefined) return image
  }
  if (!isWsl(env)) return undefined
  const path = stagePath()
  // Windows PowerShell writes the path it is given, so the staging path must be
  // translated back into the Windows view of the same file.
  const translated = await run('wslpath', ['-w', path], LIST_TIMEOUT_MS)
  const windowsPath = translated?.toString('utf8').trim()
  if (windowsPath === undefined || windowsPath === '') return undefined
  return readPowerShell(run, windowsPath, readStaged)
}

/**
 * Read one image from the system clipboard.
 * @param options - substituted process facts and readers; omitted fields read this process's clipboard.
 * @returns the clipboard image, or undefined when the clipboard holds no accepted image or no reader is available.
 */
export async function readClipboardImage(options: ClipboardReadOptions = {}): Promise<ClipboardImage | undefined> {
  const readers: Required<ClipboardReadOptions> = { ...systemClipboard, ...options }
  switch (readers.platform) {
    case 'darwin':
      return readDarwin(readers.run, readers.stagePath, readers.readStaged)
    case 'win32':
      return readPowerShell(readers.run, readers.stagePath(), readers.readStaged)
    case 'linux':
      return readLinux(readers.run, readers.env, readers.stagePath, readers.readStaged)
    default:
      return undefined
  }
}

/**
 * Copy a selection using the local macOS pasteboard, or the terminal elsewhere.
 * @param text - exact selected text, supplied to pbcopy through stdin.
 * @param write - terminal output for the OSC 52 path.
 * @param options - process facts and command runner; defaults to this process.
 * @returns native command success, or true after an unacknowledged OSC 52 write.
 */
export async function copyClipboardText(
  text: string,
  write: (data: string) => void,
  options: Pick<ClipboardReadOptions, 'platform' | 'env' | 'run'> = {},
): Promise<boolean> {
  const { platform, env, run } = { ...systemClipboard, ...options }
  if (platform === 'darwin' && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY) {
    return await run('/usr/bin/pbcopy', [], READ_TIMEOUT_MS, text) !== undefined
  }
  write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  return true
}

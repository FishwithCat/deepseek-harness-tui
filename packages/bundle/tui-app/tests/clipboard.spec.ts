/**
 * The clipboard image reader: which platform reader runs, how each stages its
 * bytes, and what it reports when the clipboard holds no image.
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readClipboardImage, systemClipboard } from '../src/clipboard.ts'
import type { ClipboardCommandRunner, ClipboardReadOptions } from '../src/clipboard.ts'

/** Stand-in clipboard bytes; the attachment service owns real decoding. */
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) await rm(path, { recursive: true, force: true })
})

/** Create one temporary directory removed after the test. */
async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-clipboard-spec-'))
  temporaryDirectories.push(path)
  return path
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A runner answering by command and recording every call. */
function fakeRunner(handler: (command: string, args: readonly string[]) => Buffer | undefined): {
  run: ClipboardCommandRunner
  calls: { command: string; args: readonly string[] }[]
} {
  const calls: { command: string; args: readonly string[] }[] = []
  const run: ClipboardCommandRunner = (command, args) => {
    calls.push({ command, args: [...args] })
    return Promise.resolve(handler(command, args))
  }
  return { run, calls }
}

/** Options naming one staged file and the bytes a reader would have written. */
function stagedOptions(
  readers: Omit<ClipboardReadOptions, 'stagePath' | 'readStaged'>,
  path: string,
  data: Uint8Array | undefined,
): { options: ClipboardReadOptions; readStaged: ReturnType<typeof vi.fn> } {
  const readStaged = vi.fn(async () => data)
  return { options: { ...readers, stagePath: () => path, readStaged }, readStaged }
}

describe('readClipboardImage', () => {
  it('stages the macOS pasteboard PNG, quoting the staging path', async () => {
    const path = '/tmp/dsh "clip"\\stage.png'
    const { run, calls } = fakeRunner(() => Buffer.from('ok\n'))
    const { options, readStaged } = stagedOptions({ platform: 'darwin', run }, path, IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toEqual({ data: IMAGE_BYTES, mediaType: 'image/png' })
    expect(calls[0]!.command).toBe('osascript')
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e'])
    const script = calls[0]!.args[3]!
    expect(script).toContain("NSPasteboard.generalPasteboard.dataForType('public.png')")
    expect(script).toContain('writeToFileAtomically("/tmp/dsh \\"clip\\"\\\\stage.png", true)')
    expect(readStaged).toHaveBeenCalledWith(path)
  })

  it('reports no image when the macOS pasteboard holds none', async () => {
    const { run } = fakeRunner(() => Buffer.from('empty\n'))
    const { options, readStaged } = stagedOptions({ platform: 'darwin', run }, '/tmp/staged.png', IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
    expect(readStaged).not.toHaveBeenCalled()
  })

  it('reports no image when the macOS script cannot write the staged file', async () => {
    const { run } = fakeRunner(() => Buffer.from('failed\n'))
    const { options, readStaged } = stagedOptions({ platform: 'darwin', run }, '/tmp/staged.png', IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
    expect(readStaged).not.toHaveBeenCalled()
  })

  it('reports no image when the macOS reader cannot run', async () => {
    const { run } = fakeRunner(() => undefined)
    const { options, readStaged } = stagedOptions({ platform: 'darwin', run }, '/tmp/staged.png', IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
    expect(readStaged).not.toHaveBeenCalled()
  })

  it('reports no image when a reader reports success but writes nothing', async () => {
    const { run } = fakeRunner(() => Buffer.from('ok'))
    const { options } = stagedOptions({ platform: 'darwin', run }, '/tmp/staged.png', undefined)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
  })

  it('stages the Windows clipboard image through PowerShell, quoting the destination', async () => {
    const path = "C:\\Temp\\it's.png"
    const { run, calls } = fakeRunner(() => Buffer.from('ok\n'))
    const { options, readStaged } = stagedOptions({ platform: 'win32', run }, path, IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toEqual({ data: IMAGE_BYTES, mediaType: 'image/png' })
    const script = calls[0]!.args[3]!
    expect(script).toContain('[System.Windows.Forms.Clipboard]::GetImage()')
    expect(script).toContain("$image.Save('C:\\Temp\\it''s.png'")
    expect(readStaged).toHaveBeenCalledWith(path)
  })

  it('reports no image when the Windows clipboard holds none', async () => {
    const { run } = fakeRunner(() => Buffer.from('empty\n'))
    const { options, readStaged } = stagedOptions({ platform: 'win32', run }, 'C:\\Temp\\staged.png', IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
    expect(readStaged).not.toHaveBeenCalled()
  })

  it('reports no image when PowerShell reports success but writes nothing', async () => {
    const { run } = fakeRunner(() => Buffer.from('ok\n'))
    const { options } = stagedOptions({ platform: 'win32', run }, 'C:\\Temp\\staged.png', undefined)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
  })

  it('prefers PNG among the types a Wayland owner offers', async () => {
    const { run, calls } = fakeRunner((_command, args) => (
      args.includes('--list-types')
        ? Buffer.from('text/plain;charset=utf-8\nimage/jpeg\nimage/png\n')
        : Buffer.from(IMAGE_BYTES)
    ))
    const options: ClipboardReadOptions = { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, run }
    await expect(readClipboardImage(options)).resolves.toEqual({ data: IMAGE_BYTES, mediaType: 'image/png' })
    expect(calls[1]).toEqual({ command: 'wl-paste', args: ['--type', 'image/png', '--no-newline'] })
  })

  it('ignores a Wayland clipboard that offers no image', async () => {
    const { run, calls } = fakeRunner((_command, args) => (
      args.includes('--list-types') ? Buffer.from('text/plain\n') : undefined
    ))
    const options: ClipboardReadOptions = { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, run }
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
    expect(calls[0]).toEqual({ command: 'wl-paste', args: ['--list-types'] })
    expect(calls.some(call => call.args.includes('--type'))).toBe(false)
  })

  it('ignores an empty Wayland payload', async () => {
    const { run } = fakeRunner((_command, args) => (
      args.includes('--list-types') ? Buffer.from('image/png\n') : Buffer.alloc(0)
    ))
    const options: ClipboardReadOptions = { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, run }
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
  })

  it('reads the type an X11 owner advertises', async () => {
    const { run, calls } = fakeRunner((_command, args) => {
      if (args.includes('TARGETS')) return Buffer.from('image/webp;charset=binary\n')
      return args.at(-2) === 'image/webp' ? Buffer.from(IMAGE_BYTES) : undefined
    })
    const options: ClipboardReadOptions = { platform: 'linux', env: { DISPLAY: ':0' }, run }
    await expect(readClipboardImage(options)).resolves.toEqual({ data: IMAGE_BYTES, mediaType: 'image/webp' })
    expect(calls[1]!.args).toEqual(['-selection', 'clipboard', '-t', 'image/webp', '-o'])
  })

  it('probes every accepted type when the X11 owner lists no target', async () => {
    const { run, calls } = fakeRunner((_command, args) => (
      args.at(-2) === 'image/jpeg' ? Buffer.from(IMAGE_BYTES) : undefined
    ))
    const options: ClipboardReadOptions = { platform: 'linux', env: { DISPLAY: ':0' }, run }
    await expect(readClipboardImage(options)).resolves.toEqual({ data: IMAGE_BYTES, mediaType: 'image/jpeg' })
    expect(calls.map(call => call.args.at(-2))).toEqual(['TARGETS', 'image/png', 'image/jpeg'])
  })

  it('reads nothing on a Linux host with no display owner', async () => {
    const { run, calls } = fakeRunner(() => Buffer.from(IMAGE_BYTES))
    await expect(readClipboardImage({ platform: 'linux', env: {}, run })).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('falls back to the Windows clipboard on WSL', async () => {
    const { run, calls } = fakeRunner((command) => {
      if (command === 'wslpath') return Buffer.from('C:\\Temp\\staged.png\n')
      return command === 'powershell.exe' ? Buffer.from('ok\n') : undefined
    })
    const { options, readStaged } = stagedOptions({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, run }, '/tmp/staged.png', IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toEqual({ data: IMAGE_BYTES, mediaType: 'image/png' })
    expect(readStaged).toHaveBeenCalledWith('C:\\Temp\\staged.png')
    expect(calls.map(call => call.command)).toEqual(['wslpath', 'powershell.exe'])
  })

  it('reports no image when WSL cannot translate the staging path', async () => {
    const { run, calls } = fakeRunner(() => undefined)
    const { options } = stagedOptions({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, run }, '/tmp/staged.png', IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
    expect(calls.map(call => call.command)).toEqual(['wslpath'])
  })

  it('reports no image when WSL translates the staging path to nothing', async () => {
    const { run } = fakeRunner(() => Buffer.from('\n'))
    const { options } = stagedOptions({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, run }, '/tmp/staged.png', IMAGE_BYTES)
    await expect(readClipboardImage(options)).resolves.toBeUndefined()
  })

  it('reads nothing on a platform without a reader', async () => {
    const { run, calls } = fakeRunner(() => Buffer.from(IMAGE_BYTES))
    await expect(readClipboardImage({ platform: 'aix', run })).resolves.toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe('systemClipboard', () => {
  it('returns the stdout of a command that succeeds', async () => {
    const stdout = await systemClipboard.run(process.execPath, ['-e', 'process.stdout.write("bytes")'], 5_000)
    expect(stdout?.toString('utf8')).toBe('bytes')
  })

  it('returns nothing for a command that exits non-zero', async () => {
    await expect(systemClipboard.run(process.execPath, ['-e', 'process.exit(3)'], 5_000)).resolves.toBeUndefined()
  })

  it('returns nothing for a program that does not exist', async () => {
    await expect(systemClipboard.run('dsh-missing-clipboard-reader', [], 5_000)).resolves.toBeUndefined()
  })

  it('creates a unique staging path in the temporary directory', () => {
    const first = systemClipboard.stagePath()
    const second = systemClipboard.stagePath()
    expect(first).not.toBe(second)
    expect(first.startsWith(tmpdir())).toBe(true)
    expect(first.endsWith('.png')).toBe(true)
  })

  it('reads and deletes a staged file', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'staged.png')
    await writeFile(path, IMAGE_BYTES)
    await expect(systemClipboard.readStaged(path)).resolves.toEqual(IMAGE_BYTES)
    await expect(exists(path)).resolves.toBe(false)
  })

  it('deletes an empty staged file and reports nothing', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'staged.png')
    await writeFile(path, new Uint8Array())
    await expect(systemClipboard.readStaged(path)).resolves.toBeUndefined()
    await expect(exists(path)).resolves.toBe(false)
  })

  it('reports nothing when no staged file exists', async () => {
    const directory = await temporaryDirectory()
    await expect(systemClipboard.readStaged(join(directory, 'missing.png'))).resolves.toBeUndefined()
  })
})

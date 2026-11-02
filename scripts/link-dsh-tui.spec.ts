/**
 * The global `dsh-tui` installer: target resolution, idempotent install and
 * refresh, refusal to clobber another program's entry, and removal.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BIN_DIR_ENV,
  installCommand,
  isOnPath,
  parseArgs,
  removeCommand,
  resolveBinDir,
  run,
  type CommandPaths,
} from './link-dsh-tui.ts'

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Create one temporary root.
 * @returns the absolute directory.
 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-link-'))
  tempDirs.push(dir)
  return dir
}

/**
 * Build a fake checkout with a built launcher and a built CLI.
 * @returns the launcher and legacy CLI paths and the bin directory to install into.
 */
function fixture(): { binPath: string; binDir: string; legacyBinPath: string } {
  const root = tempDir()
  const binPath = join(root, 'repo', 'apps', 'tui-launcher', 'lib', 'bin.js')
  const legacyBinPath = join(root, 'repo', 'apps', 'cli', 'lib', 'bin.js')
  mkdirSync(join(root, 'repo', 'apps', 'tui-launcher', 'lib'), { recursive: true })
  mkdirSync(join(root, 'repo', 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(binPath, '#!/usr/bin/env node\n')
  writeFileSync(legacyBinPath, '#!/usr/bin/env node\n')
  return { binPath, binDir: join(root, 'bin'), legacyBinPath }
}

/** Paths for one fixture install. */
function pathsFor(binPath: string, binDir: string, platform: NodeJS.Platform = 'darwin'): CommandPaths {
  return { binPath, binDir, platform }
}

describe('parseArgs', () => {
  it('accepts the documented flags and rejects the rest', () => {
    expect(parseArgs([])).toEqual({ remove: false, dir: undefined, help: false })
    expect(parseArgs(['--', '--dir', '/tmp/x'])).toEqual({ remove: false, dir: '/tmp/x', help: false })
    expect(parseArgs(['--remove'])).toEqual({ remove: true, dir: undefined, help: false })
    expect(parseArgs(['--dir', '/tmp/x'])).toEqual({ remove: false, dir: '/tmp/x', help: false })
    expect(parseArgs(['-h'])).toEqual({ remove: false, dir: undefined, help: true })
    expect(() => parseArgs(['--dir'])).toThrow(/--dir needs a path/)
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
  })
})

describe('resolveBinDir', () => {
  it('prefers the explicit environment override', () => {
    expect(resolveBinDir({ [BIN_DIR_ENV]: '/opt/custom' }, '/home/u', 'darwin')).toBe('/opt/custom')
    expect(resolveBinDir({ [BIN_DIR_ENV]: '  ' }, '/home/u', 'darwin')).toBe(join('/home/u', '.local', 'bin'))
  })

  it('uses the platform default', () => {
    expect(resolveBinDir({}, '/home/u', 'linux')).toBe(join('/home/u', '.local', 'bin'))
    expect(resolveBinDir({}, '/home/u', 'darwin')).toBe(join('/home/u', '.local', 'bin'))
    expect(resolveBinDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u', 'win32'))
      .toBe(join('C:\\Users\\u\\AppData\\Roaming', 'npm'))
    expect(resolveBinDir({}, 'C:\\Users\\u', 'win32')).toBe(join('C:\\Users\\u', 'AppData', 'Roaming', 'npm'))
  })
})

describe('isOnPath', () => {
  it('compares resolved entries per platform', () => {
    expect(isOnPath('/usr/bin:/home/u/.local/bin', '/home/u/.local/bin', 'linux')).toBe(true)
    expect(isOnPath('/usr/bin', '/home/u/.local/bin', 'linux')).toBe(false)
    expect(isOnPath('C:\\a;C:\\Users\\u\\bin', 'C:\\Users\\u\\bin', 'win32')).toBe(true)
    expect(isOnPath('C:\\a', 'C:\\Users\\u\\bin', 'win32')).toBe(false)
  })
})

describe('installCommand', () => {
  it('installs a symlink to the built launcher', () => {
    const { binPath, binDir } = fixture()
    const installed = installCommand(pathsFor(binPath, binDir))
    expect(installed).toEqual({ path: join(binDir, 'dsh-tui'), kind: 'symlink' })
    expect(lstatSync(join(binDir, 'dsh-tui')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(binDir, 'dsh-tui'))).toBe(binPath)
  })

  it('is idempotent and leaves no temporary entries', () => {
    const { binPath, binDir } = fixture()
    installCommand(pathsFor(binPath, binDir))
    installCommand(pathsFor(binPath, binDir))
    expect(readlinkSync(join(binDir, 'dsh-tui'))).toBe(binPath)
    expect(readdirSync(binDir)).toEqual(['dsh-tui'])
  })

  it('refreshes a dangling link a moved checkout left behind', () => {
    const { binPath, binDir } = fixture()
    mkdirSync(binDir, { recursive: true })
    symlinkSync(join(binDir, 'gone', 'bin.js'), join(binDir, 'dsh-tui'))
    installCommand(pathsFor(binPath, binDir))
    expect(readlinkSync(join(binDir, 'dsh-tui'))).toBe(binPath)
  })

  it('refuses a foreign symlink and a regular file', () => {
    const { binPath, binDir } = fixture()
    const other = join(binDir, 'other.js')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(other, '#!/bin/sh\n')
    symlinkSync(other, join(binDir, 'dsh-tui'))
    expect(() => installCommand(pathsFor(binPath, binDir))).toThrow(/belongs to another program/)
    rmSync(join(binDir, 'dsh-tui'))
    writeFileSync(join(binDir, 'dsh-tui'), '#!/bin/sh\n')
    expect(() => installCommand(pathsFor(binPath, binDir))).toThrow(/belongs to another program/)
  })

  it('fails loudly when the launcher has not been built', () => {
    const { binPath, binDir } = fixture()
    rmSync(binPath)
    expect(() => installCommand(pathsFor(binPath, binDir))).toThrow(/pnpm run build/)
  })

  it('writes forwarding shims on Windows', () => {
    const { binPath, binDir } = fixture()
    const installed = installCommand(pathsFor(binPath, binDir, 'win32'))
    expect(installed.kind).toBe('shim')
    expect(readFileSync(join(binDir, 'dsh-tui.cmd'), 'utf8')).toContain(binPath)
    expect(readFileSync(join(binDir, 'dsh-tui.ps1'), 'utf8')).toContain(binPath)
    // Re-running refreshes its own shims.
    installCommand(pathsFor(binPath, binDir, 'win32'))
    expect(readFileSync(join(binDir, 'dsh-tui.cmd'), 'utf8')).toContain(binPath)
  })

  it('refuses a foreign Windows shim', () => {
    const { binPath, binDir } = fixture()
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'dsh-tui.cmd'), '@ECHO OFF\r\necho other\r\n')
    expect(() => installCommand(pathsFor(binPath, binDir, 'win32'))).toThrow(/belongs to another program/)
  })
})

describe('removeCommand', () => {
  it('reports absence, removes its own link, and refuses a foreign entry', () => {
    const { binPath, binDir } = fixture()
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('absent')
    installCommand(pathsFor(binPath, binDir))
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('removed')
    expect(existsSync(join(binDir, 'dsh-tui'))).toBe(false)

    const other = join(binDir, 'other.js')
    writeFileSync(other, '#!/bin/sh\n')
    symlinkSync(other, join(binDir, 'dsh-tui'))
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('foreign')
    expect(existsSync(join(binDir, 'dsh-tui'))).toBe(true)
  })

  it('removes a dangling link from a previous checkout', () => {
    const { binPath, binDir } = fixture()
    mkdirSync(binDir, { recursive: true })
    symlinkSync(join(binDir, 'gone', 'bin.js'), join(binDir, 'dsh-tui'))
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('removed')
  })
})

describe('run', () => {
  it('removes a dsh link this checkout installed', () => {
    const { binPath, binDir, legacyBinPath } = fixture()
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    mkdirSync(binDir, { recursive: true })
    symlinkSync(legacyBinPath, join(binDir, 'dsh'))

    expect(run(['--dir', binDir], { PATH: '/usr/bin' }, '/home/u', 'linux', binPath, legacyBinPath)).toBe(0)
    expect(existsSync(join(binDir, 'dsh'))).toBe(false)
    expect(existsSync(join(binDir, 'dsh-tui'))).toBe(true)
    expect(out.join('')).toContain(`removed legacy ${join(binDir, 'dsh')}`)
  })

  it('leaves a dsh link owned by another program alone', () => {
    const { binPath, binDir, legacyBinPath } = fixture()
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const other = join(binDir, 'other.js')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(other, '#!/bin/sh\n')
    symlinkSync(other, join(binDir, 'dsh'))

    expect(run(['--dir', binDir], { PATH: '/usr/bin' }, '/home/u', 'linux', binPath, legacyBinPath)).toBe(0)
    expect(existsSync(join(binDir, 'dsh'))).toBe(true)
    expect(out.join('')).not.toContain('removed legacy')
  })

  it('removes legacy Windows shims that name this checkout', () => {
    const { binPath, binDir, legacyBinPath } = fixture()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'dsh.cmd'), `@ECHO OFF\r\nnode "${legacyBinPath}" %*\r\n`)
    writeFileSync(join(binDir, 'dsh.ps1'), `node "${legacyBinPath}" @args\r\n`)

    expect(run(['--dir', binDir], {}, '/home/u', 'win32', binPath, legacyBinPath)).toBe(0)
    expect(existsSync(join(binDir, 'dsh.cmd'))).toBe(false)
    expect(existsSync(join(binDir, 'dsh.ps1'))).toBe(false)
    expect(existsSync(join(binDir, 'dsh-tui.cmd'))).toBe(true)
  })

  it('removes the legacy link with --remove when dsh-tui is absent', () => {
    const { binPath, binDir, legacyBinPath } = fixture()
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    mkdirSync(binDir, { recursive: true })
    symlinkSync(legacyBinPath, join(binDir, 'dsh'))

    expect(run(['--remove', '--dir', binDir], {}, '/home/u', 'linux', binPath, legacyBinPath)).toBe(0)
    expect(existsSync(join(binDir, 'dsh'))).toBe(false)
    expect(out.join('')).toContain(`removed legacy ${join(binDir, 'dsh')}`)
    expect(out.join('')).not.toContain('nothing installed')
  })

  it('installs into --dir, reports a PATH miss, and removes again', () => {
    const { binPath, binDir } = fixture()
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(run(['--dir', binDir], { PATH: '/usr/bin' }, '/home/u', 'linux', binPath)).toBe(0)
    expect(out.join('')).toContain(`installed ${join(binDir, 'dsh-tui')}`)
    expect(out.join('')).toContain('add ')
    out.length = 0

    expect(run(['--remove', '--dir', binDir], { PATH: '/usr/bin' }, '/home/u', 'linux', binPath)).toBe(0)
    expect(out.join('')).toContain('removed')
    out.length = 0

    expect(run(['--remove', '--dir', binDir], { PATH: '/usr/bin' }, '/home/u', 'linux', binPath)).toBe(0)
    expect(out.join('')).toContain('nothing installed')
  })

  it('prints usage, and fails on a bad argument or a foreign entry', () => {
    const { binPath, binDir } = fixture()
    const out: string[] = []
    const err: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err.push(String(chunk)); return true })

    expect(run(['--help'], {}, '/home/u', 'linux', binPath)).toBe(0)
    expect(out.join('')).toContain('Usage: pnpm run link:dsh-tui')
    expect(run(['--nope'], {}, '/home/u', 'linux', binPath)).toBe(1)
    expect(err.join('')).toContain('unknown argument')

    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'dsh-tui'), '#!/bin/sh\n')
    expect(run(['--dir', binDir, '--remove'], {}, '/home/u', 'linux', binPath)).toBe(1)
    expect(err.join('')).toContain('belongs to another program')
  })
})

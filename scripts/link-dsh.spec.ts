/**
 * The global `dsh` installer: target resolution, idempotent install and
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
} from './link-dsh.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-link-'))
  tempDirs.push(dir)
  return dir
}

/**
 * Build a fake checkout with a built launcher.
 * @returns the launcher path and the bin directory to install into.
 */
function fixture(): { binPath: string; binDir: string } {
  const root = tempDir()
  const binPath = join(root, 'repo', 'apps', 'cli', 'lib', 'bin.js')
  mkdirSync(join(root, 'repo', 'apps', 'cli', 'lib'), { recursive: true })
  writeFileSync(binPath, '#!/usr/bin/env node\n')
  return { binPath, binDir: join(root, 'bin') }
}

/** Paths for one fixture install. */
function pathsFor(binPath: string, binDir: string, platform: NodeJS.Platform = 'darwin'): CommandPaths {
  return { binPath, binDir, platform }
}

describe('parseArgs', () => {
  it('accepts the documented flags and rejects the rest', () => {
    expect(parseArgs([])).toEqual({ remove: false, dir: undefined, help: false })
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
    expect(installed).toEqual({ path: join(binDir, 'dsh'), kind: 'symlink' })
    expect(lstatSync(join(binDir, 'dsh')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(binDir, 'dsh'))).toBe(binPath)
  })

  it('is idempotent and leaves no temporary entries', () => {
    const { binPath, binDir } = fixture()
    installCommand(pathsFor(binPath, binDir))
    installCommand(pathsFor(binPath, binDir))
    expect(readlinkSync(join(binDir, 'dsh'))).toBe(binPath)
    expect(readdirSync(binDir)).toEqual(['dsh'])
  })

  it('refreshes a dangling link a moved checkout left behind', () => {
    const { binPath, binDir } = fixture()
    mkdirSync(binDir, { recursive: true })
    symlinkSync(join(binDir, 'gone', 'bin.js'), join(binDir, 'dsh'))
    installCommand(pathsFor(binPath, binDir))
    expect(readlinkSync(join(binDir, 'dsh'))).toBe(binPath)
  })

  it('refuses a foreign symlink and a regular file', () => {
    const { binPath, binDir } = fixture()
    const other = join(binDir, 'other.js')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(other, '#!/bin/sh\n')
    symlinkSync(other, join(binDir, 'dsh'))
    expect(() => installCommand(pathsFor(binPath, binDir))).toThrow(/belongs to another program/)
    rmSync(join(binDir, 'dsh'))
    writeFileSync(join(binDir, 'dsh'), '#!/bin/sh\n')
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
    expect(readFileSync(join(binDir, 'dsh.cmd'), 'utf8')).toContain(binPath)
    expect(readFileSync(join(binDir, 'dsh.ps1'), 'utf8')).toContain(binPath)
    // Re-running refreshes its own shims.
    installCommand(pathsFor(binPath, binDir, 'win32'))
    expect(readFileSync(join(binDir, 'dsh.cmd'), 'utf8')).toContain(binPath)
  })

  it('refuses a foreign Windows shim', () => {
    const { binPath, binDir } = fixture()
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'dsh.cmd'), '@ECHO OFF\r\necho other\r\n')
    expect(() => installCommand(pathsFor(binPath, binDir, 'win32'))).toThrow(/belongs to another program/)
  })
})

describe('removeCommand', () => {
  it('reports absence, removes its own link, and refuses a foreign entry', () => {
    const { binPath, binDir } = fixture()
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('absent')
    installCommand(pathsFor(binPath, binDir))
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('removed')
    expect(existsSync(join(binDir, 'dsh'))).toBe(false)

    const other = join(binDir, 'other.js')
    writeFileSync(other, '#!/bin/sh\n')
    symlinkSync(other, join(binDir, 'dsh'))
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('foreign')
    expect(existsSync(join(binDir, 'dsh'))).toBe(true)
  })

  it('removes a dangling link from a previous checkout', () => {
    const { binPath, binDir } = fixture()
    mkdirSync(binDir, { recursive: true })
    symlinkSync(join(binDir, 'gone', 'bin.js'), join(binDir, 'dsh'))
    expect(removeCommand(pathsFor(binPath, binDir))).toBe('removed')
  })
})

describe('run', () => {
  it('installs into --dir, reports a PATH miss, and removes again', () => {
    const { binPath, binDir } = fixture()
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    expect(run(['--dir', binDir], { PATH: '/usr/bin' }, '/home/u', 'linux', binPath)).toBe(0)
    expect(out.join('')).toContain(`installed ${join(binDir, 'dsh')}`)
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
    expect(out.join('')).toContain('Usage: pnpm run link:dsh')
    expect(run(['--nope'], {}, '/home/u', 'linux', binPath)).toBe(1)
    expect(err.join('')).toContain('unknown argument')

    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'dsh'), '#!/bin/sh\n')
    expect(run(['--dir', binDir, '--remove'], {}, '/home/u', 'linux', binPath)).toBe(1)
    expect(err.join('')).toContain('belongs to another program')
  })
})

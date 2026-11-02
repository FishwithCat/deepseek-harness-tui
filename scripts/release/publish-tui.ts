/**
 * Publish or stage the packed terminal distribution in its dependency order.
 *
 * Publication is a separate, explicit step: `pack-tui` produces the tarballs
 * without credentials, and this command uploads exactly those bytes. A failed
 * package stops the sequence so a partial release is never reported as done.
 *
 * `--stage` defers proof of presence: npm uploads every tarball under the
 * requested tag but leaves it invisible to installs until an owner approves its
 * stage id. The ids are written to `stage-ids.json` in the pack directory, in
 * publish order, so approval follows dependency order.
 *
 * @module scripts/release/publish-tui
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { TUI_SCOPE } from './pack-tui.ts'
import { attempt, attemptEchoed, capture } from './process.ts'
import { packedManifest, readPublishOrder } from './tarball.ts'

/** File recording the stage ids of a staged release, in publish order. */
export const STAGE_IDS_FILE = 'stage-ids.json'

/** One staged package waiting for an owner's approval. */
export interface StagedPackage {
  readonly name: string
  readonly version: string
  readonly stageId: string
}

/** First npm major version that implements `npm stage`. */
const STAGE_NPM_MAJOR = 12

/**
 * Build the npm publish arguments for one packed tarball.
 * @param tarball - absolute tarball path.
 * @param options - the required dist-tag and whether to rehearse.
 * @returns npm arguments.
 */
export function publishArgs(
  tarball: string,
  options: { tag: string; dryRun?: boolean },
): string[] {
  return [
    'publish',
    tarball,
    '--access',
    'public',
    '--tag',
    options.tag,
    ...options.dryRun === true ? ['--dry-run'] : [],
  ]
}

/**
 * Build the `npm stage publish` arguments for one packed tarball.
 * @param tarball - absolute tarball path.
 * @param options - the required dist-tag and whether to rehearse.
 * @returns npm arguments.
 */
export function stagePublishArgs(
  tarball: string,
  options: { tag: string; dryRun?: boolean },
): string[] {
  return [
    'stage',
    'publish',
    tarball,
    '--access',
    'public',
    '--tag',
    options.tag,
    '--json',
    ...options.dryRun === true ? ['--dry-run'] : [],
  ]
}

/**
 * Read the major version of an npm version string.
 * @param version - output of `npm --version`.
 * @returns the major version number.
 */
export function npmMajor(version: string): number {
  const match = /^(\d+)\./u.exec(version.trim())
  if (match?.[1] === undefined) {
    throw new Error(`publish-tui: cannot read an npm version from ${JSON.stringify(version)}`)
  }
  return Number(match[1])
}

/**
 * Reject an npm that predates `npm stage`.
 * @param major - the running npm's major version.
 */
export function requireStageNpm(major: number): void {
  if (major < STAGE_NPM_MAJOR) {
    throw new Error(`publish-tui: --stage requires npm ${String(STAGE_NPM_MAJOR)} or later, found ${String(major)}`)
  }
}

/**
 * Read the stage id npm printed for one tarball.
 * @param stdout - standard output of `npm stage publish --json`.
 * @returns the staged package identity.
 */
export function parseStageResult(stdout: string): StagedPackage {
  const parsed: unknown = JSON.parse(stdout)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('publish-tui: npm stage publish did not print a JSON object')
  }
  const [record] = Object.values(parsed as Record<string, unknown>)
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('publish-tui: npm stage publish printed no package record')
  }
  const { name, version, stageId } = record as Record<string, unknown>
  if (typeof name !== 'string' || typeof version !== 'string' || typeof stageId !== 'string' || stageId === '') {
    throw new Error('publish-tui: npm stage publish printed no stage id')
  }
  return { name, version, stageId }
}

/**
 * Upload or stage every tarball recorded in the pack order.
 */
function main(): void {
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      tag: { type: 'string' },
      stage: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: false,
    args: argv[0] === '--' ? argv.slice(1) : argv,
  })
  const tag = values.tag
  if (tag === undefined || tag.trim() === '') {
    throw new Error('publish-tui: pass --tag <latest|next|alpha>; npm requires an explicit tag for a prerelease version')
  }
  const from = resolve(values.from ?? 'dist/tui')
  const order = readPublishOrder(from)
  if (order.length === 0) throw new Error(`publish-tui: ${from} holds no tarballs`)
  const staging = values.stage === true
  const dryRun = values['dry-run'] === true
  if (staging) requireStageNpm(npmMajor(capture('npm', ['--version'])))
  const staged: StagedPackage[] = []
  for (const filename of order) {
    const tarball = resolve(from, filename)
    const manifest = packedManifest(tarball)
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(`${TUI_SCOPE}/`)) {
      throw new Error(`publish-tui: ${filename} is not a ${TUI_SCOPE} package`)
    }
    if (manifest.private === true) throw new Error(`publish-tui: ${filename} is private`)
    const options = {
      tag,
      dryRun,
    }
    if (staging) {
      const result = attempt('npm', stagePublishArgs(tarball, options))
      if (result.status !== 0) {
        throw new Error(`publish-tui: npm stage publish ${filename} exited with ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
      }
      if (dryRun) {
        console.log(`  staged ${manifest.name}@${String(manifest.version)} (dry run)`)
      } else {
        const record = parseStageResult(result.stdout)
        staged.push(record)
        console.log(`  staged ${record.name}@${record.version} with id ${record.stageId}`)
      }
      continue
    }
    const result = attemptEchoed('npm', publishArgs(tarball, options))
    if (result.status !== 0) {
      throw new Error(`publish-tui: npm publish ${filename} exited with ${String(result.status)}`)
    }
  }
  if (staging) {
    if (dryRun) {
      console.log(`publish-tui: staged ${String(order.length)} package(s) (dry run)`)
      return
    }
    writeFileSync(join(from, STAGE_IDS_FILE), `${JSON.stringify(staged, undefined, 2)}\n`)
    console.log(`publish-tui: staged ${String(staged.length)} package(s); approve in this order:`)
    for (const record of staged) {
      console.log(`  npm stage approve ${record.stageId}  # ${record.name}@${record.version}`)
    }
    return
  }
  console.log(`publish-tui: published ${String(order.length)} package(s)`)
}

if (import.meta.main) main()

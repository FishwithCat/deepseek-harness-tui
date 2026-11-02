/**
 * Publish the packed terminal distribution in its dependency order.
 *
 * Publication is a separate, explicit step: `pack-tui` produces the tarballs
 * without credentials, and this command uploads exactly those bytes. A failed
 * package stops the sequence so a partial release is never reported as done.
 *
 * @module scripts/release/publish-tui
 */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { TUI_SCOPE } from './pack-tui.ts'
import { attemptEchoed } from './process.ts'
import { packedManifest, readPublishOrder } from './tarball.ts'

/**
 * Build the npm publish arguments for one packed tarball.
 * @param tarball - absolute tarball path.
 * @param options - provenance, the required dist-tag, and whether to rehearse.
 * @returns npm arguments.
 */
export function publishArgs(
  tarball: string,
  options: { provenance: boolean; tag: string; dryRun?: boolean },
): string[] {
  return [
    'publish',
    tarball,
    '--access',
    'public',
    '--tag',
    options.tag,
    ...options.provenance ? ['--provenance'] : [],
    ...options.dryRun === true ? ['--dry-run'] : [],
  ]
}

/** Publish every tarball recorded in the pack order. */
function main(): void {
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      provenance: { type: 'boolean' },
      tag: { type: 'string' },
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
  for (const filename of order) {
    const tarball = resolve(from, filename)
    const manifest = packedManifest(tarball)
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(`${TUI_SCOPE}/`)) {
      throw new Error(`publish-tui: ${filename} is not a ${TUI_SCOPE} package`)
    }
    if (manifest.private === true) throw new Error(`publish-tui: ${filename} is private`)
    const result = attemptEchoed('npm', publishArgs(tarball, {
      provenance: values.provenance === true,
      tag,
      dryRun: values['dry-run'] === true,
    }))
    if (result.status !== 0) {
      throw new Error(`publish-tui: npm publish ${filename} exited with ${String(result.status)}`)
    }
  }
  console.log(`publish-tui: published ${String(order.length)} package(s)`)
}

if (import.meta.main) main()

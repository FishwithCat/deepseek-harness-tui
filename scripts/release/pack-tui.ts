/**
 * Pack the npm-installable terminal distribution.
 *
 * The distribution cannot publish under `@deepseek-ai`: that scope belongs to
 * upstream, and `@deepseek-ai/dsh-tui-app` does not exist on the registry.
 * This script repacks the fork-only packages under `@fishwithcat` and turns
 * every dependency on one of them into an `npm:` alias, so the upstream CLI
 * still resolves the original names while the launcher's installation tree
 * carries the fork's builds. The launcher manifest also pins the upstream
 * packages the TUI composes.
 *
 * The pack set has two layers. The core overlay patches packages that upstream
 * packages also depend on, and those upstream packages declare exact versions
 * and required peers, so the overlay keeps upstream's version. The TUI layer
 * (CLI, TUI bundle, and launcher) is only referenced by the launcher and the
 * fork itself, so it carries `<upstream>.fork.<n>`. Its aliases name each
 * layer at that layer's published version; only non-fork workspace ranges stay
 * at the upstream version.
 *
 * @module scripts/release/pack-tui
 */

import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { capture } from './process.ts'
import { packedManifest, PUBLISH_ORDER_FILE, tarballFiles } from './tarball.ts'

/** Registry scope the packed distribution publishes under. */
export const TUI_SCOPE = '@fishwithcat'

/** One package name in the publishing scope. */
function tuiPackage(name: string): string {
  return `${TUI_SCOPE}/${name}`
}

/** Release layer a packed member belongs to. */
export type TuiLayer = 'core' | 'tui'

/** Packages the distribution carries, in publish order. */
export const TUI_MEMBERS: readonly {
  readonly directory: string
  readonly layer: TuiLayer
  readonly launcher?: true
  readonly cli?: true
  readonly published?: string
}[] = [
  { directory: 'packages/core/agent', layer: 'core' },
  { directory: 'packages/core/session', layer: 'core' },
  { directory: 'packages/interaction/user-approval', layer: 'core' },
  { directory: 'packages/interaction/tool-ask-user', layer: 'core' },
  { directory: 'packages/compaction/compaction', layer: 'core' },
  { directory: 'packages/compaction/compaction-basic', layer: 'core' },
  { directory: 'packages/subagent/subagent', layer: 'core' },
  { directory: 'packages/todo/tool-todo', layer: 'core' },
  { directory: 'packages/bundle/tui-app', layer: 'tui' },
  { directory: 'apps/cli', cli: true, layer: 'tui', published: tuiPackage('dsh') },
  { directory: 'apps/tui-launcher', launcher: true, layer: 'tui', published: tuiPackage('dsh-tui') },
]

/** Source package name → published package name. */
export const TUI_ALIASES: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh': tuiPackage('dsh'),
  '@deepseek-ai/dsh-agent': tuiPackage('dsh-agent'),
  '@deepseek-ai/dsh-session': tuiPackage('dsh-session'),
  '@deepseek-ai/dsh-user-approval': tuiPackage('dsh-user-approval'),
  '@deepseek-ai/dsh-tool-ask-user': tuiPackage('dsh-tool-ask-user'),
  '@deepseek-ai/dsh-compaction': tuiPackage('dsh-compaction'),
  '@deepseek-ai/dsh-compaction-basic': tuiPackage('dsh-compaction-basic'),
  '@deepseek-ai/dsh-subagent': tuiPackage('dsh-subagent'),
  '@deepseek-ai/dsh-tool-todo': tuiPackage('dsh-tool-todo'),
  '@deepseek-ai/dsh-tui-app': tuiPackage('dsh-tui-app'),
}

/**
 * Rewrite the ownership field of a generated Typert manifest.
 *
 * The Typert loader rejects a manifest whose `package` differs from the
 * package that exports it. Type symbols intentionally keep the source name:
 * they are cross-package type identities, not ownership fields.
 * @param text - generated Typert module contents.
 * @param sourceName - package name the generator embedded.
 * @param publishedName - package name the packed manifest declares.
 * @returns the contents with ownership fields updated.
 */
export function rewriteTypertManifest(text: string, sourceName: string, publishedName: string): string {
  return text
    .replaceAll(`package: '${sourceName}'`, `package: '${publishedName}'`)
    .replaceAll(`package: "${sourceName}"`, `package: "${publishedName}"`)
}

/** Upstream bundle layer the launcher pins beside the aliased TUI. */
const BASE_PACKAGE = '@deepseek-ai/dsh-base'

/** Repository URL every packed manifest declares, so npm records the publishing repository. */
export const FORK_REPOSITORY = 'https://github.com/FishwithCat/deepseek-harness-tui'

/** Dependency sections a packed manifest rewrites. */
const DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const

/** One rewrite input for {@link rewriteTuiManifest}. */
export interface TuiRewriteContext {
  /** Name the packed package declares. */
  readonly publishedName: string
  /** Version this packed package carries. */
  readonly version: string
  /** Workspace package name → version, for every `workspace:` range. */
  readonly versions: ReadonlyMap<string, string>
  /** Upstream package name → version its packed fork package carries. */
  readonly aliasVersions: ReadonlyMap<string, string>
  /** Whether the package is the launcher that pins the composed packages. */
  readonly launcher?: boolean | undefined
  /** Whether the packed CLI's `dsh` bin must be removed. */
  readonly stripBin?: boolean | undefined
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve one `workspace:` range against the package version it names.
 * @param spec - the workspace range from the source manifest.
 * @param name - dependency name, used in the failure message.
 * @param versions - workspace package versions.
 * @returns the published range.
 * @throws when the workspace has no manifest for the dependency.
 */
function workspaceRange(spec: string, name: string, versions: ReadonlyMap<string, string>): string {
  const version = versions.get(name)
  if (version === undefined) throw new Error(`pack-tui: no workspace version for ${name}`)
  const range = spec.slice('workspace:'.length)
  if (range === '' || range === '*') return version
  if (range === '^') return `^${version}`
  if (range === '~') return `~${version}`
  return range
}

/**
 * Rewrite one source manifest into its packed form.
 *
 * Dependencies on a fork-only package become `npm:` aliases at that package's
 * packed version; every other workspace range becomes the exact upstream
 * version. The launcher additionally pins the upstream base bundle and every
 * aliased package, because the profile resolves bundle names from the
 * launcher's installation.
 * @param manifest - the source package.json.
 * @param context - published identity, version, workspace versions, and packed
 * alias versions.
 * @returns a new manifest for the packed package.
 */
export function rewriteTuiManifest(
  manifest: Readonly<Record<string, unknown>>,
  context: TuiRewriteContext,
): Record<string, unknown> {
  const next = structuredClone(manifest) as Record<string, unknown>
  next.name = context.publishedName
  next.version = context.version
  delete next.private
  if (context.stripBin === true) delete next.bin
  if (isRecord(next.repository)) {
    next.repository = { ...next.repository, type: 'git', url: FORK_REPOSITORY }
  }

  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = next[section]
    if (!isRecord(dependencies)) continue
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      const alias = section === 'dependencies' || section === 'optionalDependencies' ? TUI_ALIASES[name] : undefined
      if (alias === undefined) {
        dependencies[name] = workspaceRange(spec, name, context.versions)
        continue
      }
      const aliasVersion = context.aliasVersions.get(name)
      if (aliasVersion === undefined) throw new Error(`pack-tui: no packed version for ${name}`)
      dependencies[name] = `npm:${alias}@${aliasVersion}`
    }
  }

  if (context.launcher === true) {
    const dependencies = isRecord(next.dependencies) ? next.dependencies : {}
    dependencies[BASE_PACKAGE] = workspaceRange('workspace:*', BASE_PACKAGE, context.versions)
    for (const [source, published] of Object.entries(TUI_ALIASES)) {
      const aliasVersion = context.aliasVersions.get(source)
      if (aliasVersion === undefined) throw new Error(`pack-tui: no packed version for ${source}`)
      dependencies[source] = `npm:${published}@${aliasVersion}`
    }
    next.dependencies = dependencies
  }

  return next
}

/**
 * Read every workspace package's name and version.
 * @param root - repository root.
 * @returns name → version for app, package, vendor, and native platform manifests.
 */
export function readWorkspaceVersions(root: string): Map<string, string> {
  const versions = new Map<string, string>()
  const manifests = [
    ...globSync('apps/*/package.json', { cwd: root }),
    ...globSync('packages/*/*/package.json', { cwd: root }),
    ...globSync('vendor/*/package.json', { cwd: root }),
    ...globSync('native/system/packages/*/package.json', { cwd: root }),
  ]
  for (const relative of manifests) {
    const manifest = JSON.parse(readFileSync(join(root, relative), 'utf8')) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
    versions.set(manifest.name, manifest.version)
  }
  return versions
}

/** One member resolved for packing. */
export interface ResolvedMember {
  /** Absolute source directory. */
  readonly directory: string
  /** Source package name. */
  readonly sourceName: string
  /** Published package name. */
  readonly publishedName: string
  /** Release layer that decides the packed version. */
  readonly layer: TuiLayer
  /** Version the packed tarball carries. */
  readonly publishedVersion: string
  /** Whether this member is the launcher. */
  readonly launcher: boolean
  /** Relative `lib/` file the tarball must contain. */
  readonly entry: string
  /** Whether the packed CLI's `dsh` bin must be removed. */
  readonly stripBin: boolean
}

/**
 * Resolve the pack set against the checkout.
 * Every source manifest stays on the upstream version. Only TUI-layer members
 * take the fork version; core-overlay members keep the upstream version so
 * upstream exact ranges and required peers keep resolving to one copy.
 * @param root - repository root.
 * @param baseVersion - upstream version every source manifest must declare.
 * @param forkVersion - TUI-layer version, in `<baseVersion>.fork.<n>` form.
 * @returns resolved members in publish order.
 * @throws when a source manifest is not on `baseVersion`, or `forkVersion` is
 * based on a different upstream version.
 */
export function resolveMembers(
  root: string,
  baseVersion: string,
  forkVersion: string,
): ResolvedMember[] {
  if (forkBase(forkVersion) !== baseVersion) {
    throw new Error(`pack-tui: ${forkVersion} is not based on ${baseVersion}`)
  }
  return TUI_MEMBERS.map(({ directory, layer, launcher, cli, published }) => {
    const absolute = join(root, directory)
    const manifest = JSON.parse(readFileSync(join(absolute, 'package.json'), 'utf8')) as {
      name: string
      version: string
    }
    if (manifest.version !== baseVersion) {
      throw new Error(`pack-tui: ${manifest.name} declares ${manifest.version}, expected ${baseVersion}`)
    }
    const publishedName = published ?? (launcher === true
      ? tuiPackage('dsh-tui')
      : (TUI_ALIASES[manifest.name] ?? `${TUI_SCOPE}/${manifest.name.slice('@deepseek-ai/'.length)}`)
    )
    return {
      directory: absolute,
      sourceName: manifest.name,
      publishedName,
      layer,
      publishedVersion: layer === 'tui' ? forkVersion : baseVersion,
      launcher: launcher === true,
      entry: launcher === true || cli === true ? 'lib/bin.js' : 'lib/index.js',
      stripBin: cli === true,
    }
  })
}

/**
 * Read the upstream base from a fork version.
 * @param version - `<base>.fork.<n>`.
 * @returns the upstream base version.
 * @throws when the version does not use the fork form.
 */
export function forkBase(version: string): string {
  const match = /^(.+)\.fork\.(\d+)$/u.exec(version)
  if (match?.[1] === undefined) {
    throw new Error(`pack-tui: ${JSON.stringify(version)} is not a <base>.fork.<n> version`)
  }
  return match[1]
}

/** Copy a package into a staging directory without its dependency tree. */
function stageMember(
  member: ResolvedMember,
  versions: ReadonlyMap<string, string>,
  aliasVersions: ReadonlyMap<string, string>,
): string {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-tui-pack-'))
  cpSync(member.directory, staging, {
    recursive: true,
    filter: source => !source.split(sep).includes('node_modules'),
  })
  const manifestPath = join(staging, 'package.json')
  const source = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  for (const file of globSync('lib/typert*.js', { cwd: staging })) {
    const path = join(staging, file)
    const text = readFileSync(path, 'utf8')
    const rewritten = rewriteTypertManifest(text, member.sourceName, member.publishedName)
    if (rewritten !== text) writeFileSync(path, rewritten)
  }
  writeFileSync(manifestPath, `${JSON.stringify(rewriteTuiManifest(source, {
    publishedName: member.publishedName,
    version: member.publishedVersion,
    versions,
    aliasVersions,
    launcher: member.launcher,
    stripBin: member.stripBin,
  }), undefined, 2)}\n`)
  return staging
}

/** Pack one staged member and return its tarball path. */
function packStaged(staging: string, destination: string, publishedName: string, version: string): string {
  const stdout = capture('npm', ['pack', '--json', '--pack-destination', destination], { cwd: staging })
  const [record] = JSON.parse(stdout) as [{ filename: string }]
  const target = join(destination, `${publishedName.slice(1).replace('/', '-')}-${version}.tgz`)
  renameSync(join(destination, record.filename), target)
  return target
}

/**
 * Validate one packed tarball's identity, members, and dependency ranges.
 * @param tarball - absolute tarball path.
 * @param member - the member it should contain.
 */
export function validateTarball(tarball: string, member: ResolvedMember): void {
  const manifest = packedManifest(tarball)
  if (manifest.name !== member.publishedName) {
    throw new Error(`pack-tui: ${tarball} declares ${String(manifest.name)}, expected ${member.publishedName}`)
  }
  if (manifest.version !== member.publishedVersion) {
    throw new Error(`pack-tui: ${tarball} declares ${String(manifest.version)}, expected ${member.publishedVersion}`)
  }
  if (JSON.stringify(manifest).includes('workspace:')) {
    throw new Error(`pack-tui: ${tarball} still contains a workspace range`)
  }
  const files = tarballFiles(tarball)
  const entry = `package/${member.entry}`
  if (!files.includes(entry)) throw new Error(`pack-tui: ${tarball} is missing ${entry}`)
  if (!files.includes('package/package.json')) throw new Error(`pack-tui: ${tarball} is missing package.json`)
}

/**
 * Select the members one release publishes.
 *
 * A TUI-layer release assumes the core overlay for its base is already on the
 * registry; `withCore` republishes that overlay when adopting a new base.
 * @param members - every resolved member.
 * @param withCore - whether to include the core overlay.
 * @returns members to pack, in publish order.
 */
export function releaseMembers(
  members: readonly ResolvedMember[],
  withCore: boolean,
): ResolvedMember[] {
  return withCore ? [...members] : members.filter(member => member.layer === 'tui')
}

/**
 * Pack the selected members into `destination`, in publish order.
 * @param root - repository root.
 * @param destination - absolute output directory.
 * @param forkVersion - TUI-layer version, in `<base>.fork.<n>` form.
 * @param options - whether to include the core overlay.
 * @returns tarball filenames in publish order.
 */
export function packTui(
  root: string,
  destination: string,
  forkVersion: string,
  options: { withCore?: boolean } = {},
): string[] {
  const baseVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
  const versions = readWorkspaceVersions(root)
  const members = resolveMembers(root, baseVersion, forkVersion)
  const aliasVersions = new Map(members.map(member => [member.sourceName, member.publishedVersion]))
  const selected = releaseMembers(members, options.withCore === true)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const order: string[] = []
  for (const member of selected) {
    const staging = stageMember(member, versions, aliasVersions)
    try {
      const tarball = packStaged(staging, destination, member.publishedName, member.publishedVersion)
      validateTarball(tarball, member)
      order.push(basename(tarball))
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${order.join('\n')}\n`)
  return order
}

/** Parse the pack command. */
function main(): void {
  const argv = process.argv.slice(2)
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      version: { type: 'string' },
      'with-core': { type: 'boolean' },
    },
    allowPositionals: false,
    args: argv[0] === '--' ? argv.slice(1) : argv,
  })
  const root = resolve(import.meta.dirname, '../..')
  const destination = resolve(root, values.out ?? 'dist/tui')
  const forkVersion = values.version
  if (forkVersion === undefined) throw new Error('pack-tui: pass --version <base>.fork.<n>')
  const baseVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version
  if (forkBase(forkVersion) !== baseVersion) {
    throw new Error(`pack-tui: ${forkVersion} is not based on ${baseVersion}`)
  }
  const withCore = values['with-core'] === true
  const order = packTui(root, destination, forkVersion, { withCore })
  console.log(`pack-tui: ${String(order.length)} tarball(s) for ${forkVersion} (base ${baseVersion}) in ${destination}`)
  if (!withCore) console.log('pack-tui: core overlay omitted; it must already be published for this base')
  for (const filename of order) console.log(`  ${filename}`)
}

if (import.meta.main) main()

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  forkBase,
  readWorkspaceVersions,
  releaseMembers,
  resolveMembers,
  rewriteTuiManifest,
  rewriteTypertManifest,
  TUI_ALIASES,
} from './pack-tui.ts'

const BASE = '0.2.2-alpha.2'
const FORK = '0.2.2-alpha.2.fork.1'

const VERSIONS = new Map([
  ['@deepseek-ai/dsh', BASE],
  ['@deepseek-ai/dsh-base', BASE],
  ['@deepseek-ai/dsh-llm', BASE],
  ['@deepseek-ai/dsh-agent', BASE],
  ['@deepseek-ai/dsh-session', BASE],
  ['@deepseek-ai/dsh-tui-app', BASE],
])

const ALIAS_VERSIONS = new Map([
  ['@deepseek-ai/dsh', FORK],
  ['@deepseek-ai/dsh-agent', BASE],
  ['@deepseek-ai/dsh-session', BASE],
  ['@deepseek-ai/dsh-user-approval', BASE],
  ['@deepseek-ai/dsh-tool-ask-user', BASE],
  ['@deepseek-ai/dsh-compaction', BASE],
  ['@deepseek-ai/dsh-compaction-basic', BASE],
  ['@deepseek-ai/dsh-subagent', BASE],
  ['@deepseek-ai/dsh-tool-todo', BASE],
  ['@deepseek-ai/dsh-tui-app', FORK],
])

describe('rewriteTuiManifest', () => {
  it('keeps a core-overlay package and its upstream ranges on the base version', () => {
    const manifest = {
      name: '@deepseek-ai/dsh-agent',
      version: BASE,
      private: true,
      dependencies: { '@deepseek-ai/dsh-llm': 'workspace:*' },
      peerDependencies: { '@deepseek-ai/dsh-session': 'workspace:*' },
    }
    expect(rewriteTuiManifest(manifest, {
      publishedName: '@fishwithcat/dsh-agent',
      version: BASE,
      versions: VERSIONS,
      aliasVersions: ALIAS_VERSIONS,
    })).toEqual({
      name: '@fishwithcat/dsh-agent',
      version: BASE,
      dependencies: { '@deepseek-ai/dsh-llm': BASE },
      peerDependencies: { '@deepseek-ai/dsh-session': BASE },
    })
  })

  it('aliases a dependency on another fork package at that package version', () => {
    const manifest = {
      name: '@deepseek-ai/dsh-tui-app',
      version: BASE,
      dependencies: {
        '@deepseek-ai/dsh-agent': 'workspace:*',
        '@deepseek-ai/dsh-brand': 'workspace:~',
        '@deepseek-ai/dsh-util-values': 'workspace:^',
      },
      peerDependencies: { '@deepseek-ai/dsh-agent': 'workspace:*' },
    }
    const rewritten = rewriteTuiManifest(manifest, {
      publishedName: '@fishwithcat/dsh-tui-app',
      version: FORK,
      versions: new Map([
        ...VERSIONS,
        ['@deepseek-ai/dsh-brand', BASE],
        ['@deepseek-ai/dsh-util-values', BASE],
      ]),
      aliasVersions: ALIAS_VERSIONS,
    })
    expect(rewritten).toMatchObject({
      name: '@fishwithcat/dsh-tui-app',
      version: FORK,
      dependencies: {
        '@deepseek-ai/dsh-agent': `npm:@fishwithcat/dsh-agent@${BASE}`,
        '@deepseek-ai/dsh-brand': `~${BASE}`,
        '@deepseek-ai/dsh-util-values': `^${BASE}`,
      },
      peerDependencies: { '@deepseek-ai/dsh-agent': BASE },
    })
  })

  it('pins the base bundle and every alias at its layer version in the launcher', () => {
    const rewritten = rewriteTuiManifest({
      name: '@deepseek-ai/dsh-tui-launcher',
      version: BASE,
      private: true,
      bin: { 'dsh-tui': 'lib/bin.js' },
      dependencies: {
        '@deepseek-ai/dsh': 'workspace:*',
        '@deepseek-ai/dsh-app-boot': 'workspace:*',
      },
    }, {
      publishedName: '@fishwithcat/dsh-tui',
      version: FORK,
      versions: new Map([...VERSIONS, ['@deepseek-ai/dsh-app-boot', BASE]]),
      aliasVersions: ALIAS_VERSIONS,
      launcher: true,
    })
    const dependencies = rewritten.dependencies as Record<string, string>
    expect(dependencies['@deepseek-ai/dsh']).toBe(`npm:@fishwithcat/dsh@${FORK}`)
    expect(dependencies['@deepseek-ai/dsh-app-boot']).toBe(BASE)
    expect(dependencies['@deepseek-ai/dsh-base']).toBe(BASE)
    for (const [source, published] of Object.entries(TUI_ALIASES)) {
      const version = source === '@deepseek-ai/dsh' || source === '@deepseek-ai/dsh-tui-app' ? FORK : BASE
      expect(dependencies[source]).toBe(`npm:${published}@${version}`)
    }
    expect(rewritten).not.toHaveProperty('private')
    expect(rewritten.bin).toEqual({ 'dsh-tui': 'lib/bin.js' })
  })

  it('removes the CLI bin and aliases the TUI bundle at the fork version', () => {
    const rewritten = rewriteTuiManifest({
      name: '@deepseek-ai/dsh',
      version: BASE,
      bin: { dsh: 'lib/bin.js' },
      dependencies: {
        '@deepseek-ai/dsh-tui-app': 'workspace:*',
        '@deepseek-ai/dsh-agent': 'workspace:*',
      },
    }, {
      publishedName: '@fishwithcat/dsh',
      version: FORK,
      versions: VERSIONS,
      aliasVersions: ALIAS_VERSIONS,
      stripBin: true,
    })
    expect(rewritten).not.toHaveProperty('bin')
    const dependencies = rewritten.dependencies as Record<string, string>
    expect(dependencies['@deepseek-ai/dsh-tui-app']).toBe(`npm:@fishwithcat/dsh-tui-app@${FORK}`)
    expect(dependencies['@deepseek-ai/dsh-agent']).toBe(`npm:@fishwithcat/dsh-agent@${BASE}`)
  })

  it('points the packed repository at the publishing repository', () => {
    const rewritten = rewriteTuiManifest({
      name: '@deepseek-ai/dsh-agent',
      version: BASE,
      repository: {
        type: 'git',
        url: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
        directory: 'packages/core/agent',
      },
    }, {
      publishedName: '@fishwithcat/dsh-agent',
      version: BASE,
      versions: VERSIONS,
      aliasVersions: ALIAS_VERSIONS,
    })
    expect(rewritten.repository).toEqual({
      type: 'git',
      url: 'https://github.com/FishwithCat/deepseek-harness-tui',
      directory: 'packages/core/agent',
    })
  })

  it('rejects a workspace dependency without a version', () => {
    expect(() => rewriteTuiManifest({
      name: '@deepseek-ai/dsh-agent',
      version: BASE,
      dependencies: { '@deepseek-ai/dsh-missing': 'workspace:*' },
    }, {
      publishedName: '@fishwithcat/dsh-agent',
      version: BASE,
      versions: VERSIONS,
      aliasVersions: ALIAS_VERSIONS,
    })).toThrow(/no workspace version for @deepseek-ai\/dsh-missing/u)
  })

  it('rejects an alias without a packed version', () => {
    expect(() => rewriteTuiManifest({
      name: '@deepseek-ai/dsh',
      version: BASE,
      dependencies: { '@deepseek-ai/dsh-agent': 'workspace:*' },
    }, {
      publishedName: '@fishwithcat/dsh',
      version: FORK,
      versions: VERSIONS,
      aliasVersions: new Map(),
    })).toThrow(/no packed version for @deepseek-ai\/dsh-agent/u)
  })
})

describe('workspace members', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))

  it('reads every workspace version', () => {
    const versions = readWorkspaceVersions(root)
    expect(versions.get('@deepseek-ai/dsh')).toBe(BASE)
    expect(versions.get('@deepseek-ai/dsh-tui-app')).toBe(BASE)
  })

  it('resolves the publish set in dependency order with one version per layer', () => {
    const members = resolveMembers(root, BASE, FORK)
    expect(members.map(member => member.publishedName)).toEqual([
      '@fishwithcat/dsh-agent',
      '@fishwithcat/dsh-session',
      '@fishwithcat/dsh-user-approval',
      '@fishwithcat/dsh-tool-ask-user',
      '@fishwithcat/dsh-compaction',
      '@fishwithcat/dsh-compaction-basic',
      '@fishwithcat/dsh-subagent',
      '@fishwithcat/dsh-tool-todo',
      '@fishwithcat/dsh-tui-app',
      '@fishwithcat/dsh',
      '@fishwithcat/dsh-tui',
    ])
    expect(members.filter(member => member.layer === 'core').every(member => member.publishedVersion === BASE)).toBe(true)
    expect(members.filter(member => member.layer === 'tui').every(member => member.publishedVersion === FORK)).toBe(true)
    expect(members.at(-1)?.launcher).toBe(true)
  })

  it('publishes only the TUI layer unless the core overlay is requested', () => {
    const members = resolveMembers(root, BASE, FORK)
    expect(releaseMembers(members, false).map(member => member.publishedName)).toEqual([
      '@fishwithcat/dsh-tui-app',
      '@fishwithcat/dsh',
      '@fishwithcat/dsh-tui',
    ])
    expect(releaseMembers(members, true)).toHaveLength(members.length)
  })

  it('rejects a source manifest that is not on the base version', () => {
    expect(() => resolveMembers(root, '0.2.2-alpha.3', '0.2.2-alpha.3.fork.1'))
      .toThrow(/declares 0.2.2-alpha.2, expected 0.2.2-alpha.3/u)
  })

  it('rejects a fork version based on another upstream version', () => {
    expect(() => resolveMembers(root, BASE, '0.2.2-alpha.3.fork.1'))
      .toThrow(/not based on 0.2.2-alpha.2/u)
  })
})

describe('forkBase', () => {
  it('reads the upstream base from a fork version', () => {
    expect(forkBase(FORK)).toBe(BASE)
    expect(forkBase('0.2.2.fork.12')).toBe('0.2.2')
  })

  it('rejects a version without the fork suffix', () => {
    expect(() => forkBase(BASE)).toThrow(/is not a <base>\.fork\.<n> version/u)
    expect(() => forkBase('0.2.2-alpha.2-fork.1')).toThrow(/is not a <base>\.fork\.<n> version/u)
    expect(() => forkBase('0.2.2-alpha.2.fork.x')).toThrow(/is not a <base>\.fork\.<n> version/u)
  })
})

describe('rewriteTypertManifest', () => {
  it('renames the ownership field and leaves type symbols alone', () => {
    const text = [
      "const TYPERT = { package: '@deepseek-ai/dsh-subagent',",
      "  schemas: [{ typeSymbol: '@deepseek-ai/dsh-subagent#subagents/prompt' }] }",
    ].join('\n')
    expect(rewriteTypertManifest(text, '@deepseek-ai/dsh-subagent', '@fishwithcat/dsh-subagent'))
      .toContain("package: '@fishwithcat/dsh-subagent'")
    expect(rewriteTypertManifest(text, '@deepseek-ai/dsh-subagent', '@fishwithcat/dsh-subagent'))
      .toContain("typeSymbol: '@deepseek-ai/dsh-subagent#subagents/prompt'")
  })

  it('rewrites double-quoted ownership fields', () => {
    expect(rewriteTypertManifest('package: "@deepseek-ai/dsh-agent"', '@deepseek-ai/dsh-agent', '@fishwithcat/dsh-agent'))
      .toBe('package: "@fishwithcat/dsh-agent"')
  })
})

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  readWorkspaceVersions,
  resolveMembers,
  rewriteTuiManifest,
  rewriteTypertManifest,
  TUI_ALIASES,
} from './pack-tui.ts'

const VERSIONS = new Map([
  ['@deepseek-ai/dsh', '0.2.2-alpha.2'],
  ['@deepseek-ai/dsh-base', '0.2.2-alpha.2'],
  ['@deepseek-ai/dsh-llm', '0.2.2-alpha.2'],
  ['@deepseek-ai/dsh-agent', '0.2.2-alpha.2'],
  ['@deepseek-ai/dsh-session', '0.2.2-alpha.2'],
  ['@deepseek-ai/dsh-tui-app', '0.2.2-alpha.2'],
])

describe('rewriteTuiManifest', () => {
  it('publishes a fork package under its alias name and keeps upstream ranges exact', () => {
    const manifest = {
      name: '@deepseek-ai/dsh-agent',
      version: '0.2.2-alpha.2',
      private: true,
      dependencies: { '@deepseek-ai/dsh-llm': 'workspace:*' },
      peerDependencies: { '@deepseek-ai/dsh-session': 'workspace:*' },
    }
    expect(rewriteTuiManifest(manifest, {
      publishedName: '@fishwithcat/dsh-agent',
      version: '0.2.2-alpha.2',
      versions: VERSIONS,
    })).toEqual({
      name: '@fishwithcat/dsh-agent',
      version: '0.2.2-alpha.2',
      dependencies: { '@deepseek-ai/dsh-llm': '0.2.2-alpha.2' },
      peerDependencies: { '@deepseek-ai/dsh-session': '0.2.2-alpha.2' },
    })
  })

  it('aliases a dependency on another fork package and preserves range operators', () => {
    const manifest = {
      name: '@deepseek-ai/dsh-tui-app',
      version: '0.2.2-alpha.2',
      dependencies: {
        '@deepseek-ai/dsh-agent': 'workspace:*',
        '@deepseek-ai/dsh-brand': 'workspace:~',
        '@deepseek-ai/dsh-util-values': 'workspace:^',
      },
      peerDependencies: { '@deepseek-ai/dsh-agent': 'workspace:*' },
    }
    const rewritten = rewriteTuiManifest(manifest, {
      publishedName: '@fishwithcat/dsh-tui-app',
      version: '0.2.2-alpha.2',
      versions: new Map([
        ...VERSIONS,
        ['@deepseek-ai/dsh-brand', '0.2.2-alpha.2'],
        ['@deepseek-ai/dsh-util-values', '0.2.2-alpha.2'],
      ]),
    })
    expect(rewritten).toMatchObject({
      name: '@fishwithcat/dsh-tui-app',
      dependencies: {
        '@deepseek-ai/dsh-agent': 'npm:@fishwithcat/dsh-agent@0.2.2-alpha.2',
        '@deepseek-ai/dsh-brand': '~0.2.2-alpha.2',
        '@deepseek-ai/dsh-util-values': '^0.2.2-alpha.2',
      },
      peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.2-alpha.2' },
    })
  })

  it('pins the base bundle and every alias in the launcher', () => {
    const rewritten = rewriteTuiManifest({
      name: '@deepseek-ai/dsh-tui-launcher',
      version: '0.2.2-alpha.2',
      private: true,
      bin: { 'dsh-tui': 'lib/bin.js' },
      dependencies: {
        '@deepseek-ai/dsh': 'workspace:*',
        '@deepseek-ai/dsh-app-boot': 'workspace:*',
      },
    }, {
      publishedName: '@fishwithcat/dsh-tui',
      version: '0.2.2-alpha.2',
      versions: new Map([...VERSIONS, ['@deepseek-ai/dsh-app-boot', '0.2.2-alpha.2']]),
      launcher: true,
    })
    const dependencies = rewritten.dependencies as Record<string, string>
    expect(dependencies['@deepseek-ai/dsh']).toBe('npm:@fishwithcat/dsh@0.2.2-alpha.2')
    expect(dependencies['@deepseek-ai/dsh-app-boot']).toBe('0.2.2-alpha.2')
    expect(dependencies['@deepseek-ai/dsh-base']).toBe('0.2.2-alpha.2')
    for (const [source, published] of Object.entries(TUI_ALIASES)) {
      expect(dependencies[source]).toBe(`npm:${published}@0.2.2-alpha.2`)
    }
    expect(rewritten).not.toHaveProperty('private')
    expect(rewritten.bin).toEqual({ 'dsh-tui': 'lib/bin.js' })
  })

  it('removes the CLI bin from the packed distribution', () => {
    const rewritten = rewriteTuiManifest({
      name: '@deepseek-ai/dsh',
      version: '0.2.2-alpha.2',
      bin: { dsh: 'lib/bin.js' },
      dependencies: { '@deepseek-ai/dsh-tui-app': 'workspace:*' },
    }, {
      publishedName: '@fishwithcat/dsh',
      version: '0.2.2-alpha.2',
      versions: VERSIONS,
      stripBin: true,
    })
    expect(rewritten).not.toHaveProperty('bin')
    expect((rewritten.dependencies as Record<string, string>)['@deepseek-ai/dsh-tui-app'])
      .toBe('npm:@fishwithcat/dsh-tui-app@0.2.2-alpha.2')
  })

  it('points the packed repository at the publishing repository', () => {
    const rewritten = rewriteTuiManifest({
      name: '@deepseek-ai/dsh-agent',
      version: '0.2.2-alpha.2',
      repository: {
        type: 'git',
        url: 'git+https://github.com/deepseek-ai/deepseek-harness.git',
        directory: 'packages/core/agent',
      },
    }, {
      publishedName: '@fishwithcat/dsh-agent',
      version: '0.2.2-alpha.2',
      versions: VERSIONS,
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
      version: '0.2.2-alpha.2',
      dependencies: { '@deepseek-ai/dsh-missing': 'workspace:*' },
    }, {
      publishedName: '@fishwithcat/dsh-agent',
      version: '0.2.2-alpha.2',
      versions: VERSIONS,
    })).toThrow(/no workspace version for @deepseek-ai\/dsh-missing/u)
  })
})

describe('workspace members', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))

  it('reads every workspace version', () => {
    const versions = readWorkspaceVersions(root)
    expect(versions.get('@deepseek-ai/dsh')).toBe('0.2.2-alpha.2')
    expect(versions.get('@deepseek-ai/dsh-tui-app')).toBe('0.2.2-alpha.2')
  })

  it('resolves the publish set in dependency order', () => {
    const members = resolveMembers(root, '0.2.2-alpha.2')
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
    expect(members.at(-1)?.launcher).toBe(true)
  })

  it('rejects a member on another version', () => {
    expect(() => resolveMembers(root, '0.2.2-alpha.3')).toThrow(/declares 0.2.2-alpha.2/u)
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

/**
 * The transcript fold: durable Session events and live Assistant frames into
 * the rows the terminal renders.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CURSOR_MARKER, Editor, SelectList, visibleWidth } from '@earendil-works/pi-tui'
import type { Component, TUI } from '@earendil-works/pi-tui'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import { Transcript } from '../src/transcript.ts'
import { PROMPT_PANEL_CHROME_ROWS, PlaceholderEditor, PromptPanel, StatusBar, TranscriptView, modelLabel, promptPanelRows, summarizeToolArguments } from '../src/views.ts'
import type { TuiStatus } from '../src/views.ts'
import { createTheme, editorTheme, selectListTheme } from '../src/ansi.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/**
 * Create a store-backed session whose events the transcript can fold.
 * @returns the live session.
 */
async function makeSession() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  return ctx.sessions.create()
}

/**
 * One durable image reference a folded prompt can carry.
 * @returns the attachment reference.
 */
function imageRef(): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:spec'),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
  }
}

/**
 * Build one live Assistant chunk frame.
 * @param revision - the frame revision.
 * @param index - the dense chunk position.
 * @param chunk - the provider chunk.
 * @returns the published frame.
 */
function chunkFrame(revision: number, index: number, chunk: StreamChunk): AssistantStreamFrame {
  return { type: 'chunk', attemptId: LlmAttemptId('attempt'), revision, index, time: index, chunk }
}

describe('Transcript', () => {
  it('renders the human prompt, assistant text, and tool outcome in log order', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'list the files' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Listing now.' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-1' as ToolCallId, name: 'bash', arguments: '{"command":"ls"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-1' as ToolCallId,
        content: [{ type: 'text', text: 'a.ts\nb.ts' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const transcript = new Transcript()
    for (const event of session.ownEvents()) expect(typeof transcript.applyEvent(event)).toBe('boolean')

    const entries = transcript.entries()
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'list the files' })
    expect(entries[1]).toMatchObject({ kind: 'assistant', text: 'Listing now.' })
    expect(entries[2]).toMatchObject({ kind: 'tool', name: 'bash', status: 'ok', result: 'a.ts\nb.ts' })
  })

  it('accumulates live deltas and replaces them with the durable settlement', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const transcript = new Transcript()
    let folded = 0
    const foldNew = (): void => {
      const events = session.ownEvents()
      for (; folded < events.length; folded++) {
        const event = events[folded]
        if (event === undefined) throw new Error('event index out of range')
        transcript.applyEvent(event)
      }
    }
    foldNew()
    expect(transcript.applyFrame({ type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1 })).toBe(true)
    expect(transcript.streaming).toBe(true)
    transcript.applyFrame(chunkFrame(2, 0, { type: 'reasoning-delta', index: 0, text: 'thinking' }))
    transcript.applyFrame(chunkFrame(3, 1, { type: 'text-delta', index: 0, text: 'Hel' }))
    transcript.applyFrame(chunkFrame(4, 2, { type: 'text-delta', index: 0, text: 'lo' }))
    transcript.applyFrame(chunkFrame(5, 3, { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }))
    expect(transcript.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
    expect(transcript.entries().map(entry => entry.kind)).toEqual(['user', 'reasoning', 'assistant'])
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello' })

    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Hello' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    foldNew()
    transcript.applyFrame({
      type: 'end',
      attemptId: LlmAttemptId('attempt'),
      revision: 6,
      index: 4,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: SessionSeq(session.seq - 1) },
    })
    expect(transcript.streaming).toBe(false)
    // The live rows are gone; only the durable settlement remains.
    expect(transcript.entries().map(entry => entry.kind)).toEqual(['user', 'assistant'])
  })

  it('reports a failed attempt and an errored turn as notices', async () => {
    const session = await makeSession()
    const stream: AssistantStreamRecord[] = [{
      type: 'chunk',
      time: 0,
      chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'E' } } },
    }]
    session.append('turn/start', { turn: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream })

    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'provider exploded' })

    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    const closer = session.ownEvents().at(-1)
    if (closer === undefined) throw new Error('expected the turn closer to be appended')
    transcript.applyEvent(closer)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: 'turn cancelled' })
  })

  it('clears every row on reset', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    expect(transcript.entries()).toHaveLength(1)
    transcript.reset()
    expect(transcript.entries()).toHaveLength(0)
  })

  it('hides injected context and keeps only the notices its producers declare', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    const injected = [
      {
        text: '<system-reminder>\nworkspace instructions\n</system-reminder>',
        source: { kind: 'plugin', plugin: 'agent-instructions', form: 'instructions' } as const,
      },
      {
        text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
        source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] } as const,
      },
      {
        text: '<system-reminder>\n<available_skills>\n</system-reminder>',
        source: { kind: 'plugin', plugin: 'skill-catalog', form: 'catalog' } as const,
      },
      {
        text: 'context from a producer that declares no form',
        source: { kind: 'plugin', plugin: 'opaque' } as const,
      },
      {
        text: '',
        source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice', summary: '' } as const,
      },
    ]
    for (const message of injected) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: message.source,
      }), { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plain/model → capable/model' }],
      source: { kind: 'plugin', plugin: 'model-selection', form: 'notice', summary: 'plain/model → capable/model' },
    }), { surfaceOp: 'append' })

    const transcript = new Transcript()
    for (const event of session.ownEvents()) expect(typeof transcript.applyEvent(event)).toBe('boolean')

    expect(transcript.entries().map(entry => entry.kind)).toEqual(['notice'])
    expect(transcript.entries()[0]).toMatchObject({
      kind: 'notice',
      level: 'info',
      text: 'plain/model → capable/model',
    })
  })

  it('drops a user message that carries no visible text', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) expect(typeof transcript.applyEvent(event)).toBe('boolean')
    expect(transcript.entries()).toHaveLength(0)
  })

  it('labels the images a prompt carries in content order', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'compare these' },
        { type: 'image', attachment: imageRef() },
        { type: 'image', attachment: imageRef() },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    expect(transcript.entries().at(-1)).toMatchObject({
      kind: 'user',
      text: 'compare these',
      images: ['[Image #1]', '[Image #2]'],
    })
  })

  it('keeps an image-only prompt as its own row', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: imageRef() }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'user', text: '', images: ['[Image #1]'] })
  })
})

describe('TranscriptView', () => {
  it('keeps every rendered line inside the viewport width', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a very long prompt '.repeat(12) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const view = new TranscriptView(transcript, createTheme(false))
    for (const line of view.render(40)) {
      expect(line.length).toBeLessThanOrEqual(40)
    }
  })

  it('renders a prompt as its image markers followed by its text', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: imageRef() },
        { type: 'text', text: 'what is this?' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const view = new TranscriptView(transcript, createTheme(false))
    expect(view.render(60).join('\n')).toContain('› [Image #1] what is this?')
  })

  it('folds a long tool result and summarizes its arguments', async () => {
    const session = await makeSession()
    const callId = 'call-1' as ToolCallId
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"printf x"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: Array.from({ length: 40 }, (_, index) => `line ${String(index)}`).join('\n') }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const view = new TranscriptView(transcript, createTheme(false))
    const rendered = view.render(60).join('\n')
    expect(rendered).toContain('command=printf x')
    expect(rendered).toContain('more lines')
  })

  it('keeps a multi-line tool argument on one row so the footer keeps its own lines', async () => {
    const session = await makeSession()
    const command = "python3 - <<'EOF'\np=\"src/ReviewPanel.tsx\"\nfor i,l in enumerate(open(p)):\n    print(i)\nEOF"
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1' as ToolCallId,
      name: 'bash',
      arguments: JSON.stringify({ command }),
    })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const view = new TranscriptView(transcript, createTheme(false))
    const lines = view.render(60)
    expect(lines.some(line => line.includes('\n'))).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('command=python3')
  })
})

describe('summarizeToolArguments', () => {
  it('prefers a known key, falls back to pairs, and passes invalid JSON through', () => {
    expect(summarizeToolArguments('{"command":"ls -la"}')).toBe('command=ls -la')
    expect(summarizeToolArguments('{"alpha":1,"beta":"two"}')).toBe('alpha=1 beta=two')
    expect(summarizeToolArguments('not json')).toBe('not json')
    expect(summarizeToolArguments('')).toBe('')
  })

  it('flattens the newlines, tabs, and escapes an argument may carry', () => {
    expect(summarizeToolArguments('{"command":"a\\nb\\tc"}')).toBe('command=a b c')
    expect(summarizeToolArguments('{"command":"\\u001b[31mred"}')).toBe('command= [31mred')
  })
})


describe('StatusBar', () => {
  /**
   * Build a footer over one status frame.
   * @param status - the facts to present.
   * @param color - whether ANSI styles are emitted.
   * @returns the renderable footer.
   */
  function bar(status: TuiStatus, color = false): StatusBar {
    const view = new StatusBar(createTheme(color))
    view.set(status)
    return view
  }

  /**
   * Build a populated status frame.
   * @param tokens - measured occupancy.
   * @param window - routed capacity.
   * @param automatic - whether the engine compacts automatically.
   * @returns the frame.
   */
  function populated(tokens: number, window: number, automatic = false): TuiStatus {
    return {
      workspace: '~/Workspace/Nutkin',
      state: 'idle',
      model: 'deepseek-flash',
      usage: { inputTokens: 1501, outputTokens: 3418 },
      context: { tokens, window, automatic },
    }
  }

  it('right-aligns the routed model against the workspace and lifecycle state', () => {
    const status: TuiStatus = { workspace: '~/Workspace/Nutkin', state: 'running', model: 'deepseek-flash', effort: 'xhigh' }
    const [head, stats] = bar(status).render(60)
    const left = '~/Workspace/Nutkin  ● running'
    const right = 'deepseek-flash • xhigh'
    expect(head).toBe(left + ' '.repeat(60 - left.length - right.length) + right)
    expect(stats).toBe('')
  })

  it('marks plan mode beside the lifecycle state', () => {
    const base: TuiStatus = { workspace: '~/Workspace/Nutkin', state: 'idle', model: 'deepseek-flash' }
    expect(bar({ ...base, plan: true }).render(60)[0]).toContain('○ idle  plan')
    expect(bar({ ...base, plan: false }).render(60)[0]).not.toContain('plan')
    expect(bar(base).render(60)[0]).not.toContain('plan')
  })

  it('pins the token accounting and occupancy under the identity line', () => {
    const status = populated(131_072, 262_144, true)
    const [head, stats] = bar(status).render(80)
    expect(head).toBe('~/Workspace/Nutkin  ○ idle' + ' '.repeat(80 - '~/Workspace/Nutkin  ○ idle'.length - 'deepseek-flash'.length) + 'deepseek-flash')
    expect(stats).toBe('↑1501 ↓3418  50.0%/262k (auto)')
  })

  it('marks automatic compaction only when the engine reports it', () => {
    expect(bar(populated(0, 262_144, true)).render(60)[1]).toContain('(auto)')
    expect(bar(populated(0, 262_144, false)).render(60)[1]).not.toContain('(auto)')
  })

  it('escalates the occupancy colour as the window fills', () => {
    expect(bar(populated(50_000, 100_000), true).render(60)[1]).toContain('\x1b[2m50.0%/100k\x1b[0m')
    expect(bar(populated(80_000, 100_000), true).render(60)[1]).toContain('\x1b[38;5;214m80.0%/100k\x1b[0m')
    expect(bar(populated(95_000, 100_000), true).render(60)[1]).toContain('\x1b[38;5;203m95.0%/100k\x1b[0m')
  })

  it('formats a capacity in whole units the footer can read', () => {
    const windows = [[900, '0.0%/900'], [5000, '0.0%/5.0k'], [262_144, '0.0%/262k'], [2_000_000, '0.0%/2.0M'], [20_000_000, '0.0%/20M']] as const
    for (const [window, label] of windows) {
      expect(bar(populated(0, window)).render(60)[1]).toContain(label)
    }
  })

  it('yields the model before the identity on a narrow terminal', () => {
    const [head, stats] = bar(populated(131_072, 262_144)).render(30)
    expect(head).toContain('~/Workspace/Nutkin  ○ idle')
    expect(head).not.toContain('deepseek')
    expect(stats).toBe('↑1501 ↓3418  50.0%/262k')
    const [narrowHead, narrowStats] = bar(populated(131_072, 262_144)).render(20)
    expect(narrowHead).toContain('~/Workspace/Nutki')
    expect(narrowStats).toContain('↑1501 ↓3418')
    expect(visibleWidth(narrowHead ?? '')).toBeLessThanOrEqual(20)
    expect(visibleWidth(narrowStats ?? '')).toBeLessThanOrEqual(20)
  })
})

describe('PlaceholderEditor', () => {
  /**
   * Build a composer over a stub terminal.
   * @returns the editor and its placeholder wrapper.
   */
  function composer(): { editor: Editor; view: PlaceholderEditor } {
    const tui = { terminal: { rows: 30, columns: 80 }, requestRender: () => {} } as unknown as TUI
    const theme = createTheme(false)
    const editor = new Editor(tui, editorTheme(theme), { paddingX: 1 })
    return { editor, view: new PlaceholderEditor(editor, theme) }
  }

  it('shows the hints with a cursor while the composer is empty, then the typed text', () => {
    const { editor, view } = composer()
    view.setHint('Enter send · /help commands')
    const empty = view.render(40)[1] ?? ''
    expect(empty).toContain('\x1b[7mE\x1b[27m')
    expect(empty).toContain('nter send · /help commands')
    expect(empty).not.toContain(CURSOR_MARKER)
    view.focused = true
    expect(view.render(40)[1]).toContain(CURSOR_MARKER)
    editor.setText('hello')
    expect(view.render(40)[1]).toContain('hello')
    expect(view.render(40)[1]).not.toContain('/help')
  })

  it('leaves the composer untouched when no hint is set or the line is narrow', () => {
    const { editor, view } = composer()
    expect(view.render(40)).toEqual(editor.render(40))
    view.setHint('Enter send · /help commands')
    expect(visibleWidth(view.render(10)[1] ?? '')).toBeLessThanOrEqual(10)
  })

  it('forwards focus, input, and invalidation to the composer', () => {
    const { editor, view } = composer()
    view.focused = true
    expect(editor.focused).toBe(true)
    expect(view.focused).toBe(true)
    view.handleInput('x')
    expect(editor.getText()).toBe('x')
    view.invalidate()
  })
})

describe('PromptPanel', () => {
  /**
   * Build one picker panel.
   * @returns the panel and its title.
   */
  function panel(): { view: PromptPanel; title: string } {
    const theme = createTheme(false)
    const list = new SelectList(
      [{ value: 'deepseek-official/deepseek-flash', label: 'deepseek-official/deepseek-flash', description: 'DeepSeek-V4-Flash' }],
      1,
      selectListTheme(theme),
    )
    const title = 'Select a model'
    return { view: new PromptPanel(title, theme, list), title }
  }

  it('reads as output lines while filling every row the overlay covers', () => {
    const { view, title } = panel()
    const lines = view.render(60)
    for (const line of lines) expect(visibleWidth(line)).toBe(60)
    expect(lines[0]).toBe(title.padEnd(60))
    expect(lines[1]).toBe(' '.repeat(60))
    expect(lines[2]).toMatch(/^→ \S+ +DeepSeek-V4-Flash +$/)
  })

  it('gives the body the full width it renders at', () => {
    const { view } = panel()
    const lines = view.render(100)
    for (const line of lines) expect(visibleWidth(line)).toBe(100)
    expect(lines[0]).toBe('Select a model'.padEnd(100))
    expect(lines[2]).toContain('DeepSeek-V4-Flash')
    expect(visibleWidth(lines[2] ?? '')).toBe(100)
  })

  it('keeps a long title and every body line inside a narrow panel', () => {
    const theme = createTheme(false)
    const list = new SelectList(
      [{ value: 'x', label: 'a value wider than the panel', description: 'description' }],
      1,
      selectListTheme(theme),
    )
    const view = new PromptPanel('a title that cannot fit', theme, list)
    for (const width of [12, 24, 76, 120]) {
      for (const line of view.render(width)) expect(visibleWidth(line)).toBe(width)
    }
  })

  it('budgets panel rows around its chrome', () => {
    expect(promptPanelRows(4)).toBe(PROMPT_PANEL_CHROME_ROWS + 1)
    expect(promptPanelRows(40)).toBe(18)
    expect(promptPanelRows(13)).toBe(11)
  })

  it('clips a body line wider than the panel', () => {
    const theme = createTheme(false)
    const body: Component = { render: () => ['x'.repeat(200)], invalidate: () => {} }
    const view = new PromptPanel('wide', theme, body)
    const lines = view.render(20)
    for (const line of lines) expect(visibleWidth(line)).toBe(20)
    expect(lines[2]).not.toContain('x'.repeat(20))
    // A viewport narrower than the title still yields rows inside it.
    for (const line of view.render(2)) expect(visibleWidth(line)).toBe(2)
  })

  it('forwards invalidation to the body it shows', () => {
    const invalidate = vi.fn()
    const view = new PromptPanel('title', createTheme(false), { render: () => [], invalidate })
    view.invalidate()
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('keeps every row inside the viewport width when styles are emitted', () => {
    const theme = createTheme(true)
    const list = new SelectList(
      [{ value: 'value', label: 'value', description: 'detail' }],
      1,
      selectListTheme(theme),
    )
    const lines = new PromptPanel('Select a model', theme, list).render(40)
    for (const line of lines) expect(visibleWidth(line)).toBe(40)
    expect(lines[0]).toContain('Select a model')
  })
})

describe('modelLabel', () => {
  it('qualifies the model with its provider only when several are registered', () => {
    expect(modelLabel('deepseek-official', 'deepseek-flash', 1)).toBe('deepseek-flash')
    expect(modelLabel('deepseek-official', 'deepseek-flash', 2)).toBe('(deepseek-official) deepseek-flash')
  })
})

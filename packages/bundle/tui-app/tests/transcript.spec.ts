/**
 * The transcript fold: durable Session events and live Assistant frames into
 * the rows the terminal renders.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CURSOR_MARKER, Editor, SelectList, visibleWidth } from '@earendil-works/pi-tui'
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import { Transcript } from '../src/transcript.ts'
import type { ToolDiffCard, ToolPresentationResolver } from '../src/tool-view.ts'
import { PROMPT_PANEL_CHROME_ROWS, DetailBody, PlaceholderEditor, PromptPanel, StatusBar, TranscriptView, modelLabel, promptPanelRows, summarizeToolArguments } from '../src/views.ts'
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

/**
 * Build an appender that appends one event and folds exactly that event.
 * @param transcript - the transcript to fold into.
 * @param session - the session log to append to.
 * @returns the append-and-fold operation.
 */
function folder(
  transcript: Transcript,
  session: Awaited<ReturnType<typeof makeSession>>,
): (append: () => void) => boolean {
  return (append) => {
    append()
    const event = session.ownEvents().at(-1)
    if (event === undefined) throw new Error('expected an appended event')
    return transcript.applyEvent(event)
  }
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

  it('renders no live row while a started attempt has produced nothing', () => {
    const transcript = new Transcript()
    transcript.applyFrame({ type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1 })
    expect(transcript.streaming).toBe(true)
    expect(transcript.entries()).toEqual([])
  })

  it('ignores the stream chunks the transcript does not render', () => {
    const transcript = new Transcript()
    transcript.applyFrame({ type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1 })
    expect(transcript.applyFrame(chunkFrame(2, 0, { type: 'text-delta', index: 0, text: '' }))).toBe(false)
    expect(transcript.applyFrame(chunkFrame(3, 1, { type: 'reasoning-delta', index: 0, text: '' }))).toBe(false)
    expect(transcript.applyFrame(chunkFrame(4, 2, { type: 'block-start', index: 0, blockType: 'text' }))).toBe(false)
    expect(transcript.applyFrame(chunkFrame(5, 3, { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }))).toBe(false)
    expect(transcript.applyFrame(chunkFrame(6, 4, {
      type: 'tool-call-delta',
      index: 1,
      id: 'call-1' as ToolCallId,
      argumentsDelta: '{}',
    }))).toBe(false)
    expect(transcript.applyFrame(chunkFrame(7, 5, { type: 'finish', reason: { kind: 'stop' } }))).toBe(false)
  })

  it('reports an abandoned stream and drops the live attempt', () => {
    const transcript = new Transcript()
    transcript.applyFrame({ type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1 })
    transcript.applyFrame(chunkFrame(2, 0, { type: 'text-delta', index: 0, text: 'partial' }))
    transcript.applyFrame({ type: 'end', attemptId: LlmAttemptId('attempt'), revision: 3, index: 1, outcome: { kind: 'abandoned' } })
    expect(transcript.streaming).toBe(false)
    expect(transcript.entries().at(-1)).toMatchObject({
      kind: 'notice',
      level: 'info',
      text: 'the model stream ended without a settlement',
    })
  })

  it('ignores a durable message that carries no visible text', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({ content: [], source: { provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'never-called' as ToolCallId,
        content: [{ type: 'text', text: 'orphan' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) expect(transcript.applyEvent(event)).toBe(false)
    expect(transcript.entries()).toEqual([])
  })

  it('reports an aborted attempt and ignores a stream that ended cleanly', async () => {
    const session = await makeSession()
    const aborted: AssistantStreamRecord[] = [
      { type: 'chunk', time: 0, chunk: { type: 'text-delta', index: 0, text: 'partial' } },
      { type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled mid-stream', code: 'ABORTED' } } } },
    ]
    const transcript = new Transcript()
    const appendAndFold = folder(transcript, session)
    appendAndFold(() => { session.append('turn/start', { turn: 1 }) })
    appendAndFold(() => { session.append('step/start', { turn: 1, step: 1 }) })
    expect(appendAndFold(() => {
      session.append('assistant/attempt', { turn: 1, step: 1, stream: aborted })
    })).toBe(true)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'cancelled mid-stream' })

    const folded = transcript.entries().length
    expect(appendAndFold(() => {
      session.append('assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [{ type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
      })
    })).toBe(false)
    expect(transcript.entries()).toHaveLength(folded)
  })

  it('maps an errored and a max-token turn end to notices', async () => {
    const session = await makeSession()
    const transcript = new Transcript()
    const appendAndFold = folder(transcript, session)
    appendAndFold(() => { session.append('turn/start', { turn: 1 }) })
    expect(appendAndFold(() => {
      session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'provider exploded', code: 'E' } } })
    })).toBe(true)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'provider exploded' })

    appendAndFold(() => { session.append('turn/start', { turn: 2 }) })
    expect(appendAndFold(() => {
      session.append('turn/end', { turn: 2, reason: { kind: 'max-tokens' } })
    })).toBe(true)
    expect(transcript.entries().at(-1)).toMatchObject({ kind: 'notice', level: 'info', text: 'the model reached its output limit' })
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
    const view = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
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
    const view = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
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
    const view = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
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
    const view = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
    const lines = view.render(60)
    expect(lines.some(line => line.includes('\n'))).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('command=python3')
  })

  it('reuses its rendered lines and refreshes a grown live body', () => {
    const transcript = new Transcript()
    transcript.applyFrame({ type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1 })
    transcript.applyFrame(chunkFrame(2, 0, { type: 'reasoning-delta', index: 0, text: 'weighing it' }))
    transcript.applyFrame(chunkFrame(3, 1, { type: 'text-delta', index: 0, text: 'Hel' }))
    const view = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' }))
    const first = view.render(40)
    expect(first.join('\n')).toContain('✻ weighing it')
    // Same width and revision: the cached lines come back untouched.
    expect(view.render(40)).toBe(first)
    // A different width and a moved revision both rebuild.
    expect(view.render(50)).not.toBe(first)
    expect(view.render(40)).not.toBe(first)
    transcript.applyFrame(chunkFrame(4, 2, { type: 'text-delta', index: 0, text: 'lo' }))
    expect(view.render(40).join('\n')).toContain('Hello')
  })

  it('marks an interrupted assistant message beside its body', async () => {
    const session = await makeSession()
    session.append('turn/start', { turn: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      interrupted: true,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'half a sentence' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    const transcript = new Transcript()
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' })).render(60).join('\n')
    expect(rendered).toContain('half a sentence')
    expect(rendered).toContain('[cancelled]')
  })
})

describe('summarizeToolArguments', () => {
  it('prefers a known key, falls back to pairs, and passes invalid JSON through', () => {
    expect(summarizeToolArguments('{"command":"ls -la"}')).toBe('command=ls -la')
    expect(summarizeToolArguments('{"alpha":1,"beta":"two"}')).toBe('alpha=1 beta=two')
    expect(summarizeToolArguments('not json')).toBe('not json')
    expect(summarizeToolArguments('[1]')).toBe('[1]')
    expect(summarizeToolArguments('42')).toBe('42')
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
    const view = new StatusBar(createTheme({ enabled: color, palette: 'dark' }))
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
    expect(bar(populated(50_000, 100_000), true).render(60)[1]).toContain('\x1b[38;5;243m50.0%/100k\x1b[0m')
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
    const theme = createTheme({ enabled: false, palette: 'dark' })
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

  it('keeps the reverse-video cursor when styles are emitted', () => {
    const tui = { terminal: { rows: 30, columns: 80 }, requestRender: () => {} } as unknown as TUI
    const theme = createTheme({ enabled: true, palette: 'dark' })
    const editor = new Editor(tui, editorTheme(theme), { paddingX: 1 })
    const view = new PlaceholderEditor(editor, theme)
    view.setHint('Enter send')
    // The cursor character must not be wrapped in a styler: every styler ends
    // with an SGR reset that would cancel the reverse video around it.
    expect(view.render(40)[1]).toContain('\x1b[7mE\x1b[27m')
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

/** One normalized mouse event for component tests. */
function mouseEvent(type: TuiMouseEvent['type'], overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type, button: 'none', x: 0, y: 0, screenX: 0, screenY: 0,
    width: 40, height: 12, shift: false, alt: false, ctrl: false,
    ...overrides,
  }
}

/** A fixed-height control whose scroll-affecting input stays observable. */
interface StubControl {
  render: () => string[]
  invalidate: () => void
  handleInput: Mock<(data: string) => void>
  handleMouse: Mock<(event: TuiMouseEvent) => TuiMouseEventResult | undefined>
}

describe('DetailBody', () => {
  /** Build one stub control. */
  function control(): StubControl {
    return {
      render: () => ['→ Approve', '  Keep planning'],
      invalidate: () => {},
      handleInput: vi.fn(),
      handleMouse: vi.fn(),
    }
  }

  /** A detail of `count` one-line paragraphs. */
  function detail(count: number): string {
    return Array.from({ length: count }, (_, index) => `marker-${String(index + 1).padStart(2, '0')}`).join('\n\n')
  }

  /** One wheel event over the panel body. */
  function wheel(delta: number): TuiMouseEvent {
    return mouseEvent('wheel', { wheelDelta: delta })
  }

  it('scrolls an overflowing detail line by line and viewport by viewport', () => {
    const body = control()
    const view = new DetailBody(detail(40), body, createTheme({ enabled: false, palette: 'dark' }), 12)
    const first = view.render(40).join('\n')
    expect(first).toContain('marker-01')
    expect(first).toContain('↑↓/PgUp/PgDn scroll')
    expect(first).not.toContain('←→ choose')

    view.handleInput('\x1b[B')
    const down = view.render(40).join('\n')
    expect(down).toContain('marker-02')
    expect(down).not.toContain('marker-01')
    expect(body.handleInput).not.toHaveBeenCalled()

    view.handleInput('\x1b[A')
    expect(view.render(40).join('\n')).toContain('marker-01')

    view.handleInput('\x1b[6~')
    const paged = view.render(40).join('\n')
    expect(paged).toContain('10–18/')
    expect(paged).not.toContain('marker-01')
  })

  it('moves the control selection with Left/Right and Tab while the detail overflows', () => {
    const step = vi.fn()
    const view = new DetailBody(detail(40), control(), createTheme({ enabled: false, palette: 'dark' }), 12, step)
    expect(view.render(40).join('\n')).toContain('←→ choose')

    view.handleInput('\x1b[C')
    view.handleInput('\t')
    expect(step.mock.calls).toEqual([[1], [1]])

    view.handleInput('\x1b[D')
    view.handleInput('\x1b[Z')
    expect(step.mock.calls).toEqual([[1], [1], [-1], [-1]])
  })

  it('hands every key to the control while the detail fits', () => {
    const body = control()
    const view = new DetailBody('one short line', body, createTheme({ enabled: false, palette: 'dark' }), 12, () => {})
    view.render(40)

    view.handleInput('\x1b[B')
    expect(body.handleInput).toHaveBeenCalledWith('\x1b[B')
    // The wheel is always the detail's: it consumes the event even at a bound.
    expect(view.handleMouse(wheel(-3))).toEqual({ handled: true })
    expect(view.render(40).join('\n')).toContain('one short line')
  })

  it('scrolls an overflowing detail with the wheel', () => {
    const view = new DetailBody(detail(40), control(), createTheme({ enabled: false, palette: 'dark' }), 12)
    view.render(40)
    expect(view.handleMouse(wheel(3))).toEqual({ handled: true })
    expect(view.render(40).join('\n')).toContain('4–12/')
    view.handleMouse(wheel(-1))
    expect(view.render(40).join('\n')).toContain('3–11/')
  })

  it('forwards non-wheel mouse events to the control', () => {
    const body = control()
    const view = new DetailBody('short', body, createTheme({ enabled: false, palette: 'dark' }), 12)
    const click = { ...wheel(0), type: 'click' as const }
    view.handleMouse(click)
    expect(body.handleMouse).toHaveBeenCalledWith(click)
  })

  it('hands movement keys to a control with no selection to move', () => {
    const body = control()
    const view = new DetailBody(detail(40), body, createTheme({ enabled: false, palette: 'dark' }), 12)
    view.render(40)

    view.handleInput('\x1b[C')
    view.handleInput('\x1b[D')
    expect(body.handleInput.mock.calls).toEqual([['\x1b[C'], ['\x1b[D']])
  })

  it('leaves a non-wheel event to a control with no mouse handler', () => {
    const view = new DetailBody('short', { render: () => ['x'], invalidate: () => {} }, createTheme({ enabled: false, palette: 'dark' }), 12)
    expect(view.handleMouse(mouseEvent('click'))).toBeUndefined()
  })

  it('leaves the keys to a control that leaves the detail no rows', () => {
    const body = control()
    const view = new DetailBody(detail(40), body, createTheme({ enabled: false, palette: 'dark' }), 1)
    view.render(40)
    view.handleInput('\x1b[B')
    expect(body.handleInput).toHaveBeenCalledWith('\x1b[B')
  })
})

describe('PromptPanel', () => {
  /**
   * Build one picker panel.
   * @returns the panel and its title.
   */
  function panel(): { view: PromptPanel; title: string } {
    const theme = createTheme({ enabled: false, palette: 'dark' })
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
    const theme = createTheme({ enabled: false, palette: 'dark' })
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
    const theme = createTheme({ enabled: false, palette: 'dark' })
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
    const view = new PromptPanel('title', createTheme({ enabled: false, palette: 'dark' }), { render: () => [], invalidate })
    view.invalidate()
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('routes a mouse event past its chrome and drops one on the chrome', () => {
    const handleMouse = vi.fn(() => ({ handled: true as const }))
    const view = new PromptPanel('title', createTheme({ enabled: false, palette: 'dark' }), { render: () => ['x'], invalidate: () => {}, handleMouse })
    expect(view.handleMouse(mouseEvent('click', { y: 2, height: 10 }))).toEqual({ handled: true })
    expect(handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 0, height: 8 }))
    expect(view.handleMouse(mouseEvent('click', { y: 1 }))).toBeUndefined()
  })

  it('leaves a body without a mouse handler to the renderer', () => {
    const view = new PromptPanel('title', createTheme({ enabled: false, palette: 'dark' }), { render: () => [], invalidate: () => {} })
    expect(view.handleMouse(mouseEvent('click', { y: 4 }))).toBeUndefined()
  })

  it('keeps every row inside the viewport width when styles are emitted', () => {
    const theme = createTheme({ enabled: true, palette: 'dark' })
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

describe('Transcript diff cards', () => {
  /** The literal replacement the helper's `edit` call carries. */
  const EDIT_ARGS = '{"file_path":"a.ts","old_string":"old","new_string":"new"}'

  /**
   * Append one `edit` call, plus its settled result when the test supplies one.
   * @param session - the session log.
   * @param result - the result fields to append, or undefined for a running call.
   */
  function appendEdit(
    session: Awaited<ReturnType<typeof makeSession>>,
    result?: { text: string; isError: boolean; meta?: JsonValue; error?: { name: string; code: string } },
  ): void {
    const callId = 'call-edit' as ToolCallId
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'edit', arguments: EDIT_ARGS })
    if (result === undefined) return
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: result.text }],
        isError: result.isError,
      }),
      ...result.meta === undefined ? {} : { meta: result.meta },
      ...result.error === undefined ? {} : { error: result.error },
    }, { surfaceOp: 'append' })
  }

  /** Fold every event a session already holds. */
  function fold(session: Awaited<ReturnType<typeof makeSession>>, transcript: Transcript): void {
    for (const event of session.ownEvents()) transcript.applyEvent(event)
  }

  /** A resolver returning the same fixed cards for every call. */
  function fixed(call: ToolDiffCard | undefined, result: ToolDiffCard | undefined): ToolPresentationResolver {
    return { call: () => call, result: () => result }
  }

  it('attaches the pending diff card its resolver declares', async () => {
    const session = await makeSession()
    appendEdit(session)
    const transcript = new Transcript(fixed(
      { title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
      undefined,
    ))
    fold(session, transcript)
    expect(transcript.entries()[0]).toMatchObject({
      kind: 'tool',
      status: 'running',
      title: 'Edit a.ts',
      diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
    })
  })

  it('replaces the pending card with the settled one', async () => {
    const session = await makeSession()
    appendEdit(session, { text: 'The file a.ts has been updated successfully.', isError: false })
    const transcript = new Transcript(fixed(
      { title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
      { title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'ctx\nold', newText: 'ctx\nnew' }] },
    ))
    fold(session, transcript)
    expect(transcript.entries()[0]).toMatchObject({
      status: 'ok',
      diffs: [{ path: 'a.ts', oldText: 'ctx\nold', newText: 'ctx\nnew' }],
    })
  })

  it('keeps the pending card when the Tool declares no result view', async () => {
    const session = await makeSession()
    appendEdit(session, { text: 'Replaced.', isError: false })
    const transcript = new Transcript(fixed(
      { title: 'str_replace_editor a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
      undefined,
    ))
    fold(session, transcript)
    expect(transcript.entries()[0]).toMatchObject({
      status: 'ok',
      title: 'str_replace_editor a.ts',
      diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }],
    })
  })

  it('clears the card when the mutation failed', async () => {
    const session = await makeSession()
    appendEdit(session, { text: 'the file changed since it was read', isError: true })
    const transcript = new Transcript(fixed(
      { title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
      { title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
    ))
    fold(session, transcript)
    const entry = transcript.entries()[0]
    expect(entry).toMatchObject({ status: 'error', result: 'the file changed since it was read' })
    const row = entry as { title?: string; diffs?: readonly unknown[] }
    expect(row.title).toBeUndefined()
    expect(row.diffs).toBeUndefined()
  })

  it('keeps raw rows without a resolver, and ignores another card', async () => {
    const session = await makeSession()
    appendEdit(session, { text: 'Replaced.', isError: false })
    const raw = new Transcript()
    fold(session, raw)
    const rawEntry = raw.entries()[0]
    expect(rawEntry).toMatchObject({ kind: 'tool' })
    expect(Object.hasOwn(rawEntry ?? {}, 'title')).toBe(false)
    expect(Object.hasOwn(rawEntry ?? {}, 'diffs')).toBe(false)

    const other = new Transcript({ call: () => undefined, result: () => undefined })
    fold(session, other)
    const otherEntry = other.entries()[0]
    expect(Object.hasOwn(otherEntry ?? {}, 'title')).toBe(false)
    expect(Object.hasOwn(otherEntry ?? {}, 'diffs')).toBe(false)
  })

  it('drops a card whose hunk list is empty', async () => {
    const session = await makeSession()
    appendEdit(session)
    const transcript = new Transcript(fixed({ title: 'Edit a.ts', diffs: [] }, undefined))
    fold(session, transcript)
    const entry = transcript.entries()[0]
    expect(entry).toMatchObject({ title: 'Edit a.ts' })
    expect((entry as { diffs?: readonly unknown[] }).diffs).toBeUndefined()
  })

  it('keeps the call-time heading when a settled card declares no title', async () => {
    const session = await makeSession()
    appendEdit(session, { text: 'Replaced.', isError: false })
    const transcript = new Transcript({
      call: () => ({ title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] }),
      result: () => ({ diffs: [{ path: 'a.ts', oldText: 'ctx', newText: 'ctx2' }] }),
    })
    fold(session, transcript)
    expect(transcript.entries()[0]).toMatchObject({
      title: 'Edit a.ts',
      diffs: [{ path: 'a.ts', oldText: 'ctx', newText: 'ctx2' }],
    })
  })

  it('keeps the failure identity on a failed mutation', async () => {
    const session = await makeSession()
    appendEdit(session, {
      text: 'the file was not observed',
      isError: true,
      error: { name: 'FsError', code: 'FS_NOT_OBSERVED' },
    })
    const transcript = new Transcript(fixed(
      { title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] },
      undefined,
    ))
    fold(session, transcript)
    expect(transcript.entries()[0]).toMatchObject({ error: 'FsError: FS_NOT_OBSERVED' })
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' })).render(60).join('\n')
    expect(rendered).toContain('FsError: FS_NOT_OBSERVED')
  })

  it('hands the resolver the call identity and the settled result projection', async () => {
    const session = await makeSession()
    appendEdit(session, { text: 'Replaced.', isError: false, meta: { diffs: [] } })
    const resultSpy = vi.fn((): ToolDiffCard | undefined => undefined)
    const callSpy = vi.fn((): ToolDiffCard | undefined => undefined)
    const transcript = new Transcript({ call: callSpy, result: resultSpy })
    fold(session, transcript)
    expect(callSpy).toHaveBeenCalledWith('edit', EDIT_ARGS)
    expect(resultSpy).toHaveBeenCalledWith('edit', EDIT_ARGS, {
      content: [{ type: 'text', text: 'Replaced.' }],
      isError: false,
      meta: { diffs: [] },
    })
  })
})

describe('TranscriptView diff cards', () => {
  /**
   * Fold an `edit` call and settled result with one fixed applied card.
   * @param diffs - the applied hunks the result card declares.
   * @param result - the model-facing result text the tool returned.
   * @returns the rendered transcript lines.
   */
  async function render(diffs: ToolDiffCard['diffs'], result = 'The file a.ts has been updated successfully.'): Promise<string[]> {
    const session = await makeSession()
    const callId = 'call-edit' as ToolCallId
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'edit', arguments: '{"file_path":"a.ts"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: result }], isError: false }),
    }, { surfaceOp: 'append' })
    const transcript = new Transcript({
      call: () => ({ title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] }),
      result: () => ({ title: 'Edit a.ts', diffs }),
    })
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    return new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' })).render(60)
  }

  it('renders an applied mutation as a diff body with its change totals', async () => {
    const rendered = (await render([{ path: 'a.ts', oldText: 'ctx\nold', newText: 'ctx\nnew' }])).join('\n')
    expect(rendered).toContain('✔ Edit a.ts')
    expect(rendered).toContain('+1')
    expect(rendered).toContain('-1')
    expect(rendered).toContain('- old')
    expect(rendered).toContain('+ new')
    expect(rendered).toContain('  ctx')
    expect(rendered).not.toContain('updated successfully')
  })

  it('marks a later hunk of one file with a gap and omits zero totals', async () => {
    const gap = (await render([
      { path: 'a.ts', oldText: 'one', newText: 'ONE' },
      { path: 'a.ts', oldText: 'two', newText: 'TWO' },
    ])).join('\n')
    expect(gap).toContain('⋯')

    const unchanged = (await render([{ path: 'a.ts', oldText: 'same', newText: 'same' }])).join('\n')
    expect(unchanged).toContain('  same')
    expect(unchanged).not.toContain('+0')
    expect(unchanged).not.toContain('-0')

    const deletion = (await render([{ path: 'a.ts', oldText: 'gone', newText: '' }])).join('\n')
    expect(deletion).toContain('+0')
    expect(deletion).toContain('-1')
  })

  it('opens every file of a multi-file card and folds a long body', async () => {
    const many = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join('\n')
    const rendered = (await render([
      { path: 'a.ts', oldText: null, newText: 'one' },
      { path: 'b.ts', oldText: null, newText: many },
    ])).join('\n')
    expect(rendered).toContain('a.ts')
    expect(rendered).toContain('b.ts')
    expect(rendered).toContain('more lines')
  })

  it('keeps a long diff line inside the viewport width', async () => {
    const lines = await render([{ path: 'a.ts', oldText: null, newText: 'x'.repeat(200) }])
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60)
  })

  it('shows the error text instead of a card when a mutation failed', async () => {
    const session = await makeSession()
    const callId = 'call-edit' as ToolCallId
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'edit', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'old_string not found' }],
        isError: true,
      }),
    }, { surfaceOp: 'append' })
    const transcript = new Transcript({
      call: () => ({ title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] }),
      result: () => ({ title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] }),
    })
    for (const event of session.ownEvents()) transcript.applyEvent(event)
    const rendered = new TranscriptView(transcript, createTheme({ enabled: false, palette: 'dark' })).render(60).join('\n')
    expect(rendered).toContain('✘ edit')
    expect(rendered).toContain('old_string not found')
    expect(rendered).not.toContain('+ new')
  })
})

describe('modelLabel', () => {
  it('qualifies the model with its provider only when several are registered', () => {
    expect(modelLabel('deepseek-official', 'deepseek-flash', 1)).toBe('deepseek-flash')
    expect(modelLabel('deepseek-official', 'deepseek-flash', 2)).toBe('(deepseek-official) deepseek-flash')
  })
})

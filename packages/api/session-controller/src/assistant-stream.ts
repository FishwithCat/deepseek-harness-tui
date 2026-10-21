/** Process-local assistant state retained for reconnecting Web followers. */

import { AssistantStreamState } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame, AssistantStreamBaseline } from '@deepseek-ai/dsh-agent'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionAssistantStreamBaseline } from './types.ts'

/**
 * Web-facing adapter over the shared `dsh-agent` fold. The reconnect snapshot
 * keeps its original wire vocabulary (`JsonValue` stream records); the
 * process-local fold itself is shared with the terminal watch stream.
 */
export class SessionAssistantStreamAccumulator {
  private readonly state = new AssistantStreamState()
  private cached: { source: AssistantStreamBaseline; value: SessionAssistantStreamBaseline } | undefined

  /**
   * Fold one trusted frame from the current attached Agent lifecycle.
   * @param frame - next dense process-local Assistant frame.
   * @param durableCursor - last committed Session seq when this frame was observed.
   */
  accept(frame: AssistantStreamFrame, durableCursor: SessionSeqCursor): void {
    this.state.accept(frame, durableCursor)
  }

  /**
   * Read the cached reconnect baseline in its wire form.
   * @returns the identity-stable baseline for the latest accepted revision.
   */
  snapshot(): SessionAssistantStreamBaseline {
    const source = this.state.snapshot()
    if (this.cached?.source === source) return this.cached.value
    const value = wireBaseline(source)
    this.cached = { source, value }
    return value
  }
}

/**
 * Convert the shared fold's typed compact records to the Web wire vocabulary.
 *
 * The stream records cross the Remote boundary, where a branded tool-call id
 * is not an analyzable JSON type; the original wire form stays `JsonValue`.
 * @param baseline - the process-local baseline.
 * @returns the same cut with JSON stream records.
 */
function wireBaseline(baseline: AssistantStreamBaseline): SessionAssistantStreamBaseline {
  const attempt = baseline.activeAttempt
  if (attempt === undefined) return { revision: baseline.revision }
  return {
    revision: baseline.revision,
    activeAttempt: {
      attemptId: attempt.attemptId,
      startedAfterSeq: attempt.startedAfterSeq,
      turn: attempt.turn,
      step: attempt.step,
      nextIndex: attempt.nextIndex,
      stream: JSON.parse(JSON.stringify(attempt.stream)) as JsonValue[],
    },
  }
}

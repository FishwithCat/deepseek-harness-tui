/**
 * Process-local assistant-attempt state retained for reconnecting presentation
 * consumers. This fold is independent of any transport: the Web follow stream,
 * the terminal watch stream, and other local viewers share it.
 * @module @deepseek-ai/dsh-agent/assistant-stream-state
 */

import type { AssistantStreamFrame } from './runtime-types.ts'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session'

/** One active assistant attempt in a reconnect opening snapshot. */
export interface AssistantStreamBaselineAttempt {
  /** Attempt identity from the opening `start` frame. */
  readonly attemptId: LlmAttemptId
  /** Last durable Session seq observed when this attempt started. */
  readonly startedAfterSeq: SessionSeqCursor
  /** Durable turn owning the request. */
  readonly turn: number
  /** Durable step owning the request. */
  readonly step: number
  /** Dense position expected for the next live chunk frame. */
  readonly nextIndex: number
  /** Compact detached stream accumulated at this opening revision. */
  readonly stream: readonly AssistantStreamRecord[]
}

/** Complete process-local assistant state at one reconnect opening. */
export interface AssistantStreamBaseline {
  /** Highest accepted frame revision. */
  readonly revision: number
  /** The attempt still streaming at this revision, absent between attempts. */
  readonly activeAttempt?: AssistantStreamBaselineAttempt
}

interface MutableAttempt {
  readonly attemptId: AssistantStreamBaselineAttempt['attemptId']
  readonly startedAfterSeq: SessionSeqCursor
  readonly turn: number
  readonly step: number
  readonly stream: AssistantStreamAccumulator
  nextIndex: number
}

const EMPTY_BASELINE: AssistantStreamBaseline = { revision: 0 }

/**
 * Folds dense Agent frames into the latest process-local attempt and
 * materializes one shared immutable reconnect baseline per accepted revision.
 */
export class AssistantStreamState {
  private activeAttempt: MutableAttempt | undefined
  private revision = 0
  private snapshotValue: AssistantStreamBaseline = EMPTY_BASELINE
  private dirty = false

  /**
   * Fold one trusted frame from the current attached Agent lifecycle.
   * @param frame - next dense process-local Assistant frame.
   * @param durableCursor - last committed Session seq when this frame was observed.
   */
  accept(frame: AssistantStreamFrame, durableCursor: SessionSeqCursor): void {
    if (frame.type === 'start' && frame.revision === 1 && this.revision !== 0) {
      this.activeAttempt = undefined
      this.revision = 0
    }
    if (frame.revision !== this.revision + 1) {
      this.activeAttempt = undefined
      this.revision = frame.revision
      this.dirty = true
      return
    }
    this.revision = frame.revision
    switch (frame.type) {
      case 'start':
        this.activeAttempt = {
          attemptId: frame.attemptId,
          startedAfterSeq: durableCursor,
          turn: frame.turn,
          step: frame.step,
          stream: new AssistantStreamAccumulator(),
          nextIndex: 0,
        }
        break
      case 'chunk': {
        const attempt = this.activeAttempt
        if (attempt === undefined
          || attempt.attemptId !== frame.attemptId
          || frame.index !== attempt.nextIndex) {
          this.activeAttempt = undefined
          break
        }
        attempt.stream.push({ time: frame.time, chunk: frame.chunk })
        attempt.nextIndex += 1
        break
      }
      case 'end':
        this.activeAttempt = undefined
        break
    }
    this.dirty = true
  }

  /**
   * Read the cached reconnect baseline, materializing it after a state change.
   * @returns the identity-stable baseline for the latest accepted revision.
   */
  snapshot(): AssistantStreamBaseline {
    if (!this.dirty) return this.snapshotValue
    this.snapshotValue = {
      revision: this.revision,
      ...this.activeAttempt === undefined ? {} : {
        activeAttempt: {
          attemptId: this.activeAttempt.attemptId,
          startedAfterSeq: this.activeAttempt.startedAfterSeq,
          turn: this.activeAttempt.turn,
          step: this.activeAttempt.step,
          nextIndex: this.activeAttempt.nextIndex,
          stream: this.activeAttempt.stream.snapshot(),
        },
      },
    }
    this.dirty = false
    return this.snapshotValue
  }
}

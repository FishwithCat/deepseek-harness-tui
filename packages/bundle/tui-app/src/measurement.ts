/** Shared projection-to-footer measurements for interactive and watched sessions. */

import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
import type { TuiContextStatus, TuiSessionStats } from './views.ts'

/** Billing buckets a session without the `tokenUsage` unit is treated as having. */
const ZERO_USAGE: TokenUsageProjection = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/** Footer facts derived from one projection snapshot. */
export interface TuiMeasurement {
  /** Context occupancy, absent until the meter reports both a pressure and a capacity. */
  context: TuiContextStatus | undefined
  /** Whole-log throughput and token totals; zero counts render nothing. */
  stats: TuiSessionStats
}

/**
 * Convert registered usage projections to terminal footer facts.
 * @param values - projection values at one committed log position, if available.
 * @param automatic - whether the owning engine compacts automatically.
 * @returns available context occupancy and whole-log token figures.
 */
export function measureUsage(values: ProjectionSnapshot['values'] | undefined, automatic: boolean): TuiMeasurement {
  const pressure: ContextPressureProjection | undefined = values?.['contextPressure']
  const window = pressure?.contextWindow
  const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const usage: TokenUsageProjection = values?.['tokenUsage'] ?? ZERO_USAGE
  const whole: SessionStatsProjection | undefined = values?.['sessionStats']
  return {
    context: window === undefined || tokens === undefined
      ? undefined
      : { tokens, window, automatic },
    stats: {
      ...whole !== undefined && whole.decodeMs > 0
        ? { tokensPerSecond: whole.decodeTokens / (whole.decodeMs / 1_000) }
        : {},
      promptTokens: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
    },
  }
}

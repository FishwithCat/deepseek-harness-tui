/**
 * Host tool-presentation bridge for the terminal surface: the Host consumer
 * of `ToolDefinition.presentCall`/`presentResult` anticipated by the
 * [decision](../../../../.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md).
 * The bridge narrows the provider-neutral view vocabulary to the one card this
 * surface draws today — `card: 'diff'` — so every other card falls back to the
 * surface's ordinary tool row.
 * @module @deepseek-ai/dsh-tui-app/tool-view
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FileDiff, ToolCallView, ToolDefinition, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

/** The diff card the terminal surface renders, narrowed from the Host vocabulary. */
export interface ToolDiffCard {
  /** Heading the tool declared; absent keeps the call-time heading. */
  title?: string | undefined
  /** The hunks to draw, in the order the tool declared them. */
  diffs: readonly FileDiff[]
}

/** Resolves the diff card a Tool declared for one call and its settled result. */
export interface ToolPresentationResolver {
  /**
   * @param name - the Tool name as the model requested it.
   * @param argsJson - the raw arguments JSON the model produced.
   * @returns the pending diff card, or undefined for every other presentation.
   */
  call(name: string, argsJson: string): ToolDiffCard | undefined
  /**
   * @param name - the Tool name as the model requested it.
   * @param argsJson - the raw arguments JSON the model produced.
   * @param result - the settled result projection the durable event carries.
   * @returns the completed diff card, or undefined for every other presentation.
   */
  result(name: string, argsJson: string, result: ToolResult): ToolDiffCard | undefined
}

/**
 * Parse raw Tool arguments into the object shape a presenter expects.
 *
 * Arguments are a model-produced JSON boundary, so presence, JSON syntax, and
 * the object shape are all checked before a presenter narrows its own fields.
 * @param argsJson - the model-produced arguments string.
 * @returns the parsed object, or undefined when it is not a JSON object.
 */
function parseArguments(argsJson: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(argsJson)
  } catch {
    // The model produced arguments its Tool will reject; there is no card to derive.
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Narrow one declared view to the diff card this surface draws.
 * @param view - the view a presenter returned, when it returned one.
 * @returns the diff card, or undefined for another card or no view.
 */
function diffCard(view: ToolCallView | ToolResultView | undefined): ToolDiffCard | undefined {
  if (view === undefined || view.card !== 'diff') return undefined
  return { title: view.title, diffs: view.diffs }
}

/**
 * Build the resolver over the live Tool registry.
 * @param ctx - the application context carrying the optional `tools` service.
 * @param agent - reads the Agent whose scope owns the call; the registry resolves the
 *   definition the acting scope sees, so a scoped shadow renders as it executed.
 * @returns the resolver the transcript folds with.
 */
export function createToolPresentationResolver(ctx: Context, agent: () => object): ToolPresentationResolver {
  const resolve = (
    name: string,
    argsJson: string,
    present: (definition: ToolDefinition, args: Record<string, unknown>) => ToolCallView | ToolResultView | undefined,
  ): ToolDiffCard | undefined => {
    const args = parseArguments(argsJson)
    if (args === undefined) return undefined
    const definition = ctx.get('tools')?.get(name, agent())
    if (definition === undefined) return undefined
    try {
      return diffCard(present(definition, args))
    } catch {
      // A presenter that throws on model-produced arguments must not break the
      // transcript fold that is already rendering the surrounding turn.
      return undefined
    }
  }
  return {
    call: (name, argsJson) => resolve(name, argsJson, (definition, args) => definition.presentCall?.(args)),
    result: (name, argsJson, result) => resolve(name, argsJson, (definition, args) => definition.presentResult?.(args, result)),
  }
}

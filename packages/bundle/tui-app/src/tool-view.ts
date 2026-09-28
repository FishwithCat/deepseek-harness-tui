/**
 * Host tool-presentation bridge for the terminal surface: the Host consumer
 * of `ToolDefinition.presentCall`/`presentResult` anticipated by the
 * [decision](../../../../.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md).
 * The bridge resolves the acting scope's Tool definition and hands the declared
 * call or result view to the transcript unchanged; the terminal renderer
 * switches on the card tag and degrades to the surface's ordinary tool row when
 * a Tool declares no view.
 * @module @deepseek-ai/dsh-tui-app/tool-view
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView, ToolDefinition, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'

/** Resolves the presentation view a Tool declared for one call and its settled result. */
export interface ToolPresentationResolver {
  /**
   * @param name - the Tool name as the model requested it.
   * @param argsJson - the raw arguments JSON the model produced.
   * @returns the pending call view, or undefined when the Tool declares none.
   */
  call(name: string, argsJson: string): ToolCallView | undefined
  /**
   * @param name - the Tool name as the model requested it.
   * @param argsJson - the raw arguments JSON the model produced.
   * @param result - the settled result projection the durable event carries.
   * @returns the completed result view, or undefined when the Tool declares none.
   */
  result(name: string, argsJson: string, result: ToolResult): ToolResultView | undefined
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
    // The model produced arguments its Tool will reject; there is no view to derive.
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Build the resolver over the live Tool registry.
 * @param ctx - the application context carrying the optional `tools` service.
 * @param agent - reads the Agent whose scope owns the call; the registry resolves the
 *   definition the acting scope sees, so a scoped shadow renders as it executed.
 * @returns the resolver the transcript folds with.
 */
export function createToolPresentationResolver(ctx: Context, agent: () => object): ToolPresentationResolver {
  const resolve = <View>(
    name: string,
    argsJson: string,
    present: (definition: ToolDefinition, args: Record<string, unknown>) => View | undefined,
  ): View | undefined => {
    const args = parseArguments(argsJson)
    if (args === undefined) return undefined
    const definition = ctx.get('tools')?.get(name, agent())
    if (definition === undefined) return undefined
    try {
      return present(definition, args)
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

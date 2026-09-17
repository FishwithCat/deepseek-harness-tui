/**
 * The composer's slash-command surface: the app's own commands, the registry's
 * catalog, and dispatch through `ctx.commands`. A registry command runs against
 * the Agent without creating a model message; the app renders its settled text.
 * @module @deepseek-ai/dsh-tui-app/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui'
import type { AutocompleteProvider, SelectItem } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'

/** One local command the composer handles without the registry. */
export interface LocalCommand {
  /** Command name without the leading slash. */
  name: string
  /** Discovery description. */
  description: string
  /** Whether the command takes trailing input. */
  takesInput: boolean
}

/** App-owned commands take precedence over registry commands and skill gestures. */
export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  { name: 'help', description: 'List available commands', takesInput: false },
  { name: 'new', description: 'Start a new session', takesInput: false },
  { name: 'sessions', description: 'List stored sessions', takesInput: false },
  { name: 'resume', description: 'Resume a stored session by id', takesInput: true },
  { name: 'model', description: 'Show or switch the model route', takesInput: true },
  { name: 'effort', description: 'Show or switch reasoning effort', takesInput: true },
  { name: 'quit', description: 'Exit the TUI', takesInput: false },
]

/**
 * Parse one slash line.
 * @param line - the composer's submitted text.
 * @returns the command name and the remainder, or undefined when the line is not a command.
 */
export function parseCommand(line: string): { name: string; input: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/.exec(line)
  if (match === null) return undefined
  return { name: match[1] ?? '', input: match[2] ?? '' }
}

/**
 * Build the completion catalog: the app's commands followed by the registry's
 * effective commands for this Agent.
 * @param ctx - context carrying the command registry.
 * @param agent - the Agent whose scoped commands apply.
 * @returns selectable entries carrying the slash value.
 */
export function commandCatalog(ctx: Context, agent: Agent): SelectItem[] {
  const items: SelectItem[] = LOCAL_COMMANDS.map(command => ({
    value: `/${command.name}`,
    label: `/${command.name}`,
    description: command.description,
  }))
  const commands = ctx.get('commands')
  if (commands === undefined) return items
  for (const descriptor of commands.list(agent)) {
    items.push({
      value: `/${descriptor.name}`,
      label: `/${descriptor.name}`,
      description: descriptor.input?.hint === undefined
        ? descriptor.description
        : `${descriptor.description} ${descriptor.input.hint}`,
    })
  }
  return items
}

/**
 * Complete leading slash names with commands taking precedence over user-invocable skills.
 * @param ctx - context carrying the optional command and skill registries.
 * @param agent - the Agent whose scoped catalogs apply.
 * @param cwd - workspace used for skill discovery.
 * @returns the editor provider; each request reads the current catalogs and honors cancellation.
 */
export function slashAutocomplete(ctx: Context, agent: Agent, cwd: string): AutocompleteProvider {
  const completion = new CombinedAutocompleteProvider([], cwd)
  return {
    triggerCharacters: ['/'],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const before = (lines[0] ?? '').slice(0, cursorCol)
      if (cursorLine !== 0 || !/^\/[a-z0-9_-]*$/i.test(before)) return null
      const prefix = before.slice(1).toLowerCase()
      const commands = commandCatalog(ctx, agent).map(item => ({ ...item, name: item.value.slice(1) }))
      const skills = await ctx.get('skills')?.list({ cwd, scope: agent, signal: options.signal }) ?? []
      const seen = new Set<string>()
      const candidates = [...commands, ...skills.filter(skill => skill.invocation.userInvocable)]
        .filter((item) => {
          if (seen.has(item.name) || !item.name.toLowerCase().startsWith(prefix)) return false
          seen.add(item.name)
          return true
        })
      return new CombinedAutocompleteProvider(candidates, cwd)
        .getSuggestions(lines, cursorLine, cursorCol, { signal: options.signal })
    },
    applyCompletion: completion.applyCompletion.bind(completion),
  }
}

/**
 * Execute one registry command against the owning Agent.
 * @param ctx - context carrying the command registry.
 * @param agent - the Agent the command targets.
 * @param line - the full command line, including the leading slash.
 * @param signal - cancellation lifetime of the dispatch.
 * @returns the settled execution, or undefined when the name is unknown.
 */
export async function executeCommand(
  ctx: Context,
  agent: Agent,
  line: string,
  signal: AbortSignal,
): Promise<CommandExecution | undefined> {
  const commands = ctx.get('commands')
  if (commands === undefined) return undefined
  return commands.execute(agent, line, [], signal)
}

/** One selectable model route. */
export interface ModelChoice {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Label shown in the picker. */
  label: string
  /** Supporting detail shown beside the label. */
  description: string
}

/**
 * List the model routes the live LLM registry advertises.
 * @param ctx - context carrying the LLM registry.
 * @returns one choice per reachable provider model, in registry order; providers that fail discovery are omitted.
 */
export async function listModelChoices(ctx: Context): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = []
  for (const provider of ctx.llm.listProviders()) {
    let models
    try {
      models = await ctx.llm.listModels(provider.id)
    } catch {
      // A provider whose discovery fails contributes no selectable routes.
      continue
    }
    for (const model of models) {
      choices.push({
        provider: provider.id,
        model: model.id,
        label: `${provider.id}/${model.id}`,
        description: model.name,
      })
    }
  }
  return choices
}

/** One selectable reasoning effort, or the routed model's provider default. */
export interface EffortChoice {
  /** Opaque effort id the adapter accepts, or undefined to send no effort. */
  effort: ReasoningEffortId | undefined
  /** Label shown in the picker. */
  label: string
  /** Supporting detail shown beside the label. */
  description: string
}

/**
 * List the reasoning efforts one routed model declares.
 *
 * A route whose adapter declares no efforts has no effort control at all. A
 * route that declares efforts without a default also accepts the provider's own
 * behavior, which the first choice clears back to; when the adapter does
 * declare a default, selecting that effort is the same request, so no separate
 * clear is offered.
 * @param ctx - context carrying the LLM registry.
 * @param route - the routed provider and model.
 * @returns the selectable efforts in adapter order, or undefined when the route declares none.
 * @throws when the route has no registered adapter or its metadata is invalid.
 */
export async function listEffortChoices(
  ctx: Context,
  route: { provider: string; model: string },
): Promise<EffortChoice[] | undefined> {
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
  const reasoning = info.reasoning
  if (reasoning === undefined) return undefined
  const clearToProviderDefault: EffortChoice[] = reasoning.defaultEffort === undefined
    ? [{
      effort: undefined,
      label: 'Provider default',
      description: 'Send no effort and let the provider decide',
    }]
    : []
  return [
    ...clearToProviderDefault,
    ...reasoning.efforts.map(effort => ({
      effort: effort.id,
      label: effort.name,
      description: effort.description ?? String(effort.id),
    })),
  ]
}

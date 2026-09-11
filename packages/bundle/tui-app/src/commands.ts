/**
 * The composer's slash-command surface: the app's own commands, the registry's
 * catalog, and dispatch through `ctx.commands`. A registry command runs against
 * the Agent without creating a model message; the app renders its settled text.
 * @module @deepseek-ai/dsh-tui-app/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelectItem } from '@earendil-works/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'

/** One local command the composer handles without the registry. */
export interface LocalCommand {
  /** Command name without the leading slash. */
  name: string
  /** Discovery description. */
  description: string
  /** Whether the command takes trailing input. */
  takesInput: boolean
}

/** The commands this app owns; every other slash line goes to the registry. */
export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  { name: 'help', description: 'List available commands', takesInput: false },
  { name: 'new', description: 'Start a new session', takesInput: false },
  { name: 'sessions', description: 'List stored sessions', takesInput: false },
  { name: 'resume', description: 'Resume a stored session by id', takesInput: true },
  { name: 'model', description: 'Show or switch the model route', takesInput: true },
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

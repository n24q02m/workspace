/**
 * Tool subcommands for the console script: `workspace <tool> <action> [--param value]...`.
 *
 * Thin adapter, not a second implementation. Every subcommand resolves to
 * `dispatchTool(name, args)` -- the same function the MCP `tools/call` handler
 * runs (see ../tools/dispatch.ts) -- so credential gating, domain validation
 * and error wrapping are literally shared code. This module only does the two
 * things a CLI has to do: turn argv into the tool's input object, and turn the
 * tool's CallTool result into stdout/stderr plus an exit code.
 *
 * Output: human text by default; `--json` prints one JSON envelope
 * `{"tool", "action", "result"}` (result is the tool payload, parsed from its
 * JSON text when it is JSON). Failures go to stderr -- as
 * `{"tool", "action", "error"}` under `--json` -- with exit 1. Bad argv exits 2.
 *
 * Two tools do not get a subcommand named after themselves. `config` is hull's
 * stored-credential operator command (see OPERATOR_COMMANDS), and `help` has its
 * own argv shape. So the MCP `config` tool is reached as `config-tool`, and
 * `help` keeps the hand-written spec below; every other subcommand is
 * `<tool> <action>` with flags derived from the tool's input schema.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CliHandler } from '@n24q02m/hull'
import { dispatchTool, HELP_TOPICS } from '../tools/dispatch.js'
import { DOMAINS } from '../tools/domains/index.js'
import { INFRA_TOOLS } from '../tools/registry.js'
import { getPackageVersion } from '../version.js'

/** Sink for the command output. Injectable so tests capture instead of printing. */
export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const defaultIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line)
}

/** Exit code for argv the CLI could not turn into a tool call. */
const USAGE_EXIT = 2

const JSON_FLAG = '--json'
const HELP_FLAGS: Record<string, true> = { '-h': true, '--help': true }

/** `account` is accepted by every domain but lives outside their inputProps. */
const ACCOUNT_PROP: Record<string, unknown> = {
  type: 'string',
  description: 'Google account email to act as. Defaults to the primary account.'
}

interface ToolSpec {
  /** The MCP tool this subcommand runs; `dispatchTool` receives this name. */
  tool: string
  /** What the user types. Differs from `tool` only for an aliased name. */
  subcommand: string
  description: string
  actions: readonly string[]
  props: Record<string, unknown>
}

interface ToolProp {
  type: string
  description?: string
  values?: readonly string[]
}

/**
 * The props are JSON-schema fragments carried as `unknown`; this reads the
 * fields the CLI uses and defaults the rest to a plain string.
 */
function readProp(prop: unknown): ToolProp {
  if (typeof prop !== 'object' || prop === null) return { type: 'string' }
  const type = 'type' in prop && typeof prop.type === 'string' ? prop.type : 'string'
  const description = 'description' in prop && typeof prop.description === 'string' ? prop.description : undefined
  const values =
    'enum' in prop && Array.isArray(prop.enum)
      ? prop.enum.filter((value): value is string => typeof value === 'string')
      : undefined
  return { type, description, values }
}

/** The spec for one domain tool, as the MCP schema describes it. */
function domainSpec(name: string): ToolSpec | undefined {
  const domain = DOMAINS.find((candidate) => candidate.name === name)
  if (!domain) return undefined
  return {
    tool: domain.name,
    subcommand: domain.name,
    description: domain.description,
    actions: domain.actions,
    props: { account: ACCOUNT_PROP, ...domain.inputProps }
  }
}

const HELP_SPEC: ToolSpec = {
  tool: 'help',
  subcommand: 'help',
  description: 'Full documentation for one tool (the MCP `help` tool).',
  actions: [],
  props: {
    topic: { type: 'string', description: `Topic to read: ${HELP_TOPICS.join(', ')}` }
  }
}

/**
 * Subcommands for MCP tools whose own name a console operator command already
 * owns. The operator `config` reads the credential store hull manages
 * (`config status`, `config delete`); the MCP `config` tool is a different
 * surface -- credential lifecycle plus the Google accounts the server acts as.
 * Shadowing the operator command would silently break it, so the tool keeps its
 * CLI path under `config-tool`, the alias the email server's CLI also uses.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = { 'config-tool': 'config' }

/**
 * The spec for an aliased infra tool, derived from the definition the server
 * registers: actions come from the schema's `action` enum, options from the
 * remaining properties. Deriving beats restating -- a parameter added to the
 * tool becomes a flag here with no second edit to forget.
 */
function infraSpec(subcommand: string, tool: string): ToolSpec {
  const definition = INFRA_TOOLS.find((candidate) => candidate.name === tool)
  if (!definition) {
    // Alias table, tool definitions and tool names all live in this repo; a
    // dangling alias is a programming error, not a user error.
    throw new Error(`subcommand '${subcommand}' aliases the unknown MCP tool '${tool}'`)
  }
  const { action, ...props } = definition.inputSchema.properties
  return {
    tool,
    subcommand,
    description: definition.description,
    actions: readProp(action).values ?? [],
    props
  }
}

/** Operator commands: this server's `auth` and `relay` plus hull's built-ins. */
export const OPERATOR_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'auth', description: 'add a Google account on the host (`--user <namespace>` for HTTP mode)' },
  {
    name: 'config',
    description: 'stored credential state: `config status` | `config delete --yes` (MCP `config` tool: `config-tool`)'
  },
  { name: 'status', description: 'alias of `config status`' },
  { name: 'logout', description: 'alias of `config delete`' },
  { name: 'doctor', description: 'environment and credential-backend checks' },
  { name: 'token', description: 'bearer-token helpers for HTTP mode' },
  { name: 'relay', description: 'removed; prints a pointer to `auth`' }
]

/** Domain tools, `help`, and one subcommand per alias -- the whole subcommand surface. */
export const TOOL_SUBCOMMAND_NAMES: readonly string[] = [
  ...DOMAINS.map((d) => d.name),
  HELP_SPEC.subcommand,
  ...Object.keys(TOOL_ALIASES)
]

/** Resolve a subcommand to its spec; undefined when the CLI does not expose it. */
function specFor(subcommand: string): ToolSpec | undefined {
  if (subcommand === HELP_SPEC.subcommand) return HELP_SPEC
  const aliased = TOOL_ALIASES[subcommand]
  if (aliased !== undefined) return infraSpec(subcommand, aliased)
  return domainSpec(subcommand)
}

class UsageError extends Error {}

/** First sentence of a tool description, for one-line summaries. */
function summarize(text: string): string {
  const firstLine = text.split('\n')[0] ?? text
  const sentence = firstLine.split('. ')[0] ?? firstLine
  return sentence.replace(/\.$/, '')
}

function summarizeActions(actions: readonly string[], max = 6): string {
  if (actions.length <= max) return actions.join(', ')
  return `${actions.slice(0, max).join(', ')}, … (+${actions.length - max})`
}

function toolUsage(spec: ToolSpec): string {
  if (spec.subcommand === HELP_SPEC.subcommand) {
    return [
      'usage: workspace help [topic] [--json]',
      '',
      'Print full documentation for one topic, or the whole subcommand surface',
      'when no topic is given.',
      '',
      'topics:',
      `  ${HELP_TOPICS.join(', ')}`,
      '',
      'options:',
      '  --json      Print the result as JSON on stdout',
      '  -h, --help  Show this help'
    ].join('\n')
  }

  const optionLines = Object.entries(spec.props).map(([name, raw]) => {
    const prop = readProp(raw)
    const description = prop.description ? `  ${prop.description}` : ''
    return `  --${name} <${prop.type}>${description}`
  })

  return [
    `usage: workspace ${spec.subcommand} <action> [--param <value>]... [--json]`,
    '',
    spec.description,
    '',
    'actions:',
    `  ${spec.actions.join(', ')}`,
    '',
    'options:',
    ...optionLines,
    '  --json      Print the result as JSON on stdout',
    '  -h, --help  Show this help'
  ].join('\n')
}

/**
 * The grouped `workspace help` / `workspace --help` surface: tool subcommands
 * and operator commands listed separately, so the two are never confused.
 * Both sections are derived from the lists above -- adding an alias, a domain
 * or an operator command changes this text without a second edit -- and the
 * label column is measured rather than hardcoded, so `config-tool` does not
 * push the descriptions out of line.
 */
export function cliHelpText(): string {
  const toolEntries: Array<{ label: string; description: string; actions: readonly string[] }> = [
    ...DOMAINS.map((d) => ({ label: d.name, description: d.description, actions: d.actions })),
    ...Object.entries(TOOL_ALIASES).map(([subcommand, tool]) => {
      const spec = infraSpec(subcommand, tool)
      return { label: subcommand, description: spec.description, actions: spec.actions }
    }),
    { label: HELP_SPEC.subcommand, description: 'Full documentation for any tool', actions: [] }
  ]

  const labels = [...toolEntries.map((entry) => entry.label), ...OPERATOR_COMMANDS.map((command) => command.name)]
  const width = Math.max(...labels.map((label) => label.length)) + 2

  const toolLines = toolEntries.map((entry) => {
    const suffix = entry.actions.length > 0 ? ` — ${summarizeActions(entry.actions)}` : ''
    return `  ${entry.label.padEnd(width)}${summarize(entry.description)}${suffix}`
  })
  const operatorLines = OPERATOR_COMMANDS.map((command) => `  ${command.name.padEnd(width)}${command.description}`)

  return [
    `workspace ${getPackageVersion()} — Google Workspace MCP server`,
    '',
    'usage:',
    '  workspace                              start the MCP server (stdio)',
    '  workspace --http                       start the MCP server (HTTP)',
    '  workspace <tool> <action> [--param]    call one tool from the terminal',
    '  workspace help [topic]                 tool documentation',
    '',
    'tools (each is an MCP tool; the CLI runs the same handler):',
    ...toolLines,
    '',
    'operator commands (not tools):',
    ...operatorLines,
    '',
    'examples:',
    '  workspace time getCurrentTime --json',
    '  workspace gmail search --query "is:unread" --maxResults 5',
    '  workspace docs getText --documentId <document-id> --limit 2000',
    '  workspace config-tool status --json',
    '  workspace help tasks'
  ].join('\n')
}

interface ParsedArgv {
  positionals: string[]
  params: Record<string, unknown>
  json: boolean
}

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new UsageError(`--${name} expects JSON, got '${raw}'`)
  }
}

function coerce(name: string, raw: string, prop: ToolProp): unknown {
  switch (prop.type) {
    case 'number': {
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new UsageError(`--${name} expects a number, got '${raw}'`)
      return value
    }
    case 'boolean': {
      if (raw === 'true' || raw === '') return true
      if (raw === 'false') return false
      throw new UsageError(`--${name} expects 'true' or 'false', got '${raw}'`)
    }
    case 'array': {
      // Anything that starts like a JSON array must BE one; a plain value is
      // the shorter comma-list form.
      if (raw.startsWith('[')) return parseJson(name, raw)
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    }
    default:
      return raw
  }
}

/**
 * Turn `[<action>, --flag value, --flag=value, --no-flag, --json]` into the
 * tool's input object. Unknown flags are rejected here rather than silently
 * dropped, because a dropped filter would widen the call (a search without its
 * query) instead of failing it.
 */
function parseArgv(spec: ToolSpec, argv: string[]): ParsedArgv {
  const positionals: string[] = []
  const params: Record<string, unknown> = {}
  let json = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === JSON_FLAG) {
      json = true
      continue
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const [flag, inlineValue] = token.slice(2).split(/=(.*)/s)
    const negated = flag!.startsWith('no-')
    const name = negated ? flag!.slice(3) : flag!
    const rawProp = spec.props[name]
    if (rawProp === undefined) {
      const valid = Object.keys(spec.props)
        .map((key) => `--${key}`)
        .join(', ')
      throw new UsageError(`unknown option --${name} (valid: ${valid})`)
    }
    const prop = readProp(rawProp)

    if (negated) {
      if (prop.type !== 'boolean') throw new UsageError(`--no-${name} only applies to boolean options`)
      params[name] = false
      continue
    }

    const next = argv[index + 1]
    const hasInline = inlineValue !== undefined
    const takesNext = !hasInline && next !== undefined && !next.startsWith('--')
    if (!hasInline && !takesNext) {
      // A bare boolean flag (`--preview`) is a truthy switch; anything else
      // needs its value.
      if (prop.type === 'boolean') {
        params[name] = true
        continue
      }
      throw new UsageError(`--${name} expects a value`)
    }
    if (takesNext) index += 1
    params[name] = coerce(name, hasInline ? inlineValue : next!, prop)
  }

  return { positionals, params, json }
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((item) => (item.type === 'text' ? item.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** The tool payload: parsed when the handler emitted JSON, raw text otherwise. */
function payloadOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Run one tool subcommand. Returns the process exit code:
 * 0 success, 1 tool failure, 2 argv the CLI could not parse.
 */
export async function runToolSubcommand(name: string, argv: string[], io: CliIo = defaultIo): Promise<number> {
  const spec = specFor(name)
  if (!spec) {
    io.err(`workspace: unknown tool '${name}' (expected one of: ${TOOL_SUBCOMMAND_NAMES.join(', ')})`)
    return USAGE_EXIT
  }
  const isHelp = spec.tool === HELP_SPEC.tool

  if (argv.some((token) => HELP_FLAGS[token] === true)) {
    io.out(toolUsage(spec))
    return 0
  }

  // `workspace help` with no topic is the grouped surface listing.
  if (isHelp && !argv.some((token) => !token.startsWith('-'))) {
    io.out(cliHelpText())
    return 0
  }

  let parsed: ParsedArgv
  let action: string
  try {
    parsed = parseArgv(spec, argv)
    if (isHelp) {
      if (parsed.positionals.length > 1) {
        throw new UsageError(`help takes one topic, got ${parsed.positionals.length}`)
      }
      action = 'help'
      if (parsed.positionals[0] !== undefined) parsed.params.topic = parsed.positionals[0]
    } else {
      const [positional, ...extra] = parsed.positionals
      if (positional === undefined) {
        throw new UsageError(`missing action (one of: ${spec.actions.join(', ')})`)
      }
      if (extra.length > 0) {
        throw new UsageError(`unexpected argument '${extra[0]}' (pass options as --name value)`)
      }
      action = positional
      parsed.params.action = positional
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.err(`workspace ${name}: ${error.message}`)
    io.err(`run \`workspace ${name} --help\` for usage`)
    return USAGE_EXIT
  }

  // `spec.tool`, not the subcommand: `config-tool` runs the MCP `config` tool,
  // and the envelope names the tool whose handler ran.
  const result = await dispatchTool(spec.tool, parsed.params)

  if (result.isError === true) {
    const message = textOf(result)
    io.err(parsed.json ? JSON.stringify({ tool: spec.tool, action, error: message }) : message)
    return 1
  }

  const text = textOf(result)
  if (!parsed.json) {
    io.out(text)
    return 0
  }
  io.out(JSON.stringify({ tool: spec.tool, action, result: payloadOf(text) }, null, 2))
  return 0
}

/**
 * Subcommand handlers for hull `buildCli`, keyed by subcommand name -- a tool
 * name, or an alias like `config-tool`. The dispatcher routes `workspace docs
 * ...` here; every other subcommand is untouched.
 */
export function toolCommands(): Record<string, CliHandler> {
  return Object.fromEntries(
    TOOL_SUBCOMMAND_NAMES.map((name) => [name, (argv: string[]) => runToolSubcommand(name, argv)])
  )
}

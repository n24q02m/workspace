import { beforeEach, describe, expect, it, vi } from 'vitest'

// The CLI is an adapter: it must reach the SAME dispatch the MCP `tools/call`
// handler runs, and nothing else. Stubbing the dispatch boundary is what makes
// "did it call the shared handler" observable, without a Google client.
vi.mock('../tools/dispatch.js', () => ({
  dispatchTool: vi.fn(),
  HELP_TOPICS: ['docs', 'drive', 'config', 'overview']
}))

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type * as DispatchModule from '../tools/dispatch.js'
import { dispatchTool } from '../tools/dispatch.js'
import { DOMAINS } from '../tools/domains/index.js'
import { INFRA_TOOLS } from '../tools/registry.js'
import {
  type CliIo,
  cliHelpText,
  OPERATOR_COMMANDS,
  runToolSubcommand,
  TOOL_ALIASES,
  TOOL_SUBCOMMAND_NAMES,
  toolCommands
} from './tools.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) }
  return { io, out, err }
}

function toolResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

describe('tool subcommand wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('ok'))
  })

  it('exposes one subcommand per domain tool, plus help and one per alias', () => {
    expect(Object.keys(toolCommands()).sort()).toEqual([...TOOL_SUBCOMMAND_NAMES].sort())
    expect(TOOL_SUBCOMMAND_NAMES).toEqual([
      ...DOMAINS.map((domain) => domain.name),
      'help',
      ...Object.keys(TOOL_ALIASES)
    ])
  })

  it('never shadows an operator command', () => {
    const commands = toolCommands()
    for (const operator of OPERATOR_COMMANDS) {
      expect(commands[operator.name]).toBeUndefined()
    }
  })

  // The MCP `config` tool and the operator `config` command are different
  // surfaces. The tool keeps a console path under the `config-tool` alias, and
  // it must run the config handler -- not the domain lookup, and not hull's.
  it('routes `config-tool status` to the MCP config tool', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('{"state":"awaiting_setup","configured":false}'))
    const { io, out } = capture()

    const code = await runToolSubcommand('config-tool', ['status'], io)

    expect(code).toBe(0)
    expect(dispatchTool).toHaveBeenCalledWith('config', { action: 'status' })
    expect(out).toEqual(['{"state":"awaiting_setup","configured":false}'])
  })

  it('names the MCP tool in the --json envelope of an aliased subcommand', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('{"accounts":[],"primary":null}'))
    const { io, out } = capture()

    const code = await runToolSubcommand('config-tool', ['account_list', '--json'], io)

    expect(code).toBe(0)
    expect(JSON.parse(out.join('\n'))).toEqual({
      tool: 'config',
      action: 'account_list',
      result: { accounts: [], primary: null }
    })
  })

  it('forwards the action and parsed options of every domain to the shared dispatch', async () => {
    for (const domain of DOMAINS) {
      vi.mocked(dispatchTool).mockClear()
      const { io } = capture()
      const code = await runToolSubcommand(domain.name, [domain.actions[0]!, '--account', 'me@example.com'], io)

      expect(code).toBe(0)
      expect(dispatchTool).toHaveBeenCalledWith(domain.name, {
        action: domain.actions[0],
        account: 'me@example.com'
      })
    }
  })
})

// The gap this closes: a tool that exists over MCP but has no console path is
// invisible from a shell, and the omission is silent. Both sides are derived --
// TOOL_NAMES from the real dispatch module, the subcommands from the lists this
// CLI exposes -- so a new tool fails here instead of shipping half-reachable.
describe('CLI parity with the tool surface', () => {
  it('keeps TOOL_NAMES equal to the registered surface, in order', async () => {
    // TOOL_NAMES is hand-written next to the dispatch switch, while the schemas
    // come from DOMAINS + INFRA_TOOLS. Pin them together: adding an infra tool
    // to the registry without adding it here would leave it out of the parity
    // walk below as well.
    const { TOOL_NAMES } = await vi.importActual<typeof DispatchModule>('../tools/dispatch.js')

    expect(TOOL_NAMES).toEqual([...DOMAINS.map((domain) => domain.name), ...INFRA_TOOLS.map((tool) => tool.name)])
  })

  it('gives every MCP tool a console path', async () => {
    const { TOOL_NAMES } = await vi.importActual<typeof DispatchModule>('../tools/dispatch.js')
    const operatorNames = new Set(OPERATOR_COMMANDS.map((command) => command.name))
    const subcommands = new Set(TOOL_SUBCOMMAND_NAMES)
    const aliasedTools = new Set(Object.values(TOOL_ALIASES))

    expect(TOOL_NAMES.length).toBeGreaterThan(0)
    for (const tool of TOOL_NAMES) {
      if (operatorNames.has(tool)) {
        // An operator command owns the name, so the tool has to be aliased:
        // `workspace config status` is the credential store, not the tool.
        expect(aliasedTools.has(tool), `${tool} is shadowed by an operator command and has no alias`).toBe(true)
        continue
      }
      expect(subcommands.has(tool), `${tool} has no CLI subcommand`).toBe(true)
    }

    for (const aliased of aliasedTools) {
      expect(TOOL_NAMES, `alias target '${aliased}' is not an MCP tool`).toContain(aliased)
    }
  })
})

describe('argv parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('ok'))
  })

  it('coerces numbers, booleans, comma lists, JSON arrays and inline values', async () => {
    const { io } = capture()
    await runToolSubcommand(
      'gmail',
      ['search', '--query=is:unread', '--maxResults', '5', '--includeSpamTrash', '--labelIds', 'INBOX,IMPORTANT'],
      io
    )

    expect(dispatchTool).toHaveBeenCalledWith('gmail', {
      action: 'search',
      query: 'is:unread',
      maxResults: 5,
      includeSpamTrash: true,
      labelIds: ['INBOX', 'IMPORTANT']
    })
  })

  it('turns --no-<flag> into false and parses JSON object arrays', async () => {
    const { io } = capture()
    await runToolSubcommand('docs', ['getText', '--preview', '--no-preview'], io)
    expect(dispatchTool).toHaveBeenLastCalledWith('docs', { action: 'getText', preview: false })

    vi.mocked(dispatchTool).mockClear()
    await runToolSubcommand('docs', ['formatText', '--formats', '[{"startIndex":1,"endIndex":2,"style":"bold"}]'], io)
    expect(dispatchTool).toHaveBeenLastCalledWith('docs', {
      action: 'formatText',
      formats: [{ startIndex: 1, endIndex: 2, style: 'bold' }]
    })
  })

  it('accepts explicit true/false values for boolean options', async () => {
    const { io } = capture()
    await runToolSubcommand('docs', ['getText', '--preview', 'true'], io)
    expect(dispatchTool).toHaveBeenLastCalledWith('docs', { action: 'getText', preview: true })

    await runToolSubcommand('docs', ['getText', '--preview', 'false'], io)
    expect(dispatchTool).toHaveBeenLastCalledWith('docs', { action: 'getText', preview: false })
  })

  it('rejects a value that is neither true nor false for a boolean option', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('docs', ['getText', '--preview', 'maybe'], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain("--preview expects 'true' or 'false'")
  })

  it('rejects a non-boolean --no- flag and malformed JSON values', async () => {
    const { io, err } = capture()
    expect(await runToolSubcommand('gmail', ['search', '--no-query'], io)).toBe(2)
    expect(err.join('\n')).toContain('--no-query only applies to boolean options')

    // Not JSON at all: a comma list is still a valid array value.
    vi.mocked(dispatchTool).mockClear()
    expect(await runToolSubcommand('docs', ['formatText', '--formats', 'not-json'], io)).toBe(0)
    expect(dispatchTool).toHaveBeenCalledWith('docs', { action: 'formatText', formats: ['not-json'] })

    // Starts like JSON and is not: rejected rather than sent half-parsed.
    vi.mocked(dispatchTool).mockClear()
    expect(await runToolSubcommand('docs', ['formatText', '--formats', '[1,'], io)).toBe(2)
    expect(err.join('\n')).toContain('--formats expects JSON')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('keeps a bare boolean flag true when no value follows', async () => {
    const { io } = capture()
    await runToolSubcommand('docs', ['getText', '--preview', '--documentId', 'doc-1'], io)
    expect(dispatchTool).toHaveBeenCalledWith('docs', { action: 'getText', preview: true, documentId: 'doc-1' })
  })
})

describe('output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints the tool text verbatim without --json', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('Document Title: Notes\n\nbody'))
    const { io, out } = capture()

    const code = await runToolSubcommand('docs', ['getText', '--documentId', 'doc-1'], io)

    expect(code).toBe(0)
    expect(out).toEqual(['Document Title: Notes\n\nbody'])
  })

  it('prints one JSON envelope under --json, with the payload parsed out of the text', async () => {
    const payload = { title: 'Notes', tabs: [] }
    vi.mocked(dispatchTool).mockResolvedValue(toolResult(JSON.stringify(payload)))
    const { io, out } = capture()

    const code = await runToolSubcommand('docs', ['getText', '--documentId', 'doc-1', '--json'], io)

    expect(code).toBe(0)
    expect(JSON.parse(out.join('\n'))).toEqual({ tool: 'docs', action: 'getText', result: payload })
  })

  it('ignores non-text content items in the result', async () => {
    vi.mocked(dispatchTool).mockResolvedValue({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    })
    const { io, out } = capture()

    await runToolSubcommand('docs', ['getText', '--documentId', 'doc-1'], io)

    expect(out).toEqual(['line one'])
  })

  it('writes through console when no io is injected', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('ok'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const code = await runToolSubcommand('docs', ['getText', '--documentId', 'doc-1'])
      expect(code).toBe(0)
      expect(logSpy).toHaveBeenCalledWith('ok')
    } finally {
      logSpy.mockRestore()
    }
  })

  it('keeps non-JSON payloads as a string inside the JSON envelope', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('plain text'))
    const { io, out } = capture()

    await runToolSubcommand('docs', ['getText', '--documentId', 'doc-1', '--json'], io)

    expect(JSON.parse(out.join('\n'))).toEqual({ tool: 'docs', action: 'getText', result: 'plain text' })
  })
})

describe('failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports a tool failure on stderr with exit 1 and nothing on stdout', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('Error: Document not found', true))
    const { io, out, err } = capture()

    const code = await runToolSubcommand('docs', ['getText', '--documentId', 'bad'], io)

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err).toEqual(['Error: Document not found'])
  })

  it('writes failures through console when no io is injected', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('Error: nope', true))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(await runToolSubcommand('docs', ['getText'])).toBe(1)
      expect(errorSpy).toHaveBeenCalledWith('Error: nope')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('reports a tool failure as a JSON envelope on stderr under --json', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('Error: Document not found', true))
    const { io, err } = capture()

    const code = await runToolSubcommand('docs', ['getText', '--documentId', 'bad', '--json'], io)

    expect(code).toBe(1)
    expect(JSON.parse(err.join('\n'))).toEqual({
      tool: 'docs',
      action: 'getText',
      error: 'Error: Document not found'
    })
  })

  it('rejects a call with no action', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('docs', [], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain('missing action (one of: getText, create')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('rejects an unknown option instead of silently dropping it', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('gmail', ['search', '--bogus', 'x'], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain('unknown option --bogus')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric value for a number option', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('gmail', ['search', '--maxResults', 'lots'], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain('--maxResults expects a number')
  })

  it('rejects an option whose value is missing', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('gmail', ['search', '--query'], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain('--query expects a value')
  })

  // `config` without the alias stays hull's operator command: it reads the
  // credential store, and quietly turning it into a tool call would change what
  // `workspace config status` prints for everyone already using it.
  it('leaves plain `config` to the operator command, not the MCP tool', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('config', ['status'], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain("unknown tool 'config'")
    expect(err.join('\n')).toContain('docs, time, drive')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('rejects an extra positional argument', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('docs', ['getText', 'doc-1'], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain("unexpected argument 'doc-1'")
  })
})

describe('help', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(dispatchTool).mockResolvedValue(toolResult('# Docs documentation'))
  })

  it('prints per-tool usage with the action list and the option names', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('docs', ['--help'], io)

    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('usage: workspace docs <action>')
    expect(text).toContain('getText')
    expect(text).toContain('--documentId <string>')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('prints the grouped surface for a bare `workspace help`', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('help', [], io)

    expect(code).toBe(0)
    const text = out.join('\n')
    for (const domain of DOMAINS) expect(text).toContain(domain.name)
    expect(text).toContain('tools (each is an MCP tool')
    expect(text).toContain('operator commands (not tools)')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('prints the help tool usage for `workspace help --help`', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('help', ['--help'], io)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain('usage: workspace help [topic]')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('prints the config-tool usage from the schema the server advertises', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('config-tool', ['--help'], io)

    expect(code).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('usage: workspace config-tool <action>')
    // Derived, not restated: these come from the MCP tool definition.
    expect(text).toContain('account_set_default')
    expect(text).toContain('--account <string>')
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it('routes `workspace help <topic>` through the MCP help tool', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('help', ['docs'], io)

    expect(code).toBe(0)
    expect(dispatchTool).toHaveBeenCalledWith('help', { topic: 'docs' })
    expect(out).toEqual(['# Docs documentation'])
  })

  it('rejects more than one help topic', async () => {
    const { io, err } = capture()

    const code = await runToolSubcommand('help', ['docs', 'drive'], io)

    expect(code).toBe(2)
    expect(err.join('\n')).toContain('help takes one topic')
  })

  it('lists the tool groups and the operator commands separately', () => {
    const text = cliHelpText()

    expect(text).toContain('tools (each is an MCP tool; the CLI runs the same handler):')
    expect(text).toContain('operator commands (not tools):')
    expect(text).toContain('  auth')
    expect(text).toContain('  doctor')
    expect(text).toContain('workspace gmail search --query "is:unread" --maxResults 5')
    // The alias is a tool subcommand; the plain name belongs to the operator list.
    expect(text).toMatch(/^ {2}config-tool +Manage server configuration/m)
    expect(text).toMatch(/^ {2}config +stored credential state: .*\(MCP `config` tool: `config-tool`\)$/m)
  })
})

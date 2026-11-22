import { describe, expect, it, vi } from 'vitest'
import { type CliIo, runToolSubcommand } from './tools.js'

// No mocks here on purpose: this file proves the CLI really reaches the same
// dispatch the MCP server uses, down to the domain handler and its validation.
// `time` is the one domain that needs no Google account and no network, so the
// whole path (argv -> dispatchTool -> domain.run -> TimeService) runs for real.
function capture() {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) }
  return { io, out, err }
}

describe('CLI -> shared dispatch (real handlers)', () => {
  it('runs the time domain and returns its JSON payload', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('time', ['getCurrentDate', '--json'], io)

    expect(code).toBe(0)
    const envelope = JSON.parse(out.join('\n')) as { tool: string; action: string; result: Record<string, unknown> }
    expect(envelope.tool).toBe('time')
    expect(envelope.action).toBe('getCurrentDate')
    expect(typeof envelope.result.utc).toBe('string')
    expect(typeof envelope.result.timeZone).toBe('string')
  })

  it('renders the same call as human text without --json', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('time', ['getTimeZone'], io)

    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('timeZone')
  })

  it('surfaces the domain validation error as a tool failure (exit 1)', async () => {
    const { io, out, err } = capture()

    const code = await runToolSubcommand('time', ['bogus'], io)

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain('Unknown action: bogus')
    expect(err.join('\n')).toContain('Valid actions')
  })

  it('exits 1 with the payload on stderr when the service reports {error}', async () => {
    // Fault injection, not a mock of the path under test: TimeService catches the
    // thrown error and returns {"error": ...} without isError, so this exercises
    // the domain factory flagging that payload and the CLI turning it into exit 1.
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no time zone data')
    })
    const { io, out, err } = capture()

    try {
      const code = await runToolSubcommand('time', ['getTimeZone'], io)

      expect(code).toBe(1)
      expect(out).toEqual([])
      expect(JSON.parse(err.join('\n'))).toEqual({ error: 'no time zone data' })
    } finally {
      spy.mockRestore()
    }
  })

  it('reads a documentation topic through the MCP help handler', async () => {
    const { io, out } = capture()

    const code = await runToolSubcommand('help', ['overview'], io)

    expect(code).toBe(0)
    expect(out.join('\n').length).toBeGreaterThan(0)
  })
})

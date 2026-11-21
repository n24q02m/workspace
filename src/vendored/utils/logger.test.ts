import { afterEach, describe, expect, it, vi } from 'vitest'
import { logToFile, setLoggingEnabled } from './logger.js'

describe('vendored logger shim', () => {
  afterEach(() => {
    setLoggingEnabled(false)
    vi.restoreAllMocks()
  })

  it('writes nothing until logging is switched on', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    logToFile('not yet')

    expect(stderr).not.toHaveBeenCalled()
  })

  it('writes one prefixed line to stderr and never to stdout, the MCP channel', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    setLoggingEnabled(true)
    logToFile('token refreshed')

    expect(stderr).toHaveBeenCalledExactlyOnceWith('[workspace] token refreshed\n')
    expect(stdout).not.toHaveBeenCalled()
  })

  it('goes quiet again once switched off', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    setLoggingEnabled(true)
    setLoggingEnabled(false)
    logToFile('after')

    expect(stderr).not.toHaveBeenCalled()
  })
})

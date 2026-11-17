import { describe, expect, it, vi } from 'vitest'
import {
  aiReadableMessage,
  enhanceError,
  findClosestMatch,
  retryWithBackoff,
  suggestFixes,
  WorkspaceMCPError,
  withErrorHandling
} from './errors.js'

describe('WorkspaceMCPError', () => {
  it('should set all properties from constructor', () => {
    const error = new WorkspaceMCPError('test message', 'TEST_CODE', 'try this', { foo: 'bar' })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(WorkspaceMCPError)
    expect(error.name).toBe('WorkspaceMCPError')
    expect(error.message).toBe('test message')
    expect(error.code).toBe('TEST_CODE')
    expect(error.suggestion).toBe('try this')
    expect(error.details).toEqual({ foo: 'bar' })
  })

  it('should allow optional suggestion and details', () => {
    const error = new WorkspaceMCPError('msg', 'CODE')

    expect(error.suggestion).toBeUndefined()
    expect(error.details).toBeUndefined()
  })

  it('toJSON should return correct shape', () => {
    const error = new WorkspaceMCPError('msg', 'CODE', 'hint', { id: 1 })

    expect(error.toJSON()).toEqual({
      error: 'WorkspaceMCPError',
      code: 'CODE',
      message: 'msg',
      suggestion: 'hint',
      details: { id: 1 }
    })
  })
})

describe('enhanceError', () => {
  it('should pass through an existing WorkspaceMCPError unchanged', () => {
    const original = new WorkspaceMCPError('msg', 'CODE')

    expect(enhanceError(original)).toBe(original)
  })

  describe('network errors', () => {
    it('should handle ECONNREFUSED', () => {
      const result = enhanceError({ message: 'connect ECONNREFUSED 127.0.0.1:443' })

      expect(result.code).toBe('NETWORK_ERROR')
      expect(result.message).toContain('Cannot connect')
      expect(result.suggestion).toContain('internet connection')
    })

    it('should handle ENOTFOUND', () => {
      const result = enhanceError({ message: 'getaddrinfo ENOTFOUND docs.googleapis.com' })

      expect(result.code).toBe('NETWORK_ERROR')
    })
  })

  describe('coded errors', () => {
    it('should preserve and uppercase an existing error code', () => {
      const result = enhanceError({ code: 'not_found', message: 'missing' })

      expect(result.code).toBe('NOT_FOUND')
      expect(result.message).toBe('missing')
    })

    it('should fall back to a default message when a coded error has none', () => {
      const result = enhanceError({ code: 'weird' })

      expect(result.code).toBe('WEIRD')
      expect(result.message).toBe('Unknown error occurred')
    })
  })

  describe('generic errors', () => {
    it('should handle errors without a code', () => {
      const result = enhanceError({ message: 'something broke' })

      expect(result.code).toBe('UNKNOWN_ERROR')
      expect(result.message).toBe('something broke')
      expect(result.suggestion).toContain('try again')
    })

    it('should handle errors without a message', () => {
      const result = enhanceError({})

      expect(result.code).toBe('UNKNOWN_ERROR')
      expect(result.message).toBe('Unknown error occurred')
    })

    it('should handle non-object errors', () => {
      const result = enhanceError('plain string error')

      expect(result.code).toBe('UNKNOWN_ERROR')
      expect(result.message).toBe('Unknown error occurred')
    })

    it('should sanitize details for generic errors', () => {
      const result = enhanceError({ message: 'oops', name: 'SomeError', status: 502 })

      expect(result.details).toEqual({
        message: 'oops',
        name: 'SomeError',
        code: undefined,
        status: 502
      })
    })
  })

  describe('security', () => {
    it('should not leak sensitive headers in generic errors', () => {
      const sensitiveError = {
        message: 'Something went wrong',
        name: 'GenericError',
        config: { headers: { Authorization: 'Bearer secret-token' } },
        request: { _headers: { authorization: 'Bearer secret-token' } },
        response: { status: 500 }
      }

      const enhanced = enhanceError(sensitiveError)

      expect(enhanced.details.message).toBe('Something went wrong')
      expect(JSON.stringify(enhanced.details)).not.toContain('secret-token')
      expect(enhanced.details.config).toBeUndefined()
      expect(enhanced.details.request).toBeUndefined()
    })

    it('should only redact the sensitive keys in a headers object, leaving others intact', () => {
      // stripSensitiveFields mutates the error object in place before
      // sanitizeErrorDetails's whitelist strips non-whitelisted fields like
      // `config` out of the final `details` -- assert on the mutated input
      // directly to see redactHeaderMap's per-key behavior.
      const errorWithMixedHeaders = {
        message: 'boom',
        config: { headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' } }
      }

      enhanceError(errorWithMixedHeaders)

      expect(errorWithMixedHeaders.config.headers).not.toHaveProperty('Authorization')
      expect(errorWithMixedHeaders.config.headers['Content-Type']).toBe('application/json')
    })

    it('should not infinite-loop on a circular error object', () => {
      const circular: Record<string, unknown> = { message: 'boom', code: 'CIRC' }
      circular.self = circular

      expect(() => enhanceError(circular)).not.toThrow()
      expect(enhanceError(circular).code).toBe('CIRC')
    })
  })
})

describe('aiReadableMessage', () => {
  it('should format error with an explicit suggestion', () => {
    const error = new WorkspaceMCPError('Document not found', 'NOT_FOUND', 'Check the ID')

    expect(aiReadableMessage(error)).toBe('Error: Document not found\n\nSuggestion: Check the ID')
  })

  it('should fall back to default suggestions when none is set', () => {
    const error = new WorkspaceMCPError('Something failed', 'UNKNOWN')
    const msg = aiReadableMessage(error)

    expect(msg).toContain('Error: Something failed')
    expect(msg).toContain('Suggestion:')
    expect(msg).toContain('Review request parameters')
  })

  it('should include details when present', () => {
    const error = new WorkspaceMCPError('Bad input', 'VALIDATION_ERROR', 'Fix it', { field: 'title' })
    const msg = aiReadableMessage(error)

    expect(msg).toContain('Error: Bad input')
    expect(msg).toContain('Suggestion: Fix it')
    expect(msg).toContain('Details:')
    expect(msg).toContain('"field": "title"')
  })
})

describe('suggestFixes', () => {
  it('should return the generic default suggestions for any code (no domain-specific map yet)', () => {
    expect(suggestFixes(new WorkspaceMCPError('', 'ANY_CODE'))).toEqual([
      'Review request parameters',
      'Try again in a few moments'
    ])
  })
})

describe('withErrorHandling', () => {
  it('should pass through successful results', async () => {
    const wrapped = withErrorHandling(async (a: number, b: number) => a + b)

    expect(await wrapped(2, 3)).toBe(5)
  })

  it('should catch and enhance thrown errors', async () => {
    const wrapped = withErrorHandling(async () => {
      throw { message: 'connect ECONNREFUSED 127.0.0.1' }
    })

    await expect(wrapped()).rejects.toThrow(WorkspaceMCPError)
    await expect(wrapped()).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })
})

describe('retryWithBackoff', () => {
  it('should succeed on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok')

    const result = await retryWithBackoff(fn, { initialDelay: 1 })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should succeed after retries', async () => {
    const fn = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject({ message: 'fail 1' }))
      .mockImplementationOnce(() => Promise.reject({ message: 'fail 2' }))
      .mockResolvedValue('ok')

    const result = await retryWithBackoff(fn, { initialDelay: 1, maxDelay: 10 })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('should give up after maxRetries', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject({ message: 'always fails' }))

    await expect(retryWithBackoff(fn, { maxRetries: 2, initialDelay: 1, maxDelay: 5 })).rejects.toThrow(
      WorkspaceMCPError
    )
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('should not retry on UNAUTHORIZED', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject({ code: 'UNAUTHORIZED', message: 'bad token' }))

    await expect(retryWithBackoff(fn, { maxRetries: 3, initialDelay: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED'
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should not retry on NOT_FOUND', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject({ code: 'NOT_FOUND', message: 'gone' }))

    await expect(retryWithBackoff(fn, { maxRetries: 3, initialDelay: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should use default options when none are provided', async () => {
    const fn = vi.fn().mockResolvedValue('ok')

    expect(await retryWithBackoff(fn)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('findClosestMatch', () => {
  it('should return null for empty input or empty options', () => {
    expect(findClosestMatch('', ['option'])).toBeNull()
    expect(findClosestMatch('input', [])).toBeNull()
  })

  it('should return a prefix match case-insensitively', () => {
    expect(findClosestMatch('doc', ['docs', 'other'])).toBe('docs')
    expect(findClosestMatch('DOCS', ['doc', 'other'])).toBe('doc')
  })

  it('should return the closest match by bigram similarity', () => {
    expect(findClosestMatch('propety', ['property', 'something else'])).toBe('property')
  })

  it('should return null when nothing is close enough', () => {
    expect(findClosestMatch('xyz', ['abc', 'def'])).toBeNull()
  })

  it('should skip a one-character option that is not a prefix and keep scanning', () => {
    expect(findClosestMatch('xyz', ['q'])).toBeNull()
    expect(findClosestMatch('docz', ['q', 'docs'])).toBe('docs')
  })

  it('should count a repeated bigram in an option once', () => {
    // Bigram sets: 'aaab' -> {aa, ab}, 'aaaaaaac' -> {aa, ac}; Dice = 2*1/(2+2) = 0.5.
    // Counting the six repeated 'aa' would give 2*1/(2+7) and miss the match.
    expect(findClosestMatch('aaab', ['aaaaaaac'])).toBe('aaaaaaac')
  })
})

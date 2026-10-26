import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from '../constants.js'
import { escapeHtml, startLoopbackConsent } from './loopback-consent.js'

const realFetch = globalThis.fetch
const idToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"email":"a@example.com"}').toString('base64url')}.sig`
type Handle = { url: string; host: string; port: number; close: () => Promise<void> }
const handles: Handle[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of handles.splice(0)) await h.close()
})

/** Stubs only the Google token endpoint; loopback requests still go to the real server. */
function stubTokenEndpoint(response: () => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(GOOGLE_TOKEN_URL)) return Promise.resolve(response())
    return realFetch(input, init)
  })
}

async function start(onTokens = vi.fn(async () => {})) {
  const handle = await startLoopbackConsent({
    clientId: 'cid',
    clientSecret: 'test-client-secret',
    scopes: ['openid', 'email'],
    onTokens
  })
  handles.push(handle)
  return { handle, onTokens }
}

function stateFrom(location: string | null): string {
  return new URL(location ?? '').searchParams.get('state') ?? ''
}

/** Sends a raw HTTP request, bypassing fetch's URL normalization, and returns the reply. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request))
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
    })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

describe('startLoopbackConsent', () => {
  it('listens on 127.0.0.1 with an ephemeral port by default', async () => {
    const { handle } = await start()
    expect(handle.host).toBe('127.0.0.1')
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`)
  })

  it('redirects GET / to Google with offline access, forced consent and a state', async () => {
    const { handle } = await start()
    const res = await realFetch(handle.url, { redirect: 'manual' })

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.href.startsWith(GOOGLE_AUTHORIZE_URL)).toBe(true)
    expect(location.searchParams.get('client_id')).toBe('cid')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('scope')).toBe('openid email')
    expect(location.searchParams.get('access_type')).toBe('offline')
    expect(location.searchParams.get('prompt')).toBe('consent')
    expect(stateFrom(res.headers.get('location'))).not.toBe('')
  })

  it('rejects a callback whose state does not match, without exchanging the code', async () => {
    const tokenFetch = stubTokenEndpoint(() => new Response('{}', { status: 200 }))
    const { handle, onTokens } = await start()

    const res = await realFetch(`${handle.url}callback?state=wrong&code=x`)

    expect(res.status).toBe(400)
    expect(onTokens).not.toHaveBeenCalled()
    expect(tokenFetch.mock.calls.some(([input]) => String(input).startsWith(GOOGLE_TOKEN_URL))).toBe(false)
  })

  it('refuses a callback that reports a Google error', async () => {
    const { handle, onTokens } = await start()
    const first = await realFetch(handle.url, { redirect: 'manual' })
    const state = stateFrom(first.headers.get('location'))

    const res = await realFetch(`${handle.url}callback?state=${state}&error=access_denied`)

    expect(res.status).toBe(400)
    expect(onTokens).not.toHaveBeenCalled()
  })

  it('refuses a callback with no authorization code', async () => {
    const { handle, onTokens } = await start()
    const first = await realFetch(handle.url, { redirect: 'manual' })
    const state = stateFrom(first.headers.get('location'))

    const res = await realFetch(`${handle.url}callback?state=${state}`)

    expect(res.status).toBe(400)
    expect(onTokens).not.toHaveBeenCalled()
  })

  it('exchanges a valid code and hands the tokens to onTokens exactly once', async () => {
    stubTokenEndpoint(
      () => new Response(JSON.stringify({ access_token: 'fake-token-value', id_token: idToken }), { status: 200 })
    )
    const { handle, onTokens } = await start()
    const first = await realFetch(handle.url, { redirect: 'manual' })
    const state = stateFrom(first.headers.get('location'))

    const res = await realFetch(`${handle.url}callback?state=${state}&code=auth-code`)

    expect(res.status).toBe(200)
    expect(onTokens).toHaveBeenCalledTimes(1)
    expect(onTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'fake-token-value' }))
  })

  it('reports a failed token exchange as a server error and does not call onTokens', async () => {
    stubTokenEndpoint(() => new Response('invalid_grant', { status: 400 }))
    const { handle, onTokens } = await start()
    const first = await realFetch(handle.url, { redirect: 'manual' })
    const state = stateFrom(first.headers.get('location'))

    const res = await realFetch(`${handle.url}callback?state=${state}&code=bad-code`)

    expect(res.status).toBe(500)
    expect(onTokens).not.toHaveBeenCalled()
  })

  it('answers unknown paths with 404 and non-GET methods with 405', async () => {
    const { handle } = await start()
    expect((await realFetch(`${handle.url}nope`)).status).toBe(404)
    expect((await realFetch(handle.url, { method: 'POST' })).status).toBe(405)
  })

  it('answers a request target that cannot be parsed with a 500 page and keeps serving', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { handle } = await start()
    const reply = await rawRequest(
      handle.port,
      'GET http://[bad/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    )
    expect(reply).toMatch(/^HTTP\/1\.1 500 /)
    expect(reply).toContain('Unexpected error.')
    expect(consoleError).toHaveBeenCalledWith('[workspace] consent request failed:', expect.any(TypeError))
    expect((await realFetch(`${handle.url}nope`)).status).toBe(404)
  })
})

describe('escapeHtml', () => {
  it('escapes markup and quote characters so page text cannot inject HTML', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})

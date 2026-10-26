/**
 * One-shot Google consent over a loopback HTTP server.
 *
 * `/` redirects the browser to Google's consent screen. Google redirects back to
 * `/callback`, where the authorization code is exchanged for tokens and handed to
 * `onTokens`. Only the stdio/CLI flows use this; the HTTP server never runs consent
 * (see src/auth/add-account.ts and src/auth/oauth-setup.ts).
 *
 * The `state` value is random per server and checked in constant time. A user-facing
 * error page never echoes tokens or the token-endpoint body.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from '../constants.js'

export type ConsentTokens = Record<string, unknown>

export interface LoopbackConsentOptions {
  clientId: string
  clientSecret: string
  scopes: readonly string[]
  /**
   * Called once per successful code exchange, so a late tab reaches it too. A rejection
   * is shown on that tab's page; the caller decides what a late tab may do.
   */
  onTokens: (tokens: ConsentTokens) => Promise<void>
  /** 0 (default) lets the OS pick a free port on 127.0.0.1. */
  port?: number
}

export interface LoopbackConsent {
  /** Base URL to open, e.g. `http://127.0.0.1:53121/`. */
  url: string
  host: string
  port: number
  close: () => Promise<void>
}

const HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function sendPage(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`
  )
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function exchangeCode(opts: LoopbackConsentOptions, code: string, redirectUri: string): Promise<ConsentTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: redirectUri
  })
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) {
    // The body is deliberately not read into the error: it is the provider's text and
    // can echo request fields back.
    throw new Error(`Google token exchange failed (HTTP ${res.status}).`)
  }
  return (await res.json()) as ConsentTokens
}

export async function startLoopbackConsent(opts: LoopbackConsentOptions): Promise<LoopbackConsent> {
  const state = randomBytes(16).toString('base64url')
  let redirectUri = ''

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)

    if (req.method !== 'GET') {
      sendPage(res, 405, 'Method not allowed', 'Use GET.')
      return
    }

    if (url.pathname === '/') {
      const authorize = new URL(GOOGLE_AUTHORIZE_URL)
      authorize.search = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: opts.scopes.join(' '),
        state,
        access_type: 'offline',
        prompt: 'consent'
      }).toString()
      res.writeHead(302, { Location: authorize.toString(), 'Cache-Control': 'no-store' })
      res.end()
      return
    }

    if (url.pathname !== CALLBACK_PATH) {
      sendPage(res, 404, 'Not found', 'Nothing here.')
      return
    }

    const returnedState = url.searchParams.get('state') ?? ''
    if (!sameText(returnedState, state)) {
      sendPage(res, 400, 'Authorization failed', 'The consent response did not match this session. Start again.')
      return
    }
    if (url.searchParams.get('error')) {
      sendPage(res, 400, 'Authorization cancelled', 'Google did not grant access. Nothing was stored.')
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      sendPage(res, 400, 'Authorization failed', 'Google returned no authorization code.')
      return
    }

    try {
      const tokens = await exchangeCode(opts, code, redirectUri)
      await opts.onTokens(tokens)
      sendPage(res, 200, 'Authorization complete', 'You can close this tab.')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authorization failed.'
      sendPage(res, 500, 'Authorization failed', message)
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('[workspace] consent request failed:', err)
      if (!res.headersSent) sendPage(res, 500, 'Authorization failed', 'Unexpected error.')
    })
  })

  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(opts.port ?? 0, HOST, () => {
    server.off('error', listening.reject)
    listening.resolve()
  })
  await listening.promise

  const { port } = server.address() as AddressInfo
  redirectUri = `http://${HOST}:${port}${CALLBACK_PATH}`

  return {
    url: `http://${HOST}:${port}/`,
    host: HOST,
    port,
    close: () => {
      const closed = Promise.withResolvers<void>()
      server.close((err) => (err ? closed.reject(err) : closed.resolve()))
      server.closeIdleConnections()
      return closed.promise
    }
  }
}

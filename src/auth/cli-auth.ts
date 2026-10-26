/**
 * `workspace auth [--user <namespace>]`: add a Google account from the host.
 *
 * Without `--user` the account is stored for the local stdio server. With `--user` it is
 * stored under that hull multi-auth namespace, which is the subject the HTTP server reads
 * for that user. This is the only consent path for HTTP users: remote callers cannot
 * complete Google consent over MCP.
 */
import { localAuthContext, runWithAuthContext } from '@n24q02m/hull/token-auth'
import { startAddAccount } from './add-account.js'

const NAMESPACE_RE = /^[a-zA-Z0-9._-]+$/

function parseUser(argv: string[]): { user?: string; error?: string } {
  const idx = argv.indexOf('--user')
  if (idx === -1) return {}
  const user = argv[idx + 1]
  if (!user || user.startsWith('--')) return { error: '--user requires a namespace value.' }
  if (!NAMESPACE_RE.test(user)) {
    return { error: '--user must contain only letters, digits, ".", "_" or "-".' }
  }
  return { user }
}

async function consent(): Promise<number> {
  const flow = await startAddAccount()
  process.stderr.write(`[workspace] Google authorization required. Open ${flow.url} in a browser to continue.\n`)
  const email = await flow.done
  process.stdout.write(`Added ${email}\n`)
  return 0
}

export async function authCommand(argv: string[]): Promise<number> {
  const { user, error } = parseUser(argv)
  if (error) {
    process.stderr.write(`${error}\n`)
    return 2
  }
  try {
    if (user === undefined) return await consent()
    return await runWithAuthContext({ ...localAuthContext(), uid: user, namespace: user, mode: 'multi' }, consent)
  } catch (err) {
    process.stderr.write(`auth failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

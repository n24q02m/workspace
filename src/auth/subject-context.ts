/**
 * Storage subject of the current request: the hull `namespace` of the authenticated caller.
 *
 * Layering: hull's HTTP guard binds the caller (`AuthContext`) for each request; tools
 * read it here and scope credential storage by `namespace`. The Google account a tool
 * uses is a second, independent axis, chosen by the tool argument (account-context.ts).
 *
 * `undefined` means "no subject": stdio and loopback no-auth both resolve to
 * `mode: 'no-auth'`, which maps to the single-user layout in PerPluginStore (sub = null).
 */
import { currentUser } from '@n24q02m/hull/token-auth'

export function currentSubject(): string | undefined {
  const user = currentUser()
  return user.mode === 'no-auth' ? undefined : user.namespace
}

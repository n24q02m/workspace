# config

Manage server configuration, Google credential state, and the set of Google
accounts this server can act as. Does not require a configured Google account --
works independently of the domain tools.

## Actions

| Action | Description |
| --- | --- |
| `status` | Returns `{state, configured, accounts, primary}` -- the credential state (`awaiting_setup` \| `configured`), the configured account emails, and which one is primary. |
| `setup_start` | Returns instructions to trigger the browser Google OAuth consent flow (stdio mode: restart the server). |
| `setup_reset` | Clears stored credentials for **every** account and returns to `awaiting_setup`. |
| `setup_complete` | Re-checks stored credentials after an external config change. |
| `set` | No mutable runtime settings -- returns an informational no-op. |
| `cache_clear` | No client-side cache -- returns an informational no-op. |
| `account_add` | Adds one more Google account. In stdio it starts a loopback consent flow and returns `{open, next}`; open the `open` URL to complete the consent. Over HTTP it returns `{open: null, next, default_account}`, where `next` is the `workspace auth --user <namespace>` command to run on the host. |
| `account_list` | Returns `{accounts, primary}`. |
| `account_remove` | Forgets the account named in `account`. Returns `{removed, primary}`. |
| `account_set_default` | Makes the account named in `account` the primary one. Returns `{primary}`. |

## CLI

Every action is also a console subcommand:

```sh
workspace config-tool status --json
workspace config-tool account_list
workspace config-tool account_set_default --account you@example.com
```

The subcommand is `config-tool`, not `config`: `workspace config ...` is the
operator command that reads the credential store hull manages, which is a
different surface from this tool. `--json` prints `{tool, action, result}` on
stdout; a tool failure prints to stderr and exits 1. The flags (`--key`,
`--value`, `--account`) come from this tool's schema, so they cannot drift from
the parameters above.

## Accounts

Every domain tool takes `account="<email>"`. Omit it and the call runs against
the primary account.

- The first account stored becomes the primary automatically.
- Removing the primary promotes one of the remaining accounts -- `account_remove`
  reports which one in `primary`.
- Removing the last account clears the credential blob and puts the server back
  in `awaiting_setup`; domain tools are refused again until an account is
  configured.
- Naming an account that is not configured is an **error that names the
  account**, and lists what is configured. The call is never silently rerouted to
  the primary -- a silent fallback would act on the wrong mailbox.
- Emails are the account keys, matched case-insensitively and stored lowercased.
- `account_remove` and `account_set_default` require `account` and have no
  default: falling back to the primary would remove or reshuffle the wrong
  account. `account_set_default` on an unknown account is an error.

### account_add

- Picks the flow by transport. In stdio it stands a temporary consent server on
  a loopback port and returns its URL. Over HTTP the server does not serve
  consent at all: it returns `open: null` and, in `next`, the
  `workspace auth --user <namespace>` command to run on the host, already filled
  in with the caller's own namespace.
- **What that means for an HTTP deployment**: the operator runs that command on
  the host. It writes the account into that namespace's encrypted store, so it
  needs the server's `CREDENTIAL_SECRET` and the same credential directory. Like
  the stdio flow, it prints a consent URL on a loopback port.
- The account is filed under the namespace passed to `--user`, not under whoever
  the consent screen was signed in as. Those are two different identities: the
  caller is the users-file namespace its bearer token maps to, and the account is
  the email in the tokens Google returns.
- Requires `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the
  environment of whichever process runs the consent: the stdio server, or the
  host `workspace auth` command.
- In stdio it returns the URL immediately rather than blocking on the consent.
  Open it, sign in as the account you want to add, then call `account_list` to
  confirm the outcome.
- Which account gets added is decided by whom you sign in as on the consent
  screen. `account_add` does **not** read the `account` parameter.
- Pass `value="primary"` to make the newly added account the primary one. This
  is **stdio only**: over HTTP the account is added by the host `workspace auth`
  command, which takes no such option. Remote callers get told it was ignored and
  should use
  `account_set_default` instead. (Either way, the very first account in an empty
  store becomes primary -- a store of accounts with no working default would be
  broken.)
- The link is good for 10 minutes and works once. In stdio the temporary consent
  server also closes itself after that window, so an abandoned flow does not hold
  its port open. Call `account_add` again if the URL has gone stale.

## key / value

`key` is accepted on the schema but unused. `value` is read only by `account_add`
(`value="primary"`).

## Upgrading from the single-account layout

Credentials written before multi-account support are a single flat blob of tokens.
The first run afterwards adopts that blob into the multi-account layout, keyed by
the account's email:

- The email comes from the stored `id_token` when it is there. That needs no
  network and is the usual case.
- Otherwise the server asks Google's userinfo endpoint, which needs network
  access and a token that is still valid or refreshable.

If neither works, the state falls back to `awaiting_setup` and the server starts the
browser OAuth flow even though the stored token may still be good. Completing that
consent does work, and nothing is discarded: the newly authorized account is stored
and becomes the primary, and the old blob is carried across under the key
`(unidentified)` rather than being overwritten. `account_list` then shows two
entries:

```json
{ "accounts": ["(unidentified)", "you@example.com"], "primary": "you@example.com" }
```

`(unidentified)` holds the tokens whose owner could not be determined. Nothing
routes to it -- it is never promoted to primary while a real account remains, and
no call can select it unless you name it. Remove it once the re-authorized account
is working:

```json
{ "action": "account_remove", "account": "(unidentified)" }
```

After a successful adoption -- the usual case -- `account_list` shows exactly one
account and it is the primary.

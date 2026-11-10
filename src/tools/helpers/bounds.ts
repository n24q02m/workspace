/**
 * Response bounds for tool payloads with no natural size limit.
 *
 * A Google read can return megabytes from one call: a Docs body, a Gmail
 * message, a slide deck's text, or a Drive comment thread with replies. Those
 * payloads are bounded by default like the notion `max_chars` reader and the
 * sheets `getText`/`getRange` reads: 20,000 characters, raisable to 100,000,
 * with `full: true` for the complete payload. Listing payloads additionally
 * cap how many items one response carries.
 *
 * Truncation is never silent and never breaks the caller's next step:
 *
 * - the emitted text names the true size and how to fetch the rest;
 * - a JSON payload stays parseable (`_truncation` entry; a top-level array is
 *   wrapped as `{ items, _truncation }`);
 * - a pagination cursor (`nextPageToken` and friends) is never cut, so the
 *   caller can always page on instead of being stranded mid-list.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Characters kept by default. Matches the sheets/docs/notion reads. */
export const DEFAULT_RESPONSE_CHARS = 20_000
/** Highest budget a caller may request with `max_chars`. */
export const MAX_RESPONSE_CHARS = 100_000
/** Items kept by default from a listing array that has no pagination cursor. */
export const DEFAULT_RESPONSE_ITEMS = 50
/** `full: true` -- no character and no item budget. */
export const UNBOUNDED = Number.POSITIVE_INFINITY

/**
 * Keys whose value is a cursor. Cutting one would leave the caller holding a
 * token that no longer resolves, so these strings are exempt from the string
 * budget even when the payload is over it.
 */
const CURSOR_KEYS: Readonly<Record<string, true>> = {
  nextPageToken: true,
  next_page_token: true,
  nextPageCursor: true,
  pageToken: true,
  page_token: true,
  nextSyncToken: true,
  syncToken: true,
  continuationToken: true,
  cursor: true
}

export interface ResponseBudget {
  chars: number
  items: number
}

export interface BoundedPayload {
  text: string
  truncated: boolean
  totalCharacters: number
}

export interface TruncationList {
  path: string
  returned: number
  total: number
}

function tryParseJson(text: string): { value: Record<string, unknown> | unknown[] } | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    // Only `{`/`[` got here, so a successful parse is an object or an array.
    return { value: JSON.parse(trimmed) as Record<string, unknown> | unknown[] }
  } catch {
    return undefined
  }
}

/**
 * The marker every bounded payload carries: true size plus the escape hatch.
 * Same wording as the sheets reader so one sentence means one thing across
 * this server.
 */
export function truncationNote(totalCharacters: number, keptCharacters: number, hint: string): string {
  const omitted = Math.max(totalCharacters - keptCharacters, 0)
  return `[Content truncated: showing ${keptCharacters} of ${totalCharacters} characters (${omitted} omitted). ${hint}]`
}

/**
 * Validate `max_chars` and resolve the budget. `full: true` removes both
 * bounds; a missing `max_chars` keeps the default; anything else must be an
 * integer from 1 to 100,000 (the same envelope the sheets reads accept).
 */
export function resolveResponseBudget(
  input: { max_chars?: unknown; full?: unknown },
  spec: { chars?: number; items?: number } = {}
): ResponseBudget {
  if (input.full === true) return { chars: UNBOUNDED, items: UNBOUNDED }

  const items = spec.items ?? UNBOUNDED
  const maxChars = input.max_chars
  if (maxChars === undefined) return { chars: spec.chars ?? DEFAULT_RESPONSE_CHARS, items }
  if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_RESPONSE_CHARS) {
    throw new Error(`max_chars must be an integer between 1 and ${MAX_RESPONSE_CHARS}.`)
  }
  return { chars: maxChars, items }
}

/** Relative path of a nested node, e.g. `$.messages[0].payload`. */
function childPath(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`
}

interface ShrinkResult {
  value: Record<string, unknown> | unknown[]
  lists: TruncationList[]
}

/**
 * Walk the payload and cut over-budget arrays and strings. Cursor values are
 * kept whole; only arrays are capped (never a cursor, which is a string).
 */
function shrink(
  root: Record<string, unknown> | unknown[],
  caps: { items: number; stringChars: number },
  path = '$'
): ShrinkResult {
  const lists: TruncationList[] = []

  const walk = (node: unknown, at: string): unknown => {
    if (Array.isArray(node)) {
      const kept = caps.items === UNBOUNDED ? node : node.slice(0, caps.items)
      if (kept.length < node.length) lists.push({ path: at, returned: kept.length, total: node.length })
      return kept.map((item, index) => walk(item, childPath(at, index)))
    }
    if (typeof node === 'string') {
      if (caps.stringChars === UNBOUNDED || node.length <= caps.stringChars) return node
      return `${node.slice(0, caps.stringChars)}[+${node.length - caps.stringChars} chars]`
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) {
        out[key] = CURSOR_KEYS[key] ? child : walk(child, childPath(at, key))
      }
      return out
    }
    return node
  }

  // `walk` is generic over any node; a root here is always a parsed JSON object
  // or array, because `tryParseJson` refuses anything else.
  const shrunk = walk(root, path) as Record<string, unknown> | unknown[]
  return { value: shrunk, lists }
}

/** Attach the `_truncation` entry to an object payload, or wrap an array. */
function withTruncation(
  value: Record<string, unknown> | unknown[],
  lists: TruncationList[],
  totalCharacters: number,
  keptCharacters: number,
  hint: string
): string {
  const entry: Record<string, unknown> = {
    truncated: true,
    total_characters: totalCharacters,
    returned_characters: keptCharacters,
    note: truncationNote(totalCharacters, keptCharacters, hint)
  }
  if (lists.length > 0) {
    entry.omitted_items = lists
  }

  if (Array.isArray(value)) {
    return JSON.stringify({ items: value, _truncation: entry })
  }
  const key = '_truncation' in value ? '_response_truncation' : '_truncation'
  return JSON.stringify({ ...value, [key]: entry })
}

/** Plain text (or a parsed scalar): keep a prefix and name the true size. */
function boundPlainText(text: string, budget: ResponseBudget, hint: string): BoundedPayload {
  const totalCharacters = text.length
  if (budget.chars === UNBOUNDED || totalCharacters <= budget.chars) {
    return { text, truncated: false, totalCharacters }
  }
  const kept = text.slice(0, budget.chars)
  return {
    text: `${kept}\n\n${truncationNote(totalCharacters, kept.length, hint)}`,
    truncated: true,
    totalCharacters
  }
}

/**
 * Bound one response text. A payload already inside both budgets is returned
 * byte-for-byte (formatting included); only a payload that has to be cut is
 * re-serialized, compactly, so the emitted size and the accounting agree.
 */
export function boundResponseText(text: string, budget: ResponseBudget, hint: string): BoundedPayload {
  const totalCharacters = text.length
  if (budget.chars === UNBOUNDED && budget.items === UNBOUNDED) {
    return { text, truncated: false, totalCharacters }
  }

  const parsed = tryParseJson(text)
  if (!parsed) return boundPlainText(text, budget, hint)

  // Item caps first: they are semantic (a list of items) and cheap. Strings are
  // only cut when the item-capped payload still exceeds the character budget.
  const itemCaps =
    budget.items === UNBOUNDED ? [UNBOUNDED, 1, 0] : [budget.items, Math.max(1, Math.floor(budget.items / 2)), 1, 0]
  const stringCaps = [UNBOUNDED, 4_000, 1_000, 256, 64]

  // The tightest caps always run, so there is always a payload to carry when
  // nothing fits: a cursor can be longer than the whole budget.
  let tightest: ShrinkResult = shrink(parsed.value, { items: 0, stringChars: 64 })
  for (const itemCap of itemCaps) {
    for (const stringCap of stringCaps) {
      const shrunk = shrink(parsed.value, { items: itemCap, stringChars: stringCap })
      const untouched = shrunk.lists.length === 0 && stringCap === UNBOUNDED
      if (untouched) {
        // Nothing to cut at the configured item budget: keep the caller's
        // formatting unless the character budget itself is exceeded.
        if (totalCharacters <= budget.chars) return { text, truncated: false, totalCharacters }
        continue
      }
      tightest = shrunk
      const kept = JSON.stringify(shrunk.value) ?? ''
      const candidate = withTruncation(shrunk.value, shrunk.lists, totalCharacters, kept.length, hint)
      if (candidate.length <= budget.chars) {
        return { text: candidate, truncated: true, totalCharacters }
      }
    }
  }

  // Last resort for a JSON payload: nothing may be cut any further (a cursor
  // alone can exceed the budget), so keep whole root entries -- cursors first --
  // and the marker. A cursor is never dropped, even past the requested budget:
  // losing it strands the caller on a page they can no longer reach.
  const carried = carryRoot(tightest.value, tightest.lists, totalCharacters, hint, budget.chars)
  if (carried) return { text: carried, truncated: true, totalCharacters }
  return boundPlainText(text, budget, hint)
}

/**
 * Greedy root-level carry: keep the cursor entries first, then as many other
 * entries as fit beside the marker. Always emits valid JSON.
 */
function carryRoot(
  value: Record<string, unknown> | unknown[],
  lists: TruncationList[],
  totalCharacters: number,
  hint: string,
  budgetChars: number
): string | undefined {
  const entries: Array<[string, unknown]> = Array.isArray(value) ? [['items', value]] : Object.entries(value)
  if (entries.length === 0) return undefined

  const ordered = [...entries.filter(([key]) => CURSOR_KEYS[key]), ...entries.filter(([key]) => !CURSOR_KEYS[key])]
  const carried: Record<string, unknown> = {}
  for (const [key, entry] of ordered) {
    const trial = { ...carried, [key]: entry }
    const text = withTruncation(trial, lists, totalCharacters, JSON.stringify(trial).length, hint)
    if (text.length <= budgetChars || CURSOR_KEYS[key]) carried[key] = entry
  }

  const kept = JSON.stringify(carried) ?? ''
  return withTruncation(carried, lists, totalCharacters, kept.length, hint)
}

/**
 * Bound every text part of an MCP tool result. `isError` results pass through:
 * an error message is diagnostic, not a listing, and cutting it would hide
 * the reason a call failed.
 */
export function boundToolResult(result: CallToolResult, budget: ResponseBudget, hint: string): CallToolResult {
  if (result.isError) return result

  let truncated = false
  const content = result.content.map((item) => {
    if (item.type !== 'text') return item
    const bounded = boundResponseText(item.text, budget, hint)
    if (!bounded.truncated) return item
    truncated = true
    return { ...item, text: bounded.text }
  })

  return truncated ? { ...result, content } : result
}

/**
 * Character budgets for spreadsheet reads.
 *
 * `getText` concatenates every cell of every tab and `getRange` serializes
 * every cell of the requested range, so both can return megabytes from one
 * call. They are bounded by default: 20,000 characters keeps a single read
 * small while still covering ordinary sheets whole. A caller can raise the
 * budget to 100,000, or pass `full: true` when the whole payload is the
 * actual goal.
 */
export const DEFAULT_SHEETS_TEXT_LIMIT = 20_000
export const MAX_SHEETS_TEXT_LIMIT = 100_000
export const FULL_TEXT_LIMIT = Number.POSITIVE_INFINITY

export interface BoundedText {
  text: string
  truncated: boolean
  totalCharacters: number
  returnedCharacters: number
}

/** The marker every bounded read ends with: true size plus the escape hatch. */
export function truncationNote(totalCharacters: number, keptCharacters: number, hint: string): string {
  return `[Content truncated: showing ${keptCharacters} of ${totalCharacters} characters (${totalCharacters - keptCharacters} omitted). ${hint}]`
}

/**
 * Validate `max_chars`. `full: true` removes the bound; anything else missing
 * falls back to the default budget.
 */
export function resolveTextLimit(maxChars: unknown, full: unknown): number {
  if (full === true) {
    return FULL_TEXT_LIMIT
  }
  if (maxChars === undefined) {
    return DEFAULT_SHEETS_TEXT_LIMIT
  }
  if (
    typeof maxChars !== 'number' ||
    !Number.isInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > MAX_SHEETS_TEXT_LIMIT
  ) {
    throw new Error(`max_chars must be an integer between 1 and ${MAX_SHEETS_TEXT_LIMIT}.`)
  }
  return maxChars
}

/** Bound plain text (text/csv formats) to the character budget. */
export function boundText(text: string, limit: number, hint: string): BoundedText {
  const totalCharacters = text.length
  if (totalCharacters <= limit) {
    return { text, truncated: false, totalCharacters, returnedCharacters: totalCharacters }
  }

  return {
    text: `${text.slice(0, limit)}\n\n${truncationNote(totalCharacters, limit, hint)}`,
    truncated: true,
    totalCharacters,
    returnedCharacters: limit
  }
}

export interface BoundedJsonText extends BoundedText {
  returnedRows: number
  totalRows: number
}

/**
 * Bound JSON sheet data (json format) without emitting invalid JSON: rows are
 * kept in order until the budget is reached and a `_truncation` entry names
 * the true size. A truncated payload is compact so the size accounting and the
 * emitted text agree.
 */
export function boundJsonRows(
  data: Record<string, unknown[][]>,
  limit: number,
  hint: string
): BoundedJsonText {
  const fullText = JSON.stringify(data, null, 2)
  const totalRows = Object.values(data).reduce((sum, rows) => sum + rows.length, 0)

  if (fullText.length <= limit) {
    return {
      text: fullText,
      truncated: false,
      totalCharacters: fullText.length,
      returnedCharacters: fullText.length,
      returnedRows: totalRows,
      totalRows
    }
  }

  // Reserve room for the `_truncation` entry so the emitted payload stays
  // inside the budget that the marker reports.
  const reserved = 512
  const budget = Math.max(limit - reserved, 0)
  const kept: Record<string, unknown[][]> = {}
  let used = 0
  let returnedRows = 0
  let truncatedMidSheet = false

  for (const [sheetName, rows] of Object.entries(data)) {
    const keptRows: unknown[][] = []
    kept[sheetName] = keptRows
    used += JSON.stringify(sheetName).length + 4
    for (const row of rows) {
      const rowText = JSON.stringify(row)
      if (used + rowText.length > budget) {
        truncatedMidSheet = true
        break
      }
      keptRows.push(row)
      returnedRows += 1
      used += rowText.length + 2
    }
    if (truncatedMidSheet) break
  }

  const keptText = JSON.stringify(kept)
  const text = JSON.stringify({
    ...kept,
    _truncation: {
      truncated: true,
      total_characters: fullText.length,
      returned_characters: keptText.length,
      returned_rows: returnedRows,
      total_rows: totalRows,
      note: truncationNote(fullText.length, keptText.length, hint)
    }
  })

  return {
    text,
    truncated: true,
    totalCharacters: fullText.length,
    returnedCharacters: keptText.length,
    returnedRows,
    totalRows
  }
}

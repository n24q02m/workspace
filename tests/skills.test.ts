/**
 * Plugin skill assets: `skills/<name>/SKILL.md` is the whole discovery contract.
 *
 * The host does not import these skills -- it scans that directory one level
 * deep, reads each SKILL.md's YAML frontmatter, and drops any entry whose name
 * is missing, malformed, or disagrees with its folder. Nothing in the MCP server
 * loads them either (its only file-backed resources are the tool docs under
 * `src/docs`), so there is no in-process seam to call: this test walks the same
 * filesystem path the loader walks and fails when a shipped skill would be
 * dropped or silently ignored.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILLS_DIR = resolve(__dirname, '..', 'skills')
const EXPECTED_SKILLS = ['calendar-agenda', 'drive-audit']
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseFrontmatter(text: string): Record<string, string> {
  // The loader only reads a `---` block at the top of the file, closed by a
  // second `---`; anything else makes the skill unreadable.
  expect(text.startsWith('---')).toBe(true)
  const end = text.indexOf('\n---', 3)
  expect(end).toBeGreaterThan(0)
  const fields: Record<string, string> = {}
  for (const line of text.slice(3, end).split('\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
    }
  }
  return fields
}

describe('packaged skills', () => {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })

  it('discovers exactly the packaged skills and nothing stray', () => {
    expect(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    ).toEqual(EXPECTED_SKILLS)
    expect(entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name)).toEqual([])
  })

  for (const skill of EXPECTED_SKILLS) {
    it(`parses ${skill}'s frontmatter so the loader keeps it`, () => {
      const fields = parseFrontmatter(readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8'))
      expect(fields.name).toBe(skill)
      expect(fields.name).toMatch(SKILL_NAME_PATTERN)
      expect(fields.description?.length ?? 0).toBeGreaterThan(0)
    })
  }
})

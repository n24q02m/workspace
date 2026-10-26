// Shim (ours) for upstream utils/paths — decoupled from gemini-cli.
// Upstream walked the FS for a `gemini-extension.json` marker (thrown if
// missing) and defined its OWN encrypted-token paths; we authenticate via
// hull PerPluginStore, so those are unused and dropped here (YAGNI).
// PROJECT_ROOT is only a base for the optional debug log file (see logger.ts).
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd() // fallback; never throws
}

export const PROJECT_ROOT = findPackageRoot()

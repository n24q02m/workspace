/**
 * Docs Mega Tool
 * All Google Docs operations in one unified interface, dispatched by `action`
 * to the vendored DocsService via the generic domain factory.
 */

import { DocsService } from '../../vendored/services/DocsService.js'
import { DOCS_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

// Action name = DocsService method name (verbatim).
export const DOCS_ACTIONS = ['getText', 'create', 'writeText', 'getSuggestions', 'replaceText', 'formatText'] as const

export const docs = makeDomainRun(DocsService, DOCS_ACTIONS, { bounds: DOCS_BOUNDS })

/**
 * Forms Mega Tool
 * All Google Forms operations in one unified interface, dispatched by `action`
 * to FormsService via the generic domain factory. FormsService is ours
 * (src/services/, not src/vendored/) because upstream has no Forms coverage.
 */

import { FormsService } from '../../services/FormsService.js'
import { FORMS_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

// Action name = FormsService method name (verbatim).
export const FORMS_ACTIONS = ['create', 'get', 'batchUpdate', 'listResponses', 'getResponse'] as const

export const forms = makeDomainRun(FormsService, FORMS_ACTIONS, {
  pagination: { listResponses: 'pageSize' },
  bounds: FORMS_BOUNDS
})

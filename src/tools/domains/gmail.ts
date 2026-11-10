import { GmailService } from '../../vendored/services/GmailService.js'
import { GMAIL_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

export const GMAIL_ACTIONS = [
  'search',
  'get',
  'downloadAttachment',
  'modify',
  'batchModify',
  'modifyThread',
  'send',
  'createDraft',
  'sendDraft',
  'listLabels',
  'createLabel'
] as const
export const gmail = makeDomainRun(GmailService, GMAIL_ACTIONS, {
  pagination: { search: 'maxResults' },
  bounds: GMAIL_BOUNDS
})

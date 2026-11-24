import { GmailService } from '../../vendored/services/GmailService.js'
import {
  downloadGmailAttachmentInline,
  runWithOptionalAccount,
  shouldUseInlineDownload
} from '../helpers/inline-download.js'
import { GMAIL_BOUNDS } from './bounds.js'
import { type DomainRunInput, makeDomainRun } from './factory.js'

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

const runGmailBase = makeDomainRun(GmailService, GMAIL_ACTIONS, {
  pagination: { search: 'maxResults' },
  bounds: GMAIL_BOUNDS
})

export async function gmail(input: DomainRunInput) {
  if (input.action === 'downloadAttachment' && shouldUseInlineDownload(input)) {
    return runWithOptionalAccount(input.account, () => downloadGmailAttachmentInline(input))
  }
  return runGmailBase(input)
}

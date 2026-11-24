import { DriveService } from '../../vendored/services/DriveService.js'
import { downloadDriveFileInline, runWithOptionalAccount, shouldUseInlineDownload } from '../helpers/inline-download.js'
import { DRIVE_BOUNDS } from './bounds.js'
import { type DomainRunInput, makeDomainRun } from './factory.js'

export const DRIVE_ACTIONS = [
  'findFolder',
  'createFolder',
  'search',
  'trashFile',
  'renameFile',
  'getComments',
  'moveFile',
  'downloadFile'
] as const

const runDriveBase = makeDomainRun(DriveService, DRIVE_ACTIONS, {
  pagination: { search: 'pageSize', getComments: 'pageSize' },
  bounds: DRIVE_BOUNDS
})

export async function drive(input: DomainRunInput) {
  if (input.action === 'downloadFile' && shouldUseInlineDownload(input)) {
    return runWithOptionalAccount(input.account, () => downloadDriveFileInline(input))
  }
  return runDriveBase(input)
}

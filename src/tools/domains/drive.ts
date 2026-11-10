import { DriveService } from '../../vendored/services/DriveService.js'
import { DRIVE_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

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
export const drive = makeDomainRun(DriveService, DRIVE_ACTIONS, {
  pagination: { search: 'pageSize', getComments: 'pageSize' },
  bounds: DRIVE_BOUNDS
})

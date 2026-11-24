import { SlidesService } from '../../vendored/services/SlidesService.js'
import {
  downloadSlidesImagesInline,
  downloadSlideThumbnailInline,
  runWithOptionalAccount,
  shouldUseInlineDownload
} from '../helpers/inline-download.js'
import { SLIDES_BOUNDS } from './bounds.js'
import { type DomainRunInput, makeDomainRun } from './factory.js'

export const SLIDES_ACTIONS = [
  'getText',
  'getMetadata',
  'getImages',
  'create',
  'addSlide',
  'deleteSlide',
  'duplicateSlide',
  'reorderSlides',
  'getSpeakerNotes',
  'updateSpeakerNotes',
  'replaceAllText',
  'insertText',
  'deleteText',
  'addShape',
  'addImage',
  'addTable',
  'updateTextStyle',
  'updateShapeProperties',
  'getSlideThumbnail'
] as const

const runSlidesBase = makeDomainRun(SlidesService, SLIDES_ACTIONS, { bounds: SLIDES_BOUNDS })

export async function slides(input: DomainRunInput) {
  if (input.action === 'getImages' && shouldUseInlineDownload(input)) {
    return runWithOptionalAccount(input.account, () => downloadSlidesImagesInline(input))
  }
  if (input.action === 'getSlideThumbnail' && shouldUseInlineDownload(input)) {
    return runWithOptionalAccount(input.account, () => downloadSlideThumbnailInline(input))
  }
  return runSlidesBase(input)
}

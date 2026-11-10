import { SlidesService } from '../../vendored/services/SlidesService.js'
import { SLIDES_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

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
export const slides = makeDomainRun(SlidesService, SLIDES_ACTIONS, { bounds: SLIDES_BOUNDS })

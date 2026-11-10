import { PeopleService } from '../../vendored/services/PeopleService.js'
import { PEOPLE_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

export const PEOPLE_ACTIONS = ['getUserProfile', 'getMe', 'getUserRelations'] as const
export const people = makeDomainRun(PeopleService, PEOPLE_ACTIONS, { bounds: PEOPLE_BOUNDS })

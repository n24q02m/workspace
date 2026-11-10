import { ChatService } from '../../vendored/services/ChatService.js'
import { CHAT_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

export const CHAT_ACTIONS = [
  'listSpaces',
  'sendMessage',
  'findSpaceByName',
  'getMessages',
  'sendDm',
  'findDmByEmail',
  'listThreads',
  'setUpSpace'
] as const
export const chat = makeDomainRun(ChatService, CHAT_ACTIONS, {
  pagination: { listSpaces: 'pageSize', getMessages: 'pageSize', listThreads: 'pageSize' },
  bounds: CHAT_BOUNDS
})

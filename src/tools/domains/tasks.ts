import { TasksService } from '../../vendored/services/TasksService.js'
import { TASKS_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

export const TASKS_ACTIONS = [
  'listTaskLists',
  'listTasks',
  'createTask',
  'updateTask',
  'completeTask',
  'deleteTask'
] as const
export const tasks = makeDomainRun(TasksService, TASKS_ACTIONS, {
  pagination: { listTaskLists: 'maxResults', listTasks: 'maxResults' },
  bounds: TASKS_BOUNDS
})

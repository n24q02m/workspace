/**
 * Single source of truth for N+2 domain tools. Each DomainDef fully
 * describes one domain (docs; Task 7b appends 9 more) -- registry.ts derives
 * TOOLS, RESOURCES, the help topic allowlist, and the CallTool dispatch map
 * from this one list instead of maintaining them as separate hand-synced
 * arrays. Adding a domain = pushing one DomainDef here.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CALENDAR_ACTIONS, calendar } from './calendar.js'
import { CHAT_ACTIONS, chat } from './chat.js'
import { DOCS_ACTIONS, docs } from './docs.js'
import { DRIVE_ACTIONS, drive } from './drive.js'
import type { DomainRunInput } from './factory.js'
import { FORMS_ACTIONS, forms } from './forms.js'
import { GMAIL_ACTIONS, gmail } from './gmail.js'
import { PEOPLE_ACTIONS, people } from './people.js'
import { SHEETS_ACTIONS, sheets } from './sheets.js'
import { SLIDES_ACTIONS, slides } from './slides.js'
import { TASKS_ACTIONS, tasks } from './tasks.js'
import { TIME_ACTIONS, time } from './time.js'

export interface DomainDef {
  name: string // tool name, e.g. 'docs'
  description: string // tool description (actions summary)
  actions: readonly string[] // = the vendored service method names
  inputProps: Record<string, unknown> // JSON-schema properties beyond action+account
  localOnlyActions?: readonly string[] // unavailable to remote HTTP clients
  localOnlyInputProps?: readonly string[] // omitted with their local-only actions
  run: (input: DomainRunInput) => Promise<CallToolResult>
}

export const DOMAINS: DomainDef[] = [
  {
    name: 'docs',
    description:
      'Google Docs operations.\n\nActions (required params -> optional):\n- getText (documentId -> tabId, limit, preview)\n- create (title -> content)\n- writeText (documentId, text -> position, tabId)\n- getSuggestions (documentId)\n- replaceText (documentId, findText, replaceText -> tabId)\n- formatText (documentId, formats -> tabId)\n\ngetText defaults to 20,000 characters, accepts limit 1-100,000, and marks truncated output explicitly. preview defaults to 2,000 characters unless limit is provided. getSuggestions is bounded separately: 20,000 characters and 100 suggestions by default (max_chars 1-100,000, full:true for every entry). These bounds limit response size without changing document authorization.\n\naccount = email of the Google account to use (default: primary).',
    actions: DOCS_ACTIONS,
    inputProps: {
      documentId: { type: 'string', description: 'Google Doc ID or URL' },
      title: { type: 'string', description: 'Document title (for create)' },
      content: { type: 'string', description: 'Initial document content (for create)' },
      text: { type: 'string', description: 'Text to insert (for writeText)' },
      position: {
        type: 'string',
        description: 'Insert position for writeText: "beginning", "end" (default), or a positive integer index'
      },
      tabId: { type: 'string', description: 'Tab ID to target (optional, for multi-tab documents)' },
      limit: { type: 'number', description: 'Maximum Docs text characters for getText (1-100000; default 20000)' },
      preview: { type: 'boolean', description: 'Use a 2000-character getText preview unless limit is provided' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by getSuggestions (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return every getSuggestions entry, bypassing the default 20000-character and 100-item bounds'
      },
      replaceText: { type: 'string', description: 'Replacement text (for replaceText)' },
      formats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            startIndex: { type: 'number' },
            endIndex: { type: 'number' },
            style: { type: 'string' },
            url: { type: 'string' }
          },
          required: ['startIndex', 'endIndex', 'style']
        },
        description: 'Formatting operations to apply (for formatText)'
      }
    },
    run: docs
  },
  {
    name: 'time',
    description:
      'Local date/time/timezone helpers (no Google account needed).\n\nActions:\n- getCurrentDate\n- getCurrentTime\n- getTimeZone',
    actions: TIME_ACTIONS,
    inputProps: {},
    run: time
  },
  {
    name: 'drive',
    description:
      'Drive operations. See the action enum for operations available in this transport.\n\nsearch, getComments and findFolder are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload). search and getComments page with pageSize and pageToken; findFolder caps at 50 name matches. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: DRIVE_ACTIONS,
    localOnlyActions: ['downloadFile'],
    localOnlyInputProps: ['localPath'],
    inputProps: {
      fileId: { type: 'string' },
      folderId: { type: 'string' },
      folderName: { type: 'string' },
      query: { type: 'string' },
      name: { type: 'string' },
      newName: { type: 'string' },
      parentId: { type: 'string' },
      destinationFolderId: { type: 'string' },
      pageSize: { type: 'number', description: 'Maximum search results per page (default 10)' },
      pageToken: { type: 'string', description: 'Continuation token from a previous search page' },
      corpus: { type: 'string', enum: ['user', 'domain'], description: 'Drive search corpus' },
      unreadOnly: { type: 'boolean', description: 'Restrict search to unread files where supported' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      localPath: {
        type: 'string',
        description:
          'Local destination path for downloadFile. This action is available only over local stdio transport.'
      }
    },
    run: drive
  },
  {
    name: 'calendar',
    description:
      'Calendar operations. Actions: ' +
      CALENDAR_ACTIONS.join(', ') +
      '.\n\nlistEvents, getEvent, listCalendars and findFreeTime are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload); listEvents pages with maxResults and pageToken and always returns its nextPageToken. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: CALENDAR_ACTIONS,
    inputProps: {
      calendarId: { type: 'string' },
      eventId: { type: 'string' },
      summary: { type: 'string' },
      description: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      attendees: { type: 'array' },
      maxResults: { type: 'number', description: 'Maximum events per page (for listEvents; default 20)' },
      pageToken: { type: 'string', description: 'Continuation token from a previous listEvents page' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      }
    },
    run: calendar
  },
  {
    name: 'chat',
    description:
      'Chat operations. Actions: ' +
      CHAT_ACTIONS.join(', ') +
      '.\n\nlistSpaces, getMessages, listThreads and findSpaceByName are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload). All three listings page with pageSize and pageToken and always return their nextPageToken; findSpaceByName caps at 50 matches. account = email of the Google account to use (default: primary).',
    actions: CHAT_ACTIONS,
    inputProps: {
      spaceId: { type: 'string' },
      displayName: { type: 'string' },
      email: { type: 'string' },
      text: { type: 'string' },
      threadId: { type: 'string' },
      pageSize: { type: 'number', description: 'Maximum spaces, messages, or threads per page' },
      pageToken: { type: 'string', description: 'Continuation token from a previous page' },
      unreadOnly: { type: 'boolean', description: 'Return only unread messages' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      orderBy: { type: 'string', description: 'Message ordering expression' },
      filter: { type: 'string', description: 'Chat message filter' }
    },
    run: chat
  },
  {
    name: 'gmail',
    description:
      'Gmail operations. Actions: ' +
      GMAIL_ACTIONS.join(', ') +
      '.\n\nget, modify, modifyThread, search and listLabels are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload), so a long message body is cut with an explicit marker instead of flooding the response. search pages with maxResults and pageToken. account = email of the Google account to use (default: primary).',
    actions: GMAIL_ACTIONS,
    inputProps: {
      query: { type: 'string' },
      messageId: { type: 'string' },
      threadId: { type: 'string' },
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      draftId: { type: 'string' },
      labelIds: { type: 'array' },
      maxResults: { type: 'number', description: 'Maximum messages returned per page (bounded by Gmail)' },
      pageToken: { type: 'string', description: 'Continuation token from a previous search page' },
      includeSpamTrash: { type: 'boolean', description: 'Include spam and trash in search results' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      format: { type: 'string', enum: ['minimal', 'full', 'raw', 'metadata'], description: 'Message payload detail' }
    },
    run: gmail
  },
  {
    name: 'slides',
    description:
      'Slides operations. Actions: ' +
      SLIDES_ACTIONS.join(', ') +
      '.\n\ngetText, getMetadata, getImages and getSpeakerNotes are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload) and at most 100 slide or image entries. getSlideThumbnail returns one base64 image and is never cut. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: SLIDES_ACTIONS,
    inputProps: {
      presentationId: { type: 'string' },
      title: { type: 'string' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      slideId: { type: 'string' },
      text: { type: 'string' }
    },
    run: slides
  },
  {
    name: 'sheets',
    description:
      'Sheets operations. Actions: ' +
      SHEETS_ACTIONS.join(', ') +
      '.\n\ngetText and getRange return at most 20,000 characters by default (max_chars 1-100,000) and mark truncated output explicitly with the true size and omitted count; pass full:true for the complete payload. account = email of the Google account to use (default: primary).',
    actions: SHEETS_ACTIONS,
    inputProps: {
      spreadsheetId: { type: 'string' },
      range: { type: 'string' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by getText/getRange (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete getText/getRange payload, bypassing the default 20000-character bound'
      }
    },
    run: sheets
  },
  {
    name: 'tasks',
    description:
      'Tasks operations. Actions: ' +
      TASKS_ACTIONS.join(', ') +
      '.\n\nlistTasks and listTaskLists are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload) and page with maxResults and pageToken. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: TASKS_ACTIONS,
    inputProps: {
      taskListId: { type: 'string' },
      taskId: { type: 'string' },
      title: { type: 'string' },
      notes: { type: 'string' },
      due: { type: 'string' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      maxResults: { type: 'number', description: 'Maximum task lists or tasks per page' },
      pageToken: { type: 'string', description: 'Continuation token from a previous page' }
    },
    run: tasks
  },
  {
    name: 'people',
    description:
      'People operations. Actions: ' +
      PEOPLE_ACTIONS.join(', ') +
      '.\n\nAll three actions are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload), and getUserRelations keeps at most 50 relations. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: PEOPLE_ACTIONS,
    inputProps: {
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      resourceName: { type: 'string' }
    },
    run: people
  },
  {
    name: 'forms',
    description:
      'Google Forms operations.\n\nActions (required params -> optional):\n- create (title -> documentTitle)\n- get (formId)\n- batchUpdate (formId, requests)\n- listResponses (formId -> pageSize, pageToken, filter)\n- getResponse (formId, responseId)\n\nQuestions are added with batchUpdate, not create. Responses are read-only (the Forms API cannot write one), and listing or deleting forms goes through the drive tool.\n\nget, getResponse and listResponses are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload); listResponses pages with pageSize and pageToken.\n\naccount = email of the Google account to use (default: primary).',
    actions: FORMS_ACTIONS,
    inputProps: {
      formId: {
        type: 'string',
        description: 'Form ID, or the editor URL https://docs.google.com/forms/d/<formId>/edit'
      },
      title: { type: 'string', description: 'Form title shown to respondents (for create)' },
      documentTitle: {
        type: 'string',
        description: 'Drive file name, when it should differ from the title (for create)'
      },
      requests: {
        type: 'array',
        items: { type: 'object' },
        description: 'Forms API batchUpdate requests, e.g. [{"createItem": {...}}] (for batchUpdate)'
      },
      responseId: { type: 'string', description: 'Response ID (for getResponse)' },
      pageSize: { type: 'number', description: 'Maximum responses to return (for listResponses)' },
      pageToken: { type: 'string', description: 'Page token from a previous listResponses call' },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      filter: {
        type: 'string',
        description: 'Response filter, e.g. timestamp > 2026-01-01T00:00:00Z (for listResponses)'
      }
    },
    run: forms
  }
]

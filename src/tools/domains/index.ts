/**
 * Single source of truth for N+2 domain tools. Each DomainDef fully
 * describes one domain (docs; Task 7b appends 9 more) -- registry.ts derives
 * TOOLS, RESOURCES, the help topic allowlist, and the CallTool dispatch map
 * from this one list instead of maintaining them as separate hand-synced
 * arrays. Adding a domain = pushing one DomainDef here.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { FormsService } from '../../services/FormsService.js'
import type { CalendarService } from '../../vendored/services/CalendarService.js'
import type { ChatService } from '../../vendored/services/ChatService.js'
import type { DocsService } from '../../vendored/services/DocsService.js'
import type { DriveService } from '../../vendored/services/DriveService.js'
import type { GmailService } from '../../vendored/services/GmailService.js'
import type { PeopleService } from '../../vendored/services/PeopleService.js'
import type { SheetsService } from '../../vendored/services/SheetsService.js'
import { PREDEFINED_LAYOUTS, type SlidesService } from '../../vendored/services/SlidesService.js'
import type { TasksService } from '../../vendored/services/TasksService.js'
import type { TimeService } from '../../vendored/services/TimeService.js'
import { CALENDAR_ACTIONS, calendar } from './calendar.js'
import { CHAT_ACTIONS, chat } from './chat.js'
import { DOCS_ACTIONS, docs } from './docs.js'
import { DRIVE_ACTIONS, drive } from './drive.js'
import type { DomainRunInput } from './factory.js'
import { FORMS_ACTIONS, forms } from './forms.js'
import { GMAIL_ACTIONS, gmail } from './gmail.js'
import { PEOPLE_ACTIONS, people } from './people.js'
import { serviceInputProps } from './service-input-props.js'
import { SHEETS_ACTIONS, sheets } from './sheets.js'
import { SLIDES_ACTIONS, slides } from './slides.js'
import { TASKS_ACTIONS, tasks } from './tasks.js'
import { TIME_ACTIONS, time } from './time.js'

export interface DomainDef {
  name: string // tool name, e.g. 'docs'
  description: string // tool description (actions summary)
  actions: readonly string[] // = the vendored service method names
  inputProps: Record<string, unknown> // JSON-schema properties beyond action+account
  localOnlyInputProps?: readonly string[] // omitted when filesystem access is disabled
  localOnlyDescription?: string // appended to description for local stdio clients only
  run: (input: DomainRunInput) => Promise<CallToolResult>
}

export const DOMAINS: DomainDef[] = [
  {
    name: 'docs',
    description:
      'Google Docs operations.\n\nActions (required params -> optional):\n- getText (documentId -> tabId, limit, preview)\n- create (title -> content)\n- writeText (documentId, text -> position, tabId)\n- getSuggestions (documentId)\n- replaceText (documentId, findText, replaceText -> tabId)\n- formatText (documentId, formats -> tabId)\n\ngetText defaults to 20,000 characters, accepts limit 1-100,000, and marks truncated output explicitly. preview defaults to 2,000 characters unless limit is provided. getSuggestions is bounded separately: 20,000 characters and 100 suggestions by default (max_chars 1-100,000, full:true for every entry). These bounds limit response size without changing document authorization.\n\naccount = email of the Google account to use (default: primary).',
    actions: DOCS_ACTIONS,
    inputProps: serviceInputProps<DocsService, typeof DOCS_ACTIONS>()({
      documentId: { type: 'string', description: 'Google Doc ID or URL' },
      title: { type: 'string', description: 'Document title (for create)' },
      content: { type: 'string', description: 'Initial document content (for create)' },
      text: { type: 'string', description: 'Text to insert (for writeText)' },
      position: {
        type: 'string',
        description: 'Insert position for writeText: "beginning", "end" (default), or a positive integer index'
      },
      tabId: { type: 'string', description: 'Tab ID to target (optional, for multi-tab documents)' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum Docs text characters for getText (1-100000; default 20000)'
      },
      preview: { type: 'boolean', description: 'Use a 2000-character getText preview unless limit is provided' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by getSuggestions (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return every getSuggestions entry, bypassing the default 20000-character and 100-item bounds'
      },
      findText: { type: 'string', description: 'Text to find, must not be empty (for replaceText)' },
      replaceText: { type: 'string', description: 'Replacement text (for replaceText)' },
      formats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            startIndex: { type: 'number' },
            endIndex: { type: 'number' },
            style: {
              type: 'string',
              enum: [
                'heading1',
                'heading2',
                'heading3',
                'heading4',
                'heading5',
                'heading6',
                'normalText',
                'bold',
                'italic',
                'underline',
                'strikethrough',
                'code',
                'link'
              ],
              description: 'Heading level, text style, code font, or link (link needs url)'
            },
            url: { type: 'string' }
          },
          required: ['startIndex', 'endIndex', 'style']
        },
        description: 'Formatting operations to apply (for formatText)'
      }
    }),
    run: docs
  },
  {
    name: 'time',
    description:
      'Local date/time/timezone helpers (no Google account needed).\n\nActions:\n- getCurrentDate\n- getCurrentTime\n- getTimeZone',
    actions: TIME_ACTIONS,
    inputProps: serviceInputProps<TimeService, typeof TIME_ACTIONS>()({}),
    run: time
  },
  {
    name: 'drive',
    description:
      'Drive operations. See the action enum for operations available in this transport.\n\nsearch, getComments and findFolder are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload). search and getComments page with pageSize and pageToken; findFolder caps at 50 name matches. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: DRIVE_ACTIONS,
    localOnlyInputProps: ['localPath'],
    inputProps: serviceInputProps<DriveService, typeof DRIVE_ACTIONS>()({
      fileId: { type: 'string' },
      folderId: { type: 'string' },
      folderName: { type: 'string' },
      query: { type: 'string' },
      name: { type: 'string' },
      newName: { type: 'string' },
      parentId: { type: 'string' },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum files or comments per page (for search, getComments; 1-100, default 20)'
      },
      pageToken: { type: 'string', description: 'Continuation token from a previous search page' },
      corpus: { type: 'string', enum: ['user', 'domain'], description: 'Drive search corpus' },
      unreadOnly: { type: 'boolean', description: 'Restrict search to unread files where supported' },
      sharedWithMe: { type: 'boolean', description: 'Restrict search to files shared with the user' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      localPath: {
        type: 'string',
        description:
          'Destination file for downloadFile, inside the server install directory; a relative path resolves against that directory. Available only over local stdio transport.'
      },
      returnBase64: {
        type: 'boolean',
        description:
          'Return base64-encoded file bytes inline for downloadFile (default when no disk destination is provided; bounded by WORKSPACE_MAX_INLINE_BYTES).'
      }
    }),
    run: drive
  },
  {
    name: 'calendar',
    description:
      'Calendar operations. Actions: ' +
      CALENDAR_ACTIONS.join(', ') +
      '.\n\nlistEvents, getEvent, listCalendars and findFreeTime are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload); listEvents pages with maxResults and pageToken and always returns its nextPageToken. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: CALENDAR_ACTIONS,
    inputProps: serviceInputProps<CalendarService, typeof CALENDAR_ACTIONS>()({
      calendarId: { type: 'string' },
      eventId: { type: 'string' },
      summary: { type: 'string' },
      description: { type: 'string' },
      start: {
        type: 'object',
        properties: {
          dateTime: { type: 'string', description: 'Start time of a timed event, e.g. 2026-03-01T09:00:00Z' },
          date: { type: 'string', description: 'Start day of an all-day event, YYYY-MM-DD' }
        },
        description: 'Event start, with exactly one of dateTime or date (for createEvent, updateEvent)'
      },
      end: {
        type: 'object',
        properties: {
          dateTime: { type: 'string', description: 'End time of a timed event, e.g. 2026-03-01T10:00:00Z' },
          date: { type: 'string', description: 'Day after the last day of an all-day event, YYYY-MM-DD' }
        },
        description: 'Event end, with exactly one of dateTime or date (for createEvent, updateEvent)'
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Attendee emails (for createEvent, updateEvent), or the people whose shared free time findFreeTime looks for ("me" is the caller)'
      },
      sendUpdates: {
        type: 'string',
        enum: ['all', 'externalOnly', 'none'],
        description: 'Who receives invitation emails (for createEvent)'
      },
      addGoogleMeet: { type: 'boolean', description: 'Add a Google Meet link (for createEvent, updateEvent)' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            fileUrl: { type: 'string', description: 'Google Drive file URL' },
            title: { type: 'string' },
            mimeType: { type: 'string' }
          },
          required: ['fileUrl']
        },
        description: 'Drive files to attach; replaces any existing attachments (for createEvent, updateEvent)'
      },
      eventType: {
        type: 'string',
        enum: ['default', 'focusTime', 'outOfOffice', 'workingLocation'],
        description: 'Kind of event to create (for createEvent; default "default")'
      },
      focusTimeProperties: {
        type: 'object',
        properties: {
          chatStatus: { type: 'string', enum: ['available', 'doNotDisturb'] },
          autoDeclineMode: {
            type: 'string',
            enum: ['declineNone', 'declineAllConflictingInvitations', 'declineOnlyNewConflictingInvitations']
          },
          declineMessage: { type: 'string' }
        },
        description: 'Settings of a focusTime event (for createEvent)'
      },
      outOfOfficeProperties: {
        type: 'object',
        properties: {
          autoDeclineMode: {
            type: 'string',
            enum: ['declineNone', 'declineAllConflictingInvitations', 'declineOnlyNewConflictingInvitations']
          },
          declineMessage: { type: 'string' }
        },
        description: 'Settings of an outOfOffice event (for createEvent)'
      },
      workingLocationProperties: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['homeOffice', 'officeLocation', 'customLocation'] },
          officeLocation: {
            type: 'object',
            properties: { buildingId: { type: 'string' }, label: { type: 'string' } }
          },
          customLocation: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }
        },
        required: ['type'],
        description: 'Location of a workingLocation event (for createEvent)'
      },
      timeMin: {
        type: 'string',
        description:
          'Window start (for listEvents, findFreeTime): YYYY-MM-DDTHH:mm:ss, optionally three fraction digits, then Z or a +HH:MM/-HH:MM offset, e.g. 2026-03-01T09:00:00Z or 2026-03-01T09:00:00.123+07:00. listEvents defaults to now; findFreeTime requires it.'
      },
      timeMax: {
        type: 'string',
        description:
          'Window end (for listEvents, findFreeTime), in the same format as timeMin, e.g. 2026-03-01T09:00:00Z. listEvents defaults to 30 days from now; findFreeTime requires it.'
      },
      eventTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['default', 'focusTime', 'outOfOffice', 'workingLocation', 'birthday', 'fromGmail']
        },
        description: 'Return only events of these kinds (for listEvents)'
      },
      attendeeResponseStatus: {
        type: 'array',
        items: { type: 'string', enum: ['accepted', 'tentative', 'needsAction', 'declined'] },
        description:
          'Keep events where the caller answered with one of these (for listEvents; default accepted, tentative, needsAction)'
      },
      responseStatus: {
        type: 'string',
        enum: ['accepted', 'declined', 'tentative'],
        description: 'Answer to the invitation (for respondToEvent)'
      },
      sendNotification: {
        type: 'boolean',
        description: 'Send update emails about the answer (for respondToEvent; default true)'
      },
      responseMessage: { type: 'string', description: 'Comment attached to the answer (for respondToEvent)' },
      duration: { type: 'number', description: 'Length of the free slot to find, in minutes (for findFreeTime)' },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum events per page (for listEvents; 1-100, default 20)'
      },
      pageToken: { type: 'string', description: 'Continuation token from a previous listEvents page' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      }
    }),
    run: calendar
  },
  {
    name: 'chat',
    description:
      'Chat operations. Actions: ' +
      CHAT_ACTIONS.join(', ') +
      '.\n\nlistSpaces, getMessages, listThreads and findSpaceByName are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload). All three listings page with pageSize and pageToken and always return their nextPageToken; findSpaceByName caps at 50 matches. account = email of the Google account to use (default: primary).',
    actions: CHAT_ACTIONS,
    inputProps: serviceInputProps<ChatService, typeof CHAT_ACTIONS>()({
      spaceName: {
        type: 'string',
        description: 'Space resource name, e.g. spaces/AAAA (for sendMessage, getMessages, listThreads)'
      },
      displayName: { type: 'string', description: 'Space display name (for findSpaceByName, setUpSpace)' },
      email: { type: 'string', description: 'Email of the other person (for sendDm, findDmByEmail)' },
      message: { type: 'string', description: 'Message text (for sendMessage, sendDm)' },
      threadName: {
        type: 'string',
        description:
          'Thread resource name, e.g. spaces/AAAA/threads/BBBB: the thread to reply in (sendMessage, sendDm) or to read (getMessages)'
      },
      userNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Members of the new space, as users/<user ID or email> (for setUpSpace)'
      },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description:
          'Maximum spaces, messages, or threads per page (for listSpaces, getMessages, listThreads; 1-100, default 20)'
      },
      pageToken: { type: 'string', description: 'Continuation token from a previous page' },
      unreadOnly: { type: 'boolean', description: 'Return only unread messages' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      orderBy: { type: 'string', description: 'Message ordering expression, e.g. "createTime desc" (for getMessages)' }
    }),
    run: chat
  },
  {
    name: 'gmail',
    description:
      'Gmail operations. Actions: ' +
      GMAIL_ACTIONS.join(', ') +
      '.\n\nget, modify, modifyThread, search and listLabels are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload), so a long message body is cut with an explicit marker instead of flooding the response. search pages with maxResults and pageToken. account = email of the Google account to use (default: primary).',
    actions: GMAIL_ACTIONS,
    localOnlyInputProps: ['localPath', 'attachments'],
    localOnlyDescription:
      '\n\nLocal stdio transport only: pass localPath to downloadAttachment to save to an absolute path on this machine (instead of inline base64), and createDraft attaches local files through attachments.',
    inputProps: serviceInputProps<GmailService, typeof GMAIL_ACTIONS>()({
      query: { type: 'string' },
      messageId: { type: 'string' },
      messageIds: { type: 'array', items: { type: 'string' }, description: 'Message IDs to change (for batchModify)' },
      threadId: {
        type: 'string',
        description: 'Thread to change (for modifyThread) or to add the draft to (for createDraft)'
      },
      attachmentId: { type: 'string', description: 'Attachment ID from get (for downloadAttachment)' },
      localPath: {
        type: 'string',
        description:
          'Absolute local file path to save the attachment to (for downloadAttachment). Available only over local stdio transport.'
      },
      returnBase64: {
        type: 'boolean',
        description:
          'Return base64-encoded attachment bytes inline for downloadAttachment (default when no disk destination is provided; bounded by WORKSPACE_MAX_INLINE_BYTES).'
      },
      to: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Recipient email address, or an array of addresses'
      },
      cc: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Cc email address, or an array of addresses'
      },
      bcc: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Bcc email address, or an array of addresses'
      },
      replyTo: { type: 'string', description: 'Reply-To email address' },
      subject: { type: 'string' },
      body: { type: 'string' },
      isHtml: { type: 'boolean', description: 'Treat body as HTML instead of plain text (default false)' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description:
                'Absolute local filesystem path to the file to attach (e.g., "/Users/name/downloads/report.pdf"). Use the downloadAttachment action first to save an email attachment locally before referencing it here.'
            },
            filename: {
              type: 'string',
              description: 'Display name for the attachment in the email. Defaults to the filename portion of filePath.'
            },
            mimeType: {
              type: 'string',
              description:
                'MIME type of the attachment (e.g., "application/pdf"). Inferred from the file extension when omitted; falls back to "application/octet-stream".'
            }
          },
          required: ['filePath']
        },
        description:
          'Local files to attach (for createDraft). Attachments are read from the server filesystem, so they are available only over local stdio transport.'
      },
      draftId: { type: 'string' },
      labelIds: { type: 'array', items: { type: 'string' }, description: 'Restrict search to these label IDs' },
      addLabelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to add (for modify, batchModify, modifyThread)'
      },
      removeLabelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to remove (for modify, batchModify, modifyThread)'
      },
      name: { type: 'string', description: 'Label name (for createLabel)' },
      labelListVisibility: {
        type: 'string',
        enum: ['labelShow', 'labelHide', 'labelShowIfUnread'],
        description: 'Label visibility in the label list (for createLabel; default labelShow)'
      },
      messageListVisibility: {
        type: 'string',
        enum: ['show', 'hide'],
        description: 'Label visibility in the message list (for createLabel; default show)'
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum messages per page (for search; 1-100, default 20)'
      },
      pageToken: { type: 'string', description: 'Continuation token from a previous search page' },
      includeSpamTrash: { type: 'boolean', description: 'Include spam and trash in search results' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      format: {
        type: 'string',
        enum: ['minimal', 'full', 'raw', 'metadata'],
        description: 'Message payload detail (for get; default full)'
      }
    }),
    run: gmail
  },
  {
    name: 'slides',
    description:
      'Slides operations. Actions: ' +
      SLIDES_ACTIONS.join(', ') +
      '.\n\ngetText, getMetadata and getSpeakerNotes are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload) and at most 100 slide entries. Truncated output names its true size and how to fetch the rest. Positions and sizes are in points (PT). account = email of the Google account to use (default: primary).',
    actions: SLIDES_ACTIONS,
    localOnlyInputProps: ['localPath'],
    localOnlyDescription:
      '\n\nLocal stdio transport only: pass localPath to getImages to save every image as a PNG in a directory, or to getSlideThumbnail where getSlideThumbnail saves the thumbnail PNG of the slideObjectId slide to the localPath file and returns its URL, size and saved path, never cut. localPath must be absolute.',
    inputProps: serviceInputProps<SlidesService, typeof SLIDES_ACTIONS>()({
      presentationId: { type: 'string', description: 'Presentation ID or URL (all actions except create)' },
      title: { type: 'string', description: 'Presentation title (for create)' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      localPath: {
        type: 'string',
        description:
          'Absolute local directory to save every image to (for getImages), or absolute local file path to save the thumbnail to (for getSlideThumbnail). Available only over local stdio transport.'
      },
      returnBase64: {
        type: 'boolean',
        description:
          'Return base64-encoded PNG payloads inline for getImages and getSlideThumbnail (default when no disk destination is provided; bounded by WORKSPACE_MAX_INLINE_BYTES).'
      },
      slideObjectId: {
        type: 'string',
        description:
          'Slide object ID (for deleteSlide, duplicateSlide, updateSpeakerNotes, addShape, addImage, addTable)'
      },
      slideObjectIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Slide object IDs to move, listed in their current deck order (for reorderSlides)'
      },
      objectId: {
        type: 'string',
        description:
          'Object ID of the shape or text box to edit (for insertText, deleteText, updateTextStyle, updateShapeProperties), or an optional ID for the new slide or element (for addSlide, addShape, addImage, addTable)'
      },
      insertionIndex: {
        type: 'number',
        description:
          'Zero-based position: where the new slide goes (for addSlide; default end), where the moved slides go (for reorderSlides), or the character index to insert at (for insertText; default 0)'
      },
      layoutId: { type: 'string', description: 'Layout object ID of the new slide (for addSlide)' },
      predefinedLayout: {
        type: 'string',
        enum: [...PREDEFINED_LAYOUTS],
        description: 'Predefined layout of the new slide (for addSlide)'
      },
      notes: { type: 'string', description: 'Speaker notes text (for updateSpeakerNotes)' },
      findText: { type: 'string', description: 'Text to find in every slide (for replaceAllText)' },
      replaceText: { type: 'string', description: 'Replacement text (for replaceAllText)' },
      matchCase: { type: 'boolean', description: 'Match case when finding text (for replaceAllText; default true)' },
      text: { type: 'string', description: 'Text to insert (for insertText)' },
      range: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['ALL', 'FIXED_RANGE', 'FROM_START_INDEX'] },
          startIndex: { type: 'number' },
          endIndex: { type: 'number' }
        },
        required: ['type'],
        description:
          'Text range (for deleteText, updateTextStyle; default {"type": "ALL"}). FIXED_RANGE needs startIndex and endIndex; FROM_START_INDEX needs startIndex.'
      },
      shapeType: { type: 'string', description: 'Slides API shape type, e.g. TEXT_BOX or RECTANGLE (for addShape)' },
      imageUrl: { type: 'string', description: 'Publicly reachable image URL (for addImage)' },
      rows: { type: 'number', description: 'Number of table rows (for addTable)' },
      columns: { type: 'number', description: 'Number of table columns (for addTable)' },
      x: { type: 'number', description: 'Left offset in points (for addShape, addImage, addTable)' },
      y: { type: 'number', description: 'Top offset in points (for addShape, addImage, addTable)' },
      width: { type: 'number', description: 'Width in points (for addShape, addImage, addTable)' },
      height: { type: 'number', description: 'Height in points (for addShape, addImage, addTable)' },
      style: {
        type: 'string',
        description: 'Slides API TextStyle as a JSON object string, e.g. {"bold": true} (for updateTextStyle)'
      },
      shapeProperties: {
        type: 'string',
        description: 'Slides API ShapeProperties as a JSON object string (for updateShapeProperties)'
      },
      fields: {
        type: 'string',
        description: 'Field mask of the properties to change, e.g. "bold" (for updateTextStyle, updateShapeProperties)'
      }
    }),
    run: slides
  },
  {
    name: 'sheets',
    description:
      'Sheets operations. Actions: ' +
      SHEETS_ACTIONS.join(', ') +
      '.\n\ngetText and getRange return at most 20,000 characters by default (max_chars 1-100,000) and mark truncated output explicitly with the true size and omitted count; pass full:true for the complete payload. account = email of the Google account to use (default: primary).',
    actions: SHEETS_ACTIONS,
    inputProps: serviceInputProps<SheetsService, typeof SHEETS_ACTIONS>()({
      spreadsheetId: { type: 'string' },
      range: { type: 'string' },
      title: {
        type: 'string',
        description: 'Spreadsheet title (create) or new tab title (addSheet)'
      },
      sheetTitles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional initial sheet tab titles (create)'
      },
      values: {
        type: 'array',
        items: { type: 'array', items: {} },
        description: '2D array of rows to write or append (updateRange, appendRows)'
      },
      valueInputOption: {
        type: 'string',
        enum: ['RAW', 'USER_ENTERED'],
        description: 'How input values are interpreted (updateRange, appendRows; default USER_ENTERED)'
      },
      insertDataOption: {
        type: 'string',
        enum: ['OVERWRITE', 'INSERT_ROWS'],
        description: 'How appended data is inserted (appendRows; default INSERT_ROWS)'
      },
      format: {
        type: 'string',
        enum: ['text', 'csv', 'json'],
        description: 'Output format of getText (default text)'
      },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by getText/getRange (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete getText/getRange payload, bypassing the default 20000-character bound'
      }
    }),
    run: sheets
  },
  {
    name: 'tasks',
    description:
      'Tasks operations. Actions: ' +
      TASKS_ACTIONS.join(', ') +
      '.\n\nlistTasks and listTaskLists are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload) and page with maxResults and pageToken. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: TASKS_ACTIONS,
    inputProps: serviceInputProps<TasksService, typeof TASKS_ACTIONS>()({
      taskListId: { type: 'string' },
      taskId: { type: 'string' },
      title: { type: 'string' },
      notes: { type: 'string' },
      due: {
        type: 'string',
        description: 'Due date as an RFC3339 timestamp (for createTask, updateTask); Google Tasks keeps only the date'
      },
      status: { type: 'string', enum: ['needsAction', 'completed'], description: 'Task status (for updateTask)' },
      showCompleted: { type: 'boolean', description: 'Include completed tasks (for listTasks)' },
      showDeleted: { type: 'boolean', description: 'Include deleted tasks (for listTasks)' },
      showHidden: { type: 'boolean', description: 'Include hidden tasks (for listTasks)' },
      showAssigned: { type: 'boolean', description: 'Include tasks assigned to the caller (for listTasks)' },
      dueMin: { type: 'string', description: 'Earliest due date, RFC3339 timestamp (for listTasks)' },
      dueMax: { type: 'string', description: 'Latest due date, RFC3339 timestamp (for listTasks)' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum task lists or tasks per page (for listTaskLists, listTasks; 1-100, default 20)'
      },
      pageToken: { type: 'string', description: 'Continuation token from a previous page' }
    }),
    run: tasks
  },
  {
    name: 'people',
    description:
      'People operations. Actions: ' +
      PEOPLE_ACTIONS.join(', ') +
      '.\n\nAll three actions are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload), and getUserRelations keeps at most 50 relations. Truncated output names its true size and how to fetch the rest. account = email of the Google account to use (default: primary).',
    actions: PEOPLE_ACTIONS,
    inputProps: serviceInputProps<PeopleService, typeof PEOPLE_ACTIONS>()({
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
        description: 'Maximum characters returned by a bounded read action (1-100000; default 20000)'
      },
      full: {
        type: 'boolean',
        description: 'Return the complete payload, bypassing the default 20000-character and item bounds'
      },
      userId: {
        type: 'string',
        description:
          'Person ID, with or without the people/ prefix (for getUserProfile; for getUserRelations, defaults to the caller)'
      },
      email: { type: 'string', description: 'Email to look up in the directory (for getUserProfile)' },
      name: { type: 'string', description: 'Name to look up in the directory (for getUserProfile)' },
      relationType: {
        type: 'string',
        description: 'Keep only relations of this type, e.g. manager or spouse (for getUserRelations)'
      }
    }),
    run: people
  },
  {
    name: 'forms',
    description:
      'Google Forms operations.\n\nActions (required params -> optional):\n- create (title -> documentTitle)\n- get (formId)\n- batchUpdate (formId, requests)\n- listResponses (formId -> pageSize, pageToken, filter)\n- getResponse (formId, responseId)\n\nQuestions are added with batchUpdate, not create. Responses are read-only (the Forms API cannot write one), and listing or deleting forms goes through the drive tool.\n\nget, getResponse and listResponses are bounded: 20,000 characters by default (max_chars 1-100,000, full:true for the complete payload); listResponses pages with pageSize and pageToken.\n\naccount = email of the Google account to use (default: primary).',
    actions: FORMS_ACTIONS,
    inputProps: serviceInputProps<FormsService, typeof FORMS_ACTIONS>()({
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
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum responses per page (for listResponses; 1-100, default 20)'
      },
      pageToken: { type: 'string', description: 'Page token from a previous listResponses call' },
      max_chars: {
        type: 'integer',
        minimum: 1,
        maximum: 100000,
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
    }),
    run: forms
  }
]

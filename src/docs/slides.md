# Slides Tool

## Actions
- getText
- getMetadata
- getImages
- create
- addSlide
- deleteSlide
- duplicateSlide
- reorderSlides
- getSpeakerNotes
- updateSpeakerNotes
- replaceAllText
- insertText
- deleteText
- addShape
- addImage
- addTable
- updateTextStyle
- updateShapeProperties
- getSlideThumbnail

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- presentationId: presentation ID or URL (all actions except `create`).
- max_chars (getText, getMetadata, getImages, getSpeakerNotes):
  maximum characters returned, integer 1–100000; defaults to 20000.
- full (getText, getMetadata, getImages, getSpeakerNotes):
  `true` returns the complete payload and ignores `max_chars` and the item bounds.
- localPath (getImages, getSlideThumbnail): absolute local directory that
  receives every image (getImages), or absolute local file path of the
  thumbnail (getSlideThumbnail).
  Both actions write to the server's disk, so they are available only over
  local stdio transport.

## Bounds

A deck read returns the whole presentation in one call, so these actions are
bounded by default:

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `getText` | 20,000 characters | raise `max_chars` (up to 100000), or `full: true` |
| `getMetadata` | 20,000 characters, 100 `slides` entries | `full: true` |
| `getImages` | 20,000 characters, 100 images | `full: true` |
| `getSpeakerNotes` | 20,000 characters, 100 slides | `full: true` |
| `getSlideThumbnail` | none -- writes the PNG to `localPath` and returns its URL, size and saved path | -- |

Truncation is never silent. A cut payload carries
`_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
and `note` reads
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`,
so the true size is always visible. A JSON payload stays parseable, and a
`getText` body that was cut keeps a readable prefix plus the same marker.

## Result shape

`getText` returns the deck's text as plain text (one `--- Slide N ---` block per
slide). Every other action returns `{content: [{type: "text", text}]}` with
`text` holding the JSON payload.

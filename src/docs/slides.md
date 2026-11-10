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

## Bounds

A deck read returns the whole presentation in one call, so these actions are
bounded by default:

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `getText` | 20,000 characters | raise `max_chars` (up to 100000), or `full: true` |
| `getMetadata` | 20,000 characters, 100 `slides` entries | `full: true` |
| `getImages` | 20,000 characters, 100 images | `full: true` |
| `getSpeakerNotes` | 20,000 characters, 100 slides | `full: true` |
| `getSlideThumbnail` | none -- one base64 image, returned whole | -- |

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

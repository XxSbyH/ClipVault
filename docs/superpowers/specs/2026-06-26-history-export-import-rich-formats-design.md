# ClipVault History Export/Import and Rich Formats Design

## Context

ClipVault currently stores clipboard history in local SQLite. Each history row is centered on one primary content representation: text, image bytes, or file path metadata. Search is based on plain text and preview fields through SQLite FTS5.

The next feature needs two related capabilities:

- Export and import history records.
- Preserve mainstream rich clipboard formats so pasted history can restore HTML/RTF/image/file-list formats instead of only plain text.

These capabilities should be designed together because exported history must be able to carry rich format payloads without changing the export format again later.

## Goals

- Export and import history records only.
- Preserve history-owned state: favorite, pinned, created time, last-used time, use count, content type, preview, searchable plain text, image data, and rich format payloads.
- Support mainstream Windows clipboard formats in the first version:
  - `CF_UNICODETEXT`
  - `CF_TEXT`
  - `HTML Format`
  - `Rich Text Format`
  - `PNG`
  - `CF_DIB`
  - `CF_HDROP`
- Keep search and list rendering fast by indexing and displaying plain text summaries only.
- Restore rich formats during paste when available, with plain text fallback.
- Import duplicate records without growing history unnecessarily.

## Non-Goals

- Do not export app settings.
- Do not export hotkey settings.
- Do not export blacklist entries.
- Do not export fixed contents.
- Do not export copied file contents. File entries only preserve paths and metadata.
- Do not support arbitrary private/custom clipboard formats in the first version.
- Do not render rich HTML/RTF inside the virtualized history list.
- Do not implement cloud sync or telemetry.

## Current Storage Summary

The active database is:

```text
%APPDATA%/com.clipvault.app/clipboard.db
```

Important existing tables:

- `clipboard_items`: history rows, plain text content, preview, image BLOB, file path, metadata, favorite/pinned state, usage state.
- `settings`: app and hotkey settings.
- `app_blacklist`: privacy blacklist.
- `fixed_contents`: fixed snippets and hotkeys.
- `clipboard_fts`: FTS5 index maintained from `clipboard_items.content` and `clipboard_items.preview`.

This feature should keep `clipboard_items` as the lightweight history summary table and add rich payload storage beside it.

## Data Model

Keep `clipboard_items` as the primary table used for list, search, sorting, favorite, and pinned state.

Add a new table:

```sql
CREATE TABLE IF NOT EXISTS clipboard_formats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  format_name TEXT NOT NULL,
  format_id INTEGER,
  mime_type TEXT,
  encoding TEXT NOT NULL,
  data BLOB NOT NULL,
  byte_len INTEGER NOT NULL,
  data_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(item_id) REFERENCES clipboard_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clipboard_formats_item_id
ON clipboard_formats(item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clipboard_formats_item_format_hash
ON clipboard_formats(item_id, format_name, data_hash);
```

Model behavior:

- `clipboard_items.content` remains the canonical searchable plain text.
- `clipboard_items.preview` remains the list preview.
- `clipboard_items.metadata` can include:
  - `hasRichFormats: true`
  - `formatNames: ["HTML Format", "Rich Text Format"]`
  - `formatCount`
- `clipboard_formats.data` stores raw bytes for rich formats and image/file-list payloads.
- `CF_UNICODETEXT` can be regenerated from `clipboard_items.content`, so it does not need to be duplicated as a BLOB unless needed for exact fidelity.

## Capture Behavior

On clipboard capture, ClipVault should continue deriving a plain text representation first:

- If `CF_UNICODETEXT` exists, use it as `clipboard_items.content`.
- If only `HTML Format` exists, extract visible text for `content` and `preview`.
- If only `Rich Text Format` exists, first version stores the RTF payload and uses a fixed fallback preview such as `Rich Text Format item`; it is searchable only by that fallback preview. In normal Office/browser copies, `CF_UNICODETEXT` is expected to be present and remains the searchable text source.
- Images keep current image summary behavior and can store `PNG`/`CF_DIB` payloads as rich formats.
- `CF_HDROP` stores file paths and metadata only, never file contents.

Privacy and limits:

- Sensitive filtering applies to the plain text representation before inserting a row.
- Rich payloads are stored only if the plain text representation passes privacy checks.
- Each format has a per-format size cap.
- Each item has a total rich payload size cap.
- Unknown formats are ignored in the first version.

## Search and List Design

Search must remain based on plain text only:

- Index `clipboard_items.content`.
- Index `clipboard_items.preview`.
- Do not index raw HTML.
- Do not index raw RTF.
- Do not index image bytes or DIB bytes.

The virtualized history list should stay lightweight:

- Query `clipboard_items` summaries only.
- Do not query `clipboard_formats.data` for list rows.
- Show plain text `preview`.
- Show small format markers such as `HTML`, `RTF`, `PNG`, or `DIB` when `metadata.hasRichFormats` is true.

This avoids search pollution from tags/control characters and avoids list rendering stalls from large payloads.

## Detail and Edit Behavior

Details view:

- Default view shows the plain text representation.
- If `HTML Format` is present, a rich preview can be shown in a constrained/sanitized preview area.
- `Rich Text Format` is preserved for paste. First version does not need full RTF visual rendering.
- A format list can show available formats and sizes.

Editing:

- Editing a rich-format item should not mutate the original rich payload.
- First version behavior: "save as plain text copy".
- The original rich item remains unchanged.
- The new edited item is a plain text record and can be searched/pasted as text.

This avoids inconsistencies where the plain text content changes but HTML/RTF payloads still contain old content.

## Paste Behavior

When pasting a history item:

1. Load the item summary.
2. Load rich formats only if the item has rich formats.
3. Write supported formats to the Windows clipboard in priority order.
4. Always provide `CF_UNICODETEXT` / plain text fallback when text exists.
5. Trigger paste simulation as today.

Suggested format priority:

- Rich text item: `HTML Format`, `Rich Text Format`, `CF_UNICODETEXT`, `CF_TEXT`
- Image item: `PNG`, `CF_DIB`
- File item: `CF_HDROP`, plus plain path text fallback if needed

If rich format write fails, fallback to current plain text/image/file behavior and log the failure.

## Export Format

Export only history data. The file extension should be:

```text
.clipvault
```

The file is a zip container. Example:

```text
manifest.json
items.jsonl
formats/
  000001-html.bin
  000001-rtf.bin
  000002-png.bin
```

`manifest.json`:

```json
{
  "app": "ClipVault",
  "type": "history",
  "exportVersion": 1,
  "createdAt": 1782460000000,
  "itemCount": 1200
}
```

`items.jsonl` uses one JSON object per line:

```json
{"exportId":"000001","content":"hello","preview":"hello","contentType":"text","contentHash":"...","createdAt":1782460000000,"lastUsedAt":1782460005000,"useCount":3,"isPinned":false,"isFavorite":true,"metadata":{"hasRichFormats":true,"formatNames":["HTML Format","Rich Text Format"]},"formats":[{"formatName":"HTML Format","mimeType":"text/html","encoding":"binary","byteLen":2048,"hash":"...","path":"formats/000001-html.bin"},{"formatName":"Rich Text Format","mimeType":"text/rtf","encoding":"binary","byteLen":4096,"hash":"...","path":"formats/000001-rtf.bin"}]}
```

Design choices:

- Use JSONL so export/import can stream records.
- Store large payloads as files under `formats/`.
- Avoid Base64 for large payloads because it expands file size and encourages loading huge JSON into memory.
- Keep settings, hotkeys, blacklist, and fixed contents out of the export package.

## Import Behavior

Import only merges history into the current local database.

Flow:

1. Open `.clipvault` zip.
2. Read and validate `manifest.json`.
3. Reject unsupported `exportVersion`.
4. Validate max item count and max total payload size.
5. Stream `items.jsonl` line by line.
6. Validate each item and each referenced format file.
7. Insert new history rows and rich payloads inside one import transaction.
8. Rebuild/repair FTS after import.
9. Return import statistics.

Duplicate strategy:

- If an item already exists by `contentHash` or equivalent payload fingerprint, do not insert a duplicate row.
- Merge `isFavorite` with OR.
- Merge `isPinned` with OR.
- Merge `lastUsedAt` by taking the newer value.
- Merge `useCount` by taking the larger value, not summing.
- Do not overwrite existing rich payloads unless the local item has no rich payload and the imported item provides supported rich formats.

Suggested import result:

```json
{
  "inserted": 100,
  "skippedDuplicates": 25,
  "mergedState": 8,
  "skippedUnsupportedFormats": 3,
  "failed": 0
}
```

## Performance Requirements

- History list queries must not read `clipboard_formats.data`.
- Search queries must not read `clipboard_formats.data`.
- Export reads history in pages.
- Import streams JSONL and format files.
- Use one database transaction for the first version import so failures can roll back cleanly.
- Rebuild FTS once after import, not after every row.
- Enforce per-format and per-item size caps.
- Keep all heavy payload decoding out of the list view.
- UI should show progress and allow canceling long import/export operations.

## Error Handling

- Invalid package: reject before writing anything.
- Missing payload file: skip that format and record a warning, unless it is the only usable payload for the item.
- Oversized payload: skip that format and record a warning.
- Unsupported format: skip and count it.
- Import failure inside the transaction: roll back the import.
- Fatal import failure: leave the existing database unchanged.
- The first version is all-or-nothing. A future version can add resumable partial import only if the UI clearly reports partial results.

## Privacy

- Export includes clipboard history content selected by the user, including rich payload bytes.
- File entries export paths and metadata only.
- File entries do not export file contents.
- Imported rich payloads still follow supported-format whitelist.
- Import should not disable sensitive filtering globally.
- Export UI should make it clear that exported history may contain sensitive copied data.

## Testing

Rust tests:

- Export package manifest generation.
- JSONL item serialization for text, image, file, and rich formats.
- Import duplicate merge: favorite/pinned OR, newer `lastUsedAt`, max `useCount`.
- Import rejects unsupported package versions.
- Import skips unsupported formats.
- Import preserves supported format payload hashes.
- Search uses plain text only and ignores HTML/RTF raw tags.
- List summary queries do not load format BLOBs.

Integration/manual verification:

- Copy rich HTML from browser, store, paste into Word/Feishu/browser editor with formatting preserved.
- Copy RTF from Word, store, paste back with formatting preserved where supported.
- Copy image, export, import, preview and paste.
- Copy file paths, export, import, verify paths only are stored.
- Export large history without UI stall.
- Import large history without search/list stutter.

# Plan: RSVP speed reading and combined mode (issue #2082, parts 2 and 3)

Status: planning only. Nothing here is implemented. Upstream issue: https://github.com/bookorbit/bookorbit/issues/2082.
Part 1 (fixation emphasis renderer) is planned separately; this document only defines what RSVP needs from it.

## 1. Summary

- RSVP is a client-only overlay inside the existing EPUB reader (`ReaderView.vue`). It reads section documents offscreen through Foliate's `book.sections[i].createDocument()`, splits them into words with `Intl.Segmenter`, and keeps DOM offsets for every word so it can produce an exact EPUB CFI for the current word on demand.
- On pause, checkpoint and exit it writes the word's CFI and percentage through the existing `PUT /api/v1/reading-progress` path (`kind: 'text'`). The server already derives the Kobo bookmark (`progressBridge.cfiToKoboBookmark`) and the KOReader xpointer (`positionConverter.cfiPointToXpointer`) from the stored CFI, so no sync code changes.
- Time spent in RSVP is recorded through the existing `useReadingSession` composable and `POST /api/v1/books/files/:fileId/sessions`, with a new `sessionType: 'rsvp'`. Stats already classify every type other than `tts`/`listen` as reading, so dashboards, the calendar and year review count RSVP as reading without query changes.
- No database migration. `reading_sessions.session_type` is `varchar(20)` with no check constraint, and reader settings live in a `jsonb` column.
- Combined mode is one boolean (`rsvpFixationEmphasis`) that makes the RSVP word renderer call a pure helper from the fixation-emphasis feature, `fixationPrefixLength(word, strength, lang)`, and bold that many graphemes of the flashed word.

## 2. What exists today (findings)

| Area                   | Where                                                                                                                                                              | What matters for RSVP                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EPUB reader            | `client/src/features/reader/ReaderView.vue` (about 1800 lines), `epub/composables/useFoliate.ts`                                                                   | Vendored Foliate (`client/public/assets/foliate/`) renders each spine section in an iframe. `view.getCFI(index, range)` and `view.resolveCFI(cfi)` are exposed. Fixed-layout books are flagged by `isFixedLayout`.                                                                                        |
| Word segmentation      | `public/assets/foliate/tts.js`, `text-walker.js`                                                                                                                   | Foliate's own TTS already turns a document into per-word DOM `Range`s with `Intl.Segmenter(lang, { granularity: 'word' })` over a text-node walker that skips `script`/`style`. Same block tag list as the server TTS extractor.                                                                          |
| Offscreen section docs | `view.js` `#searchBook` / `#searchSection`                                                                                                                         | Book search calls `book.sections[i].createDocument()` and turns matches into CFIs with `getCFI(index, range)`. Annotations then navigate to those CFIs, so CFIs from offscreen documents already round-trip through the visible renderer in production.                                                   |
| Server chapter text    | `server/src/modules/tts/tts-text-extractor.service.ts`, `GET /api/v1/tts/text/:fileId/:chapter`                                                                    | Returns plain block strings with no DOM positions. TTS stores its own `tts:<chapter>:<block>` marker, which is block-level only.                                                                                                                                                                          |
| Position converters    | `server/src/modules/position-converter/`                                                                                                                           | CFI to KOReader xpointer and CFI to Kobo span conversion, with chapter text indexes. Runs on sync pulls, not on web saves.                                                                                                                                                                                |
| Progress save          | `shared/composables/useReaderProgress.ts`, `client/src/lib/reading-progress.ts`, `server/src/modules/book/reading-progress.service.ts`, `BookService.saveProgress` | Debounced 2 s save on relocate. Server stores CFI and percentage, runs Kobo two-way sync, audiobook/ebook sync and auto read status. `checkForNewerPosition` / `NewerPositionDialog` detect another device moving the position. Relocations caused by restore or reflow are skipped via `repositionOnly`. |
| KOReader pull          | `koreader.service.ts` (around line 592)                                                                                                                            | Newest of device progress vs `reading_progress.updatedAt` wins. If the web row is newer and has no xpointer, the CFI is converted server-side.                                                                                                                                                            |
| Kobo                   | `kobo/services/kobo-reading-state.service.ts`                                                                                                                      | Builds the Kobo bookmark from `progress.cfi` with regression protection.                                                                                                                                                                                                                                  |
| Sessions (client)      | `shared/composables/useReadingSession.ts`                                                                                                                          | One session per reader instance: 5 min idle timeout, 10 s minimum, pauses on hidden tab, active time only, `sendBeacon` on unload. Accepts `sessionType`. No public pause API.                                                                                                                            |
| Sessions (server)      | `reading-session.service.ts`, `reading-session.repository.ts`                                                                                                      | DTO allows `read`/`tts`/`listen`. Idempotent on `(userId, sessionId)`, supersedes upward for checkpoints. Upserts daily stats and calls `UserStatisticsService.invalidateUser` on insert.                                                                                                                 |
| Stats                  | `user-statistics.service.ts` / `.repository.ts`, `year-review.calculations.ts`                                                                                     | `StatsCache` per user, 5 min TTL, cleared on session save. Media bucket: `tts`/`listen` = listening, everything else = reading.                                                                                                                                                                           |
| Reader settings        | `reader-preferences` module, `packages/types/src/reader-settings.ts`, `shared/composables/useReaderSettings.ts`                                                    | Per-format-group user defaults plus per-book sparse deltas in `jsonb`. Server validates with strict zod schemas, so new keys must be added to `EPUB_SETTINGS_SCHEMA`.                                                                                                                                     |
| Mobile                 | not in this repo                                                                                                                                                   | Native iOS/Android/watchOS clients live elsewhere and only talk to the API. The web reader is responsive and served as a PWA, so "mobile parity" here means the responsive web UI.                                                                                                                        |

## 3. Approaches compared: text extraction and position mapping

### A. Walk the rendered section in the visible Foliate iframe

Use `renderer.getContents()[0].doc` (what `useFoliateTts` does) and segment it.

- Pros: CFIs come from exactly the DOM the reader shows. Very little new code.
- Cons: only the current section is available. Crossing a chapter means driving the visible paginator (`view.goTo(index + 1)`) and waiting for its `load` event, which emits relocations that would save page-start positions unless suppressed. Reflows from resizing invalidate held Ranges. Couples RSVP timing to rendering.

### B. Parse sections offscreen with `book.sections[i].createDocument()` (recommended)

Same parsed XHTML Foliate renders, but outside the paginator, exactly like book search.

- Pros: CFIs are identical in structure to the reader's (search already proves the round trip). The next section can be prefetched while the current one plays, so chapter changes have no gap and never move the visible view. RSVP state is independent of layout, resize and theme. No server work and no new endpoint.
- Cons: needs access to `view.book` (add a small accessor to `useFoliate`). Each section is parsed a second time (bounded: at most current, next and previous documents cached). Large single-file books (a whole novel in one XHTML) need lazy, block-by-block segmentation to keep memory flat.

### C. Server-side word stream

Extend `tts-text-extractor` or `position-converter/chapter-text-index.ts` with an endpoint returning words plus offsets, mapped to CFIs on the server.

- Pros: reusable by native clients later. Cacheable.
- Cons: the existing extractor has no positions, so this is new mapping code that must match the browser DOM exactly (entities, whitespace, namespaces, soft hyphens). Any drift breaks round-trip accuracy, which is the main risk of the whole feature. Adds per-chapter latency, payload size (a 200k-word section is several MB of JSON) and server CPU, and is unusable offline.

### Decision

Use B. It reuses a production-proven CFI path, isolates RSVP from the paginator, and needs no backend for text. Keep A's technique only as a fallback for formats whose sections lack `createDocument`. C is worth revisiting only if native clients adopt RSVP and want a shared word stream.

### Word model and memory

- Per section: a list of blocks, using the same block tag set as `tts.js` and `useFoliateTts` (`p`, `li`, `h1`-`h6`, `blockquote`, ...). Blocks are segmented lazily when playback approaches them, and only the current, previous and next block keep word arrays.
- Per word: `{ text, nodeIndex, startOffset, endNodeIndex, endOffset, pauseAfter }` against the block's text-node list. No `Range` objects are stored. A `Range` (and CFI) is built only for checkpoints, exit and "show in page".
- Skip non-linear spine items (`linear="no"`), sections with no word-like segments (covers, image pages), and `script`/`style`. Treat `pre`/`code` blocks as a single "code block" card that the user skips past with one step, rather than flashing tokens.
- Language from `view.language` / element `lang`, falling back to the book language already computed in `useFoliate` (`bookLanguage`).

### Position mapping

- Start: resolve `progress.cfi` (the top of the visible page) or, if the user re-enters without turning a page, the last RSVP word CFI, against the offscreen document via `resolveCFI(cfi).anchor(doc)`. Start at the first word whose start is at or after that point. If text is selected, start at the selection.
- Save: `view.getCFI(sectionIndex, collapsedRangeAtWordStart)`. Percentage = `sectionFractions[i] + (sectionFractions[i + 1] - sectionFractions[i]) * (charsBeforeWord / sectionChars)`, using `getSectionFractions()` so it matches the reader's own scale.
- Exit: save first, then `view.goTo(wordCfi)` so the page containing the word is shown, with the relocate from that navigation treated as reposition-only (same mechanism as `adoptNewerPosition`). Otherwise the page-start CFI would immediately overwrite the precise word position.

## 4. Recommended design

### 4.1 Playback engine

- Base interval `60000 / wpm`. Range 100 to 1000 WPM, default 300, step 25.
- Chunk size 1 to 3 words (default 1). A chunk never crosses a sentence end or block boundary.
- Pause multipliers: comma, semicolon, colon, dash: x2. Sentence end (`.`, `!`, `?`, ellipsis, closing quote after them): x3. Block (paragraph) end: x4. Section change: shows the chapter title for about 1.5 s. Words longer than 8 characters: x1.3. Numbers and words containing digits: x1.5.
- Ramp-up: the first 5 words after play run at 60 to 100 percent speed to avoid a cold start.
- Scheduler: `setTimeout` chained from a target timestamp so drift does not accumulate. Stops on `visibilitychange` hidden and on window blur.
- Controls: play/pause, step back/forward one chunk, back one sentence, WPM +/-, chunk size, exit. Keyboard: Space, Left/Right, Shift+Left (sentence), Up/Down (WPM), Esc. Touch: tap centre to play/pause, swipe left/right to step, controls in the existing `ReaderBottomSheet` on small screens.
- On pause: show the surrounding sentence with the current word marked, so the reader can regain context.

### 4.2 Optimal recognition point (ORP) display

- ORP index by grapheme length: 1: 0, 2-5: 1, 6-9: 2, 10-13: 3, 14+: 4. Leading punctuation is not counted.
- Layout: three spans (left right-aligned, ORP letter, right left-aligned) around a fixed centre line with small guide ticks, so the ORP letter never moves and no monospace font is needed. ORP colour uses a theme token (`--primary`), never a hardcoded colour.
- Font family, size and theme come from the reader's current EPUB settings so RSVP matches the page.
- Use `Intl.Segmenter` grapheme granularity for indexing so combining marks and emoji are not split.
- Scripts where ORP is meaningless (CJK, where word segmentation yields short tokens) fall back to centring the chunk with no highlight. RTL text renders with `dir="rtl"` and mirrors the ORP layout.

### 4.3 Progress

- Write points: on pause (debounced 2 s), every 30 s while playing, on exit, and on `beforeunload`. Never per word.
- New method on `useReaderProgress`: `commitTextPosition({ cfi, percentage }, navigate)` which sets `cfi`/`percentage`, saves with `kind: 'text'`, then runs `navigate` with relocations suppressed. Kobo/KOReader fields are sent as null so the server derives them from the CFI (the current web save already sends a null KOReader value).
- Before the first checkpoint and before the exit save, call `checkForNewerPosition()`. If another device moved the book while RSVP was open, pause and show the existing `NewerPositionDialog` instead of overwriting.
- Respects `trackingEnabled` (the untracked `?mode=` preview): no progress or session writes.

### 4.4 Sessions and stats

- RSVP gets its own `useReadingSession(fileId, getRsvpProgress, { trackingEnabled, sessionType: 'rsvp' })` instance in the RSVP composable. On RSVP enter, call `endSession()` on the reader's `read` session. On exit, end the RSVP session; the `read` session restarts on the next page-turn activity as it does after an idle timeout. Time is never counted twice.
- Session definition while paused: add `pause()` and `resume()` to `useReadingSession`'s public API (wrapping the existing `pauseTimer`/`resumeTimer`). Active time accrues only while playing or while the user is stepping. A pause longer than the existing 5 min idle timeout ends the session; resuming later starts a new session id. Manual step and seek count as activity.
- `progressDelta` / `endProgress` come from RSVP's own word percentage, so a session that reads 4 percent of the book in RSVP records 4 percent.
- Server: add `'rsvp'` to `READING_SESSION_TYPES`, the DTO `@IsIn`, and the repository parameter type. No query changes are needed: `user-statistics` and `year-review` already bucket non-listening types as reading, and `invalidateUser` already runs on save.
- Open question for maintainers (see section 8): whether to persist `'rsvp'` or plain `'read'`.

### 4.5 Settings

Add optional keys to `EpubReaderSettings` and `EPUB_SETTINGS_SCHEMA`, left undefined by default (the same pattern as `cbx.autoAdvance`) so they are not injected into every per-book delta:

- `rsvpWpm?: number` (100 to 1000)
- `rsvpChunkSize?: 1 | 2 | 3`
- `rsvpPunctuationPauses?: boolean` (default true when undefined)
- `rsvpFixationEmphasis?: boolean` (combined mode, default false when undefined)

They are saved to the user's EPUB defaults (`PATCH /api/v1/reader/defaults/epub`), not per book, because reading speed is a property of the reader rather than the book.

### 4.6 Combined mode: interface needed from the fixation-emphasis feature

RSVP needs a pure, DOM-free helper that the page renderer also uses, so both agree on what gets bolded:

```ts
// client/src/features/reader/shared/lib/fixation-emphasis.ts (owned by part 1)
export type FixationStrength = number; // the same value stored by the fixation-emphasis setting

/** Number of leading graphemes to emphasise in `word`, or 0 when the word should be left alone. */
export function fixationPrefixLength(
  word: string,
  strength: FixationStrength,
  lang?: string,
): number;

export function isFixationEligible(
  lang: string | undefined,
  dir: "ltr" | "rtl",
): boolean;
```

Requirements on that helper:

- Pure and synchronous. No DOM, no iframe, no CSS injection, so RSVP can call it once per flashed chunk.
- Counts graphemes (`Intl.Segmenter`), ignores leading punctuation and quotes, handles hyphenated words per part, returns 0 for numbers, CJK and RTL scripts (same skip rules as the page renderer).
- The strength setting key and its default live in `EpubReaderSettings` and are read from the same `useReaderSettings` state, so changing strength in the appearance panel changes RSVP immediately.

RSVP owns the rendering: for each word it splits graphemes into `{ text, bold, orp }` segments, where `bold` comes from `fixationPrefixLength` and `orp` from 4.2. The ORP letter keeps its colour and gains weight if it falls inside the bold prefix. RSVP does not depend on the page renderer's DOM transform, and the page renderer does not need to know about RSVP. If part 1 lands after RSVP, the combined-mode toggle stays hidden until the helper exists.

## 5. File-by-file changes

### Shared types

- `packages/types/src/reading-session.ts`: add `'rsvp'` to `READING_SESSION_TYPES` (if the maintainers accept a new type).
- `packages/types/src/reader-settings.ts`: add the optional `rsvp*` keys to `EpubReaderSettings`, plus `RSVP_WPM_MIN/MAX/DEFAULT` constants.

### Server

- `server/src/modules/reading-session/dto/save-reading-session.dto.ts`: `@IsIn(READING_SESSION_TYPES)` instead of the literal list.
- `server/src/modules/reading-session/reading-session.repository.ts`: widen the `sessionType` parameter to `ReadingSessionType`.
- `server/src/modules/reader-preferences/reader-preferences.service.ts`: add the optional `rsvp*` keys to `EPUB_SETTINGS_SCHEMA`.
- No changes to Kobo, KOReader, position-converter, user-statistics or year-review code. Tests are added to confirm that (see section 7).
- No migration.

### Client: new feature folder `client/src/features/reader/rsvp/`

- `lib/rsvp-segmenter.ts`: block collection and lazy word segmentation over a `Document` (shares the block tag list with `useFoliateTts`; extract that list to `reader/shared/lib/block-tags.ts`).
- `lib/rsvp-timing.ts`: pause multipliers, chunking, ramp-up. Pure functions.
- `lib/rsvp-orp.ts`: ORP index and segment splitting, combining with `fixationPrefixLength`.
- `lib/rsvp-position.ts`: word to CFI, CFI to word index, word to percentage.
- `composables/useRsvpSource.ts`: offscreen section loading via `view.book.sections[i].createDocument()`, linear-spine iteration, prefetch, cache of at most 3 sections.
- `composables/useRsvpPlayer.ts`: state machine (idle, playing, paused, ended), scheduler, controls, keyboard and touch handling.
- `composables/useRsvpSession.ts`: wires `useReadingSession` (type `rsvp`) and `useReaderProgress.commitTextPosition`, checkpoints, newer-position check.
- `components/RsvpOverlay.vue`: full-reader overlay, word display, pause context.
- `components/RsvpControls.vue`: desktop control bar and mobile bottom sheet content (WPM, chunk size, punctuation pauses, combined-mode toggle).
- `components/RsvpWord.vue`: ORP and emphasis rendering.

### Client: existing files

- `reader/ReaderView.vue`: mount `RsvpOverlay`, enter/exit handlers, stop TTS and media overlay on enter, include RSVP in `isNavigationLocked`. Keep logic in the RSVP composables to avoid growing this file.
- `reader/epub/components/ReaderHeader.vue`: "Speed read" button (lucide `Gauge` or `Zap`), hidden for fixed-layout and non-EPUB formats.
- `reader/epub/composables/useFoliate.ts`: expose `getBook()` (sections, language) and the existing `getCFI`/`resolveCFI`.
- `reader/epub/composables/useReaderKeyboardShortcuts.ts`: accept an `enabled` getter so reader shortcuts are suspended while RSVP is open. Add RSVP shortcuts to `KeyboardShortcutsModal.vue`.
- `reader/epub/composables/useFoliateInput.ts`: no change; pass `canNavigate` false while RSVP is open.
- `reader/shared/composables/useReadingSession.ts`: export `pause()` / `resume()`.
- `reader/shared/composables/useReaderProgress.ts`: add `commitTextPosition`.
- `reader/shared/composables/useReaderSettings.ts`: include the new keys in defaults handling.
- `tts/composables/useFoliateTts.ts`: import the shared block tag list.
- `client/src/locales/en.json`: new `reader.rsvp.*` strings (other locales via Crowdin).

## 6. Risks

1. **Position round-trip accuracy.** The saved CFI must resolve back to the same word in the visible renderer, Kobo and KOReader. Mitigation: CFIs come from Foliate's own `getCFI` on the same parsed XHTML (the search path), never from server text. Kobo maps to sentence-level kepub spans and KOReader to xpointers, so external devices land at sentence or paragraph granularity, which is expected and better than today's page-start. Fixture tests cover nested inline markup, soft hyphens, entities, ruby, footnote links and multi-file chapters.
2. **Overwriting newer positions from other devices.** RSVP can stay open for a long time. Mitigation: newer-position check before the first and the final write, periodic checkpoints so the web row stays the newest legitimate source, and no per-word writes that would churn Kobo two-way sync and audiobook sync.
3. **Session semantics and double counting.** Mitigation: end the `read` session on enter, separate `rsvp` session, explicit pause API, idle timeout while paused, 10 s minimum unchanged.
4. **Unknown `sessionType` in native clients.** Native apps list sessions (`BookReadingSession.sessionType`). If any decodes it as a strict enum, a new `'rsvp'` value could break that screen. The field is documented as optional with a fallback, but the native code is not in this repo, so this needs maintainer confirmation.
5. **Stats and achievements inflation.** RSVP at high WPM makes pace and "pages per day" (`speed_reader` achievement) look faster. It is real reading, but maintainers may want RSVP excluded from pace estimates.
6. **Multi-chapter and odd EPUBs.** Very long single-file sections (memory), sections that are all images, non-linear spine items, fixed-layout books, and books whose TOC splits a file into several chapters. Mitigation: lazy block segmentation, skipping empty and non-linear sections, disabling RSVP for fixed layout, and showing the TOC label from `getTOCItemOf` at section changes.
7. **Interaction with other reader modes.** TTS, media overlay, search highlights, selection popups and keyboard shortcuts all assume the paginator is in control. Mitigation: RSVP is mutually exclusive with TTS and media overlay, and suspends shortcuts and tap navigation while open.
8. **Accessibility and safety.** Rapid flashing can be uncomfortable. Mitigation: no flashing colours, respect `prefers-reduced-motion` by defaulting to a lower WPM, keep the pause context view, and announce state changes (not every word) to screen readers.

## 7. Test plan

### Unit (Vitest)

- `rsvp-segmenter`: block splitting matches `useFoliateTts` on the same fixture; skips `script`/`style`; lazy segmentation; CJK, RTL, hyphenated and apostrophe words; soft hyphen and NBSP handling.
- `rsvp-timing`: multipliers per punctuation type, paragraph and section pauses, chunk boundaries never cross sentences, ramp-up, drift-free schedule with fake timers.
- `rsvp-orp`: ORP index table, grapheme handling (combining marks, emoji), segment merge with a stubbed `fixationPrefixLength`.
- `rsvp-position`: CFI to word to CFI round trip on fixture XHTML (nested spans, `<a>` footnotes, entities, ruby); percentage stays within the section's fraction range and is monotonic.
- `useReadingSession`: `pause()` stops accrual, idle timeout after pause ends the session, `sessionType: 'rsvp'` in the payload, no write when tracking is disabled.
- `useReaderProgress.commitTextPosition`: saves the given CFI, then suppresses the navigation relocate save.
- `useRsvpSession`: end-of-read-session on enter, newer-position check before the exit write, checkpoint cadence.
- Server: DTO accepts `rsvp` and rejects unknown types; repository persists it; `user-statistics` and `year-review` bucket `rsvp` as reading; reader-preferences schema accepts the new keys and rejects out-of-range WPM.

### Integration / E2E

- `server/test/`: save a session with `sessionType: 'rsvp'`, confirm it appears in book sessions and that the stats cache is invalidated (summary changes immediately).
- Progress round trip: save a word-level CFI through `PUT /reading-progress`, then pull via the KOReader sync endpoint (xpointer derived) and the Kobo reading-state path (bookmark derived), using existing EPUB fixtures in the position-converter tests.

### Manual

- Desktop and mobile (iOS Safari, Android Chrome, installed PWA): enter from mid-chapter, play across a chapter boundary, step back across a boundary, pause for over 5 minutes, exit and confirm the page shows the last word, reload and confirm the position persists.
- With a Kobo and KOReader linked: RSVP on web, sync each device, confirm it opens at the right paragraph; then move ahead on the device while RSVP is open and confirm the newer-position dialog appears on exit.
- Combined mode on and off, with different strength values, on Latin, CJK and RTL books.

## 8. Open questions for maintainers

1. New `sessionType: 'rsvp'` or record RSVP as `'read'`? Do the native clients tolerate unknown session types?
2. Should RSVP time count toward reading pace estimates and the `speed_reader` achievement?
3. Settings placement: user-level EPUB defaults only (proposed) or also per book?
4. Is the 30 s checkpoint cadence acceptable for Kobo two-way sync and audiobook/ebook sync load, or should RSVP write only on pause and exit?
5. Should RSVP be EPUB-only at first, or also cover MOBI/AZW3/FB2 opened through Foliate?
6. Any interest in native client support later? If so, approach C (server word stream) becomes more attractive and should be designed now.
7. Preferred split: one PR per part of #2082, or RSVP and combined mode together after part 1?

## 9. Effort estimate (one experienced developer familiar with the codebase)

| Piece                                                                                                                                         | Size          | Approx. days |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ |
| RSVP (part 2): segmentation and source, player and timing, ORP display, progress commit, session type, settings, UI desktop and mobile, tests | M (upper end) | 7 to 9       |
| Combined toggle (part 3), assuming the part 1 helper exists                                                                                   | S             | 1 to 1.5     |

The RSVP estimate breaks down roughly as: source and segmentation 1.5, player and timing 1.5, position mapping and progress commit 1.5, sessions, settings and server type 1, UI and mobile 1.5, tests and fixture round trips 1 to 2. The main uncertainty is position round-trip edge cases in unusual EPUBs.

## 10. Draft comment for the upstream issue (not posted)

> Thanks for considering this. Here is how I would approach #2082 if it is approved. No code until you assign it.
>
> **Fixation emphasis (part 1):** a client-only render pass on Foliate section documents, built on a pure helper `fixationPrefixLength(word, strength, lang)`. Off by default, skips code, headings, CJK and RTL. EPUB files are never modified.
>
> **RSVP (part 2):** an overlay in the EPUB reader. It parses sections offscreen with `book.sections[i].createDocument()` (the same path book search uses) and splits words with `Intl.Segmenter`, so every word maps to an exact Foliate CFI. On pause, every 30 s and on exit it saves that CFI through the existing reading-progress endpoint, so Kobo and KOReader positions are derived server-side as they are today. It checks for a newer position from another device before writing. Time is recorded with the existing reading-session flow; I would add `sessionType: 'rsvp'`, which stats already treat as reading. No database migration.
>
> **Combined mode (part 3):** one toggle in the RSVP controls that applies the part 1 helper to each flashed word.
>
> Questions: is a new `rsvp` session type fine for the native apps, or should it be stored as `read`? Should RSVP count toward pace and the speed reader achievement? Would you prefer three separate PRs?
>
> Rough size: part 2 M (about 7 to 9 days), part 3 S (about 1 day once part 1 exists); part 1 is sized separately.

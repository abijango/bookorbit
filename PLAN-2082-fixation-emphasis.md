# Plan: Fixation emphasis in the EPUB reader (issue #2082, part 1)

Status: planning only. No code will be written or PR opened until a maintainer approves and assigns
[bookorbit/bookorbit#2082](https://github.com/bookorbit/bookorbit/issues/2082).

Scope: part 1 of the issue, "fixation emphasis" (the reading aid that bolds the first part of each
word). The RSVP speed-reading mode is planned separately; section 9 covers how it reuses this work.

Working name in UI and code: **Fixation emphasis** (`fixationEmphasis`). The trademarked name is not
used anywhere, and the algorithm is original: no third-party API, library or font.

---

## 1. Summary of the recommendation

- **Approach:** a DOM text-node transform that runs inside the reflowable EPUB iframe. It wraps the
  leading graphemes of each word in a marker element (`<span data-bo-fx>`) styled with
  `font-weight: bolder`. The EPUB file and the server are never involved.
- **When it runs:** synchronously in foliate's `load` event. The paginator fires that event from
  `afterLoad`, before `beforeRender`/`render` and before the saved CFI anchor is resolved
  (`paginator.js` `#display`). Pages are laid out once, already emphasised, and the restore position
  is computed against the final layout.
- **Why positions stay stable:** foliate's `epubcfi.js` already accepts a node filter
  (`FILTER_SKIP` flattens an element into its parent) and merges adjacent text nodes into a single
  CFI chunk. Passing a filter that skips `[data-bo-fx]` makes every CFI identical to the one the
  untransformed document would produce. A small patch is needed so `nodeToParts` climbs over skipped
  ancestors (details in section 3.3). Progress, bookmarks, highlights, search hits, KOReader and Kobo
  conversion, and the iOS app all keep seeing the same CFIs.
- **Settings:** two new optional keys in `EpubReaderSettings`: `fixationEmphasis: boolean` (default
  `false`) and `fixationStrength: number` (default `0.4`). They flow through the existing
  three-layer merge: built-in defaults, then account defaults (`reader_default_preferences`), then
  the per-book-file delta (`reader_preferences`). The per-book on/off toggle is the existing per-book
  delta. Both tables store `jsonb`, so **no DB migration is needed**. Only the server's strict zod
  schema changes.
- **Effort:** **M**, about **7 working days** (range 6-9) for one experienced developer, including
  tests and cross-browser checks.

---

## 2. What exists today (findings from the code)

| Area | Where | Relevant facts |
| --- | --- | --- |
| Rendering engine | `client/public/assets/foliate/*.js` (vendored foliate-js, already patched locally: `iframe-loader.js`, `streaming-loader.js`, Kobo span helpers in `view.js`) | Each section renders in an iframe. `view.js#onLoad` emits `load` with `{ doc, index }` synchronously from the paginator's `afterLoad`, before styles and layout are applied. |
| Reader wiring | `client/src/features/reader/epub/composables/useFoliate.ts` | The `load` listener already runs per-chapter DOM work synchronously (`markBookAlignment(doc)`, `input.attachIframeClicks(doc)`, `onChapterLoad`). This is the hook point. |
| CSS injection | `epub/composables/useReaderState.ts` `generateCSS()` / `applyToRenderer()` -> `renderer.setStyles()` | Injection is gated by `shouldApplyStyles` (off when `overrideBookFormatting` is false and the book has no delta). Fixation emphasis must **not** depend on that gate, so it injects its own one-rule `<style>`, the same pattern as `injectMediaOverlayHighlightCss`. |
| Book-level transforms | `epub/lib/publisher-font-sizes.ts` uses `book.transformTarget` (`css` events) | The string-level `data` hook exists but is the wrong place for this feature (see 4.3). |
| CFI generation | `view.js` `getCFI()` -> `CFI.fromRange(range)`; `resolveCFI()` and `epub.js` `resolveCFI()` -> `CFI.toRange(doc, parts)` | Neither passes a filter today. The progress CFI uses `getReadingProgressRange`, which picks the **first visible text node**. With emphasis on, that is usually a text node inside a wrapper, so the filter patch is mandatory. |
| Search | `view.js#searchSection` / `#searchBook` call `sections[i].createDocument()` | Search runs on a fresh, untransformed parse, so search CFIs are already correct. Only resolving them in the live document needs the filter. |
| TTS / Read along | `features/tts/composables/useFoliateTts.ts`, `public/assets/foliate/tts.js`, `media-overlay/*` | TTS builds ranges from block elements (`BLOCK_TAGS`). Inline wrappers are invisible to it. Media overlay highlights elements by `id`, which is never touched. |
| Settings model | `packages/types/src/reader-settings.ts` (`EpubReaderSettings`, `EPUB_READER_DEFAULTS`) | Shared source of truth for client and server. |
| Settings persistence | `server/src/db/schema/reader.ts`: `reader_default_preferences(user_id, format_group, settings jsonb)`, `reader_preferences(user_id, book_file_id, settings jsonb)` | JSONB, user-scoped, unique per user and group/file. Adding keys needs no migration. |
| Settings API | `server/src/modules/reader-preferences/*` (`GET/PUT/PATCH/DELETE /api/v1/reader/defaults/:group` and `/reader/preferences/:bookFileId`) | `EPUB_SETTINGS_SCHEMA` is `.strict()`, so unknown keys get a 400. A full `PUT` requires every key, so new keys must be `.optional()` (precedent: cbx `autoAdvance`). Ownership is enforced through `bookService.verifyFileAccess` and `user.id`. |
| Client settings | `client/src/features/reader/shared/composables/useReaderSettings.ts` | localStorage first, then optional DB sync (`syncReaderPreferences`), field-level `PATCH`. `sanitizeEpubPartialSettings` drops unknown keys, so new keys must be added there. |
| Reader settings UI | `epub/components/ReaderSettingsPanel.vue`, reused on mobile inside `shared/components/ReaderSettingsSheet.vue` (slot) | One component serves desktop and mobile. Fixed-layout books already hide the text controls (`v-if="!isFixedLayout"`). |
| Account defaults UI | `client/src/features/settings/EbookSettings.vue` (`useReaderDefaultSettings('epub')`) | This is where the per-user default strength (and "on for new books") lives. |
| Native clients | Not in this repo. The README lists an iOS/watchOS app; Android is "coming soon". Comments in `useReaderSettings.ts` and `reader-settings.ts` say the iOS app owns the "look" fields and PATCHes them. | Parity is a coordination item for the maintainers (section 7), not code in this repo. The KOReader plugin (`koreader-plugin/`) does not sync reader display settings, so no change is needed there. |

---

## 3. Recommended design

### 3.1 Pure core: `fixation-split.ts` (shared with RSVP)

`client/src/features/reader/shared/lib/fixation-split.ts`, with no DOM access:

- `segmentWords(text, locale)`: uses `Intl.Segmenter(locale, { granularity: 'word' })` and keeps
  segments where `isWordLike` is true. Falls back to a `\p{L}[\p{L}\p{M}'’-]*` regex when
  `Intl.Segmenter` is missing.
- `fixationLength(word, strength)`: the number of **grapheme clusters** to emphasise, counted with
  `Intl.Segmenter` at `grapheme` granularity so accents, combining marks and emoji never split.
  Rule: `len <= 3 ? 1 : clamp(round(len * strength), 1, len - 1)`. A word with digits only, or one
  grapheme, gets 0.
- `isEmphasisableScript(word)`: returns false for words containing Han, Hiragana, Katakana, Hangul,
  Arabic, Hebrew, Syriac, Thaana, N'Ko, Thai, Lao, Khmer or Myanmar (Unicode `\p{Script=...}`
  regex). This is the per-word safety net for mixed-script text.
- `splitForFixation(word, strength)`: returns `{ head, tail }` for renderers that are not DOM-based
  (RSVP).

### 3.2 DOM adapter: `fixation-emphasis.ts`

`client/src/features/reader/epub/lib/fixation-emphasis.ts`:

- `applyFixationEmphasis(doc, { strength, locale })`
  1. Returns early for documents whose root `dir` is `rtl` or whose `lang` is CJK. Foliate's
     `#onLoad` has already filled `lang`/`dir` from the book metadata.
  2. Walks text nodes with a `TreeWalker` whose `acceptNode` rejects subtrees for: `pre, code, kbd,
     samp, tt, var, script, style, svg, math, ruby, rt, rp, h1-h6, hgroup, textarea, select,
     button`; elements with `dir="rtl"` or a CJK `lang`; `[data-bo-fx]` (idempotency); and
     `epub:type` values for code/landmark navigation (`nav`).
  3. Collects nodes first, then mutates, so the walker is never invalidated. Each text node with at
     least one emphasisable word is replaced by a fragment of text nodes plus `<span data-bo-fx>`
     heads. The adapter uses `span`, not `b`/`strong`, so no semantic emphasis is added.
  4. Injects `<style data-bo-fx-style>[data-bo-fx]{font-weight:bolder}</style>` once per document.
     `bolder` keeps the effect visible when the user's base `fontWeight` is already heavier.
  5. Stamps `doc.documentElement.dataset.boFx = String(strength)` so re-application is a no-op.
- `removeFixationEmphasis(doc)`: replaces every `[data-bo-fx]` with its text, removes the style,
  and calls `normalize()` on each touched parent. The DOM spec updates live ranges during
  `normalize()`, so overlayer ranges survive.
- Hard limits: skip fixed-layout books (`isFixedLayout`), and only run for the `epub` reader group.

### 3.3 Foliate patch (CFI invisibility)

All changes are in vendored `client/public/assets/foliate/`:

- `epubcfi.js`
  - Export `readerInjectedNodeFilter = (n) => n.nodeType === 1 && n.hasAttribute('data-bo-fx') ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT`.
  - `nodeToParts`: when `filter` is given, resolve `parentNode` by climbing while the parent is
    skipped, so a text node inside a wrapper is indexed against its real parent's flattened,
    chunk-merged children. When the range container is itself a skipped element, map
    `(element, offset)` to the equivalent text position before indexing.
- `view.js`: `getCFI` passes the filter to `CFI.fromRange`, and `resolveCFI`'s `anchor` passes it to
  `CFI.toRange`.
- `epub.js` (`resolveCFI` near line 736): passes the filter to `CFI.toRange`.

Without the transform, the filter is a no-op, so behaviour is unchanged for everyone who leaves the
feature off. This is the most safety-critical part of the work and is covered by golden tests
(section 6).

### 3.4 Wiring and live toggling

- `useFoliate.ts`: adds an optional `getFixationOptions()` callback. In the `load` listener, after
  `markBookAlignment` and before `onChapterLoad`, it calls `applyFixationEmphasis(doc, opts)` when
  enabled and the book is not fixed-layout.
- `ReaderView.vue`: provides the callback from reader state. When the setting changes:
  1. Remember `progress.cfi`.
  2. For every `renderer.getContents()` doc: `remove` and then `apply` with the new strength (or
     only `remove`).
  3. Let the paginator's `ResizeObserver`/`expand()` relayout, then `goTo(savedCfi)` and
     `annotations.reAddAll(view)` so highlights redraw against the new layout. This matches what a
     font-size change already costs.
- `useReaderState.ts`: adds `fixationEmphasis` and `fixationStrength` refs, setters and `state`
  fields. They are **not** part of `generateCSS()`.

### 3.5 Settings semantics

| Layer | Holds | Edited in |
| --- | --- | --- |
| Built-in default | `fixationEmphasis: false`, `fixationStrength: 0.4` | `packages/types` |
| Account default | User's preferred strength, plus an optional "turn on for all books" (`fixationEmphasis` in defaults) | Settings > Ebook (`EbookSettings.vue`) |
| Per-book-file delta | On/off toggle (and strength, if changed from inside the reader) | Reader settings panel |

The strength range is `0.2` to `0.7` in steps of `0.05`, shown as a `ReaderRangeField` labelled
"Emphasis strength". The default is about 40% of each word.

### 3.6 UI

- `ReaderSettingsPanel.vue`: a new "Reading aids" group, inside `v-if="!isFixedLayout"`, with a
  `ToggleSwitch` "Fixation emphasis" and, when on, the strength slider. When the book language is
  RTL or CJK, the toggle is disabled with the hint "Not available for this book's language".
  Handlers are named functions (`handleFixationToggle`, `handleFixationStrength`) to satisfy
  `vue/v-on-handler-style`.
- `EbookSettings.vue`: the same two controls under the ebook defaults.
- `client/src/locales/en.json`: new keys under `reader.settings.*` and the ebook settings section.
  Other locales come through Crowdin. Strings use no em dashes.
- Mobile: no separate work. `ReaderSettingsSheet` slots the same panel.

---

## 4. Approaches compared

### 4.1 A. DOM text-node transform after parse, before layout (recommended)

- **Visual:** real bold from whatever font the user picked, including synthetic bold. This matches
  the issue ("bold the first part of each word").
- **Performance:** O(words) node creation per section. A typical 5-10k word chapter adds roughly
  10-20k nodes and should take tens of milliseconds on desktop. A pathological single-file book
  (100k+ words in one XHTML, which is common for Gutenberg or TXT-derived EPUBs) could add hundreds
  of thousands of nodes and take hundreds of milliseconds to over a second on low-end mobile, with
  extra memory. Mitigations:
  - Build fragments off-DOM.
  - Collect first, then mutate.
  - Apply a per-section budget (for example 60k words). Above it, emphasise the first budget
    synchronously and the rest in `requestIdleCallback` chunks; the paginator re-anchors on
    `expand()`.
  - Measure in the perf test described in section 6.
- **Pagination/CFI:** layout happens once, already emphasised, so there is no reflow on chapter
  open. CFIs are made invisible by the filter. Toggling causes one relayout plus a re-anchor, the
  same as changing font size.
- **Highlights/annotations:** the overlayer draws from `Range.getClientRects()`, and ranges spanning
  wrappers work. Stored annotation CFIs are unchanged. `range.toString()` (annotation text, journal
  quotes, dictionary lookups) is unchanged because no characters are added.
- **Search:** unaffected. It parses fresh documents, and live-document resolution goes through the
  filter.
- **Accessibility:** no characters change, so `textContent` is identical. Some screen readers
  (VoiceOver with Safari in particular) may announce a word split across inline elements as two
  fragments. This needs a manual check. The feature is opt-in and off by default, and the
  settings hint can mention it.
- **Cost:** patching vendored foliate (three small edits) and owning the CFI edge cases.

### 4.2 B. CSS Custom Highlight API (`CSS.highlights` + `::highlight()`), no DOM mutation

- **Visual:** `::highlight()` cannot change `font-weight`. Only colour, background, decorations,
  `text-shadow` and stroke-type properties are allowed, so "bold" would be faked with `text-shadow`
  smear or by dimming the tail. That is noticeably different from what users expect, and blurry on
  low-DPI screens.
- **Performance:** one `StaticRange` per word, with no layout invalidation, so toggling is instant.
  Hundreds of thousands of ranges still cost memory and paint time. Range-heavy highlights have
  had performance issues in some engines.
- **Pagination/CFI:** perfect. Nothing in the DOM changes and no foliate patch is needed. The width
  never changes either, so there is no reflow at all.
- **Highlights/search/a11y:** no interaction with annotations or search. Screen readers are fully
  unaffected.
- **Risk:** cross-engine support for the specific properties inside `::highlight` (Firefox shipped
  the API only recently). It would need a spike.
- **Verdict:** the best fallback if maintainers refuse a foliate patch or the perf budget fails. It
  is also a reasonable "low-impact mode" to offer later.

### 4.3 C. String-level transform in `book.transformTarget` (`data` event on XHTML)

- Same output as A, but applied to serialized XHTML before the iframe parses it.
- It needs a regex or DOMParser round-trip per section, which costs more than A.
- Toggling requires reloading sections.
- It interacts with `iframe-loader.js`'s XHTML-to-HTML fallback, which goes to great lengths to keep
  CFIs stable.
- It still needs the same CFI filter.
- **Rejected:** strictly worse than A.

### 4.4 D. Font-based approach (OpenType contextual alternates or a custom font)

- A font cannot reliably know word boundaries across scripts.
- It would replace the user's chosen font and the publisher's embedded fonts.
- Licensing and shipping a font per family is impractical.
- **Rejected.**

---

## 5. File-by-file change list

### Shared types

- `packages/types/src/reader-settings.ts`
  - `EpubReaderSettings`: add `fixationEmphasis: boolean` and `fixationStrength: number`.
  - Add constants `EPUB_FIXATION_STRENGTH_MIN = 0.2`, `EPUB_FIXATION_STRENGTH_MAX = 0.7` and
    `EPUB_FIXATION_STRENGTH_DEFAULT = 0.4`.
  - Add both keys to `EPUB_READER_DEFAULTS` (`false`, `0.4`).

### Server (no migration)

- `server/src/modules/reader-preferences/reader-preferences.service.ts`
  - Add `fixationEmphasis: z.boolean().optional()` and
    `fixationStrength: z.number().min(MIN).max(MAX).optional()` to `EPUB_SETTINGS_SCHEMA`.
  - Optional, not defaulted, for the same reason as `autoAdvance`: a default would pin the key on
    every per-book delta and break full `PUT`s from clients that do not know the keys.
- `server/src/modules/reader-preferences/reader-preferences.service.test.ts`: cases for accept,
  reject out-of-range, accept `unset: ['fixationEmphasis']`, full PUT without the keys still valid,
  and PATCH on defaults merging the keys.
- `server/test/reader-state-isolation.e2e-spec.ts` (or a new
  `reader-preferences-fixation.e2e-spec.ts`): user A's per-book `fixationEmphasis` is invisible to
  user B, and a non-owner PATCH is rejected.
- No controller, DTO, repository or schema change. The DTOs accept `Record<string, unknown>` and
  validation lives in the service.
- No logging change. There are no new non-trivial server operations.

### Client: core and adapter (new)

- `client/src/features/reader/shared/lib/fixation-split.ts` plus
  `__tests__/fixation-split.spec.ts`.
- `client/src/features/reader/epub/lib/fixation-emphasis.ts` plus
  `__tests__/fixation-emphasis.spec.ts`.

### Client: foliate (vendored)

- `client/public/assets/foliate/epubcfi.js`: export the filter and fix `nodeToParts` for skipped
  ancestors and skipped containers.
- `client/public/assets/foliate/view.js`: pass the filter in `getCFI` and `resolveCFI`.
- `client/public/assets/foliate/epub.js`: pass the filter in `resolveCFI`.
- `client/src/features/reader/epub/__tests__/fixation-cfi.spec.ts` (new): golden CFI tests.

### Client: wiring and state

- `client/src/features/reader/epub/composables/useFoliate.ts`: `getFixationOptions` callback,
  applied in the `load` handler for non-fixed-layout docs.
- `client/src/features/reader/epub/composables/useReaderState.ts`: refs, setters, `state` fields,
  clamping setter for strength.
- `client/src/features/reader/ReaderView.vue`: entries in `epubSetters`, the callback passed to
  `useFoliate`, and a `watch` on the two fields that re-applies to open docs, re-anchors to the
  saved CFI, and re-adds annotations. Compute `fixationUnavailable` from `bookLanguage` and the root
  `dir`.
- `client/src/features/reader/shared/composables/useReaderSettings.ts`: sanitize both keys in
  `sanitizeEpubPartialSettings` (boolean; number in range).

### Client: UI and i18n

- `client/src/features/reader/epub/components/ReaderSettingsPanel.vue`: the "Reading aids" group.
- `client/src/features/settings/EbookSettings.vue`: default strength and the "on for all books"
  toggle.
- `client/src/locales/en.json`: new strings (`reader.settings.fixationEmphasis`,
  `fixationEmphasisHint`, `fixationStrength`, `fixationUnavailable`, and the settings-page
  equivalents).

### Client: tests (extend existing)

- `epub/components/__tests__/ReaderSettingsPanel.spec.ts`: renders the toggle, hides the slider
  when off, is hidden for fixed layout, is disabled for RTL/CJK, and emits `update` with the right
  partial.
- `shared/composables/useReaderSettings.test.ts`: sanitizer keeps valid values, drops invalid ones,
  and PATCH sends only the changed key.
- `epub/composables/__tests__/useReaderState.spec.ts`: setters clamp, and `generateCSS()` output is
  unchanged by the new fields.
- `epub/composables/__tests__/useFoliate.spec.ts`: the `load` handler calls the adapter only when
  enabled and not fixed-layout.

### Docs

- A short user-facing note in the reader docs or release notes, if the maintainers want one.

---

## 6. Test plan

### Unit (Vitest, jsdom)

1. `fixation-split`
   - Lengths for 1-12 letter words at min, default and max strength.
   - Grapheme safety: `naïve`, combining marks, emoji ZWJ sequences, and Devanagari conjuncts are
     never split mid-cluster.
   - Hyphenated and apostrophe words; digits-only words.
   - Script detection for Latin, Cyrillic and Greek (on) versus Han, Kana, Hangul, Arabic, Hebrew
     and Thai (off).
   - Behaviour when `Intl.Segmenter` is unavailable.
2. `fixation-emphasis` adapter
   - `textContent` of `body` is byte-identical before and after.
   - Skip list: `pre`, `code`, headings, `ruby`, `svg`, `math`, `[dir=rtl]`, `[lang=ja]` inside an
     English body.
   - Idempotent when applied twice.
   - `remove` restores a tree whose normalized `innerHTML` equals the original.
   - Strength change re-splits correctly.
   - A live `Range` spanning a word stays valid after `remove` + `normalize`.
3. **Golden CFI tests (the critical suite).** Load several real fixture XHTML documents into jsdom:
   existing fixtures from `epub/__tests__`, one KEPUB with `koboSpan`s, and one with nested inline
   markup, footnotes and `id`s. Then:
   - For every text node and a sample of offsets, compute `CFI.fromRange(range)` on the original,
     then apply the transform and compute `CFI.fromRange(equivalentRange, filter)`. Assert strict
     string equality.
   - Round-trip `toRange(transformedDoc, parse(cfi), filter)` and assert that `toString()` and the
     text position match.
   - Cover range containers that are a wrapper element itself, and ranges starting at offset 0 of
     a wrapper.
   - Run `getReadingProgressRange` + `getCFI` on a page-start range whose first text node is inside
     a wrapper.
   - With the feature off, CFIs are unchanged from today (regression guard for everyone).
4. Settings: server zod cases, client sanitizer, and panel component tests as listed in section 5.
5. Perf guard: a synthetic 100k-word section must transform under a generous jsdom budget. This
   catches accidental O(n^2) behaviour; real numbers come from browser checks.

### Server e2e (`server/test`)

- PATCH and GET per-book and defaults with the new keys, plus ownership and isolation between
  users.

### Manual, in Chrome, Firefox, Safari desktop and iOS Safari (PWA)

- Open a book mid-chapter with emphasis on: the restore position is correct, and the page is not
  shifted after the first paint.
- Toggle on and off, and change strength: the position is kept and highlights redraw in place.
- Create a highlight and bookmark with emphasis on. Reopen with emphasis off and the highlight
  lands on the same text. Then sync a KOReader device and a Kobo, and check that positions match.
- Search: hits highlight the right words with emphasis on.
- TTS and EPUB3 read-along: block and sentence highlights still track.
- Dictionary and translation popovers on a word whose head is wrapped.
- Copy and paste a selection: plain text is unchanged (rich paste may carry bold; see 8.6).
- Books with RTL (Arabic/Hebrew) and CJK metadata: the toggle is disabled. A mixed-language English
  book with Japanese quotes: Japanese runs are untouched.
- Fixed-layout EPUB: the controls are hidden and there is no transform.
- Very large single-file EPUB: measure `performance.now()` around the transform on a mid-range
  Android phone and an older iPhone, against the budget in 4.1.
- Screen reader smoke test: VoiceOver with Safari, NVDA with Firefox, TalkBack with Chrome.

### Required checks before commit (per AGENTS.md)

- `cd server && npx prettier --write . && npx eslint .`
- `cd client && npx prettier --write . && npx eslint .`
- `pnpm --filter client type-check`
- Targeted Vitest runs for both workspaces.

---

## 7. DB and migration needs

**None.** Both settings tables store `jsonb` (`reader_default_preferences.settings`,
`reader_preferences.settings`). They are already user-scoped by `user_id` and keyed per format group
or per book file. Adding optional keys requires:

- the shared type and default change in `packages/types`;
- the zod schema change in `ReaderPreferencesService` (strict schema, so this is mandatory);
- the client sanitizer change.

Existing rows without the keys fall back to `EPUB_READER_DEFAULTS` through the client merge.
`pnpm db:generate` should produce no diff, which is worth confirming during implementation.

---

## 8. Risks and open questions for maintainers

### Risks

1. **Position drift if any CFI path misses the filter.** A missed `fromRange`/`toRange` call would
   write CFIs that do not match the original XHTML, corrupting progress and annotations that then
   sync to KOReader, Kobo and the iOS app. Mitigations:
   - All CFI calls go through `view.js` and `epub.js` (verified by grep).
   - The filter is a no-op when the feature is off.
   - Golden equality tests cover the path.
2. **Performance and memory on huge single-section books**, especially in iOS Safari and on low-end
   Android. Mitigations: off by default, the per-section budget with idle continuation, and
   measurement before merge.
3. **Owning a patch in vendored foliate-js.** This adds to the existing local divergence and must be
   carried through any future foliate update. The patch is small and localized (`epubcfi.js`
   `nodeToParts`, plus three call sites).
4. **Screen-reader word splitting** across inline elements in some engines. This needs manual
   verification. If it is bad, approach B (no DOM change) becomes the safer default.
5. **Native app parity and settings sync.** The iOS app is not in this repo and "owns the look
   fields". The web reader will store `fixationEmphasis` in synced settings, and iOS will ignore it
   until it implements the feature. Swift `Codable` ignores unknown keys by default, but this should
   be confirmed with whoever maintains the app. Users may expect the toggle to follow them to iOS.
6. **Rich copy carries bold spans.** Pasting a copied passage into a rich editor may bring the
   emphasis with it. A `copy` handler could force plain text, but that changes existing copy
   behaviour.

### Open questions

1. **Formats:** the `epub` reader group also opens MOBI, AZW3, FB2 and TXT through foliate. Should
   fixation emphasis apply to all reflowable foliate formats (my recommendation: same code path,
   no extra cost) or EPUB only as the issue states?
2. **Scope of strength edits inside the reader:** keep today's rule that every in-reader change is a
   per-book delta (consistent, but strength becomes per book too), or have the reader's strength
   slider write the account default and keep only on/off per book (closer to the issue's wording)?
3. **"On for all books" default:** allow an account-level default of `fixationEmphasis: true` in
   Settings > Ebook, or keep the issue's "off by default, toggled per book" strictly?
4. **Foliate patch policy:** are maintainers comfortable with the `epubcfi.js`/`view.js`/`epub.js`
   patch, or would they prefer approach B (CSS Custom Highlight API, faux bold, zero DOM mutation)
   even with the weaker visual?
5. **Naming:** is "Fixation emphasis" acceptable for the UI label, or would something like "Word
   anchors" read better for translators?
6. **Headings and links:** the issue says to skip headings. Should links, table cells, captions and
   footnotes be emphasised? The plan emphasises them; headings and code are skipped.
7. **iOS and Android parity:** do the maintainers want the setting to sync now (stored but ignored
   by native clients) or to stay web-local until native support lands?

---

## 9. Reuse for RSVP (coordination with the RSVP plan)

The RSVP mode is planned separately. Fixation emphasis provides what it needs as follows:

- **Shared core:** RSVP imports `segmentWords()` and `splitForFixation()` from
  `features/reader/shared/lib/fixation-split.ts`. Tokenizing with the same segmenter keeps RSVP
  tokens and fixation units identical: same word boundaries, same grapheme safety, same script
  exclusions.
- **Rendering a flashed word or chunk:** no DOM transform is needed. The RSVP component renders
  `<span class="font-bold">{{ head }}</span>{{ tail }}` per word in a Vue template. For a
  multi-word chunk it maps over `segmentWords(chunk)`. The optimal recognition point (ORP) letter
  highlight is computed by RSVP on the same grapheme array, so both can mark the same word without
  conflicting. For example, the ORP letter is coloured while the head is bold.
- **Same strength setting:** RSVP reads `effective.fixationStrength` from `useReaderSettings`, as
  the issue requires. The combined-mode toggle (for example `rsvpFixationEmphasis`, off by default)
  belongs to the RSVP plan's settings keys and follows the same optional-zod-key pattern described
  here.
- **Script exclusions:** RSVP can call `isEmphasisableScript()` per token and skip the bold head
  for CJK or RTL words while still flashing them.
- **Positions:** RSVP builds its text stream from the live document or `createDocument()`. Any CFI
  it writes back on exit goes through the same filtered `getCFI`, so emphasis being on in the page
  view does not affect RSVP's written position.

If both features are approved, the split core should land first, in the fixation PR, so RSVP can
build on it.

---

## 10. Effort estimate

**Size: M. About 7 working days for one experienced developer (range 6-9).**

| Work item | Days |
| --- | --- |
| Pure split core plus unit tests | 0.75 |
| DOM adapter, skip rules, style injection, remove/normalize, unit tests | 1.25 |
| Foliate CFI filter patch plus golden CFI suite | 1.5 |
| Settings plumbing (types, zod, sanitizer, state, ReaderView wiring, live re-apply and re-anchor) | 1.0 |
| UI (reader panel, Ebook settings page, i18n) plus component tests | 0.75 |
| Server unit and e2e tests | 0.5 |
| Cross-browser, mobile, perf and screen-reader manual testing, fixes | 1.0 |
| Review iterations | 0.5-2 |

Unknowns that could push it toward L: the screen-reader check fails and approach B has to be
prototyped as well, or large-section performance needs the idle-continuation path tuned on real
devices.

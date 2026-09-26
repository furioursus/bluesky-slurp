# Web UI

**TL;DR:** an Astro 7 app rendered on the server by the Node adapter (`npm run dev`, `npm run serve`). Pages read archives straight from disk and arrive fully rendered. Astro's `ClientRouter` swaps pages in place, so navigation feels like an SPA with no reloads, while every page is still server-rendered HTML. The browser runs a little JavaScript for the router, the job panel, handle autocomplete, the theme, blur and font controls, the thread-roots toggle, scroll keeping and click-to-reveal on sensitive media. It's local-only on purpose, and it never renders archived text as HTML.

## Structure

**TL;DR:** `src/lib/` is the engine the CLI and UI share, `src/pages/` is routes and API endpoints, `src/components/` holds components that each own their CSS, and `src/styles/` holds tokens and shared primitives.

```
src/
  lib/            engine (archive, analyze, refs, identity, http, media, cli) + UI helpers (archives, jobs, appview, format, ui, scroll, media-view, serve, thumbs, blur, fonts)
  middleware.ts   same-origin check for non-GET requests
  layouts/        Base (html shell, ClientRouter, masthead, theme/blur/font controls, scroll keeper) · AccountLayout (header + tabs, 404 when not archived)
  components/
    ui/           Grid · Cell · Section · Stat · Tabs · Check · Ext · People · Chips · EmptyState
    jobs/         JobRunner (the only real island) · ArchiveForm · HandleInput · AnalysisActions · NoReport · UpgradeReport
    report/       HeadlineStats · ShapeSection · HoursChart · TargetingSection · InterestsSection
    records/      CollectionList · Pager · RootsToggle · RecordCard · RefList · PostEmbed · EmbedMedia · MediaThumbs
    media/        MediaWall · MediaFilters · MediaDownload · MediaViewer
    account/      AccountHeader · AccountGrid
  pages/          / · /accounts · /about · /a/[handle] · /a/[handle]/[snapshot]/{report,records/[...collection],media,media/[cid],identity}
                  /blobs/[handle]/[file] · /thumbs/[handle]/[file] · /api/jobs · /api/jobs/[id]/events · /api/typeahead
  styles/         global.css (tokens + primitives) · media.css (the one breakpoint)
```

- The CLI still runs with plain Node (`node src/lib/cli.ts`), with no Astro involved. `src/lib/*` keeps `.ts` import extensions and erasable-only TypeScript for that reason.
- `@astrojs/check` pins TypeScript to 5–6, so the project uses TypeScript 6.

## Security

**TL;DR:** it binds to `127.0.0.1` (Astro `server.host`, plus `HOST` in `npm run serve`), middleware rejects cross-origin non-GET requests, path segments are allowlisted. The server writes to disk and runs jobs, so nothing outside this machine may reach it.

- **Bind address:** `127.0.0.1`, never `0.0.0.0`. Exposing it remotely needs real auth in front (see the parked Cloudflare Access plan in project memory), not a flag flip.
- **Origin check:** `src/middleware.ts` returns 403 for any non-GET request whose `Origin` host doesn't match the request host. This stops a malicious page from POSTing jobs here. It skips prerendered routes, which can't receive POSTs. Behind a tunnel this still holds, because it compares hosts rather than full origins.
- **Paths:** handle, snapshot, collection and blob names must match `^[A-Za-z0-9._:-]+$` and resolve inside the archive root (`SAFE_NAME` in `src/lib/archives.ts`). Blob and thumbnail paths also go through `accountPath` in `src/lib/serve.ts`, which rejects any name that resolves outside `archives/<handle>/blobs/` or `thumbs/` (a handle of `..` matches the allowlist).

## Rendering untrusted text

**TL;DR:** archived posts are attacker-controlled. Astro escapes every `{expression}`, so render record content only through expressions and never with `set:html`. Links go through `Ext` / `safeHref`, which allow only `http(s)`, `/` and `#`.

- The one client script that writes archive-derived text (`JobRunner`'s log) uses `textContent` only.

## Jobs

**TL;DR:** `JobRunner` wraps a form. On submit it POSTs `/api/jobs`, clones a server-rendered `<template>` for the panel, and streams progress over SSE.

| route | purpose |
|---|---|
| `POST /api/jobs` | start `archive`, `analyze` or `media` (`{ mode, input, snapshot?, media?, analyze? }`) |
| `GET /api/jobs/:id/events` | SSE. Each event carries an `id`, and a reconnect with `Last-Event-ID` resumes rather than replaying |
| `GET /blobs/:handle/:file` | downloaded media; `?download` adds `content-disposition: attachment` |

- Jobs live in memory in the server process and are dropped an hour after they start.
- When a job finishes, the page refreshes through the router (`navigate(current URL, { history: 'replace' })`) and keeps your scroll position. An archive job instead offers an "Open" link to the new snapshot.
- Navigating away mid-job closes the panel's event stream (`disconnectedCallback`). The job itself keeps running on the server.
- Astro allows one dev server per project. To test against another archive root, build and run `dist/server/entry.mjs` with `SLURP_ARCHIVES` and `PORT` set.

## Embeds

**TL;DR:** likes, reposts and reply parents (plus thread roots when the `slurp-roots` cookie is set) show the target post, fetched server-side from the public AppView in batches of 25 and cached for 10 minutes. `undefined` means the AppView couldn't be reached; `null` means it has no such post. Those render differently.

- `null` renders as "Post unavailable": deleted, taken down, or hidden from logged-out viewers. The pointer still records which post it was.
- `undefined` renders as "Couldn't load this post" with a link to bsky.app. A network failure must never be presented as a deletion.
- Pointer labels resolve DIDs to `@handles` server-side too (`getHandles`, same cache).
- Images on posts or authors labelled `porn`, `sexual`, `nudity`, `graphic-media` or `gore` are blurred until clicked, unless blur is off. See [Sensitive media](#sensitive-media).
- Media not on disk loads from the account's PDS (the user's choice).

## Fonts

**TL;DR:** no web fonts. Text uses a [Modern Font Stacks](https://github.com/system-fonts/modern-font-stacks) stack, Neo-Grotesque by default (Inter, Roboto, Helvetica Neue, Arial…). The **font** control next to day/night and blur switches the whole page between all 15 stacks, remembered per browser. Code and IDs always use the Monospace Code stack (`--mono`).

- **Catalogue:** `FONT_STACKS` in `src/lib/fonts.ts`, copied verbatim from the Modern Font Stacks README. The first entry is the default. The Neo-Grotesque stack is also the `--font` default in `global.css`, for pages rendered with JavaScript off. Keep the two identical.
- **What you get depends on the device:** each stack names system fonts and falls back through them, so Industrial is Bahnschrift on Windows but DIN Alternate on macOS. DIN Alternate only ships in bold, so on a Mac that stack renders every weight bold. Several stacks lack the 300 weight the headings and inputs use, and the browser picks the nearest.
- **Picker:** a native `popover` above the corner, holding a radio group with each name shown in its own stack. Arrow keys switch fonts live, Escape or clicking outside closes it, and it opens focused on the current font. Its bottom edge sits on the toggles' top border, so there's one line, not two.
- **Before paint:** the inline script in `Base.astro` reads `slurp-font`, sets `--font` and `data-font` on `<html>`, and sizes the wordmark (next bullet). It gets the catalogue via `define:vars`, which `astro check` can't see, hence its two "could not find name 'fonts'" hints. It duplicates `applyFont` in `fonts.ts` because inline scripts can't import, so keep them in step. An unknown saved key falls back to the default.
- **Wordmark:** "SLURP" is sized from its glyph width (see [Masthead](#masthead)), which differs per font, so both the inline script and `applyFont` measure it with canvas `measureText` at 100px and set `--wordmark-glyphs`. System fonts need no loading, so the measurement is right the first time. Checked with Neo-Grotesque, Industrial, Didone, Monospace Code and Handwritten: the ink width matched the cell's content width (523px) every time, with no horizontal overflow.
- **Across swaps:** `FontPicker` copies `data-font`, `--font` and `--wordmark-glyphs` onto the incoming document in `astro:before-swap`, like the theme and blur. The picker itself is `transition:persist`.
- **Privacy:** removing Google Fonts means pages make no third-party request for type.

## Handle autocomplete

**TL;DR:** the handle box on the home page suggests up to 8 accounts as you type: up to 3 already-archived accounts first (tagged "archived"), then Bluesky's public typeahead. Pick with the mouse or ↑/↓ + Enter. Picking fills the box and doesn't submit.

- **Route:** `GET /api/typeahead?q=` (`src/pages/api/typeahead.ts`). Local matches come from `listAccounts` (handle or display name contains the query, prefix matches first). Remote matches come from `app.bsky.actor.searchActorsTypeahead` on the public AppView via `searchActors` in `src/lib/appview.ts`, 5 s timeout, cached per query for 10 minutes. Duplicates are dropped by DID. `offline: true` means the AppView couldn't be reached and only local matches came back.
- **What leaves the machine:** the typed text, debounced 150 ms, goes from this server to `public.api.bsky.app`. The browser only talks to this server, but avatars load from Bluesky's CDN, the same as embeds do.
- **Skipped queries:** empty text, anything starting `did:`, and anything with a `/` (profile URLs) never trigger a lookup, because the archiver resolves those itself. A leading `@` is stripped and queries are capped at 64 characters.
- **Untrusted text:** display names and handles are set with `textContent` and avatars must be `https://`, in keeping with [Rendering untrusted text](#rendering-untrusted-text).
- **Sensitive avatars:** an account self-labelled with a [sensitive](#sensitive-media) label shows an empty avatar box while blur is on.
- **Accessibility:** ARIA 1.2 combobox. The input has `role="combobox"`, `aria-expanded` and `aria-activedescendant`, the list is a `listbox` of `option`s, a polite live region announces the suggestion count, and Escape or leaving the field closes the list. Stale responses are dropped, so a slow reply can't overwrite newer suggestions.

## Design

**TL;DR:** a brutalist grid modelled on brutalist.design's "Brutal" template: 1px ink hairlines made by `gap: 1px` over an ink background, system font stacks (see [Fonts](#fonts)), uppercase headings, no radius or shadow, light and dark themes. Media and avatars show in full colour (the reference's grayscale-until-hover was dropped on 2026-09-25); only the sensitive-media blur stays grey. Tokens are global, and every component owns its own CSS.

- **Tokens:** every length, size, type step, tracking and leading value is a custom property on `:root` in `src/styles/global.css`. Rules use `var(--…)` or a `calc()` of tokens. Inline `style` is reserved for data-driven values: chart bar widths and heights, and the font picker's per-option sample and the `--font` / `--wordmark-glyphs` it sets on `<html>`.
- **One page breakpoint:** `@custom-media --narrow` in `src/styles/media.css` (which also holds `--hover-motion`, see [Hover previews](#hover-previews)), injected into every stylesheet by `@csstools/postcss-global-data` + `postcss-custom-media` (see `postcss.config.mjs`). Components write `@media (--narrow)`, and `860px` appears exactly once. The masthead is the exception: it responds to its own width with a container query (see [Masthead](#masthead)).
- **Scales:** spacing `--space-3xs` to `--space-xl` (2px to 32px), type `--text-2xs` to `--text-lg` plus four fluid display sizes, tracking `--track` / `--track-wide`, and `--control` (2.75rem) as the minimum tap target.
- **Scoped styles:** a component's `<style>` is scoped to its own template. `Grid` and `Cell` spread their props onto their root element, so a parent's scope attribute reaches them and `class` passed from a parent stays styleable. Use `:global()` only for classes applied through `Ext` (`blurred`, `link-card-link`).
- **One line, never two:** a grid nested inside a cell drops its own bottom border (`.cell .grid`), since the outer grid already draws that edge. Nested content that needs lines should be full-bleed cells in the same grid, not a grid floating inside padding. A 2-column grid with an odd number of cells stretches the last one across the row, so the ink background never shows through as a black block.
- **Toggle clearance:** the day/night toggle is fixed bottom-left like the reference, with the blur toggle and font picker beside it (same `.corner-toggle` box, sharing one line). `body` has bottom padding so the last row can always scroll clear of it, after it was found covering the Proceed button.
- **Theme before paint:** an inline script in `Base.astro` applies the saved theme before first paint so night mode doesn't flash white. On router swaps the router copies the new page's `<html>` attributes, which would drop `data-theme`, so `ThemeToggle` writes the current theme onto the incoming document in `astro:before-swap`. The toggle itself is `transition:persist`.
- **Scroll:** see [Scroll](#scroll).
- **Stale component modules in dev:** after editing an `.astro` file, Astro 7's dev server has twice served the old compiled `<style>` or `<script>` for that component (fetched with `cache: no-store`), while the file watcher reported the change and the markup updated. If an edit seems to do nothing, restart `npm run dev` before debugging the code. A production build never has this problem.

## Media

**TL;DR:** the Media tab (`/a/<handle>/<snapshot>/media`) is a wall of every downloaded file, filterable by type and source collection, 15 · 30 · 60 · 120 · 240 · 480 per page (default 60, remembered). Each file has a detail page with a viewer, alt text, size, download, and every record that uses it. Snapshots archived without media get a "Download media" job instead of an empty wall.

- **Index:** `src/lib/media.ts` scans the snapshot's records once for blob refs and caches the result as `media-index.json` in the snapshot (about 200ms to build, around 10ms from cache). Each entry has the CID, MIME type, file name, latest use, and every use: the record, role (JSON path), alt text, text and self-labels. See [archive-format.md](archive-format.md#media).
- **What's "downloaded":** whatever is in `archives/<handle>/blobs/` right now, checked per request. The Records tab uses the same check, so media downloaded after the archive (via the job or `slurp media`) shows locally there too. The `local` field on refs only reflects `--media` at archive time and isn't used for display.
- **Download job:** `mode: 'media'` runs `downloadSnapshotMedia`, which downloads every file the snapshot references that isn't already on disk, 4 at a time, then updates `manifest.media`. Same as `slurp media <handle>` on the CLI.
- **Per page:** a doubling ladder around the default, `PER_PAGE_STEPS` in `src/lib/media-view.ts`. The choice rides in `?per=` so links are explicit, and the wall saves it in the `slurp-media-per` cookie so a later visit without `?per=` uses it. Changing the size keeps the first visible tile on the new page (`pageStart`).
- **Nothing on the Media tab resets scroll:** the type tabs, source picker, per-page picker, pager (both copies) and newest/oldest toggle all keep your position, and so do the detail page's Prev/Next and ←/→. See [Scroll](#scroll).
- **Detail navigation:** Prev/Next and ←/→ step through the current filter with `history: 'replace'`, so the wall stays one Back away. "All media" and Esc go back in history when you came from the wall, which restores its scroll. Otherwise they navigate to the page of the wall that contains the file.
- **Sensitive media:** blurred on the wall and in the viewer until clicked, unless blur is off. See [Sensitive media](#sensitive-media).
- **Tiles are thumbnails:** the wall and the Records tab load `/thumbs/`, never the originals. See [Thumbnails](#thumbnails).
- **Empty filters:** the current type tab always shows, even at 0, and an empty result says what matched nothing, with links to widen it. The wall isn't rendered when there are no tiles, which avoids a doubled rule.
- **Tiles:** `repeat(auto-fill, minmax(--tile, 1fr))` with per-tile right and bottom borders, clipped by the wall's `overflow: hidden`, so a partial last row doesn't leave ink blocks the way the `gap` hairline trick would.

## Thumbnails

**TL;DR:** tiles load a 640px WebP from `/thumbs/<handle>/<file>` (about 40 KB) instead of the original (median 574 KB, up to 8 MB). Videos get a still poster frame instead of a `<video>` element. On one large archive this took a 60-tile page from 77 MB and 15–30 s of blank tiles to 2.4 MB, fully drawn in 1.6 s from cold.

- **Why videos matter most:** a `<video preload="metadata">` tile holds its HTTP/1.1 connection open for 15–30 s. The browser allows 6 connections per host, so a page with 6+ video tiles made every image behind them wait in the queue and show blank. Measured: 11 video tiles, every image request queued for 15.2 s, server time 2 ms.
- **What gets made:** `src/lib/thumbs.ts`. JPEG, PNG, WebP and AVIF go through `sharp` (auto-rotated from EXIF, shortest side 640px, never enlarged). MP4, MOV and WebM have the frame at 0.1 s pulled by `ffmpeg`, then the same resize.
- **Cache:** made on first request into `archives/<handle>/thumbs/<file>.webp` and reused after (see [archive-format.md](archive-format.md#layout)). Concurrent requests for one file share a single render. Delete the folder to rebuild them. Roughly 40 KB per file, so about 80 MB for a 2,000-file archive viewed in full.
- **Fallbacks:** a GIF, HEIC or anything else `sharp` can't read redirects to the original. A video with no poster (no `ffmpeg` on `PATH`, or a broken file) returns 404, and the tile shows just its ▶ badge.
- **Caching headers:** blobs and thumbnails are named by CID, so both are served `private, max-age=31536000, immutable`.
- **Records tab:** local images use the thumbnail and link to the original. Local videos keep their player, with the poster and `preload="none"`, so nothing downloads until you press play.
- **Needs:** `sharp` (a direct dependency) and `ffmpeg` on `PATH` for video posters.

## Hover previews

**TL;DR:** on the media wall, hovering a tile zooms its thumbnail to 115% (`--zoom`, over `--zoom-time`), and hovering a video tile plays the video muted, looped and zoomed over its poster. Moving away stops it and frees the connection. Mouse and keyboard focus only.

- **Only when it makes sense:** everything is gated on `(hover: hover) and (prefers-reduced-motion: no-preference)`: `--hover-motion` in `src/styles/media.css` for the CSS, and the same string as `HOVER_MOTION` in `MediaWall`'s script. Keep the two in step. Touch taps never start a preview, and reduced-motion users get neither zoom nor playback.
- **Built on hover, never in the markup:** a `<video>` in every tile is what made the wall blank (see [Thumbnails](#thumbnails)). The preview `<video class="preview">` is created on `pointerover` or `:focus-visible` from the tile's `data-preview` URL and destroyed on leave with `pause()`, `removeAttribute('src')`, `load()`, so the browser drops the connection. Checked: after hovering 10 video tiles in a row, 0 previews were left over and 12 thumbnails fetched in 59 ms.
- **No flash:** the preview stays at opacity 0 until its `playing` event, so the poster shows until real frames arrive. It's inserted before the ▶ badge so the badge stays on top.
- **Always silent:** `muted`, no `controls`, `aria-hidden` (the tile link is what's announced).
- **Blur wins:** a blurred tile never previews while blur is on. Click to reveal it, or switch blur off, and it previews like any other.
- **Router swaps:** every preview is torn down on `astro:before-swap`.
- **Scope:** the media wall only. Records-tab thumbnails and players are unchanged.

## Sensitive media

**TL;DR:** media whose records self-label `porn`, `sexual`, `nudity`, `graphic-media` or `gore` renders with the `blurred` class. The **blur** toggle next to day/night turns the blur off everywhere. It's remembered per browser, and it's on by default.

- **Where it applies:** the media wall, the media viewer, and embed images in Records (`MediaWall`, `MediaViewer`, `EmbedMedia`, `PostEmbed`).
- **Click to reveal:** with blur on, clicking a blurred item removes its blur instead of following the link (`SensitiveReveal`). With blur off, clicks go straight through.
- **How it's switched:** `BlurToggle` sets `data-blur="off"` on `<html>` and saves `slurp-blur` in `localStorage`. The blur rules only match `:root:not([data-blur='off'])`, so switching needs no server round trip or navigation and never moves the scroll. The global rules are wrapped in `:where()` so they keep the low specificity that lets components like `.tile` override `display` and `min-width`.
- **Before paint and across swaps:** the same inline script that applies the theme applies `data-blur` before first paint, and `BlurToggle` copies it onto the incoming document in `astro:before-swap`, just like the theme. The server never sees the setting.
- **In practice:** on one archive, 48% of files were self-labelled, so with blur on about half the wall reads as grey smudges with a "Sensitive · click to show" tag.

## Source links

**TL;DR:** wherever a record is shown (Records tab, media "Used in"), it links back to where it lives: first any URL the record itself carries, then the app's own page from a pattern registry (`src/lib/sources.ts`), then always the raw record on pdsls.dev. Each link says how it was established: stored in the record, verified against a real page, or estimated (`≈`).

| kind | shown as | meaning |
|---|---|---|
| `record` | host name, e.g. `furioursus.pckt.blog ↗` | a URL stored in the record (`url`, `originUrl`, `website`; Bluesky status → its linked stream) |
| `verified` | app name, e.g. `Popfeed ↗` | the pattern was opened for a real record and the page was specific to it |
| `estimated` | `≈ Rocksky ↗` | from source code, docs, or analogy. May not resolve |
| `raw` | `Record ↗` | pdsls.dev record viewer, always last, so a wrong guess is never a dead end |

| app | pattern | confidence |
|---|---|---|
| Bluesky | posts, feeds, lists, starter packs, profiles (via `webUrlForUri`); status → profile | verified |
| Popfeed | `/profile/{handle}`, `/review/at:/{did}/…/{rkey}`, `/list/at:/{did}/…/{rkey}`; list item → its list (from `listUri`) | verified (browser; the site is client-rendered) |
| Currents | `/profile/{handle}`, `/profile/{handle}/save/{rkey}` | verified |
| Grain | `/profile/{handle}` · galleries `/profile/{handle}/gallery/{rkey}` | verified · estimated (from their route tree) |
| atmoBB | `/members/{handle}`; thread → its board `/b/{board rkey}` (from `board`) | verified. Thread URLs need the board and title slugs, and made-up slugs return a 500 |
| Tangled | `tangled.org/{handle}`, `/{handle}/{rkey}` for repos | verified (tangled.sh redirects here; `/@handle` redirects to `/handle`) |
| Rocksky | `/profile/{handle}` · `/{did}/{song,scrobble,album,artist}/{rkey}` | verified · estimated |
| Sifa | `sifa.id/p/{handle}` | verified |
| WhiteWind | `/{handle}`, `/{handle}/{rkey}` | verified |
| Frontpage | `/profile/{handle}` | verified |
| Flushes | `flushes.app/profile/{handle}` | verified |
| Smoke Signal, Linkat | `smokesignal.events/{did}/{rkey}`, `linkat.blue/{handle}` | estimated |
| teal.fm, Streamplace, Anisota, bsky38 | none: no public per-user or per-record pages found | record viewer only |

- **Profile fallback:** a record with no page of its own, in an app with a known profile page, links to the profile as "`<App>` profile". That's skipped when the record already links to its own place in the app (a Popfeed list item, an atmoBB thread).
- **Researched 2026-09-25**, spot-checked by page title against `furioursus.dev`'s real records. Apps change routes, so re-check before trusting an old "verified".
- **Adding an app:** add an entry under its NSID namespace (first two segments) in `APPS`, with `verified(...)` only after opening the URL for a real record and seeing that record's content. For links that need data from the record, add a `RECORD_DERIVED` entry. Media uses store record links in `media-index.json`, so bump `INDEX_VERSION` in `src/lib/media.ts` when those change.

## Scroll

**TL;DR:** `ClientRouter` scrolls to the top after every page swap. Links inside a `data-keep-scroll` container (the collections list and the time-window tabs) keep your place instead. `src/lib/scroll.ts` captures the page's scroll plus every `data-scroll-id` pane's inner scroll when you click such a link, then restores it in `astro:after-swap`, before the browser paints.

- **Why `after-swap`:** the router swaps the DOM, scrolls to the top, and dispatches `astro:after-swap` in one synchronous step (`moveToLocation` then `triggerEvent` in `astro/dist/transitions/router.js`). Restoring there means the top-of-page frame never paints. A restore after load, as the earlier sessionStorage version did, always showed one frame at the top: that was the jump.
- **Not persisted on purpose:** the collections list isn't `transition:persist`, because a persisted element keeps its old `aria-current` highlight. Its inner scroll is carried across the swap instead.
- **Programmatic refreshes:** the thread-roots toggle and finished jobs call `keepScrollOnNextSwap()` before `navigate()`, so they refresh in place too.
- **Where it's on:** the collections list, the report's time-window tabs, and everything on the Media tab (type tabs, per-page picker and pager through `data-keep-scroll`; the source picker and the detail page's Prev/Next through `keepScrollOnNextSwap()`). `Pager` takes a `keepScroll` prop.
- **Deliberately not kept:** the Records pager and the account tabs (Report / Records / Media / Identity), where a new page or section should start at the top. Opening a media tile also starts at the top, so the viewer is on screen. Back and forward use the router's own saved position.
- **Adding it elsewhere:** put `data-keep-scroll` on the link container, and `data-scroll-id="<name>"` on any inner scrolling pane that should keep its own position.
- **Prefetch:** hover prefetch is on for all links (`prefetch` in `astro.config.mjs`). `Ext` links (external sites and media) opt out, so hovering a video doesn't download it.
- **Verified:** `feed.like` → `feed.repost` kept 480px / 120px, and `graph.follow` kept 620px / 200px, already restored at `after-swap`. The roots toggle kept 900px. A finished job refreshed at 4497px. The pager and the account tabs went to 0, back returned to 700, and night mode stayed on through 6 swaps. The whole run stayed in one document.

## Masthead

**TL;DR:** the masthead sizes itself from container queries, not the viewport. The `<header>` is a `masthead` container, so the grid inside collapses when the masthead itself is under `54rem`. The wordmark cell is its own `inline-size` container, and "SLURP" is set in `cqi` so its visible ink fills the cell's content width exactly, at any layout.

- **Why a wrapper:** a container query can't style the container itself, only its descendants. `<header class="masthead">` is the container, and the grid (`.bar`) inside it is what changes columns.
- **Wordmark fill:** `font-size = 100cqi / (glyphs + gaps × tracking)`. `--wordmark-glyphs` is measured at runtime for whichever font is active (see [Fonts](#fonts)): about `3.259em` in Helvetica Neue, which is also the CSS fallback. The 4 gaps between letters are `0.55em` of tracking each. The 5th tracking gap trails after the last letter as empty space and is clipped by `overflow: hidden`, which also keeps the page from scrolling sideways.
- **Changing the text:** update `WORDMARK` in `src/lib/fonts.ts` along with the markup, and `--wordmark-gaps` if the letter count changes. Fonts need nothing, since the width is measured live.
- **The one literal:** `@container masthead (width < 54rem)`. Container conditions can't read custom properties, and `postcss-custom-media` only handles `@media`. The threshold is the masthead's own need (three columns stop fitting), not the page breakpoint, so it lives only in `Masthead.astro`.
- **Measured fill:** the ink width equals the cell's content width at 375, 567, 860, 870, 1280 and 1920px, with no horizontal overflow at any of them.
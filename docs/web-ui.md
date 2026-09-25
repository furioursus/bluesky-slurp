# Web UI

**TL;DR:** an Astro 7 app rendered on the server by the Node adapter (`npm run dev`, `npm run serve`). Pages read archives straight from disk and arrive fully rendered. Astro's `ClientRouter` swaps pages in place, so navigation feels like an SPA with no reloads, while every page is still server-rendered HTML. The browser runs a little JavaScript for the router, the job panel, the theme toggle, the thread-roots toggle, scroll keeping and click-to-reveal on sensitive media. It's local-only on purpose, and it never renders archived text as HTML.

## Structure

**TL;DR:** `src/lib/` is the engine the CLI and UI share, `src/pages/` is routes and API endpoints, `src/components/` holds components that each own their CSS, and `src/styles/` holds tokens and shared primitives.

```
src/
  lib/            engine (archive, analyze, tone, refs, identity, http, cli) + UI helpers (archives, jobs, appview, format, ui, scroll)
  middleware.ts   same-origin check for non-GET requests
  layouts/        Base (html shell, ClientRouter, masthead, theme toggle, scroll keeper) · AccountLayout (header + tabs, 404 when not archived)
  components/
    ui/           Grid · Cell · Section · Stat · Tabs · Check · Ext · People · Chips · EmptyState
    jobs/         JobRunner (the only real island) · ArchiveForm · ToneControls · AnalysisActions · NoReport · UpgradeReport
    report/       HeadlineStats · ToneStat · ShapeSection · HoursChart · TargetingSection · ToneSection · InterestsSection
    records/      CollectionList · Pager · RootsToggle · RecordCard · RefList · PostEmbed · EmbedMedia · MediaThumbs
    account/      AccountHeader · AccountGrid
  pages/          / · /accounts · /about · /a/[handle] · /a/[handle]/[snapshot]/{report,records/[...collection],identity}
                  /blobs/[handle]/[file] · /api/jobs · /api/jobs/[id]/events · /api/jobs/[id]/confirm
  styles/         global.css (tokens + primitives) · media.css (the one breakpoint)
```

- The CLI still runs with plain Node (`node src/lib/cli.ts`), with no Astro involved. `src/lib/*` keeps `.ts` import extensions and erasable-only TypeScript for that reason.
- `@astrojs/check` pins TypeScript to 5–6, so the project uses TypeScript 6.

## Security

**TL;DR:** it binds to `127.0.0.1` (Astro `server.host`, plus `HOST` in `npm run serve`), middleware rejects cross-origin non-GET requests, path segments are allowlisted, and the API key stays server-side. The server writes to disk and can spend Claude credits, so nothing outside this machine may reach it.

- **Bind address:** `127.0.0.1`, never `0.0.0.0`. Exposing it remotely needs real auth in front (see the parked Cloudflare Access plan in project memory), not a flag flip.
- **Origin check:** `src/middleware.ts` returns 403 for any non-GET request whose `Origin` host doesn't match the request host. This stops a malicious page from POSTing jobs here. It skips prerendered routes, which can't receive POSTs. Behind a tunnel this still holds, because it compares hosts rather than full origins.
- **Paths:** handle, snapshot, collection and blob names must match `^[A-Za-z0-9._:-]+$` and resolve inside the archive root (`SAFE_NAME` in `src/lib/archives.ts`).
- **API key:** `npm run dev` and `npm run serve` start Node with `--env-file-if-exists=.env`. Only server code reads the key, and the browser never sees it.

## Rendering untrusted text

**TL;DR:** archived posts are attacker-controlled. Astro escapes every `{expression}`, so render record content only through expressions and never with `set:html`. Links go through `Ext` / `safeHref`, which allow only `http(s)`, `/` and `#`.

- The one client script that writes archive-derived text (`JobRunner`'s log and estimate) uses `textContent` only.

## Jobs

**TL;DR:** `JobRunner` wraps a form. On submit it POSTs `/api/jobs`, clones a server-rendered `<template>` for the panel, and streams progress over SSE. When the tone step posts an estimate, it shows Proceed/Skip and POSTs the answer to `/api/jobs/[id]/confirm`.

| route | purpose |
|---|---|
| `POST /api/jobs` | start `archive` or `analyze` (`{ mode, input, snapshot?, media?, analyze?, tone?, model?, toneLimit? }`) |
| `GET /api/jobs/:id/events` | SSE. Each event carries an `id`, and a reconnect with `Last-Event-ID` resumes rather than replaying |
| `POST /api/jobs/:id/confirm` | answer a tone estimate `{ yes }` |
| `GET /blobs/:handle/:file` | downloaded media |

- Jobs live in memory in the server process and are dropped an hour after they start.
- When a job finishes, the page refreshes through the router (`navigate(current URL, { history: 'replace' })`) and keeps your scroll position. Free re-runs refresh on their own; after a paid tone pass the "Show the report" button does it, so you can read the actual cost first.
- Navigating away mid-job closes the panel's event stream (`disconnectedCallback`). The job itself keeps running on the server.
- Astro allows one dev server per project. To test against another archive root, build and run `dist/server/entry.mjs` with `SLURP_ARCHIVES` and `PORT` set.

## Embeds

**TL;DR:** likes, reposts and reply parents (plus thread roots when the `slurp-roots` cookie is set) show the target post, fetched server-side from the public AppView in batches of 25 and cached for 10 minutes. `undefined` means the AppView couldn't be reached; `null` means it has no such post. Those render differently.

- `null` renders as "Post unavailable": deleted, taken down, or hidden from logged-out viewers. The pointer still records which post it was.
- `undefined` renders as "Couldn't load this post" with a link to bsky.app. A network failure must never be presented as a deletion.
- Pointer labels resolve DIDs to `@handles` server-side too (`getHandles`, same cache).
- Images on posts or authors labelled `porn`, `sexual`, `nudity`, `graphic-media` or `gore` are blurred until clicked.
- Media not on disk loads from the account's PDS (the user's choice).

## Design

**TL;DR:** a brutalist grid modelled on brutalist.design's "Brutal" template: 1px ink hairlines made by `gap: 1px` over an ink background, Titillium Web, uppercase headings, no radius or shadow, light and dark themes. Tokens are global, and every component owns its own CSS.

- **Tokens:** every length, size, type step, tracking and leading value is a custom property on `:root` in `src/styles/global.css`. Rules use `var(--…)` or a `calc()` of tokens. Inline `style` is reserved for data-driven widths and heights (chart bars).
- **One page breakpoint:** `@custom-media --narrow` in `src/styles/media.css`, injected into every stylesheet by `@csstools/postcss-global-data` + `postcss-custom-media` (see `postcss.config.mjs`). Components write `@media (--narrow)`, and `860px` appears exactly once. The masthead is the exception: it responds to its own width with a container query (see [Masthead](#masthead)).
- **Scales:** spacing `--space-3xs` to `--space-xl` (2px to 32px), type `--text-2xs` to `--text-lg` plus four fluid display sizes, tracking `--track` / `--track-wide`, and `--control` (2.75rem) as the minimum tap target.
- **Scoped styles:** a component's `<style>` is scoped to its own template. `Grid` and `Cell` spread their props onto their root element, so a parent's scope attribute reaches them and `class` passed from a parent stays styleable. Use `:global()` only for classes applied through `Ext` (`blurred`, `link-card-link`).
- **One line, never two:** a grid nested inside a cell drops its own bottom border (`.cell .grid`), since the outer grid already draws that edge. Nested content that needs lines should be full-bleed cells in the same grid, not a grid floating inside padding. A 2-column grid with an odd number of cells stretches the last one across the row, so the ink background never shows through as a black block.
- **Toggle clearance:** the day/night toggle is fixed bottom-left like the reference. `body` has bottom padding so the last row can always scroll clear of it, after it was found covering the Proceed button.
- **Theme before paint:** an inline script in `Base.astro` applies the saved theme before first paint so night mode doesn't flash white. On router swaps the router copies the new page's `<html>` attributes, which would drop `data-theme`, so `ThemeToggle` writes the current theme onto the incoming document in `astro:before-swap`. The toggle itself is `transition:persist`.
- **Scroll:** see [Scroll](#scroll).
- **Stale styles in dev:** after editing a component's `<style>`, Astro's dev server has been seen serving the old CSS on full page loads while the file watcher reports the change. If a style edit seems to do nothing, restart `npm run dev` before debugging the CSS.

## Scroll

**TL;DR:** `ClientRouter` scrolls to the top after every page swap. Links inside a `data-keep-scroll` container (the collections list and the time-window tabs) keep your place instead. `src/lib/scroll.ts` captures the page's scroll plus every `data-scroll-id` pane's inner scroll when you click such a link, then restores it in `astro:after-swap`, before the browser paints.

- **Why `after-swap`:** the router swaps the DOM, scrolls to the top, and dispatches `astro:after-swap` in one synchronous step (`moveToLocation` then `triggerEvent` in `astro/dist/transitions/router.js`). Restoring there means the top-of-page frame never paints. A restore after load, as the earlier sessionStorage version did, always showed one frame at the top: that was the jump.
- **Not persisted on purpose:** the collections list isn't `transition:persist`, because a persisted element keeps its old `aria-current` highlight. Its inner scroll is carried across the swap instead.
- **Programmatic refreshes:** the thread-roots toggle and finished jobs call `keepScrollOnNextSwap()` before `navigate()`, so they refresh in place too.
- **Deliberately not kept:** the pager and the account tabs (Report / Records / Identity). A new page of records or a different section should start at the top. Back and forward use the router's own saved position.
- **Adding it elsewhere:** put `data-keep-scroll` on the link container, and `data-scroll-id="<name>"` on any inner scrolling pane that should keep its own position.
- **Prefetch:** hover prefetch is on for all links (`prefetch` in `astro.config.mjs`). `Ext` links (external sites and media) opt out, so hovering a video doesn't download it.
- **Verified:** `feed.like` → `feed.repost` kept 480px / 120px, and `graph.follow` kept 620px / 200px, already restored at `after-swap`. The roots toggle kept 900px. A finished job refreshed at 4497px. The pager and the account tabs went to 0, back returned to 700, and night mode stayed on through 6 swaps. The whole run stayed in one document.

## Masthead

**TL;DR:** the masthead sizes itself from container queries, not the viewport. The `<header>` is a `masthead` container, so the grid inside collapses when the masthead itself is under `54rem`. The wordmark cell is its own `inline-size` container, and "SLURP" is set in `cqi` so its visible ink fills the cell's content width exactly, at any layout.

- **Why a wrapper:** a container query can't style the container itself, only its descendants. `<header class="masthead">` is the container, and the grid (`.bar`) inside it is what changes columns.
- **Wordmark fill:** `font-size = 100cqi / (glyphs + gaps × tracking)`. Measured in Titillium Web 400, "SLURP" is `2.8611em` of glyphs with 4 gaps of `0.55em` tracking between letters, so the visible text is `5.0611em` wide. The 5th tracking gap trails after the last letter as empty space and is clipped by `overflow: hidden`, which also keeps the page from scrolling sideways.
- **Changing the text or font:** re-measure the glyph width (render the word at `100px` with `letter-spacing: 0` and divide its width by 100) and update `--wordmark-glyphs`. Update `--wordmark-gaps` if the letter count changes.
- **The one literal:** `@container masthead (width < 54rem)`. Container conditions can't read custom properties, and `postcss-custom-media` only handles `@media`. The threshold is the masthead's own need (three columns stop fitting), not the page breakpoint, so it lives only in `Masthead.astro`.
- **Measured fill:** the ink width equals the cell's content width at 375, 567, 860, 870, 1280 and 1920px, with no horizontal overflow at any of them.
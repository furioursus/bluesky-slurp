# Web UI

**TL;DR:** `npm run serve` runs a local Node server (`src/server.ts`) with a no-build frontend (`web/`). It's local-only on purpose, it renders untrusted archived text safely, and long jobs stream over SSE with a confirm step for paid work.

## Security

**TL;DR:** binds to `127.0.0.1` only, rejects cross-origin non-GET requests, and keeps the API key server-side. The server writes to disk and can spend Claude credits, so nothing outside this machine may reach it.

- **Bind address:** `127.0.0.1`, never `0.0.0.0`. Exposing it remotely needs real auth in front (see the parked Cloudflare Access plan in project memory), not a flag flip.
- **Origin check:** any non-GET request with an `Origin` header that doesn't match `http://<Host>` gets a 403. This stops a malicious web page from POSTing jobs to the local server. Behind a tunnel this check must compare hosts instead.
- **Paths:** handle, snapshot, collection and blob names must match `^[A-Za-z0-9._:-]+$` and resolve inside the archive root.
- **API key:** read from `.env` by the server (`--env-file-if-exists`). The browser only ever sees `hasApiKey: true/false`.

## Rendering untrusted text

**TL;DR:** all DOM is built with `h()` in `web/app.js`, which inserts strings as text nodes and only allows `http(s)`, `#` and `/` URLs in `href`/`src`. Archived posts are attacker-controlled, so never use `innerHTML` with record content.

## API

**TL;DR:** a small JSON API plus SSE for jobs.

| route | purpose |
|---|---|
| `GET /api/accounts` | accounts on disk, with snapshot summaries |
| `GET /api/config` | default model, whether an API key is present |
| `GET /api/snapshot/:handle/:snapshot` | manifest, Bluesky profile, analysis |
| `GET /api/snapshot/:handle/:snapshot/identity` | DID document, PLC audit log |
| `GET /api/snapshot/:handle/:snapshot/records/:collection?offset&limit&order` | paged records, `newest` or `oldest` |
| `GET /blobs/:handle/:file` | downloaded media |
| `POST /api/jobs` | start `archive` or `analyze`, optionally with tone |
| `GET /api/jobs/:id/events` | SSE: replays the job's history, then streams |
| `POST /api/jobs/:id/confirm` | answer a tone estimate `{ yes }` |

- Jobs live in memory and are dropped an hour after they start.
- "Newest first" reverses the JSONL file. See [archive-format.md](archive-format.md#record-order).
- Static files are served `cache-control: no-cache`, so UI edits show up on a plain reload.

## Embeds

**TL;DR:** likes, reposts and reply parents (plus thread roots on request) show the target post, fetched from the public AppView in batches of 25.

- A post the AppView doesn't return is shown as "unavailable": deleted, taken down, or hidden from logged-out viewers. The pointer still records which post it was.
- Images on posts or authors labelled `porn`, `sexual`, `nudity`, `graphic-media` or `gore` are blurred until clicked.
- Media not on disk loads from the account's PDS (the user's choice).

## Design

**TL;DR:** brutalist grid modelled on brutalist.design's "Brutal" template: 1px ink hairlines made by `gap: 1px` over an ink background, Titillium Web, uppercase headings, no radius or shadow, light and dark themes.

- **Tokens:** every length, size, type step, tracking and leading value is a custom property on `:root` in `web/style.css`. Rules use `var(--…)` or a `calc()` of tokens. The only raw lengths outside `:root` are the `860px` breakpoint (media queries can't read custom properties) and the phone-size token overrides inside it. Inline `style` in `app.js` is reserved for data-driven widths and heights (chart bars).
- **Scales:** spacing `--space-3xs` to `--space-xl` (2px to 32px), type `--text-2xs` to `--text-lg` plus four fluid display sizes, tracking `--track` / `--track-wide`, and `--control` (2.75rem) as the minimum tap target.
- **One line, never two:** hairlines come from `gap: var(--line)` over an ink background. A grid nested inside a cell drops its own bottom border (`.cell .grid`), since the outer grid already draws that edge. Nested content that needs lines should be full-bleed cells in the same grid, not a grid floating inside padding. A 2-column grid with an odd number of cells stretches the last one across the row, so the ink background never shows through as a black block.
- **Wordmark overflow:** the letter-spaced wordmark trails spacing after its last glyph. Without `overflow: hidden` it widened the page on phones and caused horizontal scroll (found in testing).
- **Toggle clearance:** the day/night toggle is fixed bottom-left like the reference. `body` has bottom padding so the last row can always scroll clear of it, after it was found covering the Proceed button.
- **Theme before paint:** an inline script in `index.html` applies the saved theme before first paint so night mode doesn't flash white.
- **Scroll:** switching time windows keeps your scroll position. Any other navigation starts at the top.

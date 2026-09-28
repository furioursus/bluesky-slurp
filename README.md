# Slurp

[![Node ≥ 23.6](https://img.shields.io/badge/node-%E2%89%A5%2023.6-000?style=flat-square&logo=nodedotjs)](package.json) [![Astro](https://img.shields.io/github/package-json/dependency-version/furioursus/bluesky-slurp/astro?style=flat-square&color=000&logo=astro)](https://astro.build) [![atproto](https://img.shields.io/badge/atproto-archiver-000?style=flat-square&logo=bluesky)](https://atproto.com) [![MIT license](https://img.shields.io/badge/license-MIT-000?style=flat-square)](LICENSE)

**TL;DR:** hand `slurp` any atproto handle and it archives everything that account has publicly put on the network — every app, not just Bluesky. Every interaction carries a clickable pointer to whatever it targets. Media is opt-in (`--media`), because it can eat gigabytes. `slurp analyze <handle>` turns an archive into a behavior and interests report built from signals and evidence links. It never hands down a verdict; that part's on you.

## Docs

The "why" lives here, not in the code. The only comments are one-line links back into these files, for traps and security calls.

| doc | covers |
|---|---|
| [docs/archive-format.md](docs/archive-format.md) | directory layout, record JSON, record order, the `refs` pointer format |
| [docs/analysis.md](docs/analysis.md) | signals vs verdicts, cold outreach, reply bursts, time windows, empty samples |
| [docs/web-ui.md](docs/web-ui.md) | local-only security, rendering untrusted text, the API, embeds, design decisions |
| [docs/desktop.md](docs/desktop.md) | the macOS app: how it runs, the archive folder, the per-launch token, signing and size |

## Usage

Node ≥ 23.6 and `npm install`. The CLI runs straight from source with no build step (`npm run slurp -- <args>`), and the web UI is Astro (`npm run dev`). Video poster frames on the media wall need `ffmpeg` on your `PATH` (`brew install ffmpeg`); without it, video tiles just get a ▶ badge.

```sh
npm install
npm run slurp -- furioursus.dev                   # archive it, or update the archive you already have (~30 MB / 65k records in ~4s)
npm run slurp -- furioursus.dev --media           # + images/video (can be GBs; ~8 files/s)
npm run slurp -- furioursus.dev --analyze         # archive, then write the report
npm run slurp -- analyze furioursus.dev           # re-run the report on the existing archive
npm run slurp -- media furioursus.dev             # download media for the archive, later
npm run slurp -- migrate                          # check old snapshot-per-run archives; add --write to convert them
```

Input can be a handle, `@handle`, a DID (`did:plc:…` / `did:web:…`), an `at://` URI, or a `bsky.app/profile/…` URL — whatever you've got handy. `--out <dir>` changes the archive root (default `./archives`).

## Web UI

Run `npm run dev`, then open http://127.0.0.1:4747. It's an Astro 7 app rendered on the server over the same engine as the CLI: archive an account, read its report, and browse every record (pointers included) and every downloaded file. The details live in [docs/web-ui.md](docs/web-ui.md).

| command | what it does |
|---|---|
| `npm run dev` | Astro dev server on 127.0.0.1:4747 |
| `npm run dev:inspect` | same, plus the astro-pathfinder component inspector (see below) |
| `npm run serve` | production build, then the built Node server on 127.0.0.1:4747 |
| `npm run check` | `astro check`: types for `.astro` and `src/lib` |

- **Local only:** it binds to `127.0.0.1` and rejects cross-origin POSTs, because it writes to disk and runs jobs. Don't put it on the open internet as-is.
- **Screens:** New archive (form, then a live log, plus your 6 newest archives and a link to the rest), Accounts, and per account: Report / Records / Media / Identity. Pages are real URLs, e.g. `/a/<handle>/report?w=30d`. Each account page has an **Update** button, and Accounts has **Update all**. Navigation swaps pages in place (Astro `ClientRouter`).
- **Archive location:** `SLURP_ARCHIVES=/path npm run dev` points the UI at another archive root (default `./archives`).

### Desktop app

There's a macOS app too. `npm run app:dist` builds `release/Slurp-<version>-arm64.dmg`; drag Slurp into Applications and it runs the same server in its own window, no terminal needed. `npm run app` opens a dev copy without packaging. Details in [docs/desktop.md](docs/desktop.md).

- **Archives** live in `~/Library/Application Support/Slurp/archives` unless you pick another folder (File → Choose Archive Folder…).
- **Locked to its own window:** every launch makes a random token, and the server refuses requests without it.
- **Windows and Linux:** later.

### Component inspector (astro-pathfinder)

`npm run dev:inspect`, then hover anything. A panel in the bottom-left names the `.astro` files that produced it, innermost first, each with a line number and clickable.

```
src/components/records/PostEmbed.astro:44
src/components/records/RecordCard.astro:24
src/components/ui/Cell.astro:14
src/components/ui/Grid.astro:10
src/layouts/Base.astro:14
src/layouts/AccountLayout.astro:17
src/pages/a/[handle]/records/[...collection].astro:35
```

- **Limits:** content injected with `set:html` has no line of its own (this project doesn't use it). Framework components without a `client:*` directive can't be named (this project has none).
- **Why it exists:** Astro 7 compiles through `@astrojs/compiler-rs`, which happily accepts `annotateSourceFile` and then emits nothing, so the dev toolbar's source annotation is just… gone.
- **Install:** a devDependency pinned to the `v1.0.0` HTTPS tarball of `furioursus/astro-pathfinder`, not a `github:` spec (which locks as `git+ssh`). It's a no-op unless `INSPECT=1` and the command is `dev`. i verified an `INSPECT=1` build contains no markers.

## What gets archived

The whole signed repo from the account's own PDS, decoded to JSONL per collection, plus identity and the Bluesky AppView profile. One living archive per person: run it again and it updates in place, keeping anything they've deleted since, flagged. Details in [docs/archive-format.md](docs/archive-format.md#updates).

```
archives/<handle>/
  manifest.json                     # DID, handle + history, PDS, live and deleted counts, update log, media stats, flags
  repo.car                          # latest raw, signature-verifiable repo export (com.atproto.sync.getRepo)
  records/<collection>.jsonl        # every record ever seen, chronological; firstSeen / lastSeen / deletedAt
  identity/did-document.json
  identity/plc-audit-log.json       # did:plc only: full key/handle/PDS history
  bsky-profile.json                 # AppView view: follower counts, moderation labels (if on Bluesky)
  analysis.md / analysis.json       # after `analyze`; refreshed by every update
  blobs/<cid>.<ext>                 # --media only; never re-downloaded
```

- **Every surface = every lexicon in the repo.** Bluesky posts, likes, reposts, follows, blocks, lists, and also Tangled, teal.fm, Rocksky, Popfeed, Leaflet/standard.site, and so on.
- **Not included** because it isn't public in the protocol: DMs, mutes, private preferences.
- **Not included (yet):** things *other* people did to them (replies, quotes, likes of their posts). Those live in other people's repos.

## Pointers (`refs`)

Each JSONL line has `uri` + `web` for the record itself and a `refs` array for everything it points at.

```json
{"uri":"at://did:plc:…/app.bsky.feed.like/3juq…","web":"https://pdsls.dev/at://…","refs":[
  {"role":"liked","kind":"record","path":"subject","target":"at://did:plc:…/app.bsky.feed.post/3juq…",
   "web":"https://bsky.app/profile/did:plc:…/post/3juq…","cid":"bafyrei…"}]}
```

| role | from |
|---|---|
| `liked`, `reposted`, `via-repost` | likes/reposts (any app using `*.feed.like` / `*.feed.repost`) |
| `followed`, `blocked`, `blocked-list` | graph records, any app |
| `reply-parent`, `reply-root`, `quoted` | posts |
| `mentioned`, `linked` | rich-text facets, external embeds |
| `list`, `list-member`, `gated-post` | lists, threadgates/postgates |
| `media` | blobs; `web` is the PDS `getBlob` URL, `local` is set with `--media` (relative to `archives/<handle>/`) |
| anything else | the JSON path it was found at, e.g. `listUri` |

- `web` goes to bsky.app for Bluesky types and to pdsls.dev (a generic atproto record viewer) for everything else.
- `cid` on a record ref pins the *exact version* interacted with, so it still proves what was liked or replied to even if the target is later edited or deleted.

## Analysis

Structural signals of good- or bad-faith engagement, plus interests. It's offline except for one batched handle lookup. Read the linked posts before you conclude anything about anyone.

- **Time windows:** every stat is computed for the last 30 days, 3 months, 6 months, 1 year, and all time, counted back from the last update. The web UI switches between them instantly. `analysis.md` shows all time plus an "Over time" comparison table.
- **Shape:** original vs self-thread vs reply vs quote, likes per post, cadence.
- **Cold outreach:** share of replies/quotes aimed at accounts they don't follow, and at accounts they've never liked either. This is the reply-guy and dunk signal.
- **Fixation:** bursts of 5+ replies to one non-followed account within 24h, with links.
- **Stranger quotes:** count plus the latest examples.
- **Interests:** hashtags, link domains, languages, most-liked/most-reposted accounts, which atmosphere apps they use.

Caveats:
- "Followed" means followed *as of the last update*, in every window, and records they've deleted since are left out of the report. Old replies to people they've since unfollowed count as cold.
- Many blocks usually means block lists or self-defense, not aggression.
- It never reads text, only structure.

## License

[MIT](LICENSE) © 2026 Christopher Kennedy-Nuñez.

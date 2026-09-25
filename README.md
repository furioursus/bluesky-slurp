# bluesky-profile-slurper

**TL;DR:** `slurp <handle>` archives everything an atproto account has publicly put on the network, from every app, not just Bluesky. Every interaction carries a clickable pointer to what it targets. Media is opt-in (`--media`). `slurp analyze <handle>` turns an archive into a behavior and interests report built from signals and evidence links. It never gives a verdict. `--tone` adds an optional Claude pass that labels replies and quotes, after showing a token and cost estimate.

## Docs

**TL;DR:** the "why" behind the code lives here. Code has no comments except one-line links into these files for traps and security choices.

| doc | covers |
|---|---|
| [docs/archive-format.md](docs/archive-format.md) | directory layout, record JSON, record order, the `refs` pointer format |
| [docs/analysis.md](docs/analysis.md) | signals vs verdicts, cold outreach, reply bursts, time windows, empty samples, tone coverage |
| [docs/tone-pass.md](docs/tone-pass.md) | sampling, the cost estimate, credentials, the label cache, refusals |
| [docs/web-ui.md](docs/web-ui.md) | local-only security, rendering untrusted text, the API, embeds, design decisions |

## Usage

**TL;DR:** Node ≥ 23.6, `npm install`. The CLI runs directly with no build (`npm run slurp -- <args>`, which also loads `.env`). The web UI is Astro: `npm run dev`.

```sh
npm install
npm run slurp -- furioursus.dev                   # records only (fast: ~30 MB / 65k records in ~4s)
npm run slurp -- furioursus.dev --media           # + images/video (can be GBs; ~8 files/s)
npm run slurp -- furioursus.dev --analyze         # archive, then write the report
npm run slurp -- analyze furioursus.dev           # report on the latest existing snapshot
npm run slurp -- analyze furioursus.dev --tone    # + Claude tone pass (estimate, then asks)
npm run slurp -- media furioursus.dev             # download media for the latest snapshot, later
```

Input can be a handle, `@handle`, a DID (`did:plc:…` / `did:web:…`), an `at://` URI, or a `bsky.app/profile/…` URL. `--out <dir>` changes the archive root (default `./archives`).

## Web UI

**TL;DR:** `npm run dev` → http://127.0.0.1:4747. It's an Astro 7 app rendered on the server over the same engine as the CLI: archive an account, read the report, browse every record with its pointers, and approve the tone-pass estimate with a button. Details in [docs/web-ui.md](docs/web-ui.md).

| command | what it does |
|---|---|
| `npm run dev` | Astro dev server on 127.0.0.1:4747, loads `.env` |
| `npm run dev:inspect` | same, plus the astro-pathfinder component inspector (see below) |
| `npm run serve` | production build, then the built Node server on 127.0.0.1:4747 |
| `npm run check` | `astro check`: types for `.astro` and `src/lib` |

- **Local only:** it binds to `127.0.0.1` and rejects cross-origin POSTs, because it writes to disk and can spend Claude credits. Your API key stays server-side in `.env`.
- **Screens:** New archive (form, then a live log), Accounts, and per account: Report / Records / Media / Identity. Pages are real URLs, e.g. `/a/<handle>/<snapshot>/report?w=30d`. Navigation swaps pages in place (Astro `ClientRouter`).
- **Archive location:** `SLURP_ARCHIVES=/path npm run dev` points the UI at another archive root (default `./archives`).

### Component inspector (astro-pathfinder)

**TL;DR:** `npm run dev:inspect`, then hover anything. A panel in the bottom-left names the `.astro` files that produced it, innermost first, each with a line number and clickable.

```
src/components/records/PostEmbed.astro:44
src/components/records/RecordCard.astro:24
src/components/ui/Cell.astro:14
src/components/ui/Grid.astro:10
src/layouts/Base.astro:14
src/layouts/AccountLayout.astro:17
src/pages/a/[handle]/[snapshot]/records/[...collection].astro:35
```

- **Limits:** content injected with `set:html` has no line of its own (this project doesn't use it). Framework components without a `client:*` directive can't be named (this project has none).
- **Why it exists:** Astro 7 compiles through `@astrojs/compiler-rs`, which accepts `annotateSourceFile` but emits nothing, so the dev toolbar's built-in source annotation is silently gone.
- **Install:** a devDependency pinned to the `v1.0.0` HTTPS tarball of `furioursus/astro-pathfinder`, not a `github:` spec (which locks as `git+ssh`). It's a no-op unless `INSPECT=1` and the command is `dev`. An `INSPECT=1` build was verified to contain no markers.

## What gets archived

**TL;DR:** the whole signed repo from the account's own PDS, decoded to JSONL per collection, plus identity and the Bluesky AppView profile.

```
archives/<handle>/
  blobs/<cid>.<ext>                 # --media only; shared across snapshots, never re-downloaded
  snapshots/<timestamp>/
    manifest.json                   # DID, handle + history, PDS, per-collection counts, media stats, flags
    repo.car                        # raw, signature-verifiable repo export (com.atproto.sync.getRepo)
    records/<collection>.jsonl      # one record per line, chronological within a collection
    identity/did-document.json
    identity/plc-audit-log.json     # did:plc only: full key/handle/PDS history
    bsky-profile.json               # AppView view: follower counts, moderation labels (if on Bluesky)
    analysis.md / analysis.json     # after `analyze`
```

- **Every surface = every lexicon in the repo.** Bluesky posts, likes, reposts, follows, blocks, lists, and also Tangled, teal.fm, Rocksky, Popfeed, Leaflet/standard.site, and so on.
- **Not included** because it isn't public in the protocol: DMs, mutes, private preferences.
- **Not included (yet):** things *other* people did to them (replies, quotes, likes of their posts). Those live in other people's repos.

## Pointers (`refs`)

**TL;DR:** each JSONL line has `uri` + `web` for the record itself and a `refs` array for everything it points at.

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

**TL;DR:** structural signals of good- or bad-faith engagement, plus interests. Offline except one batched handle lookup. Read the linked posts before concluding anything.

- **Time windows:** every stat is computed for the last 30 days, 3 months, 6 months, 1 year, and all time, counted back from the snapshot date. The web UI switches between them instantly. `analysis.md` shows all time plus an "Over time" comparison table.
- **Shape:** original vs self-thread vs reply vs quote, likes per post, cadence.
- **Cold outreach:** share of replies/quotes aimed at accounts they don't follow, and at accounts they've never liked either. This is the reply-guy and dunk signal.
- **Fixation:** bursts of 5+ replies to one non-followed account within 24h, with links.
- **Stranger quotes:** count plus the latest examples.
- **Interests:** hashtags, link domains, languages, most-liked/most-reposted accounts, which atmosphere apps they use.

Caveats:
- "Followed" means followed *at snapshot time*, in every window. Old replies to people they've since unfollowed count as cold.
- Tone labels come from the most recent posts. Windows that reach back past the labelled sample say so, and show the sample's numbers rather than the window's.
- Many blocks usually means block lists or self-defense, not aggression.
- Without `--tone`, text isn't read, only structure.

## Tone pass (optional, paid)

**TL;DR:** `--tone` sends up to 200 replies/quotes to Claude (75% the most recent cold ones, 25% warm as a baseline), each with the post it answered, and adds a cold-vs-warm label table with example links to the report. It counts the tokens exactly first, shows the dollar range, and asks before spending anything.

- **Auth:** `ANTHROPIC_API_KEY`, or an `ant auth login` profile. `npm run slurp` also loads the key from a `.env` file in the project root if there is one (`ANTHROPIC_API_KEY=sk-ant-…`; git ignores that file).
- **Model:** `claude-sonnet-5` by default (about $0.20–$0.55 for a full 200-post pass). Override with `--model` (priced: `claude-opus-5`, `claude-haiku-4-5`, `claude-opus-5-5`, `claude-fable-5-1`, `claude-opus-4-8`). Runs at `effort: low` with JSON-schema output, 20 posts per request, 3 requests at a time.
- **Estimate:** input tokens come from `count_tokens` (exact and free). Output is a range, because thinking length varies. After the run it prints the actual tokens and cost.
- **Flags:** `--tone-limit <n>` (default 200), `-y/--yes` to skip the prompt. With no terminal and no `--yes`, it skips the paid part and says so.
- **Labels:** genuine, supportive, playful, disagreeing, argumentative, hostile, trolling, unclear. The TL;DR compares the bad-faith share (argumentative + hostile + trolling) on cold vs warm posts. A big gap is the tell. A high number on both is just how they talk.
- **Caching:** labels are stored per post in the snapshot's `tone.json`. Re-runs and larger limits only pay for unlabelled posts. Changing `--model` re-labels.
- **Refusals:** with `--model claude-opus-5` or `claude-fable-5-1`, `fallbacks: "default"` re-runs a declined request on a fallback model server-side. The Sonnet 5 default has no server-side fallback. Anything still without a label is marked `refused`.

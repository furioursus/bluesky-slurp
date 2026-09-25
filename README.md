# bluesky-profile-slurper

**TL;DR:** `slurp <handle>` archives everything an atproto account has publicly put on the network, from every app, not just Bluesky. Every interaction carries a clickable pointer to what it targets. Media is opt-in (`--media`). `slurp analyze <handle>` turns an archive into a behavior and interests report built from signals and evidence links. It never gives a verdict. `--tone` adds an optional Claude pass that labels replies and quotes, after showing a token and cost estimate.

## Usage

**TL;DR:** Node ≥ 23.6, `npm install`, then run `src/cli.ts` directly. There's no build step.

```sh
npm install
node src/cli.ts furioursus.dev                  # records only (fast: ~30 MB / 65k records in ~4s)
node src/cli.ts furioursus.dev --media          # + images/video (can be GBs; ~8 files/s)
node src/cli.ts furioursus.dev --analyze        # archive, then write the report
node src/cli.ts analyze furioursus.dev          # report on the latest existing snapshot
node src/cli.ts analyze furioursus.dev --tone   # + Claude tone pass (estimate, then asks)
```

Input can be a handle, `@handle`, a DID (`did:plc:…` / `did:web:…`), an `at://` URI, or a `bsky.app/profile/…` URL. `--out <dir>` changes the archive root (default `./archives`).

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

- **Shape:** original vs self-thread vs reply vs quote, all-time vs last 90 days, likes per post, cadence.
- **Cold outreach:** share of replies/quotes aimed at accounts they don't follow, and at accounts they've never liked either. This is the reply-guy and dunk signal.
- **Fixation:** bursts of 5+ replies to one non-followed account within 24h, with links.
- **Stranger quotes:** count plus the latest examples.
- **Interests:** hashtags, link domains, languages, most-liked/most-reposted accounts, which atmosphere apps they use.

Caveats:
- "Followed" means followed *at snapshot time*. Old replies to people they've since unfollowed count as cold.
- Many blocks usually means block lists or self-defense, not aggression.
- Without `--tone`, text isn't read, only structure.

## Tone pass (optional, paid)

**TL;DR:** `--tone` sends up to 200 replies/quotes to Claude (75% the most recent cold ones, 25% warm as a baseline), each with the post it answered, and adds a cold-vs-warm label table with example links to the report. It counts the tokens exactly first, shows the dollar range, and asks before spending anything.

- **Auth:** `ANTHROPIC_API_KEY`, or an `ant auth login` profile.
- **Model:** `claude-sonnet-5` by default (about $0.20–$0.55 for a full 200-post pass). Override with `--model` (priced: `claude-opus-5`, `claude-haiku-4-5`, `claude-opus-5-5`, `claude-fable-5-1`, `claude-opus-4-8`). Runs at `effort: low` with JSON-schema output, 20 posts per request, 3 requests at a time.
- **Estimate:** input tokens come from `count_tokens` (exact and free). Output is a range, because thinking length varies. After the run it prints the actual tokens and cost.
- **Flags:** `--tone-limit <n>` (default 200), `-y/--yes` to skip the prompt. With no terminal and no `--yes`, it skips the paid part and says so.
- **Labels:** genuine, supportive, playful, disagreeing, argumentative, hostile, trolling, unclear. The TL;DR compares the bad-faith share (argumentative + hostile + trolling) on cold vs warm posts. A big gap is the tell. A high number on both is just how they talk.
- **Caching:** labels are stored per post in the snapshot's `tone.json`. Re-runs and larger limits only pay for unlabelled posts. Changing `--model` re-labels.
- **Refusals:** with `--model claude-opus-5` or `claude-fable-5-1`, `fallbacks: "default"` re-runs a declined request on a fallback model server-side. The Sonnet 5 default has no server-side fallback. Anything still without a label is marked `refused`.

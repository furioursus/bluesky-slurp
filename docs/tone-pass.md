# Tone pass

**TL;DR:** optional and paid. Claude labels a sample of replies and quotes, each read with the post it answered. It counts input tokens exactly, shows a cost range, and asks before spending. Labels are cached per post. Code: `src/tone.ts`.

## Sampling

**TL;DR:** up to `--tone-limit` posts (default 200): 75% the most recent cold posts, 25% the most recent warm ones as a baseline.

- Only replies and quotes aimed at other people, with non-empty text, are candidates.
- The sample is most-recent-first, so on busy accounts it covers weeks, not years. See [analysis.md](analysis.md#tone-coverage).
- The posts they answered are fetched from the public Bluesky AppView (`app.bsky.feed.getPosts`, 25 per call). Deleted or hidden posts are sent as `[unavailable]`.

## Estimate

**TL;DR:** input tokens are exact (from `count_tokens`, which is free), output is a range, and the cost is computed from a price table in `tone.ts`.

- The output range is `posts × 60` to `posts × 180 + requests × 800`, because thinking length varies.
- Cost uses input and output rates per model. Cache reads bill at 0.1× input and 5-minute cache writes at 1.25×, and actual cost is printed after the run.
- The system prompt is below Sonnet 5's minimum cacheable size, so cache reads are normally 0. That's expected, not a bug.

## Credentials

**TL;DR:** the Anthropic SDK resolves credentials itself. When none are configured, it throws a plain `Error` at request time, not `AuthenticationError`, so the check treats any non-API error from `count_tokens` as "no credentials".

- A bad key raises `Anthropic.AuthenticationError`.
- No key at all raises a plain `Error` ("Could not resolve authentication method"). It has to be caught separately, or the user sees a raw SDK message.
- Either way the analysis still writes its structural report. A failed tone pass never costs the rest.

## Label cache

**TL;DR:** labels live in the snapshot's `tone.json`, keyed by post URI. Writes are serialized and atomic because requests finish concurrently.

- Three requests run in parallel, and each one saves `tone.json` when it finishes. Unserialized, those writes overlapped and corrupted the file (found in testing).
- Saves go through a promise chain (one at a time) and write to `tone.json.tmp` and then rename, so a crash mid-write can't truncate the cache.
- A post labelled by a different model is re-labelled when `--model` changes.

## Refusals

**TL;DR:** on `claude-opus-5` and `claude-fable-5-1`, requests carry `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a declined request re-runs server-side. The Sonnet 5 default has no fallback. Anything without a label is stored as `refused`.

# Archive format

**TL;DR:** one directory per account, one timestamped snapshot per run. Each snapshot holds the raw signed repo (`repo.car`) plus every record decoded to JSONL, with a `refs` array of pointers per record. Media is shared across snapshots under `blobs/`. Code: `src/lib/archive.ts`, `src/lib/refs.ts`.

## Layout

**TL;DR:** `archives/<handle>/snapshots/<UTC timestamp>/`, plus `archives/<handle>/blobs/` when media is downloaded.

```
archives/<handle>/
  blobs/<cid>.<ext>
  snapshots/<timestamp>/
    manifest.json
    repo.car
    records/<collection>.jsonl
    identity/did-document.json
    identity/plc-audit-log.json
    bsky-profile.json
    analysis.json / analysis.md
    tone.json
```

- The directory is named by handle, with a `did_plc_…` fallback when there's no handle. Handles change, so `manifest.json` holds the DID and the full handle history.
- The snapshot timestamp swaps `:` for `-` so it's safe as a directory name.
- `blobs/` is keyed by CID, which is content-addressed. A file that already exists is never downloaded again.

## Record JSON

**TL;DR:** records are decoded from DAG-CBOR and round-tripped through `JSON.stringify` so CIDs become `{"$link": …}` and bytes become `{"$bytes": …}`, which is atproto's standard JSON form.

- `@atcute/repo` yields records containing `CidLink` and `Bytes` wrapper objects. Their `toJSON()` produces the atproto JSON encoding.
- `JSON.parse(JSON.stringify(record))` looks like a pointless copy, but it's the conversion step. Without it, blob refs have no `$link` and pointer extraction can't see media.

## Record order

**TL;DR:** each JSONL file is in record-key order, which is chronological for most collections. The web UI reverses a file to show newest first.

- Records come out of the repo's Merkle search tree sorted by key.
- Bluesky and most atproto apps use TIDs (timestamp identifiers) as record keys, so key order is creation order.
- Collections with non-TID keys (`self` for profiles, or arbitrary keys in some apps) won't be chronological. For those, "newest first" just means "reversed key order".

## Refs

**TL;DR:** every record line carries `refs`: pointers to what it interacts with, extracted generically so any lexicon works.

| field | meaning |
|---|---|
| `role` | what the pointer means: `liked`, `reply-parent`, `quoted`, `mentioned`, `media`, … or the JSON path when there's no friendly name |
| `kind` | `record` (at:// URI), `account` (DID), `blob` (CID), `link` (https URL) |
| `path` | where in the record it was found, e.g. `reply.parent` |
| `target` | the canonical address |
| `web` | a human-openable URL: bsky.app for Bluesky types, pdsls.dev for anything else, the PDS `getBlob` URL for media |
| `cid` | for strong refs: the exact version of the target that was interacted with |
| `mimeType` | for blobs |
| `local` | for blobs, when media was downloaded: path relative to `archives/<handle>/` |

- Extraction walks the whole record. Every at:// URI, DID, blob and `uri: https://…` field becomes a ref, so third-party lexicons work without special cases.
- A strong ref (`{uri, cid}`) is reported at the object's own path (`reply.parent`, not `reply.parent.uri`) so the role reads naturally.
- Friendly roles come from the collection plus the path. Any app's `*.graph.follow`, `*.feed.like` and so on reuse Bluesky's names.

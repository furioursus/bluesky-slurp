# Archive format

One living archive per account. Running Slurp again updates it in place: new and edited records merge in, and anything deleted since stays, flagged. Each archive holds the latest raw signed repo (`repo.car`) plus every record ever seen, decoded to JSONL with a `refs` array of pointers per record. Code: `src/lib/archive.ts`, `src/lib/refs.ts`.

## Layout

Everything for one person lives in `archives/<handle>/`. `blobs/` shows up once media is downloaded and `thumbs/` once the web UI has shown it.

```
archives/<handle>/
  manifest.json
  repo.car                          # the latest export, replaced on every update
  records/<collection>.jsonl        # every record ever seen, deleted ones flagged
  identity/did-document.json
  identity/plc-audit-log.json
  bsky-profile.json
  analysis.json / analysis.md
  media-index.json
  blobs/<cid>.<ext>
  thumbs/<cid>.<ext>.webp           # web UI tile cache, safe to delete (see web-ui.md#thumbnails)
  retired/                          # data from retired features, kept but unused
```

- The directory is named by handle, with a `did_plc_…` fallback when there's no handle. Handles change, so `manifest.json` holds the DID and the full handle history.
- Updates find the folder by DID, not handle. If someone changes their handle, the next update renames the folder to match.
- `blobs/` is keyed by CID, which is content-addressed. A file that already exists is never downloaded again.

## Updates

Every update downloads the account's whole current repo, then merges it into what's already there, one collection at a time. Nothing you've archived is ever dropped.

| case | what happens |
|---|---|
| new record | added with `firstSeen` and `lastSeen` set to this update |
| same record, same CID | kept; `lastSeen` moves to this update |
| same rkey, new CID (edited) | replaced by the new version, keeping its `firstSeen` |
| gone from the repo | kept, with `deletedAt` set to this update; `lastSeen` stays the last update that saw it |
| flagged deleted, then back | `deletedAt` removed, counted as restored |

- **Line fields:** besides `uri`, `web`, `cid`, `collection`, `rkey`, `createdAt`, `refs` and `record`, every JSONL line carries `firstSeen`, `lastSeen` and, when deleted, `deletedAt`, always as the last key. The web UI's "deleted only" filter relies on that last-key position, so a record's own content can't fake it.
- **Why keep deleted records:** an archive that quietly forgets deleted posts misses half the point. "Last seen" is as precise as it gets, since the repo doesn't say when something was deleted, only that it's gone.
- **Edits keep only the newest version.** Most Bluesky records can't be edited anyway; profiles and lists are the ones that change.
- **Manifest:** `totalRecords` and `counts` are live records only; `deletedRecords` and `deleted` count the flagged ones. `fetchedAt` is the last update, `firstArchivedAt` the first, and `updates[]` logs every run as `{ at, added, changed, deleted, restored, live, total }`.
- **Crash safety:** the new export is written to `.incoming/` first, and every collection file and JSON file (manifest, report, media index) is replaced through a temp file and a rename. An interrupted update leaves the previous archive readable, and a page rendered mid-update never sees a half-written manifest. The next update clears `.incoming/`.
- **Reports and media follow along:** an update re-runs the analysis whenever the archive already has one, and drops `media-index.json` so the web UI rebuilds it.

## Migrating old snapshots

Archives from before 2026-09-26 kept a timestamped `snapshots/<run>/` folder per run. `slurp migrate` folds them into one archive, and so does the first update of such an account (the web UI shows those accounts as "old format · update to convert").

- **Order:** snapshots merge oldest first through the same merge as updates, so anything deleted between two runs gets flagged with the later run's time.
- **Checked before anything's deleted:** the live count has to equal the newest snapshot's record count, and the total has to equal every record any snapshot ever held. If either is off, the merge is thrown away and nothing changes.
- **What's kept:** the newest snapshot's `repo.car`, identity files, profile and report. Files from retired features move to `retired/`. Then the `snapshots/` folder is deleted.
- **Dry run by default:** `npm run slurp -- migrate` only checks and reports; add `--write` to convert. Old `/a/<handle>/<snapshot>/…` links redirect to the new URLs.

## Media

Downloaded files live once per account in `blobs/<cid>.<ext>`. `media-index.json` lists every file the archive references, deleted records included, and the records that use it.

- Files are written as `<cid>.part`, then renamed, so an interrupted download never leaves a truncated file under its real name.
- The extension comes from the MIME type (`jpg`, `png`, `webp`, `gif`, `heic`, `avif`, `mp4`, `mov`, `webm`, `mp3`, `pdf`), otherwise `bin`.
- `media-index.json` is `{ version, items[] }` with each item `{ cid, mimeType, kind, file, at, uses[] }`, newest first. It's derived data: delete it and the UI rebuilds it.
- `manifest.media` records `{ enabled, referenced, downloaded, alreadyHad, failed[] }` from the last media download, whether at archive time or later. Once `enabled` is true, every update also fetches media for new records. The app's launch update, and Update all unless you tick **Include media**, skip media for that run only; skipping never turns the setting off.

## Record JSON

Records are decoded from DAG-CBOR and round-tripped through `JSON.stringify` so CIDs become `{"$link": …}` and bytes become `{"$bytes": …}`, which is atproto's standard JSON form.

- `@atcute/repo` yields records containing `CidLink` and `Bytes` wrapper objects. Their `toJSON()` produces the atproto JSON encoding.
- `JSON.parse(JSON.stringify(record))` looks like a pointless copy, but it's the conversion step. Without it, blob refs have no `$link` and pointer extraction can't see media.

## Record order

Each JSONL file is in record-key order, which is chronological for most collections. The web UI reverses a file to show newest first.

- Records come out of the repo's Merkle search tree sorted by key.
- Bluesky and most atproto apps use TIDs (timestamp identifiers) as record keys, so key order is creation order.
- Collections with non-TID keys (`self` for profiles, or arbitrary keys in some apps) won't be chronological. For those, "newest first" just means "reversed key order".

## Refs

Every record line carries `refs`: pointers to what it interacts with, extracted generically so any lexicon works.

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

import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fromUint8Array } from '@atcute/repo';
import { get, pool, xrpc } from './http.ts';
import { fetchBskyProfile, fetchRepoCar, resolveIdentity, type Identity } from './identity.ts';
import { extractRefs, webUrlForUri, type Ref } from './refs.ts';

export interface ArchiveOptions {
  media?: boolean;
  out: string;
}

export interface RecordLine {
  uri: string;
  web: string;
  cid: string;
  collection: string;
  rkey: string;
  createdAt: string | null;
  refs: Ref[];
  record: any;
  firstSeen: string;
  lastSeen: string;
  deletedAt?: string;
}

export interface MergeStats {
  added: number;
  changed: number;
  deleted: number;
  restored: number;
  live: number;
  total: number;
}

export interface UpdateEntry extends MergeStats {
  at: string;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

const INCOMING = '.incoming';
const MIGRATING = '.migrating';
const RETIRED_TONE = join('retired', 'tone');
const TONE_FILES = ['tone.json', 'tone-summary.json'];
const LATEST_COPIES = ['repo.car', 'bsky-profile.json', 'analysis.json', 'analysis.md'];

const dirNameFor = (id: Pick<Identity, 'did' | 'handle'>) => id.handle ?? id.did.replaceAll(':', '_');
const byRkey = (a: RecordLine, b: RecordLine) => (a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0);

async function readJsonl(file: string): Promise<RecordLine[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function writeJsonl(file: string, lines: RecordLine[]) {
  const tmp = `${file}.tmp`;
  const out = createWriteStream(tmp);
  for (const line of lines) if (!out.write(`${JSON.stringify(line)}\n`)) await new Promise((r) => out.once('drain', r));
  await new Promise((r) => out.end(r));
  await rename(tmp, file);
}

const jsonlCollections = async (dir: string) =>
  existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)) : [];

// see docs/archive-format.md#updates
export async function mergeRecords(targetDir: string, sourceDir: string, at: string) {
  await mkdir(targetDir, { recursive: true });
  const stats: MergeStats = { added: 0, changed: 0, deleted: 0, restored: 0, live: 0, total: 0 };
  const counts: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  const collections = new Set([...(await jsonlCollections(targetDir)), ...(await jsonlCollections(sourceDir))]);
  for (const collection of collections) {
    const file = `${collection}.jsonl`;
    const incoming = new Map((await readJsonl(join(sourceDir, file))).map((l) => [l.rkey, l]));
    const merged: RecordLine[] = [];
    for (const old of await readJsonl(join(targetDir, file))) {
      const next = incoming.get(old.rkey);
      incoming.delete(old.rkey);
      if (!next) {
        if (!old.deletedAt) {
          old.deletedAt = at;
          stats.deleted++;
        }
        merged.push(old);
        continue;
      }
      if (old.deletedAt) stats.restored++;
      if (next.cid !== old.cid) stats.changed++;
      const { deletedAt: _gone, ...base } = next.cid === old.cid ? old : { ...next, firstSeen: old.firstSeen };
      merged.push({ ...base, firstSeen: old.firstSeen ?? at, lastSeen: at });
    }
    for (const line of incoming.values()) {
      const { deletedAt: _gone, ...fresh } = line;
      merged.push({ ...fresh, firstSeen: at, lastSeen: at });
      stats.added++;
    }
    merged.sort(byRkey);
    await writeJsonl(join(targetDir, file), merged);
    const gone = merged.filter((l) => l.deletedAt).length;
    if (merged.length - gone) counts[collection] = merged.length - gone;
    if (gone) deleted[collection] = gone;
    stats.live += merged.length - gone;
    stats.total += merged.length;
  }
  const sortDesc = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([, a], [, b]) => b - a));
  return { stats, counts: sortDesc(counts), deleted: sortDesc(deleted) };
}

async function readManifest(dir: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function legacySnapshots(dir: string): Promise<{ dir: string; name: string; manifest: any }[]> {
  const root = join(dir, 'snapshots');
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of (await readdir(root)).sort()) {
    const manifest = await readManifest(join(root, name));
    if (manifest) out.push({ dir: join(root, name), name, manifest });
  }
  return out;
}

export const isLegacy = (dir: string) => existsSync(join(dir, 'snapshots'));

async function didOfDir(dir: string): Promise<string | null> {
  return (await readManifest(dir))?.did ?? (await legacySnapshots(dir)).at(-1)?.manifest.did ?? null;
}

async function locateAccountDir(out: string, id: Identity, log: (msg: string) => void) {
  const preferred = join(out, dirNameFor(id));
  if (existsSync(out)) {
    for (const name of await readdir(out)) {
      const dir = join(out, name);
      if (dir === preferred || (await didOfDir(dir)) !== id.did) continue;
      if (existsSync(preferred)) return dir;
      log(`  handle changed: moving ${name}/ to ${dirNameFor(id)}/`);
      await rename(dir, preferred);
      break;
    }
  }
  return preferred;
}

// see docs/archive-format.md#migrating-old-snapshots
export async function migrateAccount(dir: string, log: (msg: string) => void, opts: { write: boolean }) {
  const snaps = await legacySnapshots(dir);
  if (!snaps.length) return null;
  const work = join(dir, MIGRATING);
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, 'records'), { recursive: true });
  const updates: UpdateEntry[] = [];
  const keys = new Set<string>();
  let result = null;
  for (const snap of snaps) {
    result = await mergeRecords(join(work, 'records'), join(snap.dir, 'records'), snap.manifest.fetchedAt);
    updates.push({ at: snap.manifest.fetchedAt, ...result.stats });
    for (const c of await jsonlCollections(join(snap.dir, 'records'))) {
      for (const l of await readJsonl(join(snap.dir, 'records', `${c}.jsonl`))) keys.add(`${c}/${l.rkey}`);
    }
    log(`  ${snap.name}: ${snap.manifest.totalRecords} records → +${result.stats.added} new, ${result.stats.changed} changed, ${result.stats.deleted} gone`);
  }
  const latest = snaps.at(-1)!;
  const { stats, counts, deleted } = result!;
  if (stats.live !== latest.manifest.totalRecords || stats.total !== keys.size) {
    await rm(work, { recursive: true, force: true });
    throw new Error(`merge check failed for ${dir}: ${stats.live} live vs ${latest.manifest.totalRecords} in the latest snapshot, ${stats.total} kept vs ${keys.size} ever seen. Nothing was changed.`);
  }
  log(`  merged: ${stats.live} live + ${stats.total - stats.live} deleted = ${stats.total} records, matching every snapshot`);

  if (!opts.write) {
    await rm(work, { recursive: true, force: true });
    return { snapshots: snaps.length, ...stats };
  }
  for (const f of LATEST_COPIES) if (existsSync(join(latest.dir, f))) await cp(join(latest.dir, f), join(work, f));
  if (existsSync(join(latest.dir, 'identity'))) await cp(join(latest.dir, 'identity'), join(work, 'identity'), { recursive: true });
  for (const snap of snaps) {
    for (const f of TONE_FILES) {
      if (!existsSync(join(snap.dir, f))) continue;
      await mkdir(join(work, RETIRED_TONE, snap.name), { recursive: true });
      await cp(join(snap.dir, f), join(work, RETIRED_TONE, snap.name, f));
    }
  }
  const { blobDir: _old, ...manifest } = latest.manifest;
  await writeJson(join(work, 'manifest.json'), {
    ...manifest,
    firstArchivedAt: snaps[0].manifest.fetchedAt,
    totalRecords: stats.live,
    deletedRecords: stats.total - stats.live,
    counts,
    deleted,
    updates,
  });
  for (const name of await readdir(work)) {
    await rm(join(dir, name), { recursive: true, force: true });
    await rename(join(work, name), join(dir, name));
  }
  await rm(work, { recursive: true, force: true });
  await rm(join(dir, 'snapshots'), { recursive: true, force: true });
  await rm(join(dir, 'media-index.json'), { force: true });
  log(`  converted: ${snaps.length} snapshot${snaps.length === 1 ? '' : 's'} folded into one archive`);
  return { snapshots: snaps.length, ...stats };
}

export async function archiveAccount(input: string, opts: ArchiveOptions, log: (msg: string) => void) {
  const fetchedAt = new Date().toISOString();

  log(`resolving ${input}…`);
  const id = await resolveIdentity(input);
  log(`  ${id.handle ?? '(no handle)'} → ${id.did}${id.handleVerified ? '' : '  ⚠ handle does not verify'}`);
  log(`  PDS: ${id.pds}`);

  const dir = await locateAccountDir(opts.out, id, log);
  if (isLegacy(dir)) {
    log('converting old snapshots into one archive…');
    await migrateAccount(dir, log, { write: true });
  }
  const previous = await readManifest(dir);
  const incoming = join(dir, INCOMING);
  await rm(incoming, { recursive: true, force: true });
  await mkdir(join(incoming, 'records'), { recursive: true });
  await mkdir(join(dir, 'identity'), { recursive: true });

  await writeJson(join(dir, 'identity', 'did-document.json'), id.didDoc);
  if (id.plcAuditLog) await writeJson(join(dir, 'identity', 'plc-audit-log.json'), id.plcAuditLog);

  const profile = await fetchBskyProfile(id.did);
  if (profile) await writeJson(join(dir, 'bsky-profile.json'), profile);

  log('downloading repo…');
  const car = await fetchRepoCar(id.pds, id.did);
  await writeFile(join(dir, 'repo.car.tmp'), car);
  await rename(join(dir, 'repo.car.tmp'), join(dir, 'repo.car'));
  log(`  ${(car.byteLength / 1024 / 1024).toFixed(1)} MB`);

  // see docs/archive-format.md#media
  const mediaOn = opts.media === true || previous?.media?.enabled === true;
  const withMedia = opts.media ?? mediaOn;
  const blobUrl = (cid: string) => xrpc(id.pds, 'com.atproto.sync.getBlob', { did: id.did, cid });
  const blobs = new Map<string, string | undefined>();
  const streams = new Map<string, WriteStream>();
  const selfLabels = new Set<string>();

  log('decoding records…');
  for (const entry of fromUint8Array(car)) {
    // see docs/archive-format.md#record-json
    const record = JSON.parse(JSON.stringify(entry.record));
    const uri = `at://${id.did}/${entry.collection}/${entry.rkey}`;
    const refs: Ref[] = extractRefs(entry.collection, record, blobUrl);

    for (const ref of refs) {
      if (ref.kind !== 'blob') continue;
      blobs.set(ref.target, ref.mimeType ?? blobs.get(ref.target));
      if (mediaOn) ref.local = `blobs/${blobFileName(ref.target, ref.mimeType)}`;
    }
    if (entry.collection === 'app.bsky.actor.profile') {
      for (const l of record.labels?.values ?? []) selfLabels.add(l.val);
    }

    let out = streams.get(entry.collection);
    if (!out) {
      out = createWriteStream(join(incoming, 'records', `${entry.collection}.jsonl`));
      streams.set(entry.collection, out);
    }
    const line = { uri, web: webUrlForUri(uri), cid: entry.cid.$link, collection: entry.collection, rkey: entry.rkey, createdAt: record.createdAt ?? null, refs, record };
    if (!out.write(`${JSON.stringify(line)}\n`)) await new Promise((r) => out.once('drain', r));
  }
  await Promise.all([...streams.values()].map((s) => new Promise((r) => s.end(r))));

  log(previous ? 'merging with the existing archive…' : 'writing the archive…');
  const { stats, counts, deleted } = await mergeRecords(join(dir, 'records'), join(incoming, 'records'), fetchedAt);
  await rm(incoming, { recursive: true, force: true });
  await rm(join(dir, 'media-index.json'), { force: true });
  log(
    previous
      ? `  +${stats.added} new, ${stats.changed} changed, ${stats.deleted} deleted since last time${stats.restored ? `, ${stats.restored} back` : ''} · ${stats.live} live, ${stats.total - stats.live} kept as deleted`
      : `  ${stats.live} records across ${Object.keys(counts).length} collections, ${blobs.size} media blobs referenced`,
  );

  const media = withMedia && blobs.size
    ? { enabled: true, referenced: blobs.size, ...(await downloadBlobs(blobs, blobUrl, join(dir, 'blobs'), log)) }
    : { ...(previous?.media ?? { downloaded: 0, alreadyHad: 0, failed: [] as MediaFailure[] }), enabled: mediaOn, referenced: blobs.size };

  const noUnauthenticated =
    selfLabels.has('!no-unauthenticated') || profile?.labels?.some((l: any) => l.val === '!no-unauthenticated') === true;

  const manifest = {
    tool: 'bluesky-slurp',
    fetchedAt,
    firstArchivedAt: previous?.firstArchivedAt ?? fetchedAt,
    input,
    did: id.did,
    handle: id.handle,
    handleVerified: id.handleVerified,
    handleHistory: id.handleHistory,
    pds: id.pds,
    profileUrl: `https://bsky.app/profile/${id.did}`,
    hasBlueskyProfile: profile !== null,
    noUnauthenticated,
    selfLabels: [...selfLabels],
    totalRecords: stats.live,
    deletedRecords: stats.total - stats.live,
    counts,
    deleted,
    media,
    updates: [...(previous?.updates ?? []), { at: fetchedAt, ...stats }],
  };
  await writeJson(join(dir, 'manifest.json'), manifest);

  if (noUnauthenticated) {
    log('⚠ this account asks apps not to show its content to logged-out viewers (!no-unauthenticated).');
    log('  the data is still public in the protocol, but treat this archive accordingly.');
  }
  if (media.failed?.length && withMedia) log(`⚠ ${media.failed.length} media downloads failed; see manifest.json`);
  return { dir, manifest, stats, isNew: !previous };
}

export function blobFileName(cid: string, mimeType?: string | null): string {
  return `${cid}.${(mimeType && MIME_EXT[mimeType]) ?? 'bin'}`;
}

export type MediaFailure = { cid: string; error: string };

const DOWNLOAD_CONCURRENCY = 4;
const PROGRESS_EVERY = 25;

export async function downloadBlobs(
  blobs: Map<string, string | null | undefined>,
  blobUrl: (cid: string) => string,
  blobDir: string,
  log: (msg: string) => void,
) {
  const stats = { downloaded: 0, alreadyHad: 0, failed: [] as MediaFailure[] };
  if (!blobs.size) return stats;
  await mkdir(blobDir, { recursive: true });
  log(`downloading media (${blobs.size} files)…`);
  let done = 0;
  await pool([...blobs], DOWNLOAD_CONCURRENCY, async ([cid, mimeType]) => {
    const dest = join(blobDir, blobFileName(cid, mimeType));
    try {
      if (existsSync(dest)) stats.alreadyHad++;
      else {
        const res = await get(blobUrl(cid));
        await writeFile(`${dest}.part`, new Uint8Array(await res.arrayBuffer()));
        await rename(`${dest}.part`, dest);
        stats.downloaded++;
      }
    } catch (err) {
      stats.failed.push({ cid, error: String((err as Error).message ?? err) });
    }
    if (++done % PROGRESS_EVERY === 0 || done === blobs.size) log(`  ${done}/${blobs.size}`);
  });
  return stats;
}

// see docs/archive-format.md#updates
export async function writeJson(path: string, data: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

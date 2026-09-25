import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fromUint8Array } from '@atcute/repo';
import { get, pool, xrpc } from './http.ts';
import { fetchBskyProfile, fetchRepoCar, resolveIdentity } from './identity.ts';
import { extractRefs, webUrlForUri, type Ref } from './refs.ts';

export interface ArchiveOptions {
  media: boolean;
  out: string;
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

export async function archiveAccount(input: string, opts: ArchiveOptions, log: (msg: string) => void) {
  const fetchedAt = new Date().toISOString();

  log(`resolving ${input}…`);
  const id = await resolveIdentity(input);
  log(`  ${id.handle ?? '(no handle)'} → ${id.did}${id.handleVerified ? '' : '  ⚠ handle does not verify'}`);
  log(`  PDS: ${id.pds}`);

  const accountDir = join(opts.out, id.handle ?? id.did.replaceAll(':', '_'));
  const snapDir = join(accountDir, 'snapshots', fetchedAt.replaceAll(':', '-').replace(/\.\d+Z$/, 'Z'));
  const blobDir = join(accountDir, 'blobs');
  await mkdir(join(snapDir, 'records'), { recursive: true });
  await mkdir(join(snapDir, 'identity'), { recursive: true });

  await writeJson(join(snapDir, 'identity', 'did-document.json'), id.didDoc);
  if (id.plcAuditLog) await writeJson(join(snapDir, 'identity', 'plc-audit-log.json'), id.plcAuditLog);

  const profile = await fetchBskyProfile(id.did);
  if (profile) await writeJson(join(snapDir, 'bsky-profile.json'), profile);

  log('downloading repo…');
  const car = await fetchRepoCar(id.pds, id.did);
  await writeFile(join(snapDir, 'repo.car'), car);
  log(`  ${(car.byteLength / 1024 / 1024).toFixed(1)} MB`);

  const blobUrl = (cid: string) => xrpc(id.pds, 'com.atproto.sync.getBlob', { did: id.did, cid });
  const blobs = new Map<string, string | undefined>();
  const counts: Record<string, number> = {};
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
      if (opts.media) ref.local = `blobs/${blobFileName(ref.target, ref.mimeType)}`;
    }
    if (entry.collection === 'app.bsky.actor.profile') {
      for (const l of record.labels?.values ?? []) selfLabels.add(l.val);
    }

    let out = streams.get(entry.collection);
    if (!out) {
      out = createWriteStream(join(snapDir, 'records', `${entry.collection}.jsonl`));
      streams.set(entry.collection, out);
    }
    const line = {
      uri,
      web: webUrlForUri(uri),
      cid: entry.cid.$link,
      collection: entry.collection,
      rkey: entry.rkey,
      createdAt: record.createdAt ?? null,
      refs,
      record,
    };
    if (!out.write(`${JSON.stringify(line)}\n`)) await new Promise((r) => out.once('drain', r));
    counts[entry.collection] = (counts[entry.collection] ?? 0) + 1;
  }
  await Promise.all([...streams.values()].map((s) => new Promise((r) => s.end(r))));

  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);
  log(`  ${totalRecords} records across ${Object.keys(counts).length} collections, ${blobs.size} media blobs referenced`);

  const media = { enabled: opts.media, referenced: blobs.size, downloaded: 0, alreadyHad: 0, failed: [] as { cid: string; error: string }[] };
  if (opts.media && blobs.size) {
    await mkdir(blobDir, { recursive: true });
    log('downloading media…');
    let done = 0;
    await pool([...blobs], 4, async ([cid, mimeType]) => {
      const dest = join(blobDir, blobFileName(cid, mimeType));
      try {
        if (existsSync(dest)) media.alreadyHad++;
        else {
          const res = await get(blobUrl(cid));
          await writeFile(`${dest}.part`, new Uint8Array(await res.arrayBuffer()));
          await rename(`${dest}.part`, dest);
          media.downloaded++;
        }
      } catch (err) {
        media.failed.push({ cid, error: String((err as Error).message ?? err) });
      }
      if (++done % 25 === 0 || done === blobs.size) log(`  ${done}/${blobs.size}`);
    });
  }

  const noUnauthenticated =
    selfLabels.has('!no-unauthenticated') || profile?.labels?.some((l: any) => l.val === '!no-unauthenticated') === true;

  const manifest = {
    tool: 'bluesky-profile-slurper',
    fetchedAt,
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
    totalRecords,
    counts: Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a)),
    media,
    blobDir: opts.media ? '../../blobs' : null,
  };
  await writeJson(join(snapDir, 'manifest.json'), manifest);

  if (noUnauthenticated) {
    log('⚠ this account asks apps not to show its content to logged-out viewers (!no-unauthenticated).');
    log('  the data is still public in the protocol, but treat this archive accordingly.');
  }
  if (media.failed.length) log(`⚠ ${media.failed.length} media downloads failed; see manifest.json`);
  return { snapDir, manifest };
}

function blobFileName(cid: string, mimeType?: string): string {
  return `${cid}.${(mimeType && MIME_EXT[mimeType]) ?? 'bin'}`;
}

async function writeJson(path: string, data: unknown) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}


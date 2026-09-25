#!/usr/bin/env node
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fromUint8Array } from '@atcute/repo';
import { get, pool, xrpc } from './http.ts';
import { DEFAULT_MODEL, runAnalyze } from './analyze.ts';
import { fetchBskyProfile, fetchRepoCar, resolveIdentity } from './identity.ts';
import { extractRefs, webUrlForUri, type Ref } from './refs.ts';

const HELP = `slurp — archive everything an atproto account has publicly put on the network

usage: slurp <handle | did | bsky.app profile URL> [options]
       slurp analyze <handle | snapshot dir> [--tone] [--out <dir>]

options:
  --media        also download images, video and other blobs (off by default)
  --analyze      write analysis.md / analysis.json into the snapshot after archiving
  --tone         add a Claude tone pass to the analysis (shows a token/cost estimate and asks first)
  --model <id>   model for the tone pass (default: ${DEFAULT_MODEL})
  --tone-limit <n>  max posts to label: 75% most recent cold, 25% warm baseline (default: 200)
  -y, --yes      skip the tone-pass confirmation
  --out <dir>    archive root (default: ./archives)
  -h, --help     show this help

output: <out>/<handle>/snapshots/<timestamp>/ plus a shared <out>/<handle>/blobs/ for media`;

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

const log = (msg: string) => process.stderr.write(`${msg}\n`);

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      media: { type: 'boolean', default: false },
      analyze: { type: 'boolean', default: false },
      tone: { type: 'boolean', default: false },
      model: { type: 'string', default: DEFAULT_MODEL },
      'tone-limit': { type: 'string', default: '200' },
      yes: { type: 'boolean', short: 'y', default: false },
      out: { type: 'string', default: 'archives' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const tone = values.tone ? { model: values.model!, limit: Number(values['tone-limit']), yes: values.yes! } : undefined;
  if (positionals[0] === 'analyze' && positionals.length === 2) {
    const snap = await runAnalyze(positionals[1], values.out!, tone, log);
    log(`analysis → ${join(snap, 'analysis.md')}`);
    return;
  }
  if (values.help || positionals.length !== 1) {
    log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const input = positionals[0];
  const fetchedAt = new Date().toISOString();

  log(`resolving ${input}…`);
  const id = await resolveIdentity(input);
  log(`  ${id.handle ?? '(no handle)'} → ${id.did}${id.handleVerified ? '' : '  ⚠ handle does not verify'}`);
  log(`  PDS: ${id.pds}`);

  const accountDir = join(values.out!, id.handle ?? id.did.replaceAll(':', '_'));
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
  const blobs = new Map<string, string | undefined>(); // cid → mimeType
  const counts: Record<string, number> = {};
  const streams = new Map<string, WriteStream>();
  const selfLabels = new Set<string>();

  log('decoding records…');
  for (const entry of fromUint8Array(car)) {
    const record = JSON.parse(JSON.stringify(entry.record)); // CidLink → {$link}, bytes → {$bytes}
    const uri = `at://${id.did}/${entry.collection}/${entry.rkey}`;
    const refs: Ref[] = extractRefs(entry.collection, record, blobUrl);

    for (const ref of refs) {
      if (ref.kind !== 'blob') continue;
      blobs.set(ref.target, ref.mimeType ?? blobs.get(ref.target));
      if (values.media) ref.local = `blobs/${blobFileName(ref.target, ref.mimeType)}`;
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

  const media = { enabled: values.media, referenced: blobs.size, downloaded: 0, alreadyHad: 0, failed: [] as { cid: string; error: string }[] };
  if (values.media && blobs.size) {
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
    blobDir: values.media ? '../../blobs' : null,
  };
  await writeJson(join(snapDir, 'manifest.json'), manifest);

  if (noUnauthenticated) {
    log('⚠ this account asks apps not to show its content to logged-out viewers (!no-unauthenticated).');
    log('  the data is still public in the protocol, but treat this archive accordingly.');
  }
  if (media.failed.length) log(`⚠ ${media.failed.length} media downloads failed; see manifest.json`);
  if (values.analyze || values.tone) {
    log('analyzing…');
    await runAnalyze(snapDir, values.out!, tone, log);
  }
  log(`done → ${snapDir}`);
}

function blobFileName(cid: string, mimeType?: string): string {
  return `${cid}.${(mimeType && MIME_EXT[mimeType]) ?? 'bin'}`;
}

async function writeJson(path: string, data: unknown) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

main().catch((err) => {
  log(`error: ${err?.message ?? err}`);
  process.exit(1);
});

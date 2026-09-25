import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { blobFileName, downloadBlobs, writeJson } from './archive.ts';
import { xrpc } from './http.ts';
import type { Ref } from './refs.ts';

export type MediaKind = 'image' | 'video' | 'other';

export interface MediaUse {
  uri: string;
  web: string;
  collection: string;
  rkey: string;
  createdAt: string | null;
  role: string;
  alt: string | null;
  text: string | null;
  labels: string[];
}

export interface MediaItem {
  cid: string;
  mimeType: string | null;
  kind: MediaKind;
  file: string;
  at: string | null;
  uses: MediaUse[];
}

const INDEX_FILE = 'media-index.json';
const INDEX_VERSION = 1;

export const accountDirOf = (snapDir: string) => join(snapDir, '..', '..');
export const blobDirOf = (snapDir: string) => join(accountDirOf(snapDir), 'blobs');

const kindOf = (mime: string | null): MediaKind => (mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : 'other');

function atPath(root: any, path: string): any {
  let node = root;
  for (const part of path.match(/[^.[\]]+/g) ?? []) node = node?.[/^\d+$/.test(part) ? Number(part) : part];
  return node;
}

function altFor(record: any, path: string): string | null {
  const parent = atPath(record, path.replace(/\.[^.]+$/, ''));
  return typeof parent?.alt === 'string' && parent.alt.trim() ? parent.alt : null;
}

async function buildIndex(snapDir: string): Promise<MediaItem[]> {
  const items = new Map<string, MediaItem>();
  const recordsDir = join(snapDir, 'records');
  for (const file of (await readdir(recordsDir)).filter((f) => f.endsWith('.jsonl'))) {
    const text = await readFile(join(recordsDir, file), 'utf8');
    for (const raw of text.split('\n')) {
      if (!raw.includes('"kind":"blob"')) continue;
      const line = JSON.parse(raw);
      const r = line.record;
      for (const ref of line.refs as Ref[]) {
        if (ref.kind !== 'blob') continue;
        const item = items.get(ref.target) ?? {
          cid: ref.target,
          mimeType: ref.mimeType ?? null,
          kind: kindOf(ref.mimeType ?? null),
          file: blobFileName(ref.target, ref.mimeType),
          at: null,
          uses: [],
        };
        item.uses.push({
          uri: line.uri,
          web: line.web,
          collection: line.collection,
          rkey: line.rkey,
          createdAt: line.createdAt,
          role: ref.path,
          alt: altFor(r, ref.path),
          text: [r.text, r.description, r.displayName].find((v) => typeof v === 'string' && v.trim()) ?? null,
          labels: (r.labels?.values ?? []).map((l: any) => l.val).filter((v: string) => !v.startsWith('!')),
        });
        if (line.createdAt && (!item.at || line.createdAt > item.at)) item.at = line.createdAt;
        items.set(ref.target, item);
      }
    }
  }
  return [...items.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

export async function loadMediaIndex(snapDir: string): Promise<MediaItem[]> {
  const path = join(snapDir, INDEX_FILE);
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    if (cached.version === INDEX_VERSION) return cached.items;
  } catch {}
  const items = await buildIndex(snapDir);
  await writeJson(path, { version: INDEX_VERSION, items });
  return items;
}

export async function localBlobFiles(snapDir: string): Promise<Set<string>> {
  const dir = blobDirOf(snapDir);
  return existsSync(dir) ? new Set((await readdir(dir)).filter((f) => !f.endsWith('.part'))) : new Set();
}

export async function localBlobBytes(snapDir: string, files: Iterable<string>): Promise<number> {
  const dir = blobDirOf(snapDir);
  let total = 0;
  for (const f of files) total += (await stat(join(dir, f)).catch(() => ({ size: 0 }))).size;
  return total;
}

export async function downloadSnapshotMedia(snapDir: string, log: (msg: string) => void) {
  const manifestPath = join(snapDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const items = await loadMediaIndex(snapDir);
  const blobUrl = (cid: string) => xrpc(manifest.pds, 'com.atproto.sync.getBlob', { did: manifest.did, cid });
  const stats = await downloadBlobs(new Map(items.map((i) => [i.cid, i.mimeType])), blobUrl, blobDirOf(snapDir), log);
  manifest.media = { enabled: true, referenced: items.length, ...stats };
  manifest.blobDir = '../../blobs';
  await writeJson(manifestPath, manifest);
  if (stats.failed.length) log(`⚠ ${stats.failed.length} media downloads failed; see manifest.json`);
  return stats;
}

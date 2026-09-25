import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Report } from './analyze.ts';
import type { Ref } from './refs.ts';

export const ARCHIVE_ROOT = resolve(process.env.SLURP_ARCHIVES ?? 'archives');

// see docs/web-ui.md#security
export const SAFE_NAME = /^[A-Za-z0-9._:-]+$/;

export interface RecordLine {
  uri: string;
  web: string;
  cid: string;
  collection: string;
  rkey: string;
  createdAt: string | null;
  refs: Ref[];
  record: any;
}

export interface SnapshotSummary {
  snapshot: string;
  fetchedAt: string;
  totalRecords: number;
  collections: number;
  media: boolean;
  analysis: boolean;
}

export interface AccountSummary {
  handle: string;
  did: string;
  displayName: string | null;
  avatar: string | null;
  snapshots: SnapshotSummary[];
}

export interface Snapshot {
  handle: string;
  snapshot: string;
  dir: string;
  manifest: any;
  profile: any | null;
  analysis: Report | null;
}

export function snapshotDir(handle: string, snapshot: string): string | null {
  if (!SAFE_NAME.test(handle) || !SAFE_NAME.test(snapshot)) return null;
  const dir = join(ARCHIVE_ROOT, handle, 'snapshots', snapshot);
  return dir.startsWith(ARCHIVE_ROOT + sep) && existsSync(dir) ? dir : null;
}

export async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function listAccounts(): Promise<AccountSummary[]> {
  if (!existsSync(ARCHIVE_ROOT)) return [];
  const accounts: AccountSummary[] = [];
  for (const handle of (await readdir(ARCHIVE_ROOT)).sort()) {
    const snapsDir = join(ARCHIVE_ROOT, handle, 'snapshots');
    if (!SAFE_NAME.test(handle) || !existsSync(snapsDir)) continue;
    const snapshots: SnapshotSummary[] = [];
    for (const snapshot of (await readdir(snapsDir)).sort().reverse()) {
      const dir = join(snapsDir, snapshot);
      const m = await readJson(join(dir, 'manifest.json'));
      if (!m) continue;
      snapshots.push({
        snapshot,
        fetchedAt: m.fetchedAt,
        totalRecords: m.totalRecords,
        collections: Object.keys(m.counts).length,
        media: m.media?.enabled ?? false,
        analysis: existsSync(join(dir, 'analysis.json')),
      });
    }
    if (!snapshots.length) continue;
    const latest = join(snapsDir, snapshots[0].snapshot);
    const manifest = await readJson(join(latest, 'manifest.json'));
    const profile = await readJson(join(latest, 'bsky-profile.json'));
    accounts.push({ handle, did: manifest.did, displayName: profile?.displayName ?? null, avatar: profile?.avatar ?? null, snapshots });
  }
  return accounts;
}

export async function loadSnapshot(handle: string, snapshot: string): Promise<Snapshot | null> {
  const dir = snapshotDir(handle, snapshot);
  if (!dir) return null;
  const manifest = await readJson(join(dir, 'manifest.json'));
  if (!manifest) return null;
  return {
    handle,
    snapshot,
    dir,
    manifest,
    profile: await readJson(join(dir, 'bsky-profile.json')),
    analysis: await readJson<Report>(join(dir, 'analysis.json')),
  };
}

export async function loadIdentity(dir: string) {
  return {
    didDocument: await readJson(join(dir, 'identity', 'did-document.json')),
    plcAuditLog: await readJson<any[]>(join(dir, 'identity', 'plc-audit-log.json')),
  };
}

export async function readRecords(dir: string, collection: string, offset: number, limit: number, order: 'newest' | 'oldest') {
  if (!SAFE_NAME.test(collection)) return null;
  const file = join(dir, 'records', `${collection}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  // see docs/archive-format.md#record-order
  if (order === 'newest') lines.reverse();
  return { total: lines.length, records: lines.slice(offset, offset + limit).map((l) => JSON.parse(l) as RecordLine) };
}


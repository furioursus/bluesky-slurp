import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Report } from './analyze.ts';
import type { RecordLine } from './archive.ts';

export type { RecordLine } from './archive.ts';

export const ARCHIVE_ROOT = resolve(process.env.SLURP_ARCHIVES ?? 'archives');

// see docs/web-ui.md#security
export const SAFE_NAME = /^[A-Za-z0-9._:-]+$/;

export type DeletedFilter = 'all' | 'deleted';

const DELETED_TAIL = /"deletedAt":"[^"]+"}$/;

export interface AccountSummary {
  handle: string;
  did: string;
  displayName: string | null;
  avatar: string | null;
  updatedAt: string;
  firstArchivedAt: string;
  totalRecords: number;
  deletedRecords: number;
  legacy: boolean;
}

export interface Archive {
  handle: string;
  dir: string;
  manifest: any;
  profile: any | null;
  analysis: Report | null;
}

export function archiveDir(handle: string): string | null {
  if (!SAFE_NAME.test(handle)) return null;
  const dir = join(ARCHIVE_ROOT, handle);
  return dir.startsWith(ARCHIVE_ROOT + sep) && existsSync(join(dir, 'manifest.json')) ? dir : null;
}

export async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function latestLegacy(dir: string) {
  const snaps = join(dir, 'snapshots');
  if (!existsSync(snaps)) return null;
  const latest = (await readdir(snaps)).sort().at(-1);
  return latest ? join(snaps, latest) : null;
}

export async function listAccounts(): Promise<AccountSummary[]> {
  if (!existsSync(ARCHIVE_ROOT)) return [];
  const accounts: AccountSummary[] = [];
  for (const handle of (await readdir(ARCHIVE_ROOT)).sort()) {
    if (!SAFE_NAME.test(handle)) continue;
    const dir = join(ARCHIVE_ROOT, handle);
    const current = existsSync(join(dir, 'manifest.json'));
    const source = current ? dir : await latestLegacy(dir);
    const m = source && (await readJson(join(source, 'manifest.json')));
    if (!m) continue;
    const profile = await readJson(join(source, 'bsky-profile.json'));
    accounts.push({
      handle,
      did: m.did,
      displayName: profile?.displayName ?? null,
      avatar: profile?.avatar ?? null,
      updatedAt: m.fetchedAt,
      firstArchivedAt: m.firstArchivedAt ?? m.fetchedAt,
      totalRecords: m.totalRecords,
      deletedRecords: m.deletedRecords ?? 0,
      legacy: !current,
    });
  }
  return accounts;
}

export async function loadArchive(handle: string): Promise<Archive | null> {
  const dir = archiveDir(handle);
  if (!dir) return null;
  const manifest = await readJson(join(dir, 'manifest.json'));
  if (!manifest) return null;
  return {
    handle,
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

export async function readRecords(dir: string, collection: string, offset: number, limit: number, order: 'newest' | 'oldest', filter: DeletedFilter = 'all') {
  if (!SAFE_NAME.test(collection)) return null;
  const file = join(dir, 'records', `${collection}.jsonl`);
  if (!existsSync(file)) return null;
  let lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  if (filter === 'deleted') lines = lines.filter((l) => DELETED_TAIL.test(l));
  // see docs/archive-format.md#record-order
  if (order === 'newest') lines.reverse();
  return { total: lines.length, records: lines.slice(offset, offset + limit).map((l) => JSON.parse(l) as RecordLine) };
}

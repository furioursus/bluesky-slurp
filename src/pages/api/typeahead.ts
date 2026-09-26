import type { APIRoute } from 'astro';
import { searchActors } from '../../lib/appview.ts';
import { listAccounts } from '../../lib/archives.ts';
import { SENSITIVE } from '../../lib/ui.ts';

const MAX_QUERY = 64;
const LIMIT = 8;
const LOCAL_LIMIT = 3;

// see docs/web-ui.md#handle-autocomplete
export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim().replace(/^@/, '').slice(0, MAX_QUERY);
  if (!q || q.startsWith('did:') || q.includes('/')) return Response.json({ actors: [], offline: false });
  const needle = q.toLowerCase();
  const [accounts, remote] = await Promise.all([listAccounts(), searchActors(q)]);
  const archived = new Set(accounts.map((a) => a.did));
  const local = accounts
    .filter((a) => a.handle.toLowerCase().includes(needle) || a.displayName?.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.handle.toLowerCase().startsWith(needle)) - Number(a.handle.toLowerCase().startsWith(needle)))
    .slice(0, LOCAL_LIMIT)
    .map((a) => ({ did: a.did, handle: a.handle, displayName: a.displayName, avatar: a.avatar, labels: [] as string[] }));
  const seen = new Set(local.map((a) => a.did));
  const actors = [...local, ...(remote ?? []).filter((a) => !seen.has(a.did))].slice(0, LIMIT).map((a) => ({
    handle: a.handle,
    displayName: a.displayName,
    avatar: a.avatar?.startsWith('https://') ? a.avatar : null,
    sensitive: a.labels.some((l) => SENSITIVE.has(l)),
    archived: archived.has(a.did),
  }));
  return Response.json({ actors, offline: remote === undefined });
};

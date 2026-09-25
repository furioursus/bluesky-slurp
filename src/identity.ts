import { resolveTxt } from 'node:dns/promises';
import { get, getJson, xrpc } from './http.ts';

const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const PLC = 'https://plc.directory';

export interface Identity {
  did: string;
  handle: string | null;
  /** true when the handle resolves back to the same DID */
  handleVerified: boolean;
  pds: string;
  didDoc: any;
  /** did:plc only: every handle this account has claimed, oldest first */
  handleHistory: { handle: string; since: string }[] | null;
  plcAuditLog: any[] | null;
}

/** Accepts a handle, @handle, DID, at:// URI, or a bsky.app profile/post URL. */
export function normalizeInput(raw: string): string {
  let s = raw.trim();
  const url = s.match(/^https?:\/\/[^/]+\/profile\/([^/?#]+)/);
  if (url) s = decodeURIComponent(url[1]);
  s = s.replace(/^at:\/\//, '').replace(/^@/, '').split('/')[0];
  return s.startsWith('did:') ? s : s.toLowerCase();
}

export async function resolveHandle(handle: string): Promise<string> {
  try {
    const records = await resolveTxt(`_atproto.${handle}`);
    for (const chunks of records) {
      const txt = chunks.join('');
      if (txt.startsWith('did=')) return txt.slice(4);
    }
  } catch {}
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const did = (await res.text()).trim();
      if (did.startsWith('did:')) return did;
    }
  } catch {}
  // Last resort: ask the Bluesky AppView (covers odd DNS setups on this machine).
  const { did } = await getJson(xrpc(PUBLIC_APPVIEW, 'com.atproto.identity.resolveHandle', { handle }));
  return did;
}

async function fetchDidDoc(did: string): Promise<any> {
  if (did.startsWith('did:plc:')) return getJson(`${PLC}/${did}`);
  if (did.startsWith('did:web:')) {
    const host = decodeURIComponent(did.slice('did:web:'.length));
    return getJson(`https://${host}/.well-known/did.json`);
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

function handleHistoryFrom(log: any[]): { handle: string; since: string }[] {
  const out: { handle: string; since: string }[] = [];
  for (const entry of log) {
    if (entry.nullified) continue;
    const op = entry.operation;
    const aka: string[] = op.alsoKnownAs ?? (op.handle ? [`at://${op.handle}`] : []);
    const handle = aka.find((a) => a.startsWith('at://'))?.slice(5);
    if (handle && out.at(-1)?.handle !== handle) out.push({ handle, since: entry.createdAt });
  }
  return out;
}

export async function resolveIdentity(input: string): Promise<Identity> {
  const id = normalizeInput(input);
  const did = id.startsWith('did:') ? id : await resolveHandle(id);
  const didDoc = await fetchDidDoc(did);

  const pds = didDoc.service?.find((s: any) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`)?.serviceEndpoint;
  if (!pds) throw new Error(`${did} has no #atproto_pds service in its DID document`);

  const handle: string | null = didDoc.alsoKnownAs?.find((a: string) => a.startsWith('at://'))?.slice(5) ?? null;
  let handleVerified = false;
  if (handle) {
    try {
      handleVerified = (await resolveHandle(handle)) === did;
    } catch {}
  }

  let plcAuditLog: any[] | null = null;
  if (did.startsWith('did:plc:')) {
    plcAuditLog = await getJson(`${PLC}/${did}/log/audit`).catch(() => null);
  }

  return {
    did,
    handle,
    handleVerified,
    pds,
    didDoc,
    handleHistory: plcAuditLog ? handleHistoryFrom(plcAuditLog) : null,
    plcAuditLog,
  };
}

/** The Bluesky AppView's view of the profile (counts, labels). Null if the account has no Bluesky presence. */
export async function fetchBskyProfile(did: string): Promise<any | null> {
  try {
    return await getJson(xrpc(PUBLIC_APPVIEW, 'app.bsky.actor.getProfile', { actor: did }));
  } catch {
    return null;
  }
}

export async function fetchRepoCar(pds: string, did: string): Promise<Uint8Array> {
  const res = await get(xrpc(pds, 'com.atproto.sync.getRepo', { did }));
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Pointers from a record to the things it interacts with: the post a like targets,
 * the parent of a reply, the account a follow points at, embedded media, and so on.
 *
 * Extraction is generic (walk the record, pick up every at:// URI, DID, blob and
 * outbound link) so it works for any lexicon on the atmosphere. Bluesky collections
 * then get friendly role names on top.
 */

export type RefKind = 'record' | 'account' | 'blob' | 'link';

export interface Ref {
  /** what this pointer means, e.g. "liked", "reply-parent", "quoted", "mentioned" */
  role: string;
  kind: RefKind;
  /** where in the record it was found, e.g. "reply.parent" */
  path: string;
  /** canonical address: at:// URI, DID, blob CID, or https URL */
  target: string;
  /** a link a human can open in a browser */
  web: string;
  /** strongRef CID: the exact version of the record that was interacted with */
  cid?: string;
  mimeType?: string;
  /** set when media was downloaded: path relative to the archive root */
  local?: string;
}

const AT_URI = /^at:\/\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const DID = /^did:(plc|web):[A-Za-z0-9._:%-]+$/;

/** Best human-facing URL for an at:// URI. Bluesky types go to bsky.app, anything else to pdsls.dev. */
export function webUrlForUri(uri: string): string {
  const m = uri.match(AT_URI);
  if (!m) return uri;
  const [, repo, collection, rkey] = m;
  if (!collection || collection === 'app.bsky.actor.profile') return `https://bsky.app/profile/${repo}`;
  switch (collection) {
    case 'app.bsky.feed.post':
      return `https://bsky.app/profile/${repo}/post/${rkey}`;
    case 'app.bsky.feed.generator':
      return `https://bsky.app/profile/${repo}/feed/${rkey}`;
    case 'app.bsky.graph.list':
      return `https://bsky.app/profile/${repo}/lists/${rkey}`;
    case 'app.bsky.graph.starterpack':
      return `https://bsky.app/starter-pack/${repo}/${rkey}`;
  }
  return `https://pdsls.dev/${uri}`;
}

export function webUrlForDid(did: string): string {
  return `https://bsky.app/profile/${did}`;
}

/** Friendly role for a pointer, given the collection it lives in and where it was found. */
function roleFor(collection: string, path: string, kind: RefKind): string {
  if (kind === 'blob') return 'media';
  if (path === 'subject' || path === 'subject.uri') {
    const byCollection: Record<string, string> = {
      'app.bsky.feed.like': 'liked',
      'app.bsky.feed.repost': 'reposted',
      'app.bsky.graph.follow': 'followed',
      'app.bsky.graph.block': 'blocked',
      'app.bsky.graph.listitem': 'list-member',
      'app.bsky.graph.listblock': 'blocked-list',
      'app.bsky.graph.verification': 'verified',
    };
    if (byCollection[collection]) return byCollection[collection];
    // other apps reuse Bluesky's naming (sh.tangled.graph.follow, id.sifa.graph.follow, …)
    const suffix = collection.split('.').slice(-2).join('.');
    const bySuffix: Record<string, string> = {
      'feed.like': 'liked',
      'feed.repost': 'reposted',
      'graph.follow': 'followed',
      'graph.block': 'blocked',
    };
    if (bySuffix[suffix]) return bySuffix[suffix];
  }
  if (path === 'via' || path === 'via.uri') return 'via-repost';
  if (path === 'reply.parent') return 'reply-parent';
  if (path === 'reply.root') return 'reply-root';
  if (/^embed\.record(\.record)?$/.test(path)) return 'quoted';
  if (/^facets\[\d+\]\.features\[\d+\]$/.test(path)) return kind === 'account' ? 'mentioned' : 'linked';
  if (path === 'list') return 'list';
  if (path === 'post' && (collection === 'app.bsky.feed.threadgate' || collection === 'app.bsky.feed.postgate')) {
    return 'gated-post';
  }
  if (kind === 'link') return 'linked';
  return path;
}

/**
 * Walk a JSON-form record and collect every pointer in it.
 * `blobUrl` builds a fetchable URL for a blob CID (from the author's PDS).
 */
export function extractRefs(collection: string, record: unknown, blobUrl: (cid: string) => string): Ref[] {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const push = (ref: Omit<Ref, 'role'>) => {
    const key = `${ref.path}|${ref.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ role: roleFor(collection, ref.path, ref.kind), ...ref });
  };

  const walk = (v: unknown, path: string, key: string) => {
    if (typeof v === 'string') {
      if (AT_URI.test(v)) push({ kind: 'record', path, target: v, web: webUrlForUri(v) });
      else if (DID.test(v)) push({ kind: 'account', path, target: v, web: webUrlForDid(v) });
      else if (key === 'uri' && /^https?:\/\//.test(v)) push({ kind: 'link', path: parentPath(path), target: v, web: v });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, key));
      return;
    }
    if (!v || typeof v !== 'object') return;
    const obj = v as Record<string, any>;

    if (obj.$type === 'blob' && obj.ref?.$link) {
      const cid = obj.ref.$link;
      push({ kind: 'blob', path, target: cid, web: blobUrl(cid), mimeType: obj.mimeType });
      return;
    }
    // strongRef {uri, cid}: report at the object's own path so "reply.parent" reads naturally
    if (typeof obj.uri === 'string' && AT_URI.test(obj.uri)) {
      push({
        kind: 'record',
        path,
        target: obj.uri,
        web: webUrlForUri(obj.uri),
        ...(typeof obj.cid === 'string' ? { cid: obj.cid } : {}),
      });
    }
    // facet mention {did} and similar: report at the containing object
    if (typeof obj.did === 'string' && DID.test(obj.did)) {
      push({ kind: 'account', path, target: obj.did, web: webUrlForDid(obj.did) });
    }
    for (const [k, child] of Object.entries(obj)) {
      if (k === '$type' || (k === 'cid' && typeof obj.uri === 'string')) continue;
      if ((k === 'uri' && AT_URI.test(child)) || (k === 'did' && DID.test(child))) continue;
      walk(child, path ? `${path}.${k}` : k, k);
    }
  };

  walk(record, '', '');
  return refs;
}

function parentPath(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? path : path.slice(0, i);
}

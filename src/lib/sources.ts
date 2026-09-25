import { webUrlForUri } from './refs.ts';

export type LinkKind = 'record' | 'verified' | 'estimated' | 'raw';

export interface SourceLink {
  label: string;
  url: string;
  kind: LinkKind;
}

export interface RecordRef {
  uri: string;
  collection: string;
  rkey: string;
}

type Pattern = { url: string; kind: 'verified' | 'estimated' };

interface AppRule {
  app: string;
  profile?: Pattern;
  records?: Record<string, Pattern>;
}

const verified = (url: string): Pattern => ({ url, kind: 'verified' });
const estimated = (url: string): Pattern => ({ url, kind: 'estimated' });

// see docs/web-ui.md#source-links
const APPS: Record<string, AppRule> = {
  'social.popfeed': {
    app: 'Popfeed',
    profile: verified('https://popfeed.social/profile/{handle}'),
    records: {
      'social.popfeed.feed.review': verified('https://popfeed.social/review/{uri}'),
      'social.popfeed.feed.list': verified('https://popfeed.social/list/{uri}'),
    },
  },
  'is.currents': {
    app: 'Currents',
    profile: verified('https://currents.is/profile/{handle}'),
    records: { 'is.currents.feed.save': verified('https://currents.is/profile/{handle}/save/{rkey}') },
  },
  'social.grain': {
    app: 'Grain',
    profile: verified('https://grain.social/profile/{handle}'),
    records: { 'social.grain.gallery': estimated('https://grain.social/profile/{handle}/gallery/{rkey}') },
  },
  'app.atmobb': { app: 'atmoBB', profile: verified('https://atmobb.app/members/{handle}') },
  'sh.tangled': {
    app: 'Tangled',
    profile: verified('https://tangled.org/{handle}'),
    records: { 'sh.tangled.repo': verified('https://tangled.org/{handle}/{rkey}') },
  },
  'app.rocksky': {
    app: 'Rocksky',
    profile: verified('https://rocksky.app/profile/{handle}'),
    records: {
      'app.rocksky.song': estimated('https://rocksky.app/{did}/song/{rkey}'),
      'app.rocksky.scrobble': estimated('https://rocksky.app/{did}/scrobble/{rkey}'),
      'app.rocksky.album': estimated('https://rocksky.app/{did}/album/{rkey}'),
      'app.rocksky.artist': estimated('https://rocksky.app/{did}/artist/{rkey}'),
    },
  },
  'id.sifa': { app: 'Sifa', profile: verified('https://sifa.id/p/{handle}') },
  'com.whtwnd': {
    app: 'WhiteWind',
    profile: verified('https://whtwnd.com/{handle}'),
    records: { 'com.whtwnd.blog.entry': verified('https://whtwnd.com/{handle}/{rkey}') },
  },
  'fyi.unravel': { app: 'Frontpage', profile: verified('https://frontpage.fyi/profile/{handle}') },
  'events.smokesignal': { app: 'Smoke Signal', records: { 'events.smokesignal.calendar.event': estimated('https://smokesignal.events/{did}/{rkey}') } },
  'blue.linkat': { app: 'Linkat', profile: estimated('https://linkat.blue/{handle}'), records: { 'blue.linkat.board': estimated('https://linkat.blue/{handle}') } },
  'im.flushing': { app: 'Flushes', profile: verified('https://flushes.app/profile/{handle}') },
};

const rkeyOf = (uri: unknown) => (typeof uri === 'string' && uri.startsWith('at://') ? uri.split('/').pop() : null);

const RECORD_DERIVED: Record<string, (record: any) => SourceLink | null> = {
  'social.popfeed.feed.listItem': (r) =>
    typeof r.listUri === 'string' && r.listUri.startsWith('at://') ? { label: 'Popfeed list', url: `https://popfeed.social/list/at:/${r.listUri.slice(5)}`, kind: 'verified' } : null,
  'app.atmobb.discussion.thread': (r) => (rkeyOf(r.board) ? { label: 'atmoBB board', url: `https://atmobb.app/b/${rkeyOf(r.board)}`, kind: 'verified' } : null),
};

const OWN_URL_FIELDS = ['url', 'originUrl', 'website'];
const OWN_URL_BY_COLLECTION: Record<string, string> = { 'app.bsky.actor.status': 'embed.external.uri' };

const https = (v: unknown): v is string => typeof v === 'string' && /^https:\/\//.test(v);
const host = (url: string) => new URL(url).host.replace(/^www\./, '');
const at = (record: any, path: string) => path.split('.').reduce((node, key) => node?.[key], record);

export function recordLinks(collection: string, record: any): SourceLink[] {
  const paths = [...OWN_URL_FIELDS, OWN_URL_BY_COLLECTION[collection]].filter(Boolean) as string[];
  const found = new Set<string>();
  const out: SourceLink[] = [];
  for (const path of paths) {
    const url = at(record, path);
    if (!https(url) || found.has(url)) continue;
    found.add(url);
    out.push({ label: path === 'originUrl' ? `Saved from ${host(url)}` : host(url), url, kind: 'record' });
  }
  const derived = RECORD_DERIVED[collection]?.(record);
  if (derived) out.push(derived);
  return out;
}

const fill = (pattern: string, ref: RecordRef, did: string, handle: string | null) =>
  pattern
    .replaceAll('{uri}', `at:/${ref.uri.slice(5)}`)
    .replaceAll('{handle}', handle ?? did)
    .replaceAll('{did}', did)
    .replaceAll('{rkey}', encodeURIComponent(ref.rkey));

function appLink(ref: RecordRef, did: string, handle: string | null): SourceLink | null {
  if (ref.collection.startsWith('app.bsky.')) {
    const bsky = webUrlForUri(ref.uri);
    if (bsky.startsWith('https://bsky.app/')) return { label: 'Bluesky', url: bsky, kind: 'verified' };
    if (ref.collection === 'app.bsky.actor.status') return { label: 'Bluesky profile', url: `https://bsky.app/profile/${handle ?? did}`, kind: 'verified' };
    return null;
  }
  const ns = ref.collection.split('.').slice(0, 2).join('.');
  const rule = APPS[ns];
  if (!rule) return null;
  const own = rule.records?.[ref.collection];
  if (own) return { label: rule.app, url: fill(own.url, ref, did, handle), kind: own.kind };
  if (!rule.profile) return null;
  const isProfile = ref.rkey === 'self' || ref.collection.endsWith('.profile');
  return { label: isProfile ? rule.app : `${rule.app} profile`, url: fill(rule.profile.url, ref, did, handle), kind: rule.profile.kind };
}

export function sourceLinks(ref: RecordRef, handle: string | null, fromRecord: SourceLink[] = []): SourceLink[] {
  const did = ref.uri.slice(5).split('/')[0];
  const derived = fromRecord.some((l) => l.kind !== 'record');
  const app = appLink(ref, did, handle);
  const keepApp = app && !(derived && app.label.endsWith(' profile'));
  return [...fromRecord, ...(keepApp ? [app] : []), { label: 'Record', url: `https://pdsls.dev/${ref.uri}`, kind: 'raw' }];
}

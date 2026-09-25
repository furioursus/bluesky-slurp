import type { MediaItem, MediaKind } from './media.ts';

export const PER_PAGE_STEPS = [15, 30, 60, 120, 240, 480];
export const DEFAULT_PER_PAGE = 60;
export const PER_PAGE_COOKIE = 'slurp-media-per';
export const MEDIA_KINDS: (MediaKind | 'all')[] = ['all', 'image', 'video', 'other'];
export const KIND_LABEL: Record<MediaKind | 'all', string> = { all: 'All', image: 'Images', video: 'Video', other: 'Other' };

export interface MediaQuery {
  type: MediaKind | 'all';
  source: string | null;
  order: 'newest' | 'oldest';
  per: number;
  offset: number;
}

const validPer = (v: unknown) => (PER_PAGE_STEPS.includes(Number(v)) ? Number(v) : null);

export const pageStart = (offset: number, per: number) => Math.floor(offset / per) * per;

export function readMediaQuery(url: URL, savedPer?: string): MediaQuery {
  const type = url.searchParams.get('type');
  const per = validPer(url.searchParams.get('per')) ?? validPer(savedPer) ?? DEFAULT_PER_PAGE;
  return {
    type: MEDIA_KINDS.includes(type as MediaQuery['type']) ? (type as MediaQuery['type']) : 'all',
    source: url.searchParams.get('source') || null,
    order: url.searchParams.get('order') === 'oldest' ? 'oldest' : 'newest',
    per,
    offset: pageStart(Math.max(0, Number(url.searchParams.get('offset')) || 0), per),
  };
}

export const perFromUrl = (url: URL) => validPer(url.searchParams.get('per'));

export function mediaSearch(q: MediaQuery, change: Partial<MediaQuery> = {}): string {
  const next = { ...q, ...change };
  const params = new URLSearchParams();
  if (next.type !== 'all') params.set('type', next.type);
  if (next.source) params.set('source', next.source);
  if (next.order !== 'newest') params.set('order', next.order);
  params.set('per', String(next.per));
  if (next.offset) params.set('offset', String(next.offset));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const onDisk = (items: MediaItem[], files: Set<string>) => items.filter((i) => files.has(i.file));

export function filterMedia(items: MediaItem[], q: MediaQuery, ignore: 'type' | null = null): MediaItem[] {
  const shown = items.filter(
    (i) => (ignore === 'type' || q.type === 'all' || i.kind === q.type) && (!q.source || i.uses.some((u) => u.collection === q.source)),
  );
  return q.order === 'oldest' ? shown.reverse() : shown;
}

export const sourceLabel = (collection: string) => {
  const [a, b, ...rest] = collection.split('.');
  return `${rest.join('.')} · ${b}.${a}`;
};

export const isSensitive = (item: MediaItem, sensitive: Set<string>) => item.uses.some((u) => u.labels.some((l) => sensitive.has(l)));

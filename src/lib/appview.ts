const APPVIEW = 'https://public.api.bsky.app/xrpc';
const BATCH = 25;
const TIMEOUT = 5_000;
const TTL = 10 * 60_000;

export type PostView = any;

// see docs/web-ui.md#embeds
export type Lookup<T> = Map<string, T | null | undefined>;

const posts = new Map<string, { at: number; value: PostView | null }>();
const handles = new Map<string, { at: number; value: string | null }>();

async function batched<T>(
  keys: string[],
  cache: Map<string, { at: number; value: T | null }>,
  url: (batch: string[]) => string,
  pick: (body: any) => [string, T][],
): Promise<Lookup<T>> {
  const now = Date.now();
  const out: Lookup<T> = new Map();
  const todo: string[] = [];
  for (const key of new Set(keys)) {
    const hit = cache.get(key);
    if (hit && now - hit.at < TTL) out.set(key, hit.value);
    else todo.push(key);
  }
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await fetch(url(batch), { signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok) throw new Error(String(res.status));
        const found = new Map(pick(await res.json()));
        for (const key of batch) {
          const value = found.get(key) ?? null;
          cache.set(key, { at: now, value });
          out.set(key, value);
        }
      } catch {
        for (const key of batch) out.set(key, undefined);
      }
    }),
  );
  return out;
}

export const getPosts = (uris: string[]) =>
  batched<PostView>(
    uris,
    posts,
    (b) => `${APPVIEW}/app.bsky.feed.getPosts?${b.map((u) => `uris=${encodeURIComponent(u)}`).join('&')}`,
    (body) => (body.posts ?? []).map((p: PostView) => [p.uri, p]),
  );

export const getHandles = (dids: string[]) =>
  batched<string>(
    dids.filter((d) => d.startsWith('did:')),
    handles,
    (b) => `${APPVIEW}/app.bsky.actor.getProfiles?${b.map((d) => `actors=${encodeURIComponent(d)}`).join('&')}`,
    (body) => (body.profiles ?? []).map((p: any) => [p.did, p.handle]),
  );

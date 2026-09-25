const UA = 'bluesky-profile-slurper/0.1 (+archival)';

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(url: string, status: number, body: string) {
    super(`${status} from ${url}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function get(url: string, retries = 5): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA } });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new HttpError(url, res.status, await res.text().catch(() => ''));
    }
    const reset = Number(res.headers.get('ratelimit-reset'));
    const wait = reset ? Math.max(1000, reset * 1000 - Date.now()) : 1000 * 2 ** attempt;
    await res.body?.cancel();
    await sleep(Math.min(wait, 5 * 60_000));
  }
}

export async function getJson<T = any>(url: string): Promise<T> {
  return (await get(url)).json() as Promise<T>;
}

export function xrpc(host: string, method: string, params: Record<string, string>): string {
  const u = new URL(`/xrpc/${method}`, host);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

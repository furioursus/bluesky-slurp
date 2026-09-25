#!/usr/bin/env node
/**
 * Local web UI: serves web/ and a small JSON + SSE API over the same engine the CLI uses.
 * Binds to 127.0.0.1 only: it writes to disk and can spend Claude credits.
 */
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { archiveAccount } from './archive.ts';
import { DEFAULT_MODEL, runAnalyze } from './analyze.ts';
import type { ToneEstimate } from './tone.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4747' },
    out: { type: 'string', default: 'archives' },
  },
});
const ROOT = resolve(values.out!);
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const SAFE = /^[A-Za-z0-9._:-]+$/;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
};

// ---- jobs -------------------------------------------------------------

type JobEvent = { type: 'log' | 'estimate' | 'done' | 'error'; data: unknown };

interface Job {
  id: string;
  events: JobEvent[];
  listeners: Set<ServerResponse>;
  finished: boolean;
  /** set while a tone estimate is waiting for the user's answer */
  answer?: (yes: boolean) => void;
}

const jobs = new Map<string, Job>();

function emit(job: Job, type: JobEvent['type'], data: unknown) {
  const ev = { type, data };
  job.events.push(ev);
  for (const res of job.listeners) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (type === 'done' || type === 'error') {
    job.finished = true;
    for (const res of job.listeners) res.end();
    job.listeners.clear();
  }
}

interface JobRequest {
  mode: 'archive' | 'analyze';
  /** handle/DID for archive; handle (account dir) for analyze */
  input: string;
  snapshot?: string;
  media?: boolean;
  analyze?: boolean;
  tone?: boolean;
  model?: string;
  toneLimit?: number;
}

function startJob(req: JobRequest): Job {
  const job: Job = { id: crypto.randomUUID(), events: [], listeners: new Set(), finished: false };
  jobs.set(job.id, job);
  const log = (line: string) => emit(job, 'log', line);
  const tone = req.tone
    ? {
        model: req.model || DEFAULT_MODEL,
        limit: Math.max(1, Math.min(2000, Number(req.toneLimit) || 200)),
        yes: false,
        confirm: (estimate: ToneEstimate) =>
          new Promise<boolean>((done) => {
            job.answer = (yes) => {
              job.answer = undefined;
              done(yes);
            };
            emit(job, 'estimate', estimate);
          }),
      }
    : undefined;

  (async () => {
    let snapDir: string;
    if (req.mode === 'archive') {
      ({ snapDir } = await archiveAccount(req.input, { media: !!req.media, out: ROOT }, log));
      if (req.analyze || req.tone) {
        log('analyzing…');
        await runAnalyze(snapDir, ROOT, tone, log);
      }
    } else {
      const target = req.snapshot ? snapshotDir(req.input, req.snapshot) : req.input.replace(/^@/, '');
      if (!target) throw new Error('bad snapshot');
      log('analyzing…');
      snapDir = await runAnalyze(target, ROOT, tone, log);
    }
    const parts = snapDir.split(sep);
    emit(job, 'done', { handle: parts.at(-3), snapshot: parts.at(-1) });
  })().catch((err) => emit(job, 'error', String(err?.message ?? err)));

  // drop finished jobs after an hour
  setTimeout(() => jobs.delete(job.id), 60 * 60_000).unref();
  return job;
}

// ---- archive reading ----------------------------------------------------

function snapshotDir(handle: string, snapshot: string): string | null {
  if (!SAFE.test(handle) || !SAFE.test(snapshot)) return null;
  const dir = join(ROOT, handle, 'snapshots', snapshot);
  return dir.startsWith(ROOT + sep) ? dir : null;
}

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function listAccounts() {
  if (!existsSync(ROOT)) return [];
  const accounts = [];
  for (const handle of (await readdir(ROOT)).sort()) {
    const snapsDir = join(ROOT, handle, 'snapshots');
    if (!SAFE.test(handle) || !existsSync(snapsDir)) continue;
    const snapshots = [];
    for (const snap of (await readdir(snapsDir)).sort().reverse()) {
      const dir = join(snapsDir, snap);
      const m = await readJson(join(dir, 'manifest.json'));
      if (!m) continue;
      snapshots.push({
        snapshot: snap,
        fetchedAt: m.fetchedAt,
        totalRecords: m.totalRecords,
        collections: Object.keys(m.counts).length,
        media: m.media?.enabled ?? false,
        analysis: existsSync(join(dir, 'analysis.json')),
        tone: existsSync(join(dir, 'tone.json')),
      });
    }
    if (!snapshots.length) continue;
    const latest = await readJson(join(snapsDir, snapshots[0].snapshot, 'manifest.json'));
    const profile = await readJson(join(snapsDir, snapshots[0].snapshot, 'bsky-profile.json'));
    accounts.push({
      handle,
      did: latest.did,
      displayName: profile?.displayName ?? null,
      avatar: profile?.avatar ?? null,
      snapshots,
    });
  }
  return accounts;
}

async function readRecords(dir: string, collection: string, offset: number, limit: number, order: 'newest' | 'oldest') {
  if (!SAFE.test(collection)) return null;
  const file = join(dir, 'records', `${collection}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  if (order === 'newest') lines.reverse(); // files are rkey order, which is chronological for TIDs
  return { total: lines.length, records: lines.slice(offset, offset + limit).map((l) => JSON.parse(l)) };
}

// ---- http -------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function serveFile(res: ServerResponse, path: string) {
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error();
    // no-cache = revalidate every load, so UI edits show up on a plain reload
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-length': s.size, 'cache-control': 'no-cache' });
    createReadStream(path).pipe(res);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  // same-origin only: reject cross-site form posts / fetches aimed at this local server
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'cross-origin' });

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  try {
    // GET /api/accounts
    if (req.method === 'GET' && url.pathname === '/api/accounts') return send(res, 200, await listAccounts());

    // GET /api/config
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { defaultModel: DEFAULT_MODEL, hasApiKey: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) });
    }

    // GET /api/snapshot/:handle/:snapshot[/analysis|/tone|/identity|/records/:collection]
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'snapshot') {
      const dir = snapshotDir(parts[2] ?? '', parts[3] ?? '');
      if (!dir || !existsSync(dir)) return send(res, 404, { error: 'no such snapshot' });
      const what = parts[4];
      if (!what) {
        return send(res, 200, {
          manifest: await readJson(join(dir, 'manifest.json')),
          profile: await readJson(join(dir, 'bsky-profile.json')),
          analysis: await readJson(join(dir, 'analysis.json')),
        });
      }
      if (what === 'identity') {
        return send(res, 200, {
          didDocument: await readJson(join(dir, 'identity', 'did-document.json')),
          plcAuditLog: await readJson(join(dir, 'identity', 'plc-audit-log.json')),
        });
      }
      if (what === 'records' && parts[5]) {
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const order = url.searchParams.get('order') === 'oldest' ? 'oldest' : 'newest';
        const page = await readRecords(dir, parts[5], offset, limit, order);
        return page ? send(res, 200, page) : send(res, 404, { error: 'no such collection' });
      }
      return send(res, 404, { error: 'not found' });
    }

    // GET /blobs/:handle/:file
    if (req.method === 'GET' && parts[0] === 'blobs' && parts.length === 3) {
      if (!SAFE.test(parts[1]) || !SAFE.test(parts[2])) return send(res, 400, { error: 'bad path' });
      return serveFile(res, join(ROOT, parts[1], 'blobs', parts[2]));
    }

    // POST /api/jobs
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const b = await body(req);
      if (!['archive', 'analyze'].includes(b.mode) || typeof b.input !== 'string' || !b.input.trim()) {
        return send(res, 400, { error: 'need mode (archive|analyze) and input' });
      }
      return send(res, 202, { id: startJob({ ...b, input: b.input.trim() }).id });
    }

    // GET /api/jobs/:id/events  (SSE; replays history, then streams)
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'events') {
      const job = jobs.get(parts[2]);
      if (!job) return send(res, 404, { error: 'no such job' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (job.finished) return res.end();
      job.listeners.add(res);
      req.on('close', () => job.listeners.delete(res));
      return;
    }

    // POST /api/jobs/:id/confirm  { yes: boolean }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'confirm') {
      const job = jobs.get(parts[2]);
      if (!job?.answer) return send(res, 409, { error: 'nothing waiting for confirmation' });
      job.answer(!!(await body(req)).yes);
      return send(res, 200, { ok: true });
    }

    // static
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const path = resolve(WEB, rel);
      if (!path.startsWith(WEB)) return send(res, 400, { error: 'bad path' });
      return serveFile(res, existsSync(path) ? path : join(WEB, 'index.html'));
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: String((err as Error).message ?? err) });
  }
});

server.listen(Number(values.port), '127.0.0.1', () => {
  process.stderr.write(`slurp UI → http://127.0.0.1:${values.port}  (archives: ${ROOT})\n`);
});

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { archiveAccount } from './archive.ts';
import { runAnalyze } from './analyze.ts';
import { ARCHIVE_ROOT, archiveDir, listAccounts } from './archives.ts';
import { downloadArchiveMedia } from './media.ts';

export type JobEvent = { type: 'log' | 'done' | 'error'; data: unknown };
type Listener = (event: JobEvent, index: number) => void;

export type JobMode = 'archive' | 'analyze' | 'media' | 'update-all';

export interface JobRequest {
  mode: JobMode;
  input: string;
  media?: boolean;
  analyze?: boolean;
}

export interface Job {
  id: string;
  mode: JobMode;
  input: string;
  events: JobEvent[];
  listeners: Set<Listener>;
  finished: boolean;
}

const JOB_TTL = 60 * 60_000;
const WRITERS = new Set<JobMode>(['archive', 'media', 'update-all']);
const jobs = new Map<string, Job>();

export const getJob = (id: string) => jobs.get(id);
export const activeJob = (mode: JobMode) => [...jobs.values()].find((j) => j.mode === mode && !j.finished) ?? null;

// see docs/web-ui.md#jobs
export const runningWriter = () => [...jobs.values()].find((j) => WRITERS.has(j.mode) && !j.finished) ?? null;
export const isWriter = (mode: JobMode) => WRITERS.has(mode);

function emit(job: Job, type: JobEvent['type'], data: unknown) {
  const event = { type, data };
  job.events.push(event);
  if (type === 'done' || type === 'error') job.finished = true;
  for (const listener of job.listeners) listener(event, job.events.length - 1);
}

async function updateOne(input: string, opts: { media?: boolean; analyze?: boolean }, log: (line: string) => void) {
  const { dir } = await archiveAccount(input, { media: opts.media, out: ARCHIVE_ROOT }, log);
  if (opts.analyze || existsSync(join(dir, 'analysis.json'))) {
    log('analyzing…');
    await runAnalyze(dir, ARCHIVE_ROOT);
  }
  return dir;
}

async function updateAll(withMedia: boolean, log: (line: string) => void) {
  const accounts = await listAccounts();
  let failed = 0;
  for (const [i, a] of accounts.entries()) {
    log(`— @${a.handle} (${i + 1}/${accounts.length})`);
    try {
      await updateOne(a.did, { media: withMedia ? undefined : false }, log);
    } catch (err) {
      failed++;
      log(`⚠ @${a.handle}: ${(err as Error)?.message ?? err}`);
    }
  }
  log(failed ? `⚠ ${failed} of ${accounts.length} accounts failed to update` : `✓ ${accounts.length} accounts updated`);
  return { count: accounts.length, failed };
}

export function startJob(req: JobRequest): Job {
  const job: Job = { id: crypto.randomUUID(), mode: req.mode, input: req.input, events: [], listeners: new Set(), finished: false };
  jobs.set(job.id, job);
  const log = (line: string) => emit(job, 'log', line);
  (async () => {
    if (req.mode === 'update-all') {
      emit(job, 'done', await updateAll(!!req.media, log));
      return;
    }
    let dir: string;
    if (req.mode === 'archive') {
      dir = await updateOne(req.input, { media: req.media || undefined, analyze: req.analyze }, log);
      log('✓ archive up to date');
    } else if (req.mode === 'media') {
      const target = archiveDir(req.input);
      if (!target) throw new Error('no such archive');
      await downloadArchiveMedia(target, log);
      dir = target;
      log('✓ media downloaded');
    } else {
      log('analyzing…');
      dir = await runAnalyze(archiveDir(req.input) ?? req.input.replace(/^@/, ''), ARCHIVE_ROOT);
      log('✓ report updated');
    }
    emit(job, 'done', { handle: basename(dir) });
  })().catch((err) => emit(job, 'error', String(err?.message ?? err)));

  setTimeout(() => jobs.delete(job.id), JOB_TTL).unref();
  return job;
}

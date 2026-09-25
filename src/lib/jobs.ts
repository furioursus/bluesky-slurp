import { sep } from 'node:path';
import { archiveAccount } from './archive.ts';
import { DEFAULT_MODEL, runAnalyze } from './analyze.ts';
import { ARCHIVE_ROOT, snapshotDir } from './archives.ts';
import type { ToneEstimate } from './tone.ts';

export type JobEvent = { type: 'log' | 'estimate' | 'done' | 'error'; data: unknown };
type Listener = (event: JobEvent, index: number) => void;

export interface Job {
  id: string;
  events: JobEvent[];
  listeners: Set<Listener>;
  finished: boolean;
  answer?: (yes: boolean) => void;
}

export interface JobRequest {
  mode: 'archive' | 'analyze';
  input: string;
  snapshot?: string;
  media?: boolean;
  analyze?: boolean;
  tone?: boolean;
  model?: string;
  toneLimit?: number;
}

const JOB_TTL = 60 * 60_000;
const jobs = new Map<string, Job>();

export const getJob = (id: string) => jobs.get(id);

function emit(job: Job, type: JobEvent['type'], data: unknown) {
  const event = { type, data };
  job.events.push(event);
  if (type === 'done' || type === 'error') job.finished = true;
  for (const listener of job.listeners) listener(event, job.events.length - 1);
}

export function startJob(req: JobRequest): Job {
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
      ({ snapDir } = await archiveAccount(req.input, { media: !!req.media, out: ARCHIVE_ROOT }, log));
      if (req.analyze || req.tone) {
        log('analyzing…');
        await runAnalyze(snapDir, ARCHIVE_ROOT, tone, log);
      }
    } else {
      const target = req.snapshot ? snapshotDir(req.input, req.snapshot) : req.input.replace(/^@/, '');
      if (!target) throw new Error('no such snapshot');
      log('analyzing…');
      snapDir = await runAnalyze(target, ARCHIVE_ROOT, tone, log);
    }
    log(req.mode === 'archive' && !req.analyze && !req.tone ? '✓ archived' : '✓ report updated');
    const parts = snapDir.split(sep);
    emit(job, 'done', { handle: parts.at(-3), snapshot: parts.at(-1) });
  })().catch((err) => emit(job, 'error', String(err?.message ?? err)));

  setTimeout(() => jobs.delete(job.id), JOB_TTL).unref();
  return job;
}

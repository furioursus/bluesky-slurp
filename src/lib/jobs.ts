import { sep } from 'node:path';
import { archiveAccount } from './archive.ts';
import { runAnalyze } from './analyze.ts';
import { ARCHIVE_ROOT, snapshotDir } from './archives.ts';
import { downloadSnapshotMedia } from './media.ts';

export type JobEvent = { type: 'log' | 'done' | 'error'; data: unknown };
type Listener = (event: JobEvent, index: number) => void;

export interface Job {
  id: string;
  events: JobEvent[];
  listeners: Set<Listener>;
  finished: boolean;
}

export interface JobRequest {
  mode: 'archive' | 'analyze' | 'media';
  input: string;
  snapshot?: string;
  media?: boolean;
  analyze?: boolean;
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
  (async () => {
    let snapDir: string;
    if (req.mode === 'archive') {
      ({ snapDir } = await archiveAccount(req.input, { media: !!req.media, out: ARCHIVE_ROOT }, log));
      if (req.analyze) {
        log('analyzing…');
        await runAnalyze(snapDir, ARCHIVE_ROOT);
      }
    } else if (req.mode === 'media') {
      const target = req.snapshot ? snapshotDir(req.input, req.snapshot) : null;
      if (!target) throw new Error('no such snapshot');
      await downloadSnapshotMedia(target, log);
      snapDir = target;
    } else {
      const target = req.snapshot ? snapshotDir(req.input, req.snapshot) : req.input.replace(/^@/, '');
      if (!target) throw new Error('no such snapshot');
      log('analyzing…');
      snapDir = await runAnalyze(target, ARCHIVE_ROOT);
    }
    log(req.mode === 'media' ? '✓ media downloaded' : req.mode === 'archive' && !req.analyze ? '✓ archived' : '✓ report updated');
    const parts = snapDir.split(sep);
    emit(job, 'done', { handle: parts.at(-3), snapshot: parts.at(-1) });
  })().catch((err) => emit(job, 'error', String(err?.message ?? err)));

  setTimeout(() => jobs.delete(job.id), JOB_TTL).unref();
  return job;
}

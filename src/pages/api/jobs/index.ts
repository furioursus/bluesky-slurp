import type { APIRoute } from 'astro';
import { isWriter, runningWriter, startJob, type JobMode } from '../../../lib/jobs.ts';

const MODES: JobMode[] = ['archive', 'analyze', 'media', 'update-all'];

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const input = typeof body?.input === 'string' ? body.input.trim() : '';
  if (!body || !MODES.includes(body.mode) || (!input && body.mode !== 'update-all')) {
    return Response.json({ error: `need mode (${MODES.join('|')}) and input` }, { status: 400 });
  }
  // see docs/web-ui.md#jobs
  const busy = isWriter(body.mode) ? runningWriter() : null;
  if (busy) return Response.json({ error: `already running: ${busy.mode === 'update-all' ? 'updating every account' : `${busy.mode} ${busy.input}`}`, id: busy.id }, { status: 409 });
  return Response.json({ id: startJob({ mode: body.mode, input, media: !!body.media, analyze: !!body.analyze }).id }, { status: 202 });
};

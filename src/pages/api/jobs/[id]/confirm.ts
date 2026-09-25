import type { APIRoute } from 'astro';
import { getJob } from '../../../../lib/jobs.ts';

export const POST: APIRoute = async ({ params, request }) => {
  const job = getJob(params.id ?? '');
  if (!job?.answer) return Response.json({ error: 'nothing waiting for confirmation' }, { status: 409 });
  const body = await request.json().catch(() => ({}));
  job.answer(!!body.yes);
  return Response.json({ ok: true });
};

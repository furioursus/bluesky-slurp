import type { APIRoute } from 'astro';
import { startJob } from '../../../lib/jobs.ts';

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body || !['archive', 'analyze', 'media'].includes(body.mode) || typeof body.input !== 'string' || !body.input.trim()) {
    return Response.json({ error: 'need mode (archive|analyze|media) and input' }, { status: 400 });
  }
  return Response.json({ id: startJob({ ...body, input: body.input.trim() }).id }, { status: 202 });
};

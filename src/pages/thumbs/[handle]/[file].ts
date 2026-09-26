import type { APIRoute } from 'astro';
import { accountPath, fileResponse } from '../../../lib/serve.ts';
import { canThumb, ensureThumb, isVideo } from '../../../lib/thumbs.ts';

export const GET: APIRoute = async ({ params, redirect }) => {
  const { handle = '', file = '' } = params;
  const src = accountPath(handle, 'blobs', file);
  const out = accountPath(handle, 'thumbs', `${file}.webp`);
  if (!src || !out) return new Response('bad path', { status: 400 });
  if (!canThumb(file)) return redirect(`/blobs/${handle}/${file}`, 302);
  try {
    await ensureThumb(src, out);
  } catch {
    return isVideo(file) ? new Response('no poster', { status: 404 }) : redirect(`/blobs/${handle}/${file}`, 302);
  }
  return fileResponse(out);
};

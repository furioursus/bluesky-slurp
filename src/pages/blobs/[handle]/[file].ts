import type { APIRoute } from 'astro';
import { accountPath, fileResponse } from '../../../lib/serve.ts';

export const GET: APIRoute = async ({ params, url }) => {
  const { handle = '', file = '' } = params;
  const path = accountPath(handle, 'blobs', file);
  if (!path) return new Response('bad path', { status: 400 });
  return fileResponse(path, url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${file}"` } : {});
};

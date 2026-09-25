import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { APIRoute } from 'astro';
import { ARCHIVE_ROOT, SAFE_NAME } from '../../../lib/archives.ts';

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
};

export const GET: APIRoute = async ({ params, url }) => {
  const { handle = '', file = '' } = params;
  if (!SAFE_NAME.test(handle) || !SAFE_NAME.test(file)) return new Response('bad path', { status: 400 });
  const path = join(ARCHIVE_ROOT, handle, 'blobs', file);
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error();
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-length': String(s.size),
        ...(url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${file}"` } : {}),
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
};

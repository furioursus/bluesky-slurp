import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { ARCHIVE_ROOT, SAFE_NAME } from './archives.ts';

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

// see docs/web-ui.md#thumbnails
const IMMUTABLE = 'private, max-age=31536000, immutable';

export function accountPath(handle: string, dir: 'blobs' | 'thumbs', file: string): string | null {
  if (!SAFE_NAME.test(handle) || !SAFE_NAME.test(file)) return null;
  const path = resolve(ARCHIVE_ROOT, handle, dir, file);
  return path.startsWith(join(ARCHIVE_ROOT, handle, dir) + sep) ? path : null;
}

export async function fileResponse(path: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error();
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'content-length': String(s.size),
        'cache-control': IMMUTABLE,
        ...headers,
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

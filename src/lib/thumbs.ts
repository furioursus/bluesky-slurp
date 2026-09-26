import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import sharp from 'sharp';

// see docs/web-ui.md#thumbnails
const THUMB_EDGE = 640;
const STILLS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const VIDEOS = new Set(['.mp4', '.mov', '.webm']);
const FRAME_AT = '0.1';
const FRAME_BUFFER = 64 * 1024 * 1024;
const inFlight = new Map<string, Promise<void>>();

export const isVideo = (file: string) => VIDEOS.has(extname(file));
export const canThumb = (file: string) => STILLS.has(extname(file)) || isVideo(file);

const firstFrame = (src: string) =>
  new Promise<Buffer>((ok, fail) =>
    execFile(
      'ffmpeg',
      ['-v', 'error', '-i', src, '-ss', FRAME_AT, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
      { encoding: 'buffer', maxBuffer: FRAME_BUFFER },
      (err, out) => (err || !out.length ? fail(err ?? new Error('no frame')) : ok(out)),
    ),
  );

async function render(src: string, out: string) {
  await mkdir(dirname(out), { recursive: true });
  const webp = await sharp(isVideo(src) ? await firstFrame(src) : src)
    .rotate()
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'outside', withoutEnlargement: true })
    .webp()
    .toBuffer();
  const tmp = `${out}.${process.pid}.tmp`;
  await writeFile(tmp, webp);
  await rename(tmp, out);
}

export async function ensureThumb(src: string, out: string): Promise<void> {
  if (existsSync(out)) return;
  let job = inFlight.get(out);
  if (!job) {
    job = render(src, out).finally(() => inFlight.delete(out));
    inFlight.set(out, job);
  }
  await job;
}

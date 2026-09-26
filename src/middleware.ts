import { timingSafeEqual } from 'node:crypto';
import { defineMiddleware } from 'astro:middleware';

const TOKEN = process.env.SLURP_TOKEN;
const TOKEN_COOKIE = 'slurp-token';

const matches = (given: string | undefined) =>
  !!given && !!TOKEN && given.length === TOKEN.length && timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));

// see docs/web-ui.md#security
export const onRequest = defineMiddleware((ctx, next) => {
  if (ctx.isPrerendered) return next();
  if (TOKEN && !matches(ctx.cookies.get(TOKEN_COOKIE)?.value)) return new Response('forbidden', { status: 403 });
  const { method, headers } = ctx.request;
  const origin = headers.get('origin');
  if (method !== 'GET' && method !== 'HEAD' && origin && new URL(origin).host !== ctx.url.host) {
    return Response.json({ error: 'cross-origin' }, { status: 403 });
  }
  return next();
});

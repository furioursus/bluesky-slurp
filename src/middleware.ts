import { defineMiddleware } from 'astro:middleware';

// see docs/web-ui.md#security
export const onRequest = defineMiddleware((ctx, next) => {
  if (ctx.isPrerendered) return next();
  const { method, headers } = ctx.request;
  const origin = headers.get('origin');
  if (method !== 'GET' && method !== 'HEAD' && origin && new URL(origin).host !== ctx.url.host) {
    return Response.json({ error: 'cross-origin' }, { status: 403 });
  }
  return next();
});

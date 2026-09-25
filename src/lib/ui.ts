import type { Ref } from './refs.ts';

export const SENSITIVE = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore']);
export const WINDOW_TABS: Record<string, string> = { '30d': '30 days', '90d': '3 months', '180d': '6 months', '365d': '1 year', all: 'All time' };
export const EMBED_KICKER: Record<string, string> = { 'reply-root': 'Thread root', 'reply-parent': 'Replying to', liked: 'Liked post', reposted: 'Reposted post' };
export const EMBED_ROLES = new Set(['liked', 'reposted']);
export const ROOTS_COOKIE = 'slurp-roots';

export const safeHref = (href: string) => (/^(https?:\/\/|\/|#)/.test(href) ? href : '#');
export const didOf = (target: string) => (target.startsWith('at://') ? target.slice(5).split('/')[0] : target);
export const bskyPostUrl = (uri: string) => {
  const [repo, , rkey] = uri.slice(5).split('/');
  return `https://bsky.app/profile/${repo}/post/${rkey}`;
};

export function embedTargets(pointers: Ref[], showRoots: boolean) {
  const isPost = (x: Ref) => x.kind === 'record' && x.target.includes('/app.bsky.feed.post/');
  const parent = pointers.find((x) => x.role === 'reply-parent');
  return pointers
    .filter((x) => isPost(x) && (EMBED_ROLES.has(x.role) || x.role === 'reply-parent' || (x.role === 'reply-root' && showRoots && x.target !== parent?.target)))
    .sort((a, b) => (a.role === 'reply-root' ? -1 : b.role === 'reply-root' ? 1 : 0));
}

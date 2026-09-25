/**
 * Offline behavior + interest analysis over a snapshot.
 *
 * Deliberately reports signals with evidence links, never a verdict: structural
 * patterns (who they reply to, how often cold, how fixated) are strong tells, but
 * any single number misreads someone. The reader makes the call.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getJson, xrpc } from './http.ts';
import { webUrlForDid } from './refs.ts';
import { DEFAULT_MODEL, LABELS, runTone, summarizeTone, type ToneCandidate, type ToneOptions } from './tone.ts';

const DAY = 86_400_000;
const RECENT_DAYS = 90;
const EXAMPLES = 5;

interface Line {
  uri: string;
  web: string;
  collection: string;
  createdAt: string | null;
  refs: { role: string; kind: string; target: string; web: string }[];
  record: any;
}

type Kind = 'original' | 'thread' | 'reply' | 'quote';

interface Post {
  line: Line;
  at: number;
  kind: Kind;
  /** DID of the account being replied to / quoted, when it isn't self */
  target: string | null;
  /** at:// URI of the post being replied to / quoted */
  targetUri?: string;
}

const didOf = (uri: string) => uri.slice(5).split('/')[0];

/** Resolve a snapshot dir from either a path or an account dir (picks the latest snapshot). */
export async function resolveSnapshot(pathOrHandle: string, out: string): Promise<string> {
  const candidates = [pathOrHandle, join(out, pathOrHandle.replace(/^@/, ''))];
  for (const c of candidates) {
    if (existsSync(join(c, 'manifest.json'))) return c;
    const snaps = join(c, 'snapshots');
    if (existsSync(snaps)) {
      const latest = (await readdir(snaps)).sort().at(-1);
      if (latest) return join(snaps, latest);
    }
  }
  throw new Error(`no snapshot found for ${pathOrHandle} (tried ${candidates.join(', ')})`);
}

async function readCollection(snap: string, collection: string): Promise<Line[]> {
  const file = join(snap, 'records', `${collection}.jsonl`);
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const ts = (l: Line) => (l.createdAt ? Date.parse(l.createdAt) : NaN);

function classify(line: Line, self: string): Post {
  const r = line.record;
  const at = ts(line);
  if (r.reply?.parent?.uri) {
    const parent = didOf(r.reply.parent.uri);
    return parent === self
      ? { line, at, kind: 'thread', target: null }
      : { line, at, kind: 'reply', target: parent, targetUri: r.reply.parent.uri };
  }
  const quoted: string | undefined = r.embed?.record?.record?.uri ?? r.embed?.record?.uri;
  if (quoted?.startsWith('at://') && quoted.includes('/app.bsky.feed.post/')) {
    const who = didOf(quoted);
    return { line, at, kind: 'quote', target: who === self ? null : who, targetUri: quoted };
  }
  return { line, at, kind: 'original', target: null };
}

function countBy<T>(items: T[], key: (t: T) => string | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

async function resolveHandles(dids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < dids.length; i += 25) {
    const batch = dids.slice(i, i + 25);
    const url = new URL(xrpc('https://public.api.bsky.app', 'app.bsky.actor.getProfiles', {}));
    for (const d of batch) url.searchParams.append('actors', d);
    try {
      const { profiles } = await getJson(url.toString());
      for (const p of profiles) out.set(p.did, p.handle);
    } catch {}
  }
  return out;
}

export async function analyze(snap: string) {
  const { report } = await analyzeWithCandidates(snap);
  return report;
}

async function analyzeWithCandidates(snap: string) {
  const manifest = JSON.parse(await readFile(join(snap, 'manifest.json'), 'utf8'));
  const self: string = manifest.did;
  const now = Date.parse(manifest.fetchedAt);

  const [postLines, likes, reposts, follows, blocks] = await Promise.all(
    ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.feed.repost', 'app.bsky.graph.follow', 'app.bsky.graph.block'].map(
      (c) => readCollection(snap, c),
    ),
  );
  const posts = postLines.map((l) => classify(l, self));
  const followed = new Set(follows.map((f) => f.record.subject as string));
  const likedAuthors = countBy(likes, (l) => l.record.subject?.uri && didOf(l.record.subject.uri));

  // --- engagement shape -------------------------------------------------
  const mix = (ps: Post[]) => {
    const c = countBy(ps, (p) => p.kind);
    const quotes = ps.filter((p) => p.kind === 'quote' && p.target).length;
    const outward = ps.filter((p) => p.target);
    const cold = outward.filter((p) => !followed.has(p.target!));
    // "cold" = aimed at someone they don't follow and have never liked a post from
    const veryCold = cold.filter((p) => !likedAuthors.has(p.target!));
    return {
      posts: ps.length,
      original: c.get('original') ?? 0,
      selfThreads: c.get('thread') ?? 0,
      repliesToOthers: c.get('reply') ?? 0,
      quotesOfOthers: quotes,
      pctRepliesToOthers: pct(c.get('reply') ?? 0, ps.length),
      pctQuotes: pct(quotes, ps.length),
      pctOutwardToNonFollowed: pct(cold.length, outward.length),
      pctOutwardToStrangers: pct(veryCold.length, outward.length),
    };
  };
  const recent = posts.filter((p) => now - p.at < RECENT_DAYS * DAY);

  // --- targeting --------------------------------------------------------
  const outward = posts.filter((p) => p.target);
  const replyTargets = countBy(
    outward.filter((p) => p.kind === 'reply'),
    (p) => p.target,
  );
  const quoteTargets = countBy(
    outward.filter((p) => p.kind === 'quote'),
    (p) => p.target,
  );
  const strangerQuotes = outward.filter((p) => p.kind === 'quote' && !followed.has(p.target!) && !likedAuthors.has(p.target!));

  // fixation: bursts of 5+ replies to the same non-followed account within 24h
  const bursts: { did: string; count: number; day: string; examples: string[] }[] = [];
  const byTarget = new Map<string, Post[]>();
  for (const p of outward) {
    if (p.kind !== 'reply' || followed.has(p.target!)) continue;
    const list = byTarget.get(p.target!) ?? [];
    list.push(p);
    byTarget.set(p.target!, list);
  }
  for (const [did, ps] of byTarget) {
    ps.sort((a, b) => a.at - b.at);
    let best: Post[] = [];
    for (let i = 0, j = 0; j < ps.length; j++) {
      while (ps[j].at - ps[i].at > DAY) i++;
      if (j - i + 1 > best.length) best = ps.slice(i, j + 1);
    }
    if (best.length >= 5) {
      bursts.push({ did, count: best.length, day: new Date(best[0].at).toISOString().slice(0, 10), examples: best.slice(0, EXAMPLES).map((p) => p.line.web) });
    }
  }
  bursts.sort((a, b) => b.count - a.count);

  // --- rhythm -----------------------------------------------------------
  const hours = Array(24).fill(0);
  for (const p of posts) if (!Number.isNaN(p.at)) hours[new Date(p.at).getUTCHours()]++;
  const perDay = countBy(posts, (p) => (Number.isNaN(p.at) ? null : new Date(p.at).toISOString().slice(0, 10)));
  const activeDays = perDay.size;

  // --- interests --------------------------------------------------------
  const tags = new Map<string, number>();
  const domains = new Map<string, number>();
  for (const p of posts) {
    for (const f of p.line.record.facets ?? []) {
      for (const feat of f.features ?? []) {
        if (feat.tag) tags.set(feat.tag.toLowerCase(), (tags.get(feat.tag.toLowerCase()) ?? 0) + 1);
      }
    }
    for (const r of p.line.refs) {
      if (r.kind !== 'link') continue;
      try {
        const host = new URL(r.target).hostname.replace(/^www\./, '');
        domains.set(host, (domains.get(host) ?? 0) + 1);
      } catch {}
    }
  }
  const langs = countBy(posts.flatMap((p) => p.line.record.langs ?? []), (l) => l);
  const repostedAuthors = countBy(reposts, (l) => l.record.subject?.uri && didOf(l.record.subject.uri));
  const apps = new Map<string, number>();
  for (const [col, n] of Object.entries(manifest.counts as Record<string, number>)) {
    const ns = col.split('.').slice(0, 2).reverse().join('.');
    apps.set(ns, (apps.get(ns) ?? 0) + n);
  }

  // --- handles for everyone we name --------------------------------------
  const named = new Set<string>([
    ...top(replyTargets, 15).map(([d]) => d),
    ...top(quoteTargets, 15).map(([d]) => d),
    ...top(likedAuthors, 15).map(([d]) => d),
    ...top(repostedAuthors, 15).map(([d]) => d),
    ...bursts.slice(0, 15).map((b) => b.did),
  ]);
  named.delete(self);
  const handles = await resolveHandles([...named]);
  const who = (did: string) => ({ did, handle: handles.get(did) ?? null, web: webUrlForDid(did), followed: followed.has(did) });
  const ranked = (m: Map<string, number>, n = 15) => top(m, n).filter(([d]) => d !== self).map(([d, count]) => ({ ...who(d), count }));

  const toneCandidates: ToneCandidate[] = outward
    .filter((p) => p.targetUri && typeof p.line.record.text === 'string' && p.line.record.text.trim())
    .map((p) => ({
      uri: p.line.uri,
      web: p.line.web,
      kind: p.kind as 'reply' | 'quote',
      text: p.line.record.text,
      targetUri: p.targetUri!,
      cold: !followed.has(p.target!) && !likedAuthors.has(p.target!),
      followed: followed.has(p.target!),
      at: p.at,
    }));

  const firstAt = Math.min(...posts.map((p) => p.at).filter((n) => !Number.isNaN(n)));

  const report = {
    account: { did: self, handle: manifest.handle, snapshot: manifest.fetchedAt, labels: manifest.selfLabels, firstPost: Number.isFinite(firstAt) ? new Date(firstAt).toISOString() : null },
    shape: {
      allTime: mix(posts),
      [`last${RECENT_DAYS}Days`]: mix(recent),
      likes: likes.length,
      reposts: reposts.length,
      follows: follows.length,
      blocks: blocks.length,
      likesPerPost: posts.length ? Math.round((likes.length / posts.length) * 10) / 10 : null,
      activeDays,
      postsPerActiveDay: activeDays ? Math.round((posts.length / activeDays) * 10) / 10 : null,
      busiestDays: top(perDay, 5).map(([day, count]) => ({ day, count })),
      postsByHourUTC: hours,
    },
    targeting: {
      mostRepliedTo: ranked(replyTargets),
      mostQuoted: ranked(quoteTargets),
      replyBurstsAtNonFollowed: bursts.slice(0, 15).map((b) => ({ ...who(b.did), count: b.count, day: b.day, examples: b.examples })),
      strangerQuotes: { count: strangerQuotes.length, examples: strangerQuotes.slice(-EXAMPLES).map((p) => p.line.web) },
    },
    interests: {
      hashtags: top(tags, 20).map(([tag, count]) => ({ tag, count })),
      linkDomains: top(domains, 20).map(([domain, count]) => ({ domain, count })),
      mostLiked: ranked(likedAuthors),
      mostReposted: ranked(repostedAuthors),
      languages: top(langs, 5).map(([lang, count]) => ({ lang, count })),
      appsUsed: top(apps, 30).map(([app, records]) => ({ app, records })),
    },
    tone: null as ReturnType<typeof summarizeTone> | null,
  };
  return { report, candidates: toneCandidates };
}

type Report = Awaited<ReturnType<typeof analyze>>;

export function toMarkdown(r: Report): string {
  const s = r.shape;
  const a = s.allTime;
  const recent = (s as any)[`last${RECENT_DAYS}Days`] as typeof a;
  const name = (p: { handle: string | null; did: string; web: string; followed: boolean }) =>
    `[${p.handle ?? p.did}](${p.web})${p.followed ? '' : ' · not followed'}`;
  const list = <T,>(items: T[], fmt: (t: T) => string) => (items.length ? items.map((i) => `- ${fmt(i)}`).join('\n') : '- none');

  return `# Behavior report: ${r.account.handle ?? r.account.did}

**TL;DR:** signals, not a verdict. The strongest bad-faith tells are structural: a high share of replies and quotes aimed at strangers, and bursts of replies at one account. Check the linked posts before you conclude anything.

- Snapshot ${r.account.snapshot.slice(0, 10)} · first post ${r.account.firstPost?.slice(0, 10) ?? 'n/a'} · self-labels: ${r.account.labels.join(', ') || 'none'}

## Shape of engagement

| | all time | last ${RECENT_DAYS} days |
|---|---|---|
| posts | ${a.posts} | ${recent.posts} |
| original posts | ${a.original} | ${recent.original} |
| self-threads | ${a.selfThreads} | ${recent.selfThreads} |
| replies to others | ${a.repliesToOthers} (${a.pctRepliesToOthers}%) | ${recent.repliesToOthers} (${recent.pctRepliesToOthers}%) |
| quotes | ${a.quotesOfOthers} (${a.pctQuotes}%) | ${recent.quotesOfOthers} (${recent.pctQuotes}%) |
| replies+quotes aimed at non-followed | ${a.pctOutwardToNonFollowed}% | ${recent.pctOutwardToNonFollowed}% |
| …and never liked either ("cold") | ${a.pctOutwardToStrangers}% | ${recent.pctOutwardToStrangers}% |

- ${s.likes} likes · ${s.reposts} reposts · ${s.follows} follows · ${s.blocks} blocks · ${s.likesPerPost ?? 'n/a'} likes per post
- ${s.activeDays} active days, ${s.postsPerActiveDay ?? 'n/a'} posts per active day
- Busiest days: ${s.busiestDays.map((d) => `${d.day} (${d.count})`).join(', ') || 'none'}

**Reading it:** people posting in good faith mostly reply to accounts they follow or have engaged with before. A "cold" share that's high and rising, plus many quotes of strangers, is the classic reply-guy and dunk pattern. Lots of blocks usually means defensive block lists, not aggression.

## Targeting

**Most replied to**
${list(r.targeting.mostRepliedTo, (p) => `${name(p)} — ${p.count}`)}

**Most quoted**
${list(r.targeting.mostQuoted, (p) => `${name(p)} — ${p.count}`)}

**Reply bursts at non-followed accounts** (5+ replies within 24h)
${list(r.targeting.replyBurstsAtNonFollowed, (b) => `${name(b)} — ${b.count} on ${b.day}: ${b.examples.map((u, i) => `[${i + 1}](${u})`).join(' ')}`)}

**Quotes of strangers:** ${r.targeting.strangerQuotes.count}${r.targeting.strangerQuotes.examples.length ? ` — latest: ${r.targeting.strangerQuotes.examples.map((u, i) => `[${i + 1}](${u})`).join(' ')}` : ''}

## Interests

- **Hashtags:** ${r.interests.hashtags.map((t) => `#${t.tag} (${t.count})`).join(', ') || 'none'}
- **Links to:** ${r.interests.linkDomains.map((d) => `${d.domain} (${d.count})`).join(', ') || 'none'}
- **Languages:** ${r.interests.languages.map((l) => `${l.lang} (${l.count})`).join(', ') || 'none'}
- **Apps on the atmosphere:** ${r.interests.appsUsed.map((x) => `${x.app} (${x.records})`).join(', ')}

**Most liked**
${list(r.interests.mostLiked, (p) => `${name(p)} — ${p.count}`)}

**Most reposted**
${list(r.interests.mostReposted, (p) => `${name(p)} — ${p.count}`)}
${r.tone ? toneMarkdown(r.tone) : ''}`;
}

function toneMarkdown(t: NonNullable<Report['tone']>): string {
  const row = (l: string) => `| ${l} | ${t.cold.counts[l]} | ${t.warm.counts[l]} |`;
  const examples = LABELS.filter((l) => t.examples[l].length)
    .map((l) => `**${l}**\n${t.examples[l].map((e) => `- [post](${e.web}) (${e.confidence}${e.cold ? ', cold' : ''}): ${e.reason}`).join('\n')}`)
    .join('\n\n');
  return `
## Tone (Claude)

**TL;DR:** ${t.cold.pctBadFaith}% of cold replies/quotes read as argumentative, hostile or trolling, vs ${t.warm.pctBadFaith}% of replies to people they know. A big gap between the two is the tell. A high number in both is just how they talk.

- ${t.labelled} posts labelled by ${t.model}${t.refused ? `, ${t.refused} without a label` : ''}. Every label is a model's reading of one post in context. Open the examples.

| label | cold (${t.cold.total}) | warm (${t.warm.total}) |
|---|---|---|
${LABELS.map(row).join('\n')}

${examples}
`;
}

export async function runAnalyze(target: string, out: string, tone?: ToneOptions, log: (m: string) => void = () => {}) {
  const snap = await resolveSnapshot(target, out);
  const { report, candidates } = await analyzeWithCandidates(snap);
  if (tone) {
    const results = await runTone(snap, candidates, tone, log);
    if (Object.keys(results).length) report.tone = summarizeTone(results);
  }
  await writeFile(join(snap, 'analysis.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(snap, 'analysis.md'), toMarkdown(report));
  return snap;
}

export { DEFAULT_MODEL };

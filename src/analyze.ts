import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getJson, xrpc } from './http.ts';
import { webUrlForDid } from './refs.ts';
import { DEFAULT_MODEL, LABELS, runTone, summarizeTone, type ToneCandidate, type ToneOptions, type ToneResult } from './tone.ts';

const DAY = 86_400_000;
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
  target: string | null;
  targetUri?: string;
}

const didOf = (uri: string) => uri.slice(5).split('/')[0];

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
  throw new Error(
    `no snapshot found for ${pathOrHandle} (tried ${candidates.join(', ')}). Archive it first: slurp ${pathOrHandle} (add --tone to archive and analyze in one go)`,
  );
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
// see docs/analysis.md#empty-samples
const pct = (a: number, b: number): number | null => (b ? Math.round((a / b) * 1000) / 10 : null);
const pc = (n: number | null) => (n == null ? 'n/a' : `${n}%`);

export function toneSentence(t: { cold: { total: number; pctBadFaith: number | null }; warm: { total: number; pctBadFaith: number | null } }): string {
  const { cold, warm } = t;
  if (cold.total && warm.total) {
    const thin = warm.total < 10 || cold.total < 10 ? ` Small sample (${cold.total} cold, ${warm.total} warm), so read the gap loosely.` : '';
    return `${cold.pctBadFaith}% of cold replies/quotes read as bad faith, vs ${warm.pctBadFaith}% toward people they know.${thin}`;
  }
  if (cold.total) return `${cold.pctBadFaith}% of cold replies/quotes read as bad faith. None of the sampled posts were to people they know, so there's no baseline to compare against.`;
  if (warm.total) return `${warm.pctBadFaith}% of replies to people they know read as bad faith. None of the sampled posts were cold, so there's nothing to compare.`;
  return 'No replies or quotes were labelled.';
}

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

export const WINDOWS = [
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 3 months', days: 90 },
  { key: '180d', label: 'Last 6 months', days: 180 },
  { key: '365d', label: 'Last year', days: 365 },
  { key: 'all', label: 'All time', days: null },
] as const;
export type WindowKey = (typeof WINDOWS)[number]['key'];

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
  // see docs/analysis.md#cold-outreach
  const followed = new Set(follows.map((f) => f.record.subject as string));
  const likedAuthors = countBy(likes, (l) => l.record.subject?.uri && didOf(l.record.subject.uri));
  const isCold = (did: string) => !followed.has(did) && !likedAuthors.has(did);

  const windowStats = (since: number | null) => {
    const inWindow = <T extends { at?: number; createdAt?: string | null }>(xs: T[], at: (x: T) => number) =>
      since == null ? xs : xs.filter((x) => at(x) >= since);
    const ps = inWindow(posts, (p) => p.at);
    const lk = inWindow(likes, ts);
    const rp = inWindow(reposts, ts);

    const c = countBy(ps, (p) => p.kind);
    const outward = ps.filter((p) => p.target);
    const quotes = outward.filter((p) => p.kind === 'quote');
    const nonFollowed = outward.filter((p) => !followed.has(p.target!));
    const cold = outward.filter((p) => isCold(p.target!));
    const hours = Array(24).fill(0);
    for (const p of ps) if (!Number.isNaN(p.at)) hours[new Date(p.at).getUTCHours()]++;
    const perDay = countBy(ps, (p) => (Number.isNaN(p.at) ? null : new Date(p.at).toISOString().slice(0, 10)));

    const replyTargets = countBy(outward.filter((p) => p.kind === 'reply'), (p) => p.target);
    const quoteTargets = countBy(quotes, (p) => p.target);
    const strangerQuotes = quotes.filter((p) => isCold(p.target!));
    const bursts: { did: string; count: number; day: string; examples: string[] }[] = [];
    const byTarget = new Map<string, Post[]>();
    for (const p of outward) {
      if (p.kind !== 'reply' || followed.has(p.target!)) continue;
      const list = byTarget.get(p.target!) ?? [];
      list.push(p);
      byTarget.set(p.target!, list);
    }
    for (const [did, list] of byTarget) {
      list.sort((a, b) => a.at - b.at);
      let best: Post[] = [];
      for (let i = 0, j = 0; j < list.length; j++) {
        while (list[j].at - list[i].at > DAY) i++;
        if (j - i + 1 > best.length) best = list.slice(i, j + 1);
      }
      if (best.length >= 5) {
        bursts.push({ did, count: best.length, day: new Date(best[0].at).toISOString().slice(0, 10), examples: best.slice(0, EXAMPLES).map((p) => p.line.web) });
      }
    }
    bursts.sort((a, b) => b.count - a.count);

    const tags = new Map<string, number>();
    const domains = new Map<string, number>();
    for (const p of ps) {
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

    return {
      shape: {
        posts: ps.length,
        original: c.get('original') ?? 0,
        selfThreads: c.get('thread') ?? 0,
        repliesToOthers: c.get('reply') ?? 0,
        quotesOfOthers: quotes.length,
        pctRepliesToOthers: pct(c.get('reply') ?? 0, ps.length),
        pctQuotes: pct(quotes.length, ps.length),
        pctOutwardToNonFollowed: pct(nonFollowed.length, outward.length),
        pctOutwardToStrangers: pct(cold.length, outward.length),
        likes: lk.length,
        reposts: rp.length,
        follows: inWindow(follows, ts).length,
        blocks: inWindow(blocks, ts).length,
        likesPerPost: ps.length ? Math.round((lk.length / ps.length) * 10) / 10 : null,
        activeDays: perDay.size,
        postsPerActiveDay: perDay.size ? Math.round((ps.length / perDay.size) * 10) / 10 : null,
        busiestDays: top(perDay, 5).map(([day, count]) => ({ day, count })),
        postsByHourUTC: hours,
      },
      raw: {
        replyTargets: top(replyTargets, 16),
        quoteTargets: top(quoteTargets, 16),
        liked: top(countBy(lk, (l) => l.record.subject?.uri && didOf(l.record.subject.uri)), 16),
        reposted: top(countBy(rp, (l) => l.record.subject?.uri && didOf(l.record.subject.uri)), 16),
        bursts: bursts.slice(0, 15),
      },
      strangerQuotes: { count: strangerQuotes.length, examples: strangerQuotes.slice(-EXAMPLES).map((p) => p.line.web) },
      interests: {
        hashtags: top(tags, 20).map(([tag, count]) => ({ tag, count })),
        linkDomains: top(domains, 20).map(([domain, count]) => ({ domain, count })),
        languages: top(countBy(ps.flatMap((p) => p.line.record.langs ?? []), (l) => l), 5).map(([lang, count]) => ({ lang, count })),
      },
    };
  };

  const computed = WINDOWS.map((w) => ({ ...w, since: w.days == null ? null : now - w.days * DAY, stats: windowStats(w.days == null ? null : now - w.days * DAY) }));

  const named = new Set<string>();
  for (const { stats } of computed) {
    for (const list of [stats.raw.replyTargets, stats.raw.quoteTargets, stats.raw.liked, stats.raw.reposted]) for (const [d] of list) named.add(d);
    for (const b of stats.raw.bursts) named.add(b.did);
  }
  named.delete(self);
  const handles = await resolveHandles([...named]);
  const who = (did: string) => ({ did, handle: handles.get(did) ?? null, web: webUrlForDid(did), followed: followed.has(did) });
  const ranked = (list: [string, number][]) => list.filter(([d]) => d !== self).slice(0, 15).map(([d, count]) => ({ ...who(d), count }));

  const byWindow = Object.fromEntries(
    computed.map(({ key, label, since, stats }) => [
      key,
      {
        key,
        label,
        since: since == null ? null : new Date(since).toISOString(),
        shape: stats.shape,
        targeting: {
          mostRepliedTo: ranked(stats.raw.replyTargets),
          mostQuoted: ranked(stats.raw.quoteTargets),
          replyBurstsAtNonFollowed: stats.raw.bursts.map((b) => ({ ...who(b.did), count: b.count, day: b.day, examples: b.examples })),
          strangerQuotes: stats.strangerQuotes,
        },
        interests: { ...stats.interests, mostLiked: ranked(stats.raw.liked), mostReposted: ranked(stats.raw.reposted) },
        tone: null as ReturnType<typeof summarizeTone> | null,
      },
    ]),
  ) as Record<WindowKey, WindowReport>;

  const apps = new Map<string, number>();
  for (const [col, n] of Object.entries(manifest.counts as Record<string, number>)) {
    const ns = col.split('.').slice(0, 2).reverse().join('.');
    apps.set(ns, (apps.get(ns) ?? 0) + n);
  }

  const toneCandidates: ToneCandidate[] = posts
    .filter((p) => p.target && p.targetUri && typeof p.line.record.text === 'string' && p.line.record.text.trim())
    .map((p) => ({
      uri: p.line.uri,
      web: p.line.web,
      kind: p.kind as 'reply' | 'quote',
      text: p.line.record.text,
      targetUri: p.targetUri!,
      cold: isCold(p.target!),
      followed: followed.has(p.target!),
      at: p.at,
    }));

  const firstAt = Math.min(...posts.map((p) => p.at).filter((n) => !Number.isNaN(n)));

  const report = {
    version: 2,
    account: {
      did: self,
      handle: manifest.handle,
      snapshot: manifest.fetchedAt,
      labels: manifest.selfLabels,
      firstPost: Number.isFinite(firstAt) ? new Date(firstAt).toISOString() : null,
    },
    windows: WINDOWS.map((w) => w.key),
    byWindow,
    appsUsed: top(apps, 30).map(([app, records]) => ({ app, records })),
    toneCoverage: null as { labelled: number; from: string; to: string } | null,
  };
  return { report, candidates: toneCandidates };
}

interface Person {
  did: string;
  handle: string | null;
  web: string;
  followed: boolean;
  count: number;
}

interface WindowReport {
  key: WindowKey;
  label: string;
  since: string | null;
  shape: {
    posts: number;
    original: number;
    selfThreads: number;
    repliesToOthers: number;
    quotesOfOthers: number;
    pctRepliesToOthers: number | null;
    pctQuotes: number | null;
    pctOutwardToNonFollowed: number | null;
    pctOutwardToStrangers: number | null;
    likes: number;
    reposts: number;
    follows: number;
    blocks: number;
    likesPerPost: number | null;
    activeDays: number;
    postsPerActiveDay: number | null;
    busiestDays: { day: string; count: number }[];
    postsByHourUTC: number[];
  };
  targeting: {
    mostRepliedTo: Person[];
    mostQuoted: Person[];
    replyBurstsAtNonFollowed: (Person & { day: string; examples: string[] })[];
    strangerQuotes: { count: number; examples: string[] };
  };
  interests: {
    hashtags: { tag: string; count: number }[];
    linkDomains: { domain: string; count: number }[];
    languages: { lang: string; count: number }[];
    mostLiked: Person[];
    mostReposted: Person[];
  };
  tone: ReturnType<typeof summarizeTone> | null;
}

type Report = Awaited<ReturnType<typeof analyze>>;

function applyTone(report: Report, candidates: ToneCandidate[], results: Record<string, ToneResult>) {
  const at = new Map(candidates.map((c) => [c.uri, c.at]));
  const labelled = Object.keys(results).filter((u) => at.has(u));
  if (!labelled.length) return;
  const times = labelled.map((u) => at.get(u)!).filter((n) => !Number.isNaN(n));
  report.toneCoverage = { labelled: labelled.length, from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() };
  for (const w of Object.values(report.byWindow)) {
    const since = w.since ? Date.parse(w.since) : -Infinity;
    const inside = Object.fromEntries(labelled.filter((u) => at.get(u)! >= since).map((u) => [u, results[u]]));
    w.tone = Object.keys(inside).length ? summarizeTone(inside) : null;
  }
}

export function toMarkdown(r: Report): string {
  const all = r.byWindow.all;
  const s = all.shape;
  const name = (p: { handle: string | null; did: string; web: string; followed: boolean }) =>
    `[${p.handle ?? p.did}](${p.web})${p.followed ? '' : ' · not followed'}`;
  const list = <T,>(items: T[], fmt: (t: T) => string) => (items.length ? items.map((i) => `- ${fmt(i)}`).join('\n') : '- none');
  const t = all.tone;
  const windows = r.windows.map((k) => r.byWindow[k]);

  return `# Behavior report: ${r.account.handle ?? r.account.did}

**TL;DR:** signals, not a verdict. The strongest bad-faith tells are structural: a high share of replies and quotes aimed at strangers, and bursts of replies at one account. Check the linked posts before you conclude anything. The web UI drills every section into 30 days / 3 months / 6 months / 1 year; this file shows all time plus the comparison below.

- Snapshot ${r.account.snapshot.slice(0, 10)} · first post ${r.account.firstPost?.slice(0, 10) ?? 'n/a'} · self-labels: ${r.account.labels.join(', ') || 'none'}

## Over time

| window | posts | replies to others | quotes | cold share | reply bursts | stranger quotes | bad faith, cold / warm |
|---|---|---|---|---|---|---|---|
${windows.map((w) => `| ${w.label} | ${w.shape.posts} | ${pc(w.shape.pctRepliesToOthers)} | ${pc(w.shape.pctQuotes)} | ${pc(w.shape.pctOutwardToStrangers)} | ${w.targeting.replyBurstsAtNonFollowed.length} | ${w.targeting.strangerQuotes.count} | ${w.tone ? `${pc(w.tone.cold.pctBadFaith)} / ${pc(w.tone.warm.pctBadFaith)}` : 'n/a'} |`).join('\n')}

**Reading it:** a cold share or bad-faith rate that climbs as the window narrows means it's getting worse lately. Windows count back from the snapshot date. "Followed" and "cold" use relationships as of the snapshot.

## Shape of engagement (all time)

| | count |
|---|---|
| posts | ${s.posts} |
| original posts | ${s.original} |
| self-threads | ${s.selfThreads} |
| replies to others | ${s.repliesToOthers} (${pc(s.pctRepliesToOthers)}) |
| quotes | ${s.quotesOfOthers} (${pc(s.pctQuotes)}) |
| replies+quotes aimed at non-followed | ${pc(s.pctOutwardToNonFollowed)} |
| …and never liked either ("cold") | ${pc(s.pctOutwardToStrangers)} |

- ${s.likes} likes · ${s.reposts} reposts · ${s.follows} follows · ${s.blocks} blocks · ${s.likesPerPost ?? 'n/a'} likes per post
- ${s.activeDays} active days, ${s.postsPerActiveDay ?? 'n/a'} posts per active day
- Busiest days: ${s.busiestDays.map((d) => `${d.day} (${d.count})`).join(', ') || 'none'}

Lots of blocks usually means defensive block lists, not aggression.

## Targeting (all time)

**Most replied to**
${list(all.targeting.mostRepliedTo, (p) => `${name(p)} — ${p.count}`)}

**Most quoted**
${list(all.targeting.mostQuoted, (p) => `${name(p)} — ${p.count}`)}

**Reply bursts at non-followed accounts** (5+ replies within 24h)
${list(all.targeting.replyBurstsAtNonFollowed, (b) => `${name(b)} — ${b.count} on ${b.day}: ${b.examples.map((u, i) => `[${i + 1}](${u})`).join(' ')}`)}

**Quotes of strangers:** ${all.targeting.strangerQuotes.count}${all.targeting.strangerQuotes.examples.length ? ` — latest: ${all.targeting.strangerQuotes.examples.map((u, i) => `[${i + 1}](${u})`).join(' ')}` : ''}

## Interests (all time)

- **Hashtags:** ${all.interests.hashtags.map((x) => `#${x.tag} (${x.count})`).join(', ') || 'none'}
- **Links to:** ${all.interests.linkDomains.map((d) => `${d.domain} (${d.count})`).join(', ') || 'none'}
- **Languages:** ${all.interests.languages.map((l) => `${l.lang} (${l.count})`).join(', ') || 'none'}
- **Apps on the atmosphere:** ${r.appsUsed.map((x) => `${x.app} (${x.records})`).join(', ')}

**Most liked**
${list(all.interests.mostLiked, (p) => `${name(p)} — ${p.count}`)}

**Most reposted**
${list(all.interests.mostReposted, (p) => `${name(p)} — ${p.count}`)}
${t ? toneMarkdown(t, r.toneCoverage) : ''}`;
}

function toneMarkdown(t: NonNullable<WindowReport['tone']>, coverage: Report['toneCoverage']): string {
  const row = (l: string) => `| ${l} | ${t.cold.counts[l]} | ${t.warm.counts[l]} |`;
  const examples = LABELS.filter((l) => t.examples[l].length)
    .map((l) => `**${l}**\n${t.examples[l].map((e) => `- [post](${e.web}) (${e.confidence}${e.cold ? ', cold' : ''}): ${e.reason}`).join('\n')}`)
    .join('\n\n');
  return `
## Tone (Claude)

**TL;DR:** ${toneSentence(t)} Bad faith = argumentative, hostile or trolling. A big gap between cold and warm is the tell. A high number on both is just how they talk.

- ${t.labelled} posts labelled by ${t.model}${t.refused ? `, ${t.refused} without a label` : ''}${coverage ? `, covering ${coverage.from.slice(0, 10)} to ${coverage.to.slice(0, 10)}` : ''}. Every label is a model's reading of one post in context. Open the examples.

| label | cold (${t.cold.total}) | warm (${t.warm.total}) |
|---|---|---|
${LABELS.map(row).join('\n')}

${examples}
`;
}

export async function runAnalyze(target: string, out: string, tone?: ToneOptions, log: (m: string) => void = () => {}) {
  const snap = await resolveSnapshot(target, out);
  const { report, candidates } = await analyzeWithCandidates(snap);
  if (!tone && existsSync(join(snap, 'tone.json'))) {
    applyTone(report, candidates, JSON.parse(await readFile(join(snap, 'tone.json'), 'utf8')));
  }
  if (tone) {
    try {
      applyTone(report, candidates, await runTone(snap, candidates, tone, log));
    } catch (err) {
      log(`⚠ tone pass failed: ${(err as Error).message}`);
      log('  writing the report without it');
    }
  }
  await writeFile(join(snap, 'analysis.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(snap, 'analysis.md'), toMarkdown(report));
  return snap;
}

export { DEFAULT_MODEL };

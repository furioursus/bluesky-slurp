import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { getJson, pool, xrpc } from './http.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5';
const BATCH = 20;
const CONCURRENCY = 3;

const PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

export const LABELS = ['genuine', 'supportive', 'playful', 'disagreeing', 'argumentative', 'hostile', 'trolling', 'unclear'] as const;
export type Label = (typeof LABELS)[number];
const BAD_FAITH: Label[] = ['argumentative', 'hostile', 'trolling'];

export interface ToneCandidate {
  uri: string;
  web: string;
  kind: 'reply' | 'quote';
  text: string;
  targetUri: string;
  cold: boolean;
  followed: boolean;
  at: number;
}

export interface ToneResult {
  label: Label | 'refused';
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  cold: boolean;
  web: string;
  model: string;
}

export interface ToneEstimate {
  posts: number;
  requests: number;
  model: string;
  inputTokens: number;
  outputLow: number;
  outputHigh: number;
  costLow: number | null;
  costHigh: number | null;
}

export interface ToneOptions {
  model: string;
  limit: number;
  yes: boolean;
  confirm?: (estimate: ToneEstimate) => Promise<boolean>;
}

const SYSTEM = `You label the tone of social media posts for someone deciding whether an account engages in good or bad faith.

Each item is one post by the account under review. It is either a reply to another post or a quote-post of another post, and the other post is given as context. Judge only the reviewed account's post, read against the context it responded to.

Labels:
- genuine: good-faith engagement: sharing information, asking a real question, adding to the conversation.
- supportive: encouragement, agreement, solidarity, thanks.
- playful: jokes, banter, or light teasing that reads as friendly in context.
- disagreeing: civil disagreement or criticism that engages with the substance.
- argumentative: combative or point-scoring. Aims to win rather than understand, piles on, moves goalposts.
- hostile: insults, contempt, name-calling, threats, or demeaning the person rather than the idea.
- trolling: deliberate provocation or bait, derailing, sealioning, bad-faith "just asking questions".
- unclear: not enough context to tell, or the post is too short to mean much.

Guidance:
- Disagreement is not bad faith. Calling out bigotry or pushing back on a harasser is usually "disagreeing" or "genuine", not "hostile", even when blunt.
- Profanity or sarcasm between people who clearly know each other is often "playful".
- "cold: true" means the account doesn't follow the person and has never liked their posts. Weigh it as context, never as proof.
- Missing context ("[unavailable]") means the other post was deleted or is hidden. Lean toward "unclear" unless the post stands on its own.
- reason: one short sentence that quotes or paraphrases the specific words that decided the label.

Return one result per item, using the item's id.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          label: { type: 'string', enum: [...LABELS] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string' },
        },
        required: ['id', 'label', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

export function selectCandidates(all: ToneCandidate[], limit: number): ToneCandidate[] {
  const byRecent = [...all].sort((a, b) => b.at - a.at);
  const coldQuota = Math.ceil(limit * 0.75);
  const cold = byRecent.filter((c) => c.cold).slice(0, coldQuota);
  const warm = byRecent.filter((c) => !c.cold).slice(0, limit - cold.length);
  return [...cold, ...warm];
}

async function hydrate(uris: string[]): Promise<Map<string, { author: string; text: string }>> {
  const out = new Map<string, { author: string; text: string }>();
  const unique = [...new Set(uris)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 25) batches.push(unique.slice(i, i + 25));
  await pool(batches, 4, async (batch) => {
    const url = new URL(xrpc('https://public.api.bsky.app', 'app.bsky.feed.getPosts', {}));
    for (const u of batch) url.searchParams.append('uris', u);
    try {
      const { posts } = await getJson(url.toString());
      for (const p of posts) {
        const media = p.embed ? ` [${String(p.embed.$type).split('.').pop()?.replace('#view', '')}]` : '';
        out.set(p.uri, { author: `@${p.author.handle}`, text: `${p.record?.text ?? ''}${media}` });
      }
    } catch {}
  });
  return out;
}

function buildRequests(items: ToneCandidate[], context: Map<string, { author: string; text: string }>) {
  const batches: ToneCandidate[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  return batches.map((batch) => {
    const payload = batch.map((c, id) => {
      const ctx = context.get(c.targetUri);
      return {
        id,
        kind: c.kind,
        cold: c.cold,
        followsThem: c.followed,
        context: ctx ? `${ctx.author}: ${ctx.text}` : '[unavailable]',
        post: c.text,
      };
    });
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: `Label each item.\n\n${JSON.stringify(payload, null, 1)}` },
    ];
    return { batch, messages };
  });
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const fmt = (n: number) => n.toLocaleString('en-US');

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runTone(
  snap: string,
  all: ToneCandidate[],
  opts: ToneOptions,
  log: (msg: string) => void,
): Promise<Record<string, ToneResult>> {
  const cachePath = join(snap, 'tone.json');
  const cache: Record<string, ToneResult> = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};

  const chosen = selectCandidates(all, opts.limit);
  const todo = chosen.filter((c) => !cache[c.uri] || cache[c.uri].model !== opts.model);
  log(`tone pass: ${chosen.length} posts selected (${chosen.filter((c) => c.cold).length} cold, ${chosen.filter((c) => !c.cold).length} warm baseline), ${chosen.length - todo.length} already labelled`);
  if (!todo.length) return pick(cache, chosen);

  const price = PRICES[opts.model];
  if (!price) log(`  ⚠ no price on file for ${opts.model}; showing tokens only`);

  log('  fetching the posts they responded to…');
  const context = await hydrate(todo.map((c) => c.targetUri));
  const requests = buildRequests(todo, context);

  const client = new Anthropic({ maxRetries: 4 });
  const base = {
    model: opts.model,
    system: [{ type: 'text' as const, text: SYSTEM, cache_control: { type: 'ephemeral' as const } }],
    output_config: { effort: 'low' as const, format: { type: 'json_schema' as const, schema: SCHEMA } },
  };

  log('  counting tokens…');
  let inputTokens = 0;
  try {
    for (const r of requests) {
      inputTokens += (await client.beta.messages.countTokens({ ...base, messages: r.messages })).input_tokens;
    }
  } catch (err) {
    // see docs/tone-pass.md#credentials
    if (err instanceof Anthropic.AuthenticationError || !(err instanceof Anthropic.APIError)) {
      throw new Error(`no working Claude API credentials (${(err as Error).message.split('.')[0]}). Set ANTHROPIC_API_KEY or run \`ant auth login\`.`);
    }
    throw err;
  }
  const outLow = todo.length * 60;
  const outHigh = todo.length * 180 + requests.length * 800;
  const estimate: ToneEstimate = {
    posts: todo.length,
    requests: requests.length,
    model: opts.model,
    inputTokens,
    outputLow: outLow,
    outputHigh: outHigh,
    costLow: price ? (inputTokens * price.input + outLow * price.output) / 1e6 : null,
    costHigh: price ? (inputTokens * price.input + outHigh * price.output) / 1e6 : null,
  };
  log(`  estimate: ${fmt(inputTokens)} input + ${fmt(outLow)}–${fmt(outHigh)} output tokens across ${requests.length} requests on ${opts.model}`);
  if (estimate.costLow !== null) log(`  ≈ ${money(estimate.costLow)}–${money(estimate.costHigh!)}`);
  const ask = opts.confirm ?? (() => confirm('  proceed? [y/N] '));
  if (!opts.yes && !(await ask(estimate))) {
    log('  skipped tone pass');
    return pick(cache, chosen);
  }

  // see docs/tone-pass.md#label-cache
  let saving = Promise.resolve();
  const save = () =>
    (saving = saving.then(async () => {
      await writeFile(`${cachePath}.tmp`, `${JSON.stringify(cache, null, 2)}\n`);
      await rename(`${cachePath}.tmp`, cachePath);
    }));

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let done = 0;
  let refused = 0;
  await pool(requests, CONCURRENCY, async ({ batch, messages }) => {
    const response = await client.beta.messages.create({
      ...base,
      max_tokens: 16000,
      messages,
      ...(FALLBACK_MODELS.has(opts.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    const text = response.content.find((b) => b.type === 'text');
    const parsed = response.stop_reason !== 'refusal' && text?.type === 'text' ? safeParse(text.text) : null;
    const byId = new Map<number, any>((parsed?.results ?? []).map((r: any) => [r.id, r]));
    batch.forEach((c, id) => {
      const r = byId.get(id);
      if (!r) refused++;
      cache[c.uri] = r
        ? { label: r.label, confidence: r.confidence, reason: r.reason, cold: c.cold, web: c.web, model: response.model }
        : { label: 'refused', confidence: 'low', reason: `no result (stop_reason: ${response.stop_reason})`, cold: c.cold, web: c.web, model: opts.model };
    });
    done += batch.length;
    log(`  ${done}/${todo.length}`);
    await save();
  });
  await saving;

  const actualIn = usage.input + usage.cacheRead + usage.cacheWrite;
  log(`  actual: ${fmt(actualIn)} input (${fmt(usage.cacheRead)} cache reads) + ${fmt(usage.output)} output tokens`);
  if (price) {
    const cost = (usage.input * price.input + usage.cacheRead * price.input * 0.1 + usage.cacheWrite * price.input * 1.25 + usage.output * price.output) / 1e6;
    log(`  ≈ ${money(cost)}`);
  }
  if (refused) log(`  ⚠ ${refused} posts came back without a label; they're marked "refused" in tone.json`);
  return pick(cache, chosen);
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function pick(cache: Record<string, ToneResult>, chosen: ToneCandidate[]): Record<string, ToneResult> {
  return Object.fromEntries(chosen.filter((c) => cache[c.uri]).map((c) => [c.uri, cache[c.uri]]));
}

export function summarizeTone(results: Record<string, ToneResult>) {
  const rows = Object.values(results).filter((r) => r.label !== 'refused');
  const share = (rs: ToneResult[]) => {
    const counts = Object.fromEntries(LABELS.map((l) => [l, rs.filter((r) => r.label === l).length]));
    const badFaith = rs.filter((r) => BAD_FAITH.includes(r.label as Label)).length;
    // see docs/analysis.md#empty-samples
    return { total: rs.length, counts, pctBadFaith: rs.length ? Math.round((badFaith / rs.length) * 1000) / 10 : null };
  };
  const examples = Object.fromEntries(
    LABELS.map((l) => [
      l,
      rows
        .filter((r) => r.label === l)
        .sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.confidence] - ({ high: 0, medium: 1, low: 2 })[b.confidence])
        .slice(0, 5)
        .map((r) => ({ web: r.web, reason: r.reason, confidence: r.confidence, cold: r.cold })),
    ]),
  );
  return {
    model: rows[0]?.model ?? null,
    labelled: rows.length,
    refused: Object.values(results).length - rows.length,
    cold: share(rows.filter((r) => r.cold)),
    warm: share(rows.filter((r) => !r.cold)),
    examples,
  };
}

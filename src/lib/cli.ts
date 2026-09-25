#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { archiveAccount } from './archive.ts';
import { DEFAULT_MODEL, resolveSnapshot, runAnalyze } from './analyze.ts';
import { downloadSnapshotMedia } from './media.ts';

const HELP = `slurp — archive everything an atproto account has publicly put on the network

usage: slurp <handle | did | bsky.app profile URL> [options]
       slurp analyze <handle | snapshot dir> [--tone] [--out <dir>]
       slurp media <handle | snapshot dir> [--out <dir>]   download media for an existing snapshot

options:
  --media        also download images, video and other blobs (off by default)
  --analyze      write analysis.md / analysis.json into the snapshot after archiving
  --tone         add a Claude tone pass to the analysis (shows a token/cost estimate and asks first)
  --model <id>   model for the tone pass (default: ${DEFAULT_MODEL})
  --tone-limit <n>  max posts to label: 75% most recent cold, 25% warm baseline (default: 200)
  -y, --yes      skip the tone-pass confirmation
  --out <dir>    archive root (default: ./archives)
  -h, --help     show this help

output: <out>/<handle>/snapshots/<timestamp>/ plus a shared <out>/<handle>/blobs/ for media`;

const log = (msg: string) => process.stderr.write(`${msg}\n`);

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      media: { type: 'boolean', default: false },
      analyze: { type: 'boolean', default: false },
      tone: { type: 'boolean', default: false },
      model: { type: 'string', default: DEFAULT_MODEL },
      'tone-limit': { type: 'string', default: '200' },
      yes: { type: 'boolean', short: 'y', default: false },
      out: { type: 'string', default: 'archives' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const tone = values.tone ? { model: values.model!, limit: Number(values['tone-limit']), yes: values.yes! } : undefined;
  if (positionals[0] === 'analyze' && positionals.length === 2) {
    const snap = await runAnalyze(positionals[1], values.out!, tone, log);
    log(`analysis → ${join(snap, 'analysis.md')}`);
    return;
  }
  if (positionals[0] === 'media' && positionals.length === 2) {
    const snap = await resolveSnapshot(positionals[1], values.out!);
    await downloadSnapshotMedia(snap, log);
    log(`done → ${snap}`);
    return;
  }
  if (values.help || positionals.length !== 1) {
    log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const { snapDir } = await archiveAccount(positionals[0], { media: values.media!, out: values.out! }, log);
  if (values.analyze || values.tone) {
    log('analyzing…');
    await runAnalyze(snapDir, values.out!, tone, log);
  }
  log(`done → ${snapDir}`);
}

main().catch((err) => {
  log(`error: ${err?.message ?? err}`);
  process.exit(1);
});

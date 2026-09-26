#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { archiveAccount, isLegacy, migrateAccount } from './archive.ts';
import { resolveArchive, runAnalyze } from './analyze.ts';
import { downloadArchiveMedia } from './media.ts';

const HELP = `slurp — archive everything an atproto account has publicly put on the network

usage: slurp <handle | did | bsky.app profile URL> [options]   archive it, or update the archive you already have
       slurp analyze <handle | archive dir> [--out <dir>]
       slurp media <handle | archive dir> [--out <dir>]        download media for an existing archive
       slurp migrate [<handle>] [--write] [--out <dir>]       fold old timestamped snapshots into one archive (dry run without --write)

options:
  --media        also download images, video and other blobs (off by default; an archive that has media keeps getting it)
  --analyze      write analysis.md / analysis.json after archiving (always refreshed if the archive already has one)
  --write        migrate only: actually convert (otherwise it just checks and reports)
  --out <dir>    archive root (default: ./archives)
  -h, --help     show this help

output: <out>/<handle>/ — one living archive per account; updates merge in and keep deleted records flagged`;

const log = (msg: string) => process.stderr.write(`${msg}\n`);

async function migrate(out: string, only: string | undefined, write: boolean) {
  const names = only ? [only.replace(/^@/, '')] : (await readdir(out)).sort();
  let found = 0;
  for (const name of names) {
    const dir = join(out, name);
    if (!isLegacy(dir)) continue;
    found++;
    log(`@${name}`);
    await migrateAccount(dir, log, { write });
    if (write) {
      await runAnalyze(dir, out).then(() => log('  report refreshed'), () => {});
    }
  }
  log(found ? (write ? `done: ${found} converted` : `dry run: ${found} would be converted. Re-run with --write to do it.`) : 'nothing in the old format');
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      media: { type: 'boolean' },
      analyze: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      out: { type: 'string', default: 'archives' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (positionals[0] === 'migrate' && positionals.length <= 2) return migrate(values.out!, positionals[1], values.write!);
  if (positionals[0] === 'analyze' && positionals.length === 2) {
    const dir = await runAnalyze(positionals[1], values.out!);
    log(`analysis → ${join(dir, 'analysis.md')}`);
    return;
  }
  if (positionals[0] === 'media' && positionals.length === 2) {
    const dir = await resolveArchive(positionals[1], values.out!);
    await downloadArchiveMedia(dir, log);
    log(`done → ${dir}`);
    return;
  }
  if (values.help || positionals.length !== 1) {
    log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const { dir } = await archiveAccount(positionals[0], { media: values.media, out: values.out! }, log);
  if (values.analyze || existsSync(join(dir, 'analysis.json'))) {
    log('analyzing…');
    await runAnalyze(dir, values.out!);
  }
  log(`done → ${dir}`);
}

main().catch((err) => {
  log(`error: ${err?.message ?? err}`);
  process.exit(1);
});

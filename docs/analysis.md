# Analysis

**TL;DR:** offline, structural signals of good- or bad-faith engagement, computed for five time windows, each with links to the posts behind it. It never outputs a verdict. Code: `src/lib/analyze.ts`.

## Signals, not verdicts

**TL;DR:** no single score. Every number links to evidence, and the reader decides.

- A single "troll score" misreads people. Someone who argues with harassers all day looks "argumentative", and someone with a sarcastic friend group looks "hostile".
- The strongest bad-faith tells are structural: who someone replies to, how often it's cold, and how fixated they are on one person. Those don't depend on reading tone.

## Cold outreach

**TL;DR:** a reply or quote is "cold" when it's aimed at an account they don't follow *and* have never liked a post from. Both checks use the relationships as of the snapshot.

- "Non-followed" alone is too broad: people reply to accounts they read through feeds and search. Adding "never liked them either" isolates genuine strangers.
- The archive only knows the *current* follow list. A reply to someone they followed back then but have since unfollowed counts as cold. There's no fixing this without historical follow data, so don't try to back-date it.
- Self-replies (threads) and self-quotes are excluded.

## Reply bursts

**TL;DR:** 5+ replies to the same non-followed account within any 24-hour stretch, using a sliding window per target.

## Time windows

**TL;DR:** every stat is computed for the last 30 days, 3 months, 6 months, 1 year, and all time, counted back from the snapshot's `fetchedAt`, not today.

- Counting from the snapshot keeps old snapshots stable: a March archive always means "the 30 days before March".
- All five windows are computed in one pass and stored in `analysis.json` under `byWindow`. The UI switches instantly with no recomputation.
- Likes, reposts, follows and blocks are windowed by their own `createdAt`.
- "Apps on the atmosphere" is all-time only: it comes from per-collection counts in the manifest, which carry no timestamps.
- Reports without `byWindow` (pre-v2) get a one-click re-run prompt in the UI.

## Empty samples

**TL;DR:** a percentage with no denominator is `null`, never `0`. "No data" must never read as "0%, nothing wrong here".

- `pct()` returns `null` for an empty sample.
- The UI and Markdown branch on sample sizes (`total`), not on the percentage, and say "no warm posts sampled" rather than printing a number.
- The original bug (in the since-retired tone stat): `13.3/0`, which reads as a division by zero and would have shown a false 0% for an empty side.

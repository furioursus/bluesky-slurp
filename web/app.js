// Slurp UI. No build step: plain ES module, DOM built with h() so archived text is never parsed as HTML.

const view = document.getElementById('view');
const APPVIEW = 'https://public.api.bsky.app/xrpc';
const LABELS = ['genuine', 'supportive', 'playful', 'disagreeing', 'argumentative', 'hostile', 'trolling', 'unclear'];
const BAD_FAITH = new Set(['argumentative', 'hostile', 'trolling']);
const MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5', 'claude-opus-5-5', 'claude-fable-5-1'];

// ---- dom helpers ---------------------------------------------------------

function safeHref(v) {
  const s = String(v);
  return /^(https?:\/\/|#|\/)/.test(s) ? s : '#';
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'href' || k === 'src') el.setAttribute(k, safeHref(v));
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ext = (href, ...kids) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...kids);
const cell = (props, ...kids) => h('div', { ...props, class: `cell ${props?.class ?? ''}`.trim() }, ...kids);
const grid = (cls, ...kids) => h('section', { class: `grid ${cls}` }, ...kids);
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const pct = (n) => (n == null ? '—' : `${n}%`);
const money = (n) => (n == null ? null : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const day = (iso) => (iso ? iso.slice(0, 10) : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

function render(...nodes) {
  view.replaceChildren(...nodes);
  view.focus({ preventScroll: true });
}

function setNav(key) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

let config = null;
const getConfig = async () => (config ??= await api('/api/config'));

// ---- handle resolution for pointers (public AppView, batched) --------------

const handles = new Map();

async function resolveHandles(dids) {
  const todo = [...new Set(dids)].filter((d) => d.startsWith('did:') && !handles.has(d));
  for (let i = 0; i < todo.length; i += 25) {
    const q = todo.slice(i, i + 25).map((d) => `actors=${encodeURIComponent(d)}`).join('&');
    try {
      const { profiles } = await (await fetch(`${APPVIEW}/app.bsky.actor.getProfiles?${q}`)).json();
      for (const p of profiles) handles.set(p.did, p.handle);
    } catch {}
    for (const d of todo.slice(i, i + 25)) if (!handles.has(d)) handles.set(d, null);
  }
}

/** Swap every [data-did] label for @handle once resolved. */
async function hydrateHandles(root) {
  const els = [...root.querySelectorAll('[data-did]')];
  await resolveHandles(els.map((el) => el.dataset.did));
  for (const el of els) {
    const handle = handles.get(el.dataset.did);
    if (handle) el.textContent = `@${handle}${el.dataset.suffix ?? ''}`;
  }
}

const didOf = (target) => (target.startsWith('at://') ? target.slice(5).split('/')[0] : target);

/** Human label for a ref target: "@handle · post 3kx…" style, filled in after handle lookup. */
function refLabel(ref) {
  if (ref.kind === 'link') return ref.target.replace(/^https?:\/\//, '');
  if (ref.kind === 'blob') return `${ref.mimeType ?? 'blob'} · ${ref.target.slice(0, 16)}…`;
  const did = didOf(ref.target);
  const rest = ref.target.startsWith('at://') ? ref.target.slice(5).split('/').slice(1) : [];
  const suffix = rest.length ? ` · ${rest[0].split('.').pop()} ${rest[1] ?? ''}` : '';
  return h('span', { 'data-did': did, 'data-suffix': suffix }, `${did}${suffix}`);
}

// ---- embedded posts (for likes and reposts) ------------------------------------

const EMBED_ROLES = new Set(['liked', 'reposted']);
const EMBED_KICKER = { 'reply-root': 'Thread root', 'reply-parent': 'Replying to', liked: 'Liked post', reposted: 'Reposted post' };

const prefs = {
  get showRoots() {
    try { return localStorage.getItem('slurp-show-roots') === '1'; } catch { return false; }
  },
  set showRoots(v) {
    try { localStorage.setItem('slurp-show-roots', v ? '1' : '0'); } catch {}
  },
};

/** Which pointers get an embedded post card: likes/reposts and reply parents always, thread roots on request. */
function embedTargets(pointers) {
  const isPost = (x) => x.kind === 'record' && x.target.includes('/app.bsky.feed.post/');
  const parent = pointers.find((x) => x.role === 'reply-parent');
  const picked = pointers.filter((x) => isPost(x) && (
    EMBED_ROLES.has(x.role) ||
    x.role === 'reply-parent' ||
    (x.role === 'reply-root' && prefs.showRoots && x.target !== parent?.target)
  ));
  // read a thread top-down: root, then the post being answered
  return picked.sort((a, b) => (a.role === 'reply-root' ? -1 : b.role === 'reply-root' ? 1 : 0));
}
const SENSITIVE = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore']);
const posts = new Map(); // at:// uri → PostView, or null when deleted/hidden

async function fetchPosts(uris) {
  const todo = [...new Set(uris)].filter((u) => !posts.has(u));
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    try {
      const res = await fetch(`${APPVIEW}/app.bsky.feed.getPosts?${batch.map((u) => `uris=${encodeURIComponent(u)}`).join('&')}`);
      for (const p of (await res.json()).posts ?? []) posts.set(p.uri, p);
    } catch {}
    // anything the AppView didn't return is deleted, taken down, or hidden from logged-out viewers
    for (const u of batch) if (!posts.has(u)) posts.set(u, null);
  }
}

/** Replace every [data-embed-uri] placeholder with a card for that post. */
async function hydrateEmbeds(root) {
  const slots = [...root.querySelectorAll('[data-embed-uri]')];
  if (!slots.length) return;
  await fetchPosts(slots.map((el) => el.dataset.embedUri));
  for (const el of slots) el.replaceWith(postEmbed(el.dataset.embedUri, posts.get(el.dataset.embedUri)));
}

const bskyPostUrl = (uri) => {
  const [repo, , rkey] = uri.slice(5).split('/');
  return `https://bsky.app/profile/${repo}/post/${rkey}`;
};

function postEmbed(uri, p) {
  if (!p) {
    return h('div', { class: 'embed gone' }, h('p', {}, h('strong', {}, 'Post unavailable. '), 'Deleted, taken down, or hidden from logged-out viewers. The pointer above still records which post it was.'));
  }
  const labels = [...(p.labels ?? []), ...(p.author.labels ?? [])].map((l) => l.val).filter((v) => !v.startsWith('!'));
  const sensitive = labels.some((l) => SENSITIVE.has(l));
  const blurToggle = (el) => {
    if (!sensitive) return el;
    el.classList.add('blurred');
    el.addEventListener('click', (e) => {
      if (el.classList.contains('blurred')) {
        e.preventDefault();
        el.classList.remove('blurred');
      }
    });
    return el;
  };
  return h('article', { class: 'embed' },
    p.author.avatar ? h('img', { class: 'avatar sm', src: p.author.avatar, alt: '', loading: 'lazy' }) : h('div', { class: 'avatar sm' }),
    h('div', { class: 'embed-body' },
      h('div', { class: 'embed-head' },
        h('span', { class: 'break' }, p.author.displayName && h('strong', {}, `${p.author.displayName} `), h('span', { class: 'muted' }, `@${p.author.handle}`)),
        ext(bskyPostUrl(p.uri), `${when(p.record?.createdAt)} ↗`)),
      p.record?.text && h('p', { class: 'embed-text' }, p.record.text),
      embedMedia(p.embed, blurToggle),
      labels.length > 0 && h('p', {}, labels.map((l) => h('span', { class: 'tag', style: 'margin:0 6px 0 0' }, l))),
      h('p', { class: 'embed-stats muted' }, `${fmt(p.replyCount)} replies · ${fmt(p.repostCount)} reposts · ${fmt(p.quoteCount)} quotes · ${fmt(p.likeCount)} likes`),
    ),
  );
}

/** Images, video poster, link card, and quoted post, from the AppView's hydrated embed view. */
function embedMedia(e, blurToggle) {
  if (!e) return null;
  const type = e.$type ?? '';
  if (type.startsWith('app.bsky.embed.recordWithMedia')) return [embedMedia(e.media, blurToggle), embedMedia(e.record, blurToggle)];
  if (type.startsWith('app.bsky.embed.images')) {
    return h('div', { class: 'thumbs' }, e.images.map((img) => blurToggle(ext(img.fullsize, h('img', { src: img.thumb, alt: img.alt || '', loading: 'lazy' })))));
  }
  if (type.startsWith('app.bsky.embed.video')) {
    return e.thumbnail ? h('div', { class: 'thumbs' }, blurToggle(h('span', { class: 'video-thumb' }, h('img', { src: e.thumbnail, alt: e.alt || '', loading: 'lazy' }), h('b', {}, '▶ video')))) : h('p', { class: 'muted' }, '▶ video');
  }
  if (type.startsWith('app.bsky.embed.external')) {
    const x = e.external;
    return ext(x.uri, h('div', { class: 'link-card' }, x.thumb && h('img', { src: x.thumb, alt: '', loading: 'lazy' }), h('div', {}, h('strong', {}, x.title || x.uri), x.description && h('p', { class: 'muted' }, x.description), h('p', { class: 'mono muted break' }, x.uri.replace(/^https?:\/\//, '').split('/')[0]))));
  }
  if (type.startsWith('app.bsky.embed.record')) {
    const r = e.record;
    if (!r?.author) return h('div', { class: 'quote muted' }, 'Quoted post unavailable');
    return h('div', { class: 'quote' },
      h('p', {}, h('span', { class: 'kicker' }, 'Quoting '), ext(r.uri?.includes('/app.bsky.feed.post/') ? bskyPostUrl(r.uri) : `https://bsky.app/profile/${r.author.did}`, `@${r.author.handle}`)),
      r.value?.text && h('p', { class: 'embed-text' }, r.value.text));
  }
  return null;
}

// ---- job panel -------------------------------------------------------------

/** Starts a job and returns a panel that streams its log, asks about tone estimates, and calls onDone. */
async function jobPanel(request, onDone) {
  const log = h('pre', { class: 'log', 'aria-live': 'polite' });
  const status = h('span', { class: 'kicker' }, 'starting');
  const prompt = cell({ class: 'span-all', hidden: true });
  const panel = grid('cols-1 job', cell({ class: 'stack' }, h('div', { class: 'status-line' }, h('h3', { class: 'subtitle' }, request.mode === 'archive' ? `Archiving ${request.input}` : `Analyzing ${request.input}`), status), log), prompt);

  const append = (line) => {
    log.append(h('span', { class: /⚠|error/.test(line) ? 'warn' : '' }, `${line}\n`));
    log.scrollTop = log.scrollHeight;
  };

  let id;
  try {
    ({ id } = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
  } catch (err) {
    append(`error: ${err.message}`);
    status.textContent = 'failed';
    return panel;
  }
  status.textContent = 'running';
  const es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'log') append(ev.data);
    if (ev.type === 'estimate') showEstimate(ev.data);
    if (ev.type === 'error') {
      append(`error: ${ev.data}`);
      status.textContent = 'failed';
      es.close();
    }
    if (ev.type === 'done') {
      status.textContent = 'done';
      es.close();
      onDone?.(ev.data, panel);
    }
  };

  function showEstimate(e) {
    status.textContent = 'waiting for you';
    const answer = async (yes) => {
      prompt.hidden = true;
      status.textContent = yes ? 'labelling' : 'finishing';
      await api(`/api/jobs/${id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yes }) });
    };
    const cost = e.costLow == null ? 'no price on file' : `${money(e.costLow)} – ${money(e.costHigh)}`;
    prompt.replaceChildren(
      h('div', { class: 'grid cols-4' },
        cell({ class: 'stack' }, h('p', { class: 'kicker' }, 'Tone pass estimate'), h('p', { class: 'big-number' }, cost)),
        cell({ class: 'stack' }, h('p', { class: 'kicker' }, 'Input tokens (exact)'), h('p', { class: 'big-number' }, fmt(e.inputTokens))),
        cell({ class: 'stack' }, h('p', { class: 'kicker' }, 'Output tokens (range)'), h('p', { class: 'subtitle' }, `${fmt(e.outputLow)} – ${fmt(e.outputHigh)}`)),
        cell({ class: 'stack' }, h('p', { class: 'kicker' }, `${fmt(e.posts)} posts · ${e.requests} requests`), h('p', { class: 'mono' }, e.model)),
      ),
      h('div', { class: 'btn-row', style: 'margin-top:20px' },
        h('button', { class: 'btn solid', type: 'button', onclick: () => answer(true) }, 'Proceed'),
        h('button', { class: 'btn', type: 'button', onclick: () => answer(false) }, 'Skip tone pass'),
      ),
    );
    prompt.hidden = false;
    prompt.querySelector('button').focus();
  }
  return panel;
}

function toneControls(cfg, { withToggle = true } = {}) {
  const tone = h('input', { type: 'checkbox', name: 'tone' });
  const model = h('select', { class: 'input small', name: 'model', 'aria-label': 'Tone model' }, MODELS.map((m) => h('option', { value: m, selected: m === cfg.defaultModel }, m)));
  const limit = h('input', { class: 'input small', name: 'toneLimit', type: 'number', min: 1, max: 2000, value: 200, 'aria-label': 'Posts to label' });
  const el = h('div', { class: 'stack' },
    withToggle && h('label', { class: 'check' }, tone, h('span', {}, h('strong', {}, 'Tone pass'), h('small', {}, 'Claude labels replies and quotes. Shows a cost estimate and asks before spending.'))),
    h('div', { class: 'grid cols-2', style: 'background:none;gap:12px;border:0' }, h('label', { class: 'field' }, h('span', { class: 'kicker' }, 'Model'), model), h('label', { class: 'field' }, h('span', { class: 'kicker' }, 'Posts to label'), limit)),
    !cfg.hasApiKey && h('p', { class: 'notice' }, 'No ANTHROPIC_API_KEY in the server environment. Put it in .env and restart, or the tone pass will fail.'),
  );
  return { el, tone, model, limit };
}

// ---- home ------------------------------------------------------------------

async function homeView() {
  setNav('home');
  const cfg = await getConfig();
  const input = h('input', { class: 'input', name: 'input', placeholder: 'handle.bsky.social', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', required: true, 'aria-label': 'Handle, DID, or profile URL' });
  const media = h('input', { type: 'checkbox', name: 'media' });
  const analyze = h('input', { type: 'checkbox', name: 'analyze', checked: true });
  const tone = toneControls(cfg);
  const run = h('button', { class: 'cta', type: 'submit' }, h('span', {}, 'Slurp it'));
  const jobSlot = h('div');

  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      run.disabled = true;
      const panel = await jobPanel(
        { mode: 'archive', input: input.value, media: media.checked, analyze: analyze.checked, tone: tone.tone.checked, model: tone.model.value, toneLimit: Number(tone.limit.value) },
        (done, panel) => {
          run.disabled = false;
          panel.append(cell({}, h('a', { class: 'btn solid', href: `#/a/${done.handle}/${done.snapshot}/report` }, `Open ${done.handle}`)));
        },
      );
      jobSlot.replaceChildren(panel);
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  },
    grid('cols-side',
      cell({ class: 'stack-lg' }, h('h1', { class: 'display' }, 'Archive', h('br'), 'an account'), h('p', { class: 'muted' }, 'Every public record from every app on the atmosphere: posts, likes, reposts, follows, blocks, lists, and third-party apps too. Each interaction links straight to its source.')),
      cell({ class: 'stack-lg' },
        h('label', { class: 'field' }, h('span', { class: 'kicker' }, 'Handle, DID, or bsky.app profile URL'), input),
        h('div', { class: 'grid cols-2', style: 'background:none;gap:24px;border:0' },
          h('label', { class: 'check' }, media, h('span', {}, h('strong', {}, 'Media'), h('small', {}, 'Download images and video. Can be gigabytes.'))),
          h('label', { class: 'check' }, analyze, h('span', {}, h('strong', {}, 'Analyze'), h('small', {}, 'Behavior and interests report. Free, offline.'))),
        ),
        tone.el,
      ),
    ),
    grid('cols-1', cell({ class: 'flush' }, run)),
  );

  const recent = h('div');
  render(form, jobSlot, recent);
  input.focus({ preventScroll: true });

  const accounts = await api('/api/accounts').catch(() => []);
  if (accounts.length) {
    recent.replaceChildren(
      grid('cols-side', cell({}, h('h2', { class: 'title' }, 'On disk')), cell({ class: 'flush' }, accountGrid(accounts.slice(0, 6)))),
    );
  }
}

function accountGrid(accounts) {
  return grid('cols-2', accounts.map((a) => {
    const s = a.snapshots[0];
    return h('a', { class: 'cell account-card', href: `#/a/${a.handle}/${s.snapshot}/report` },
      a.avatar ? h('img', { class: 'avatar', src: a.avatar, alt: '', loading: 'lazy' }) : h('div', { class: 'avatar' }),
      h('div', {},
        h('div', { class: 'break', style: 'font-size:1.3rem;line-height:1.2' }, `@${a.handle}`),
        a.displayName && h('div', { class: 'break' }, a.displayName),
        h('div', { class: 'muted', style: 'font-size:.85rem' }, `${fmt(s.totalRecords)} records · ${a.snapshots.length} snapshot${a.snapshots.length === 1 ? '' : 's'} · ${day(s.fetchedAt)}`),
      ),
    );
  }));
}

// ---- accounts ----------------------------------------------------------------

async function accountsView() {
  setNav('accounts');
  const accounts = await api('/api/accounts');
  if (!accounts.length) {
    return render(grid('cols-1', cell({ class: 'empty' }, h('h1', { class: 'display' }, 'Nothing on disk'), h('a', { class: 'btn solid', href: '#/' }, 'Archive an account'))));
  }
  render(grid('cols-side', cell({ class: 'stack' }, h('h1', { class: 'display' }, 'Accounts'), h('p', { class: 'muted' }, `${accounts.length} archived`)), cell({ class: 'flush' }, accountGrid(accounts))));
}

// ---- account -------------------------------------------------------------------

async function accountView(handle, snapshot, tab = 'report', rest = [], query) {
  setNav('accounts');
  if (!snapshot) {
    const acc = (await api('/api/accounts')).find((a) => a.handle === handle);
    if (!acc) return render(grid('cols-1', cell({ class: 'empty' }, h('h1', { class: 'display' }, 'Not archived'), h('a', { class: 'btn solid', href: '#/' }, 'Archive it'))));
    location.replace(`#/a/${handle}/${acc.snapshots[0].snapshot}/report`);
    return;
  }
  const [snap, accounts, cfg] = await Promise.all([api(`/api/snapshot/${handle}/${snapshot}`), api('/api/accounts'), getConfig()]);
  const acc = accounts.find((a) => a.handle === handle);
  const { manifest: m, profile: p } = snap;
  const base = `#/a/${handle}/${snapshot}`;

  const snapPicker = h('select', { class: 'input small', 'aria-label': 'Snapshot', onchange: (e) => (location.hash = `#/a/${handle}/${e.target.value}/${tab}`) },
    acc.snapshots.map((s) => h('option', { value: s.snapshot, selected: s.snapshot === snapshot }, `${when(s.fetchedAt)} · ${fmt(s.totalRecords)}`)));

  const header = grid('cols-4 account-head',
    cell({ class: 'flush' }, p?.avatar ? h('img', { class: 'avatar lg', src: p.avatar, alt: '' }) : h('div', { class: 'avatar lg' })),
    cell({ class: 'span-2 stack' },
      h('p', { class: 'kicker' }, m.handleVerified ? 'Verified handle' : '⚠ Handle does not verify'),
      h('h1', { class: 'title break', style: 'text-transform:none' }, `@${m.handle ?? m.did}`),
      p?.displayName && h('p', { class: 'subtitle', style: 'text-transform:none' }, p.displayName),
      p?.description && h('p', { class: 'muted break', style: 'white-space:pre-wrap' }, p.description),
      h('p', { class: 'mono muted break' }, m.did),
      m.noUnauthenticated && h('p', { class: 'notice solid' }, 'This account asks apps not to show its posts to logged-out viewers.'),
    ),
    cell({ class: 'stack' },
      h('div', {}, h('p', { class: 'kicker' }, 'Records'), h('p', { class: 'big-number' }, fmt(m.totalRecords))),
      p && h('p', {}, `${fmt(p.followersCount)} followers · ${fmt(p.followsCount)} following`),
      h('label', { class: 'field' }, h('span', { class: 'kicker' }, 'Snapshot'), snapPicker),
      h('div', { class: 'btn-row' }, ext(m.profileUrl, 'Bluesky ↗'), ext(`https://pdsls.dev/at://${m.did}`, 'Repo ↗')),
    ),
  );

  const tabs = grid('cols-1', h('nav', { class: 'cell tabs', 'aria-label': 'Account sections' },
    ['report', 'records', 'identity'].map((t) => h('a', { href: `${base}/${t}`, 'aria-current': t === tab ? 'page' : null }, t))));

  const body = h('div');
  render(header, tabs, body);

  if (tab === 'records') body.replaceChildren(await recordsView(handle, snapshot, m, rest[0], query));
  else if (tab === 'identity') body.replaceChildren(await identityView(handle, snapshot, m));
  else body.replaceChildren(reportView(handle, snapshot, snap.analysis, cfg));
  hydrateHandles(body);
  hydrateEmbeds(body);
}

// ---- report ------------------------------------------------------------------------

function analysisActions(handle, snapshot, cfg, hasTone) {
  const tone = toneControls(cfg, { withToggle: false });
  const slot = h('div');
  const runJob = async (withTone) => {
    const panel = await jobPanel({ mode: 'analyze', input: handle, snapshot, tone: withTone, model: tone.model.value, toneLimit: Number(tone.limit.value) }, (_done, p) => {
      p.append(cell({}, h('button', { class: 'btn solid', type: 'button', onclick: () => route() }, 'Show the report')));
    });
    slot.replaceChildren(panel);
  };
  return h('div', {},
    grid('cols-side',
      cell({ class: 'stack' }, h('h2', { class: 'subtitle' }, hasTone ? 'Re-run' : 'Tone pass'), h('p', { class: 'muted' }, 'Structural analysis is free. The tone pass asks Claude to label replies and quotes, and only pays for posts it hasn’t labelled yet.')),
      cell({ class: 'stack' }, tone.el, h('div', { class: 'btn-row' },
        h('button', { class: 'btn solid', type: 'button', onclick: () => runJob(true) }, hasTone ? 'Update tone pass' : 'Run tone pass'),
        h('button', { class: 'btn', type: 'button', onclick: () => runJob(false) }, 'Re-run analysis only'))),
    ),
    slot,
  );
}

/** Only call a change a trend when it moves by 3+ points. */
const trend = (delta) => (delta >= 3 ? `rising, +${delta.toFixed(1)} pts` : delta <= -3 ? `falling, ${delta.toFixed(1)} pts` : 'about the same as all time');

function reportView(handle, snapshot, r, cfg) {
  if (!r) {
    const slot = h('div');
    const tone = toneControls(cfg);
    const run = h('button', { class: 'btn solid', type: 'button', onclick: async () => {
      run.disabled = true;
      slot.replaceChildren(await jobPanel(
        { mode: 'analyze', input: handle, snapshot, tone: tone.tone.checked, model: tone.model.value, toneLimit: Number(tone.limit.value) },
        () => route(),
      ));
    } }, 'Run analysis');
    return h('div', {},
      grid('cols-side',
        cell({ class: 'empty' }, h('h2', { class: 'display' }, 'No report yet'), h('p', { class: 'muted' }, 'The structural analysis is free and runs offline in about a second. Add a tone pass to have Claude label replies and quotes too.')),
        cell({ class: 'stack-lg' }, tone.el, h('div', { class: 'btn-row' }, run))),
      slot);
  }
  const s = r.shape;
  const a = s.allTime;
  const recent = s.last90Days;
  const person = (x, extra) => h('li', {},
    h('span', { class: 'who' }, ext(x.web, x.handle ? `@${x.handle}` : h('span', { 'data-did': x.did }, x.did)), !x.followed && h('span', { class: 'tag' }, 'not followed')),
    h('span', { class: 'count' }, extra ?? fmt(x.count)));
  const ranked = (items) => (items.length ? h('ol', { class: 'ranked' }, items.map((x) => person(x))) : h('p', { class: 'muted' }, 'None'));
  const section = (title, sub, ...content) => grid('cols-side', cell({ class: 'stack' }, h('h2', { class: 'title' }, title), sub && h('p', { class: 'muted' }, sub)), cell({ class: 'flush' }, ...content));
  const maxHour = Math.max(1, ...s.postsByHourUTC);

  const shapeRows = [
    ['Posts', a.posts, recent.posts],
    ['Original', a.original, recent.original],
    ['Self-threads', a.selfThreads, recent.selfThreads],
    ['Replies to others', `${fmt(a.repliesToOthers)} (${pct(a.pctRepliesToOthers)})`, `${fmt(recent.repliesToOthers)} (${pct(recent.pctRepliesToOthers)})`],
    ['Quotes', `${fmt(a.quotesOfOthers)} (${pct(a.pctQuotes)})`, `${fmt(recent.quotesOfOthers)} (${pct(recent.pctQuotes)})`],
    ['Aimed at non-followed', pct(a.pctOutwardToNonFollowed), pct(recent.pctOutwardToNonFollowed)],
    ['Cold (never liked either)', pct(a.pctOutwardToStrangers), pct(recent.pctOutwardToStrangers)],
  ];

  return h('div', {},
    grid('cols-4',
      cell({ class: 'stack' }, h('p', { class: 'kicker' }, 'Cold outreach, all time'), h('p', { class: 'big-number' }, pct(a.pctOutwardToStrangers)), h('p', { class: 'muted' }, 'of replies + quotes go to strangers')),
      cell({ class: 'stack' }, h('p', { class: 'kicker' }, 'Cold, last 90 days'), h('p', { class: 'big-number' }, pct(recent.pctOutwardToStrangers)), h('p', { class: 'muted' }, trend(recent.pctOutwardToStrangers - a.pctOutwardToStrangers))),
      cell({ class: 'stack' }, h('p', { class: 'kicker' }, 'Reply bursts'), h('p', { class: 'big-number' }, fmt(r.targeting.replyBurstsAtNonFollowed.length)), h('p', { class: 'muted' }, '5+ replies at one stranger in 24h')),
      cell({ class: 'stack' }, h('p', { class: 'kicker' }, 'Tone, cold vs warm'), h('p', { class: 'big-number' }, r.tone ? `${r.tone.cold.pctBadFaith}/${r.tone.warm.pctBadFaith}` : '—'), h('p', { class: 'muted' }, r.tone ? '% bad faith' : 'no tone pass yet')),
    ),
    grid('cols-1', cell({}, h('p', {}, h('strong', {}, 'Signals, not a verdict. '), 'A high and rising cold share, bursts at one person, and quotes of strangers are the classic bad-faith patterns. Open the linked posts before you conclude anything. Lots of blocks usually means block lists, not aggression.'))),

    section('Shape', `Snapshot ${day(r.account.snapshot)} · first post ${day(r.account.firstPost)}`,
      h('div', { class: 'grid cols-2' },
        cell({}, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}), h('th', { class: 'num' }, 'All time'), h('th', { class: 'num' }, 'Last 90 days'))),
          h('tbody', {}, shapeRows.map(([k, x, y]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, typeof x === 'number' ? fmt(x) : x), h('td', { class: 'num' }, typeof y === 'number' ? fmt(y) : y)))))),
        cell({ class: 'stack-lg' },
          h('div', { class: 'grid cols-2', style: 'background:none;gap:16px;border:0' },
            [['Likes', s.likes], ['Reposts', s.reposts], ['Follows', s.follows], ['Blocks', s.blocks], ['Likes per post', s.likesPerPost], ['Posts per active day', s.postsPerActiveDay]]
              .map(([k, v]) => h('div', {}, h('p', { class: 'kicker' }, k), h('p', { class: 'subtitle' }, fmt(v))))),
          h('div', {}, h('p', { class: 'kicker' }, 'Posts by hour (UTC)'),
            h('div', { class: 'hours', role: 'img', 'aria-label': `Posts by UTC hour, busiest at ${s.postsByHourUTC.indexOf(maxHour)}:00` }, s.postsByHourUTC.map((n, i) => h('i', { style: `height:${(n / maxHour) * 100}%`, title: `${i}:00 · ${n}` }))),
            h('div', { class: 'hours-axis' }, ['00', '06', '12', '18'].map((t) => h('span', {}, t)))),
        ),
      ),
    ),

    section('Targeting', 'Who they reply to and quote. “Not followed” is as of this snapshot.',
      h('div', { class: 'grid cols-2' },
        cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, 'Most replied to'), ranked(r.targeting.mostRepliedTo)),
        cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, 'Most quoted'), ranked(r.targeting.mostQuoted)),
        cell({ class: 'span-all stack' }, h('h3', { class: 'subtitle' }, 'Reply bursts at non-followed accounts'),
          r.targeting.replyBurstsAtNonFollowed.length
            ? h('ol', { class: 'ranked' }, r.targeting.replyBurstsAtNonFollowed.map((b) => h('li', {},
                h('span', { class: 'who' }, ext(b.web, b.handle ? `@${b.handle}` : h('span', { 'data-did': b.did }, b.did)), ` · ${b.day} · `, b.examples.map((u, i) => [ext(u, `[${i + 1}]`), ' '])),
                h('span', { class: 'count' }, fmt(b.count)))))
            : h('p', { class: 'muted' }, 'None')),
        cell({ class: 'span-all stack' }, h('h3', { class: 'subtitle' }, `Quotes of strangers: ${fmt(r.targeting.strangerQuotes.count)}`),
          r.targeting.strangerQuotes.examples.length > 0 && h('p', {}, 'Latest: ', r.targeting.strangerQuotes.examples.map((u, i) => [ext(u, `[${i + 1}]`), ' ']))),
      ),
    ),

    r.tone ? toneSection(r.tone, section) : null,
    analysisActions(handle, snapshot, cfg, !!r.tone),

    section('Interests', null,
      h('div', { class: 'grid cols-2' },
        cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, 'Hashtags'), h('div', { class: 'chips' }, r.interests.hashtags.length ? r.interests.hashtags.map((t) => h('span', { class: 'chip' }, `#${t.tag}`, h('b', {}, t.count))) : h('span', { class: 'muted' }, 'None'))),
        cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, 'Links to'), h('div', { class: 'chips' }, r.interests.linkDomains.map((d) => h('span', { class: 'chip' }, d.domain, h('b', {}, d.count))))),
        cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, 'Most liked'), ranked(r.interests.mostLiked)),
        cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, 'Most reposted'), ranked(r.interests.mostReposted)),
        cell({ class: 'span-all stack' }, h('h3', { class: 'subtitle' }, 'Apps on the atmosphere'), h('div', { class: 'chips' }, r.interests.appsUsed.map((x) => h('span', { class: 'chip' }, x.app, h('b', {}, fmt(x.records)))))),
        cell({ class: 'span-all' }, h('p', { class: 'muted' }, 'Languages: ', r.interests.languages.map((l) => `${l.lang} (${fmt(l.count)})`).join(', ') || 'none')),
      ),
    ),
  );
}

function toneSection(t, section) {
  const max = Math.max(1, ...LABELS.map((l) => Math.max(t.cold.counts[l] / (t.cold.total || 1), t.warm.counts[l] / (t.warm.total || 1))));
  const bar = (n, total, hatch) => h('div', { class: `bar ${hatch ? 'hatch' : ''}` }, h('i', { style: `width:${total ? ((n / total) / max) * 100 : 0}%` }));
  return section('Tone', `${fmt(t.labelled)} posts labelled by ${t.model}${t.refused ? `, ${t.refused} without a label` : ''}. Each label is a model’s reading of one post in context.`,
    h('div', { class: 'grid cols-1' },
      cell({}, h('p', { class: 'subtitle', style: 'text-transform:none' }, `${t.cold.pctBadFaith}% of cold replies/quotes read as bad faith, vs ${t.warm.pctBadFaith}% toward people they know.`),
        h('p', { class: 'muted', style: 'margin-top:8px' }, 'A big gap between the two is the tell. A high number on both is just how they talk.')),
      cell({}, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Label'), h('th', { class: 'num' }, `Cold (${t.cold.total})`), h('th', {}, ''), h('th', { class: 'num' }, `Warm (${t.warm.total})`), h('th', {}, ''))),
        h('tbody', {}, LABELS.map((l) => h('tr', {},
          h('td', {}, l, BAD_FAITH.has(l) && h('span', { class: 'tag solid' }, 'bad faith')),
          h('td', { class: 'num' }, t.cold.counts[l]), h('td', { style: 'width:28%' }, bar(t.cold.counts[l], t.cold.total, false)),
          h('td', { class: 'num' }, t.warm.counts[l]), h('td', { style: 'width:28%' }, bar(t.warm.counts[l], t.warm.total, true))))))),
      cell({ class: 'stack-lg' }, LABELS.filter((l) => t.examples[l]?.length).map((l) => h('div', { class: 'stack' },
        h('h3', { class: 'subtitle' }, l),
        h('ol', { class: 'ranked' }, t.examples[l].map((e) => h('li', {}, h('span', { class: 'who' }, ext(e.web, 'post ↗'), ` ${e.reason}`), h('span', { class: 'count muted' }, `${e.confidence}${e.cold ? ' · cold' : ''}`))))))),
    ),
  );
}

// ---- records ---------------------------------------------------------------------------

async function recordsView(handle, snapshot, m, collection, query) {
  const base = `#/a/${handle}/${snapshot}/records`;
  const cols = Object.entries(m.counts);
  collection ??= cols.find(([c]) => c === 'app.bsky.feed.post')?.[0] ?? cols[0]?.[0];
  const offset = Number(query.get('offset')) || 0;
  const order = query.get('order') === 'oldest' ? 'oldest' : 'newest';
  const limit = 50;

  // group collections by app namespace
  const groups = new Map();
  for (const [c, n] of cols) {
    const ns = c.split('.').slice(0, 2).reverse().join('.');
    groups.set(ns, [...(groups.get(ns) ?? []), [c, n]]);
  }
  const list = h('ul', { class: 'collections' }, [...groups].map(([ns, items]) => [
    h('li', { class: 'ns' }, ns),
    items.map(([c, n]) => h('li', {}, h('a', { href: `${base}/${c}`, 'aria-current': c === collection ? 'page' : null }, h('span', { class: 'break' }, c.split('.').slice(2).join('.')), h('span', {}, fmt(n))))),
  ]));

  const page = collection ? await api(`/api/snapshot/${handle}/${snapshot}/records/${collection}?offset=${offset}&limit=${limit}&order=${order}`) : { total: 0, records: [] };
  const link = (o, ord = order) => `${base}/${collection}?offset=${Math.max(0, o)}&order=${ord}`;
  const pager = h('div', { class: 'pager' },
    h('a', { class: 'btn', href: link(offset - limit), 'aria-disabled': offset === 0 ? 'true' : null, style: offset === 0 ? 'visibility:hidden' : null }, '← Prev'),
    h('span', { class: 'muted' }, `${fmt(offset + 1)}–${fmt(Math.min(offset + limit, page.total))} of ${fmt(page.total)} · `, h('a', { href: link(0, order === 'newest' ? 'oldest' : 'newest') }, order === 'newest' ? 'newest first' : 'oldest first')),
    h('a', { class: 'btn', href: link(offset + limit), style: offset + limit >= page.total ? 'visibility:hidden' : null }, 'Next →'),
  );

  return grid('cols-side',
    cell({ class: 'flush' }, h('div', { class: 'cell' }, h('h2', { class: 'subtitle' }, 'Collections'), h('p', { class: 'muted' }, `${cols.length} across ${groups.size} apps`)), list),
    cell({ class: 'flush' },
      h('div', { class: 'cell stack', style: 'border-bottom:1px solid var(--ink)' },
        h('h2', { class: 'subtitle break', style: 'text-transform:none' }, collection ?? 'No records'),
        collection === 'app.bsky.feed.post' && h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: prefs.showRoots, onchange: (e) => { prefs.showRoots = e.target.checked; route(); } }),
          h('span', {}, h('strong', {}, 'Show thread roots'), h('small', {}, 'Replies always show the post they answer. This adds the post that started the thread.'))),
        pager),
      page.records.map((rec) => recordCard(handle, rec)),
      page.records.length > 5 && h('div', { class: 'cell', style: 'border-top:1px solid var(--ink)' }, pager.cloneNode(true)),
    ),
  );
}

function recordCard(handle, rec) {
  const r = rec.record;
  const text = typeof r.text === 'string' ? r.text : typeof r.description === 'string' ? r.description : typeof r.displayName === 'string' ? r.displayName : null;
  const media = rec.refs.filter((x) => x.kind === 'blob');
  const pointers = rec.refs.filter((x) => x.kind !== 'blob');
  return h('article', { class: 'record' },
    h('div', { class: 'record-head' },
      h('span', {}, h('strong', {}, when(rec.createdAt)), h('span', { class: 'mono muted' }, `  ${rec.rkey}`)),
      h('span', { class: 'btn-row' }, ext(rec.web, 'Open ↗')),
    ),
    text && h('p', { class: 'record-text' }, text),
    pointers.length > 0 && h('ul', { class: 'refs' }, pointers.map((x) => h('li', {}, h('span', { class: 'role' }, x.role), h('span', {}, ext(x.web, refLabel(x)))))),
    embedTargets(pointers).map((x) => h('div', { class: 'embed-slot' },
      h('p', { class: 'kicker' }, EMBED_KICKER[x.role]),
      h('div', { class: 'embed pending', 'data-embed-uri': x.target }, h('span', { class: 'muted' }, 'Loading post…')))),
    media.length > 0 && h('div', { class: 'thumbs' }, media.map((x) => {
      const src = x.local ? `/blobs/${handle}/${x.local.split('/').pop()}` : x.web;
      if (x.mimeType?.startsWith('video/')) return x.local ? h('video', { src, controls: true, preload: 'metadata' }) : ext(x.web, h('span', { class: 'chip' }, 'video ↗'));
      if (x.mimeType?.startsWith('image/')) return ext(src, h('img', { src, alt: r.embed?.images?.find((i) => i.image?.ref?.$link === x.target)?.alt || '', loading: 'lazy' }));
      return ext(x.web, h('span', { class: 'chip' }, `${x.mimeType ?? 'blob'} ↗`));
    })),
    h('details', { class: 'raw' }, h('summary', {}, 'Record JSON'), h('pre', {}, JSON.stringify(rec, null, 2))),
  );
}

// ---- identity ------------------------------------------------------------------------------

async function identityView(handle, snapshot, m) {
  const id = await api(`/api/snapshot/${handle}/${snapshot}/identity`);
  const services = id.didDocument?.service ?? [];
  const rows = (pairs) => h('table', { class: 'data' }, h('tbody', {}, pairs.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', { style: 'width:30%' }, k), h('td', { class: 'break' }, v)))));
  return h('div', {},
    grid('cols-2',
      cell({ class: 'stack' }, h('h2', { class: 'title' }, 'Identity'), rows([
        ['DID', h('span', { class: 'mono' }, m.did)],
        ['Handle', `@${m.handle}`],
        ['Handle verifies', m.handleVerified ? 'Yes, both directions' : 'No'],
        ['PDS', ext(m.pds, m.pds)],
        ['Self-labels', m.selfLabels.length ? m.selfLabels.join(', ') : 'None'],
        m.did.startsWith('did:plc:') && ['PLC log', ext(`https://plc.directory/${m.did}/log/audit`, 'plc.directory ↗')],
      ])),
      cell({ class: 'stack' }, h('h2', { class: 'title' }, 'Handle history'),
        m.handleHistory?.length
          ? h('ol', { class: 'ranked' }, [...m.handleHistory].reverse().map((x) => h('li', {}, h('span', { class: 'who' }, `@${x.handle}`), h('span', { class: 'count muted' }, day(x.since)))))
          : h('p', { class: 'muted' }, 'Only available for did:plc accounts.')),
    ),
    grid('cols-2',
      cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, 'Services'), rows(services.map((s) => [s.id, `${s.type} · ${s.serviceEndpoint}`]))),
      cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, `PLC operations: ${fmt(id.plcAuditLog?.length ?? 0)}`),
        id.plcAuditLog && h('ol', { class: 'ranked' }, [...id.plcAuditLog].reverse().slice(0, 12).map((op) => h('li', {},
          h('span', { class: 'who' }, op.operation?.type ?? 'op', op.nullified && h('span', { class: 'tag' }, 'nullified')),
          h('span', { class: 'count muted' }, day(op.createdAt)))))),
    ),
  );
}

// ---- about --------------------------------------------------------------------------------

function aboutView() {
  setNav('about');
  const item = (title, body) => cell({ class: 'stack' }, h('h3', { class: 'subtitle' }, title), h('p', {}, body));
  render(
    grid('cols-side', cell({}, h('h1', { class: 'display' }, 'About')), cell({ class: 'stack' }, h('p', { class: 'subtitle', style: 'text-transform:none' }, 'Slurp downloads an account’s signed repo from its own PDS. That repo is every public record it has written, in every app on the atmosphere.'))),
    grid('cols-3',
      item('What’s archived', 'The raw repo (repo.car), every record decoded to JSON, the DID document, handle history, and the Bluesky profile view. Media is optional.'),
      item('What isn’t', 'DMs, mutes and private preferences, because they aren’t public. Also what other people did to them, since that lives in other people’s repos.'),
      item('Pointers', 'Every like, repost, reply, quote, follow, block and mention links to its target. The target’s CID pins the exact version, even if it’s later deleted.'),
      item('Analysis', 'Structural signals with receipts: cold outreach, reply bursts, stranger quotes, interests. Free and offline.'),
      item('Tone pass', 'Optional and paid. Claude labels replies and quotes in context. You see an exact input-token count and a cost range before anything is spent.'),
      item('Where it lives', 'Everything is written to ./archives on this machine. This server only listens on 127.0.0.1.'),
    ),
  );
}

// ---- router -------------------------------------------------------------------------------

async function route() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(qs ?? '');
  try {
    if (!parts.length) await homeView();
    else if (parts[0] === 'accounts') await accountsView();
    else if (parts[0] === 'about') aboutView();
    else if (parts[0] === 'a' && parts[1]) await accountView(parts[1], parts[2], parts[3], parts.slice(4), query);
    else await homeView();
  } catch (err) {
    render(grid('cols-1', cell({ class: 'empty' }, h('h1', { class: 'display' }, 'Something broke'), h('p', { class: 'mono' }, String(err.message ?? err)), h('a', { class: 'btn', href: '#/' }, 'Home'))));
  }
}

// ---- theme toggle -------------------------------------------------------------------------

const toggle = document.querySelector('.theme-toggle');
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const syncToggle = () => (toggle.querySelector('.theme-label').textContent = isDark() ? 'night' : 'day');
toggle.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('slurp-theme', next); } catch {}
  syncToggle();
});
syncToggle();

window.addEventListener('hashchange', () => {
  route();
  window.scrollTo(0, 0);
});
route();

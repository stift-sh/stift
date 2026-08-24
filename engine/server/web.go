package server

import "net/http"

func serveWebUI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(webUI))
}

// webUI mirrors the Stift Cloud dashboard shell and Sessions page (same
// tokens, type scale, radii, table and state components) so self-hosted and
// hosted users see one product. Kept dependency-free: vanilla HTML/CSS/JS.
const webUI = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stift</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Inter+Tight:wght@400&display=swap" rel="stylesheet">
<style>
  /* Editorial data observatory (design-monochrome). Paper-white canvas, ash
     surfaces, whisper-weight headings, one Ember Orange accent.
     Three-radius rhythm: 0px buttons, 6px 0 0 cards, 200px pills. No shadows. */
  :root {
    color-scheme: light;
    --color-graphite:#202020; --color-canvas-white:#ffffff; --color-ash:#efefef; --color-fog:#f5f5f5;
    --color-ivory:#ebe6dd; --color-steel:#4d4d4d; --color-slate:#828282; --color-mist:#e8e8e8;
    --color-ember-orange:#ff682c; --color-brass:#816729;
    --ink:var(--color-graphite); --ink-soft:var(--color-steel); --ink-faint:var(--color-slate);
    --canvas:var(--color-canvas-white); --surface:var(--color-ash); --surface-nested:var(--color-fog);
    --surface-warm:var(--color-ivory); --rule:var(--color-mist); --accent:var(--color-ember-orange);
    --accent-2:var(--color-brass); --accent-soft:rgba(255,104,44,0.12);
    --plate:#202020; --plate-text:#efefef; --plate-dim:#828282; --plate-accent:#ff682c;
    --font-polysans:"Inter Tight","Space Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --font-inter:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --radius-cards:8px; --radius-asym:6px 0 0; --radius-pill:200px; --radius-tags:20px;
    --page-max-width:1200px; --gap:20px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: var(--font-inter); font-size: 15px; line-height: 1.5; color: var(--ink);
         background-color: var(--canvas); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  ::selection { background: var(--accent); color: var(--canvas); }
  h1, h2, h3 { font-family: var(--font-polysans); font-weight: 400; letter-spacing: -0.02em; }
  a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--accent);
      text-decoration-thickness: 1px; text-underline-offset: 3px; }
  a:hover { color: var(--accent); }
  .mono { font-family: var(--mono); font-size: 0.9em; }
  .dim { color: var(--ink-faint); }
  .inline-code { font-family: var(--mono); font-size: 0.88em; background: var(--surface); padding: 1px 6px;
                 border-radius: 3px; white-space: nowrap; }

  /* App shell */
  .app { min-height: 100%; display: flex; flex-direction: column; }
  .topbar { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: 1fr auto 1fr;
            align-items: center; gap: var(--gap); padding: 16px 36px; background: var(--canvas); }
  .topbar-left { display: flex; align-items: center; gap: 16px; }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; font-family: var(--font-polysans);
           font-weight: 400; font-size: 18px; letter-spacing: -0.02em; color: var(--ink); }
  .brand:hover { color: var(--ink); }
  .brand-cloud { color: var(--ink-faint); }
  .nav { justify-self: center; display: flex; gap: 4px; padding: 6px; background: var(--surface); border-radius: var(--radius-pill); }
  .nav-link { text-decoration: none; color: var(--ink); font-family: var(--font-polysans); font-size: 15px; font-weight: 400;
              letter-spacing: -0.02em; line-height: 1; padding: 9px 16px; border-radius: var(--radius-pill);
              transition: background .12s, color .12s; }
  .nav-link:hover { background: var(--canvas); color: var(--ink); }
  .nav-link--active { background: var(--canvas); color: var(--ink); text-decoration: underline;
                      text-decoration-color: var(--accent); text-underline-offset: 4px; }
  .topbar-right { justify-self: end; display: flex; align-items: center; gap: 12px; }
  .main { flex: 1; width: 100%; max-width: var(--page-max-width); margin: 0 auto; padding: 60px 36px 140px; }

  /* Page header */
  .page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--gap); margin-bottom: 40px; }
  .page-title { margin: 0; font-family: var(--font-polysans); font-weight: 400; font-size: clamp(32px, 4vw, 40px);
                line-height: 1.2; letter-spacing: -0.02em; }
  .page-subtitle { margin: 8px 0 0; color: var(--ink-soft); font-size: 16px; line-height: 1.4; max-width: 60ch; }
  .page-actions { display: flex; gap: 12px; align-items: center; }

  /* Buttons */
  .btn { font-family: var(--font-polysans); font-size: 15px; font-weight: 400; letter-spacing: -0.02em; line-height: 1;
         padding: 10px 20px; border: 1px solid var(--ink); border-radius: 0; background: var(--canvas); color: var(--ink);
         cursor: pointer; transition: background .12s, border-color .12s, color .12s, opacity .12s; white-space: nowrap; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn--sm { padding: 6px 12px; font-size: 13px; }
  .btn--primary { background: var(--ink); color: var(--canvas); border-color: var(--ink); }
  .btn--primary:hover:not(:disabled) { background: var(--ink-soft); border-color: var(--ink-soft); }
  .btn--ghost { background: transparent; color: var(--ink); border-color: var(--ink); }
  .btn--ghost:hover:not(:disabled) { background: var(--ink); color: var(--canvas); }

  /* Inputs */
  .input { width: 100%; font-family: var(--font-inter); font-size: 15px; color: var(--ink); background: var(--canvas);
           border: 1px solid var(--rule); border-radius: 0; padding: 10px 14px; outline: none; transition: border-color .12s; }
  .input::placeholder { color: var(--ink-faint); }
  .input:focus { border-color: var(--ink); }
  .input--search { min-width: 300px; background: var(--surface-nested); border-color: transparent; }
  .input--search:focus { background: var(--canvas); border-color: var(--ink); }
  .input--token { width: 20rem; font-family: var(--mono); font-size: 13px; background: var(--surface-nested); border-color: transparent; }
  .input--token:focus { background: var(--canvas); border-color: var(--ink); }

  /* Table */
  .table-wrap { background: var(--canvas); overflow-x: auto; }
  .table { width: 100%; border-collapse: collapse; font-size: 15px; }
  .table thead th { text-align: left; font-family: var(--font-polysans); font-weight: 400; font-size: 13px;
                    letter-spacing: -0.02em; color: var(--ink-faint); padding: 12px 16px; border-bottom: 1px solid var(--rule); }
  .table tbody td { padding: 16px; border-bottom: 1px solid var(--rule); vertical-align: middle; color: var(--ink); }
  .table tbody tr:hover { background: var(--surface-nested); }
  .table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .table-empty { text-align: center; color: var(--ink-faint); padding: 40px 16px; }
  .ellipsis { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Badges */
  .badge { display: inline-block; font-family: var(--font-inter); font-size: 12px; font-weight: 500; line-height: 1;
           padding: 5px 10px; border-radius: var(--radius-tags); background: var(--surface); color: var(--ink-soft); }
  .badge--agent { background: var(--surface-warm); color: var(--accent-2); }

  /* States */
  .state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px;
           padding: 60px 40px; background: var(--surface); border-radius: var(--radius-asym); }
  .state--empty .empty-body { max-width: 520px; color: var(--ink-soft); text-align: left; }
  .state--empty .empty-body p { margin: 8px 0; }
  .state-title { font-family: var(--font-polysans); font-size: 18px; font-weight: 400; letter-spacing: -0.02em; margin: 0; }
  .state-detail { color: var(--ink-soft); font-size: 14px; margin: 0; }
  .state--loading { flex-direction: row; color: var(--ink-faint); padding: 36px; }
  .state--error { align-items: flex-start; text-align: left; background: var(--surface-warm); }
  .spinner { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--rule); border-top-color: var(--accent);
             animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* CopyField (graphite plate) */
  .copyfield { margin: 16px 0; border-radius: var(--radius-cards); overflow: hidden; background: var(--plate); }
  .copyfield-row { display: flex; align-items: stretch; overflow: hidden; }
  .copyfield-code { flex: 1; font-family: var(--mono); font-size: 13px; line-height: 1.7; padding: 10px 16px;
                    overflow-x: auto; white-space: nowrap; color: var(--plate-text); }
  .copyfield-prompt { color: var(--plate-accent); user-select: none; }
  .copyfield-btn { flex-shrink: 0; border: none; background: transparent; color: var(--plate-dim); font-family: var(--font-polysans);
                   font-size: 13px; letter-spacing: -0.02em; padding: 0 16px; cursor: pointer; transition: color .12s; }
  .copyfield-btn:hover { color: var(--plate-text); }

  [hidden] { display: none !important; }

  @media (max-width: 860px) {
    .topbar { grid-template-columns: 1fr auto; padding: 12px 20px; }
    .nav { grid-column: 1 / -1; justify-self: stretch; overflow-x: auto; }
    .main { padding: 36px 20px 80px; }
    .page-header { flex-direction: column; align-items: flex-start; }
    .input--search { min-width: 0; }
    .input--token { width: 12rem; }
  }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="topbar-left">
      <a class="brand" href="/" aria-label="Stift">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" fill="#202020" rx="6"/>
          <rect x="24" y="4" width="4" height="4" fill="#ff682c"/>
          <text x="16" y="23" font-family="'Inter Tight','Inter',sans-serif" font-size="20" font-weight="400" fill="#ffffff" text-anchor="middle">S</text>
        </svg>
        <span>stift<span class="brand-cloud">self-hosted</span></span>
      </a>
    </div>
    <nav class="nav">
      <a class="nav-link nav-link--active" href="/" aria-current="page">Sessions</a>
    </nav>
    <div class="topbar-right">
      <input id="token" class="input input--token" type="password" placeholder="Access token (stf_…)" aria-label="Access token" autocomplete="off">
      <button id="connect" class="btn btn--primary" type="button">Connect</button>
    </div>
  </header>

  <main class="main">
    <section>
      <div class="page-header">
        <div>
          <h1 class="page-title">Sessions</h1>
          <p class="page-subtitle">Coding-agent sessions synced to this server.</p>
        </div>
        <div class="page-actions" id="actions" hidden>
          <input id="q" class="input input--search" type="search" placeholder="Filter by agent, host, project…" aria-label="Filter sessions">
        </div>
      </div>

      <div id="loading" class="state state--loading" role="status" hidden>
        <div class="spinner" aria-hidden="true"></div><span>Loading…</span>
      </div>

      <div id="error" class="state state--error" role="alert" hidden>
        <p class="state-title">Something went wrong</p>
        <p class="state-detail" id="error-detail"></p>
        <button class="btn btn--ghost" type="button" onclick="load()">Try again</button>
      </div>

      <div id="need-token" class="state state--empty">
        <p class="state-title">Connect with an access token</p>
        <div class="empty-body">
          <p>Paste a token in the top-right field to browse stored sessions. It stays in this browser only.</p>
          <p class="dim">Create one on the server with <code class="inline-code">stift token create</code>.</p>
        </div>
      </div>

      <div id="empty" class="state state--empty" hidden>
        <p class="state-title">No sessions yet</p>
        <div class="empty-body">
          <p>Once you push from a coding agent, sessions show up here. Connect the CLI to this server:</p>
          <div class="copyfield"><div class="copyfield-row">
            <code class="copyfield-code" id="login-cmd"><span class="copyfield-prompt">$ </span><span id="login-cmd-text"></span></code>
            <button class="copyfield-btn" type="button" onclick="copyLogin(this)">Copy</button>
          </div></div>
          <p class="dim">Then push with <code class="inline-code">stift push</code>.</p>
        </div>
      </div>

      <div id="table-wrap" class="table-wrap" hidden>
        <table class="table">
          <thead><tr>
            <th>Agent</th><th>Host</th><th>Project</th><th>Title</th>
            <th class="num">Size</th><th class="num">Updated</th><th aria-label="Actions"></th>
          </tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </section>
  </main>
</div>

<script>
const $ = id => document.getElementById(id);
let sessions = [];

$('token').value = localStorage.getItem('stift_token') || '';
$('login-cmd-text').textContent = 'stift login ' + location.origin + ' --token <token>';

function formatBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / Math.pow(1024, i);
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
function formatRelative(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.round((Date.now() - then) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60); if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60); if (hr < 24) return hr + 'h ago';
  const day = Math.round(hr / 24); if (day < 30) return day + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function show(id) {
  for (const s of ['loading','error','need-token','empty','table-wrap']) $(s).hidden = s !== id;
  $('actions').hidden = id !== 'table-wrap';
}
function token() { return $('token').value.trim(); }

async function api(path) {
  const res = await fetch(path, { headers: { 'Authorization': 'Bearer ' + token() } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res;
}

async function load() {
  if (!token()) { show('need-token'); return; }
  localStorage.setItem('stift_token', token());
  show('loading');
  try {
    sessions = await (await api('/v1/sessions')).json();
    if (!sessions.length) { show('empty'); return; }
    render(); show('table-wrap');
  } catch (e) { $('error-detail').textContent = e.message; show('error'); }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  const rows = $('rows'); rows.innerHTML = '';
  const list = q ? sessions.filter(s => [s.agent, s.host, s.project, s.title].some(f => (f || '').toLowerCase().includes(q))) : sessions;
  for (const s of list) {
    const tr = document.createElement('tr');
    const agent = el('td'); agent.appendChild(el('span', 'badge badge--agent', s.agent)); tr.appendChild(agent);
    tr.appendChild(el('td', 'mono dim', s.host));
    tr.appendChild(el('td', 'mono', s.project || ''));
    const title = el('td', 'ellipsis'); title.title = s.title || '';
    if (s.title) title.textContent = s.title; else title.appendChild(el('span', 'dim', 'untitled'));
    tr.appendChild(title);
    tr.appendChild(el('td', 'num mono dim', formatBytes(s.size)));
    const upd = el('td', 'num dim', formatRelative(s.updated_at)); upd.title = s.updated_at; tr.appendChild(upd);
    const act = el('td', 'num');
    const btn = el('button', 'btn btn--ghost btn--sm', 'Download'); btn.type = 'button';
    btn.onclick = () => download(s, btn);
    act.appendChild(btn); tr.appendChild(act);
    rows.appendChild(tr);
  }
  if (!list.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'table-empty', 'No sessions match “' + $('q').value.trim() + '”.'); td.colSpan = 7;
    tr.appendChild(td); rows.appendChild(tr);
  }
}

async function download(s, btn) {
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const blob = await (await api('/v1/sessions/' + s.id + '/archive')).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = s.id + '.tar.gz';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) { $('error-detail').textContent = e.message; show('error'); }
  finally { btn.disabled = false; btn.textContent = 'Download'; }
}

async function copyLogin(btn) {
  try { await navigator.clipboard.writeText($('login-cmd-text').textContent); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

$('connect').addEventListener('click', load);
$('token').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
$('q').addEventListener('input', render);
if (token()) load();
</script>
</body>
</html>
`

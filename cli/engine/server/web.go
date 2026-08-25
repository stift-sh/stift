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
  .badge--admin { background: var(--accent-soft); color: var(--accent); }

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

  /* Skills */
  .scope-rail { display: inline-flex; gap: 4px; padding: 6px; margin: 0 0 24px; background: var(--surface); border-radius: var(--radius-pill); }
  .scope-link { font-family: var(--font-polysans); font-size: 15px; font-weight: 400; letter-spacing: -0.02em; line-height: 1;
                color: var(--ink-soft); padding: 9px 16px; border-radius: var(--radius-pill); background: none; border: 0; cursor: pointer; }
  .scope-link:hover, .scope-link--active { background: var(--canvas); color: var(--ink); }
  .scope-count { color: var(--ink-faint); margin-left: 6px; }
  .table-name { color: var(--ink); text-decoration: none; font-weight: 500; }
  .table-name:hover { color: var(--accent); }
  .table-desc { color: var(--ink-faint); font-size: 12.5px; margin-top: 2px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card { background: var(--surface); border: none; border-radius: var(--radius-asym); padding: 40px; }
  .card-eyebrow { display: block; font-family: var(--font-polysans); font-size: 13px; letter-spacing: -0.02em; color: var(--accent-2); margin-bottom: 20px; }
  .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--gap); align-items: start; }
  .detail-grid > * { min-width: 0; }
  .plate-head { display: flex; align-items: center; justify-content: space-between; background: var(--plate); color: var(--plate-dim);
                border-radius: var(--radius-cards) var(--radius-cards) 0 0; padding: 10px 16px 0; font-size: 12px; font-weight: 500; }
  .plate { margin: 0; background: var(--plate); color: var(--plate-text); border-radius: 0 0 var(--radius-cards) var(--radius-cards);
           font-family: var(--mono); font-size: 13px; line-height: 1.7; padding: 12px 16px 16px; white-space: pre; overflow: auto; max-height: 70vh; }
  .editor { width: 100%; min-height: 420px; height: 70vh; resize: vertical; display: block; margin: 0; border: none; border-radius: var(--radius-cards);
            background: var(--plate); color: var(--plate-text); font-family: var(--mono); font-size: 13px; line-height: 1.7; padding: 16px; outline: none; white-space: pre; }
  .editor:focus { outline: 1px solid var(--accent); outline-offset: 2px; }
  .editor-bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 16px; }
  .editor-note { font-size: 14px; color: var(--ink-faint); }
  .warning-banner { background: var(--surface-warm); border-radius: var(--radius-asym); color: var(--ink); padding: 12px 16px; font-size: 14px; margin: 24px 0 0; }
  .warning-banner--top { margin: 0 0 20px; }
  .warning-banner .btn--sm { vertical-align: baseline; }
  .copyfield-label { padding: 8px 16px 0; font-size: 12px; font-weight: 500; color: var(--plate-dim); }
  .crumbs { margin: 0 0 8px; }
  .crumbs a { text-decoration-color: var(--accent); }
  .side { display: flex; flex-direction: column; gap: var(--gap); }
  .warning-banner strong { font-weight: 500; color: var(--accent); }
  .plate .fm { color: var(--plate-dim); }
  .plate .fm-key { color: #c9a961; }
  .plate .h { color: var(--plate-accent); }
  .kv { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; font-size: 14px; }
  .kv dt { font-size: 13px; color: var(--ink-faint); }
  .kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .hist { list-style: none; margin: 0; padding: 0; }
  .hist li { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--rule); font-size: 14px; align-items: baseline; }
  .hist li:last-child { border-bottom: none; }
  .hist .v { font-weight: 500; }
  .hist .v--head { color: var(--accent); }
  .hist .who { color: var(--ink-faint); }
  .foot-note { margin: 20px 0 0; font-size: 13px; }
  @media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }
  @media (max-width: 860px) { .card { padding: 24px; } }

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
      <a class="nav-link" id="nav-sessions" href="#/">Sessions</a>
      <a class="nav-link" id="nav-skills" href="#/skills">Skills</a>
    </nav>
    <div class="topbar-right">
      <input id="token" class="input input--token" type="password" placeholder="Access token (stf_…)" aria-label="Access token" autocomplete="off">
      <button id="connect" class="btn btn--primary" type="button">Connect</button>
    </div>
  </header>

  <main class="main">
    <section id="page-sessions">
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
    <section id="page-skills" hidden>
      <div class="page-header" id="sk-header">
        <div>
          <h1 class="page-title">Skills</h1>
          <p class="page-subtitle">Skills, agents, commands and CLAUDE.md synced to this server — by scope.</p>
        </div>
        <div class="page-actions" id="sk-actions" hidden>
          <input id="sk-q" class="input input--search" type="search" placeholder="Filter by name, agent, project…" aria-label="Filter skills">
        </div>
      </div>

      <div id="sk-loading" class="state state--loading" role="status" hidden>
        <div class="spinner" aria-hidden="true"></div><span>Loading…</span>
      </div>
      <div id="sk-error" class="state state--error" role="alert" hidden>
        <p class="state-title">Something went wrong</p>
        <p class="state-detail" id="sk-error-detail"></p>
        <button class="btn btn--ghost" type="button" onclick="loadSkills()">Try again</button>
      </div>
      <div id="sk-need-token" class="state state--empty" hidden>
        <p class="state-title">Connect with an access token</p>
        <div class="empty-body"><p>Paste a token in the top-right field to browse synced skills.</p></div>
      </div>
      <div id="sk-empty" class="state state--empty" hidden>
        <p class="state-title">No skills yet</p>
        <div class="empty-body">
          <p>Push your Claude Code skills, agents, commands and CLAUDE.md from any machine:</p>
          <div class="copyfield"><div class="copyfield-row">
            <code class="copyfield-code"><span class="copyfield-prompt">$ </span><span id="sk-push-cmd">stift push --skills</span></code>
            <button class="copyfield-btn" type="button" onclick="copyText(this, 'sk-push-cmd')">Copy</button>
          </div></div>
          <p class="dim">Admins can share a set with the whole org using <code class="inline-code">--scope org</code>. Settings and MCP config are never synced.</p>
        </div>
      </div>

      <div id="sk-list" hidden>
        <div class="scope-rail" role="tablist" id="sk-scopes"></div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>Skill</th><th>Scope</th><th>Agent</th><th>Project</th><th class="num">Version</th><th>Updated</th>
            </tr></thead>
            <tbody id="sk-rows"></tbody>
          </table>
        </div>
        <p class="dim foot-note">Org skills are pushed by admins and pulled by every member with <code class="inline-code">stift pull --skills</code>.</p>
      </div>

      <div id="sk-detail" hidden>
        <div class="page-header">
          <div>
            <p class="page-subtitle crumbs" id="sk-d-crumbs"></p>
            <h1 class="page-title" id="sk-d-title"></h1>
            <p class="page-subtitle" id="sk-d-sub" hidden></p>
          </div>
          <div class="page-actions">
            <button class="btn btn--ghost" id="sk-d-rollback" type="button" hidden></button>
            <button class="btn btn--ghost" id="sk-d-delete" type="button">Delete</button>
            <a id="sk-d-edit" class="btn btn--primary" hidden></a>
          </div>
        </div>
        <div class="warning-banner warning-banner--top" id="sk-d-banner" hidden></div>
        <div class="detail-grid">
          <div>
            <div id="sk-d-plate-wrap">
              <div class="plate-head"><span id="sk-d-plate-name"></span><span id="sk-d-plate-ver"></span></div>
              <pre class="plate" id="sk-d-plate"></pre>
            </div>
            <table class="table" id="sk-d-files-table">
              <thead><tr><th>File</th><th class="num">Size</th><th class="num">Mode</th></tr></thead>
              <tbody id="sk-d-files"></tbody>
            </table>
          </div>
          <aside class="side">
            <div class="card">
              <span class="card-eyebrow">Bundle</span>
              <dl class="kv" id="sk-d-kv"></dl>
            </div>
            <div class="card">
              <span class="card-eyebrow">History</span>
              <ul class="hist" id="sk-d-hist"></ul>
            </div>
            <div class="copyfield" style="margin:0">
              <div class="copyfield-label">Pull on a machine</div>
              <div class="copyfield-row">
                <code class="copyfield-code"><span class="copyfield-prompt">$ </span><span id="sk-d-pull"></span></code>
                <button class="copyfield-btn" type="button" onclick="copyText(this, 'sk-d-pull')">Copy</button>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <div id="sk-edit" hidden>
        <div class="page-header">
          <div>
            <p class="page-subtitle crumbs" id="sk-e-crumbs"></p>
            <h1 class="page-title" id="sk-e-title"></h1>
            <p class="page-subtitle" id="sk-e-sub"></p>
          </div>
        </div>
        <div class="plate-head"><span id="sk-e-plate-name"></span><span>markdown</span></div>
        <textarea class="editor" id="sk-e-text" spellcheck="false" style="border-radius:0 0 var(--radius-cards) var(--radius-cards)"></textarea>
        <div class="editor-bar">
          <span class="editor-note">Only <code class="inline-code">*.md</code> files are editable here. Scripts and other files change via <code class="inline-code">stift push --skills</code>.</span>
          <div class="page-actions">
            <a class="btn btn--ghost" id="sk-e-cancel" href="#/skills">Cancel</a>
            <button class="btn btn--primary" id="sk-e-save" type="button" disabled>Save</button>
          </div>
        </div>
        <div class="warning-banner" id="sk-e-stale" hidden></div>
        <div class="warning-banner" id="sk-e-error" hidden></div>
        <div class="warning-banner" id="sk-e-info" hidden></div>
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

/* ---- Skills ---- */
let bundles = null, skScope = 'all';
const SCOPES = [['All','all'],['Org','org'],['User','user'],['Project','project']];

function basename(p) { const parts = (p || '').split('/').filter(Boolean); return parts[parts.length - 1] || p; }
function skillHref(b, edit) {
  const name = b.name.split('/').map(encodeURIComponent).join('/');
  const q = b.project ? '?project=' + encodeURIComponent(b.project) : '';
  return (edit ? '#/skills/edit/' : '#/skills/') + encodeURIComponent(b.scope) + '/' + encodeURIComponent(b.agent) + '/' + name + q;
}
function bundlePath(k) {
  const name = k.name.split('/').map(encodeURIComponent).join('/');
  return '/v1/bundles/' + encodeURIComponent(k.scope) + '/' + encodeURIComponent(k.agent) + '/' + name;
}
function withProject(path, k, extra) {
  const p = new URLSearchParams(extra || {});
  if (k.project) p.set('project', k.project);
  const qs = p.toString();
  return qs ? path + '?' + qs : path;
}
function skShow(id) {
  for (const s of ['sk-loading','sk-error','sk-need-token','sk-empty','sk-list','sk-detail','sk-edit']) $(s).hidden = s !== id;
  $('sk-actions').hidden = id !== 'sk-list';
  $('sk-header').hidden = id === 'sk-detail' || id === 'sk-edit';
}

async function loadSkills() {
  if (!token()) { skShow('sk-need-token'); return; }
  localStorage.setItem('stift_token', token());
  skShow('sk-loading');
  try {
    bundles = await (await api('/v1/bundles')).json();
    if (!bundles.length) { skShow('sk-empty'); return; }
    renderSkills(); skShow('sk-list');
  } catch (e) { $('sk-error-detail').textContent = e.message; skShow('sk-error'); }
}

function renderSkills() {
  const counts = { all: bundles.length, org: 0, user: 0, project: 0 };
  for (const b of bundles) if (b.scope in counts) counts[b.scope]++;
  const rail = $('sk-scopes'); rail.innerHTML = '';
  for (const [label, key] of SCOPES) {
    const btn = el('button', 'scope-link' + (skScope === key ? ' scope-link--active' : ''), label);
    btn.type = 'button'; btn.setAttribute('role', 'tab'); btn.setAttribute('aria-selected', skScope === key);
    btn.appendChild(el('span', 'scope-count', counts[key]));
    btn.onclick = () => { skScope = key; renderSkills(); };
    rail.appendChild(btn);
  }
  const q = $('sk-q').value.trim().toLowerCase();
  let list = skScope === 'all' ? bundles : bundles.filter(b => b.scope === skScope);
  if (q) list = list.filter(b => [b.name, b.agent, b.project, b.author, ...(b.skills || []).map(k => k.name + ' ' + k.description)]
                              .some(f => (f || '').toLowerCase().includes(q)));
  const rows = $('sk-rows'); rows.innerHTML = '';
  for (const b of list) {
    const tr = document.createElement('tr');
    const name = el('td');
    const a = el('a', 'table-name', basename(b.name)); a.href = skillHref(b); name.appendChild(a);
    const desc = (b.skills && b.skills[0] && b.skills[0].description) || (b.name === 'CLAUDE.md' ? 'Global instructions' : '');
    if (desc) { const d = el('div', 'table-desc', desc); d.title = desc; name.appendChild(d); }
    tr.appendChild(name);
    const sc = el('td'); sc.appendChild(el('span', b.scope === 'org' ? 'badge badge--admin' : 'badge', b.scope)); tr.appendChild(sc);
    const ag = el('td'); ag.appendChild(el('span', 'badge badge--agent', b.agent)); tr.appendChild(ag);
    const pr = el('td', 'mono dim', b.project ? basename(b.project) : '—'); pr.title = b.project || ''; tr.appendChild(pr);
    tr.appendChild(el('td', 'num mono', 'v' + b.version));
    const upd = el('td', 'dim', (b.author || '?') + ' · ' + formatRelative(b.created)); upd.title = b.created; tr.appendChild(upd);
    rows.appendChild(tr);
  }
  if (!list.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'table-empty', 'No skills match ' + (q ? '“' + $('sk-q').value.trim() + '”' : 'the ' + skScope + ' scope') + '.'); td.colSpan = 6;
    tr.appendChild(td); rows.appendChild(tr);
  }
}

function primaryMarkdown(files) {
  return files.find(f => f.path === 'SKILL.md') || files.find(f => /\.(md|markdown)$/i.test(f.path));
}
function highlight(text) {
  const pre = $('sk-d-plate'); pre.innerHTML = '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let inFront = false, fences = 0;
  lines.forEach((line, i) => {
    let node;
    if (line === '---' && fences < 2 && (i === 0 || inFront)) { inFront = !inFront; fences++; node = el('span', 'fm', line); }
    else if (inFront) {
      const m = line.match(/^([A-Za-z0-9_-]+:)(.*)$/);
      if (m) { node = document.createDocumentFragment(); node.appendChild(el('span', 'fm-key', m[1])); node.appendChild(document.createTextNode(m[2])); }
      else node = document.createTextNode(line);
    }
    else if (/^#{1,6}\s/.test(line)) node = el('span', 'h', line);
    else node = document.createTextNode(line);
    pre.appendChild(node); if (i < lines.length - 1) pre.appendChild(document.createTextNode('\n'));
  });
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function crumbs(elId, k, extra) {
  const c = $(elId); c.innerHTML = '';
  const a = el('a', null, 'Skills'); a.href = '#/skills'; c.appendChild(a);
  const dir = k.name.split('/').slice(0, -1).join('/');
  c.appendChild(document.createTextNode(' / ' + k.scope + ' / ' + k.agent + (dir ? ' / ' + dir : '') + (extra ? ' / ' : '')));
  if (extra) { const b = el('a', null, extra); b.href = skillHref(k); c.appendChild(b); }
}
function banner(id, html) { const b = $(id); b.hidden = !html; b.innerHTML = html || ''; }
function modeString(m) { return (m & 0o111) ? '755' : '644'; }
function pullCmd(scope) { return scope === 'org' ? 'stift pull --skills --scope org' : 'stift pull --skills'; }
function apiErr(res, fallback) { return res.json().catch(() => ({})).then(b => new Error(b.error || fallback || res.statusText)); }

let detail = null; // { k, b, history, previous }
async function loadSkillDetail(k) {
  skShow('sk-loading'); detail = null; banner('sk-d-banner', '');
  try {
    const [b, hist] = await Promise.all([
      api(withProject(bundlePath(k), k)).then(r => r.json()),
      api(withProject(bundlePath(k), k, { history: '1' })).then(r => r.json()),
    ]);
    const head = b.version;
    const previous = hist.find(h => h.version < head);
    detail = { k, b, history: hist, previous };
    crumbs('sk-d-crumbs', k);
    $('sk-d-title').textContent = basename(b.name);
    const meta = (b.skills && b.skills[0]) || {};
    $('sk-d-sub').hidden = !meta.description; $('sk-d-sub').textContent = meta.description || '';

    const md = primaryMarkdown(b.files || []);
    $('sk-d-plate-wrap').hidden = !md; $('sk-d-files-table').style.marginTop = md ? '1.5rem' : '0';
    $('sk-d-edit').hidden = !md;
    if (md) {
      $('sk-d-edit').href = skillHref(k, true); $('sk-d-edit').textContent = 'Edit ' + basename(md.path);
      $('sk-d-plate-name').textContent = md.path; $('sk-d-plate-ver').textContent = 'v' + b.version;
      highlight(await (await api('/v1/blobs/' + md.sha256)).text());
    }
    const rb = $('sk-d-rollback'); rb.hidden = !previous;
    if (previous) rb.textContent = 'Rollback to v' + previous.version;
    $('sk-d-delete').textContent = 'Delete';

    const files = $('sk-d-files'); files.innerHTML = '';
    for (const f of b.files || []) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', 'mono', f.path));
      tr.appendChild(el('td', 'num mono dim', formatBytes(f.size)));
      tr.appendChild(el('td', 'num mono dim', modeString(f.mode)));
      files.appendChild(tr);
    }

    const kv = $('sk-d-kv'); kv.innerHTML = '';
    const n = (b.files || []).length, size = (b.files || []).reduce((t, f) => t + f.size, 0);
    const row = (key, node) => { kv.appendChild(el('dt', null, key)); const dd = el('dd'); dd.appendChild(node); kv.appendChild(dd); };
    row('Scope', el('span', b.scope === 'org' ? 'badge badge--admin' : 'badge', b.scope));
    row('Agent', el('span', 'badge badge--agent', b.agent));
    if (b.project) { const pr = el('span', 'mono ellipsis', b.project); pr.title = b.project; pr.style.display = 'block'; row('Project', pr); }
    row('Head', document.createTextNode('v' + head + ' · ' + n + ' file' + (n === 1 ? '' : 's') + ' · ' + formatBytes(size)));
    row('Author', el('span', 'mono', (b.author || '?') + ' · ' + (b.host || '?')));

    const hl = $('sk-d-hist'); hl.innerHTML = '';
    for (const h of hist) {
      const li = document.createElement('li');
      li.appendChild(el('span', 'v' + (h.version === head ? ' v--head' : ''), 'v' + h.version));
      li.appendChild(el('span', 'who', (h.author || '?') + ' · ' + (h.host || '?')));
      const t = el('span', 'dim', formatRelative(h.created)); t.title = h.created; li.appendChild(t);
      hl.appendChild(li);
    }
    $('sk-d-pull').textContent = pullCmd(b.scope);
    skShow('sk-detail');
  } catch (e) {
    $('sk-error-detail').textContent = /404|no such bundle/i.test(e.message) ? 'This skill no longer exists on the server.' : e.message;
    skShow('sk-error');
  }
}

function setBusy(which) {
  const rb = $('sk-d-rollback'), del = $('sk-d-delete'), ed = $('sk-d-edit');
  for (const b of [rb, del]) b.disabled = !!which;
  ed.style.pointerEvents = which ? 'none' : ''; ed.style.opacity = which ? '.5' : '';
  if (which === 'rollback') rb.textContent = '…';
  if (which === 'delete') del.textContent = '…';
}
async function rollbackSkill() {
  if (!detail || !detail.previous) return;
  const { k, b, previous } = detail, head = b.version;
  if (!confirm('Republish v' + previous.version + ' as v' + (head + 1) + '? The current v' + head + ' stays in history.')) return;
  setBusy('rollback'); banner('sk-d-banner', '');
  try {
    const res = await fetch(withProject(bundlePath(k), k), { method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: head, host: 'web', files: previous.files }) });
    if (!res.ok) throw await apiErr(res);
    loadSkillDetail(k);
  } catch (e) { banner('sk-d-banner', '<strong>That didn’t work.</strong> ' + esc(e.message)); setBusy(null); $('sk-d-rollback').textContent = 'Rollback to v' + previous.version; }
}
async function deleteSkill() {
  if (!detail) return;
  const { k, b } = detail, head = b.version;
  if (!confirm('Delete ' + basename(k.name) + ' and all ' + head + ' version' + (head === 1 ? '' : 's') + ' from the server? Members keep their local copies.')) return;
  setBusy('delete'); banner('sk-d-banner', '');
  try {
    const res = await fetch(withProject(bundlePath(k), k), { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token() } });
    if (!res.ok) throw await apiErr(res);
    location.hash = '#/skills';
  } catch (e) { banner('sk-d-banner', '<strong>That didn’t work.</strong> ' + esc(e.message)); setBusy(null); $('sk-d-delete').textContent = 'Delete'; }
}
$('sk-d-rollback').addEventListener('click', rollbackSkill);
$('sk-d-delete').addEventListener('click', deleteSkill);

async function copyText(btn, id) {
  try { await navigator.clipboard.writeText($(id).textContent); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
}

/* ---- Edit ---- */
let edit = null; // { k, b, md, base, original, stale }
async function sha256Hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function editDirty() { return edit && $('sk-e-text').value !== edit.original; }
function updateSaveBtn(saving) {
  const btn = $('sk-e-save');
  btn.disabled = saving || !edit || !editDirty() || edit.stale !== null;
  btn.textContent = saving ? 'Saving…' : (edit ? 'Save as v' + (edit.base + 1) : 'Save');
  $('sk-e-text').disabled = !!saving;
}
function editBanners() {
  const e = edit;
  banner('sk-e-stale', e && e.stale !== null ? '<strong>Someone published first.</strong> The server is now at v' + esc(e.stale) + ', but your edit is based on v' + e.base +
    '. Copy your changes, then <button type="button" class="btn btn--ghost btn--sm" onclick="loadSkillEdit(edit.k)">reload v' + esc(e.stale) + '</button> and re-apply them.' : '');
  banner('sk-e-error', e && e.saveError ? '<strong>Save failed.</strong> ' + esc(e.saveError) : '');
  banner('sk-e-info', e && e.stale === null && !e.saveError ? '<strong>Heads up.</strong> ' + esc(e.b.author || 'someone') + ' pushed v' + e.b.version + ' from ' + esc(e.b.host || 'a machine') + ' ' +
    formatRelative(e.b.created) + '. If anyone pushes again before you save, you’ll be asked to reload and re-apply your edit.' : '');
}

async function loadSkillEdit(k) {
  skShow('sk-loading'); edit = null;
  try {
    const b = await api(withProject(bundlePath(k), k)).then(r => r.json());
    const md = primaryMarkdown(b.files || []);
    if (!md) throw new Error('No markdown file in this bundle to edit.');
    const text = await (await api('/v1/blobs/' + md.sha256)).text();
    edit = { k, b, md, base: b.version, original: text, stale: null, saveError: null };
    crumbs('sk-e-crumbs', k, basename(k.name));
    $('sk-e-title').textContent = 'Edit ' + basename(md.path);
    $('sk-e-sub').innerHTML = 'Saving writes v' + (b.version + 1) + ' on top of v' + b.version + '. Members pick it up on their next <code class="inline-code">stift pull --skills</code>.';
    $('sk-e-plate-name').textContent = md.path + ' · editing from v' + b.version;
    $('sk-e-cancel').href = skillHref(k);
    $('sk-e-text').value = text; $('sk-e-text').setAttribute('aria-label', md.path + ' source');
    editBanners(); updateSaveBtn(false); skShow('sk-edit');
  } catch (e) {
    $('sk-error-detail').textContent = /404|no such bundle/i.test(e.message) ? 'This skill no longer exists on the server.' : e.message;
    skShow('sk-error');
  }
}

async function saveEdit() {
  if (!edit || !editDirty() || edit.stale !== null) return;
  updateSaveBtn(true); edit.saveError = null;
  try {
    const bytes = new TextEncoder().encode($('sk-e-text').value);
    const sha = await sha256Hex(bytes);
    const hdr = { 'Authorization': 'Bearer ' + token() };
    const put = await fetch('/v1/blobs/' + sha, { method: 'PUT', headers: { ...hdr, 'Content-Type': 'application/octet-stream' }, body: bytes });
    if (!put.ok) throw await apiErr(put);
    const files = edit.b.files.map(f => f.path === edit.md.path ? { ...f, sha256: sha, size: bytes.length } : f);
    const res = await fetch(withProject(bundlePath(edit.k), edit.k), { method: 'PUT', headers: { ...hdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: edit.base, host: 'web', files }) });
    if (res.status === 409) {
      const m = ((await res.json().catch(() => ({}))).error || '').match(/version (\d+)/);
      edit.stale = m ? m[1] : 'latest';
    } else if (res.status === 403) {
      edit.saveError = 'Only org admins can publish org-scoped skills.';
    } else if (!res.ok) {
      throw await apiErr(res);
    } else { location.hash = skillHref(edit.k); return; }
  } catch (e) { edit.saveError = e.message; }
  editBanners(); updateSaveBtn(false);
}
$('sk-e-text').addEventListener('input', () => updateSaveBtn(false));
$('sk-e-save').addEventListener('click', saveEdit);
$('sk-e-text').addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveEdit(); } });

/* ---- Routing ---- */
function route() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.slice(1).split('?');
  const isSkills = path.startsWith('/skills');
  $('page-sessions').hidden = isSkills; $('page-skills').hidden = !isSkills;
  $('nav-sessions').classList.toggle('nav-link--active', !isSkills);
  $('nav-skills').classList.toggle('nav-link--active', isSkills);
  if (!isSkills) { if (token()) load(); else show('need-token'); return; }
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent); // ['skills', ('edit',) scope, agent, ...name]
  const isEdit = seg[1] === 'edit'; if (isEdit) seg.splice(1, 1);
  if (seg.length >= 4) {
    if (!token()) { skShow('sk-need-token'); return; }
    const k = { scope: seg[1], agent: seg[2], name: seg.slice(3).join('/'), project: new URLSearchParams(qs || '').get('project') || '' };
    if (isEdit) loadSkillEdit(k); else loadSkillDetail(k);
  } else loadSkills();
}

$('connect').addEventListener('click', route);
$('token').addEventListener('keydown', e => { if (e.key === 'Enter') route(); });
$('q').addEventListener('input', render);
$('sk-q').addEventListener('input', () => bundles && renderSkills());
window.addEventListener('hashchange', route);
route();
</script>
</body>
</html>
`

package server

import "net/http"

func serveWebUI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(webUI))
}

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
  /* Monochrome editorial: white canvas, ash surfaces, graphite type,
     one ember accent. 0px buttons, 6px 0 0 cards, 200px pills. No shadows. */
  :root { color-scheme: light;
    --ink:#202020; --steel:#4d4d4d; --slate:#828282; --mist:#e8e8e8;
    --ash:#efefef; --fog:#f5f5f5; --ivory:#ebe6dd; --ember:#ff682c; --brass:#816729;
    --display:"Inter Tight","Space Grotesk",ui-sans-serif,system-ui,sans-serif;
    --body:"Inter",ui-sans-serif,system-ui,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  * { box-sizing: border-box; }
  body { font-family: var(--body); font-size: 15px; line-height: 1.5; background: #fff; color: var(--ink);
         margin: 0 auto; max-width: 1200px; padding: 60px 36px 140px; -webkit-font-smoothing: antialiased; }
  ::selection { background: var(--ember); color: #fff; }
  h1 { font-family: var(--display); font-weight: 400; font-size: 40px; line-height: 1.2;
       letter-spacing: -0.02em; margin: 0 0 8px; }
  h1 span { color: var(--slate); }
  .muted { color: var(--steel); font-size: 16px; margin: 0 0 36px; max-width: 60ch; }
  .bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  input { font-family: var(--body); font-size: 15px; color: var(--ink); background: var(--fog);
          border: 1px solid transparent; border-radius: 0; padding: 10px 14px; outline: none; }
  input::placeholder { color: var(--slate); }
  input:focus { background: #fff; border-color: var(--ink); }
  #token { width: 28rem; max-width: 60vw; font-family: var(--mono); font-size: 13px; }
  button { font-family: var(--display); font-size: 15px; font-weight: 400; letter-spacing: -0.02em; line-height: 1;
           background: var(--ink); color: #fff; border: 1px solid var(--ink); border-radius: 0;
           padding: 10px 20px; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }
  button:hover { background: var(--steel); border-color: var(--steel); }
  td button { background: transparent; color: var(--ink); border-color: var(--slate); padding: 6px 12px; font-size: 13px; }
  td button:hover { background: transparent; color: var(--ember); border-color: var(--ember); }
  table { border-collapse: collapse; width: 100%; margin-top: 40px; font-size: 15px; }
  th { font-family: var(--display); font-weight: 400; font-size: 13px; letter-spacing: -0.02em; color: var(--slate); }
  th, td { text-align: left; padding: 14px 16px; border-bottom: 1px solid var(--mist); white-space: nowrap; }
  tr:hover td { background: var(--fog); }
  td:first-child { font-family: var(--mono); font-size: 13px; color: var(--steel); }
  td.title { white-space: normal; max-width: 24rem; color: var(--steel); }
  .agent { display: inline-block; font-size: 12px; font-weight: 500; line-height: 1; padding: 5px 10px;
           border-radius: 20px; background: var(--ivory); color: var(--brass); }
  .err { color: var(--steel); margin-top: 24px; padding: 24px 40px; background: var(--ash); border-radius: 6px 0 0; }
  .err:empty { display: none; }
  .err.is-error { color: var(--ember); background: var(--ivory); }
</style>
</head>
<body>
<h1>stift <span>session store</span></h1>
<p class="muted">Paste an access token to browse stored sessions. The token stays in this browser.</p>
<div class="bar">
<input id="token" type="password" placeholder="stf_..." aria-label="Access token">
<input id="q" type="text" placeholder="Filter sessions" aria-label="Filter">
<button onclick="load()">Load</button>
</div>
<div id="err" class="err"></div>
<table id="tbl" hidden>
  <thead><tr><th>ID</th><th>Agent</th><th>Host</th><th>Project</th><th>Title</th>
  <th>Size</th><th>Updated</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
const $ = id => document.getElementById(id);
$('token').value = localStorage.getItem('stift_token') || '';
function hsize(n) {
  for (const u of ['B','KB','MB','GB']) { if (n < 1024) return n.toFixed(n<10&&u!=='B'?1:0)+u; n /= 1024; }
  return n.toFixed(1)+'TB';
}
async function api(path, opts) {
  const tok = $('token').value.trim();
  const res = await fetch(path, {...opts, headers: {'Authorization': 'Bearer ' + tok}});
  if (!res.ok) throw new Error((await res.json().catch(()=>({}))).error || res.statusText);
  return res;
}
async function load() {
  $('err').textContent = ''; $('err').classList.remove('is-error');
  localStorage.setItem('stift_token', $('token').value.trim());
  try {
    const q = encodeURIComponent($('q').value.trim());
    const sessions = await (await api('/v1/sessions' + (q ? '?q='+q : ''))).json();
    const rows = $('rows'); rows.innerHTML = '';
    for (const s of sessions) {
      const tr = document.createElement('tr');
      const cells = [s.id.slice(0,8), s.agent, s.host, s.project || '—', s.title || '—',
                     hsize(s.size), new Date(s.updated_at).toLocaleString()];
      tr.innerHTML = cells.map((c,i) =>
        '<td class="' + (i===1?'agent':i===4?'title':'') + '"></td>').join('');
      [...tr.children].forEach((td,i) => td.textContent = cells[i]);
      const act = document.createElement('td');
      const dl = document.createElement('button'); dl.textContent = 'Download';
      dl.title = 'Download archive';
      dl.onclick = () => download(s);
      act.appendChild(dl); tr.appendChild(act);
      rows.appendChild(tr);
    }
    $('tbl').hidden = false;
    if (!sessions.length) $('err').textContent = 'No sessions stored yet.';
  } catch (e) { $('err').textContent = e.message; $('err').classList.add('is-error'); $('tbl').hidden = true; }
}
async function download(s) {
  try {
    const blob = await (await api('/v1/sessions/' + s.id + '/archive')).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = s.agent + '-' + s.id.slice(0,8) + '.tar.gz';
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { $('err').textContent = e.message; $('err').classList.add('is-error'); }
}
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
$('token').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
if ($('token').value) load();
</script>
</body>
</html>
`

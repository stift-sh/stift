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
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         background: #0d1117; color: #c9d1d9; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h1 span { color: #58a6ff; }
  input { background: #161b22; color: inherit; border: 1px solid #30363d; border-radius: 6px;
          padding: .45rem .6rem; font: inherit; }
  #token { width: 28rem; max-width: 60vw; }
  button { background: #21262d; color: inherit; border: 1px solid #30363d; border-radius: 6px;
           padding: .45rem .8rem; font: inherit; cursor: pointer; }
  button:hover { border-color: #58a6ff; }
  table { border-collapse: collapse; width: 100%; margin-top: 1.2rem; font-size: .85rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #21262d; white-space: nowrap; }
  td.title { white-space: normal; max-width: 24rem; color: #8b949e; }
  .agent { color: #58a6ff; } .err { color: #f85149; margin-top: 1rem; }
  .muted { color: #8b949e; font-size: .8rem; }
</style>
</head>
<body>
<h1><span>stift</span> — agent session store</h1>
<p class="muted">Paste an access token to browse stored sessions. The token stays in this browser.</p>
<input id="token" type="password" placeholder="stf_...">
<input id="q" type="text" placeholder="filter...">
<button onclick="load()">Load</button>
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
  $('err').textContent = '';
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
      const dl = document.createElement('button'); dl.textContent = '⬇';
      dl.title = 'Download archive';
      dl.onclick = () => download(s);
      act.appendChild(dl); tr.appendChild(act);
      rows.appendChild(tr);
    }
    $('tbl').hidden = false;
    if (!sessions.length) $('err').textContent = 'No sessions stored yet.';
  } catch (e) { $('err').textContent = e.message; $('tbl').hidden = true; }
}
async function download(s) {
  try {
    const blob = await (await api('/v1/sessions/' + s.id + '/archive')).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = s.agent + '-' + s.id.slice(0,8) + '.tar.gz';
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { $('err').textContent = e.message; }
}
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
$('token').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
if ($('token').value) load();
</script>
</body>
</html>
`

import { BrowserWindow } from 'electron'
import { loadDvr, DvrFrame } from './snapshotlog'

/**
 * Playback for a recorded console session.
 *
 * Deliberately a separate window rather than a mode inside the live console. The
 * console's job is to show what is happening now, and threading a "we are showing
 * you the past" state through its render path is how a live view starts lying —
 * the riskiest possible place to put a bug. Replay reads the recording and owns
 * its own drawing; nothing here can affect what the live board does.
 */

const LANES = [
  { key: 'queued', label: 'QUEUED' },
  { key: 'think', label: 'THINKING' },
  { key: 'act', label: 'ACTING' },
  { key: 'return', label: 'RETURNED' },
  { key: 'landed', label: 'LANDED' },
  { key: 'blocked', label: 'BLOCKED' },
]

function buildHtml(frames: DvrFrame[]): string {
  const t0 = frames[0]?.ts ?? 0
  const t1 = frames[frames.length - 1]?.ts ?? 0
  const mins = Math.max(1, Math.round((t1 - t0) / 60000))
  const payload = JSON.stringify(frames).replace(/</g, '\\u003c')

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Console Replay</title><style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#16171a;--panel:#1d1f23;--line:#2c2f35;--text:#e6e7ea;--dim:#8b8f98;--accent:#38bdf8}
body{background:var(--bg);color:var(--text);font:12px/1.5 ui-monospace,Menlo,Monaco,monospace;padding:14px}
header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
h1{font-size:13px;font-weight:600}
.meta{color:var(--dim);font-size:11px}
.board{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;min-height:340px}
.lane{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px;min-height:120px}
.lane h2{font-size:9px;letter-spacing:.09em;color:var(--dim);margin-bottom:7px;display:flex;justify-content:space-between}
.card{background:#23262b;border:1px solid #31353c;border-left:2px solid var(--accent);border-radius:5px;padding:6px 7px;margin-bottom:6px}
.card .tag{font-size:10px;color:var(--accent)}
.card .task{font-size:10px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .sub{font-size:9px;color:var(--dim)}
.card.err{border-left-color:#f87171}
.card.err .tag{color:#f87171}
.transport{display:flex;align-items:center;gap:10px;margin-top:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
button{background:#282b31;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:5px 11px;font:inherit;cursor:pointer}
button:hover{background:#31353c}
input[type=range]{flex:1;accent-color:var(--accent)}
.clock{font-variant-numeric:tabular-nums;color:var(--dim);min-width:150px}
select{background:#282b31;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:4px 6px;font:inherit}
.empty{color:#4b5563;font-size:10px;font-style:italic}
</style></head><body>
<header>
  <h1>Console Replay</h1>
  <span class="meta">${frames.length} frames · ${mins} min recorded</span>
</header>
<div class="board" id="board"></div>
<div class="transport">
  <button id="back">&#8676;</button>
  <button id="play">&#9654; Play</button>
  <button id="fwd">&#8677;</button>
  <input type="range" id="scrub" min="0" max="${Math.max(0, frames.length - 1)}" value="0">
  <select id="speed"><option value="1">1x</option><option value="2">2x</option><option value="4" selected>4x</option><option value="10">10x</option></select>
  <span class="clock" id="clock">--:--:--</span>
</div>
<script>
const F = ${payload};
const LANES = ${JSON.stringify(LANES)};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function render(i) {
  const f = F[i];
  if (!f) return;
  document.getElementById('clock').textContent =
    new Date(f.ts).toLocaleTimeString() + '  ·  ' + f.cards.length + ' cards';
  document.getElementById('board').innerHTML = LANES.map((L) => {
    const cards = f.cards.filter((c) => c.col === L.key);
    return '<div class="lane"><h2><span>' + L.label + '</span><span>' + (cards.length || '') + '</span></h2>' +
      (cards.length ? cards.map((c) =>
        '<div class="card' + (c.err ? ' err' : '') + '">' +
          '<div class="tag">' + esc(c.tag) + (c.durMs ? ' · ' + Math.round(c.durMs / 100) / 10 + 's' : '') + '</div>' +
          '<div class="task" title="' + esc(c.task) + '">' + esc(c.task) + '</div>' +
          (c.sub ? '<div class="sub">' + esc(c.sub) + '</div>' : '') +
        '</div>').join('')
      : '<div class="empty">empty</div>') + '</div>';
  }).join('');
}

const scrub = document.getElementById('scrub');
let timer = null;
scrub.addEventListener('input', () => render(+scrub.value));
document.getElementById('back').onclick = () => { scrub.value = Math.max(0, +scrub.value - 10); render(+scrub.value); };
document.getElementById('fwd').onclick = () => { scrub.value = Math.min(F.length - 1, +scrub.value + 10); render(+scrub.value); };
document.getElementById('play').onclick = function () {
  if (timer) { clearInterval(timer); timer = null; this.innerHTML = '&#9654; Play'; return; }
  this.innerHTML = '&#10074;&#10074; Pause';
  const step = () => {
    const v = +scrub.value + 1;
    if (v >= F.length - 1) {
      clearInterval(timer); timer = null;
      document.getElementById('play').innerHTML = '&#9654; Play';
      scrub.value = F.length - 1;
    } else scrub.value = v;
    render(+scrub.value);
  };
  const speed = +document.getElementById('speed').value;
  timer = setInterval(step, 1000 / speed);
};
document.getElementById('speed').onchange = function () {
  if (!timer) return;
  clearInterval(timer);
  document.getElementById('play').click();
  document.getElementById('play').click();
};
render(0);
</script></body></html>`
}

let dvrWindow: BrowserWindow | null = null

export function openDvrViewer(): { ok: boolean; reason?: string } {
  const frames = loadDvr()
  if (frames.length === 0) {
    return { ok: false, reason: 'No recording yet — turn on "Board recording" in the Activity Console settings and let a session run.' }
  }

  if (!dvrWindow || dvrWindow.isDestroyed()) {
    dvrWindow = new BrowserWindow({
      width: 1280,
      height: 720,
      title: 'Console Replay',
      backgroundColor: '#16171a',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    dvrWindow.on('closed', () => { dvrWindow = null })
  }
  dvrWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(frames)))
  dvrWindow.focus()
  return { ok: true }
}

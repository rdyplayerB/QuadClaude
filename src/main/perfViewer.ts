import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from './logger'
import { getPerfLogDir } from './perfMonitor'

/**
 * A reader for the performance logs.
 *
 * The monitor has been sampling every 5 seconds since June and nothing has ever
 * displayed any of it — the only way anyone has read a perf log is an ad-hoc
 * script, which is how three real defects sat undiscovered inside it. This is the
 * missing half: a scrubbable timeline over data that already exists, so no new
 * capture is needed to start seeing it.
 *
 * Sessions run to hundreds of megabytes, so nothing raw reaches the window. Main
 * parses the JSONL, buckets it down to a fixed number of columns, and hands over
 * a few hundred KB of finished series. Buckets keep the MAXIMUM of each metric
 * rather than the mean: this view exists to find spikes, and averaging is exactly
 * what hides them.
 */

const MAX_POINTS = 1400

interface Series {
  t: number[]
  cpu: number[]
  rss: number[]
  lag: number[]
  heap: number[]
}

interface PerfEvent {
  t: number
  kind: string
  label: string
  detail: string
}

interface SessionData {
  file: string
  meta: Record<string, unknown>
  series: Series
  events: PerfEvent[]
  startT: number
  endT: number
  sampleCount: number
  bytes: number
}

export interface SessionSummary {
  file: string
  label: string
  bytes: number
}

export function listPerfSessions(): SessionSummary[] {
  try {
    return fs
      .readdirSync(getPerfLogDir())
      .filter((f) => f.startsWith('perf-') && f.endsWith('.jsonl'))
      .map((f) => {
        const full = path.join(getPerfLogDir(), f)
        let bytes = 0
        try { bytes = fs.statSync(full).size } catch { /* listed anyway */ }
        // perf-YYYYMMDD-HHMMSS.jsonl
        const m = /^perf-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.jsonl$/.exec(f)
        const label = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : f
        return { file: f, label, bytes }
      })
      .sort((a, b) => (a.file < b.file ? 1 : -1)) // newest first
  } catch {
    return []
  }
}

function loadSession(file: string): SessionData | null {
  const full = path.join(getPerfLogDir(), file)
  let raw: string
  let bytes = 0
  try {
    bytes = fs.statSync(full).size
    raw = fs.readFileSync(full, 'utf-8')
  } catch (err) {
    logger.warn('perf', 'could not read perf session', err instanceof Error ? err.message : String(err))
    return null
  }

  let meta: Record<string, unknown> = {}
  const samples: Array<{ t: number; cpu: number; rss: number; lag: number; heap: number }> = []
  const events: PerfEvent[] = []

  for (const line of raw.split('\n')) {
    if (!line) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue }
    const t = typeof d.t === 'number' ? d.t : 0
    switch (d.type) {
      case 'meta':
        meta = d
        break
      case 'sample': {
        const main = (d.main ?? {}) as Record<string, number>
        const totals = (d.appTotals ?? {}) as Record<string, number>
        samples.push({
          t,
          cpu: Number(totals.cpuPercent ?? 0) || 0,
          rss: Number(main.rssMb ?? 0) || 0,
          lag: Number(main.eventLoopLagMaxMs ?? 0) || 0,
          heap: Number(main.heapUsedMb ?? 0) || 0,
        })
        break
      }
      case 'stall': {
        // Sleep shows up here as a multi-hour "stall". Those are artifacts of the
        // machine suspending, not jank, and mixing them in makes the real ones
        // impossible to see — so they are labelled apart, not silently dropped.
        const blocked = Number(d.blockedMs ?? 0) || 0
        const isFreeze = d.kind === 'busy-freeze'
        events.push({
          t,
          kind: isFreeze ? 'freeze' : blocked > 60000 ? 'sleep' : 'pause',
          label: isFreeze ? 'busy freeze' : blocked > 60000 ? 'machine asleep' : 'idle gap',
          detail: `${Math.round(blocked)}ms · ${String(d.activity ?? 'unknown')}`,
        })
        break
      }
      case 'slow-op':
        events.push({
          t,
          kind: 'slowop',
          label: String(d.label ?? 'slow op'),
          detail: `${Math.round(Number(d.durationMs ?? 0))}ms`,
        })
        break
      case 'marker':
        events.push({ t, kind: 'marker', label: String(d.label ?? 'marker'), detail: 'manual marker' })
        break
      case 'power':
        events.push({ t, kind: 'power', label: String(d.event ?? 'power'), detail: 'power event' })
        break
      case 'gc':
        events.push({
          t,
          kind: 'gc',
          label: 'gc pause',
          detail: `${Math.round(Number(d.durationMs ?? 0))}ms · ${String(d.activity ?? 'unknown')}`,
        })
        break
    }
  }

  if (samples.length === 0) return null
  samples.sort((a, b) => a.t - b.t)
  const startT = samples[0].t
  const endT = samples[samples.length - 1].t

  // Bucket to a fixed width, keeping the peak in each bucket.
  const series: Series = { t: [], cpu: [], rss: [], lag: [], heap: [] }
  const stride = Math.max(1, Math.ceil(samples.length / MAX_POINTS))
  for (let i = 0; i < samples.length; i += stride) {
    const chunk = samples.slice(i, i + stride)
    series.t.push(chunk[0].t)
    series.cpu.push(Math.max(...chunk.map((s) => s.cpu)))
    series.rss.push(Math.max(...chunk.map((s) => s.rss)))
    series.lag.push(Math.max(...chunk.map((s) => s.lag)))
    series.heap.push(Math.max(...chunk.map((s) => s.heap)))
  }

  events.sort((a, b) => a.t - b.t)
  return { file, meta, series, events, startT, endT, sampleCount: samples.length, bytes }
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB'
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB'
  return (n / 1e3).toFixed(0) + ' KB'
}

function buildHtml(data: SessionData, sessions: SessionSummary[]): string {
  const durMin = Math.max(1, Math.round((data.endT - data.startT) / 60000))
  const meta = data.meta as Record<string, string | number>
  const payload = JSON.stringify({
    series: data.series,
    events: data.events,
    startT: data.startT,
    endT: data.endT,
  }).replace(/</g, '\\u003c')

  const options = sessions
    .map((s) => `<option value="${s.file}"${s.file === data.file ? ' selected' : ''}>${s.label} · ${fmtBytes(s.bytes)}</option>`)
    .join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Performance Timeline</title><style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#16171a; --panel:#1d1f23; --line:#2c2f35; --text:#e6e7ea; --dim:#8b8f98;
  --cpu:#38bdf8; --rss:#a78bfa; --lag:#fbbf24;
  --freeze:#f87171; --slowop:#fb923c; --marker:#34d399; --sleep:#4b5563; --power:#60a5fa;
}
body{background:var(--bg);color:var(--text);font:12px/1.5 ui-monospace,Menlo,Monaco,monospace;padding:14px}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:13px;font-weight:600;letter-spacing:.02em}
.meta{color:var(--dim);font-size:11px}
select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:5px;padding:4px 7px;font:inherit}
.charts{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;position:relative}
.row{display:flex;align-items:center;gap:9px;margin-bottom:7px}
.row:last-child{margin-bottom:0}
.tag{width:104px;flex:0 0 104px;font-size:10px;color:var(--dim);text-align:right;letter-spacing:.03em}
canvas{display:block;background:#141519;border-radius:4px;width:100%}
.cv{flex:1;min-width:0;position:relative}
#playhead{position:absolute;top:10px;bottom:10px;width:1px;background:#fff;opacity:.55;pointer-events:none;left:-99px}
.transport{display:flex;align-items:center;gap:10px;margin-top:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
button{background:#282b31;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:5px 11px;font:inherit;cursor:pointer}
button:hover{background:#31353c}
input[type=range]{flex:1;accent-color:var(--cpu)}
.clock{font-variant-numeric:tabular-nums;color:var(--dim);min-width:118px}
.readout{display:flex;gap:16px;flex-wrap:wrap;margin-top:11px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.stat .k{font-size:10px;color:var(--dim);letter-spacing:.04em}
.stat .v{font-size:15px;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:13px;flex-wrap:wrap;margin-top:9px;font-size:10px;color:var(--dim)}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:-1px}
#near{margin-top:11px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-height:60px}
#near h2{font-size:10px;color:var(--dim);letter-spacing:.05em;margin-bottom:6px}
#near div{padding:2px 0;border-bottom:1px solid #23262b}
#near div:last-child{border:0}
.k-freeze{color:var(--freeze)} .k-slowop{color:var(--slowop)} .k-marker{color:var(--marker)}
.k-sleep{color:var(--sleep)} .k-power{color:var(--power)} .k-pause{color:var(--dim)} .k-gc{color:var(--dim)}
</style></head><body>
<header>
  <h1>Performance Timeline</h1>
  <select id="sess">${options}</select>
  <span class="meta">${data.sampleCount.toLocaleString()} samples · ${durMin} min · ${fmtBytes(data.bytes)} · v${meta.appVersion ?? '?'} · ${meta.cpuModel ?? ''}</span>
</header>

<div class="charts" id="charts">
  <div class="row"><div class="tag">CPU %</div><div class="cv"><canvas id="c-cpu" height="86"></canvas></div></div>
  <div class="row"><div class="tag">MAIN RSS MB</div><div class="cv"><canvas id="c-rss" height="86"></canvas></div></div>
  <div class="row"><div class="tag">LOOP LAG MS</div><div class="cv"><canvas id="c-lag" height="86"></canvas></div></div>
  <div class="row"><div class="tag">EVENTS</div><div class="cv"><canvas id="c-evt" height="26"></canvas></div></div>
  <div id="playhead"></div>
</div>

<div class="transport">
  <button id="back">&#8676;</button>
  <button id="play">&#9654; Play</button>
  <button id="fwd">&#8677;</button>
  <input type="range" id="scrub" min="0" max="1000" value="0">
  <span class="clock" id="clock">--:--:--</span>
</div>

<div class="readout">
  <div class="stat"><div class="k">CPU</div><div class="v" id="v-cpu">–</div></div>
  <div class="stat"><div class="k">MAIN RSS</div><div class="v" id="v-rss">–</div></div>
  <div class="stat"><div class="k">HEAP</div><div class="v" id="v-heap">–</div></div>
  <div class="stat"><div class="k">LOOP LAG</div><div class="v" id="v-lag">–</div></div>
</div>

<div class="legend">
  <span><i style="background:var(--freeze)"></i>busy freeze</span>
  <span><i style="background:var(--slowop)"></i>slow op</span>
  <span><i style="background:var(--marker)"></i>marker</span>
  <span><i style="background:var(--power)"></i>power</span>
  <span><i style="background:var(--sleep)"></i>machine asleep</span>
</div>

<div id="near"><h2>AT THE PLAYHEAD</h2><div style="color:var(--dim)">Scrub or press Play.</div></div>

<script>
const D = ${payload};
const S = D.series, EV = D.events, T0 = D.startT, T1 = D.endT, SPAN = Math.max(1, T1 - T0);
const COLORS = {freeze:'#f87171',slowop:'#fb923c',marker:'#34d399',sleep:'#4b5563',power:'#60a5fa',pause:'#6b7280',gc:'#6b7280'};

function draw(id, vals, color, fill) {
  const cv = document.getElementById(id), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.height;
  cv.width = w * dpr; cv.style.height = h + 'px'; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const peak = Math.max(1, ...vals);
  // Gridlines at quarters so a spike can be read against something.
  g.strokeStyle = '#23262b'; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = (h / 4) * i; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.beginPath();
  vals.forEach((v, i) => {
    const x = (i / Math.max(1, vals.length - 1)) * w;
    const y = h - (v / peak) * (h - 4) - 2;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = color; g.lineWidth = 1.35; g.stroke();
  if (fill) { g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = fill; g.fill(); }
  g.fillStyle = '#8b8f98'; g.font = '9px ui-monospace,monospace';
  g.fillText(Math.round(peak).toLocaleString(), 4, 10);
}

function drawEvents() {
  const cv = document.getElementById('c-evt'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.height;
  cv.width = w * dpr; cv.style.height = h + 'px'; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  for (const e of EV) {
    const x = ((e.t - T0) / SPAN) * w;
    g.fillStyle = COLORS[e.kind] || '#6b7280';
    // Freezes are what this view is for — make them impossible to miss.
    const tall = e.kind === 'freeze' || e.kind === 'marker';
    g.fillRect(x, tall ? 2 : 8, tall ? 2 : 1, tall ? h - 4 : h - 14);
  }
}

function redraw() {
  draw('c-cpu', S.cpu, '#38bdf8', 'rgba(56,189,248,.10)');
  draw('c-rss', S.rss, '#a78bfa', 'rgba(167,139,250,.10)');
  draw('c-lag', S.lag, '#fbbf24', 'rgba(251,191,36,.10)');
  drawEvents();
  update(+document.getElementById('scrub').value);
}

function update(pos) {
  const frac = pos / 1000, t = T0 + SPAN * frac;
  const cv = document.getElementById('c-cpu');
  const left = cv.getBoundingClientRect().left - document.getElementById('charts').getBoundingClientRect().left;
  document.getElementById('playhead').style.left = (left + frac * cv.clientWidth) + 'px';
  document.getElementById('clock').textContent = new Date(t).toLocaleTimeString();

  let i = 0, best = Infinity;
  S.t.forEach((tt, k) => { const d = Math.abs(tt - t); if (d < best) { best = d; i = k; } });
  document.getElementById('v-cpu').textContent = S.cpu[i].toFixed(1) + '%';
  document.getElementById('v-rss').textContent = Math.round(S.rss[i]) + ' MB';
  document.getElementById('v-heap').textContent = Math.round(S.heap[i]) + ' MB';
  document.getElementById('v-lag').textContent = Math.round(S.lag[i]) + ' ms';

  // Everything within 30s of the playhead, so scrubbing explains the spike you land on.
  const near = EV.filter((e) => Math.abs(e.t - t) < 30000).slice(0, 14);
  const box = document.getElementById('near');
  box.innerHTML = '<h2>AT THE PLAYHEAD</h2>' + (near.length
    ? near.map((e) => '<div><span class="k-' + e.kind + '">' + e.label + '</span> <span style="color:var(--dim)">' + e.detail + ' · ' + new Date(e.t).toLocaleTimeString() + '</span></div>').join('')
    : '<div style="color:var(--dim)">Nothing within 30s.</div>');
}

const scrub = document.getElementById('scrub');
let timer = null;
scrub.addEventListener('input', () => update(+scrub.value));
document.getElementById('back').onclick = () => { scrub.value = Math.max(0, +scrub.value - 25); update(+scrub.value); };
document.getElementById('fwd').onclick = () => { scrub.value = Math.min(1000, +scrub.value + 25); update(+scrub.value); };
document.getElementById('play').onclick = function () {
  if (timer) { clearInterval(timer); timer = null; this.innerHTML = '&#9654; Play'; return; }
  this.innerHTML = '&#10074;&#10074; Pause';
  timer = setInterval(() => {
    const v = +scrub.value + 2;
    if (v >= 1000) { clearInterval(timer); timer = null; document.getElementById('play').innerHTML = '&#9654; Play'; scrub.value = 1000; }
    else scrub.value = v;
    update(+scrub.value);
  }, 60);
};
// Session switching goes through a navigation the main process intercepts — this
// window has no preload, and a data: URL cannot be given one.
document.getElementById('sess').onchange = function () { location.href = 'qcperf://open/' + this.value; };
window.addEventListener('resize', redraw);
redraw();
</script></body></html>`
}

let perfWindow: BrowserWindow | null = null

export function openPerfViewer(file?: string): void {
  const sessions = listPerfSessions()
  if (sessions.length === 0) {
    logger.warn('perf', 'no perf sessions to show')
    return
  }
  const target = file && sessions.some((s) => s.file === file) ? file : sessions[0].file
  const data = loadSession(target)
  if (!data) {
    logger.warn('perf', 'perf session had no samples', target)
    return
  }

  if (!perfWindow || perfWindow.isDestroyed()) {
    perfWindow = new BrowserWindow({
      width: 1180,
      height: 840,
      title: 'Performance Timeline',
      backgroundColor: '#16171a',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    perfWindow.on('closed', () => { perfWindow = null })
    // The picker navigates to qcperf://open/<file>; catch it and reload in place.
    perfWindow.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('qcperf://')) return
      e.preventDefault()
      const next = decodeURIComponent(url.replace('qcperf://open/', '').replace(/\/$/, ''))
      openPerfViewer(next)
    })
  }

  perfWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml(data, sessions)))
  perfWindow.focus()
  logger.info('perf', 'Opened performance timeline', `${target} (${data.sampleCount} samples)`)
}

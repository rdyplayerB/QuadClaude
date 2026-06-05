#!/usr/bin/env node
/**
 * Analyze a QuadClaude performance log (JSONL produced by src/main/perfMonitor.ts).
 *
 * Usage:
 *   node scripts/analyze-perf.mjs                 # newest log in the default dir
 *   node scripts/analyze-perf.mjs <file.jsonl>    # a specific log
 *   node scripts/analyze-perf.mjs --list          # list available logs
 *
 * It answers two questions:
 *   1. Is the slowdown the OS/machine or the app?  (app totals vs system stats)
 *   2. Where in the app is it?                      (per-process + renderer + pty)
 *
 * Heuristics are clearly labeled. Nothing here mutates the app; read-only.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ---- locate the log ----
function defaultLogDirs() {
  const home = os.homedir();
  // Electron userData on macOS = ~/Library/Application Support/<appName>
  // App name resolves to package.json "name" ("quadclaude") in dev.
  return [
    path.join(home, 'Library', 'Application Support', 'quadclaude', 'perf-logs'),
    path.join(home, 'Library', 'Application Support', 'QuadClaude', 'perf-logs'),
    path.join(home, '.config', 'quadclaude', 'perf-logs'),
  ];
}

function listLogs() {
  const found = [];
  for (const dir of defaultLogDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jsonl')) {
        const full = path.join(dir, f);
        found.push({ full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

function resolveTarget(arg) {
  if (arg && arg !== '--list') {
    if (!fs.existsSync(arg)) {
      console.error(`File not found: ${arg}`);
      process.exit(1);
    }
    return arg;
  }
  const logs = listLogs();
  if (logs.length === 0) {
    console.error('No perf logs found. Looked in:\n  ' + defaultLogDirs().join('\n  '));
    console.error('\nRun the app (it records automatically), then re-run this script.');
    process.exit(1);
  }
  return logs[0].full;
}

// ---- stats helpers ----
function linregSlope(points) {
  // points: [{x, y}]; returns slope (y units per x unit) via least squares.
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const max = (a) => (a.length ? Math.max(...a) : 0);
const min = (a) => (a.length ? Math.min(...a) : 0);
const r1 = (n) => Math.round(n * 10) / 10;
const r0 = (n) => Math.round(n);

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

// ---- load ----
const arg = process.argv[2];
if (arg === '--list') {
  const logs = listLogs();
  if (!logs.length) console.log('No logs found.');
  for (const l of logs) console.log(`${new Date(l.mtime).toLocaleString()}  ${l.full}`);
  process.exit(0);
}

const target = resolveTarget(arg);
const raw = fs.readFileSync(target, 'utf-8').split('\n').filter((l) => l.trim());
const records = [];
for (const line of raw) {
  try { records.push(JSON.parse(line)); } catch { /* skip */ }
}

const meta = records.find((r) => r.type === 'meta');
const samples = records.filter((r) => r.type === 'sample');
const markers = records.filter((r) => r.type === 'marker');
// High-resolution event streams (added by the self-instrumenting recorder).
const stalls = records.filter((r) => r.type === 'stall');
const gcs = records.filter((r) => r.type === 'gc');
const slowOps = records.filter((r) => r.type === 'slow-op');
const powerEvents = records.filter((r) => r.type === 'power');
const orphanEvents = records.filter((r) => r.type === 'orphan');
const lineageEvents = records.filter((r) => r.type === 'lineage');

if (samples.length < 2) {
  console.error('Not enough samples to analyze (need at least 2).');
  process.exit(1);
}

const t0 = samples[0].t;
const tEnd = samples[samples.length - 1].t;
const durationMs = tEnd - t0;
const hours = durationMs / 3600000;
const hx = (t) => (t - t0) / 3600000; // time in hours since start (regression x)

// ---- header ----
console.log('═'.repeat(72));
console.log('  QuadClaude Performance Analysis');
console.log('═'.repeat(72));
console.log(`Log:       ${target}`);
if (meta) {
  console.log(`Machine:   ${meta.cpuModel} · ${meta.cpuCount} cores · ${meta.totalMemMb} MB RAM`);
  console.log(`Versions:  app ${meta.appVersion} · electron ${meta.electron} · chrome ${meta.chrome}`);
}
console.log(`Duration:  ${fmtDur(durationMs)}  (${samples.length} samples)`);
console.log(`Started:   ${new Date(t0).toLocaleString()}`);
console.log('');

// ---- system vs app ----
const sysCpu = samples.map((s) => s.sys?.cpuPercent).filter((v) => v != null);
const sysFree = samples.map((s) => s.sys?.freeMemMb).filter((v) => v != null);
const sysMemPct = samples.map((s) => s.sys?.memUsedPct).filter((v) => v != null);
const load1 = samples.map((s) => s.sys?.loadavg?.[0]).filter((v) => v != null);

const appCpu = samples.map((s) => s.appTotals?.cpuPercent).filter((v) => v != null);
const appMemMb = samples.map((s) => (s.appTotals?.memWorkingSetKb || 0) / 1024);
const appMemPts = samples
  .filter((s) => s.appTotals?.memWorkingSetKb)
  .map((s) => ({ x: hx(s.t), y: s.appTotals.memWorkingSetKb / 1024 }));
const appMemSlope = linregSlope(appMemPts); // MB per hour

const cpuCount = meta?.cpuCount || os.cpus().length;

console.log('── SYSTEM (whole machine) ' + '─'.repeat(46));
console.log(`  CPU:        avg ${r1(avg(sysCpu))}%   peak ${r1(max(sysCpu))}%   (across ${cpuCount} cores)`);
console.log(`  Load avg:   avg ${r1(avg(load1))}    peak ${r1(max(load1))}    (>${cpuCount} = oversubscribed)`);
console.log(`  Mem used:   avg ${r1(avg(sysMemPct))}%   peak ${r1(max(sysMemPct))}%`);
console.log(`  Free mem:   min ${r0(min(sysFree))} MB   (low free mem ⇒ macOS compresses/swaps ⇒ everything slows)`);
console.log('');

console.log('── APP (all QuadClaude processes) ' + '─'.repeat(38));
console.log(`  CPU:        avg ${r1(avg(appCpu))}%   peak ${r1(max(appCpu))}%`);
console.log(`  Memory:     start ${r0(appMemMb[0])} MB → end ${r0(appMemMb[appMemMb.length - 1])} MB   peak ${r0(max(appMemMb))} MB`);
console.log(`  Mem trend:  ${appMemSlope >= 0 ? '+' : ''}${r1(appMemSlope)} MB/hour  ${appMemSlope > 50 ? '⚠️  GROWING (possible leak)' : appMemSlope > 15 ? '↗ slowly growing' : 'stable'}`);
console.log('');

// ---- per-process breakdown ----
// Group app.getAppMetrics() rows across samples by a stable key.
const procSeries = new Map(); // key -> [{x, mem, cpu}]
for (const s of samples) {
  for (const p of s.procs || []) {
    const key = `${p.type}${p.name ? ':' + p.name : ''}${p.serviceName ? ':' + p.serviceName : ''}`;
    if (!procSeries.has(key)) procSeries.set(key, []);
    procSeries.get(key).push({ x: hx(s.t), mem: (p.memWorkingSetKb || 0) / 1024, cpu: p.cpuPercent || 0 });
  }
}

const procRows = [];
for (const [key, series] of procSeries) {
  const mems = series.map((p) => p.mem);
  const cpus = series.map((p) => p.cpu);
  procRows.push({
    key,
    memStart: mems[0],
    memEnd: mems[mems.length - 1],
    memPeak: max(mems),
    memSlope: linregSlope(series.map((p) => ({ x: p.x, y: p.mem }))),
    cpuAvg: avg(cpus),
    cpuMax: max(cpus),
    samples: series.length,
  });
}
procRows.sort((a, b) => b.memSlope - a.memSlope);

console.log('── PER-PROCESS (which part of the app) ' + '─'.repeat(33));
console.log('  process                    mem start→end    growth      cpu avg/max');
for (const p of procRows) {
  const label = p.key.padEnd(26).slice(0, 26);
  const memCol = `${r0(p.memStart)}→${r0(p.memEnd)}MB`.padEnd(16);
  const grow = `${p.memSlope >= 0 ? '+' : ''}${r1(p.memSlope)}MB/h`.padEnd(11);
  const cpuCol = `${r1(p.cpuAvg)}/${r1(p.cpuMax)}%`;
  const flag = p.memSlope > 30 ? '  ⚠️' : '';
  console.log(`  ${label} ${memCol} ${grow} ${cpuCol}${flag}`);
}
console.log('');

// ---- main process internals ----
const heapUsed = samples.map((s) => s.main?.heapUsedMb).filter((v) => v != null);
const rss = samples.map((s) => s.main?.rssMb).filter((v) => v != null);
const lagMax = samples.map((s) => s.main?.eventLoopLagMaxMs).filter((v) => v != null);
const lagP99 = samples.map((s) => s.main?.eventLoopLagP99Ms).filter((v) => v != null);
const rssSlope = linregSlope(
  samples.filter((s) => s.main?.rssMb != null).map((s) => ({ x: hx(s.t), y: s.main.rssMb }))
);

console.log('── MAIN PROCESS (node/IPC/pty host) ' + '─'.repeat(36));
console.log(`  RSS:        start ${r0(rss[0])} MB → end ${r0(rss[rss.length - 1])} MB   (${rssSlope >= 0 ? '+' : ''}${r1(rssSlope)} MB/hour)`);
console.log(`  V8 heap:    start ${r1(heapUsed[0])} MB → end ${r1(heapUsed[heapUsed.length - 1])} MB`);
// The sampled histogram conflates sleep with real freezes, so it's now only a
// rough hint. The authoritative freeze data comes from the stall stream below.
console.log(`  Event loop: sampled max lag ${r1(max(lagMax))} ms (UNRELIABLE — see FREEZES below)`);
console.log('');

// ---- FREEZES: the authoritative, sleep-discriminated freeze section ----
// 'busy-freeze' = main thread genuinely blocked on CPU (the real bug).
// 'idle-gap'    = wall-clock advanced with ~no CPU = OS sleep/suspend (ignore).
const busyFreezes = stalls.filter((s) => s.kind === 'busy-freeze');
const idleGaps = stalls.filter((s) => s.kind === 'idle-gap');

if (stalls.length === 0 && gcs.length === 0) {
  console.log('── FREEZES ' + '─'.repeat(61));
  console.log('  No high-resolution freeze data in this log. (Recorded by an older');
  console.log('  build? The stall/GC detectors only exist in newer recordings.)');
  console.log('');
} else {
  console.log('── FREEZES (high-resolution, sleep-discriminated) ' + '─'.repeat(22));
  console.log(`  Real main-thread freezes (busy-freeze): ${busyFreezes.length}`);
  console.log(`  Sleep/suspend gaps (idle-gap, excluded): ${idleGaps.length}`);
  if (busyFreezes.length) {
    const durs = busyFreezes.map((s) => s.blockedMs).sort((a, b) => b - a);
    console.log(`  Freeze duration: worst ${r0(durs[0])} ms   median ${r0(durs[Math.floor(durs.length / 2)])} ms   total ${r0(durs.reduce((a, v) => a + v, 0))} ms`);
    // Attribute freezes to the activity that was running.
    const byActivity = {};
    for (const s of busyFreezes) {
      const k = s.activity || 'unknown';
      if (!byActivity[k]) byActivity[k] = { count: 0, ms: 0, worst: 0 };
      byActivity[k].count++;
      byActivity[k].ms += s.blockedMs;
      byActivity[k].worst = Math.max(byActivity[k].worst, s.blockedMs);
    }
    console.log('  Blamed on (activity running when the freeze hit):');
    Object.entries(byActivity)
      .sort((a, b) => b[1].ms - a[1].ms)
      .forEach(([k, v]) => console.log(`    ${k.padEnd(28)} ${String(v.count).padStart(4)}×   total ${r0(v.ms)}ms   worst ${r0(v.worst)}ms`));
    console.log('  Worst individual freezes:');
    busyFreezes
      .slice()
      .sort((a, b) => b.blockedMs - a.blockedMs)
      .slice(0, 6)
      .forEach((s) => {
        const trail = (s.trail || []).map((t) => t.label).join(' → ') || '(no trail)';
        console.log(`    @${fmtDur(s.t - t0)}  ${r0(s.blockedMs)}ms  activity="${s.activity}"  rss=${s.rssMb}MB  trail: ${trail}`);
      });
  }
  // GC pauses.
  if (gcs.length) {
    const gcDurs = gcs.map((g) => g.durationMs).sort((a, b) => b - a);
    const gcTotal = gcDurs.reduce((a, v) => a + v, 0);
    console.log(`  GC pauses >${80}ms: ${gcs.length}   worst ${r1(gcDurs[0])} ms   total ${r0(gcTotal)} ms`);
  }
  // Slow ops (named operations that individually exceeded the threshold).
  if (slowOps.length) {
    const byOp = {};
    for (const o of slowOps) {
      if (!byOp[o.label]) byOp[o.label] = { count: 0, ms: 0, worst: 0 };
      byOp[o.label].count++;
      byOp[o.label].ms += o.durationMs;
      byOp[o.label].worst = Math.max(byOp[o.label].worst, o.durationMs);
    }
    console.log('  Slow named operations (>300ms each):');
    Object.entries(byOp)
      .sort((a, b) => b[1].ms - a[1].ms)
      .forEach(([k, v]) => console.log(`    ${k.padEnd(28)} ${String(v.count).padStart(4)}×   total ${r0(v.ms)}ms   worst ${r0(v.worst)}ms`));
  }
  console.log('');
}

// ---- ORPHANED PROCESSES (did closing a pane leave processes behind?) ----
console.log('── ORPHANED PROCESSES (did QuadClaude leave processes behind?) ' + '─'.repeat(10));
if (orphanEvents.length === 0) {
  console.log('  None detected. When panes closed, no process detached and survived —');
  console.log('  QuadClaude is not orphaning processes in this session.');
} else {
  const totalSurvivors = orphanEvents.reduce((a, e) => a + (e.count || 0), 0);
  console.log(`  ⚠️  ${orphanEvents.length} pane close(s) left ${totalSurvivors} process(es) detached & alive:`);
  // Aggregate by command so a repeat offender (e.g. claude-mem) stands out.
  const byCmd = {};
  for (const e of orphanEvents) {
    for (const s of e.survivors || []) {
      const key = (s.cmd || '').split(/\s+/).slice(0, 3).join(' ') || '(unknown)';
      byCmd[key] = (byCmd[key] || 0) + 1;
    }
  }
  console.log('  By command (top offenders):');
  Object.entries(byCmd)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(3)}×  ${k}`));
  console.log('  Recent events:');
  for (const e of orphanEvents.slice(-4)) {
    console.log(`    @${fmtDur(e.t - t0)}  pane ${e.paneId} (shell ${e.shellPid}) left ${e.count}:`);
    for (const s of (e.survivors || []).slice(0, 4)) {
      console.log(`        pid ${s.pid} reparented→${s.reparentedTo}: ${s.cmd}`);
    }
  }
}
console.log('');

// ---- POWER events (explicit sleep/lock windows) ----
if (powerEvents.length) {
  const suspends = powerEvents.filter((p) => p.event === 'suspend').length;
  const resumes = powerEvents.filter((p) => p.event === 'resume').length;
  const locks = powerEvents.filter((p) => p.event === 'lock-screen').length;
  console.log('── POWER (explicit, not inferred) ' + '─'.repeat(38));
  console.log(`  suspend: ${suspends}   resume: ${resumes}   screen-lock: ${locks}`);
  console.log('  (Sleep windows are now hard-marked, so freezes above exclude them.)');
  console.log('');
}

// ---- renderer internals ----
const rSamples = samples.filter((s) => s.renderer);
if (rSamples.length >= 2) {
  const jsHeap = rSamples.map((s) => s.renderer.jsHeapUsedMb).filter((v) => v != null);
  const dom = rSamples.map((s) => s.renderer.domNodes).filter((v) => v != null);
  const termLines = rSamples.map((s) => s.renderer.terminalTotalLines).filter((v) => v != null);
  const fps = rSamples.map((s) => s.renderer.fps).filter((v) => v != null && v > 0);
  const longTaskMs = rSamples.map((s) => s.renderer.longTaskMsTotal || 0);
  const longTaskMax = rSamples.map((s) => s.renderer.longTaskMaxMs || 0);
  const jsHeapSlope = linregSlope(
    rSamples.filter((s) => s.renderer.jsHeapUsedMb != null).map((s) => ({ x: hx(s.t), y: s.renderer.jsHeapUsedMb }))
  );

  console.log('── RENDERER (React + xterm UI) ' + '─'.repeat(41));
  console.log(`  JS heap:    start ${r1(jsHeap[0])} MB → end ${r1(jsHeap[jsHeap.length - 1])} MB   (${jsHeapSlope >= 0 ? '+' : ''}${r1(jsHeapSlope)} MB/hour)  ${jsHeapSlope > 20 ? '⚠️  growing' : ''}`);
  console.log(`  DOM nodes:  start ${r0(dom[0])} → end ${r0(dom[dom.length - 1])}   peak ${r0(max(dom))}  ${max(dom) - dom[0] > 2000 ? '⚠️  DOM growing' : ''}`);
  console.log(`  Scrollback: start ${r0(termLines[0])} → end ${r0(termLines[termLines.length - 1])} lines (sum across panes)`);
  console.log(`  FPS:        avg ${r0(avg(fps))}   min ${r0(min(fps))}   ${min(fps) < 30 && fps.length ? '⚠️  janky frames' : ''}`);
  console.log(`  Long tasks: worst single ${r0(max(longTaskMax))} ms   busiest 5s window ${r0(max(longTaskMs))} ms blocked`);
  console.log('');
} else {
  console.log('── RENDERER ' + '─'.repeat(60));
  console.log('  No renderer samples (renderer reporter may not have started).');
  console.log('');
}

// ---- pty ----
const ptyBps = samples.map((s) => s.pty?.bytesOutPerSec).filter((v) => v != null);
const lastPty = [...samples].reverse().find((s) => s.pty);
console.log('── PTY (terminal output throughput) ' + '─'.repeat(36));
console.log(`  Sessions:   ${lastPty?.pty?.sessions ?? '?'} active`);
console.log(`  Throughput: avg ${r0(avg(ptyBps) / 1024)} KB/s   peak ${r0(max(ptyBps) / 1024)} KB/s`);
console.log(`  Total out:  ${r0((lastPty?.pty?.totalBytesOut || 0) / 1048576)} MB over session`);
console.log('');

// ---- markers ----
if (markers.length) {
  console.log('── MARKERS (your annotations) ' + '─'.repeat(42));
  for (const m of markers) {
    const at = fmtDur(m.t - t0);
    // Find nearest sample to show context.
    let nearest = samples[0];
    for (const s of samples) if (Math.abs(s.t - m.t) < Math.abs(nearest.t - m.t)) nearest = s;
    const appM = r0((nearest.appTotals?.memWorkingSetKb || 0) / 1024);
    const sysFreeM = nearest.sys?.freeMemMb;
    console.log(`  @${at}  "${m.label}"  → app ${appM}MB, sys free ${sysFreeM}MB, load ${r1(nearest.sys?.loadavg?.[0])}`);
  }
  console.log('');
}

// ---- verdict ----
console.log('═'.repeat(72));
console.log('  VERDICT (heuristic)');
console.log('═'.repeat(72));

const findings = [];

// OS vs app: did free memory get low while app memory stayed flat?
const lowFreeMem = min(sysFree) < (meta?.totalMemMb || 16000) * 0.08; // <8% free
const highLoad = max(load1) > cpuCount * 1.5;
const appMemGrew = appMemSlope > 30;
const appMemEndMb = appMemMb[appMemMb.length - 1];

if (appMemGrew) {
  findings.push(
    `APP MEMORY LEAK LIKELY: app grew ${r1(appMemSlope)} MB/hour (now ${r0(appMemEndMb)} MB). ` +
    `Top grower: ${procRows[0]?.key} (+${r1(procRows[0]?.memSlope)} MB/h). ` +
    `This compounds: as the app consumes RAM, macOS compresses/swaps and the whole machine slows.`
  );
} else {
  findings.push(`App memory looks stable (${r1(appMemSlope)} MB/hour) — not an obvious leak.`);
}

if (lowFreeMem) {
  findings.push(
    `SYSTEM MEMORY PRESSURE: free RAM dropped to ${r0(min(sysFree))} MB. ` +
    `${appMemGrew ? 'Driven at least partly by the app above.' : 'But the app stayed flat — other apps/OS are the main consumers; the slowdown may be machine-wide, not QuadClaude.'}`
  );
}

if (highLoad && avg(appCpu) < 30) {
  findings.push(
    `HIGH SYSTEM LOAD with LOW app CPU (app avg ${r1(avg(appCpu))}%): the CPU contention is coming from outside QuadClaude — likely the OS or other processes.`
  );
} else if (avg(appCpu) > 40) {
  findings.push(`App CPU is high (avg ${r1(avg(appCpu))}%) — QuadClaude is a significant CPU consumer itself.`);
}

// Authoritative freeze verdict from the busy-freeze stream (no longer guessing
// from the sleep-contaminated lag histogram).
if (busyFreezes.length) {
  const durs = busyFreezes.map((s) => s.blockedMs).sort((a, b) => b - a);
  const worst = durs[0];
  const byActivity = {};
  for (const s of busyFreezes) {
    const k = s.activity || 'unknown';
    byActivity[k] = (byActivity[k] || 0) + s.blockedMs;
  }
  const topBlame = Object.entries(byActivity).sort((a, b) => b[1] - a[1])[0];
  findings.push(
    `REAL MAIN-THREAD FREEZES: ${busyFreezes.length} genuine on-CPU freezes (worst ${r0(worst)} ms), ` +
    `with ${idleGaps.length} sleep gaps correctly excluded. Top culprit by blocked time: "${topBlame[0]}" ` +
    `(${r0(topBlame[1])} ms total). This is an app bug worth fixing — it froze while burning CPU, not waiting on RAM or sleep.`
  );
} else if (idleGaps.length) {
  findings.push(
    `No real main-thread freezes detected — the ${idleGaps.length} large event-loop gaps were all OS sleep/suspend ` +
    `(CPU idle during them), not QuadClaude blocking. Earlier "huge lag" numbers were this artifact.`
  );
}
if (orphanEvents.length) {
  const totalSurvivors = orphanEvents.reduce((a, e) => a + (e.count || 0), 0);
  const cmds = new Set();
  for (const e of orphanEvents) for (const s of e.survivors || []) cmds.add((s.cmd || '').split(/\s+/)[0]);
  findings.push(
    `ORPHANED PROCESSES: closing panes left ${totalSurvivors} detached process(es) across ${orphanEvents.length} close(s). ` +
    `Offending commands: ${[...cmds].slice(0, 5).join(', ')}. These survived because they detached from the shell ` +
    `(reparented to launchd) — a pane-close kills the shell tree but cannot reach a process that already daemonized.`
  );
}
if (gcs.length) {
  const gcTotal = gcs.reduce((a, g) => a + g.durationMs, 0);
  const gcWorst = Math.max(...gcs.map((g) => g.durationMs));
  if (gcWorst > 200) {
    findings.push(
      `GC PAUSES: ${gcs.length} garbage-collection pauses over 80ms (worst ${r0(gcWorst)} ms, ${r0(gcTotal)} ms total). ` +
      `Long synchronous GC can be the hidden cause of freezes that own no obvious code.`
    );
  }
}

const rEnd = rSamples[rSamples.length - 1]?.renderer;
if (rEnd && rEnd.terminalTotalLines > 30000) {
  findings.push(`Large terminal scrollback (${r0(rEnd.terminalTotalLines)} lines total across panes). With WebGL, this is real GPU+RAM cost; consider lowering scrollback from 10000.`);
}

if (!findings.length) findings.push('Nothing alarming in this slice.');

findings.forEach((f, i) => {
  console.log(`\n  ${i + 1}. ${f}`);
});

console.log('\n' + '─'.repeat(72));
console.log('  Freezes are now captured automatically (busy-freeze vs sleep idle-gap),');
console.log('  attributed to the activity running at the time — no manual marker needed.');
console.log('─'.repeat(72));

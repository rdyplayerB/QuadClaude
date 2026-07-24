#!/usr/bin/env node
// Analyze the Ops Console verification trace: accuracy + timing.
// Usage: node src/plugins/ops-console/scripts/analyze-verify.mjs [path]
//   default path: ~/.quadclaude/ops-verify.jsonl
import fs from 'fs'
import os from 'os'
import path from 'path'

const file = process.argv[2] || path.join(os.homedir(), '.quadclaude', 'ops-verify.jsonl')
if (!fs.existsSync(file)) { console.error('no trace at ' + file + ' (enable Verification logging in the Activity Console settings, open it, then act in QuadClaude)'); process.exit(1) }

const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const by = (t) => rows.filter((r) => r.type === t)
const transitions = by('transition')
const represented = by('represented')
const missed = by('missed')
const phantom = by('phantom')
const mismatch = by('mismatch')

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
const stats = (arr) => {
  if (!arr.length) return { n: 0 }
  const s = [...arr].sort((a, b) => a - b)
  const sum = s.reduce((x, y) => x + y, 0)
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  return { n: s.length, min: s[0], p50: q(0.5), avg: Math.round(sum / s.length), p95: q(0.95), max: s[s.length - 1] }
}
const lat = stats(represented.map((r) => r.latencyMs))
const buildLag = stats(represented.map((r) => r.buildLagMs).filter((x) => x != null))
const renderLag = stats(represented.map((r) => r.renderLagMs).filter((x) => x != null))
const recvLag = stats(transitions.map((r) => r.recvLagMs).filter((x) => x != null))

// column-move transitions are the ones expected to produce a visual move
const moveTransitions = transitions.filter((t) => t.expect && t.expect.split('→')[0] !== t.expect.split('→')[1])
const denom = moveTransitions.length || (represented.length + missed.length + mismatch.length)

console.log('\n  QuadClaude Ops Console — verification report')
console.log('  ' + '─'.repeat(52))
console.log('  trace:            ' + file)
console.log('  transitions:      ' + transitions.length + ' total, ' + moveTransitions.length + ' expected a card move')
console.log('')
console.log('  ACCURACY')
console.log('    represented:    ' + represented.length + '   (' + pct(represented.length, denom) + '% of expected moves)')
console.log('    missed:         ' + missed.length + '   (no viz move in time — aliased/dropped)')
console.log('    phantom:        ' + phantom.length + '   (viz moved with no real transition)')
console.log('    mismatch:       ' + mismatch.length + '   (matched pane, wrong column)')
console.log('')
console.log('  TIMING — real change → card visibly moves (ms)')
if (lat.n) {
  console.log('    end-to-end:     min ' + lat.min + ' · p50 ' + lat.p50 + ' · avg ' + lat.avg + ' · p95 ' + lat.p95 + ' · max ' + lat.max)
  console.log('    ├ build lag:    avg ' + (buildLag.avg ?? '—') + '   (renderer debounce + main poll)')
  console.log('    └ render lag:   avg ' + (renderLag.avg ?? '—') + '   (snapshot IPC + window render)')
  console.log('    event recv lag: avg ' + (recvLag.avg ?? '—') + '   (transition IPC → main, ground-truth path)')
} else {
  console.log('    (no represented moves yet)')
}
if (missed.length) {
  console.log('')
  console.log('  MISSED detail:')
  for (const m of missed.slice(-8)) console.log('    pane ' + m.paneId + '  ' + m.from + '→' + m.to + '  (' + m.expect + ')')
}
console.log('')
if (lat.avg != null && lat.avg > 1200) console.log('  ⚠ avg latency >1.2s — consider event-driven push (drop the 400ms debounce + poll).')
if (missed.length) console.log('  ⚠ missed transitions present — the poll is aliasing fast state changes; event-driven push fixes this.')
if (!missed.length && !phantom.length && !mismatch.length && represented.length) console.log('  ✓ every expected move was represented, correctly.')
console.log('')

#!/usr/bin/env node
/*
 * qclearn — distill the durable delegation memory into a learned rubric.
 *
 * Reads  ~/.quadclaude/eval/outcomes.jsonl   (append-only labeled dataset; the memory)
 * Writes ~/.quadclaude/eval/rubric.md        (per-class priors + failure modes; editable)
 *        ~/.quadclaude/eval/calibration.json (how often the eval itself was right)
 *
 * This is the "learning" step of a continuously-improving evaluator. It is pure
 * aggregation over plain files — no app, no model, no network. Run it anytime, or let
 * qcdelegate trigger it every N new outcomes. Hand-edits below the marker in rubric.md
 * are PRESERVED across re-distills, so your judgment compounds with the data.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = path.join(os.homedir(), '.quadclaude', 'eval')
const OUTCOMES = path.join(DIR, 'outcomes.jsonl')
const RUBRIC = path.join(DIR, 'rubric.md')
const CALIB = path.join(DIR, 'calibration.json')
const TRACE = path.join(os.homedir(), '.quadclaude', 'delegation-trace.jsonl')
const HAND_MARKER = '<!-- HAND-EDITS BELOW — your notes here survive re-distills -->'

function readJsonl(p) {
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

const outcomes = readJsonl(OUTCOMES)
if (outcomes.length === 0) {
  console.log('qclearn: no outcomes yet at ' + OUTCOMES + ' — nothing to distill.')
  process.exit(0)
}

// --- Per-class aggregation -------------------------------------------------
const byClass = {}
for (const o of outcomes) {
  const c = o.taskClass || 'logic'
  const g = (byClass[c] = byClass[c] || { n: 0, checked: 0, passed: 0, firstTry: 0, lines: 0 })
  g.n++
  g.lines += o.lines || 0
  if (o.groundTruth === 'pass' || o.groundTruth === 'fail') {
    g.checked++
    if (o.groundTruth === 'pass') {
      g.passed++
      if ((o.iterations || 1) <= 1) g.firstTry++
    }
  }
}

function recommend(g) {
  // No runnable check seen for this class → we can't trust a delegation here yet.
  if (g.checked === 0) return ['KEEP or write a QC_CHECK first', 'no ground-truth seen — unverifiable']
  const rate = g.passed / g.checked
  if (g.checked < 3) return ['DELEGATE cautiously', `only ${g.checked} checked sample(s) — low confidence`]
  if (rate >= 0.85) return ['DELEGATE', `${Math.round(rate * 100)}% pass over ${g.checked} — qwen reliable here`]
  if (rate >= 0.6) return ['DELEGATE + strong QC_CHECK', `${Math.round(rate * 100)}% — needs ground truth + review`]
  return ['KEEP (or heavy-verify)', `${Math.round(rate * 100)}% pass — qwen unreliable on this class`]
}

// --- Failure modes: mine eval 'fail' reasons from the trace ----------------
const failReasons = readJsonl(TRACE)
  .filter((e) => e.type === 'eval' && e.verdict === 'fail' && e.reason)
  .map((e) => '- ' + e.reason.trim())
const failModes = [...new Set(failReasons)].slice(0, 20)

// --- Calibration: needs human verdicts to know if the eval was RIGHT -------
const labeled = outcomes.filter((o) => o.humanVerdict)
const falsePos = labeled.filter((o) => o.groundTruth === 'pass' && o.humanVerdict === 'revert').length
const falseNeg = labeled.filter((o) => o.groundTruth === 'fail' && o.humanVerdict === 'ship').length
const calibration = {
  updated: new Date().toISOString().slice(0, 19) + 'Z',
  totalOutcomes: outcomes.length,
  humanLabeled: labeled.length,
  evalFalsePositives: falsePos, // check said pass, human reverted
  evalFalseNegatives: falseNeg, // check said fail, human shipped anyway
  evalTrustworthiness: labeled.length
    ? +(100 * (labeled.length - falsePos - falseNeg) / labeled.length).toFixed(0)
    : null,
  note: labeled.length
    ? 'eval agreement vs human verdicts'
    : 'no human verdicts yet — run `qceval verdict <task> ship|revert` to calibrate',
}

// --- Emit rubric.md (preserve hand-edits) ----------------------------------
const projects = new Set(outcomes.map((o) => o.project)).size
let lines = []
lines.push('# QuadClaude delegation rubric')
lines.push(`_Auto-distilled by qclearn · ${calibration.updated} · ${outcomes.length} outcomes across ${projects} project(s)_`)
lines.push('')
lines.push('## Learned priors (per task class)')
lines.push('| Class | n | checked | first-try pass | recommendation | why |')
lines.push('|---|---|---|---|---|---|')
for (const [c, g] of Object.entries(byClass).sort((a, b) => b[1].n - a[1].n)) {
  const [rec, why] = recommend(g)
  const ft = g.checked ? Math.round((100 * g.firstTry) / g.checked) + '%' : '—'
  lines.push(`| ${c} | ${g.n} | ${g.checked} | ${ft} | ${rec} | ${why} |`)
}
lines.push('')
lines.push('## Failure modes seen (inject into judge/QC_CHECK prompts)')
lines.push(failModes.length ? failModes.join('\n') : '- _(none recorded yet)_')
lines.push('')
lines.push(`## Eval calibration`)
lines.push('```json')
lines.push(JSON.stringify(calibration, null, 2))
lines.push('```')
lines.push('')
lines.push(HAND_MARKER)

// Preserve anything the user wrote under the marker in the previous rubric.
let handTail = ''
if (fs.existsSync(RUBRIC)) {
  const prev = fs.readFileSync(RUBRIC, 'utf8')
  const idx = prev.indexOf(HAND_MARKER)
  if (idx >= 0) handTail = prev.slice(idx + HAND_MARKER.length)
}
if (!handTail.trim()) handTail = '\n\n_(Add your own priors/failure-modes here — they survive re-distills.)_\n'

fs.mkdirSync(DIR, { recursive: true })
fs.writeFileSync(RUBRIC, lines.join('\n') + handTail)
fs.writeFileSync(CALIB, JSON.stringify(calibration, null, 2) + '\n')

console.log(`qclearn: distilled ${outcomes.length} outcomes → ${RUBRIC}`)
console.log(`  classes: ${Object.keys(byClass).join(', ')}`)
console.log(`  calibration: ${calibration.evalTrustworthiness == null ? 'pending (no human verdicts)' : calibration.evalTrustworthiness + '% eval/human agreement'}`)

#!/usr/bin/env node
/*
 * qceval — the continuously-learning delegation evaluator (durable, app-independent).
 *
 * Memory lives in ~/.quadclaude/eval/ (home dir → survives app updates; never touched by
 * the dashboard's "clear telemetry"). Append-only, plain JSONL — portable and greppable.
 *
 * Subcommands:
 *   record     Append a labeled outcome for one delegated unit. Driven by env (QCE_*),
 *              called automatically by qcdelegate after every run. Classifies the unit,
 *              derives ground truth from the QC_CHECK exit, appends to outcomes.jsonl, and
 *              re-distills the rubric every few outcomes.
 *   suggest    `qceval suggest "<files or description>"` → the LEARNED prior for that kind
 *              of unit (DELEGATE / KEEP / needs-check) from the distilled rubric. This is
 *              the evaluator USING its memory to inform the next keep/delegate decision.
 *   verdict    `qceval verdict <task> ship|revert|edit` → record the real human outcome so
 *              calibration can learn how often the eval itself was right.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const QC = path.join(os.homedir(), '.quadclaude')
const DIR = path.join(QC, 'eval')
const OUTCOMES = path.join(DIR, 'outcomes.jsonl')
const RUBRIC = path.join(DIR, 'rubric.md')
fs.mkdirSync(DIR, { recursive: true })

// Heuristic task class from changed files + the task text. Coarse on purpose — the
// rubric just needs stable buckets to accumulate pass-rates against.
function classify(files, task) {
  const f = (files || '').toLowerCase()
  const t = (task || '').toLowerCase()
  if (/\.test\.|_test\.|spec\.|\/test\//.test(f) || /\bunit test|test suite\b/.test(t)) return 'test'
  if (/\.(json|ya?ml|toml|csv)\b/.test(f) || /\b(data|table|schema|fixture|seed|catalog)\b/.test(t)) return 'data'
  if (/\.(md|mdx|txt|rst)\b/.test(f) || /\b(doc|docs|readme|comment)\b/.test(t)) return 'docs'
  if (/\.(css|scss|less|html)\b/.test(f) || /\b(ui|component|style|layout|css|markup)\b/.test(t)) return 'ui'
  if (/\.(config|conf|env|rc|ini)\b|dockerfile|makefile|\.ya?ml\b/.test(f) || /\b(config|setup|wiring|boilerplate|scaffold)\b/.test(t)) return 'config'
  return 'logic'
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const cmd = process.argv[2]

if (cmd === 'record') {
  const e = process.env
  const files = e.QCE_FILES || ''
  const task = e.QCE_TASK || ''
  const checkExit = e.QCE_CHECK_EXIT
  const rec = {
    ts: new Date().toISOString().slice(0, 19) + 'Z',
    project: e.QCE_PROJECT || process.cwd(),
    task: task || 'untagged',
    engine: e.QCE_ENGINE || '',
    route: e.QCE_ROUTE || '',
    files,
    taskClass: classify(files, task),
    lines: (parseInt(e.QCE_INS || '0', 10) || 0) + (parseInt(e.QCE_DEL || '0', 10) || 0),
    promptChars: parseInt(e.QCE_PROMPTCHARS || '0', 10) || 0,
    groundTruth: checkExit === undefined || checkExit === '' ? 'none' : (checkExit === '0' ? 'pass' : 'fail'),
    iterations: parseInt(e.QCE_ITER || '1', 10) || 1,
    orchTokens: e.QCE_ORCHTOKENS ? parseInt(e.QCE_ORCHTOKENS, 10) : null,
    humanVerdict: null,
    source: e.QCE_SOURCE || 'qcdelegate',
  }
  fs.appendFileSync(OUTCOMES, JSON.stringify(rec) + '\n')
  // Re-distill every few outcomes so the rubric tracks reality without churn.
  const n = readJsonl(OUTCOMES).length
  if (n % 3 === 0) { try { execFileSync('qclearn', { stdio: 'ignore' }) } catch {} }
  console.error(`qceval: recorded ${rec.taskClass} outcome (${rec.groundTruth}) → eval/outcomes.jsonl [${n}]`)
  process.exit(0)
}

if (cmd === 'suggest') {
  const text = process.argv.slice(3).join(' ')
  const cls = classify(text, text)
  // Prefer the distilled rubric; fall back to computing from raw outcomes.
  const outs = readJsonl(OUTCOMES).filter((o) => o.taskClass === cls)
  const checked = outs.filter((o) => o.groundTruth === 'pass' || o.groundTruth === 'fail')
  const passed = checked.filter((o) => o.groundTruth === 'pass').length
  const rate = checked.length ? passed / checked.length : null
  let rec
  if (checked.length === 0) rec = 'KEEP or write a QC_CHECK first (no verified history for this class)'
  else if (checked.length < 3) rec = `DELEGATE cautiously (${passed}/${checked.length} verified — low sample)`
  else if (rate >= 0.85) rec = `DELEGATE (${Math.round(rate * 100)}% pass over ${checked.length})`
  else if (rate >= 0.6) rec = `DELEGATE + strong QC_CHECK (${Math.round(rate * 100)}%)`
  else rec = `KEEP / heavy-verify (${Math.round(rate * 100)}% pass — qwen weak here)`
  console.log(`class=${cls}  →  ${rec}`)
  // Surface any recorded failure modes so the decision/judge can watch for them.
  if (fs.existsSync(RUBRIC)) {
    const r = fs.readFileSync(RUBRIC, 'utf8')
    const m = r.split('## Failure modes')[1]
    if (m) {
      const fm = m.split('\n').filter((l) => l.startsWith('- ')).slice(0, 4)
      if (fm.length) console.log('watch for:\n' + fm.join('\n'))
    }
  }
  process.exit(0)
}

if (cmd === 'verdict') {
  const task = process.argv[3]
  const verdict = process.argv[4]
  if (!task || !['ship', 'revert', 'edit'].includes(verdict)) {
    console.error('usage: qceval verdict <task> ship|revert|edit')
    process.exit(2)
  }
  // Annotate the most recent outcome for this task with the real human outcome.
  const all = readJsonl(OUTCOMES)
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].task === task) { all[i].humanVerdict = verdict; break }
  }
  fs.writeFileSync(OUTCOMES, all.map((o) => JSON.stringify(o)).join('\n') + '\n')
  try { execFileSync('qclearn', { stdio: 'ignore' }) } catch {}
  console.log(`qceval: recorded human verdict '${verdict}' for task '${task}' (calibration updated)`)
  process.exit(0)
}

console.error('usage: qceval record | suggest "<text>" | verdict <task> ship|revert|edit')
process.exit(2)

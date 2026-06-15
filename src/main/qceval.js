#!/usr/bin/env node
/*
 * qceval — the continuously-learning delegation evaluator (durable, app-independent).
 *
 * Memory lives in ~/.quadclaude/eval/ (home dir → survives app updates; never touched by
 * the dashboard's "clear telemetry"). Append-only, plain JSONL — portable and greppable.
 *
 * Subcommands:
 *   record     Append a labeled outcome for one delegated unit (env QCE_*). Auto-called by
 *              qcdelegate. Classifies the unit, derives ground truth from the QC_CHECK exit.
 *   judge      `qceval judge "<task/spec>"` → run an ADVERSARIAL PANEL of independent
 *              skeptics over the working-tree diff (correctness / completeness / edge-cases),
 *              each prompted to REFUTE it, biased to flag when unsure. Emits SHIP / CAUTION /
 *              REVIEW and folds the votes into the matching outcome. This is what makes a
 *              green QC_CHECK trustworthy — it catches "passed the test but subtly wrong".
 *   suggest    `qceval suggest "<unit>"` → learned keep/delegate prior + failure modes.
 *   verdict    `qceval verdict <task> ship|revert|edit` → record the real human outcome.
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

// Resolve the OpenAI-compatible endpoint the panel judges through, from ccr's config +
// the delegation route file (same source qcdelegate uses). QC_JUDGE_MODEL overrides the
// judge model (e.g. point judging at a stronger model than the worker).
function resolveEndpoint() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-code-router', 'config.json'), 'utf8'))
    const route = fs.readFileSync(path.join(QC, 'delegation-model'), 'utf8').trim()
    const [slug, model] = route.split(',')
    const p = (cfg.Providers || []).find((x) => x.name === slug)
    if (!p || !p.api_base_url) return null
    return { base: p.api_base_url.replace(/\/chat\/completions\/?$/, ''), key: p.api_key || '', model: process.env.QC_JUDGE_MODEL || model || (p.models || [])[0] }
  } catch { return null }
}

async function askJudge(ep, lens, task, diff, failModes) {
  const sys = 'You are a meticulous adversarial code reviewer. Your job is to find why a change is WRONG, not to praise it. Be skeptical: if you are unsure whether something is correct, treat it as a defect. Reply with ONLY compact JSON: {"defect":true|false,"severity":"low|med|high","reason":"<one short sentence>"}.'
  const user = `TASK GIVEN TO THE CODER:\n${task}\n\nKNOWN FAILURE MODES from past delegations — check for these specifically:\n${failModes || '(none recorded)'}\n\nYOUR REVIEW LENS: ${lens.ask}\n\nUNIFIED DIFF UNDER REVIEW:\n${diff.slice(0, 9000)}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 60000)
  try {
    const r = await fetch(ep.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ep.key },
      body: JSON.stringify({ model: ep.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], stream: false, temperature: 0.2, max_tokens: 220 }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    const j = await r.json()
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''
    const m = txt.match(/\{[\s\S]*\}/)
    let parsed = { defect: true, severity: 'low', reason: 'unparseable judge response' }
    if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
    return { lens: lens.key, defect: !!parsed.defect, severity: parsed.severity || 'low', reason: String(parsed.reason || '').slice(0, 200) }
  } catch (e) {
    clearTimeout(t)
    return { lens: lens.key, defect: true, severity: 'low', reason: 'judge error: ' + (e && e.message || e) }
  }
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
  const n = readJsonl(OUTCOMES).length
  if (n % 3 === 0) { try { execFileSync('qclearn', { stdio: 'ignore' }) } catch {} }
  console.error(`qceval: recorded ${rec.taskClass} outcome (${rec.groundTruth}) → eval/outcomes.jsonl [${n}]`)
  process.exit(0)
}

if (cmd === 'judge') {
  ;(async () => {
    const task = process.argv.slice(3).join(' ') || '(task description not provided)'
    let diff = ''
    for (const args of [['diff', '--no-color'], ['diff', '--no-color', '--staged']]) {
      try { diff = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16e6 }); if (diff.trim()) break } catch {}
    }
    if (!diff.trim()) { console.log('qceval judge: no working-tree diff to judge.'); process.exit(0) }
    const ep = resolveEndpoint()
    if (!ep || typeof fetch !== 'function') { console.log('qceval judge: no inference endpoint (need ccr config + delegation-model).'); process.exit(0) }
    let failModes = ''
    if (fs.existsSync(RUBRIC)) { const seg = fs.readFileSync(RUBRIC, 'utf8').split('## Failure modes')[1] || ''; failModes = seg.split('\n').filter((l) => l.startsWith('- ')).slice(0, 6).join('\n') }
    const lenses = [
      { key: 'correctness', ask: 'Does this diff CORRECTLY implement the task? Trace the core logic for real bugs.' },
      { key: 'completeness', ask: 'Did it do EVERYTHING the task asked, or only part? Name anything missing, stubbed, or skipped.' },
      { key: 'edge-cases', ask: 'Find edge cases it gets wrong: off-by-one, inclusive vs exclusive bounds, null/empty/zero, mutation.' },
    ]
    const results = await Promise.all(lenses.map((l) => askJudge(ep, l, task, diff, failModes)))
    const defects = results.filter((r) => r.defect)
    const high = defects.some((r) => String(r.severity).toLowerCase() === 'high')
    const verdict = defects.length === 0 ? 'SHIP' : ((high || defects.length >= 2) ? 'REVIEW' : 'CAUTION')
    const out = []
    out.push(`\n[2m🧑‍⚖️ adversarial panel (${ep.model}) — ${defects.length}/${results.length} lenses flagged[0m`)
    for (const r of results) out.push(`  ${r.defect ? '⚠' : '✓'} ${r.lens.padEnd(13)} ${r.defect ? '[' + r.severity + '] ' : ''}${r.reason}`)
    const vcol = verdict === 'SHIP' ? 32 : verdict === 'REVIEW' ? 31 : 33
    out.push(`  [${vcol}m→ verdict: ${verdict}[0m`)
    const text = out.join('\n')
    console.log(text)
    // Mirror into the live feed so a 📡 pane shows the verdict too.
    try {
      const feeds = [path.join(QC, 'delegation.log')]
      if (process.env.QC_PANE) { fs.mkdirSync(path.join(QC, 'feed'), { recursive: true }); feeds.push(path.join(QC, 'feed', process.env.QC_PANE + '.log')) }
      for (const f of feeds) fs.appendFileSync(f, text + '\n')
    } catch {}
    // Fold the votes into the matching outcome (enriches the eval memory + future calibration).
    if (process.env.QC_TASK) {
      const all = readJsonl(OUTCOMES)
      for (let i = all.length - 1; i >= 0; i--) { if (all[i].task === process.env.QC_TASK) { all[i].judges = results; all[i].judgeVerdict = verdict; break } }
      fs.writeFileSync(OUTCOMES, all.map((o) => JSON.stringify(o)).join('\n') + '\n')
    }
    process.exit(0)
  })()
}

if (cmd === 'suggest') {
  const text = process.argv.slice(3).join(' ')
  const cls = classify(text, text)
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
  if (fs.existsSync(RUBRIC)) {
    const m = fs.readFileSync(RUBRIC, 'utf8').split('## Failure modes')[1]
    if (m) { const fm = m.split('\n').filter((l) => l.startsWith('- ')).slice(0, 4); if (fm.length) console.log('watch for:\n' + fm.join('\n')) }
  }
  process.exit(0)
}

if (cmd === 'verdict') {
  const task = process.argv[3]
  const verdict = process.argv[4]
  if (!task || !['ship', 'revert', 'edit'].includes(verdict)) { console.error('usage: qceval verdict <task> ship|revert|edit'); process.exit(2) }
  const all = readJsonl(OUTCOMES)
  for (let i = all.length - 1; i >= 0; i--) { if (all[i].task === task) { all[i].humanVerdict = verdict; break } }
  fs.writeFileSync(OUTCOMES, all.map((o) => JSON.stringify(o)).join('\n') + '\n')
  try { execFileSync('qclearn', { stdio: 'ignore' }) } catch {}
  console.log(`qceval: recorded human verdict '${verdict}' for task '${task}' (calibration updated)`)
  process.exit(0)
}

if (!['record', 'judge', 'suggest', 'verdict'].includes(cmd)) {
  console.error('usage: qceval record | judge "<task>" | suggest "<text>" | verdict <task> ship|revert|edit')
  process.exit(2)
}

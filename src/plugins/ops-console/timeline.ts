// @ts-nocheck
// Activity Timeline — the alternate renderer for OpsSnapshot.
//
// Why this exists: the lane board draws the PRESENT, and the present is empty.
// Measured over 40s of four busy sessions: queued and blocked were empty in
// 100% of frames, acting in 45%, and 47 cards produced 3 lane hops — 94% of
// cards never visibly moved. A board sized for flow rendering ~4.7 cards is
// mostly grey.
//
// So this draws TIME instead. X is elapsed seconds, now at the right, and the
// whole field drifts left at a constant rate — which means the frame is always
// moving even when occupancy is 0.06. The data does the work:
//
//   • a tool call is a capsule whose WIDTH IS ITS REAL DURATION
//   • a fork burst SPLITS its agent's lane into parallel threads that converge
//     as each one reports back
//   • an outcome lands as a pulse and leaves a marker carrying Claude's words
//   • blocked turns the whole lane amber instead of reserving an empty column
//
// createTimelineView(root, handlers) mounts into `root` (element or ShadowRoot)
// and returns { update, destroy }, matching createOpsView so a host can swap
// renderers without knowing which one it has.

const PANE_COLORS = ['#22d3ee','#4ade80','#fbbf24','#a78bfa','#f472b6','#fb923c','#38bdf8','#34d399','#f59e0b','#c084fc','#fb7185','#2dd4bf']

// Visible history, and the single most consequential number here — it sets both
// how wide a call reads and how fast the field drifts.
//
// Measured on live sessions: the median tool call is ~520ms. Over ~1700px of
// lane that is 6px at a 150s window (invisible, and "width is duration" says
// nothing) versus ~15px at 60s. Drift goes from 11px/s — which the eye reads as
// static — to ~28px/s, which reads as motion. A call longer than the window
// simply runs off the left edge, which is honest: it is still going.
const WINDOW_MS = 60000
// Lanes SHARE the available height rather than each taking a fixed slice —
// four agents on a tall window left ~700px of dead black below the last lane.
const LANE_MIN = 52
const LANE_MAX = 132
const LANE_PAD = 10
const HERO_H = 64
const RIVER_H = 58
const CAP_H = 15            // a tool-call capsule
const FORK_H = 4            // one fork thread
// A sub-second call would otherwise be invisible. This is a rendering floor for
// legibility, never a claim about duration — the label still prints the real ms.
const MIN_CAP_PX = 4

const clamp = (n, a, b) => Math.min(b, Math.max(a, n))
const fmtDur = (ms) => {
  if (ms == null) return ''
  const s = ms / 1000
  if (s < 1) return Math.round(ms) + 'ms'
  if (s < 60) return (Math.round(s * 10) / 10) + 's'
  return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's'
}
const fmtTok = (n) => {
  n = +n || 0
  return n >= 1e6 ? (Math.round(n / 1e5) / 10) + 'M' : n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n)
}
// Cheap ease for entries — facts shouldn't bounce, so this settles, never overshoots.
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3)

const hex = (c, a) => {
  const n = parseInt(c.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export function createTimelineView(root, handlers = {}) {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative;width:100%;height:100%;background:#111113;overflow:hidden'
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;width:100%;height:100%'
  wrap.appendChild(canvas)
  root.appendChild(wrap)
  const ctx = canvas.getContext('2d')

  // ---- accumulated history -------------------------------------------------
  // OpsSnapshot is instantaneous; a timeline needs the past. Everything here is
  // built by watching successive snapshots — no synthesized events.
  const segs = new Map()    // cardId  -> { pane, t0, t1, label, tag, err, tokens, kind, seen }
  const forks = new Map()   // forkKey -> { pane, t0, t1, label, seen }
  const marks = new Map()   // cardId  -> { pane, t, text, re, stat, seen }
  const blocked = new Map() // paneId  -> { since, ask }
  let agents = []
  let paneCount = 0
  let lastSnapAt = 0
  let destroyed = false
  let raf = 0

  const posOf = (pane) => {
    const a = agents.filter((x) => x.paneId === pane)[0]
    return a ? a.pos : pane
  }
  const colorOf = (pane) => PANE_COLORS[((posOf(pane) % 12) + 12) % 12]

  function update(s) {
    if (!s) return
    const now = Date.now()
    lastSnapAt = now
    agents = s.agents || []
    paneCount = s.paneCount || agents.length

    for (const c of s.cards || []) {
      // A grouped fork card carries its own threads; each becomes a strand.
      if (c.forks && c.forks.length) {
        for (const f of c.forks) {
          const key = c.id + ':' + f.id
          let g = forks.get(key)
          if (!g) {
            g = { pane: c.paneId, t0: f.startedAt || now, t1: null, label: f.label || 'fork', seen: now }
            forks.set(key, g)
          }
          if (f.done && g.t1 == null) g.t1 = now
          g.seen = now
        }
        continue
      }
      if (c.col === 'landed') {
        if (!marks.has(c.id)) marks.set(c.id, { pane: c.paneId, t: now, text: c.task || '', re: c.re || '', stat: c.stat || '', seen: now })
        continue
      }
      if (c.col === 'blocked') {
        if (!blocked.has(c.paneId)) blocked.set(c.paneId, { since: now, ask: c.ask || '' })
        continue
      }
      const id = c.id
      let g = segs.get(id)
      if (!g) {
        g = { pane: c.paneId, t0: c.startedAt || now, t1: null, label: c.task || c.tag || '', tag: c.tag || '', err: !!c.err, tokens: c.tokens, kind: c.kind || 'step', seen: now }
        segs.set(id, g)
      }
      g.label = c.task || g.label
      g.err = !!c.err
      if (c.tokens) g.tokens = c.tokens
      // The board CARRIES one card from composing into the call it produced —
      // same id, new kind. Follow that here or the call would keep rendering as
      // a thinking band forever, and its capsule would time from the wrong
      // instant. Re-basing on the tool_use timestamp is what makes the capsule
      // width the call's real duration.
      if (c.kind && c.kind !== g.kind) {
        g.kind = c.kind
        if (c.startedAt) g.t0 = c.startedAt
      }
      // Real elapsed when the result is in; otherwise it is still running.
      if (c.durMs != null) g.t1 = g.t0 + c.durMs
      else if (c.col === 'return') g.t1 = g.t1 ?? now
      g.seen = now
    }

    // Panes that are no longer blocked release their lane.
    const stillBlocked = new Set((s.cards || []).filter((c) => c.col === 'blocked').map((c) => c.paneId))
    for (const pane of [...blocked.keys()]) if (!stillBlocked.has(pane)) blocked.delete(pane)

    // ANYTHING that dropped out of the snapshot has ended. Without this a card
    // that never reports a duration — a think card, a step whose card retired
    // out of the transcript tail — keeps `t1 == null` forever and draws as a
    // capsule growing without bound, until the lane is one solid bar across the
    // whole window. Closing it at last-seen is also the honest reading: the
    // service stopped reporting it, so that is when we know it was last alive.
    const live = new Set((s.cards || []).map((c) => c.id))
    for (const [id, g] of segs) if (g.t1 == null && !live.has(id)) g.t1 = g.seen
    const liveForks = new Set()
    for (const c of s.cards || []) if (c.forks) for (const f of c.forks) liveForks.add(c.id + ':' + f.id)
    for (const [k, g] of forks) if (g.t1 == null && !liveForks.has(k)) g.t1 = g.seen

    prune(now)
  }

  function prune(now) {
    // Prune on LAST SEEN, not on end time: `t1 ?? now` can never fall below the
    // floor, so the old form leaked every unfinished item forever.
    const floor = now - WINDOW_MS - 15000
    for (const [k, g] of segs) if (Math.max(g.seen, g.t1 ?? 0) < floor) segs.delete(k)
    for (const [k, g] of forks) if (Math.max(g.seen, g.t1 ?? 0) < floor) forks.delete(k)
    for (const [k, m] of marks) if (m.t < floor) marks.delete(k)
  }

  // ---- drawing -------------------------------------------------------------
  let W = 0, H = 0, dpr = 1
  function resize() {
    const r = wrap.getBoundingClientRect()
    dpr = Math.min(3, window.devicePixelRatio || 1)
    W = Math.max(320, Math.floor(r.width))
    H = Math.max(240, Math.floor(r.height))
    canvas.width = Math.floor(W * dpr)
    canvas.height = Math.floor(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  let laneH = LANE_MIN
  const laneTop = (i) => HERO_H + LANE_PAD + i * laneH
  // Time → x. Now sits just inside the right edge so the live edge has room to glow.
  const RIGHT_PAD = 26
  const xOf = (t, now) => {
    const span = W - 132 - RIGHT_PAD
    return 132 + span - ((now - t) / WINDOW_MS) * span
  }

  function draw() {
    if (destroyed) return
    const now = Date.now()
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#111113'
    ctx.fillRect(0, 0, W, H)

    const rows = agents.slice(0, 12)
    const bodyBottom = H - RIVER_H
    const avail = bodyBottom - HERO_H - LANE_PAD * 2
    laneH = clamp(avail / Math.max(1, rows.length), LANE_MIN, LANE_MAX)
    drawGrid(now, bodyBottom)
    drawHero(now)

    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]
      const top = laneTop(i)
      if (top + laneH > bodyBottom + 2) break
      drawLane(a, i, top, now)
    }
    drawRiver(now, bodyBottom)
    drawNowEdge(now, bodyBottom)
    raf = requestAnimationFrame(draw)
  }

  function drawGrid(now, bottom) {
    // Minute marks drifting with the field: the only thing that says "this axis
    // is real time" rather than a decorative scroll.
    ctx.save()
    ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
    ctx.textBaseline = 'top'
    for (let sec = 15; sec <= WINDOW_MS / 1000; sec += 15) {
      const x = xOf(now - sec * 1000, now)
      if (x < 132) continue
      ctx.strokeStyle = 'rgba(255,255,255,.045)'
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, HERO_H)
      ctx.lineTo(Math.round(x) + 0.5, bottom)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,255,.18)'
      ctx.fillText('-' + (sec >= 60 ? sec / 60 + 'm' : sec + 's'), x + 4, HERO_H + 4)
    }
    ctx.restore()
  }

  function drawHero(now) {
    // The one line that has to survive being watched on a phone. Newest real
    // action across every agent, at display size.
    let best = null
    for (const g of segs.values()) {
      if (g.kind === 'think') continue
      if (!best || g.t0 > best.t0) best = g
    }
    for (const g of forks.values()) if (!g.t1 && (!best || g.t0 > best.t0)) best = g

    ctx.save()
    ctx.textBaseline = 'middle'
    if (best) {
      const col = colorOf(best.pane)
      const a = agents.filter((x) => x.paneId === best.pane)[0]
      const running = best.t1 == null
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.arc(24, HERO_H / 2, 4.5, 0, Math.PI * 2)
      ctx.fill()
      if (running) {
        ctx.globalAlpha = 0.28 + 0.22 * Math.sin(now / 320)
        ctx.beginPath()
        ctx.arc(24, HERO_H / 2, 9, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.font = '600 13px ui-monospace, SF Mono, Menlo, monospace'
      ctx.fillStyle = col
      const who = (a && a.name) || ('pane ' + best.pane)
      ctx.fillText(who, 38, HERO_H / 2 - 10)
      ctx.font = '500 19px ui-monospace, SF Mono, Menlo, monospace'
      ctx.fillStyle = '#f2f2f3'
      const label = trunc(ctx, best.label || '', W - 260)
      ctx.fillText(label, 38, HERO_H / 2 + 11)
      ctx.textAlign = 'right'
      ctx.font = '500 17px ui-monospace, SF Mono, Menlo, monospace'
      ctx.fillStyle = running ? '#4ade80' : 'rgba(255,255,255,.45)'
      ctx.fillText(running ? fmtDur(now - best.t0) : fmtDur(best.t1 - best.t0), W - 22, HERO_H / 2 + 5)
    } else {
      ctx.font = '500 17px ui-monospace, SF Mono, Menlo, monospace'
      ctx.fillStyle = 'rgba(255,255,255,.28)'
      ctx.fillText('all quiet', 38, HERO_H / 2)
    }
    ctx.strokeStyle = 'rgba(255,255,255,.07)'
    ctx.beginPath()
    ctx.moveTo(0, HERO_H + 0.5)
    ctx.lineTo(W, HERO_H + 0.5)
    ctx.stroke()
    ctx.restore()
  }

  function drawLane(a, i, top, now) {
    const col = colorOf(a.paneId)
    const mid = top + laneH / 2
    const blk = blocked.get(a.paneId)
    // Explicit vertical structure: the agent's own calls ride one baseline, its
    // forks hang below it. When there are no forks the calls take the middle,
    // so a lane never looks top-heavy over empty space.
    const mine = [...forks.values()].filter((f) => f.pane === a.paneId)
    const capY = Math.round(top + laneH * (mine.length ? 0.34 : 0.5))
    const forkY = Math.round(top + laneH * 0.7)
    // Nothing may draw to the right of now. Transcript timestamps can lead the
    // local clock, so a reported duration sometimes ends "in the future" — left
    // unclamped that pushes a capsule past the live edge and off the canvas.
    const nowX = xOf(now, now)

    ctx.save()
    // Blocked takes the whole lane rather than a permanent empty column: it is
    // rare, and when it happens it is the only thing that matters.
    if (blk) {
      const pulse = 0.06 + 0.05 * Math.sin(now / 420)
      ctx.fillStyle = `rgba(251,191,36,${pulse})`
      ctx.fillRect(0, top, W, laneH - 4)
      ctx.fillStyle = 'rgba(251,191,36,.85)'
      ctx.fillRect(0, top, 2.5, laneH - 4)
    }

    // identity
    ctx.font = '600 12px ui-monospace, SF Mono, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = col
    ctx.fillText(trunc(ctx, a.name || ('pane ' + a.paneId), 92), 14, mid - 8)
    ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
    ctx.fillStyle = 'rgba(255,255,255,.32)'
    const sub = blk ? 'blocked on you' : a.state === 'active' ? (a.tokPerMin ? fmtTok(a.tokPerMin) + ' tok/min' : 'working') : a.state === 'ready' ? 'awaiting you' : 'idle'
    ctx.fillText(trunc(ctx, sub, 100), 14, mid + 8)

    // lane baseline — a hairline the capsules sit on, so an idle lane still
    // reads as a lane rather than as absence.
    ctx.strokeStyle = 'rgba(255,255,255,.05)'
    ctx.beginPath()
    ctx.moveTo(132, capY + 0.5)
    ctx.lineTo(W - RIGHT_PAD, capY + 0.5)
    ctx.stroke()

    // thinking: a soft band under the capsules
    for (const g of segs.values()) {
      if (g.pane !== a.paneId || g.kind !== 'think') continue
      const x0 = xOf(g.t0, now), x1 = Math.min(nowX, xOf(g.t1 ?? now, now))
      if (x1 < 132) continue
      ctx.fillStyle = hex(col, 0.13)
      ctx.fillRect(Math.max(132, x0), capY - 2, Math.max(2, x1 - Math.max(132, x0)), 4)
    }

    // fork threads: the burst. Strands stack around the lane's midline and each
    // one ends when that fork actually reported back.
    if (mine.length) {
      mine.sort((p, q) => p.t0 - q.t0)
      const n = Math.min(mine.length, 9)
      const spread = Math.min(laneH - 22, n * (FORK_H + 2))
      mine.slice(0, n).forEach((f, k) => {
        const y = n > 1 ? forkY - spread / 2 + k * (spread / (n - 1)) : forkY
        const x0 = Math.max(132, xOf(f.t0, now))
        const x1 = Math.min(nowX, xOf(f.t1 ?? now, now))
        if (x1 < 132) return
        const grow = easeOut((now - f.t0) / 420)
        const xe = x0 + (x1 - x0) * (f.t1 ? 1 : grow || 1)
        ctx.fillStyle = f.t1 ? hex(col, 0.3) : hex(col, 0.72)
        rrect(ctx, x0, y - FORK_H / 2, Math.max(2, xe - x0), FORK_H, 1.5)
        ctx.fill()
        if (!f.t1) {
          // live head
          ctx.fillStyle = hex(col, 0.95)
          ctx.beginPath()
          ctx.arc(xe, y, 2.6, 0, Math.PI * 2)
          ctx.fill()
        }
      })
      ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
      ctx.fillStyle = hex(col, 0.7)
      const running = mine.filter((f) => !f.t1).length
      ctx.fillText(running ? running + ' forks running' : mine.length + ' forks back', 132, top + 9)
    }

    // tool-call capsules: width IS duration
    for (const g of segs.values()) {
      if (g.pane !== a.paneId || g.kind === 'think') continue
      const end = g.t1 ?? now
      let x0 = xOf(g.t0, now)
      let x1 = Math.min(nowX, xOf(end, now))
      if (x1 < 132) continue
      x0 = Math.max(132, x0)
      const w = Math.max(MIN_CAP_PX, x1 - x0)
      const running = g.t1 == null
      const y = capY - CAP_H / 2
      const appear = easeOut((now - g.seen + 400) / 400)
      ctx.globalAlpha = clamp(appear, 0.15, 1)
      const grad = ctx.createLinearGradient(0, y, 0, y + CAP_H)
      if (g.err) {
        grad.addColorStop(0, 'rgba(248,113,113,.85)')
        grad.addColorStop(1, 'rgba(248,113,113,.5)')
      } else if (running) {
        grad.addColorStop(0, hex(col, 0.95))
        grad.addColorStop(1, hex(col, 0.6))
      } else {
        grad.addColorStop(0, hex(col, 0.5))
        grad.addColorStop(1, hex(col, 0.3))
      }
      ctx.fillStyle = grad
      rrect(ctx, x0, y, w, CAP_H, 2.5)
      ctx.fill()
      // A capsule wide enough to hold its own name says what it is.
      if (w > 54) {
        ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
        ctx.fillStyle = 'rgba(10,10,11,.82)'
        ctx.fillText(trunc(ctx, g.label || g.tag, w - 10), x0 + 5, y + CAP_H / 2)
      }
      if (running) {
        ctx.fillStyle = hex(col, 0.25 + 0.2 * Math.sin(now / 260))
        rrect(ctx, x0, y, w, CAP_H, 2.5)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    // landed outcomes: one pulse, then a marker that keeps Claude's words
    for (const m of marks.values()) {
      if (m.pane !== a.paneId) continue
      const x = Math.min(nowX, xOf(m.t, now))
      if (x < 132) continue
      const age = now - m.t
      if (age < 620) {
        const p = easeOut(age / 620)
        ctx.strokeStyle = `rgba(251,191,36,${0.85 * (1 - p)})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, capY, 5 + 22 * p, 0, Math.PI * 2)
        ctx.stroke()
        ctx.lineWidth = 1
      }
      ctx.fillStyle = '#fbbf24'
      ctx.beginPath()
      ctx.arc(x, capY, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = '11px ui-monospace, SF Mono, Menlo, monospace'
      ctx.fillStyle = `rgba(251,191,36,${clamp(1 - age / WINDOW_MS, 0.25, 0.95)})`
      ctx.fillText(trunc(ctx, m.text, Math.min(300, W - RIGHT_PAD - x - 8)), x + 9, capY - 12)
      if (m.stat) {
        ctx.fillStyle = 'rgba(255,255,255,.3)'
        ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
        ctx.fillText(m.stat, x + 9, capY + 12)
      }
    }
    ctx.restore()
  }

  function drawRiver(now, top) {
    // Real output tokens per 2s bucket, summed across agents. Always growing,
    // always moving, and every pixel of it is measured.
    const series = []
    const len = Math.max(...agents.map((a) => (a.outSeries || []).length), 0)
    for (let i = 0; i < len; i++) {
      let v = 0
      for (const a of agents) v += (a.outSeries || [])[i] || 0
      series.push(v)
    }
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,.07)'
    ctx.beginPath()
    ctx.moveTo(0, top + 0.5)
    ctx.lineTo(W, top + 0.5)
    ctx.stroke()

    ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(255,255,255,.3)'
    ctx.fillText('OUTPUT — real tokens per 2s', 14, top + 9)

    const totOut = agents.reduce((x, a) => x + ((a.tokens && a.tokens.output) || 0), 0)
    const tpm = agents.reduce((x, a) => x + (a.tokPerMin || 0), 0)
    ctx.textAlign = 'right'
    ctx.font = '600 15px ui-monospace, SF Mono, Menlo, monospace'
    ctx.fillStyle = '#f2f2f3'
    ctx.fillText(fmtTok(Math.round(tpm)) + ' tok/min', W - 14, top + 8)
    ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
    ctx.fillStyle = 'rgba(255,255,255,.3)'
    ctx.fillText(fmtTok(totOut) + ' written this session', W - 14, top + 27)
    ctx.textAlign = 'left'

    if (series.length > 1) {
      const peak = Math.max(1, ...series)
      const x0 = 132, x1 = W - RIGHT_PAD
      const base = H - 8
      const h = RIVER_H - 22
      ctx.beginPath()
      ctx.moveTo(x0, base)
      series.forEach((v, i) => {
        const x = x0 + (i / (series.length - 1)) * (x1 - x0)
        ctx.lineTo(x, base - (v / peak) * h)
      })
      ctx.lineTo(x1, base)
      ctx.closePath()
      const g = ctx.createLinearGradient(0, base - h, 0, base)
      g.addColorStop(0, 'rgba(74,222,128,.55)')
      g.addColorStop(1, 'rgba(74,222,128,.05)')
      ctx.fillStyle = g
      ctx.fill()
    }
    ctx.restore()
  }

  function drawNowEdge(now, bottom) {
    const x = xOf(now, now)
    ctx.save()
    const g = ctx.createLinearGradient(x - 26, 0, x, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(1, 'rgba(255,255,255,.055)')
    ctx.fillStyle = g
    ctx.fillRect(x - 26, HERO_H, 26, bottom - HERO_H)
    ctx.strokeStyle = 'rgba(255,255,255,.22)'
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, HERO_H)
    ctx.lineTo(Math.round(x) + 0.5, bottom)
    ctx.stroke()
    // A stale stream should look stale rather than quietly frozen.
    if (lastSnapAt && Date.now() - lastSnapAt > 6000) {
      ctx.font = '10px ui-monospace, SF Mono, Menlo, monospace'
      ctx.fillStyle = 'rgba(248,113,113,.8)'
      ctx.textAlign = 'right'
      ctx.fillText('stream stalled', x - 6, HERO_H + 12)
    }
    ctx.restore()
  }

  function rrect(c, x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2)
    c.beginPath()
    c.moveTo(x + rr, y)
    c.arcTo(x + w, y, x + w, y + h, rr)
    c.arcTo(x + w, y + h, x, y + h, rr)
    c.arcTo(x, y + h, x, y, rr)
    c.arcTo(x, y, x + w, y, rr)
    c.closePath()
  }

  function trunc(c, s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    if (max <= 8) return ''
    if (c.measureText(s).width <= max) return s
    let lo = 0, hi = s.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (c.measureText(s.slice(0, mid) + '…').width <= max) lo = mid
      else hi = mid - 1
    }
    return s.slice(0, lo) + '…'
  }

  const ro = new ResizeObserver(resize)
  ro.observe(wrap)
  resize()
  raf = requestAnimationFrame(draw)

  return {
    update,
    setVerify() {},
    setScale() {},
    destroy() {
      destroyed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      wrap.remove()
    },
  }
}

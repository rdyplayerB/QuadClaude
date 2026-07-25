// Exact token accounting per session, read from the transcript's `usage` blocks.
//
// Two things make this non-trivial, and getting either wrong inflates the number:
//
//   1. DEDUPE. A single API response is appended to the transcript more than
//      once as it streams. Measured on a real session: 322 assistant records
//      carrying `usage`, but only 170 distinct `message.id`. Summing every
//      record reports 361,384 output tokens where the truth is 145,775 — 2.5x
//      too high. We key on message.id (falling back to requestId).
//
//   2. INCREMENTAL. Totals need the WHOLE file, but re-parsing a multi-MB
//      transcript every poll is not acceptable. We remember the byte offset and
//      the ids already counted, then parse only what was appended since.
//
// Validated against `ccusage@20.0.18` on session d1fec374: input 325,
// output 145,775, cacheCreation 764,575, cacheRead 30,593,223 — exact match on
// all four counters.
//
// Note `usage.iterations[]` restates the same totals as the top level (verified:
// sum(iterations.output_tokens) === output_tokens); adding it would double count.

import fs from 'fs'
import { TokenTotals } from '../types'

const ZERO: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }
const RATE_WINDOW_MS = 45000 // window for the live output-tokens/min figure
// The roster meter used to be a sine wave whose amplitude tracked PTY bytes — it
// could never show a gap, because a wave has no zero. These fixed-width buckets
// are the real thing: a bucket in which the agent produced nothing reports 0, so
// the meter goes flat exactly when the agent does.
const BUCKET_MS = 2000
const SERIES_MAX = 9 // one per bar

interface FileState {
  offset: number
  seen: Set<string>
  totals: TokenTotals
  samples: { at: number; output: number }[] // for the real rate, not a bytes proxy
  bucketAt: number      // start of the bucket currently filling
  bucketBase: number    // totals.output as of that bucket's start
  series: number[]      // closed buckets, oldest first
}

export class TokenMeter {
  private files = new Map<string, FileState>()

  /** Exact deduped totals for one transcript, parsing only newly-appended bytes. */
  read(file: string): TokenTotals {
    let st = this.files.get(file)
    if (!st) { st = { offset: 0, seen: new Set(), totals: { ...ZERO }, samples: [], bucketAt: 0, bucketBase: 0, series: [] }; this.files.set(file, st) }
    try {
      const stat = fs.statSync(file)
      // Truncated or replaced → the offset and id set no longer describe it.
      if (stat.size < st.offset) {
        st.offset = 0; st.seen.clear(); st.totals = { ...ZERO }; st.samples = []
        st.series = []; st.bucketAt = 0; st.bucketBase = 0
      }
      if (stat.size > st.offset) {
        const len = stat.size - st.offset
        const fd = fs.openSync(file, 'r')
        let text: string
        try {
          const buf = Buffer.alloc(len)
          fs.readSync(fd, buf, 0, len, st.offset)
          text = buf.toString('utf8')
        } finally {
          fs.closeSync(fd)
        }
        // Only consume through the last complete line; the tail may be mid-write.
        const cut = text.lastIndexOf('\n')
        if (cut >= 0) {
          st.offset += Buffer.byteLength(text.slice(0, cut + 1), 'utf8')
          this.consume(st, text.slice(0, cut + 1))
        }
      }
      const now = Date.now()
      st.samples.push({ at: now, output: st.totals.output })
      while (st.samples.length > 2 && now - st.samples[0].at > RATE_WINDOW_MS) st.samples.shift()

      // Close every bucket the clock has passed. A `while`, not an `if`: an idle
      // stretch must emit its real zeroes so the series stays time-aligned with
      // the bars — otherwise a pause would silently compress into one bucket.
      if (!st.bucketAt) { st.bucketAt = now; st.bucketBase = st.totals.output }
      while (now - st.bucketAt >= BUCKET_MS) {
        st.series.push(st.totals.output - st.bucketBase)
        if (st.series.length > SERIES_MAX) st.series.shift()
        st.bucketAt += BUCKET_MS
        st.bucketBase = st.totals.output
      }
    } catch { /* transcript vanished or unreadable — keep the last good totals */ }
    return { ...st.totals }
  }

  /** Real output tokens per 2s bucket, oldest first. [] if the file is unknown. */
  series(file: string): number[] {
    const st = this.files.get(file)
    return st ? st.series.slice() : []
  }

  /** Real output tokens/min over the recent window (0 when there's no movement). */
  rate(file: string): number {
    const st = this.files.get(file)
    if (!st || st.samples.length < 2) return 0
    const a = st.samples[0], b = st.samples[st.samples.length - 1]
    const dt = b.at - a.at
    if (dt < 2000) return 0
    return Math.max(0, Math.round(((b.output - a.output) / dt) * 60000))
  }

  forget(file: string) { this.files.delete(file) }

  private consume(st: FileState, chunk: string) {
    for (const raw of chunk.split('\n')) {
      const s = raw.trim()
      if (!s || s.charCodeAt(0) !== 123 /* '{' */) continue
      let d: Record<string, unknown>
      try { d = JSON.parse(s) } catch { continue }
      if (d.type !== 'assistant') continue
      const m = d.message as Record<string, unknown> | undefined
      if (!m || typeof m !== 'object') continue
      const u = m.usage as Record<string, unknown> | undefined
      if (!u || typeof u !== 'object') continue
      const id = (typeof m.id === 'string' && m.id) || (typeof d.requestId === 'string' && d.requestId) || ''
      if (!id || st.seen.has(id)) continue // the streaming duplicate lands here
      st.seen.add(id)
      const n = (k: string): number => { const v = Number(u[k]); return Number.isFinite(v) && v > 0 ? v : 0 }
      st.totals.input += n('input_tokens')
      st.totals.output += n('output_tokens')
      st.totals.cacheCreate += n('cache_creation_input_tokens')
      st.totals.cacheRead += n('cache_read_input_tokens')
    }
    st.totals.total = st.totals.input + st.totals.output + st.totals.cacheCreate + st.totals.cacheRead
  }
}

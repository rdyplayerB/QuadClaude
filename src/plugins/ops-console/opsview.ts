// @ts-nocheck
// Ops Console view — the console's rendering logic as a bundled module so it can
// render NATIVELY inside the main window's renderer process (a Shadow DOM host,
// no iframe → single-digit MB, no extra process). createOpsView(root, handlers)
// mounts into `root` (a ShadowRoot) and returns { update, setVerify, destroy }.
// All state is closure-scoped so multiple/repeat mounts are clean.

const CSS = `
:host{ /* Mirrors the QuadClaude Design System (index.css) inside the shadow.
         Legacy console names (--pane/--term/--green/--red/--blue/--teal) are
         remapped to system values so most selectors restyle automatically. */
  --bg:transparent;--scrim:rgba(15,15,16,.72);
  /* NEUTRAL gray surfaces (R≈G≈B) to match the app's #1e1e1e/#252525 — a cool
     blue-biased tint read as "a different app" against the neutral main UI. */
  --pane:var(--surface-1,rgba(30,30,32,.55));--term:var(--surface-2,rgba(40,40,42,.72));
  --line:var(--border,rgba(255,255,255,.08));--line-soft:var(--edge-soft,rgba(255,255,255,.05));--sel:rgba(34,211,238,.18);
  --fg:var(--text-1,#f0f0f1);--fg2:var(--text-2,#9d9d9f);--fg3:var(--text-3,#737375);--faint:var(--text-4,#4e4e50);--bright:#fff;
  --accent:#22d3ee;
  --green:var(--success,#4ade80);--red:var(--danger,#f87171);--teal:#22d3ee;
  --g-green:#4ade80;--g-cyan:#22d3ee;--g-yellow:#fbbf24;--g-orange:#fb923c;--amber:var(--warning,#fbbf24);
  --mono:ui-monospace,"SF Mono",Menlo,Monaco,"Courier New",monospace;--r:2px;--rp:2px; display:block; height:100%;
  /* Type comes from the app's shared scale (index.css) — custom properties
     inherit straight through the shadow boundary, so the console sizes with
     the rest of the app instead of drifting on its own hardcoded px.
     --ui-scale is pinned to 1 here because the console carries its own zoom
     (OpsOverlay), which would otherwise compound with the chrome zoom. */
  --ui-scale:1;
  /* Same gutter the terminal grid uses (GRID_PAD / getGridStyle). The console's
     panels are its "windows", so they get the app's spacing, not their own. */
  --ops-gap:20px; }
*{margin:0;padding:0;box-sizing:border-box}
.ops-host{height:100%;background:var(--bg);color:var(--fg);font-family:var(--mono);-webkit-font-smoothing:antialiased;
  padding:0;font-size:var(--fs-body);line-height:1.5;font-variant-numeric:tabular-nums;overflow:hidden;display:flex;flex-direction:column}
::selection{background:var(--sel)}
.wrap{width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.content{flex:1;min-height:0;display:flex;flex-direction:column;padding:var(--ops-gap)}
/* Console title bar. In-app it sits directly under the app's own title bar, so
   it needs no traffic-light safe area; popped out the console IS the window, so
   .ops-host.popped re-adds the 84px inset for that window's controls. */
.titlebar{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:38px;background:rgba(22,22,23,.72);border:none;border-bottom:1px solid var(--line);border-radius:0;padding:0 14px;font-size:var(--fs-body);-webkit-app-region:drag;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.recbtn,.zoomgrp{-webkit-app-region:no-drag}
.ops-host.popped .titlebar{padding-left:84px}
.zoomgrp{display:flex;align-items:center;border:1px solid var(--line);background:var(--term);border-radius:var(--r);overflow:hidden}
.zoomgrp button{border:0;background:transparent;color:var(--fg3);font-family:var(--mono);font-size:var(--fs-meta);padding:4px 8px;cursor:pointer;letter-spacing:.04em}
.zoomgrp button:hover{color:var(--fg);background:rgba(255,255,255,.06)}
.zoomgrp #zoomPct{min-width:44px;color:var(--fg2);font-variant-numeric:tabular-nums}
.tb-brand{display:flex;align-items:center;gap:8px}
.tb-brand b{font-size:var(--fs-body);color:var(--fg)} .tb-brand .v{color:var(--faint);font-size:var(--fs-meta)}
.demopill{display:none;font-size:var(--fs-meta);font-weight:700;letter-spacing:.06em;color:#1a1206;background:var(--amber);padding:2px 8px;border-radius:var(--r);text-transform:uppercase;-webkit-app-region:no-drag}
.demopill.on{display:inline-block}
.spacer{flex:1}
.recbtn{border:1px solid var(--line);background:var(--term);color:var(--fg3);font-family:var(--mono);font-size:var(--fs-meta);padding:4px 9px;border-radius:var(--r);cursor:pointer;letter-spacing:.04em}
.recbtn.on{color:var(--red);border-color:rgba(248,113,113,.5);background:rgba(248,113,113,.08)}
.recbtn.on::before{content:"● ";}
.kpis{flex:0 0 auto;display:grid;grid-template-columns:repeat(5,1fr);gap:var(--ops-gap);margin:0 0 var(--ops-gap)}
.kpi{padding:11px 14px;border:1px solid var(--line)}
.kpi.alert{border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.05)}
.kpi .lab{font-size:var(--fs-meta);color:var(--fg3)}
/* The KPI numerals were display-sized: five of them cost ~130px of height that
   the board needed more. Still the biggest thing on screen, just not by 3x. */
.kpi .val{font-size:calc(var(--fs-display) * .68);font-weight:600;margin-top:0;color:var(--bright);line-height:1.15}
.kpi .val.warn{color:var(--amber)} .kpi .val .u{font-size:var(--fs-body);color:var(--fg3);margin-left:2px}
.kpi .sub{font-size:var(--fs-meta);color:var(--fg3);margin-top:1px}
.stage{flex:1 1 auto;min-height:0;display:grid;gap:var(--ops-gap);grid-template-columns:246px minmax(0,1fr) 300px;grid-template-rows:minmax(0,1fr)}
/* min-width:0 is load-bearing: a grid item defaults to min-width:auto, so the
   board's min-content width (six lanes) refused to shrink and shoved the feed
   off the right edge instead. With this the middle track yields and every panel
   stays on screen. */
.stage>.panel{min-height:0;min-width:0;display:flex;flex-direction:column}
.stage>.panel>.phead{flex:0 0 auto}
/* Panels are WINDOWS onto the same canvas the terminal panes show, not tinted
   boxes sitting on a full-bleed sheet. background-attachment:fixed anchors the
   image to the viewport, so the picture runs continuously across every panel
   while the gaps between them stay clear — exactly how the grid behaves. The
   tint rides as a first background layer over the image. Radius and elevation
   come from the app's tokens so the console can't drift from the main window. */
.panel,.kpi{
  /* Same neutral base the terminal panes carry UNDER their wallpaper
     (glass-elevated). Without it the panels were wallpaper + scrim only, so
     they picked up whatever the photo was doing — reading cool/blue against
     the panes' warm gray. This is what makes the two surfaces the same color. */
  background-color:rgba(var(--window-tint-rgb,30,30,30),var(--window-tint,.85));
  background-image:linear-gradient(var(--ops-tint),var(--ops-tint)),var(--ops-wallpaper,none);
  background-attachment:scroll,fixed;
  background-size:auto,cover;
  background-position:center,center;
  background-repeat:no-repeat,no-repeat;
  border-radius:var(--pane-radius,12px);
  box-shadow:0 6px 18px rgba(0,0,0,calc(.40 * var(--ground-opacity,1))),
             0 2px 5px rgba(0,0,0,calc(.28 * var(--ground-opacity,1))),
             var(--specular,inset 0 1px 0 rgba(255,255,255,.09));
}
/* overflow:hidden so scrolling rows clip to the rounded corners instead of
   squaring them off — the same reason each terminal pane clips its own body. */
.panel{border:1px solid var(--line);overflow:hidden}
.phead{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line-soft)}
.phead h3{font-size:var(--fs-body);color:var(--fg2);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.phead .sub{color:var(--faint);font-weight:400;text-transform:none;letter-spacing:0;font-size:var(--fs-meta)}
#roster{flex:1 1 auto;min-height:0;overflow:auto}
.r{padding:8px 14px;border-bottom:1px solid var(--line-soft);cursor:pointer}
.r:last-child{border-bottom:0} .r:hover,.r.sel{background:rgba(255,255,255,.03)}
.r-top{display:flex;align-items:center;gap:8px}
.av{width:24px;height:24px;border-radius:2px;flex:0 0 24px;display:grid;place-items:center;font-size:var(--fs-body);font-weight:700;color:#0a0a0a}
.r-name{font-size:var(--fs-body);font-weight:600}
.r-state{margin-left:auto;font-size:var(--fs-meta);text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:2px}
.s-active{color:var(--g-green);background:rgba(74,222,128,.14)}
.s-waiting{color:var(--amber);background:rgba(251,191,36,.14)}
.s-idle{color:var(--fg3);background:rgba(255,255,255,.06)}
.r-status{display:flex;align-items:center;gap:7px;margin-top:4px;font-size:var(--fs-meta);color:var(--fg3);flex-wrap:wrap}
.gitchip{display:inline-flex;align-items:center;gap:3px;color:var(--g-green)}
.gitchip .dirty{color:var(--g-orange)}
.acct{color:var(--green)} .ctx{margin-left:auto}
.meter{display:flex;align-items:flex-end;gap:2px;height:15px;margin-top:5px}
.meter i{flex:1;background:var(--mc,var(--g-green));border-radius:1px;height:2px;min-height:2px;transition:height .45s cubic-bezier(.4,0,.2,1)}
.meter.flat i{background:var(--faint)}
.r-meterlab{display:flex;justify-content:space-between;font-size:var(--fs-meta);color:var(--faint);margin-top:3px}
.r-meterlab b{color:var(--fg3)}
/* The rail only COUNTS a parent's forks — the board names them. One row per
   fork here spent four lines restating what the grouped card already says. */
.subs:not(:empty){margin-top:5px}
.subchip{display:inline-flex;align-items:center;gap:5px;font-size:var(--fs-meta);color:var(--g-cyan);
  background:rgba(34,211,238,.10);border-radius:2px;padding:1px 6px}
.subchip.done{color:var(--fg3);background:rgba(255,255,255,.05)}
.subchip .subglyph{opacity:.8}
/* Reasoning text pulled straight from the transcript's thinking blocks. */
.thinkline{color:var(--fg3);font-style:italic;line-height:1.45;margin-bottom:4px;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.doneline.err{color:var(--red)}
.card.sub{border-left:2px solid var(--g-cyan)}
/* Real work ended, card still serving its minimum visible dwell. */
.card.spent{opacity:.5}
.card.failed{border-color:rgba(248,113,113,.45)}
.board{flex:1 1 auto;min-height:0;display:flex;gap:7px;padding:12px;overflow:auto;position:relative}
/* Lanes share the width evenly and are allowed to shrink; card text wraps
   (and breaks inside long tokens), so all six stay readable side by side
   instead of the last one scrolling out of view. */
/* Lane widths follow measured load, not symmetry. On a six-pane board RETURNED
   is occupied in 100% of frames and carries far more cards than anything else,
   so it takes two lane widths AND lays them out two-up — four times the
   capacity of a single lane in the same height. LANDED and BLOCKED are both
   episodic (23% and rare), so they share the last lane stacked. */
.col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:5px}
.col.wide{flex:2 2 0}
.colbody.grid2{display:grid;grid-template-columns:1fr 1fr;gap:5px;align-content:start}
/* The shared tail lane: LANDED over BLOCKED, each with its own head and body. */
.col.stack{gap:8px}
.col.stack .half{flex:1 1 50%;min-height:0;display:flex;flex-direction:column;gap:5px}
.col.stack .half .colbody{flex:1 1 auto;min-height:0;overflow:auto}
/* The alarm half is separated by a rule rather than a border box — empty is the
   healthy state and should not look like a container waiting to be filled. */
.col.stack .half.alarm{border-top:1px solid var(--line-soft);padding-top:6px}
.col.stack .half.alarm .colhead{border-bottom-color:rgba(251,191,36,.35)}
.colhead{position:relative;display:flex;align-items:center;justify-content:space-between;font-size:var(--fs-meta);color:var(--fg2);padding:2px 2px 5px;text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid var(--line-soft);cursor:help}
.colhead .cdot{width:7px;height:7px;border-radius:1px}
.colhead .lft{display:flex;align-items:center;gap:6px;font-weight:600}
.colhead .cn{color:var(--fg3)}
/* What each column actually means. The board is read at a glance by people who
   did not write it, and "acting" in particular is not self-evident — a column
   that is usually empty reads as broken unless you know why. */
.coltip{position:absolute;top:calc(100% + 6px);left:0;z-index:40;width:224px;
  background:var(--term);border:1px solid var(--line);border-radius:var(--r);padding:8px 9px;
  font-size:var(--fs-meta);line-height:1.5;color:var(--fg2);text-transform:none;letter-spacing:0;font-weight:400;
  box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;transform:translateY(-3px);pointer-events:none;
  transition:opacity .12s ease,transform .12s ease}
.colhead:hover .coltip{opacity:1;transform:none}
.col:last-child .coltip{left:auto;right:0}
.coltip b{color:var(--fg);font-weight:600}
@media (prefers-reduced-motion:reduce){.coltip{transition:none}}
.board-empty{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:9px;pointer-events:none;color:var(--faint);text-align:center}
.board.quiet .board-empty{display:flex}
.board-empty svg{width:26px;height:26px;opacity:.5;stroke:var(--fg3)}
.board-empty .bq-t{font-size:var(--fs-body);color:var(--fg2);letter-spacing:.01em}
.board-empty .bq-s{font-size:var(--fs-meta);color:var(--faint);max-width:260px;line-height:1.5}
/* position:relative anchors a departing card, which is pinned out of flow while
   it fades (see startLeaving) so its column closes the gap immediately and
   smoothly instead of holding an invisible slot for 250ms and then snapping. */
.colbody{position:relative;display:flex;flex-direction:column;gap:5px;min-height:20px}
.card{background:var(--term);border:1px solid var(--line);border-radius:var(--r);padding:6px 8px;will-change:transform;overflow:hidden}
.card.dim{opacity:.3}
.card.enter{animation:pop .3s ease}
@keyframes pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
.card.leaving{opacity:0;transform:scale(.96);transition:.25s}
.card.wait{border-color:rgba(251,191,36,.5);animation:waitglow 1.4s ease-in-out infinite}
@keyframes waitglow{0%,100%{box-shadow:inset 0 0 0 1px rgba(251,191,36,.35)}50%{box-shadow:inset 0 0 0 1px rgba(251,191,36,.7),inset 0 0 10px rgba(251,191,36,.18)}}
.chead{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.whodot{width:8px;height:8px;border-radius:50%;flex:0 0 8px}
.whoname{font-size:var(--fs-meta);font-weight:600}
.ctag{margin-left:auto;font-size:var(--fs-meta);text-transform:uppercase;letter-spacing:.03em;color:var(--fg3);border:1px solid var(--line);padding:1px 5px;border-radius:2px}
/* A card headline is arbitrary text from a transcript — a URL, a path, a shell
   command — so it can be one unbreakable token far wider than the lane. Break
   anywhere and clamp, or it bleeds out over the next column. */
.ct{font-size:var(--fs-body);color:var(--fg);font-weight:500;line-height:1.35;
  overflow-wrap:anywhere;word-break:break-word;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
/* LANDED: the ask this outcome answers, kept dim and to one line — the result
   is the headline, this is only the tie-back. */
.reline{font-size:var(--fs-meta);color:var(--fg3);margin-bottom:4px;line-height:1.4;
  overflow-wrap:anywhere;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.reline::before{content:"re: ";color:var(--faint)}
/* Grouped forks: one row per subagent, each with its own clock. */
.fk{display:flex;align-items:center;gap:6px;font-size:var(--fs-meta);color:var(--fg2);line-height:1.5;min-width:0}
.fk .fkg{color:var(--g-cyan);flex:0 0 auto}
.fk.done{color:var(--fg3)} .fk.done .fkg{color:var(--g-green)}
.fk .fkn{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fk .fke{flex:0 0 auto;margin-left:auto;color:var(--faint);font-variant-numeric:tabular-nums}
.fkmore{font-size:var(--fs-meta);color:var(--faint);padding-top:2px}
.updateline{font-size:var(--fs-meta);margin-top:5px;color:var(--fg3)}
.updateline .g{color:var(--green)} .updateline .add{color:var(--green)} .updateline .del{color:var(--red)} .updateline .fn{color:var(--teal)}
.workline{font-size:var(--fs-meta);color:var(--g-orange);margin-top:6px;display:flex;align-items:center;gap:5px}
.workline .sp{animation:spin 1.2s steps(8) infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.askline{font-size:var(--fs-meta);color:var(--amber);margin-top:6px;line-height:1.4;background:rgba(251,191,36,.08);border-radius:2px;padding:4px 6px}
.askline::before{content:"? "}
.doneline{font-size:var(--fs-meta);color:var(--green);margin-top:6px}
.doneline::before{content:"● "}
.cmeta{font-size:var(--fs-meta);color:var(--faint);margin-top:5px}
#cursorLayer{position:fixed;inset:0;pointer-events:none;z-index:2147483000}
.carry{position:absolute;display:flex;align-items:center;gap:4px;transition:transform .6s cubic-bezier(.3,.1,.25,1),opacity .18s}
.carry svg{width:14px;height:14px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
.carry .pill{font-size:var(--fs-meta);font-weight:700;color:#0a0a0a;padding:1px 6px;border-radius:2px;white-space:nowrap;font-family:var(--mono)}
.feed{flex:1 1 auto;min-height:0;overflow:auto}
.fi{display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line-soft)}
.fi:last-child{border-bottom:0}
.fi.new{animation:fin .5s ease}
@keyframes fin{from{opacity:0;transform:translateY(-6px);background:rgba(78,201,176,.06)}to{opacity:1;transform:none}}
.fi.incident .fmain b{color:var(--red)}
.fi .fd{width:7px;height:7px;border-radius:50%;margin-top:4px;flex:0 0 7px}
.fmain{font-size:var(--fs-body);color:var(--fg2);line-height:1.45}
.fmain b{color:var(--fg);font-weight:600}
.fmain .wait{color:var(--amber)} .fmain .done{color:var(--green)}
.fsub{font-size:var(--fs-meta);color:var(--faint);margin-top:2px;line-height:1.4}
.ftime{font-size:var(--fs-meta);color:var(--faint);margin-top:2px}
.ftime::before{content:"› "}
.foot{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;margin-top:9px;color:var(--faint);font-size:var(--fs-meta);padding:0 4px;flex-wrap:wrap;gap:8px}
#verify{position:fixed;top:56px;right:20px;z-index:2147483001;display:none;background:var(--pane);border:1px solid var(--line);border-radius:var(--rp);padding:8px 11px;font-size:var(--fs-meta);color:var(--fg2);min-width:190px}
#verify.on{display:block}
#verify .vh{display:flex;align-items:center;gap:6px;color:var(--teal);font-size:var(--fs-meta);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px}
#verify .vh::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--teal);box-shadow:0 0 6px var(--teal)}
#verify .vrow{display:flex;justify-content:space-between;gap:12px;line-height:1.7}
#verify .vk{color:var(--fg3)}
#verify .good{color:var(--g-green)} #verify .bad{color:var(--red)} #verify .warnc{color:var(--amber)}
#verify.flash{animation:vflash .5s ease}
@keyframes vflash{0%{border-color:var(--red)}100%{border-color:var(--line)}}
#connecting{position:absolute;inset:0;display:grid;place-items:center;color:var(--fg3);font-size:var(--fs-heading);background:var(--scrim)}
@media(prefers-reduced-motion:reduce){.card,.carry,.meter i{transition:none!important}.card.wait,.workline .sp{animation:none!important}}
`

const HTML = `
<div class="ops-host">
  <div id="connecting">connecting to QuadClaude…</div>
  <div class="wrap" id="app" style="display:none">
    <div class="titlebar">
      <div class="tb-brand"><b>QuadClaude</b><span class="v">activity-console</span>
        <span class="demopill" id="demopill">demo loop</span></div>
      <div class="spacer"></div>
      <div class="zoomgrp" title="Console zoom (Cmd +/−). Click % to reset.">
        <button id="zoomOut" aria-label="Zoom out">−</button>
        <button id="zoomPct" aria-label="Reset zoom">100%</button>
        <button id="zoomIn" aria-label="Zoom in">+</button>
      </div>
      <button class="recbtn" id="recBtn">REC</button>
      <button class="recbtn" id="popBtn">⇱ pop out</button>
      <button class="recbtn" id="closeBtn">✕ close</button>
    </div>
    <div class="content">
    <div class="kpis" id="kpis"></div>
    <div class="stage">
      <div class="panel"><div class="phead"><h3>AI agents <span class="sub">· your panes</span></h3><span id="rcount" class="sub" style="font-size:var(--fs-body)"></span></div><div id="roster"></div></div>
      <div class="panel"><div class="phead"><h3>activity board <span class="sub">— current state, per agent</span></h3></div><div class="board" id="board"></div></div>
      <div class="panel"><div class="phead"><h3>activity feed <span class="sub">— history</span></h3></div><div class="feed" id="feed"></div></div>
    </div>
    <div class="foot">
      <div>output meters = real output tokens per 2s, oldest bar left · a flat meter means the agent produced nothing</div>
      <div id="footmeta">states mirror the app: shell · claude-active · claude-waiting</div>
    </div>
    </div>
  </div>
  <div id="cursorLayer"></div>
  <div id="verify">
    <div class="vh">verification</div>
    <div class="vrow"><span class="vk">match rate</span><span id="v-match">—</span></div>
    <div class="vrow"><span class="vk">last / avg</span><span id="v-lat">—</span></div>
    <div class="vrow"><span class="vk">p95 latency</span><span id="v-p95">—</span></div>
    <div class="vrow"><span class="vk">missed</span><span id="v-missed">0</span></div>
    <div class="vrow"><span class="vk">phantom</span><span id="v-phantom">0</span></div>
    <div class="vrow"><span class="vk">transitions</span><span id="v-n">0</span></div>
  </div>
</div>`

export function createOpsView(root, handlers) {
  root.innerHTML = '<style>' + CSS + '</style>' + HTML
  const gid = (id) => root.querySelector('#' + id)
  const qa = (sel) => root.querySelectorAll(sel)

  const PANE_COLORS = ["#22d3ee","#4ade80","#fbbf24","#a78bfa","#f472b6","#fb923c","#38bdf8","#34d399","#f59e0b","#c084fc","#fb7185","#2dd4bf"]
  // Six lanes: work flows left to right and a card is CARRIED between them, so
  // what you watch is one thing travelling. BLOCKED is last and narrow — it is
  // an alarm, and empty is the healthy state, so it does not earn equal width.
  const COLS = [
    {k:"queued",name:"queued",c:"var(--fg3)",
     tip:"Prompts you stacked while the agent was busy. Drains itself as each one is picked up."},
    {k:"think",name:"thinking",c:"var(--g-cyan)",
     tip:"Claude is <b>streaming a message</b> — reasoning or writing — with no tool call in flight. This card is <b>carried into ACTING</b> when it issues one."},
    {k:"act",name:"acting",c:"var(--teal)",
     tip:"A tool call is <b>running</b>. Cards hold this slot briefly even after finishing — marked <i>ended</i> — so a sub-second call is still visible passing through."},
    {k:"return",name:"returned",c:"var(--green)",
     tip:"The result <b>came back</b>. Duration is real, measured start-to-result."},
    {k:"landed",name:"landed",c:"var(--g-yellow)",
     tip:"Kept outcomes: a finished turn, a pull request, a commit. The step that ends a turn <b>becomes</b> the turn's outcome here."},
    {k:"blocked",name:"blocked",c:"var(--amber)",
     tip:"Claude <b>asked you a question and stopped</b>. Nothing moves in that pane until you answer — this lane being empty is good news."},
  ]
  const ac = (pos) => PANE_COLORS[((pos%12)+12)%12]
  // 1234 -> "1.2k", 1234567 -> "1.2M"
  const fmtTok = (n) => { n=+n||0; return n>=1e6?(Math.round(n/1e5)/10)+"M":(n>=1000?(Math.round(n/100)/10)+"k":String(n)) }
  const esc = (s) => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  const initial = (n) => (n||"?").slice(0,1).toUpperCase()

  let snap=null, prev=null, selPane=null
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
  let cardEls={}, colBodies={}, agentSeries={}, kpiShown={}, kpiTarget={}, boardBuilt=false, boardRenders=0, lastSnapAt=0
  // Cards mid-exit, by id. A card can drop out of one snapshot and be back in
  // the next — a composing card whose pane briefly reports a call in flight does
  // exactly that — and at a 1s poll against a 250ms fade the old element was
  // still on screen when the new one was appended. Two elements for one card,
  // one above the other, the upper vanishing a moment later: the flicker.
  // Holding them here lets a returning card reclaim its own element instead.
  let leavingEls={}
  let verifyOn=false, prevMissedPhantom=0
  let rafId=0, destroyed=false

  // Left to right in the order work actually travels. RETURNED is double-width
  // and two-up because it holds the most cards; LANDED and BLOCKED share the
  // tail lane, landed on top.
  const FLOW = ["queued","think","act"]
  const WIDE = "return"
  const TAIL = ["landed","blocked"]
  // Most simultaneous carry arrows drawn for one tick. Measured on six real
  // panes: 4 moves in a tick happens, 6 happens once in ~90 ticks.
  const CARRY_MAX = 4
  const colOf = (k) => COLS.filter(function(c){ return c.k===k })[0]
  const headHtml = (c) =>
    '<div class="colhead"><span class="lft"><span class="cdot" style="background:'+c.c+'"></span>'+c.name+'</span>'+
    '<span class="cn" id="cn-'+c.k+'">0</span><div class="coltip">'+c.tip+'</div></div>'

  function buildShell(){
    const board=gid("board"); board.innerHTML=""
    const lane=(k,cls,bodyCls)=>{
      const c=colOf(k); if(!c) return null
      const col=document.createElement("div"); col.className=cls
      col.innerHTML=headHtml(c)
      const body=document.createElement("div"); body.className=bodyCls; body.id="cb-"+c.k
      col.appendChild(body); colBodies[c.k]=body
      return col
    }
    FLOW.forEach(function(k){ const col=lane(k,"col","colbody"); if(col) board.appendChild(col) })
    const wide=lane(WIDE,"col wide","colbody grid2"); if(wide) board.appendChild(wide)
    const stack=document.createElement("div"); stack.className="col stack"
    TAIL.forEach(function(k){
      const c=colOf(k); if(!c) return
      const half=document.createElement("div"); half.className="half"+(k==="blocked"?" alarm":"")
      half.innerHTML=headHtml(c)
      const body=document.createElement("div"); body.className="colbody"; body.id="cb-"+c.k
      half.appendChild(body); stack.appendChild(half); colBodies[c.k]=body
    })
    board.appendChild(stack)
    const empty=document.createElement("div"); empty.className="board-empty"
    empty.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'+
      '<div class="bq-t">All quiet</div>'+
      '<div class="bq-s">No agents are working right now. Delegations and Claude sessions will appear here as they move.</div>'
    board.appendChild(empty)
    boardBuilt=true
  }
  function computeKpis(s){
    const active=s.agents.filter(a=>a.state==="active").length
    const need=s.agents.filter(a=>a.state==="waiting").length
    const work=s.cards.filter(c=>c.col==="act").length
    const withCtx=s.agents.filter(a=>a.ctxPct>0)
    const ctxAvg=withCtx.length?Math.round(withCtx.reduce((x,a)=>x+a.ctxPct,0)/withCtx.length):0
    // Real: summed output tokens/min from the deduped meter, and exact session
    // totals. Previously this was PTY bytes/4 — an estimate presented as tokens.
    const tpm=Math.round(s.agents.reduce((x,a)=>x+(a.tokPerMin||0),0)/100)/10
    const totOut=s.agents.reduce((x,a)=>x+((a.tokens&&a.tokens.output)||0),0)
    return [
      {k:"agents active",v:active,u:"/"+s.paneCount,sub:"panes running claude"},
      {k:"tasks working",v:work,sub:"in claude-active"},
      {k:"needs input",v:need,warn:need>0,alert:need>0,sub:"in claude-waiting"},
      {k:"avg context",v:ctxAvg,u:"%",sub:"across active panes"},
      {k:"output",v:tpm,u:"k tok/min",sub:fmtTok(totOut)+" written this session"}
    ]
  }
  function renderKpis(s){
    const K=computeKpis(s), host=gid("kpis")
    if(!host.children.length){
      host.innerHTML=K.map((k,i)=>'<div class="kpi'+(k.alert?" alert":"")+'" id="kpi-'+i+'"><div class="lab">'+k.k+'</div><div class="val'+(k.warn?" warn":"")+'"><span id="kv-'+i+'">0</span>'+(k.u?'<span class="u">'+k.u+'</span>':'')+'</div><div class="sub">'+k.sub+'</div></div>').join("")
      K.forEach((k,i)=>{kpiShown[i]=0})
    }
    K.forEach((k,i)=>{
      const box=gid("kpi-"+i)
      if(box){ box.classList.toggle("alert",!!k.alert); const vv=box.querySelector(".val"); if(vv) vv.classList.toggle("warn",!!k.warn) }
      kpiTarget[i]=k.v
    })
  }
  function tweenKpis(){
    for(const i in kpiTarget){
      const t=kpiTarget[i]; let cur=kpiShown[i]||0
      if(Math.abs(t-cur)<0.05){ cur=t } else { cur+=(t-cur)*0.2 }
      kpiShown[i]=cur
      const el=gid("kv-"+i)
      if(el){ el.textContent=(t%1!==0||cur%1!==0)?(Math.round(cur*10)/10).toFixed(1):String(Math.round(cur)) }
    }
  }
  function renderRoster(s){
    gid("rcount").textContent=s.agents.filter(a=>a.state==="active").length+"/"+s.paneCount
    const host=gid("roster"); const seen={}
    s.agents.forEach(function(a){
      seen[a.paneId]=1; const col=ac(a.pos)
      let row=host.querySelector('.r[data-pane="'+a.paneId+'"]')
      if(!row){
        row=document.createElement("div"); row.className="r"; row.setAttribute("data-pane",a.paneId)
        row.onclick=function(){ selPane=(selPane===a.paneId?null:a.paneId); applyDim(); renderRoster(snap) }
        row.innerHTML='<div class="r-top"><div class="av"></div><span class="r-name"></span><span class="r-state"></span></div>'+
          '<div class="r-status"><span class="gitchip"></span><span class="mdl"></span><span class="acct"></span><span class="ctx"></span></div>'+
          '<div class="meter"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>'+
          '<div class="r-meterlab"><b class="tkl"></b><span class="mlab"></span></div>'+
          '<div class="subs"></div>'
        host.appendChild(row)
      }
      row.classList.toggle("sel",selPane===a.paneId)
      row.querySelector(".av").style.background=col; row.querySelector(".av").textContent=initial(a.name)
      const nm=row.querySelector(".r-name"); nm.style.color=col; nm.textContent=a.name
      const stEl=row.querySelector(".r-state"); stEl.className="r-state s-"+a.state; stEl.textContent=a.state
      row.querySelector(".gitchip").innerHTML="⎇ "+esc(a.branch?(a.branch.length>16?a.branch.slice(0,15)+"…":a.branch):"—")+(a.dirty?' <span class="dirty">●'+a.dirty+'</span>':'')
      row.querySelector(".mdl").textContent=a.model||""
      row.querySelector(".acct").textContent=a.account||""
      const ctx=row.querySelector(".ctx"); ctx.textContent="Ctx: "+(a.ctxPct?a.ctxPct+"%":"—")
      ctx.style.color=a.ctxPct===0?"var(--fg3)":a.ctxPct<=50?"var(--g-cyan)":a.ctxPct<=75?"var(--g-yellow)":"var(--red)"
      const meter=row.querySelector(".meter"); meter.classList.toggle("flat",a.state!=="active"); meter.style.setProperty("--mc",col)
      const tpm=a.tokPerMin||0
      // Queued prompts ride the status label — real queue-operation records,
      // surfaced here rather than as a fifth lane (extra lanes scored WORSE in
      // the 2026-07-25 lane study; extra sources scored better).
      const qd=a.queued?" · "+a.queued+" queued":""
      row.querySelector(".mlab").textContent=(a.state==="active"?(tpm?fmtTok(tpm)+" tok/min":"working"):(a.state==="waiting"?"blocked":(a.state==="ready"?"awaiting instruction":"idle")))+qd
      const tk=a.tokens
      row.querySelector(".tkl").textContent=tk?("↓"+fmtTok(tk.output)+" out · "+fmtTok(tk.total)+" total"):"terminal output"
      // Forks are NAMED on the board (one grouped card, one row each). Here the
      // rail only has to say the parent has some out — a row per fork cost four
      // lines to repeat what the board already spelled out.
      const subsEl=row.querySelector(".subs"); const subs=a.subagents||[]
      const runN=subs.filter(function(x){return !x.done}).length, doneN=subs.length-runN
      subsEl.innerHTML=subs.length?('<div class="subchip'+(runN?"":" done")+'"><span class="subglyph">⑂</span>'+
        (runN?runN+" fork"+(runN===1?"":"s")+" running":doneN+" fork"+(doneN===1?"":"s")+" back")+
        (runN&&doneN?" · "+doneN+" back":"")+'</div>'):""
      agentSeries[a.paneId]=a.outSeries||[]
    })
    Array.prototype.slice.call(host.querySelectorAll(".r")).forEach(function(row){ const pid=+row.getAttribute("data-pane"); if(!seen[pid]) row.remove() })
  }
  // A full-tilt agent produces roughly this many output tokens in one 2s bucket.
  // Scaling against it means a trickle reads as a trickle instead of filling the
  // meter; a pane that beats it scales against its own peak instead.
  const METER_REF=400
  function smoothMeters(){
    // Every bar is one real 2s bucket of output tokens — oldest left, newest
    // right — straight from TokenMeter.series(). This was a sine wave once: it
    // looked alive at all times, which is precisely the problem. A bucket where
    // the agent produced nothing is now 0, and the meter says so.
    qa("#roster .r").forEach(function(row){
      const pid=+row.getAttribute("data-pane")
      const s=agentSeries[pid]||[]
      const bars=row.querySelectorAll(".meter i")
      let ref=METER_REF
      for(let k=0;k<s.length;k++) if(s[k]>ref) ref=s[k]
      bars.forEach(function(b,i){
        const idx=s.length-bars.length+i        // right-align: newest bucket rightmost
        const v=idx>=0?(s[idx]||0):0
        b.style.height=(2+Math.round(16*Math.min(1,v/ref)))+"px"
      })
    })
  }
  function cardSig(c){ return [c.col,c.tag,c.task,c.kind,c.sub,c.think,c.durMs,c.tokens,c.err,c.ask,c.when,c.re,c.stat].join("|") }
  function dur(ms){ if(ms==null) return ""; const s=ms/1000; return s<1?Math.round(ms)+"ms":(s<60?(Math.round(s*10)/10)+"s":Math.floor(s/60)+"m "+Math.round(s%60)+"s") }
  function since(t){ const sec=Math.max(0,Math.floor((Date.now()-t)/1000)); return sec<60?sec+"s":Math.floor(sec/60)+"m "+(sec%60)+"s" }
  // A parent's forks as rows on ONE card: the tie to the agent is the card
  // itself (its header is the parent), and each row still says what that fork
  // is working on. Eight forks used to be eight cards filling the lane.
  const FORK_ROWS=7
  function forkBody(c){
    const list=c.forks||[]
    const rows=list.slice(0,FORK_ROWS).map(function(f){
      return '<div class="fk'+(f.done?" done":"")+'" data-since="'+(f.startedAt||0)+'">'+
        '<span class="fkg">'+(f.done?"●":"○")+'</span>'+
        '<span class="fkn">'+esc(f.label)+'</span>'+
        '<span class="fke">'+(f.done?"back":since(f.startedAt||Date.now()))+'</span></div>'
    }).join("")
    const more=list.length-FORK_ROWS
    return rows+(more>0?'<div class="fkmore">+'+more+' more</div>':"")
  }
  function cardBody(c){
    // Every line here is read off the transcript — reasoning text, real tool
    // durations, real output_tokens. Nothing on a card is synthesized.
    const think=c.think?'<div class="thinkline">'+esc(c.think)+'</div>':""
    const re=c.re?'<div class="reline">'+esc(c.re)+'</div>':""
    if(c.col==="blocked") return '<div class="askline">'+esc(c.ask||"waiting for input")+'</div>'
    if(c.forks&&c.forks.length) return forkBody(c)
    if(c.col==="think") return think+re+'<div class="workline"><span class="sp">✳</span> <span class="wtxt">composing… (<span class="wel">0s</span>)</span></div>'
    if(c.col==="act") return think+'<div class="workline"><span class="sp">✳</span> <span class="wtxt">'+(c.kind==="subagent"?"running":"in flight")+'… (<span class="wel">0s</span>'+(c.tokens?' · ↓'+c.tokens+' tok':'')+')</span></div>'
    // LANDED reads as an outcome, not another copy of the prompt: the headline
    // is what Claude said when it finished, `re:` names the ask it answers, and
    // the footer carries the turn's measured shape.
    if(c.col==="landed") return re+
      '<div class="doneline'+(c.err?" err":"")+'">'+(c.when?esc(c.when):"landed")+(c.stat?' · '+esc(c.stat):"")+'</div>'
    // returned
    return think+'<div class="doneline'+(c.err?" err":"")+'">'+(c.err?"failed":"returned")+(c.durMs!=null?' · '+dur(c.durMs):(c.when?' · '+esc(c.when):''))+(c.tokens?' · ↓'+c.tokens+' tok':'')+'</div>'
  }
  function agentFor(pane){ return (snap&&snap.agents.find(a=>a.paneId===pane))||{pos:pane,name:"pane "+pane} }
  function applyDim(){ for(const id in cardEls){ const c=cardEls[id].el._card; cardEls[id].el.classList.toggle("dim", selPane!==null && c && c.paneId!==selPane) } }

  function renderBoard(s){
    if(!boardBuilt) buildShell()
    boardRenders++
    // Measure departing cards too, so one that comes back animates from where it
    // actually was rather than popping in at its new slot.
    const first={}; for(const id in cardEls){ first[id]=cardEls[id].el.getBoundingClientRect() }
    for(const id in leavingEls){ first[id]=leavingEls[id].el.getBoundingClientRect() }
    const present={}; const moved=[]; const appeared=[]
    s.cards.forEach(function(c){
      present[c.id]=1; const a=agentFor(c.paneId); const col=ac(a.pos)
      let rec=cardEls[c.id], el
      if(!rec && leavingEls[c.id]) rec=cardEls[c.id]=reclaim(c.id)
      if(!rec){
        el=document.createElement("div"); el.className="card"+(c.col==="blocked"?" wait":"")+(c.kind==="subagent"?" sub":"")+(reduced?"":" enter"); el.setAttribute("data-id",c.id)
        el.innerHTML='<div class="chead"><span class="whodot"></span><span class="whoname"></span><span class="ctag"></span></div><div class="ct"></div><div class="cbody"></div>'
        cardEls[c.id]={el:el,sig:"",bodyEl:el.querySelector(".cbody")}
        colBodies[c.col].appendChild(el); rec=cardEls[c.id]
        if(boardRenders>1) appeared.push({id:c.id,pane:c.paneId,fromCol:"none",toCol:c.col})
      } else {
        el=rec.el
        if(el.parentNode!==colBodies[c.col]){
          const fromCol=((el.parentNode&&el.parentNode.id)||"cb-none").replace("cb-","")
          moved.push({id:c.id,pane:c.paneId,fromCol:fromCol,toCol:c.col}); colBodies[c.col].appendChild(el)
        }
      }
      el.classList.toggle("wait",c.col==="blocked"); el.classList.toggle("sub",c.kind==="subagent"); el.classList.toggle("failed",!!c.err); el.classList.toggle("spent",!!c.spent)
      el.querySelector(".whodot").style.background=col
      const wn=el.querySelector(".whoname"); wn.style.color=col; wn.textContent=a.name
      el.querySelector(".ctag").textContent=c.tag||""
      // A grouped fork card has no headline of its own — its rows are the
      // content — so the empty slot must not reserve a line.
      const ct=el.querySelector(".ct"); ct.textContent=c.task||""; ct.style.display=c.task?"":"none"
      const sig=cardSig(c)
      if(rec.sig!==sig){ rec.bodyEl.innerHTML=cardBody(c); rec.sig=sig }
      el._card=c
    })
    for(const cid in cardEls){ if(!present[cid]){ startLeaving(cid,cardEls[cid].el); delete cardEls[cid] } }
    COLS.forEach(function(c){ const n=s.cards.filter(x=>x.col===c.k).length; const e=gid("cn-"+c.k); if(e) e.textContent=n })
    const board=gid("board"); if(board) board.classList.toggle("quiet", s.cards.length===0)
    applyDim()
    requestAnimationFrame(function(){
      // Read every destination BEFORE any inverse transform goes on. The old
      // order measured, transformed, then let carry() measure again — by which
      // point the card had been shifted back to where it started, so the arrow's
      // source and destination were the same point and it never travelled.
      // Batching the reads also stops the read/write/read layout thrash.
      const dest={}
      for(const id in cardEls) dest[id]=cardEls[id].el.getBoundingClientRect()
      for(const id in cardEls){
        const el=cardEls[id].el, f=first[id], l=dest[id]; if(!f||!l) continue
        const dx=f.left-l.left, dy=f.top-l.top
        if((dx||dy)&&!reduced){ el.style.transition="none"; el.style.transform="translate("+dx+"px,"+dy+"px)"
          requestAnimationFrame((function(elx){return function(){ elx.style.transition="transform .55s cubic-bezier(.4,0,.2,1)"; elx.style.transform="" }})(el)) }
      }
      // Every hop earns an arrow, not just the first. On one pane that cost 9%
      // of moves; on six it was 48% — simultaneous hops are the norm as soon as
      // several agents are working, which is exactly when the board should look
      // busiest. Capped so a burst reads as a burst rather than a swarm, and
      // staggered so the eye can follow them.
      if(!reduced) moved.slice(0,CARRY_MAX).forEach(function(mv,i){
        const from=first[mv.id], to=dest[mv.id]
        if(!from||!to) return
        if(i===0) carry(mv,from,to)
        else setTimeout(function(){ carry(mv,from,to) }, i*90)
      })
    })
    if(verifyOn && handlers && handlers.onMove){
      const all=moved.concat(appeared)
      if(all.length){ const tRender=Date.now(), builtAt=(s&&s.ts)||tRender
        all.forEach(m=>handlers.onMove({cardId:m.id,paneId:m.pane,fromCol:m.fromCol,toCol:m.toCol,tRender:tRender,builtAt:builtAt})) }
    }
  }
  // Pin a departing card to the spot it already occupies and take it out of
  // flow, so the column reflows in the SAME frame the card leaves. The surviving
  // cards then close the gap through the FLIP pass below, instead of standing
  // still for 250ms and jumping when the invisible element is finally removed.
  function startLeaving(id, el){
    const parent=el.parentNode
    if(!parent){ el.remove(); return }
    const pr=parent.getBoundingClientRect(), r=el.getBoundingClientRect()
    el.style.position="absolute"
    el.style.left=(r.left-pr.left+parent.scrollLeft)+"px"
    el.style.top=(r.top-pr.top+parent.scrollTop)+"px"
    el.style.width=r.width+"px"
    el.classList.add("leaving")
    leavingEls[id]={el:el,t:setTimeout(function(){ el.remove(); delete leavingEls[id] },250)}
  }
  // A card that came back before its fade finished: cancel the removal, drop it
  // back into flow, and hand the caller the same element it had before.
  function reclaim(id){
    const lv=leavingEls[id]; delete leavingEls[id]
    clearTimeout(lv.t)
    const el=lv.el
    el.classList.remove("leaving")
    el.style.position=""; el.style.left=""; el.style.top=""; el.style.width=""
    return {el:el,sig:"",bodyEl:el.querySelector(".cbody")}
  }
  // Takes the source and destination rects outright — measuring them here is
  // what broke it, since by call time the card is mid-FLIP.
  function carry(mv, firstRect, last){
    if(!firstRect||!last) return
    const a=agentFor(mv.pane); const col=ac(a.pos)
    const layer=gid("cursorLayer"); if(!layer) return
    const cur=document.createElement("div"); cur.className="carry"; cur.style.opacity="0"
    cur.innerHTML='<svg viewBox="0 0 24 24" fill="'+col+'"><path d="M4 2l7 18 2.5-7.5L21 10z"/></svg><span class="pill" style="background:'+col+'">'+esc(a.name)+'</span>'
    layer.appendChild(cur)
    // The console carries its own zoom (OpsOverlay applies CSS `zoom`), and the
    // two sides of this sum are in different units: getBoundingClientRect() is
    // post-zoom viewport pixels, while a translate() inside the zoomed subtree
    // is multiplied by the zoom on the way out. At 140% every arrow landed 40%
    // too far. Measure the factor off the layer — its layout width is unzoomed,
    // its rect width is not — and convert into the layer's own space.
    const lr=layer.getBoundingClientRect()
    const z=(lr.width>0 && layer.offsetWidth>0) ? lr.width/layer.offsetWidth : 1
    const sx=(firstRect.left-lr.left)/z+12, sy=(firstRect.top-lr.top)/z+8
    const ex=(last.left-lr.left)/z+12,      ey=(last.top-lr.top)/z+8
    cur.style.transform="translate("+sx+"px,"+sy+"px)"
    requestAnimationFrame(function(){ cur.style.opacity="1"; requestAnimationFrame(function(){ cur.style.transform="translate("+ex+"px,"+ey+"px)" }) })
    setTimeout(function(){ cur.style.opacity="0"; setTimeout(()=>cur.remove(),220) }, 760)
  }
  function fmtAge(sec){ sec=Math.max(0,Math.round(sec)); if(sec<3) return "now"; if(sec<90) return sec+"s"; const m=Math.round(sec/60); if(m<90) return m+"m"; return Math.round(m/60)+"h" }
  // Incremental, in-place feed render. The old version rebuilt the list every
  // tick (detach each row into a fragment, re-append) — and re-inserting a node
  // RESTARTS its CSS animations, so `.fi.new`'s entry animation replayed on
  // every row on every tick and the whole feed appeared to blink forever.
  // Here a row that's already in the right slot is only touched to refresh its
  // age, so it animates exactly once, when it first arrives.
  function renderFeed(s){
    const host=gid("feed")
    const seen={}
    let ref=host.firstElementChild
    s.feed.forEach(function(f){
      seen[f.id]=1
      // Already in the correct position → update the age only. No re-parenting.
      if(ref && ref.getAttribute("data-fid")===f.id){
        const t=ref.querySelector(".ftime"); if(t) t.textContent=fmtAge(f.ageSec)
        ref=ref.nextElementSibling
        return
      }
      const existing=host.querySelector('[data-fid="'+f.id+'"]')
      if(existing){
        const t=existing.querySelector(".ftime"); if(t) t.textContent=fmtAge(f.ageSec)
        host.insertBefore(existing, ref)
        return
      }
      const a=agentFor(f.paneId)
      const row=document.createElement("div"); row.className="fi new"+(f.incident?" incident":""); row.setAttribute("data-fid",f.id)
      row.innerHTML='<span class="fd" style="background:'+ac(a.pos)+'"></span><div><div class="fmain">'+f.main+'</div>'+(f.sub?'<div class="fsub">'+esc(f.sub)+'</div>':'')+'<div class="ftime">'+fmtAge(f.ageSec)+'</div></div>'
      host.insertBefore(row, ref)
      // Drop the entry class once it has played, so the row can never re-animate
      // even if a later reorder does move it.
      setTimeout(function(){ row.classList.remove("new") }, 600)
    })
    // Drop rows that aged out of the snapshot.
    Array.prototype.slice.call(host.children).forEach(function(el){
      if(!seen[el.getAttribute("data-fid")]) el.remove()
    })
  }
  function tickNumbers(){
    for(const id in cardEls){
      const c=cardEls[id].el._card; if(!c) continue
      // Each fork row runs its own clock — they were spawned at different times.
      if(c.forks&&c.forks.length){
        const rows=cardEls[id].el.querySelectorAll(".fk[data-since]")
        Array.prototype.forEach.call(rows,function(r){
          if(r.classList.contains("done")) return
          const t=+r.getAttribute("data-since"); const e=r.querySelector(".fke")
          if(e&&t) e.textContent=since(t)
        })
        continue
      }
      if(c.col!=="act"&&c.col!=="think") continue
      const el=cardEls[id].el.querySelector(".wel"); if(el&&c.startedAt){ const ms=Date.now()-c.startedAt; const sec=Math.floor(ms/1000); el.textContent=sec<60?sec+"s":(Math.floor(sec/60)+"m "+(sec%60)+"s") }
    }
  }
  function render(s){
    gid("connecting").style.display="none"; gid("app").style.display=""
    prev=snap; snap=s; lastSnapAt=Date.now()
    gid("footmeta").textContent=s.recordMode?"record mode · deterministic demo loop":"states mirror the app: shell · claude-active · claude-waiting"
    gid("demopill").classList.toggle("on",!!s.recordMode)
    renderKpis(s); renderRoster(s); renderBoard(s); renderFeed(s)
  }
  function renderVerify(o){
    verifyOn=!!(o&&o.on); const box=gid("verify"); box.classList.toggle("on",verifyOn)
    if(!verifyOn) return
    const rate=o.n>0?Math.round(o.represented/o.n*100):100
    const mEl=gid("v-match"); mEl.textContent=rate+"% ("+o.represented+"/"+o.n+")"; mEl.className=rate>=95?"good":rate>=80?"warnc":"bad"
    gid("v-lat").textContent=(o.lastMs!=null?o.lastMs+"ms":"—")+" / "+(o.avgMs!=null?o.avgMs+"ms":"—")
    gid("v-p95").textContent=o.p95Ms!=null?o.p95Ms+"ms":"—"
    const miss=gid("v-missed"); miss.textContent=o.missed; miss.className=o.missed>0?"bad":""
    const ph=gid("v-phantom"); ph.textContent=o.phantom; ph.className=o.phantom>0?"bad":""
    gid("v-n").textContent=o.n
    const mp=o.missed+o.phantom
    if(mp>prevMissedPhantom){ box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash") }
    prevMissedPhantom=mp
  }
  let lastFrame=0
  function loop(ts){
    if(destroyed) return
    rafId=requestAnimationFrame(loop)
    if(document.hidden) return
    if((ts||0)-lastFrame < 45) return
    lastFrame=ts||0
    smoothMeters(); tweenKpis(); tickNumbers()
  }

  // record toggle
  let recOn=false
  gid("recBtn").onclick=function(){ recOn=!recOn; this.classList.toggle("on",recOn); if(handlers&&handlers.onRecord) handlers.onRecord(recOn) }
  gid("closeBtn").onclick=function(){ if(handlers&&handlers.onClose) handlers.onClose() }
  // Pop out / pop in. The same button flips meaning depending on which surface
  // is hosting the view: the in-app overlay offers "pop out", the standalone
  // window offers "pop in" (which destroys that window so its memory is freed).
  var popped=!!(handlers&&handlers.popped)
  if(popped){ var oh=root.querySelector(".ops-host"); if(oh) oh.classList.add("popped") }
  var popBtn=gid("popBtn")
  popBtn.textContent = popped ? "⇲ pop in" : "⇱ pop out"
  popBtn.title = popped
    ? "Put the console back inside the QuadClaude window and close this one"
    : "Move the console into its own window"
  popBtn.onclick=function(){
    if(!handlers) return
    if(popped){ if(handlers.onPopIn) handlers.onPopIn() }
    else if(handlers.onPopOut) handlers.onPopOut()
  }

  // Zoom. The host (OpsOverlay) owns the value and persists it; the view only
  // reports intent and reflects what it's told, so Cmd +/− and these buttons
  // stay in agreement. setScale() is returned for the host to drive.
  const clampScale=(n)=>Math.min(1.8,Math.max(0.8,Math.round(n*10)/10))
  let scale=(handlers&&handlers.initialScale)||1
  const emitScale=(n)=>{ scale=clampScale(n); gid("zoomPct").textContent=Math.round(scale*100)+"%"
    if(handlers&&handlers.onScale) handlers.onScale(scale) }
  gid("zoomOut").onclick=()=>emitScale(scale-0.1)
  gid("zoomIn").onclick=()=>emitScale(scale+0.1)
  gid("zoomPct").onclick=()=>emitScale(1)
  gid("zoomPct").textContent=Math.round(scale*100)+"%"

  rafId=requestAnimationFrame(loop)

  return {
    update(s){ try{ render(s) }catch(e){ /* ignore */ } },
    setVerify(o){ renderVerify(o) },
    // Reflect a scale set elsewhere (Cmd +/−) without re-emitting it.
    setScale(n){ scale=clampScale(n); gid("zoomPct").textContent=Math.round(scale*100)+"%" },
    destroy(){ destroyed=true; cancelAnimationFrame(rafId); for(const id in leavingEls) clearTimeout(leavingEls[id].t); leavingEls={}; root.innerHTML="" },
  }
}

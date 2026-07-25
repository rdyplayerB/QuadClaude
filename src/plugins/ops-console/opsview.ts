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
  --ui-scale:1; }
*{margin:0;padding:0;box-sizing:border-box}
.ops-host{height:100%;background:var(--bg);color:var(--fg);font-family:var(--mono);-webkit-font-smoothing:antialiased;
  padding:0;font-size:var(--fs-body);line-height:1.5;font-variant-numeric:tabular-nums;overflow:hidden;display:flex;flex-direction:column}
::selection{background:var(--sel)}
.wrap{width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.content{flex:1;min-height:0;display:flex;flex-direction:column;padding:12px 14px 14px}
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
.kpis{flex:0 0 auto;display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:0 0 10px}
.kpi{padding:9px 11px;background:var(--pane);border:1px solid var(--line);border-radius:var(--rp)}
.kpi.alert{border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.05)}
.kpi .lab{font-size:var(--fs-meta);color:var(--fg3)}
.kpi .val{font-size:var(--fs-display);font-weight:600;margin-top:3px;color:var(--bright)}
.kpi .val.warn{color:var(--amber)} .kpi .val .u{font-size:var(--fs-body);color:var(--fg3);margin-left:2px}
.kpi .sub{font-size:var(--fs-meta);color:var(--fg3);margin-top:3px}
.stage{flex:1 1 auto;min-height:0;display:grid;gap:8px;grid-template-columns:270px 1fr 322px;grid-template-rows:minmax(0,1fr)}
.stage>.panel{min-height:0;display:flex;flex-direction:column}
.stage>.panel>.phead{flex:0 0 auto}
.panel{background:var(--pane);border:1px solid var(--line);border-radius:var(--rp)}
.phead{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid var(--line-soft)}
.phead h3{font-size:var(--fs-body);color:var(--fg2);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.phead .sub{color:var(--faint);font-weight:400;text-transform:none;letter-spacing:0;font-size:var(--fs-meta)}
.live{font-size:var(--fs-meta);letter-spacing:.06em;color:var(--accent);display:inline-flex;align-items:center;gap:5px;text-transform:uppercase;font-weight:600}
.live::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);animation:pulse 1.6s infinite}
@keyframes pulse{50%{opacity:.35}}
#roster{flex:1 1 auto;min-height:0;overflow:auto}
.r{padding:10px 12px;border-bottom:1px solid var(--line-soft);cursor:pointer}
.r:last-child{border-bottom:0} .r:hover,.r.sel{background:rgba(255,255,255,.03)}
.r-top{display:flex;align-items:center;gap:8px}
.av{width:24px;height:24px;border-radius:2px;flex:0 0 24px;display:grid;place-items:center;font-size:var(--fs-body);font-weight:700;color:#0a0a0a}
.r-name{font-size:var(--fs-body);font-weight:600}
.r-state{margin-left:auto;font-size:var(--fs-meta);text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:2px}
.s-active{color:var(--g-green);background:rgba(74,222,128,.14)}
.s-waiting{color:var(--amber);background:rgba(251,191,36,.14)}
.s-idle{color:var(--fg3);background:rgba(255,255,255,.06)}
.r-status{display:flex;align-items:center;gap:7px;margin-top:6px;font-size:var(--fs-meta);color:var(--fg3);flex-wrap:wrap}
.gitchip{display:inline-flex;align-items:center;gap:3px;color:var(--g-green)}
.gitchip .dirty{color:var(--g-orange)}
.acct{color:var(--green)} .ctx{margin-left:auto}
.meter{display:flex;align-items:flex-end;gap:2px;height:20px;margin-top:8px}
.meter i{flex:1;background:var(--mc,var(--g-green));border-radius:1px;height:2px;min-height:2px}
.meter.flat i{background:var(--faint)}
.r-meterlab{display:flex;justify-content:space-between;font-size:var(--fs-meta);color:var(--faint);margin-top:3px}
.r-meterlab b{color:var(--fg3)}
.board{flex:1 1 auto;min-height:0;display:flex;gap:8px;padding:10px;overflow:auto;position:relative}
.col{flex:1;min-width:176px;display:flex;flex-direction:column;gap:7px}
.colhead{display:flex;align-items:center;justify-content:space-between;font-size:var(--fs-meta);color:var(--fg2);padding:2px 2px 5px;text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid var(--line-soft)}
.colhead .cdot{width:7px;height:7px;border-radius:1px}
.colhead .lft{display:flex;align-items:center;gap:6px;font-weight:600}
.colhead .cn{color:var(--fg3)}
.board-empty{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:9px;pointer-events:none;color:var(--faint);text-align:center}
.board.quiet .board-empty{display:flex}
.board-empty svg{width:26px;height:26px;opacity:.5;stroke:var(--fg3)}
.board-empty .bq-t{font-size:var(--fs-body);color:var(--fg2);letter-spacing:.01em}
.board-empty .bq-s{font-size:var(--fs-meta);color:var(--faint);max-width:260px;line-height:1.5}
.colbody{display:flex;flex-direction:column;gap:7px;min-height:20px}
.card{background:var(--term);border:1px solid var(--line);border-radius:var(--r);padding:8px 9px;will-change:transform}
.card.dim{opacity:.3}
.card.enter{animation:pop .3s ease}
@keyframes pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
.card.leaving{opacity:0;transform:scale(.96);transition:.25s}
.card.wait{border-color:rgba(251,191,36,.5);animation:waitglow 1.4s ease-in-out infinite}
@keyframes waitglow{0%,100%{box-shadow:inset 0 0 0 1px rgba(251,191,36,.35)}50%{box-shadow:inset 0 0 0 1px rgba(251,191,36,.7),inset 0 0 10px rgba(251,191,36,.18)}}
.chead{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.whodot{width:8px;height:8px;border-radius:50%;flex:0 0 8px}
.whoname{font-size:var(--fs-meta);font-weight:600}
.ctag{margin-left:auto;font-size:var(--fs-meta);text-transform:uppercase;letter-spacing:.03em;color:var(--fg3);border:1px solid var(--line);padding:1px 5px;border-radius:2px}
.ct{font-size:var(--fs-body);color:var(--fg);font-weight:500;line-height:1.35}
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
.fi{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line-soft)}
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
@media(prefers-reduced-motion:reduce){.card,.carry,.meter i{transition:none!important}.card.wait,.workline .sp,.live::before{animation:none!important}}
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
      <div class="panel"><div class="phead"><h3>activity board <span class="sub">— current state, per agent</span></h3><span class="live">live</span></div><div class="board" id="board"></div></div>
      <div class="panel"><div class="phead"><h3>activity feed <span class="sub">— history</span></h3><span class="live">live</span></div><div class="feed" id="feed"></div></div>
    </div>
    <div class="foot">
      <div>output meters = live tokens/sec per pane · a flat meter means the agent is waiting on you</div>
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
  const COLS = [{k:"queued",name:"queued",c:"var(--fg3)"},{k:"work",name:"working",c:"var(--teal)"},{k:"need",name:"needs input",c:"var(--amber)"},{k:"done",name:"done",c:"var(--green)"}]
  const ac = (pos) => PANE_COLORS[((pos%12)+12)%12]
  const esc = (s) => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  const initial = (n) => (n||"?").slice(0,1).toUpperCase()

  let snap=null, prev=null, selPane=null
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
  let cardEls={}, colBodies={}, agentTps={}, agentTpsShown={}, kpiShown={}, kpiTarget={}, boardBuilt=false, boardRenders=0, lastSnapAt=0
  let verifyOn=false, prevMissedPhantom=0
  let rafId=0, destroyed=false

  function buildShell(){
    const board=gid("board"); board.innerHTML=""
    COLS.forEach(function(c){
      const col=document.createElement("div"); col.className="col"
      col.innerHTML='<div class="colhead"><span class="lft"><span class="cdot" style="background:'+c.c+'"></span>'+c.name+'</span><span class="cn" id="cn-'+c.k+'">0</span></div>'
      const body=document.createElement("div"); body.className="colbody"; body.id="cb-"+c.k
      col.appendChild(body); board.appendChild(col); colBodies[c.k]=body
    })
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
    const work=s.cards.filter(c=>c.col==="work").length
    const withCtx=s.agents.filter(a=>a.ctxPct>0)
    const ctxAvg=withCtx.length?Math.round(withCtx.reduce((x,a)=>x+a.ctxPct,0)/withCtx.length):0
    const tpm=Math.round(s.agents.reduce((x,a)=>x+a.tps,0)*60/1000*10)/10
    return [
      {k:"agents active",v:active,u:"/"+s.paneCount,sub:"panes running claude"},
      {k:"tasks working",v:work,sub:"in claude-active"},
      {k:"needs input",v:need,warn:need>0,alert:need>0,sub:"in claude-waiting"},
      {k:"avg context",v:ctxAvg,u:"%",sub:"across active panes"},
      {k:"output",v:tpm,u:"k tok/min",sub:"live across fleet"}
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
          '<div class="r-meterlab"><b>output · tok/s</b><span class="mlab"></span></div>'
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
      row.querySelector(".mlab").textContent=a.state==="active"?Math.round(a.tps)+" tok/s":(a.state==="waiting"?"0 tok/s · waiting":"idle")
      agentTps[a.paneId]=a.state==="active"?a.tps:0
    })
    Array.prototype.slice.call(host.querySelectorAll(".r")).forEach(function(row){ const pid=+row.getAttribute("data-pane"); if(!seen[pid]) row.remove() })
  }
  function smoothMeters(){
    // A calm equalizer, not per-frame noise: each pane's bars undulate as one
    // gentle, phase-shifted wave whose overall HEIGHT tracks that pane's real
    // output (tokens/sec). Tall = producing a lot; flat = waiting on you.
    const t=performance.now()/1000
    qa("#roster .r").forEach(function(row){
      const pid=+row.getAttribute("data-pane"); const target=agentTps[pid]||0
      const bars=row.querySelectorAll(".meter i")
      if(target<=0){ if(!row._flat){ row._flat=true; bars.forEach(function(b){b.style.height="2px"}) } return }
      row._flat=false
      let shown=agentTpsShown[pid]||0; shown+=(target-shown)*0.06; agentTpsShown[pid]=shown // ease amplitude
      const amp=Math.min(1,shown/150)
      bars.forEach(function(b,i){
        const wave=0.5+0.5*Math.sin(t*1.9 + i*0.55)   // slow travelling wave, per-bar phase
        b.style.height=(3+amp*13*(0.4+0.6*wave)).toFixed(1)+"px"
      })
    })
  }
  function cardSig(c){ return [c.col,c.tag,c.task,c.file,c.add,c.del,c.word,c.ask,c.when].join("|") }
  function cardBody(c){
    if(c.col==="work") return '<div class="updateline"><span class="g">●</span> Update(<span class="fn">'+esc(c.file||"session")+'</span>) <span class="add">+'+(c.add||0)+'</span>'+((c.del)?' <span class="del">−'+c.del+'</span>':'')+'</div>'+
      '<div class="workline"><span class="sp">✳</span> <span class="wtxt">'+esc(c.word||"Working")+'… (<span class="wel">0s</span> · ↓<span class="wtok">'+(c.tokens||0)+'</span>k tokens)</span></div>'
    if(c.col==="need") return '<div class="askline">'+esc(c.ask||"waiting for input")+'</div>'
    if(c.col==="done") return '<div class="doneline">completed · '+esc(c.when||"just now")+'</div>'
    return '<div class="cmeta">queued — starts when the pane frees up</div>'
  }
  function agentFor(pane){ return (snap&&snap.agents.find(a=>a.paneId===pane))||{pos:pane,name:"pane "+pane} }
  function applyDim(){ for(const id in cardEls){ const c=cardEls[id].el._card; cardEls[id].el.classList.toggle("dim", selPane!==null && c && c.paneId!==selPane) } }

  function renderBoard(s){
    if(!boardBuilt) buildShell()
    boardRenders++
    const first={}; for(const id in cardEls){ first[id]=cardEls[id].el.getBoundingClientRect() }
    const present={}; const moved=[]; const appeared=[]
    s.cards.forEach(function(c){
      present[c.id]=1; const a=agentFor(c.paneId); const col=ac(a.pos)
      let rec=cardEls[c.id], el
      if(!rec){
        el=document.createElement("div"); el.className="card"+(c.col==="need"?" wait":"")+(reduced?"":" enter"); el.setAttribute("data-id",c.id)
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
      el.classList.toggle("wait",c.col==="need")
      el.querySelector(".whodot").style.background=col
      const wn=el.querySelector(".whoname"); wn.style.color=col; wn.textContent=a.name
      el.querySelector(".ctag").textContent=c.tag||""
      el.querySelector(".ct").textContent=c.task||""
      const sig=cardSig(c)
      if(rec.sig!==sig){ rec.bodyEl.innerHTML=cardBody(c); rec.sig=sig }
      el._card=c
    })
    for(const cid in cardEls){ if(!present[cid]){ const r=cardEls[cid]; r.el.classList.add("leaving"); (function(el){setTimeout(()=>el.remove(),250)})(r.el); delete cardEls[cid] } }
    COLS.forEach(function(c){ const n=s.cards.filter(x=>x.col===c.k).length; const e=gid("cn-"+c.k); if(e) e.textContent=n })
    const board=gid("board"); if(board) board.classList.toggle("quiet", s.cards.length===0)
    applyDim()
    requestAnimationFrame(function(){
      for(const id in cardEls){
        const el=cardEls[id].el, f=first[id]; if(!f) continue
        const l=el.getBoundingClientRect(); const dx=f.left-l.left, dy=f.top-l.top
        if((dx||dy)&&!reduced){ el.style.transition="none"; el.style.transform="translate("+dx+"px,"+dy+"px)"
          requestAnimationFrame((function(elx){return function(){ elx.style.transition="transform .55s cubic-bezier(.4,0,.2,1)"; elx.style.transform="" }})(el)) }
      }
      if(moved.length&&!reduced) carry(moved[0], first[moved[0].id])
    })
    if(verifyOn && handlers && handlers.onMove){
      const all=moved.concat(appeared)
      if(all.length){ const tRender=Date.now(), builtAt=(s&&s.ts)||tRender
        all.forEach(m=>handlers.onMove({cardId:m.id,paneId:m.pane,fromCol:m.fromCol,toCol:m.toCol,tRender:tRender,builtAt:builtAt})) }
    }
  }
  function carry(mv, firstRect){
    const el=cardEls[mv.id] && cardEls[mv.id].el; if(!el||!firstRect) return
    const a=agentFor(mv.pane); const col=ac(a.pos)
    const last=el.getBoundingClientRect(); const layer=gid("cursorLayer")
    const cur=document.createElement("div"); cur.className="carry"; cur.style.opacity="0"
    cur.innerHTML='<svg viewBox="0 0 24 24" fill="'+col+'"><path d="M4 2l7 18 2.5-7.5L21 10z"/></svg><span class="pill" style="background:'+col+'">'+esc(a.name)+'</span>'
    layer.appendChild(cur)
    const sx=firstRect.left+12, sy=firstRect.top+8, ex=last.left+12, ey=last.top+8
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
    const since=snap?(Date.now()-lastSnapAt):0
    for(const id in cardEls){
      const c=cardEls[id].el._card; if(!c||c.col!=="work") continue
      const el=cardEls[id].el.querySelector(".wel"); if(el&&c.elapsedMs!=null){ const ms=c.elapsedMs+since; const sec=Math.floor(ms/1000); el.textContent=sec<60?sec+"s":(Math.floor(sec/60)+"m "+(sec%60)+"s") }
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
    destroy(){ destroyed=true; cancelAnimationFrame(rafId); root.innerHTML="" },
  }
}

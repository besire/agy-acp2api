/**
 * agy2api Web Console — Material Design 3
 *
 * Single-file SPA served at `/` and `/dashboard`. Pulls `/api/admin/overview` every 2s.
 * Sections: 首页 (overview) · 请求 (requests & sessions telemetry) · 运行 (workers & live sessions) · 设置.
 *
 * NOTE: The markup is wrapped in `String.raw`, so the embedded client script must never
 * contain backticks or `${` sequences.
 */
const DASHBOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>agy2api</title>
<link rel="icon" type="image/svg+xml" href="./favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,400;8..144,500;8..144,600&family=Roboto+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400,0..1,0&display=block" />
<script>
  (function () {
    var t = localStorage.getItem("agy-theme");
    if (!t) t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    var l = localStorage.getItem("agy-layout");
    if (l === "top" || l === "side") document.documentElement.setAttribute("data-layout", l);
    var emb = location.pathname.indexOf("/v0/resource/plugins/") === 0;
    if (!emb) { try { emb = window.self !== window.top; } catch (e) {} }
    if (emb) document.documentElement.setAttribute("data-embedded", "cpa");
  })();
</script>
<style>
  /* ---------- MD3 tokens (baseline scheme) ---------- */
  html[data-theme="dark"] {
    color-scheme: dark;
    --primary:#D0BCFF; --on-primary:#381E72; --primary-container:#4F378B; --on-primary-container:#EADDFF;
    --secondary:#CCC2DC; --secondary-container:#4A4458; --on-secondary-container:#E8DEF8;
    --tertiary:#EFB8C8; --tertiary-container:#633B48; --on-tertiary-container:#FFD8E4;
    --error:#F2B8B5; --on-error:#601410; --error-container:#8C1D18; --on-error-container:#F9DEDC;
    --surface:#141218; --on-surface:#E6E0E9; --on-surface-variant:#CAC4D0;
    --outline:#938F99; --outline-variant:#49454F;
    --sc-lowest:#0F0D13; --sc-low:#1D1B20; --sc:#211F26; --sc-high:#2B2930; --sc-highest:#36343B;
    --inverse-surface:#E6E0E9; --inverse-on-surface:#322F35;
    --success:#7DDC8B; --success-container:#1E4F2B; --on-success-container:#A6F5B0;
    --warning:#F5BE5B; --warning-container:#5C4100; --on-warning-container:#FFDEA6;
    --c-out:#7DD6CF; --c-think:#9A93A8;
  }
  html[data-theme="light"] {
    color-scheme: light;
    --primary:#6750A4; --on-primary:#FFFFFF; --primary-container:#EADDFF; --on-primary-container:#21005D;
    --secondary:#625B71; --secondary-container:#E8DEF8; --on-secondary-container:#1D192B;
    --tertiary:#7D5260; --tertiary-container:#FFD8E4; --on-tertiary-container:#31111D;
    --error:#B3261E; --on-error:#FFFFFF; --error-container:#F9DEDC; --on-error-container:#410E0B;
    --surface:#FEF7FF; --on-surface:#1D1B20; --on-surface-variant:#49454F;
    --outline:#79747E; --outline-variant:#CAC4D0;
    --sc-lowest:#FFFFFF; --sc-low:#F7F2FA; --sc:#F3EDF7; --sc-high:#ECE6F0; --sc-highest:#E6E0E9;
    --inverse-surface:#322F35; --inverse-on-surface:#F5EFF7;
    --success:#2E7D32; --success-container:#C8F0CC; --on-success-container:#0A3A12;
    --warning:#8F5A00; --warning-container:#FFDDB0; --on-warning-container:#2D1A00;
    --c-out:#00696A; --c-think:#A59DB3;
  }
  :root {
    --font: "Roboto Flex", Roboto, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    --mono: "Roboto Mono", ui-monospace, Consolas, monospace;
    --ease: cubic-bezier(.2,0,0,1);
  }

  * { box-sizing: border-box; }
  body { margin:0; background:var(--surface); color:var(--on-surface); font:14px/1.45 var(--font); -webkit-font-smoothing:antialiased; }
  button, input, select { font-family: inherit; }
  .ms { font-family:"Material Symbols Rounded"; font-weight:normal; font-style:normal; font-size:20px; line-height:1;
        display:inline-block; white-space:nowrap; direction:ltr; user-select:none; -webkit-font-smoothing:antialiased;
        font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24; }
  .fill { font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; }
  .mono { font-family:var(--mono); font-size:12.5px; }
  .muted { color:var(--on-surface-variant); }
  .strong { font-weight:600; }
  .grow { flex:1; }
  .r { text-align:right; } .c { text-align:center; }
  ::-webkit-scrollbar { width:8px; height:8px; }
  ::-webkit-scrollbar-thumb { background:var(--outline-variant); border-radius:4px; }
  ::-webkit-scrollbar-track { background:transparent; }

  /* ---------- Layout ---------- */
  .app { display:flex; min-height:100vh; }
  .drawer { width:240px; flex:none; position:sticky; top:0; height:100vh; padding:12px; display:flex; flex-direction:column; gap:2px; background:var(--sc-low); }
  .brand { display:flex; align-items:center; gap:12px; height:56px; padding:0 16px; margin-bottom:8px; font-size:18px; font-weight:600; }
  .brand-logo { width:32px; height:32px; border-radius:8px; display:block; }
  .nav-item { display:flex; align-items:center; gap:12px; height:56px; padding:0 16px; border-radius:28px; color:var(--on-surface-variant);
              text-decoration:none; font-weight:500; position:relative; transition:background .15s; }
  .nav-item:hover { background:color-mix(in srgb, var(--on-surface) 8%, transparent); }
  .nav-item.active { background:var(--secondary-container); color:var(--on-secondary-container); }
  .nav-item.active .ms { font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; }
  .nav-ic { position:relative; display:grid; place-items:center; }
  .badge { position:absolute; top:-6px; right:-10px; min-width:16px; height:16px; padding:0 4px; border-radius:8px; background:var(--primary);
           color:var(--on-primary); font-size:11px; font-weight:600; line-height:16px; text-align:center; display:none; }
  .badge.on { display:block; }
  .badge.err { background:var(--error); color:var(--on-error); }

  .content { flex:1; min-width:0; padding:8px 28px 40px; }
  .topbar { display:flex; align-items:center; gap:8px; height:64px; position:sticky; top:0; z-index:10; background:var(--surface); }
  .topbar h1 { margin:0; font-size:24px; font-weight:400; }

  .page { display:none; flex-direction:column; gap:16px; }
  .page.on { display:flex; animation:fade .2s var(--ease); }
  @keyframes fade { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }

  .grid { display:grid; gap:16px; }
  .kpis { grid-template-columns:repeat(4, minmax(0,1fr)); }
  .two { grid-template-columns:repeat(2, minmax(0,1fr)); }
  .home-bottom { grid-template-columns:minmax(0,3fr) minmax(0,2fr); }
  .workers { grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); }
  .settings { grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); align-items:start; }

  /* ---------- Surfaces ---------- */
  .card { background:var(--sc); border-radius:16px; padding:20px; min-width:0; }
  .card.flush { padding:0; overflow:hidden; }
  .card-h { display:flex; align-items:center; gap:12px; font-size:16px; font-weight:500; margin-bottom:16px; }
  .ic { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; flex:none; }
  .ic.sm { width:32px; height:32px; border-radius:10px; }
  .ic.sm .ms { font-size:18px; }

  .t-primary { background:var(--primary-container); color:var(--on-primary-container); }
  .t-secondary { background:var(--secondary-container); color:var(--on-secondary-container); }
  .t-tertiary { background:var(--tertiary-container); color:var(--on-tertiary-container); }
  .t-ok { background:var(--success-container); color:var(--on-success-container); }
  .t-warn { background:var(--warning-container); color:var(--on-warning-container); }
  .t-err { background:var(--error-container); color:var(--on-error-container); }
  .t-plain { background:transparent; color:var(--on-surface-variant); box-shadow:inset 0 0 0 1px var(--outline-variant); }

  .c-ok { color:var(--success); } .c-mid { color:var(--primary); } .c-slow { color:var(--warning); } .c-err { color:var(--error); } .c-muted { color:var(--on-surface-variant); }

  /* ---------- Components ---------- */
  .chip { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px; border-radius:8px; font-size:12px; font-weight:500; white-space:nowrap; max-width:100%; }
  .chip .ms { font-size:16px; }
  .chip.lg { height:32px; padding:0 12px; font-size:14px; }
  .chip.lg .ms { font-size:18px; }
  .chip-x { border:0; background:transparent; color:inherit; padding:0; margin-right:-4px; width:18px; height:18px; border-radius:9px; display:grid; place-items:center; cursor:pointer; }
  .chip-x:hover { background:color-mix(in srgb, currentColor 16%, transparent); }
  .chip-x .ms { font-size:14px; }

  .btn { display:inline-flex; align-items:center; gap:8px; height:40px; padding:0 24px; border-radius:20px; border:0; font-size:14px; font-weight:500;
         cursor:pointer; position:relative; overflow:hidden; white-space:nowrap; }
  .btn .ms { font-size:18px; margin-left:-8px; }
  .btn.filled { background:var(--primary); color:var(--on-primary); }
  .btn.tonal { background:var(--secondary-container); color:var(--on-secondary-container); }
  .btn.outlined { background:transparent; color:var(--primary); box-shadow:inset 0 0 0 1px var(--outline); }
  .btn.text { background:transparent; color:var(--primary); padding:0 12px; }
  .btn.text .ms { margin-left:0; }
  .btn.danger { color:var(--error); }
  .icon-btn { width:40px; height:40px; border-radius:20px; border:0; background:transparent; color:var(--on-surface-variant); display:inline-grid;
              place-items:center; cursor:pointer; position:relative; overflow:hidden; flex:none; }
  .icon-btn.danger { color:var(--error); }
  .btn::after, .icon-btn::after, .seg button::after { content:""; position:absolute; inset:0; background:currentColor; opacity:0; transition:opacity .15s; pointer-events:none; }
  .btn:hover::after, .icon-btn:hover::after, .seg button:hover::after { opacity:.08; }
  .btn:active::after, .icon-btn:active::after { opacity:.12; }

  .seg { display:inline-flex; border-radius:20px; overflow:hidden; height:40px; box-shadow:inset 0 0 0 1px var(--outline); }
  .seg button { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:0 20px; border:0; background:transparent;
                color:var(--on-surface); font-size:14px; font-weight:500; cursor:pointer; position:relative; }
  .seg button + button { box-shadow:inset 1px 0 0 var(--outline); }
  .seg button.on { background:var(--secondary-container); color:var(--on-secondary-container); }
  .seg button.on .ms { font-variation-settings:"FILL" 1,"wght" 400,"GRAD" 0,"opsz" 24; }
  .seg.full { display:flex; } .seg.full button { flex:1; }

  .search { display:flex; align-items:center; gap:8px; height:40px; padding:0 16px; border-radius:20px; background:var(--sc-high); min-width:240px; color:var(--on-surface-variant); }
  .search input { border:0; outline:0; background:transparent; color:var(--on-surface); font-size:14px; flex:1; min-width:0; }

  .lin { height:4px; border-radius:2px; background:var(--sc-highest); overflow:hidden; position:relative; }
  .lin > i { display:block; height:100%; background:var(--primary); border-radius:2px; transition:width .4s var(--ease); }
  .lin.ok > i { background:var(--success); }
  .lin.indet > i { width:35%; position:absolute; animation:indet 1.3s infinite var(--ease); }
  @keyframes indet { 0% { left:-35%; } 100% { left:100%; } }

  .stack { display:flex; gap:2px; border-radius:99px; overflow:hidden; background:var(--sc-highest); }
  .stack > i { display:block; min-width:2px; }

  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; background:var(--outline); }
  .dot.ok { background:var(--success); } .dot.busy { background:var(--primary); } .dot.warn { background:var(--warning); } .dot.err { background:var(--error); }
  .dot.pulse { animation:pulse 1.6s infinite; }
  @keyframes pulse { 50% { opacity:.3; } }

  .lv { display:inline-flex; align-items:flex-end; gap:2px; height:14px; vertical-align:-1px; }
  .lv i { width:4px; border-radius:1px; background:var(--outline-variant); }
  .lv i:nth-child(1) { height:5px; } .lv i:nth-child(2) { height:9px; } .lv i:nth-child(3) { height:14px; }
  .lv.l1 i:nth-child(-n+1), .lv.l2 i:nth-child(-n+2), .lv.l3 i { background:var(--primary); }
  .model { display:inline-flex; align-items:center; gap:8px; white-space:nowrap; }

  .ring { display:block; flex:none; }

  .empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:40px 16px; color:var(--on-surface-variant); }
  .empty .ms { font-size:36px; opacity:.6; }

  /* ---------- Tables ---------- */
  .tbl-wrap { overflow-x:auto; }
  .tbl { width:100%; border-collapse:collapse; }
  .tbl th { font-size:12px; font-weight:500; color:var(--on-surface-variant); text-align:left; padding:14px 12px; white-space:nowrap;
            border-bottom:1px solid var(--outline-variant); }
  .tbl td { padding:10px 12px; border-bottom:1px solid color-mix(in srgb, var(--outline-variant) 50%, transparent); white-space:nowrap; vertical-align:middle; }
  .tbl th:first-child, .tbl td:first-child { padding-left:20px; }
  .tbl th:last-child, .tbl td:last-child { padding-right:20px; }
  .tbl tbody tr { cursor:pointer; transition:background .12s; }
  .tbl tbody tr:hover { background:color-mix(in srgb, var(--on-surface) 6%, transparent); }
  .tbl tbody tr:last-child td { border-bottom:0; }
  .tbl .r { text-align:right; } .tbl .c { text-align:center; }

  .tokcell { display:flex; flex-direction:column; gap:4px; width:84px; }
  .cachecell { display:inline-flex; align-items:center; gap:8px; }
  .turns { display:flex; flex-direction:column; gap:4px; width:56px; }
  .sid { display:inline-flex; align-items:center; gap:8px; }

  /* ---------- Home ---------- */
  .kpi { display:flex; flex-direction:column; gap:12px; }
  .kpi-head { display:flex; align-items:center; gap:12px; color:var(--on-surface-variant); font-weight:500; }
  .kpi-body { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:56px; }
  .kpi-val { font-size:36px; font-weight:400; line-height:1.1; letter-spacing:-.5px; }
  .kpi-foot { display:flex; align-items:center; gap:8px; min-height:24px; font-size:12px; color:var(--on-surface-variant); }
  .spark { width:100%; height:32px; display:block; }
  .legend { display:flex; flex-wrap:wrap; gap:12px; font-size:12px; color:var(--on-surface-variant); font-weight:400; }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  .legend i { width:8px; height:8px; border-radius:2px; display:inline-block; }

  .chart-box { position:relative; }
  .chart { width:100%; height:160px; display:block; }
  .chart .hit { fill:transparent; cursor:pointer; }
  .chart .hit:hover { fill:color-mix(in srgb, var(--on-surface) 10%, transparent); }
  .chart .ref { stroke:var(--outline); stroke-width:1; stroke-dasharray:4 4; vector-effect:non-scaling-stroke; }
  .chart-max { position:absolute; top:-2px; left:0; font-size:11px; color:var(--on-surface-variant); font-family:var(--mono); }
  .chart-base { height:1px; background:var(--outline-variant); }

  .up-row { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(60px,1fr) 40px 64px 72px; align-items:center; gap:12px; padding:8px 0; }
  .up-row + .up-row { border-top:1px solid color-mix(in srgb, var(--outline-variant) 50%, transparent); }
  .up-head { font-size:12px; color:var(--on-surface-variant); padding-top:0; }
  .up-bar { height:8px; border-radius:4px; background:var(--sc-highest); overflow:hidden; }
  .up-bar i { display:block; height:100%; background:var(--primary); border-radius:4px; }
  .up-bar.warn i { background:var(--warning); }

  .slots { display:flex; gap:6px; }
  .slot { flex:1; height:32px; border-radius:8px; min-width:12px; transition:background .3s; }
  .s-idle { background:var(--success-container); box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--success) 40%, transparent); }
  .s-busy { background:var(--primary); animation:pulse 1.6s infinite; }
  .s-starting { background:var(--warning-container); }
  .s-dead { background:var(--error-container); }
  .s-empty { box-shadow:inset 0 0 0 1.5px var(--outline-variant); background:transparent; }
  .pool-meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:16px; }

  /* ---------- Toolbar ---------- */
  .toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .section-h { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-top:8px; font-size:16px; font-weight:500; }

  /* ---------- Workers ---------- */
  .worker { display:flex; flex-direction:column; gap:16px; }
  .w-head { display:flex; align-items:center; gap:12px; }
  .w-id { display:flex; flex-direction:column; gap:4px; flex:1; min-width:0; }
  .w-id .mono { font-size:15px; }
  .w-stats { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:8px; }
  .stat { display:flex; flex-direction:column; align-items:flex-start; gap:4px; padding:10px 12px; border-radius:12px; background:var(--sc-high); min-width:0; }
  .stat .ms { font-size:18px; color:var(--on-surface-variant); }
  .stat .mono { font-size:13px; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
  .w-sess { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-height:24px; }

  /* ---------- Settings ---------- */
  .field { position:relative; margin-top:6px; }
  .field + .field, .field + .field-l, .field-l + .field, .row2 + .row2 { margin-top:24px; }
  .field > label, .field-l > label { position:absolute; top:-8px; left:12px; padding:0 4px; font-size:12px; color:var(--on-surface-variant); background:var(--sc); z-index:1; line-height:16px; }
  .field-l > label { position:static; display:block; padding:0; margin-bottom:8px; background:none; }
  .field-box { display:flex; align-items:center; gap:2px; height:56px; border-radius:4px; box-shadow:inset 0 0 0 1px var(--outline); padding:0 4px 0 16px; }
  .field-box:hover { box-shadow:inset 0 0 0 1px var(--on-surface); }
  .field-box:focus-within { box-shadow:inset 0 0 0 2px var(--primary); }
  .field:focus-within > label { color:var(--primary); }
  .field-box input, .field-box select { flex:1; width:0; min-width:0; height:100%; border:0; outline:0; background:transparent; color:var(--on-surface); font-size:16px; }
  .field-box input.mono { font-size:14px; }
  .field-box input.masked { -webkit-text-security:disc; }
  .field-box select { appearance:none; cursor:pointer; }
  .field-box select option { background:var(--sc-high); color:var(--on-surface); }
  .field-box .trail { pointer-events:none; color:var(--on-surface-variant); margin-right:8px; }
  .field-box .suffix { color:var(--on-surface-variant); padding-right:12px; }
  .field-box.step { padding:0 4px; }
  .field-box.step input { text-align:center; }
  input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
  input[type=number] { -moz-appearance:textfield; }
  .row2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; }
  .row2 .field + .field { margin-top:6px; }

  .savebar { position:fixed; right:28px; bottom:28px; display:flex; gap:8px; padding:8px; border-radius:28px; background:var(--sc-high);
             box-shadow:0 4px 8px 3px rgba(0,0,0,.15), 0 1px 3px rgba(0,0,0,.3); transform:translateY(140%); opacity:0; transition:all .25s var(--ease); z-index:15; }
  .savebar.on { transform:none; opacity:1; }

  /* ---------- Sheet / dialog / snackbar / tooltip ---------- */
  .scrim { position:fixed; inset:0; background:rgba(0,0,0,.32); opacity:0; pointer-events:none; transition:opacity .2s; z-index:30; }
  .scrim.on { opacity:1; pointer-events:auto; }
  .sheet { position:fixed; top:0; right:0; bottom:0; width:min(440px, 100vw); background:var(--sc-low); border-radius:16px 0 0 16px;
           transform:translateX(105%); transition:transform .3s var(--ease); z-index:31; display:flex; flex-direction:column; }
  .sheet.on { transform:none; }
  .sheet-head { display:flex; align-items:center; gap:8px; padding:12px 12px 8px 24px; font-size:22px; }
  .sheet-body { overflow:auto; padding:4px 24px 32px; display:flex; flex-direction:column; gap:24px; }
  .hero { display:flex; flex-direction:column; align-items:flex-start; gap:8px; }
  .sec-t { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:500; color:var(--on-surface-variant); margin-bottom:10px; }
  .sec-t .ms { font-size:16px; }
  .kv { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:6px 0; min-height:36px; }
  .kv > span:first-child { color:var(--on-surface-variant); flex:none; }
  .kv > span:last-child { min-width:0; overflow:hidden; text-overflow:ellipsis; text-align:right; }
  .tl-bar { display:flex; height:12px; border-radius:6px; overflow:hidden; gap:2px; background:var(--sc-highest); }
  .tl-bar i { display:block; }
  .tl-lbl { display:flex; justify-content:space-between; font-size:12px; margin-top:6px; font-family:var(--mono); }
  .tok-legend { display:grid; grid-template-columns:1fr 1fr; gap:8px 16px; margin-top:12px; }
  .tok-legend div { display:flex; align-items:center; gap:8px; font-size:13px; }
  .tok-legend i { width:10px; height:10px; border-radius:3px; flex:none; }
  .tok-legend .mono { margin-left:auto; }
  .mini-stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .mini-stats .stat .big { font-size:22px; }
  .err-box { margin-top:8px; padding:12px; border-radius:12px; background:var(--error-container); color:var(--on-error-container); font-family:var(--mono);
             font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .mini-list { display:flex; flex-direction:column; }
  .mini-row { display:grid; grid-template-columns:64px 24px 1fr 56px 56px; align-items:center; gap:8px; padding:8px; border-radius:8px; cursor:pointer; }
  .mini-row:hover { background:color-mix(in srgb, var(--on-surface) 6%, transparent); }

  dialog { border:0; padding:24px; border-radius:28px; background:var(--sc-high); color:var(--on-surface); width:min(340px, calc(100vw - 48px)); }
  dialog::backdrop { background:rgba(0,0,0,.4); }
  .dlg-ic { display:flex; justify-content:center; color:var(--error); }
  .dlg-ic .ms { font-size:24px; }
  dialog h3 { margin:16px 0 0; font-size:24px; font-weight:400; text-align:center; }
  dialog p { margin:16px 0 0; color:var(--on-surface-variant); text-align:center; word-break:break-all; }
  .dlg-act { display:flex; justify-content:flex-end; gap:8px; margin-top:24px; }
  #auth-key { display:block; width:100%; box-sizing:border-box; margin-top:16px; height:48px; padding:0 14px; border:0; outline:0; border-radius:4px; box-shadow:inset 0 0 0 1px var(--outline); background:transparent; color:var(--on-surface); font-family:var(--mono); font-size:14px; }
  #auth-key:focus { box-shadow:inset 0 0 0 2px var(--primary); }

  .snack { position:fixed; left:50%; bottom:24px; transform:translate(-50%, 24px); min-width:240px; max-width:560px; padding:14px 16px; border-radius:4px;
           background:var(--inverse-surface); color:var(--inverse-on-surface); box-shadow:0 4px 8px 3px rgba(0,0,0,.15); z-index:50;
           opacity:0; visibility:hidden; transition:transform .25s var(--ease), opacity .2s, visibility .25s; }
  .snack.on { transform:translate(-50%, 0); opacity:1; visibility:visible; }
  .snack.err { background:var(--error-container); color:var(--on-error-container); }

  .tip { position:fixed; z-index:60; pointer-events:none; padding:6px 8px; border-radius:4px; background:var(--inverse-surface); color:var(--inverse-on-surface);
         font-size:12px; line-height:1.5; white-space:pre-line; max-width:320px; opacity:0; transition:opacity .1s; }
  .tip.on { opacity:1; }

  /* ---------- Responsive: drawer -> rail -> bottom bar ---------- */
  @media (max-width: 1280px) { .kpis { grid-template-columns:repeat(2, minmax(0,1fr)); } .home-bottom { grid-template-columns:1fr; } }
  @media (max-width: 1000px) {
    html:not([data-layout="top"]) .drawer { width:88px; align-items:center; padding:12px 0; gap:12px; }
    html:not([data-layout="top"]) .brand { padding:0; justify-content:center; margin-bottom:0; }
    html:not([data-layout="top"]) .brand-name { display:none; }
    html:not([data-layout="top"]) .nav-item { flex-direction:column; height:auto; padding:0; gap:4px; width:80px; font-size:12px; background:none !important; }
    html:not([data-layout="top"]) .nav-ic { width:56px; height:32px; border-radius:16px; transition:background .15s; }
    html:not([data-layout="top"]) .nav-item:hover .nav-ic { background:color-mix(in srgb, var(--on-surface) 8%, transparent); }
    html:not([data-layout="top"]) .nav-item.active .nav-ic { background:var(--secondary-container); }
    .two { grid-template-columns:1fr; }
  }
  @media (max-width: 640px) {
    .app { flex-direction:column; }
    html:not([data-layout="top"]) .drawer { position:fixed; top:auto; bottom:0; left:0; right:0; width:100%; height:80px; flex-direction:row; justify-content:space-around; z-index:20; padding:0; }
    html:not([data-layout="top"]) .brand { display:none; }
    html:not([data-layout="top"]) .content { padding:0 16px 104px; }
    .kpis { grid-template-columns:1fr; }
    .w-stats { grid-template-columns:repeat(2, minmax(0,1fr)); }
    .search { min-width:0; flex:1; }
    html:not([data-layout="top"]) .savebar { bottom:96px; right:16px; }
  }

  /* ---------- Top Layout (CPA Plugin Adaptation Mode) ---------- */
  .top-actions { display:none; align-items:center; gap:8px; margin-left:auto; }
  html[data-layout="top"] .app { flex-direction:column; }
  html[data-layout="top"] .drawer {
    width:100%; height:64px; position:sticky; top:0; z-index:20;
    flex-direction:row; align-items:center; padding:0 28px; gap:8px;
    background:var(--sc-low); border-bottom:1px solid color-mix(in srgb, var(--outline-variant) 50%, transparent);
  }
  html[data-layout="top"] .brand { height:40px; padding:0 8px 0 0; margin:0 8px 0 0; }
  html[data-layout="top"] .nav-item { height:40px; padding:0 16px; border-radius:20px; gap:8px; }
  html[data-layout="top"] .top-actions { display:flex; }
  html[data-layout="top"] .topbar { display:none; }
  html[data-layout="top"] .content { padding:24px 28px 40px; max-width:1600px; width:100%; margin:0 auto; }
  html[data-embedded="cpa"] .topbar { padding-right:210px; }
  html[data-embedded="cpa"][data-layout="top"] .drawer { padding-right:220px; }
  @media (max-width: 720px) {
    html[data-layout="top"] .drawer { padding:0 12px; gap:4px; }
    html[data-layout="top"] .brand-name { display:none; }
    html[data-layout="top"] .nav-item { padding:0 12px; font-size:13px; }
    html[data-layout="top"] .content { padding:16px 16px 40px; }
  }
</style>
</head>
<body>
<div class="app">
  <nav class="drawer">
    <div class="brand"><img class="brand-logo" src="./favicon.svg" alt="" /><span class="brand-name">agy2api</span></div>
    <a class="nav-item" href="#home" data-page="home"><span class="nav-ic"><span class="ms">space_dashboard</span></span><span>首页</span></a>
    <a class="nav-item" href="#traffic" data-page="traffic"><span class="nav-ic"><span class="ms">monitoring</span></span><span>请求</span></a>
    <a class="nav-item" href="#runtime" data-page="runtime"><span class="nav-ic"><span class="ms">memory</span><span class="badge" id="badge-rt"></span></span><span>运行</span></a>
    <a class="nav-item" href="#settings" data-page="settings"><span class="nav-ic"><span class="ms">tune</span></span><span>设置</span></a>
    <div class="top-actions">
      <span class="chip t-plain" id="sync-top" data-tip="连接中"><span class="dot" id="sync-dot-top"></span><span id="sync-t-top">…</span></span>
      <button class="icon-btn" data-act="refresh" data-tip="刷新"><span class="ms">refresh</span></button>
      <button class="icon-btn" data-act="theme" data-tip="切换主题"><span class="ms" id="theme-ic-top">dark_mode</span></button>
    </div>
  </nav>

  <main class="content">
    <header class="topbar">
      <h1 id="title">首页</h1>
      <span class="grow"></span>
      <span class="chip t-plain" id="sync" data-tip="连接中"><span class="dot" id="sync-dot"></span><span id="sync-t">…</span></span>
      <button class="icon-btn" data-act="refresh" data-tip="刷新"><span class="ms">refresh</span></button>
      <button class="icon-btn" data-act="theme" data-tip="切换主题"><span class="ms" id="theme-ic">dark_mode</span></button>
    </header>

    <!-- 首页 -->
    <section class="page" id="page-home">
      <div class="grid kpis" id="home-kpis"></div>
      <div class="grid two">
        <div class="card">
          <div class="card-h"><span class="ic sm t-primary"><span class="ms">token</span></span><span>Token</span><span class="grow"></span>
            <span class="legend"><span><i style="background:var(--primary)"></i>缓存</span><span><i style="background:var(--tertiary)"></i>输入</span><span><i style="background:var(--c-out)"></i>输出</span></span>
          </div>
          <div id="chart-tok"></div>
        </div>
        <div class="card">
          <div class="card-h"><span class="ic sm t-secondary"><span class="ms">timer</span></span><span>TTFT</span><span class="grow"></span>
            <span class="legend"><span><i style="background:var(--success)"></i>≤5s</span><span><i style="background:var(--primary)"></i>≤12s</span><span><i style="background:var(--warning)"></i>慢</span></span>
          </div>
          <div id="chart-ttft"></div>
        </div>
      </div>
      <div class="grid home-bottom">
        <div class="card">
          <div class="card-h"><span class="ic sm t-tertiary"><span class="ms">hub</span></span><span>上游路由</span></div>
          <div id="home-up"></div>
        </div>
        <div class="card">
          <div class="card-h"><span class="ic sm t-ok"><span class="ms">memory</span></span><span>进程池</span><span class="grow"></span>
            <button class="icon-btn" data-act="nav" data-page="runtime" data-tip="详情"><span class="ms">arrow_forward</span></button>
          </div>
          <div id="home-pool"></div>
        </div>
      </div>
    </section>

    <!-- 请求 -->
    <section class="page" id="page-traffic">
      <div class="toolbar">
        <div class="seg" id="traffic-tabs">
          <button data-act="tab" data-tab="req" class="on"><span class="ms">receipt_long</span>请求</button>
          <button data-act="tab" data-tab="sess"><span class="ms">forum</span>会话</button>
        </div>
        <span class="grow"></span>
        <label class="search"><span class="ms">search</span><input id="q" placeholder="筛选" autocomplete="off" /></label>
      </div>
      <div class="card flush"><div class="tbl-wrap" id="traffic-body"></div></div>
    </section>

    <!-- 运行 -->
    <section class="page" id="page-runtime">
      <div class="card" id="rt-pool"></div>
      <div class="section-h"><span>进程</span><span class="grow"></span>
        <button class="btn outlined" data-act="clear"><span class="ms">cleaning_services</span>清空哈希</button>
        <button class="btn tonal" data-act="spawn"><span class="ms">add</span>扩容</button>
      </div>
      <div class="grid workers" id="rt-workers"></div>
      <div class="section-h"><span>存续会话</span></div>
      <div class="card flush"><div class="tbl-wrap" id="rt-sessions"></div></div>
    </section>

    <!-- 设置 -->
    <section class="page" id="page-settings">
      <div class="grid settings" id="settings-form">
        <div class="card">
          <div class="card-h"><span class="ic sm t-primary"><span class="ms">key</span></span><span>接入</span></div>
          <div class="field"><label>Base URL</label>
            <div class="field-box"><input id="f-url" class="mono" readonly />
              <button type="button" class="icon-btn" data-act="copy-url" data-tip="复制"><span class="ms">content_copy</span></button></div>
          </div>
          <div class="field"><label>API Key</label>
            <div class="field-box"><input id="f-apiKey" class="mono masked" type="text" autocomplete="off" data-1p-ignore="true" data-lpignore="true" spellcheck="false" />
              <button type="button" class="icon-btn" data-act="toggle-key" data-tip="显示"><span class="ms" id="key-eye">visibility</span></button>
              <button type="button" class="icon-btn" data-act="gen-key" data-tip="随机生成"><span class="ms">autorenew</span></button>
              <button type="button" class="icon-btn" data-act="copy-key" data-tip="复制"><span class="ms">content_copy</span></button></div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><span class="ic sm t-tertiary"><span class="ms">psychology</span></span><span>默认模型</span></div>
          <div class="field"><label>模型</label>
            <div class="field-box"><select id="f-model"></select><span class="ms trail">expand_more</span></div>
          </div>
          <div class="field-l"><label>思考强度</label>
            <div class="seg full" id="f-level">
              <button type="button" data-act="lv-pick" data-v="low"><span class="lv l1"><i></i><i></i><i></i></span>低</button>
              <button type="button" data-act="lv-pick" data-v="medium"><span class="lv l2"><i></i><i></i><i></i></span>中</button>
              <button type="button" data-act="lv-pick" data-v="high"><span class="lv l3"><i></i><i></i><i></i></span>高</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><span class="ic sm t-ok"><span class="ms">memory</span></span><span>进程池</span></div>
          <div class="row2">
            <div class="field"><label>常驻</label>
              <div class="field-box step">
                <button type="button" class="icon-btn" data-act="step" data-for="f-min" data-d="-1"><span class="ms">remove</span></button>
                <input id="f-min" type="number" min="0" max="20" />
                <button type="button" class="icon-btn" data-act="step" data-for="f-min" data-d="1"><span class="ms">add</span></button></div>
            </div>
            <div class="field"><label>上限</label>
              <div class="field-box step">
                <button type="button" class="icon-btn" data-act="step" data-for="f-max" data-d="-1"><span class="ms">remove</span></button>
                <input id="f-max" type="number" min="1" max="32" />
                <button type="button" class="icon-btn" data-act="step" data-for="f-max" data-d="1"><span class="ms">add</span></button></div>
            </div>
          </div>
          <div class="row2">
            <div class="field"><label>空闲回收</label>
              <div class="field-box"><input id="f-idle" type="number" min="5" step="5" /><span class="suffix">秒</span></div>
            </div>
            <div class="field"><label>会话哈希有效期</label>
              <div class="field-box"><input id="f-sess" type="number" min="1" step="1" /><span class="suffix">分钟</span></div>
            </div>
          </div>
          <div class="row2">
            <div class="field"><label>请求超时</label>
              <div class="field-box"><input id="f-timeout" type="number" min="5" step="5" /><span class="suffix">秒</span></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><span class="ic sm t-secondary"><span class="ms">dashboard_customize</span></span><span>界面适配</span></div>
          <div class="field-l"><label>导航栏位置（CPA 插件面板推荐顶部）</label>
            <div class="seg full" id="f-layout">
              <button type="button" data-act="layout-pick" data-v="side"><span class="ms">dock_to_right</span>左侧标准</button>
              <button type="button" data-act="layout-pick" data-v="top"><span class="ms">dock_to_bottom</span>顶部 CPA 适配</button>
            </div>
          </div>
        </div>
      </div>
      <div class="savebar" id="savebar">
        <button class="btn text" data-act="revert"><span class="ms">undo</span>还原</button>
        <button class="btn filled" data-act="save"><span class="ms">save</span>保存</button>
      </div>
    </section>
  </main>
</div>

<div class="scrim" id="scrim" data-act="close-sheet"></div>
<aside class="sheet" id="sheet">
  <div class="sheet-head"><span id="sheet-title" class="grow"></span><button class="icon-btn" data-act="close-sheet"><span class="ms">close</span></button></div>
  <div class="sheet-body" id="sheet-body"></div>
</aside>

<dialog id="dlg">
  <div class="dlg-ic"><span class="ms" id="dlg-ic">warning</span></div>
  <h3 id="dlg-t"></h3>
  <p id="dlg-p"></p>
  <div class="dlg-act"><button class="btn text" id="dlg-no">取消</button><button class="btn text" id="dlg-ok">确定</button></div>
</dialog>
<dialog id="auth-dlg">
  <div class="dlg-ic"><span class="ms">key</span></div>
  <h3>输入 API Key</h3>
  <p>管理接口需要鉴权，请输入网关的 API Key（与 /v1 接口使用的相同）。</p>
  <input id="auth-key" type="password" autocomplete="off" spellcheck="false" />
  <div class="dlg-act"><button class="btn text" id="auth-ok">确定</button></div>
</dialog>
<div class="snack" id="snack"></div>
<div class="tip" id="tip"></div>

<script>
  var S = { d: null, page: "home", tab: "req", q: "", sheet: null, cfgReady: false, dirty: false, level: "medium", layout: localStorage.getItem("agy-layout") || "side", last: 0 };
  var TITLES = { home: "首页", traffic: "请求", runtime: "运行", settings: "设置" };
  var LV = { low: 1, medium: 2, high: 3 };
  function $(id) { return document.getElementById(id); }

  /* ---------- CPA Panel Auth & Relative Path Helper ---------- */
  function getCpaManagementKey() {
    try {
      var raw = localStorage.getItem("cli-proxy-auth");
      if (!raw) return "";
      var prefix = "enc::v1::";
      var decoded = raw;
      if (raw.indexOf(prefix) === 0) {
        var bin = atob(raw.slice(prefix.length));
        var data = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        var keyStr = "cli-proxy-api-webui::secure-storage|" + location.host + "|" + navigator.userAgent;
        var keyBytes = new TextEncoder().encode(keyStr);
        var out = new Uint8Array(data.length);
        for (var j = 0; j < data.length; j++) out[j] = data[j] ^ keyBytes[j % keyBytes.length];
        decoded = new TextDecoder().decode(out);
      }
      var parsed = JSON.parse(decoded);
      var st = (parsed && parsed.state) ? parsed.state : parsed;
      return (st && typeof st.managementKey === "string") ? st.managementKey : "";
    } catch (e) {
      return "";
    }
  }
  var ADMIN_KEY_STORE = "agy2api-admin-key";
  function getAdminKey() { try { return localStorage.getItem(ADMIN_KEY_STORE) || ""; } catch (e) { return ""; } }
  function setAdminKey(k) { try { if (k) localStorage.setItem(ADMIN_KEY_STORE, k); else localStorage.removeItem(ADMIN_KEY_STORE); } catch (e) {} }
  function authHeaders() {
    var h = {};
    var mgmtKey = getCpaManagementKey();
    if (mgmtKey) h["Authorization"] = "Bearer " + mgmtKey;
    var k = getAdminKey();
    if (k) h["X-Agy2Api-Key"] = k;
    return h;
  }
  var authPending = null;
  function askAdminKey() {
    if (authPending) return authPending;
    authPending = new Promise(function (res) {
      var d = $("auth-dlg"), inp = $("auth-key");
      inp.value = "";
      var done = function () {
        var v = inp.value.trim();
        if (!v) { inp.focus(); return; }
        setAdminKey(v);
        $("auth-ok").onclick = null; inp.onkeydown = null; d.oncancel = null;
        if (d.open) d.close();
        authPending = null;
        res(v);
      };
      $("auth-ok").onclick = done;
      inp.onkeydown = function (e) { if (e.key === "Enter") done(); };
      d.oncancel = function (e) { e.preventDefault(); };
      d.showModal();
      inp.focus();
    });
    return authPending;
  }
  function resolveApiUrl(relPath) {
    var p = relPath.replace(/^\.?\//, "");
    var loc = location.pathname;
    var baseDir = loc.endsWith("/") ? loc : loc.replace(/\/[^/]*$/, "/");
    return baseDir + p;
  }

  /* ---------- formatters ---------- */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function trimZ(s) { return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }
  function tok(n) {
    n = Number(n) || 0;
    var U = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (var i = 0; i < U.length; i++) {
      if (n >= U[i][0]) { var x = n / U[i][0]; return trimZ(x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)) + U[i][1]; }
    }
    return String(Math.round(n));
  }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function ms(v) {
    v = Number(v) || 0;
    if (v <= 0) return "–";
    if (v < 1000) return Math.round(v) + "ms";
    if (v < 60000) return trimZ((v / 1000).toFixed(1)) + "s";
    return Math.floor(v / 60000) + "m" + Math.round((v % 60000) / 1000) + "s";
  }
  function span(v) {
    v = Math.max(0, Number(v) || 0) / 1000;
    if (v < 60) return Math.floor(v) + "s";
    if (v < 3600) return Math.floor(v / 60) + "m";
    if (v < 86400) return Math.floor(v / 3600) + "h" + Math.floor((v % 3600) / 60) + "m";
    return Math.floor(v / 86400) + "d";
  }
  function clock(ts) {
    var d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (x) { return String(x).padStart(2, "0"); }).join(":");
  }
  function dateTime(ts) { var d = new Date(ts); return (d.getMonth() + 1) + "/" + d.getDate() + " " + clock(ts); }
  function pct(v) { return trimZ((Number(v) || 0).toFixed(1)) + "%"; }
  function promptTok(r) { return (r.inputTokens || 0) + (r.cachedReadTokens || 0) + (r.cachedWriteTokens || 0); }
  function allTok(r) { return promptTok(r) + (r.outputTokens || 0) + (r.thoughtTokens || 0); }
  function tps(r) {
    var gen = (r.durationMs || 0) - (r.ttftMs || 0);
    var out = (r.outputTokens || 0) + (r.thoughtTokens || 0);
    return gen > 200 && out > 0 ? out / (gen / 1000) : 0;
  }
  function tone(v) { v = Number(v) || 0; return v <= 0 ? "c-muted" : v <= 5000 ? "c-ok" : v <= 12000 ? "c-mid" : "c-slow"; }
  function toneColor(r) {
    if (r.status === "error") return "var(--error)";
    var t = tone(r.ttftMs);
    return t === "c-ok" ? "var(--success)" : t === "c-mid" ? "var(--primary)" : t === "c-slow" ? "var(--warning)" : "var(--outline)";
  }
  function isTrial(m) { return /trial/i.test(m || ""); }

  /* ---------- visual atoms ---------- */
  function lv(level) {
    var n = LV[level] || 0;
    return '<span class="lv l' + n + '" data-tip="思考 ' + esc(level || "-") + '"><i></i><i></i><i></i></span>';
  }
  function upChip(m, big) {
    var t = isTrial(m);
    return '<span class="chip mono ' + (big ? "lg " : "") + (t ? "t-warn" : "t-plain") + '" data-tip="' + (t ? "trial 路由" : "上游模型") + '">' +
      (t ? '<span class="ms">warning</span>' : "") + esc(m || "–") + "</span>";
  }
  var MISS_REASONS = { new_conversation: "新对话", no_match: "历史不匹配", worker_busy: "原进程忙，等待超时" };
  function missName(reason) { return MISS_REASONS[reason] || reason || ""; }
  function sessChip(hit, sid, reason) {
    return hit
      ? '<span class="chip t-primary" data-tip="会话复用"><span class="ms">link</span><span class="mono">' + esc(sid.slice(0, 6)) + "</span></span>"
      : '<span class="chip t-tertiary" data-tip="' + esc("新会话" + (reason ? " · " + missName(reason) : "")) + '"><span class="ms">fiber_new</span><span class="mono">' + esc(sid.slice(0, 6)) + "</span></span>";
  }
  function finish(r) {
    if (r.status === "error") return '<span class="ms fill c-err" data-tip="' + esc(r.errorMessage || "error") + '">error</span>';
    if (r.finishReason === "tool_calls") return '<span class="chip t-warn" data-tip="工具调用"><span class="ms">build</span>' + r.toolCallsCount + "</span>";
    if (r.finishReason === "length") return '<span class="ms c-slow" data-tip="长度截断">content_cut</span>';
    if (r.finishReason === "content_filter") return '<span class="ms c-err" data-tip="模型拒绝回答">block</span>';
    return '<span class="ms fill c-ok" data-tip="完成">check_circle</span>';
  }
  function ring(p, size, sw, color) {
    p = Math.max(0, Math.min(100, Number(p) || 0));
    var r = (size - sw) / 2, c = 2 * Math.PI * r, h = size / 2;
    return '<svg class="ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '">' +
      '<circle cx="' + h + '" cy="' + h + '" r="' + r + '" style="fill:none;stroke:var(--sc-highest);stroke-width:' + sw + '"/>' +
      '<circle cx="' + h + '" cy="' + h + '" r="' + r + '" transform="rotate(-90 ' + h + " " + h + ')" style="fill:none;stroke:' + (color || "var(--primary)") +
      ";stroke-width:" + sw + ";stroke-linecap:round;stroke-dasharray:" + (c * p / 100).toFixed(2) + " " + c.toFixed(2) + '"/></svg>';
  }
  function stack(parts, h) {
    return '<div class="stack" style="height:' + (h || 6) + 'px">' + parts.map(function (p) {
      return p[0] > 0 ? '<i style="flex:' + p[0] + ";background:" + p[1] + '"></i>' : "";
    }).join("") + "</div>";
  }
  function tokParts(r) {
    return [
      [r.cachedReadTokens || 0, "var(--primary)"],
      [(r.inputTokens || 0) + (r.cachedWriteTokens || 0), "var(--tertiary)"],
      [r.outputTokens || 0, "var(--c-out)"],
      [r.thoughtTokens || 0, "var(--c-think)"],
    ];
  }
  function tokTip(r) {
    return "缓存 " + num(r.cachedReadTokens) + "\n输入 " + num((r.inputTokens || 0) + (r.cachedWriteTokens || 0)) +
      "\n输出 " + num(r.outputTokens) + "\n思考 " + num(r.thoughtTokens);
  }
  function tokCell(r) {
    return '<div class="tokcell" data-tip="' + esc(tokTip(r)) + '"><span class="mono">' + tok(allTok(r)) + "</span>" + stack(tokParts(r), 4) + "</div>";
  }
  function cacheCell(p) { return '<span class="cachecell">' + ring(p, 18, 3) + '<span class="mono">' + pct(p) + "</span></span>"; }
  function empty(icon, text) { return '<div class="empty"><span class="ms">' + icon + "</span><span>" + text + "</span></div>"; }
  function stateTone(st) { return { IDLE: "ok", BUSY: "busy", STARTING: "warn", DEAD: "err" }[st] || ""; }
  function stateName(st) { return { IDLE: "空闲", BUSY: "忙碌", STARTING: "启动中", DEAD: "已退出" }[st] || st; }

  /* ---------- charts ---------- */
  function barChart(list, segFn, tipFn, fmt, ref) {
    if (!list.length) return empty("bar_chart", "暂无数据");
    var N = Math.max(list.length, 30), W = N * 10, H = 160, off = N - list.length, max = 0;
    var segs = list.map(function (r) {
      var sg = segFn(r), t = sg.reduce(function (a, x) { return a + x[0]; }, 0);
      if (t > max) max = t;
      return sg;
    });
    if (!max) max = 1;
    var s = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">';
    if (ref > 0) { var ry = (H - (ref / max) * (H - 16)).toFixed(1); s += '<line class="ref" x1="0" x2="' + W + '" y1="' + ry + '" y2="' + ry + '"/>'; }
    segs.forEach(function (sg, i) {
      var x = (off + i) * 10, y = H;
      sg.forEach(function (p) {
        if (p[0] <= 0) return;
        var h = Math.max((p[0] / max) * (H - 16), 1);
        y -= h;
        s += '<rect x="' + (x + 2) + '" y="' + y.toFixed(2) + '" width="6" height="' + h.toFixed(2) + '" style="fill:' + p[1] + '"/>';
      });
      s += '<rect class="hit" x="' + x + '" y="0" width="10" height="' + H + '" data-tip="' + esc(tipFn(list[i])) + '" data-act="open-req" data-id="' + esc(list[i].requestId) + '"/>';
    });
    return '<div class="chart-box"><span class="chart-max">' + fmt(max) + "</span>" + s + '</svg><div class="chart-base"></div></div>';
  }
  function spark(vals) {
    if (vals.length < 2) return '<svg class="spark"></svg>';
    var W = 100, H = 32, max = Math.max.apply(null, vals) || 1, step = W / (vals.length - 1);
    var pts = vals.map(function (v, i) { return (i * step).toFixed(1) + "," + (H - 3 - (v / max) * (H - 6)).toFixed(1); }).join(" ");
    return '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none"><polyline points="' + pts +
      '" style="fill:none;stroke:var(--primary);stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round"/></svg>';
  }
  function slots(d) {
    var max = Math.max(d.config.maxWorkers, d.workers.length), h = '<div class="slots">';
    for (var i = 0; i < max; i++) {
      var w = d.workers[i];
      h += w
        ? '<span class="slot s-' + w.state.toLowerCase() + '" data-tip="' + esc(w.id + " · " + stateName(w.state)) + '"></span>'
        : '<span class="slot s-empty" data-tip="' + (i < d.config.minWorkers ? "常驻位" : "可扩容") + '"></span>';
    }
    return h + "</div>";
  }
  function poolMeta(d) {
    var p = d.pool;
    return '<div class="pool-meta">' +
      '<span class="chip t-ok" data-tip="空闲"><span class="dot ok"></span>' + p.idleWorkers + "</span>" +
      '<span class="chip t-primary" data-tip="忙碌"><span class="dot busy"></span>' + p.busyWorkers + "</span>" +
      (p.startingWorkers ? '<span class="chip t-warn" data-tip="启动中"><span class="dot warn"></span>' + p.startingWorkers + "</span>" : "") +
      '<span class="grow"></span>' +
      '<span class="chip ' + (p.queuedRequests ? "t-err" : "t-plain") + '" data-tip="排队请求"><span class="ms">hourglass_top</span>' + p.queuedRequests + "</span>" +
      (p.affinityWaiters ? '<span class="chip t-warn" data-tip="等待原会话进程空闲"><span class="ms">link</span>' + p.affinityWaiters + "</span>" : "") +
      '<span class="chip t-plain" data-tip="会话哈希"><span class="ms">tag</span>' + p.cachedSessionHashes + "</span>" +
      '<span class="chip t-plain" data-tip="常驻 – 上限"><span class="ms">width</span>' + d.config.minWorkers + "–" + d.config.maxWorkers + "</span>" +
      "</div>";
  }
  // What agy declared in ACP initialize; null until a worker has started
  function agentMeta(d) {
    var a = d.agent;
    if (!a) return "";
    var info = a.agentInfo || {}, pc = (a.agentCapabilities || {}).promptCapabilities || {};
    var name = (info.title || info.name || "agy") + (info.version ? " " + info.version : "");
    function cap(on, icon, label) {
      return '<span class="chip ' + (on ? "t-ok" : "t-plain") + '" data-tip="' + label + (on ? " · 支持" : " · 不支持") + '">' +
        '<span class="ms">' + (on ? icon : "block") + "</span>" + label + "</span>";
    }
    return '<div class="pool-meta">' +
      '<span class="chip t-plain" data-tip="上游 Agent"><span class="ms">smart_toy</span>' + esc(name) + "</span>" +
      '<span class="chip t-plain" data-tip="ACP 协议版本"><span class="ms">swap_horiz</span>ACP v' + esc(a.protocolVersion) + "</span>" +
      '<span class="grow"></span>' +
      cap(pc.image, "image", "图片输入") + cap(pc.audio, "mic", "音频输入") + cap(pc.embeddedContext, "description", "嵌入资源") +
      "</div>";
  }

  /* ---------- pages ---------- */
  function kpi(icon, toneCls, label, body, foot) {
    return '<div class="card kpi"><div class="kpi-head"><span class="ic sm ' + toneCls + '"><span class="ms">' + icon + "</span></span>" + label +
      '</div><div class="kpi-body">' + body + '</div><div class="kpi-foot">' + foot + "</div></div>";
  }
  function renderHome(d) {
    var s = d.telemetry.summary, reqs = d.telemetry.recentRequests, chrono = reqs.slice().reverse();
    var okRate = s.totalRequests ? (s.successfulRequests / s.totalRequests) * 100 : 0;
    var misses = Object.keys(s.missReasons || {}).map(function (k) { return missName(k) + " " + num(s.missReasons[k]); });
    var html =
      kpi("bolt", "t-primary", "请求",
        '<span class="kpi-val">' + (s.totalRequests >= 10000 ? tok(s.totalRequests) : num(s.totalRequests)) + "</span>" + ring(okRate, 48, 5, "var(--success)"),
        '<span class="chip t-ok" data-tip="成功"><span class="ms">check</span>' + num(s.successfulRequests) + "</span>" +
        '<span class="chip ' + (s.failedRequests ? "t-err" : "t-plain") + '" data-tip="失败"><span class="ms">close</span>' + num(s.failedRequests) + "</span>" +
        (s.toolParseFailures ? '<span class="chip t-warn" data-tip="无法解析的工具调用"><span class="ms">build</span>' + num(s.toolParseFailures) + "</span>" : "")) +
      kpi("timer", "t-secondary", "平均 TTFT",
        '<span class="kpi-val ' + tone(s.avgTtftMs) + '">' + ms(s.avgTtftMs) + "</span>",
        '<div style="flex:1" data-tip="最近 30 次">' + spark(chrono.slice(-30).map(function (r) { return r.ttftMs || 0; })) + "</div>") +
      kpi("cached", "t-tertiary", "缓存命中",
        '<span class="kpi-val">' + pct(s.cloudCacheHitRate) + "</span>" + ring(s.cloudCacheHitRate, 48, 5),
        '<span class="ms" data-tip="' + esc(["会话复用率"].concat(misses).join("\n")) + '" style="font-size:16px">link</span><div class="lin ok" style="flex:1"><i style="width:' + s.sessionHashHitRate + '%"></i></div><span class="mono">' + pct(s.sessionHashHitRate) + "</span>") +
      kpi("token", "t-ok", "Token",
        '<span class="kpi-val">' + tok(s.totalTokens) + "</span>",
        '<div style="flex:1" data-tip="' + esc("缓存 " + tok(s.totalCachedReadTokens) + "\n输入 " + tok(s.totalInputTokens + s.totalCachedWriteTokens) +
          "\n输出 " + tok(s.totalOutputTokens) + "\n思考 " + tok(s.totalThoughtTokens)) + '">' +
        stack([[s.totalCachedReadTokens, "var(--primary)"], [s.totalInputTokens + s.totalCachedWriteTokens, "var(--tertiary)"],
               [s.totalOutputTokens, "var(--c-out)"], [s.totalThoughtTokens, "var(--c-think)"]], 8) + "</div>");
    $("home-kpis").innerHTML = html;

    var last = chrono.slice(-40);
    $("chart-tok").innerHTML = barChart(last,
      function (r) { return tokParts(r).slice(0, 3); },
      function (r) { return clock(r.timestamp) + "  " + (r.actualModelVersion || "") + "\n" + tokTip(r) + "\n命中 " + pct(r.cacheHitRate); },
      tok, 0);
    var okT = last.filter(function (r) { return r.ttftMs > 0; });
    var avg = okT.length ? okT.reduce(function (a, r) { return a + r.ttftMs; }, 0) / okT.length : 0;
    $("chart-ttft").innerHTML = barChart(last,
      function (r) { return [[r.ttftMs || 0, toneColor(r)]]; },
      function (r) { return clock(r.timestamp) + "  " + (r.actualModelVersion || "") + "\nTTFT " + ms(r.ttftMs) + "\n总耗时 " + ms(r.durationMs); },
      ms, avg);

    // upstream routes
    var m = {};
    reqs.forEach(function (r) {
      if (r.status !== "success") return;
      var k = r.actualModelVersion || "–", o = m[k] || (m[k] = { n: 0, tt: 0, ttn: 0, tp: 0, tpn: 0 });
      o.n++;
      if (r.ttftMs > 0) { o.tt += r.ttftMs; o.ttn++; }
      var t = tps(r); if (t > 0) { o.tp += t; o.tpn++; }
    });
    var rows = Object.keys(m).map(function (k) { return [k, m[k]]; }).sort(function (a, b) { return b[1].n - a[1].n; });
    if (!rows.length) { $("home-up").innerHTML = empty("hub", "暂无数据"); }
    else {
      var maxN = rows[0][1].n;
      $("home-up").innerHTML =
        '<div class="up-row up-head"><span>模型</span><span></span><span class="r">次</span><span class="r">TTFT</span><span class="r">速度</span></div>' +
        rows.map(function (e) {
          var o = e[1], at = o.ttn ? o.tt / o.ttn : 0, ap = o.tpn ? o.tp / o.tpn : 0;
          return '<div class="up-row"><span style="min-width:0;overflow:hidden">' + upChip(e[0]) + "</span>" +
            '<div class="up-bar' + (isTrial(e[0]) ? " warn" : "") + '"><i style="width:' + (o.n / maxN) * 100 + '%"></i></div>' +
            '<span class="mono r">' + o.n + "</span>" +
            '<span class="mono r ' + tone(at) + '">' + ms(at) + "</span>" +
            '<span class="mono r muted" data-tip="tok/s">' + (ap ? trimZ(ap.toFixed(1)) : "–") + "</span></div>";
        }).join("");
    }
    $("home-pool").innerHTML = slots(d) + poolMeta(d);
  }

  function match(q, arr) {
    if (!q) return true;
    for (var i = 0; i < arr.length; i++) if (String(arr[i] || "").toLowerCase().indexOf(q) >= 0) return true;
    return false;
  }
  function renderTraffic(d) {
    var q = S.q.trim().toLowerCase(), now = Date.now();
    document.querySelectorAll("#traffic-tabs button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === S.tab); });
    if (S.tab === "req") {
      var rows = d.telemetry.recentRequests.filter(function (r) {
        return match(q, [r.requestId, r.sessionId, r.workerId, r.resolvedBaseModel, r.requestedModel, r.actualModelVersion, r.finishReason]);
      });
      if (!rows.length) { $("traffic-body").innerHTML = empty("receipt_long", "暂无请求"); return; }
      $("traffic-body").innerHTML =
        '<table class="tbl"><thead><tr><th>时间</th><th>会话</th><th>模型</th><th>上游</th><th class="r">TTFT</th><th class="r">耗时</th><th>Token</th><th>缓存</th><th class="c">结果</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr data-act="open-req" data-id="' + esc(r.requestId) + '">' +
            '<td class="mono muted">' + clock(r.timestamp) + "</td>" +
            "<td>" + sessChip(r.sessionCache === "HIT", r.sessionId, r.missReason) + "</td>" +
            '<td><span class="model">' + esc(r.resolvedBaseModel) + lv(r.thinkingLevel) + "</span></td>" +
            "<td>" + upChip(r.actualModelVersion) + "</td>" +
            '<td class="r mono ' + tone(r.ttftMs) + '">' + ms(r.ttftMs) + "</td>" +
            '<td class="r mono muted">' + ms(r.durationMs) + "</td>" +
            "<td>" + tokCell(r) + "</td>" +
            "<td>" + cacheCell(r.cacheHitRate) + "</td>" +
            '<td class="c">' + finish(r) + "</td></tr>";
        }).join("") + "</tbody></table>";
    } else {
      var ss = d.telemetry.sessions.filter(function (s) {
        return match(q, [s.sessionId, s.workerId, s.baseModelId, s.lastActualModelVersion, s.status]);
      });
      if (!ss.length) { $("traffic-body").innerHTML = empty("forum", "暂无会话"); return; }
      $("traffic-body").innerHTML =
        '<table class="tbl"><thead><tr><th>会话</th><th>模型</th><th>上游</th><th>轮次</th><th>Token</th><th>缓存</th><th class="r">TTFT</th><th class="r">活跃</th></tr></thead><tbody>' +
        ss.map(function (s) {
          var act = s.status === "ACTIVE", hitP = s.turns ? (s.hashHits / s.turns) * 100 : 0;
          return '<tr data-act="open-sess" data-id="' + esc(s.sessionId) + '">' +
            '<td><span class="sid"><span class="dot ' + (act ? "ok pulse" : "") + '" data-tip="' + (act ? "存续" : "已关闭") + '"></span><span class="mono">' + esc(s.sessionId.slice(0, 8)) + "</span></span></td>" +
            '<td><span class="model">' + esc(s.baseModelId) + lv(s.lastThinkingLevel) + "</span></td>" +
            "<td>" + upChip(s.lastActualModelVersion) + "</td>" +
            '<td><div class="turns" data-tip="复用 ' + s.hashHits + " / " + s.turns + '"><span class="mono">' + s.turns + '</span><div class="lin ok"><i style="width:' + hitP + '%"></i></div></div></td>' +
            "<td>" + tokCell(s) + "</td>" +
            "<td>" + cacheCell(s.cacheHitRate) + "</td>" +
            '<td class="r mono ' + tone(s.avgTtftMs) + '">' + ms(s.avgTtftMs) + "</td>" +
            '<td class="r mono muted" data-tip="' + dateTime(s.lastActiveAt) + '">' + span(now - s.lastActiveAt) + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
  }

  function renderRuntime(d) {
    var now = Date.now();
    $("rt-pool").innerHTML = slots(d) + poolMeta(d) + agentMeta(d);

    if (!d.workers.length) $("rt-workers").innerHTML = '<div class="card">' + empty("memory", "无进程") + "</div>";
    else $("rt-workers").innerHTML = d.workers.map(function (w) {
      var tn = stateTone(w.state), prog;
      if (w.state === "BUSY") prog = '<div class="lin indet" data-tip="处理中"><i></i></div>';
      else if (w.state === "IDLE") {
        var f = d.config.workerIdleTtlMs ? (w.idleTtlRemainingMs / d.config.workerIdleTtlMs) * 100 : 0;
        prog = '<div class="lin ok" data-tip="空闲回收倒计时 ' + span(w.idleTtlRemainingMs) + '"><i style="width:' + f + '%"></i></div>';
      } else prog = '<div class="lin"><i style="width:0"></i></div>';
      var sess = w.activeSessions.length
        ? w.activeSessions.map(function (id) {
            return '<span class="chip t-secondary" data-tip="' + esc(id) + '"><span class="mono" data-act="open-sess" data-id="' + esc(id) + '" style="cursor:pointer">' + esc(id.slice(0, 8)) + "</span>" +
              '<button class="chip-x" data-act="close-sess" data-w="' + esc(w.id) + '" data-s="' + esc(id) + '"><span class="ms">close</span></button></span>';
          }).join("")
        : '<span class="muted">–</span>';
      return '<div class="card worker">' +
        '<div class="w-head"><span class="ic ' + (tn === "busy" ? "t-primary" : tn === "ok" ? "t-ok" : tn === "warn" ? "t-warn" : "t-err") + '"><span class="ms">memory</span></span>' +
        '<div class="w-id"><span class="mono strong" data-tip="' + esc(w.relAppDataDir) + '">' + esc(w.id) + "</span>" +
        '<span class="muted" style="display:flex;align-items:center;gap:6px;font-size:12px"><span class="dot ' + tn + (tn === "busy" ? " pulse" : "") + '"></span>' + stateName(w.state) + "</span></div>" +
        '<button class="icon-btn danger" data-act="kill" data-id="' + esc(w.id) + '" data-tip="销毁"><span class="ms">power_settings_new</span></button></div>' +
        '<div class="w-stats">' +
        '<div class="stat" data-tip="PID"><span class="ms">tag</span><span class="mono">' + (w.pid || "–") + "</span></div>" +
        '<div class="stat" data-tip="嗅探端口"><span class="ms">lan</span><span class="mono">' + (w.snifferPort || "–") + "</span></div>" +
        '<div class="stat" data-tip="已处理请求"><span class="ms">bolt</span><span class="mono">' + w.totalRequestsHandled + "</span></div>" +
        '<div class="stat" data-tip="运行时长"><span class="ms">schedule</span><span class="mono">' + span(now - w.createdAt) + "</span></div></div>" +
        prog +
        '<div class="w-sess"><span class="ms muted" data-tip="挂载会话" style="font-size:18px">forum</span>' + sess + "</div></div>";
    }).join("");

    var act = d.telemetry.sessions.filter(function (s) { return s.status === "ACTIVE"; });
    if (!act.length) { $("rt-sessions").innerHTML = empty("forum", "无存续会话"); return; }
    var ttl = d.config.sessionTtlMs || 1;
    $("rt-sessions").innerHTML =
      '<table class="tbl"><thead><tr><th>会话</th><th>进程</th><th>模型</th><th>存续</th><th>哈希有效期</th><th>轮次</th><th></th></tr></thead><tbody>' +
      act.map(function (s) {
        var rem = Math.max(0, ttl - (now - s.lastActiveAt));
        return '<tr data-act="open-sess" data-id="' + esc(s.sessionId) + '">' +
          '<td><span class="sid"><span class="dot ok pulse"></span><span class="mono">' + esc(s.sessionId.slice(0, 8)) + "</span></span></td>" +
          '<td><span class="chip t-plain"><span class="ms">memory</span><span class="mono">' + esc(s.workerId) + "</span></span></td>" +
          '<td><span class="model">' + esc(s.baseModelId) + lv(s.lastThinkingLevel) + "</span></td>" +
          '<td class="mono" data-tip="' + dateTime(s.createdAt) + '">' + span(now - s.createdAt) + "</td>" +
          '<td><div style="display:flex;align-items:center;gap:8px;width:140px"><div class="lin' + (rem / ttl > 0.25 ? " ok" : "") + '" style="flex:1"><i style="width:' + (rem / ttl) * 100 + '%"></i></div><span class="mono muted">' + span(rem) + "</span></div></td>" +
          '<td class="mono">' + s.turns + "</td>" +
          '<td class="r"><button class="icon-btn" data-act="close-sess" data-w="' + esc(s.workerId) + '" data-s="' + esc(s.sessionId) + '" data-tip="关闭"><span class="ms">close</span></button></td></tr>';
      }).join("") + "</tbody></table>";
  }

  /* ---------- settings ---------- */
  function fillModels(d) {
    var sel = $("f-model"), cur = sel.value || d.config.defaultModel;
    var ids = d.unifiedModels.map(function (m) { return m.id; });
    if (ids.indexOf(d.config.defaultModel) < 0) ids.unshift(d.config.defaultModel);
    var html = ids.map(function (id) {
      var m = d.unifiedModels.filter(function (x) { return x.id === id; })[0];
      return '<option value="' + esc(id) + '">' + esc(m && m.name && m.name !== id ? id + " · " + m.name : id) + "</option>";
    }).join("");
    if (sel.innerHTML !== html) { sel.innerHTML = html; }
    sel.value = cur;
  }
  function renderLevel() {
    document.querySelectorAll("#f-level button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-v") === S.level); });
  }
  function renderLayout() {
    document.querySelectorAll("#f-layout button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-v") === S.layout); });
  }
  function applyLayout(l) {
    if (l !== "top" && l !== "side") l = "side";
    S.layout = l;
    document.documentElement.setAttribute("data-layout", l);
    localStorage.setItem("agy-layout", l);
    renderLayout();
  }
  function initSettings(d) {
    var c = d.config;
    if (location.pathname.indexOf("/v0/resource/plugins/") === 0 && c.port) {
      $("f-url").value = location.protocol + "//" + location.hostname + ":" + c.port + "/v1";
    } else {
      $("f-url").value = location.origin + "/v1";
    }
    fillModels(d);
    if (S.cfgReady && S.dirty) return;
    if (S.cfgReady) return;
    setDirty(false);
    $("f-apiKey").value = getAdminKey();
    $("f-model").value = c.defaultModel;
    S.level = c.defaultThinkingLevel || "medium";
    renderLevel();
    if (c.uiLayout === "top" || c.uiLayout === "side") {
      applyLayout(c.uiLayout);
    } else {
      renderLayout();
    }
    $("f-min").value = c.minWorkers;
    $("f-max").value = c.maxWorkers;
    $("f-idle").value = Math.round(c.workerIdleTtlMs / 1000);
    $("f-sess").value = trimZ((c.sessionTtlMs / 60000).toFixed(1));
    $("f-timeout").value = Math.round((c.requestTimeoutMs || 300000) / 1000);
    S.cfgReady = true;
  }
  function setDirty(v) { S.dirty = v; $("savebar").classList.toggle("on", v); }
  async function saveCfg() {
    var p = {
      apiKey: $("f-apiKey").value.trim(),
      defaultModel: $("f-model").value,
      defaultThinkingLevel: S.level,
      minWorkers: Number($("f-min").value),
      maxWorkers: Number($("f-max").value),
      workerIdleTtlMs: Math.round(Number($("f-idle").value) * 1000),
      sessionTtlMs: Math.round(Number($("f-sess").value) * 60000),
      requestTimeoutMs: Math.round(Number($("f-timeout").value) * 1000),
      uiLayout: S.layout,
    };
    if (!p.apiKey) { snack("API Key 不能为空", true); return; }
    await api("POST", "./api/admin/config", p);
    setAdminKey(p.apiKey);
    setDirty(false);
    S.cfgReady = false;
    snack("已保存");
    await poll();
  }

  /* ---------- sheet ---------- */
  function sec(icon, title, body) { return '<div><div class="sec-t"><span class="ms">' + icon + "</span>" + title + "</div>" + body + "</div>"; }
  function kv(k, v) { return '<div class="kv"><span>' + k + "</span><span>" + v + "</span></div>"; }
  function tokLegend(r) {
    var items = [["var(--primary)", "缓存", r.cachedReadTokens], ["var(--tertiary)", "输入", (r.inputTokens || 0) + (r.cachedWriteTokens || 0)],
                 ["var(--c-out)", "输出", r.outputTokens], ["var(--c-think)", "思考", r.thoughtTokens]];
    return '<div class="tok-legend">' + items.map(function (x) {
      return '<div><i style="background:' + x[0] + '"></i>' + x[1] + '<span class="mono">' + num(x[2]) + "</span></div>";
    }).join("") + "</div>";
  }
  function reqSheet(r) {
    var f = r.durationMs > 0 ? Math.min(100, (r.ttftMs / r.durationMs) * 100) : 0, sp = tps(r);
    return '<div class="hero">' + upChip(r.actualModelVersion, true) + '<span class="mono muted">' + dateTime(r.timestamp) + "</span></div>" +
      sec("route", "路由",
        kv("请求", '<span class="mono">' + esc(r.requestedModel) + "</span>") +
        kv("解析", '<span class="model">' + esc(r.resolvedBaseModel) + lv(r.thinkingLevel) + "</span>") +
        kv("ACP", '<span class="mono">' + esc(r.acpModelId) + "</span>") +
        kv("上游", upChip(r.actualModelVersion))) +
      sec("timer", "耗时",
        '<div class="tl-bar"><i style="width:' + f + "%;background:" + toneColor(r) + '"></i><i style="flex:1;background:var(--c-out)"></i></div>' +
        '<div class="tl-lbl"><span class="' + tone(r.ttftMs) + '">TTFT ' + ms(r.ttftMs) + "</span><span>" + ms(r.durationMs) + "</span></div>" +
        kv("生成速度", '<span class="mono">' + (sp ? trimZ(sp.toFixed(1)) + " tok/s" : "–") + "</span>")) +
      sec("token", "Token · " + tok(allTok(r)),
        stack(tokParts(r), 12) + tokLegend(r) +
        '<div class="kv" style="margin-top:8px"><span>命中</span><span class="cachecell">' + ring(r.cacheHitRate, 22, 3) + '<span class="mono">' + pct(r.cacheHitRate) + "</span></span></div>") +
      sec("forum", "会话",
        kv("会话", '<span data-act="open-sess" data-id="' + esc(r.sessionId) + '" style="cursor:pointer">' + sessChip(r.sessionCache === "HIT", r.sessionId, r.missReason) + "</span>") +
        (r.sessionCache !== "HIT" && r.missReason ? kv("未复用", esc(missName(r.missReason))) : "") +
        kv("进程", '<span class="mono">' + esc(r.workerId) + "</span>") +
        kv("传输", '<span class="chip t-plain">' + (r.stream ? "SSE" : "JSON") + "</span>")) +
      sec("flag", "结果", kv(esc(r.finishReason || "stop"), finish(r)) +
        (r.toolParseFailures ? kv("工具解析失败", '<span class="mono c-slow">' + r.toolParseFailures + "</span>") : "") +
        (r.errorMessage ? '<div class="err-box">' + esc(r.errorMessage) + "</div>" : "")) +
      '<div class="mono muted" style="font-size:11px">' + esc(r.requestId) + "</div>";
  }
  function sessSheet(s, d) {
    var act = s.status === "ACTIVE", reqs = d.telemetry.recentRequests.filter(function (r) { return r.sessionId === s.sessionId; });
    return '<div class="hero"><div style="display:flex;align-items:center;gap:8px"><span class="dot ' + (act ? "ok pulse" : "") + '"></span>' +
      '<span class="mono" style="word-break:break-all">' + esc(s.sessionId) + "</span>" +
      '<button class="icon-btn" data-act="copy" data-copy="' + esc(s.sessionId) + '" data-tip="复制"><span class="ms">content_copy</span></button></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><span class="chip ' + (act ? "t-ok" : "t-plain") + '">' + (act ? "存续" : "已关闭") + "</span>" +
      '<span class="chip t-plain"><span class="ms">memory</span><span class="mono">' + esc(s.workerId) + "</span></span>" + upChip(s.lastActualModelVersion) + "</div></div>" +
      '<div class="mini-stats">' +
      '<div class="stat"><span class="ms">repeat</span><span class="big">' + s.turns + '</span><span class="muted" style="font-size:12px">复用 ' + s.hashHits + "</span></div>" +
      '<div class="stat"><span class="ms">cached</span><span class="cachecell">' + ring(s.cacheHitRate, 26, 4) + '<span class="big">' + pct(s.cacheHitRate) + "</span></span></div>" +
      '<div class="stat"><span class="ms">timer</span><span class="big ' + tone(s.avgTtftMs) + '">' + ms(s.avgTtftMs) + "</span></div>" +
      '<div class="stat"><span class="ms">token</span><span class="big">' + tok(allTok(s)) + "</span></div></div>" +
      sec("token", "Token", stack(tokParts(s), 12) + tokLegend(s)) +
      sec("info", "详情",
        kv("模型", '<span class="model">' + esc(s.baseModelId) + lv(s.lastThinkingLevel) + "</span>") +
        kv("ACP", '<span class="mono">' + esc(s.lastAcpModelId) + "</span>") +
        kv("创建", '<span class="mono">' + dateTime(s.createdAt) + "</span>") +
        kv("活跃", '<span class="mono">' + dateTime(s.lastActiveAt) + "</span>")) +
      sec("receipt_long", "请求 · " + reqs.length,
        reqs.length ? '<div class="mini-list">' + reqs.map(function (r) {
          return '<div class="mini-row" data-act="open-req" data-id="' + esc(r.requestId) + '"><span class="mono muted">' + clock(r.timestamp) + "</span>" +
            '<span class="ms ' + (r.sessionCache === "HIT" ? "c-mid" : "c-muted") + '" style="font-size:16px">' + (r.sessionCache === "HIT" ? "link" : "fiber_new") + "</span>" +
            stack(tokParts(r), 6) + '<span class="mono r ' + tone(r.ttftMs) + '">' + ms(r.ttftMs) + '</span><span class="r">' + finish(r) + "</span></div>";
        }).join("") + "</div>" : empty("receipt_long", "无记录")) +
      (act ? '<div><button class="btn outlined danger" data-act="close-sess" data-w="' + esc(s.workerId) + '" data-s="' + esc(s.sessionId) + '"><span class="ms">close</span>关闭会话</button></div>' : "");
  }
  function renderSheet() {
    if (!S.sheet || !S.d) return;
    var d = S.d, body = "", title = "";
    if (S.sheet.t === "req") {
      var r = d.telemetry.recentRequests.filter(function (x) { return x.requestId === S.sheet.id; })[0];
      title = "请求"; body = r ? reqSheet(r) : empty("history", "记录已滚出窗口");
    } else {
      var s = d.telemetry.sessions.filter(function (x) { return x.sessionId === S.sheet.id; })[0];
      title = "会话"; body = s ? sessSheet(s, d) : empty("history", "记录不存在");
    }
    $("sheet-title").textContent = title;
    var b = $("sheet-body"), st = b.scrollTop;
    b.innerHTML = body;
    b.scrollTop = st;
  }
  function openSheet(t, id) {
    var changed = !S.sheet || S.sheet.t !== t || S.sheet.id !== id;
    S.sheet = { t: t, id: id };
    renderSheet();
    if (changed) $("sheet-body").scrollTop = 0;
    $("sheet").classList.add("on"); $("scrim").classList.add("on");
  }
  function closeSheet() { S.sheet = null; $("sheet").classList.remove("on"); $("scrim").classList.remove("on"); }

  /* ---------- infra ---------- */
  function resolveResourceUrl(relPath) {
    var p = relPath.replace(/^\.?\//, "");
    var loc = location.pathname;
    var baseDir = loc.endsWith("/") ? loc : loc.replace(/\/[^/]*$/, "/");
    return baseDir + p;
  }
  async function api(method, url, body) {
    var hdrs = authHeaders();
    var isCpaResource = location.pathname.indexOf("/v0/resource/plugins/") === 0;
    var r;
    if (isCpaResource && method !== "GET") {
      var resUrl = resolveResourceUrl(url);
      var sep = resUrl.indexOf("?") >= 0 ? "&" : "?";
      var tunnelUrl = resUrl + sep + "_method=" + encodeURIComponent(method);
      if (body) tunnelUrl += "&_body=" + encodeURIComponent(JSON.stringify(body));
      r = await fetch(tunnelUrl, { method: "GET", cache: "no-store", headers: Object.keys(hdrs).length ? hdrs : undefined });
    } else {
      if (body) hdrs["Content-Type"] = "application/json";
      r = await fetch(resolveApiUrl(url), { method: method, headers: Object.keys(hdrs).length ? hdrs : undefined, body: body ? JSON.stringify(body) : undefined });
    }
    var j = {};
    try { j = await r.json(); } catch (e) {}
    if (r.status === 401) { askAdminKey().then(poll); throw new Error("API Key 无效或缺失"); }
    if (!r.ok || j.status === "error" || j.status === "not_found") throw new Error(j.message || j.status || "HTTP " + r.status);
    return j;
  }
  var snT;
  function snack(msg, err) {
    var s = $("snack");
    s.textContent = msg;
    s.className = "snack on" + (err ? " err" : "");
    clearTimeout(snT);
    snT = setTimeout(function () { s.className = "snack" + (err ? " err" : ""); }, 2800);
  }
  function confirmDlg(icon, title, text, ok) {
    return new Promise(function (res) {
      var d = $("dlg");
      $("dlg-ic").textContent = icon; $("dlg-t").textContent = title; $("dlg-p").textContent = text || ""; $("dlg-ok").textContent = ok || "确定";
      var done = function (v) { $("dlg-ok").onclick = null; $("dlg-no").onclick = null; d.oncancel = null; if (d.open) d.close(); res(v); };
      $("dlg-ok").onclick = function () { done(true); };
      $("dlg-no").onclick = function () { done(false); };
      d.oncancel = function () { done(false); };
      d.showModal();
    });
  }
  function copyText(t) {
    var ok = function () { snack("已复制"); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t).then(ok, function () { snack("复制失败", true); }); return; }
    var ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); ok(); } catch (e) { snack("复制失败", true); }
    document.body.removeChild(ta);
  }
  function setSync(ok) {
    var cls = "dot " + (ok ? "ok pulse" : "err");
    var txt = ok ? "实时" : "离线";
    var tip = ok ? "更新于 " + clock(S.last) : "连接失败";
    $("sync-dot").className = cls;
    $("sync-t").textContent = txt;
    $("sync").setAttribute("data-tip", tip);
    if ($("sync-dot-top")) {
      $("sync-dot-top").className = cls;
      $("sync-t-top").textContent = txt;
      $("sync-top").setAttribute("data-tip", tip);
    }
  }
  function applyTheme() {
    var ic = document.documentElement.getAttribute("data-theme") === "dark" ? "light_mode" : "dark_mode";
    $("theme-ic").textContent = ic;
    if ($("theme-ic-top")) $("theme-ic-top").textContent = ic;
  }

  function render() {
    var d = S.d;
    if (!d) return;
    if (!S.cfgReady && d.config && (d.config.uiLayout === "top" || d.config.uiLayout === "side") && d.config.uiLayout !== S.layout) {
      applyLayout(d.config.uiLayout);
    }
    var b = $("badge-rt");
    if (d.pool.queuedRequests > 0) { b.textContent = d.pool.queuedRequests; b.className = "badge on err"; }
    else if (d.pool.busyWorkers > 0) { b.textContent = d.pool.busyWorkers; b.className = "badge on"; }
    else b.className = "badge";
    if (S.page === "home") renderHome(d);
    else if (S.page === "traffic") renderTraffic(d);
    else if (S.page === "runtime") renderRuntime(d);
    else if (S.page === "settings") initSettings(d);
    if (S.sheet) renderSheet();
  }
  async function poll() {
    try {
      var hdrs = authHeaders();
      var r = await fetch(resolveApiUrl("./api/admin/overview"), { cache: "no-store", headers: Object.keys(hdrs).length ? hdrs : undefined });
      if (r.status === 401) { setSync(false); await askAdminKey(); return poll(); }
      if (!r.ok) throw new Error("HTTP " + r.status);
      S.d = await r.json();
      S.last = Date.now();
      setSync(true);
      render();
    } catch (e) { setSync(false); }
  }
  function go(p) {
    if (!TITLES[p]) p = "home";
    S.page = p;
    document.querySelectorAll(".nav-item").forEach(function (n) { n.classList.toggle("active", n.getAttribute("data-page") === p); });
    document.querySelectorAll(".page").forEach(function (n) { n.classList.toggle("on", n.id === "page-" + p); });
    $("title").textContent = TITLES[p];
    render();
  }

  /* ---------- events ---------- */
  window.addEventListener("hashchange", function () { go(location.hash.slice(1)); });

  document.addEventListener("click", async function (e) {
    var el = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el) return;
    var a = el.getAttribute("data-act");
    try {
      if (a === "nav") { location.hash = el.getAttribute("data-page"); }
      else if (a === "open-req") { e.stopPropagation(); openSheet("req", el.getAttribute("data-id")); }
      else if (a === "open-sess") { e.stopPropagation(); openSheet("sess", el.getAttribute("data-id")); }
      else if (a === "close-sheet") closeSheet();
      else if (a === "tab") { S.tab = el.getAttribute("data-tab"); render(); }
      else if (a === "refresh") poll();
      else if (a === "theme") {
        var t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", t); localStorage.setItem("agy-theme", t); applyTheme(); render();
      }
      else if (a === "copy") copyText(el.getAttribute("data-copy"));
      else if (a === "kill") {
        var id = el.getAttribute("data-id");
        if (await confirmDlg("power_settings_new", "销毁进程", id + " 上的会话将全部关闭", "销毁")) {
          await api("DELETE", "./api/admin/workers?id=" + encodeURIComponent(id)); snack("已销毁 " + id); poll();
        }
      }
      else if (a === "close-sess") {
        e.stopPropagation();
        var sid = el.getAttribute("data-s");
        await api("DELETE", "./api/admin/sessions?workerId=" + encodeURIComponent(el.getAttribute("data-w")) + "&sessionId=" + encodeURIComponent(sid));
        snack("已关闭 " + sid.slice(0, 8)); poll();
      }
      else if (a === "spawn") { var j = await api("POST", "./api/admin/workers/spawn"); snack("已启动 " + j.workerId); poll(); }
      else if (a === "clear") {
        if (await confirmDlg("cleaning_services", "清空会话哈希", "后续请求将新建会话，无法复用已有上下文", "清空")) {
          await api("POST", "./api/admin/sessions/clear-cache"); snack("已清空"); poll();
        }
      }
      else if (a === "copy-url") copyText($("f-url").value);
      else if (a === "copy-key") copyText($("f-apiKey").value);
      else if (a === "toggle-key") {
        var k = $("f-apiKey"), show = k.classList.contains("masked");
        k.classList.toggle("masked", !show); $("key-eye").textContent = show ? "visibility_off" : "visibility";
      }
      else if (a === "gen-key") {
        var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", buf = new Uint32Array(32), out = "sk-agy-";
        crypto.getRandomValues(buf);
        for (var i = 0; i < buf.length; i++) out += chars.charAt(buf[i] % chars.length);
        $("f-apiKey").value = out; $("f-apiKey").classList.remove("masked"); $("key-eye").textContent = "visibility_off"; setDirty(true);
      }
      else if (a === "lv-pick") { S.level = el.getAttribute("data-v"); renderLevel(); setDirty(true); }
      else if (a === "layout-pick") {
        var nl = el.getAttribute("data-v");
        applyLayout(nl);
        await api("POST", "./api/admin/config", { uiLayout: nl });
        snack(nl === "top" ? "已切换为顶部 CPA 适配导航" : "已切换为左侧标准导航");
      }
      else if (a === "step") {
        var inp = $(el.getAttribute("data-for")), v = (Number(inp.value) || 0) + Number(el.getAttribute("data-d"));
        v = Math.max(Number(inp.min), Math.min(Number(inp.max), v)); inp.value = v; setDirty(true);
      }
      else if (a === "save") await saveCfg();
      else if (a === "revert") { setDirty(false); S.cfgReady = false; if (S.d) initSettings(S.d); }
    } catch (err) { snack(err && err.message ? err.message : String(err), true); }
  });

  $("settings-form").addEventListener("input", function () { if (!S.cfgReady) return; setDirty(true); });
  $("q").addEventListener("input", function (e) { S.q = e.target.value; if (S.d) renderTraffic(S.d); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.sheet) closeSheet(); });

  var tipEl = $("tip");
  document.addEventListener("mousemove", function (e) {
    var t = e.target.closest ? e.target.closest("[data-tip]") : null;
    if (!t) { tipEl.classList.remove("on"); return; }
    var txt = t.getAttribute("data-tip");
    if (tipEl.textContent !== txt) tipEl.textContent = txt;
    tipEl.classList.add("on");
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var x = Math.min(e.clientX + 12, window.innerWidth - w - 8);
    var y = e.clientY + 18 + h > window.innerHeight ? e.clientY - h - 10 : e.clientY + 18;
    tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
  });
  document.addEventListener("mouseleave", function () { tipEl.classList.remove("on"); });

  applyTheme();
  applyLayout(S.layout);
  go(location.hash.slice(1) || "home");
  poll();
  setInterval(function () { if (!document.hidden) poll(); }, 2000);
</script>
</body>
</html>`;

export function renderDashboardHtml(): string {
  return DASHBOARD_HTML;
}

/* =============================================================================
   Doctor D's BBQ — Inventory & Sales console (new design, vanilla JS SPA)
   Renders the design wired to the pure-Python / Postgres backend (app.py).
   All data comes from the DB views; all writes go through app.py, which calls
   fn_finalize_sale — the UI never duplicates the money math.
   ============================================================================= */
(() => {
"use strict";

const ACCENT = "#7a1f1f";
const root = document.getElementById("root");

// ---- data + view state -----------------------------------------------------
const NEEDS_API = 6;              // must match API_VERSION in app.py
const STALE_SERVER = "The app server that's running is older than this page, so some lists would come up empty. " +
  "Restart it: in the terminal running the app press Ctrl+C, then start it again (py app.py). " +
  "If it then says the database is on an older script, rerun DoctorDs_Inventory_System.sql in DBeaver (Alt+X) first.";
let D = null;                     // bootstrap payload from the server
const S = {
  page: "overview", range: "12m", metric: "revenue", hover: null, trendView: "monthly", jarsView: "product",
  ledgerFilter: "all", notice: null, loading: false,
  // form values start empty / from the database (see boot): nothing is pre-typed
  sale:  { mode: "single", channel: null, state: null, county: null,
           qty: {}, price: {},                                             // per product code
           shipRev: "0", shipExp: "0",                                     // shipped orders only
           cash: { total: "0", jars: {} },                                 // market: cash box
           card: { total: "0", fee: "0", jars: {} } },                     // market: card reader
  schMonth: null,                                                          // Function 3 report month
  inv:   { mode: "restock", product: null, jars: "", code: "",
           reason: "Breakage", adjJars: "", direction: "loss", note: "" },
  cnt:   { product: null, counted: null, note: "Shelf count", reconcile: true },
  taxState: null, taxCounties: null, taxPlan: null,   // taxPlan: null | "loading" | {preview} | {error}
  set:   { prod: {}, ch: {}, newProd: null, newCh: null, biz: null, saving: null, msg: null },   // Settings tab drafts
};

// ---- formatting helpers ----------------------------------------------------
const money = n => "$" + Math.round(n).toLocaleString("en-US");
const cents = n => "$" + Number(n).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
const short = n => n >= 1000 ? (n/1000).toFixed(1) + "k" : String(n);
const sgn   = n => (n > 0 ? "+" : "") + Number(n).toLocaleString("en-US");
const pctR  = r => r == null ? "— needs review" : (r*100).toFixed(2) + "%";
const num   = v => Math.max(0, Number(v) || 0);
// "Wake" -> "Wake County"; names that already say what they are stay as they are
const cty   = name => /county|parish|borough|city|census area|municipality|not listed|^—$/i.test(String(name)) ? name : name + " County";
const esc   = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// style builders (mirror the design)
const pill = a => `border:0;border-radius:6px;padding:7px 12px;white-space:nowrap;font:${a?600:500} 13px 'IBM Plex Sans',sans-serif;cursor:pointer;background:${a?"#221e1b":"transparent"};color:${a?"#fff":"#5b534b"}`;
const chip = a => `border:1px solid ${a?ACCENT:"#e6e0d8"};border-radius:999px;padding:5px 12px;white-space:nowrap;font:500 12px 'IBM Plex Sans',sans-serif;cursor:pointer;background:${a?ACCENT:"#fff"};color:${a?"#fff":"#5b534b"}`;
const opt  = a => `border:1.5px solid ${a?ACCENT:"#e0d9d0"};border-radius:8px;padding:10px 14px;white-space:nowrap;font:${a?600:500} 14px 'IBM Plex Sans',sans-serif;cursor:pointer;background:${a?ACCENT+"10":"#fff"};color:${a?ACCENT:"#3d3731"}`;
const badge = (bg,fg) => `font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;background:${bg};color:${fg}`;
// "Download CSV": the COMPLETE data behind a table, straight from the database (opens in Excel)
const DL_ICON = `<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8m0 0L4.5 6.5M8 10l3.5-3.5M2.5 13.5h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const dlBtn = (name, what, params = {}, label = "Download CSV") => {
  const qs = new URLSearchParams(params).toString();
  return `<a class="dl" href="/api/export/${name}.csv${qs ? "?" + qs : ""}" download title="Download ${esc(what)} as a CSV file (opens in Excel)">${DL_ICON}${label}</a>`;
};
const btnPrimary = "background:#7a1f1f;color:#fff;border:0;border-radius:8px;padding:13px 16px;font:600 15px 'IBM Plex Sans',sans-serif;cursor:pointer";

const CURRENT_STATUS = new Set(["Verified", "Refreshed"]);
const STATUS_STYLE = {
  "Verified":        ["#e9f4ec", "#1d6b35", "✓ Verified"],
  "Refreshed":       ["#eef2fb", "#2a4f9a", "Refreshed"],
  "Provisional":     ["#f0ebe4", "#7d746b", "Provisional"],
  "Review Required": ["#fbf1e3", "#8a5a00", "Review required"],
  "State only":      ["#f0ebe4", "#7d746b", "State only"],
};
const statusBadge = st => { const [bg,fg,label] = STATUS_STYLE[st] || ["#f0ebe4","#7d746b",st];
  return `<span style="${badge(bg,fg)};white-space:nowrap">${esc(label)}</span>`; };
const safeLink = (url, text) => /^https:\/\//.test(url||"")
  ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text);
const TYPE_LABEL = { PRODUCTION: "Batch", SALE: "Sale", ADJUSTMENT: "Adjust" };
const TYPE_COLOR = { PRODUCTION: ["#e9f4ec","#1d6b35"], SALE: ["#eef2fb","#2a4f9a"], ADJUSTMENT: ["#fbf1e3","#8a5a00"] };
const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonth = mdY => { const p = String(mdY).split("-"); return `${MONTHS[+p[0]]||p[0]} ${p[2]||""}`.trim(); };

// ---- lookups over current data (everything below reads the database payload) --
const CFG = key => ((D && D.settings) || {})[key] || "";                 // business_setting table
const HOME = () => CFG("home_state");
const productByCode = code => (D.products || []).find(p => p.code === code) || {};
const productName = code => productByCode(code).name || code;
const prod   = code => D.inventory.find(p => p.code === code) ||
  { code, on_hand: 0, reorder: productByCode(code).reorder_level || 0, produced: 0, sold: 0, adjusted: 0, name: productName(code) };
const onHand = code => prod(code).on_hand;
const countyByCode = code => D.counties.find(c => c.code === code);
const channelByName = name => D.channels.find(c => c.name === name);
// licence (scholarship) settings come from the product table
const schRate = code => productByCode(code).scholarship_rate || 0;
const isCobranded = code => !!productByCode(code).is_cobranded;
const cobrandName = () => (D.products || []).filter(p => p.is_cobranded).map(p => p.name).join(" & ") || "co-branded products";
const otherNames = () => (D.products || []).filter(p => !p.is_cobranded).map(p => p.name).join(" & ") || "other products";
const pctTxt = r => +((r || 0) * 100).toFixed(2) + "%";
const schPct = () => pctTxt(Math.max(0, ...(D.products || []).map(p => p.scholarship_rate || 0)));
const licensor = () => CFG("licensor_name") || "licensor";
const countiesOf = st => D.counties.filter(c => c.state === st);
const defaultCounty = st => { const list = countiesOf(st), want = CFG("default_county");
  return ((list.find(c => c.code === want)) || list[0] || {}).code || null; };
const SHIPS = name => !!(channelByName(name) || {}).ships;               // sales_channel.ships_orders
// default price for a product on a channel: the channel's price basis applied to the product's prices
const priceFor = (channelName, code) => { const ch = channelByName(channelName) || {}, p = productByCode(code);
  return ch.price_basis === "wholesale" ? p.wholesale_price : ch.price_basis === "free" ? 0 : p.retail_price; };
const setChannelPrices = () => (D.products || []).forEach(p => { S.sale.price[p.code] = String(priceFor(S.sale.channel, p.code) ?? 0); });
// the qualifying-food rate in the home state (tax_code.food_rate), for explanations
const homeFoodRate = () => { const c = D.counties.find(x => x.state === HOME() && x.food_rate != null); return c ? c.food_rate : null; };
const feeText = ch => ch && (ch.fee_pct > 0 || ch.fee_fixed > 0)
  ? `${pctTxt(ch.fee_pct)}${ch.fee_fixed ? ` + $${ch.fee_fixed.toFixed(2)}` : ""} of the order total` : "";
// on-hand bar scale: the larger of the biggest stock and twice the biggest reorder level
const stockScale = () => Math.max(1, ...D.inventory.map(p => Math.max(p.on_hand, p.reorder * 2))) * 1.05;
const r2 = n => Math.round(n * 100) / 100;
// logo initials from the business name, e.g. "Doctor D's BBQ" -> "DD"
const initials = name => (String(name).match(/\b[A-Z]/g) || ["?"]).slice(0, 2).join("");

// =============================================================================
//  BOOT
// =============================================================================
async function boot(){
  try {
    const r = await fetch("/api/bootstrap");
    const j = await r.json();
    if (j.error) { showError(j.error); return; }
    if (!(j.api_version >= NEEDS_API)) { showError(STALE_SERVER); return; }
    D = j;
    // every default comes from the database: first channel, home state + default county,
    // product prices for that channel, first product, current on-hand for the count
    if (!S.sale.channel) { S.sale.channel = (D.channels[0] || {}).name || null; setChannelPrices(); }
    if (!S.sale.state)   S.sale.state = HOME() || (D.tax_states || [])[0] || null;
    if (!S.sale.county)  S.sale.county = defaultCounty(S.sale.state);
    if (!S.taxState)     S.taxState = S.sale.state;
    const first = (D.products[0] || {}).code;
    if (!S.inv.product)  S.inv.product = first;
    if (!S.cnt.product)  S.cnt.product = first;
    if (S.cnt.counted == null) S.cnt.counted = String(onHand(S.cnt.product));
    S.inv.code = suggestBatch(S.inv.product);
    render();
  } catch (e) { showError("Could not reach the server. Is app.py running?  (" + e + ")"); }
}
function showError(msg){
  root.innerHTML = `<div style="max-width:720px;margin:80px auto;padding:0 20px">
    <div style="background:#fbeeee;border:1px solid #efc9c9;color:#8a1c12;border-radius:12px;padding:20px 24px;font-size:15px;line-height:1.6">
      <strong>Can't load the console.</strong><br>${esc(msg)}
      ${/password|could not connect|reach the server|refused|timeout/i.test(msg) && !/older than this page|older version of the script/.test(msg) ? `<br><br>
      <span style="color:#5b534b">Start the backend with <span class="mono">.\\.venv\\Scripts\\python.exe app.py</span>.
      The database password is read from <span class="mono">local_settings.json</span> (or the
      <span class="mono">DD_DB_PASSWORD</span> environment variable).</span>` : ""}
    </div></div>`;
}

async function refresh(){
  const r = await fetch("/api/bootstrap");
  const j = await r.json();
  if (j.error) { showError(j.error); return; }
  if (!(j.api_version >= NEEDS_API)) { showError(STALE_SERVER); return; }
  D = j;
  render();
}

// POST a write action, show the server's authoritative message, then refresh.
// No button is ever disabled. While a save runs its label reads "Saving…"; "busy" is
// cleared before the page is redrawn, so the next entry can be saved straight away.
async function post(path, payload){
  if (S.loading) {                            // second click while saving: say so (prevents a duplicate entry)
    S.notice = { ok: true, text: "Still saving your last entry — it will appear in a second." }; render(); return null;
  }
  S.loading = true; render();
  let j = null;
  try {
    const r = await fetch(path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
    j = await r.json();
    S.notice = { ok: !!j.ok, text: j.message || (j.ok ? "Done." : "Something went wrong.") };
  } catch (e) {
    S.notice = { ok:false, text:"Request failed: " + e };
  }
  S.loading = false;
  try { await refresh(); }                     // re-pull fresh numbers from the DB (redraws, buttons enabled)
  catch (e) { render(); }
  return j;
}

// =============================================================================
//  RENDER
// =============================================================================
// page titles; the overview line is built from the live counts
const PAGES = () => ({
  overview:  ["Overview",   `Live from the database — ${D.totals.sales.toLocaleString("en-US")} sales across ${D.totals.channels} channels, inventory, and the ${esc(licensor())} scholarship.`],
  sales:     ["Sales",      `Record what you sold. Stock, sales tax, the ${esc(licensor())} scholarship and profit all update automatically.`],
  inventory: ["Inventory",  "Add production batches or record breakage, spoilage and samples. Every change lands in the ledger."],
  count:     ["Stock count","Count the jars on the shelf and compare with what the system expects."],
  reports:   ["Reports",    "What you earned, where it went, and what to reorder next."],
  tax:       ["Tax rates",  "How sales tax is charged, and Function 1's county rate dataset behind it."],
  settings:  ["Settings",   "Products, prices, costs, fees, tax and business settings. Every rule the dashboard follows comes from here."],
});
const NAV = [["overview","Overview"],["sales","Sales"],["inventory","Inventory"],["count","Stock count"],["reports","Reports"],["tax","Tax rates"],["settings","Settings"]];

function render(){
  if (!D) return;
  document.title = `${CFG("business_name")} — Inventory & Sales`;
  const [title, sub] = PAGES()[S.page];
  const nav = NAV.map(([k,l]) => {
    const a = S.page === k;
    return `<button data-nav="${k}" style="border:0;padding:8px 12px;border-radius:7px;font:${a?600:500} 14px 'IBM Plex Sans',sans-serif;cursor:pointer;color:${a?"#221e1b":"#7d746b"};background:${a?"#f2ede7":"transparent"}">${l}</button>`;
  }).join("");

  const n = S.notice;
  const notice = n ? `<div style="display:flex;align-items:center;gap:14px;border-radius:10px;padding:13px 18px;font-size:14px;font-weight:500;background:${n.ok?"#e9f4ec":"#fbeeee"};border:1px solid ${n.ok?"#b5dcc0":"#efc9c9"};color:${n.ok?"#1d5b30":"#8a1c12"}">
      <span style="flex:1">${esc(n.text)}</span>
      <button id="dismiss" style="background:transparent;border:0;font:500 13px 'IBM Plex Sans',sans-serif;color:inherit;cursor:pointer;text-decoration:underline">Dismiss</button>
    </div>` : "";

  const rangeToggle = S.page === "overview" ? `<div style="display:flex;background:#fff;border:1px solid #e6e0d8;border-radius:8px;padding:3px;gap:2px">
      ${[["6m","6 months"],["12m","12 months"],["all","All time"]].map(([k,l]) =>
        `<button data-range="${k}" style="${pill(S.range===k)}">${l}</button>`).join("")}
    </div>` : "";

  let body = "";
  if (S.page === "overview")  body = pageOverview();
  else if (S.page === "sales") body = pageSales();
  else if (S.page === "inventory") body = pageInventory();
  else if (S.page === "count") body = pageCount();
  else if (S.page === "reports") body = pageReports();
  else if (S.page === "tax") body = pageTax();
  else if (S.page === "settings") body = pageSettings();

  root.innerHTML = `
  <div style="min-height:100vh;background:#f5f2ee">
    <header style="background:#fff;border-bottom:1px solid #e6e0d8;position:sticky;top:0;z-index:5">
      <div class="hwrap shell" style="padding-top:14px;padding-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:36px;height:36px;border-radius:8px;background:#7a1f1f;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px">${esc(initials(CFG("business_name")))}</div>
          <div><div style="font-weight:700;font-size:16px;letter-spacing:-0.01em">${esc(CFG("business_name"))}</div>
            <div style="font-size:12px;color:#7d746b">Inventory &amp; Sales</div></div>
        </div>
        <nav style="display:flex;gap:4px;flex-wrap:wrap">${nav}</nav>
        <button data-nav="sales" style="background:#7a1f1f;color:#fff;border:0;border-radius:8px;padding:10px 16px;white-space:nowrap;font:600 14px 'IBM Plex Sans',sans-serif;cursor:pointer">+ Record sale</button>
      </div>
    </header>
    <main class="shell" style="padding-top:28px;padding-bottom:56px;display:flex;flex-direction:column;gap:20px">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div><h1 style="margin:0;font-size:26px;font-weight:700;letter-spacing:-0.02em">${title}</h1>
          <p style="margin:4px 0 0;font-size:14px;color:#7d746b;max-width:680px">${sub}</p></div>
        ${rangeToggle}
      </div>
      ${notice}
      ${body}
    </main>
  </div>`;

  bind();
}

// ---- event binding ---------------------------------------------------------
function bind(){
  root.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => { S.page = b.dataset.nav; S.notice = null; S.set.msg = null; render(); });
  root.querySelectorAll("[data-range]").forEach(b => b.onclick = () => { S.range = b.dataset.range; S.hover = null; render(); });
  root.querySelectorAll("[data-metric]").forEach(b => b.onclick = () => { S.metric = b.dataset.metric; S.hover = null; render(); });
  const dismiss = root.querySelector("#dismiss"); if (dismiss) dismiss.onclick = () => { S.notice = null; render(); };
  const schSel = root.querySelector("#sch-month"); if (schSel) schSel.onchange = () => { S.schMonth = schSel.value; render(); };
  if (S.page === "overview") bindTrend();
  if (S.page === "sales") bindSales();
  else if (S.page === "inventory") bindInventory();
  else if (S.page === "count") bindCount();
  else if (S.page === "tax") bindTax();
  else if (S.page === "settings") bindSettings();
}

// =============================================================================
//  OVERVIEW
// =============================================================================
function monthlySlice(){
  const m = D.monthly || [];
  if (S.range === "6m")  return m.slice(-6);
  if (S.range === "12m") return m.slice(-12);
  return m;
}
// =============================================================================
//  SALES TREND CARD  (Overview) — monthly bars + year-over-year lines.
//  Jars can be shown per product (two charts, same scale) or combined (stacked).
//  Palette validated with the dataviz checker (light surface): all checks pass.
// =============================================================================
const SERIES = ["#9e2f2a", "#a8770f", "#2f6db8"];          // maroon · gold · blue (fixed order)
const SER_MAIN = SERIES[0];                                  // single-series charts
const OLDER  = "#a39a90";                                    // years beyond the 3rd: neutral
const METRIC = {
  revenue: { label: "Revenue",      noun: "revenue",      get: m => m.revenue,               fmt: n => money(n) },
  profit:  { label: "Gross profit", noun: "gross profit", get: m => m.gross_profit,          fmt: n => money(n) },
  jars:    { label: "Jars sold",    noun: "jars",         get: m => m.jars,                  fmt: n => Math.round(n).toLocaleString("en-US") },
};
// one series per product in the database (fixed colour order by product id)
const PRODUCTS = () => (D.products || []).map((p, i) => ({ code: p.code, name: p.name,
  get: m => ((m.by || {})[p.code] || 0), color: SERIES[i] || OLDER }));
const compact = n => { const a = Math.abs(n);
  return a >= 1e6 ? (n/1e6).toFixed(1) + "M" : a >= 1e4 ? Math.round(n/1e3) + "k" : a >= 1e3 ? (n/1e3).toFixed(1) + "k" : String(Math.round(n)); };
const niceMax = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(s => n <= s)) * p; };     // fine steps: bars use the height
// size of a % change: "0.4", "3.5", "12" (a small dip never reads as "down 0%")
const pctAbs = p => { const a = Math.abs(p); return a < 10 ? String(+a.toFixed(1)) : a.toFixed(0); };
const pctChange = (now, before) => before ? (now - before) / before * 100 : null;
const deltaChip = (pct, suffix = "") => pct == null ? `<span style="color:#8f867c">—</span>`
  : `<span style="font-weight:600;color:${pct >= 0 ? "#1d6b35" : "#b42318"}">${pct >= 0 ? "▲" : "▼"} ${pctAbs(pct)}%${suffix}</span>`;
const mKey = m => { const p = String(m.month).split("-"); return { mm: +p[0], yy: +p[2] }; };
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monYear = m => { const k = mKey(m); return `${MON[k.mm-1]} ${k.yy}`; };
const dollar = () => S.metric === "jars" ? "" : "$";

// a month is "partial" when the data starts or stops part-way through it
// (the month the history begins, and the current month) — kept out of averages and comparisons
function partialKind(m){
  const k = mKey(m), at = iso => iso ? new Date(iso + "T00:00:00") : null;
  const f = at(D.data_from), t = at(D.data_through);
  if (t && t.getFullYear() === k.yy && t.getMonth() + 1 === k.mm && t.getDate() < new Date(k.yy, k.mm, 0).getDate()) return "end";
  if (f && f.getFullYear() === k.yy && f.getMonth() + 1 === k.mm && f.getDate() > 1) return "start";
  return null;
}
const isPartial = m => !!partialKind(m);
let TRENDS = [];                                             // one entry per plot, read by the hover handlers
// Width available to the trend card's plots, so charts are sized to the screen
// (SVG text stays ~11px, bars keep a sensible aspect ratio). Re-rendered on resize.
let TREND_W = null;                                          // measured plot width (px), set after render
const TREND_FIT = {};                                        // extra plot height per layout, so the card fills its row
const fitKey = () => [S.trendView, S.metric, S.jarsView, S.range, TREND_W].join("|");
const fitExtra = (share = 1) => Math.round((TREND_FIT[fitKey()] || 0) * share);
function trendWidth(){
  if (TREND_W) return TREND_W;
  const vw = Math.min(window.innerWidth || 1280, 1760), pad = 2 * Math.max(16, Math.min(48, vw * 0.03));
  const content = vw - pad, sideBySide = content >= 560 + 300 + 16;
  return Math.max(300, (sideBySide ? (content - 16) * 2 / 3 : content) - 46);
}
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function seriesStats(slice, get){
  const vals = slice.map(get);
  const full = slice.map((m,i) => ({ m, v: vals[i], i })).filter(x => !isPartial(x.m));
  const avg = full.length ? full.reduce((a,x) => a + x.v, 0) / full.length : 0;
  const best = full.length ? full.reduce((a,x) => x.v > a.v ? x : a) : null;
  const last = full[full.length-1] || null, prev = full[full.length-2] || null;
  return { vals, full, avg, best, last, prev, lastChg: last && prev ? pctChange(last.v, prev.v) : null,
           total: vals.reduce((a,b) => a + b, 0) };
}
const statTile = (label, value, sub, basis = 110) => `<div style="flex:1 1 ${basis}px;min-width:0;border-left:3px solid #f0ebe4;padding:2px 0 2px 10px">
    <div style="font-size:12px;color:#7d746b">${label}</div>
    <div style="font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap">${value}</div>
    <div style="font-size:12px;color:#8f867c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div></div>`;
const swatch = (c, label, extra = "") => `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:12px;height:12px;border-radius:3px;background:${c};${extra}"></span>${label}</span>`;
const hatch = c => `repeating-linear-gradient(45deg, ${c} 0 5px, ${c}55 5px 9px)`;
const tipBox = id => `<div id="tt-${id}" style="position:absolute;display:none;pointer-events:none;z-index:3;background:#221e1b;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.5;box-shadow:0 4px 14px #0003;white-space:nowrap"></div>`;

function trendCard(slice){
  TRENDS = [];
  const views = [["monthly","Monthly"],["yearly","Year over year"]].map(([k,l]) =>
    `<button data-trendview="${k}" style="${pill(S.trendView===k)}">${l}</button>`).join("");
  const metricBtns = [["revenue","Revenue"],["profit","Profit"],["jars","Jars"]].map(([k,l]) =>
    `<button data-metric="${k}" style="${chip(S.metric===k)}">${l}</button>`).join("");
  const split = S.metric === "jars" ? `<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#5b534b">Show jars
      <div style="display:flex;background:#f7f4f0;border-radius:8px;padding:3px;gap:2px">${[["product","By product"],["combined","Combined"]].map(([k,l]) =>
        `<button data-jarsview="${k}" style="${pill(S.jarsView===k)};padding:5px 10px;font-size:12px">${l}</button>`).join("")}</div></div>` : "";
  const byProduct = S.metric === "jars" && S.jarsView === "product";
  const body = S.trendView === "yearly"
    ? (byProduct ? yearlyByProduct() : yearlyView(METRIC[S.metric]))
    : (byProduct ? monthlyByProduct(slice) : monthlyView(slice, METRIC[S.metric]));
  return `<div data-trendcard style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px;flex:2 1 560px;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:16px;font-weight:600">Sales trend</h2>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <div style="display:flex;background:#f7f4f0;border-radius:8px;padding:3px;gap:2px">${views}</div>
          <div style="display:flex;gap:6px">${metricBtns}</div></div></div>
      ${split}
      ${body}
    </div>`;
}

// ---- one bar plot (stacked when segs has 2 entries) --------------------------
function barPlot({ id, slice, st, top, height, segs, tip }){
  const y = v => v / top * 100;
  const grid = [1, 0.5, 0].map(f => `<div style="position:absolute;left:0;right:0;bottom:${f*100}%;border-top:1px ${f ? "dashed #ebe5dd" : "solid #d9d2c9"}">
      <span style="position:absolute;left:-44px;width:38px;text-align:right;top:-8px;font-size:11px;color:#8f867c;font-variant-numeric:tabular-nums">${dollar()}${compact(top*f)}</span></div>`).join("");
  const avgLine = `<div style="position:absolute;left:0;right:0;bottom:${y(st.avg)}%;border-top:2px dashed #221e1b;opacity:.55;pointer-events:none"></div>
      <span style="position:absolute;right:0;bottom:calc(${y(st.avg)}% + 3px);font-size:11px;font-weight:600;color:#221e1b;background:#ffffffd9;padding:0 4px;border-radius:3px;pointer-events:none">avg ${dollar()}${compact(st.avg)}</span>`;
  const bars = slice.map((m,i) => {
    const v = st.vals[i], part = isPartial(m), h = y(v), fill = c => part ? hatch(c) : c;
    const inner = segs.length > 1
      ? `<div style="height:${h}%;display:flex;flex-direction:column-reverse;gap:2px;width:100%;max-width:40px">${segs.map((s,si) => { const sv = s.get(m);
          return `<div style="flex:${sv} 1 0;min-height:${sv?2:0}px;background:${fill(s.color)};border-radius:${si === segs.length-1 ? "4px 4px 0 0" : "0"}"></div>`; }).join("")}</div>`
      : `<div style="height:${h}%;width:100%;max-width:40px;background:${fill(segs[0].color)};border-radius:4px 4px 0 0"></div>`;
    const tag = st.best && st.best.i === i ? `<div style="position:absolute;bottom:calc(${h}% + 4px);font-size:10px;font-weight:700;color:${ACCENT};white-space:nowrap">★ best</div>`
      : part ? `<div style="position:absolute;bottom:calc(${h}% + 4px);font-size:10px;color:#7d746b;white-space:nowrap">${partialKind(m) === "end" ? "so far" : "partial"}</div>` : "";
    return `<div data-ti="${i}" class="tbar" style="flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0;cursor:pointer;position:relative;transition:opacity .12s">${tag}${inner}</div>`;
  }).join("");
  const xl = slice.map((m,i) => { const k = mKey(m), showYear = i === 0 || k.mm === 1;
    return `<div style="flex:1;text-align:center;font-size:11px;color:#8f867c;min-width:0;line-height:1.25">${MON[k.mm-1]}${showYear ? `<div style="font-weight:600;color:#5b534b">'${String(k.yy).slice(2)}</div>` : ""}</div>`; }).join("");
  TRENDS.push({ id, kind: "bars", tip });
  return `<div style="position:relative;margin-left:44px;margin-top:6px">
      <div id="tp-${id}" style="position:relative;height:${height}px">
        ${grid}${avgLine}
        <div style="position:absolute;inset:0;display:flex;align-items:flex-end;gap:${slice.length > 14 ? 3 : 6}px">${bars}</div>
        ${tipBox(id)}
      </div>
      <div style="display:flex;gap:${slice.length > 14 ? 3 : 6}px;margin-top:6px">${xl}</div>
    </div>`;
}
const monthTip = (slice, vals, i, unit, extra = "") => {
  const m = slice[i], chg = i ? pctChange(vals[i], vals[i-1]) : null;
  return `<div style="font-weight:700">${monYear(m)}${partialKind(m) === "end" ? " · so far" : partialKind(m) === "start" ? " · partial (data starts mid-month)" : ""}</div>
    <div style="font-size:15px;font-weight:600">${unit(vals[i])}</div>${extra}
    ${chg == null ? "" : `<div style="opacity:.85">${chg >= 0 ? "▲" : "▼"} ${pctAbs(chg)}% vs ${MON[mKey(slice[i-1]).mm-1]}</div>`}`;
};
const legendRow = (items, anyPartial) => `<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#5b534b;align-items:center">
    ${items}${swatch("transparent", "Monthly average", "border-top:2px dashed #221e1b;height:0;border-radius:0;opacity:.55")}
    ${anyPartial ? swatch(hatch("#9a928a"), "Partial month") : ""}
    <button data-nav="reports" style="margin-left:auto;background:transparent;border:0;padding:0;font:500 12px 'IBM Plex Sans',sans-serif;color:${ACCENT};cursor:pointer">See the table →</button></div>`;
const rangeLabel = () => S.range === "all" ? "all time" : S.range === "6m" ? "last 6 months" : "last 12 months";

// ---- Monthly: one metric (revenue / profit / jars combined) ------------------
function monthlyView(slice, M){
  if (!slice.length) return `<p style="color:#8f867c">No sales yet.</p>`;
  const st = seriesStats(slice, M.get), jars = S.metric === "jars";
  const trend = st.lastChg == null ? "" : `; ${MON[mKey(st.last.m).mm-1]} was ${st.lastChg >= 0 ? "up" : "down"} <strong>${pctAbs(st.lastChg)}%</strong> on ${MON[mKey(st.prev.m).mm-1]}`;
  const headline = `Averaging <strong>${M.fmt(st.avg)} ${M.noun} a month</strong>. Best month: <strong>${st.best ? monYear(st.best.m) : "—"}</strong> (${st.best ? M.fmt(st.best.v) : "—"})${trend}.`;
  const stats = `<div style="display:flex;gap:12px;flex-wrap:wrap">
      ${statTile(`Total · ${rangeLabel()}`, M.fmt(st.total), `${slice.length} months`)}
      ${statTile("Monthly average", M.fmt(st.avg), "full months only")}
      ${statTile("Best month", st.best ? monYear(st.best.m) : "—", st.best ? M.fmt(st.best.v) : "")}
      ${statTile("Latest full month", st.last ? monYear(st.last.m) : "—", st.last ? `${M.fmt(st.last.v)} · ${deltaChip(st.lastChg, " vs prior")}` : "")}</div>`;
  const segs = jars ? PRODUCTS().map(p => ({ get: p.get, color: p.color })) : [{ get: M.get, color: SER_MAIN }];
  const tip = i => monthTip(slice, st.vals, i, v => M.fmt(v) + (jars ? " jars" : ""), jars
      ? PRODUCTS().map(p => `<div><span style="color:${p.color};filter:brightness(1.7)">■</span> ${esc(p.name)} ${p.get(slice[i]).toLocaleString("en-US")}</div>`).join("")
      : `<div style="opacity:.85">Margin ${slice[i].revenue ? Math.round(slice[i].gross_profit / slice[i].revenue * 100) : 0}% · ${slice[i].jars.toLocaleString("en-US")} jars</div>`);
  const plot = barPlot({ id: "m", slice, st, top: niceMax(Math.max(...st.vals) * 1.05), height: Math.round(clampN(trendWidth() * 0.26, 190, 300)) + fitExtra(), segs, tip });
  const items = jars ? PRODUCTS().map(p => swatch(p.color, esc(p.name))).join("") : swatch(SER_MAIN, M.label);
  return `<div style="font-size:14px;color:#3d3731;line-height:1.5">${headline}</div>${stats}${plot}${legendRow(items, slice.some(isPartial))}`;
}

// ---- Monthly: jars, one chart per product (same scale) -----------------------
function monthlyByProduct(slice){
  if (!slice.length) return `<p style="color:#8f867c">No sales yet.</p>`;
  const PR = PRODUCTS(), sts = PR.map(p => seriesStats(slice, p.get));
  const top = niceMax(Math.max(...sts.flatMap(s => s.vals)) * 1.05);
  const fmt = n => Math.round(n).toLocaleString("en-US");
  // comparative headline: each product's share, and which one sold most in the most months
  const grand = sts.reduce((a, st) => a + st.total, 0) || 1, full = slice.map((m,i) => i).filter(i => !isPartial(slice[i]));
  const shares = PR.map((p, k) => Math.round(sts[k].total / grand * 100));
  const wins = PR.map((p, k) => full.filter(i => sts.every((o, j) => j === k || sts[k].vals[i] > o.vals[i])).length);
  const lk = shares.indexOf(Math.max(...shares)), wk = wins.indexOf(Math.max(...wins));
  const even = Math.max(...shares) - Math.min(...shares) <= 2;
  const lead = even
    ? `The ${PR.length} products sell <strong>almost evenly</strong> (${shares.map(x => x + "%").join(" / ")}, ${rangeLabel()})`
    : `<strong>${esc(PR[lk].name)}</strong> leads with <strong>${shares[lk]}%</strong> of jars (${rangeLabel()})`;
  const headline = `${lead}; <strong>${esc(PR[wk].name)}</strong> sold the most in <strong>${wins[wk]} of ${full.length}</strong> full months.`;
  const panels = PR.map((p, k) => {
    const st = sts[k];
    const tip = i => monthTip(slice, st.vals, i, v => fmt(v) + " jars",
      `<div style="opacity:.85">${Math.round(st.vals[i] / (slice[i].jars || 1) * 100)}% of all jars that month</div>`);
    return `<div style="flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:10px;border:1px solid #f0ebe4;border-radius:10px;padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px"><span style="width:12px;height:12px;border-radius:3px;background:${p.color}"></span>${esc(p.name)}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${statTile("Total", fmt(st.total), rangeLabel(), 70)}
          ${statTile("Avg / month", fmt(st.avg), st.best ? `best ${MON[mKey(st.best.m).mm-1]} '${String(mKey(st.best.m).yy).slice(2)}` : "", 70)}
          ${statTile("Latest month", st.last ? fmt(st.last.v) : "—", st.last ? `${MON[mKey(st.last.m).mm-1]} · ${deltaChip(st.lastChg)}` : "", 70)}</div>
        ${barPlot({ id: "p" + p.code, slice, st, top, height: Math.round(clampN(trendWidth() * 0.17, 150, 230)) + fitExtra(trendWidth() >= 620 ? 1 : 0.5), segs: [{ get: p.get, color: p.color }], tip })}
      </div>`;
  }).join("");
  return `<div style="font-size:14px;color:#3d3731;line-height:1.5">${headline}</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">${panels}</div>
    ${legendRow(`<span style="color:#8f867c">All charts use the same scale, so bar heights compare directly.</span>`, slice.some(isPartial))}`;
}

// ---- Year over year ----------------------------------------------------------
function yearData(get){
  const byYear = {};
  (D.monthly || []).forEach(m => { const k = mKey(m); (byYear[k.yy] = byYear[k.yy] || {})[k.mm] = { v: get(m), part: isPartial(m) }; });
  const years = Object.keys(byYear).map(Number).sort((a,b) => a - b);
  const color = y => { const r = years.length - 1 - years.indexOf(y); return r < SERIES.length ? SERIES[r] : OLDER; };   // newest = maroon
  const sameMonths = (y, py) => Object.keys(byYear[y] || {}).map(Number)
    .filter(mo => !byYear[y][mo].part && byYear[py] && byYear[py][mo] && !byYear[py][mo].part);
  const sum = (y, mos) => mos.reduce((a,mo) => a + byYear[y][mo].v, 0);
  return { byYear, years, color, sameMonths, sum };
}
const spanOf = mos => mos.length ? (mos.length === 12 ? "Jan–Dec" : `${MON[Math.min(...mos)-1]}–${MON[Math.max(...mos)-1]}`) : "—";
function yoyHeadline(Y, noun, fmt, who = ""){
  const ny = Y.years[Y.years.length-1], pc = Y.sameMonths(ny, ny - 1);
  if (!pc.length) return `Every year in the data, month by month, so seasons line up.`;
  const a = Y.sum(ny, pc), b = Y.sum(ny - 1, pc), c = pctChange(a, b);
  const verdict = Math.abs(c) < 1 ? `is running <strong>level with</strong> ${ny-1}`
    : `is running <strong style="color:${c >= 0 ? "#1d6b35" : "#b42318"}">${c >= 0 ? "▲" : "▼"} ${pctAbs(c)}% ${c >= 0 ? "ahead of" : "behind"}</strong> ${ny-1}`;
  return `${who}<strong>${ny}</strong> ${verdict} on ${noun} for the same full months (${spanOf(pc)}): ${fmt(a)} vs ${fmt(b)}.`;
}
function linePlot({ id, Y, top, fmt, W = 520, H = 210, label }){     // W ≈ rendered width, so text stays ~11px
  const L = 44, R = 44, T = 14, B = 26;
  const X = mo => L + (mo - 1) * (W - L - R) / 11, Yp = v => T + (1 - v / top) * (H - T - B);
  const ny = Y.years[Y.years.length-1];
  const grid = [0, 0.5, 1].map(f => `<line x1="${L}" x2="${W-R}" y1="${Yp(top*f)}" y2="${Yp(top*f)}" stroke="${f ? "#ebe5dd" : "#d9d2c9"}" stroke-dasharray="${f ? "3 3" : ""}"/>
      <text x="${L-6}" y="${Yp(top*f)+4}" text-anchor="end" font-size="11" fill="#8f867c">${dollar()}${compact(top*f)}</text>`).join("");
  const xl = MON.map((n,i) => `<text x="${X(i+1)}" y="${H-8}" text-anchor="middle" font-size="11" fill="#8f867c">${n}</text>`).join("");
  const lines = Y.years.map(y => {
    const pts = Object.keys(Y.byYear[y]).map(Number).sort((a,b) => a - b).map(mo => ({ mo, ...Y.byYear[y][mo] }));
    const solid = pts.filter(p => !p.part), c = Y.color(y), newest = y === ny;
    const partSeg = pts.filter(p => p.part).map(p => {
      const nb = solid.filter(s => s.mo < p.mo).pop() || solid.find(s => s.mo > p.mo);
      return nb ? `<line x1="${X(nb.mo)}" y1="${Yp(nb.v)}" x2="${X(p.mo)}" y2="${Yp(p.v)}" stroke="${c}" stroke-width="2" stroke-dasharray="4 3"/>` : ""; }).join("");
    const dots = pts.map(p => `<circle cx="${X(p.mo)}" cy="${Yp(p.v)}" r="4" fill="${p.part ? "#fff" : c}" stroke="${p.part ? c : "#fff"}" stroke-width="2"/>`).join("");
    const end = solid[solid.length-1] || pts[pts.length-1];
    const lab = end ? `<text x="${X(end.mo) + 8}" y="${Yp(end.v) + 4}" font-size="12" font-weight="700" fill="#221e1b">${y}</text>` : "";
    return `<g><polyline points="${solid.map(p => `${X(p.mo)},${Yp(p.v)}`).join(" ")}" fill="none" stroke="${c}" stroke-width="${newest ? 3 : 2}" stroke-linejoin="round" stroke-linecap="round"/>${partSeg}${dots}${lab}</g>`;
  }).join("");
  const hits = MON.map((n,i) => `<rect data-yi="${i+1}" x="${X(i+1) - (W-L-R)/22}" y="${T}" width="${(W-L-R)/11}" height="${H-T-B}" fill="transparent" style="cursor:pointer"/>`).join("");
  TRENDS.push({ id, kind: "lines", Y, fmt, X, W });
  return `<div id="tp-${id}" style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)} by month, one line per year" style="display:block;overflow:visible">
        ${grid}${xl}<line id="tc-${id}" x1="0" x2="0" y1="${T}" y2="${H-B}" stroke="#221e1b" stroke-opacity=".25" stroke-width="1" style="display:none"/>${lines}${hits}</svg>
      ${tipBox(id)}</div>`;
}
const yearLegend = Y => `<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#5b534b;align-items:center">
    ${Y.years.map(y => `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:16px;height:3px;border-radius:2px;background:${Y.color(y)}"></span>${y}</span>`).join("")}
    <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:9px;height:9px;border-radius:50%;border:2px solid #9a928a;background:#fff"></span>Partial month</span>
    <span style="color:#8f867c">· Comparisons use full months only</span></div>`;

function yearlyView(M){
  const Y = yearData(M.get);
  if (!Y.years.length) return `<p style="color:#8f867c">No sales yet.</p>`;
  const tiles = Y.years.map(y => {
    const mos = Object.keys(Y.byYear[y]).map(Number), part = mos.filter(mo => Y.byYear[y][mo].part);
    const cmp = Y.sameMonths(y, y - 1), chg = cmp.length ? pctChange(Y.sum(y, cmp), Y.sum(y - 1, cmp)) : null;
    return `<div style="flex:1 1 150px;min-width:0;border:1px solid #ece6dd;border-radius:10px;padding:12px 14px;border-top:4px solid ${Y.color(y)}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><span style="font-weight:700">${y}</span>
          <span style="font-size:11px;color:#8f867c">${spanOf(mos)}${part.length ? ` · ${part.map(mo => MON[mo-1]).join(", ")} partial` : ""}</span></div>
        <div style="font-size:20px;font-weight:600;font-variant-numeric:tabular-nums">${M.fmt(Y.sum(y, mos))}</div>
        <div style="font-size:12px;color:#5b534b">${chg == null ? "First year of data" : `${deltaChip(chg)} vs same ${cmp.length} months of ${y-1}`}</div></div>`;
  }).join("");
  const top = niceMax(Math.max(...Y.years.flatMap(y => Object.values(Y.byYear[y]).map(p => p.v))) * 1.05);
  return `<div style="font-size:14px;color:#3d3731;line-height:1.5">${yoyHeadline(Y, M.noun, M.fmt)}</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">${tiles}</div>
    ${linePlot({ id: "y", Y, top, fmt: M.fmt, label: M.label, W: Math.round(trendWidth()), H: Math.round(clampN(trendWidth() * 0.3, 210, 300)) + fitExtra() })}
    ${yearLegend(Y)}`;
}

function yearlyByProduct(){
  const fmt = n => Math.round(n).toLocaleString("en-US");
  const PR = PRODUCTS(), Ys = PR.map(p => yearData(p.get));
  if (!Ys[0].years.length) return `<p style="color:#8f867c">No sales yet.</p>`;
  const top = niceMax(Math.max(...Ys.flatMap(Y => Y.years.flatMap(y => Object.values(Y.byYear[y]).map(p => p.v)))) * 1.05);
  const wide = trendWidth() >= 860, panelW = Math.round((wide ? (trendWidth() - 12) / 2 : trendWidth()) - 30);
  const panels = PR.map((p, k) => { const Y = Ys[k];
    const chips = Y.years.map(y => { const mos = Object.keys(Y.byYear[y]).map(Number);
      return `<span style="font-size:12px;color:#5b534b;white-space:nowrap"><span style="display:inline-block;width:10px;height:3px;border-radius:2px;background:${Y.color(y)};vertical-align:middle;margin-right:4px"></span>${y}: <strong>${fmt(Y.sum(y, mos))}</strong></span>`; }).join("");
    return `<div style="flex:1 1 ${wide ? 0 : 100}%;min-width:0;display:flex;flex-direction:column;gap:8px;border:1px solid #f0ebe4;border-radius:10px;padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px"><span style="width:12px;height:12px;border-radius:3px;background:${p.color}"></span>${esc(p.name)}</div>
        <div style="font-size:13px;color:#3d3731;line-height:1.45">${yoyHeadline(Y, "jars", fmt)}</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">${chips}</div>
        ${linePlot({ id: "y" + p.code, Y, top, fmt, W: panelW, H: Math.round(clampN(panelW * 0.42, 180, 240)) + fitExtra(wide ? 1 : 0.5), label: p.name + " jars" })}
      </div>`; }).join("");
  return `<div style="font-size:14px;color:#3d3731;line-height:1.5">Each product on its own, year against year — all charts use the same scale.</div>
    <div style="display:flex;flex-direction:${wide ? "row" : "column"};gap:12px">${panels}</div>
    ${yearLegend(Ys[0])}`;
}

// ---- hover: update each plot's tooltip in place (no re-render, no flicker) ---
function bindTrend(){
  // charts are drawn at the card's REAL width: if the estimate was off, redraw once at the measured size
  const card = root.querySelector("[data-trendcard]");
  if (card) { const w = card.clientWidth - 44;
    if (w > 200 && (!TREND_W || Math.abs(w - TREND_W) > 6)) { TREND_W = w; render(); return; }
    // fill the row: if the neighbouring card is taller, grow the plots into the blank space (once per layout)
    const key = fitKey();
    if (!(key in TREND_FIT) && card.parentElement && getComputedStyle(card.parentElement).flexDirection === "row") {
      const last = Math.max(...[...card.children].map(k => k.getBoundingClientRect().bottom));
      const free = Math.round(card.getBoundingClientRect().bottom - last - 20);
      TREND_FIT[key] = free > 12 && card.offsetTop === (card.nextElementSibling || card).offsetTop ? Math.min(free, 260) : 0;
      if (TREND_FIT[key]) { render(); return; }
    } }
  root.querySelectorAll("[data-trendview]").forEach(b => b.onclick = () => { S.trendView = b.dataset.trendview; render(); });
  root.querySelectorAll("[data-jarsview]").forEach(b => b.onclick = () => { S.jarsView = b.dataset.jarsview; render(); });
  TRENDS.forEach(T => {
    const plot = root.querySelector("#tp-" + T.id), tip = root.querySelector("#tt-" + T.id);
    if (!plot || !tip) return;
    const hide = () => { tip.style.display = "none";
      plot.querySelectorAll(".tbar").forEach(b => b.style.opacity = 1);
      const cr = plot.querySelector("#tc-" + T.id); if (cr) cr.style.display = "none"; };
    if (T.kind === "bars") {
      plot.querySelectorAll("[data-ti]").forEach(el => {
        el.onmouseenter = () => {
          plot.querySelectorAll(".tbar").forEach(b => b.style.opacity = b === el ? 1 : 0.4);
          tip.innerHTML = T.tip(+el.dataset.ti); tip.style.display = "block";
          const r = el.getBoundingClientRect(), p = plot.getBoundingClientRect(), bar = el.lastElementChild.getBoundingClientRect();
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          if (bar.top - p.top - th - 10 >= 0) {                     // room above the bar
            tip.style.left = Math.max(0, Math.min(plot.clientWidth - tw, r.left - p.left + r.width / 2 - tw / 2)) + "px";
            tip.style.top = (bar.top - p.top - th - 10) + "px";
          } else {                                                  // tall bar: beside it, inside the plot
            const right = r.right - p.left + 6, left = r.left - p.left - tw - 6;
            tip.style.left = (right + tw <= plot.clientWidth ? right : Math.max(0, left)) + "px";
            tip.style.top = "0px";
          }
        };
        el.onmouseleave = hide;
      });
    } else {
      const svg = plot.querySelector("svg"), cr = plot.querySelector("#tc-" + T.id), { Y, fmt, X, W } = T;
      plot.querySelectorAll("[data-yi]").forEach(el => {
        el.onmouseenter = () => {
          const mo = +el.dataset.yi;
          const rows = Y.years.slice().reverse().filter(y => Y.byYear[y][mo]).map(y => {
            const cur = Y.byYear[y][mo], prev = Y.byYear[y-1] && Y.byYear[y-1][mo];
            const chg = prev && !cur.part && !prev.part ? pctChange(cur.v, prev.v) : null;
            return `<div><span style="color:${Y.color(y)};filter:brightness(1.6)">●</span> ${y}: <strong>${fmt(cur.v)}</strong>${cur.part ? " (partial)" : ""}${chg == null ? "" : ` <span style="opacity:.8">${chg >= 0 ? "▲" : "▼"}${pctAbs(chg)}%</span>`}</div>`;
          }).join("");
          if (!rows) return hide();
          tip.innerHTML = `<div style="font-weight:700">${MON[mo-1]}</div>${rows}`; tip.style.display = "block";
          const cx = X(mo) * svg.getBoundingClientRect().width / W, tw = tip.offsetWidth;
          cr.setAttribute("x1", X(mo)); cr.setAttribute("x2", X(mo)); cr.style.display = "";
          tip.style.left = (cx + 12 + tw <= plot.clientWidth ? cx + 12 : Math.max(0, cx - tw - 12)) + "px";
          tip.style.top = "4px";
        };
        el.onmouseleave = hide;
      });
    }
  });
}

function pageOverview(){
  const slice = monthlySlice();
  const lowList = D.inventory.filter(p => /LOW/.test(p.status));
  const totalJars = D.inventory.reduce((a,p) => a + p.on_hand, 0);

  const totRev  = slice.reduce((a,m) => a + m.revenue, 0);
  const totProf = slice.reduce((a,m) => a + m.gross_profit, 0);
  const totSch  = slice.reduce((a,m) => a + m.scholarship, 0);
  const margin  = totRev ? Math.round(totProf/totRev*100) : 0;

  const alert = lowList.length ? `<div style="display:flex;align-items:center;gap:14px;background:#fbeeee;border:1px solid #efc9c9;border-radius:10px;padding:14px 18px;flex-wrap:wrap">
      <div style="width:8px;height:8px;border-radius:50%;background:#b42318;flex:none"></div>
      <div style="flex:1;min-width:240px;font-size:14px;color:#7a1a12"><strong>${lowList.map(s=>s.name).join(" & ")} ${lowList.length>1?"are":"is"} below reorder level.</strong>
        ${lowList.map(s=>`${s.on_hand.toLocaleString("en-US")} jars on hand`).join(", ")} vs. ${prod(lowList[0].code).reorder.toLocaleString("en-US")} target — plan a production batch.</div>
      <button data-nav="inventory" style="background:#fff;color:#7a1a12;border:1px solid #e3b4b4;border-radius:7px;padding:8px 14px;white-space:nowrap;font:600 13px 'IBM Plex Sans',sans-serif;cursor:pointer">Add batch</button>
    </div>` : "";

  const kpis = [
    ["Revenue", money(totRev), S.range==="all"?"all time":S.range==="6m"?"last 6 months":"last 12 months"],
    ["Gross profit", money(totProf), margin + "% margin"],
    ["Scholarship owed", money(totSch), `${schPct()} of ${esc(cobrandName())} sales`],
    ["Jars in stock", totalJars.toLocaleString("en-US"), lowList.length?`${lowList.length} product below reorder level`:"All products above reorder level"],
  ].map(([l,v,note]) => `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:8px">
      <div style="font-size:13px;color:#7d746b;font-weight:500">${l}</div>
      <div style="font-size:30px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${v}</div>
      <div style="font-size:12px;color:#8f867c">${note}</div></div>`).join("");

  const chart = trendCard(slice);

  const stockMini = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:18px;flex:1 1 300px;min-width:0">
      <div><h2 style="margin:0;font-size:16px;font-weight:600">Stock on hand</h2>
        <p style="margin:3px 0 0;font-size:13px;color:#7d746b">Produced + adjustments − sold</p></div>
      ${D.inventory.map(stockRow).join("")}
      <div style="margin-top:auto;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:#7d746b;line-height:1.5">Days left and dates come from the last ${(D.reorder[0] || {}).window || ""} days of sales. Suggested reorder point: ${D.reorder.map(r => `${esc(r.code)} ${r.suggested.toLocaleString("en-US")}`).join(" · ")} jars.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button data-nav="inventory" style="flex:1;background:#7a1f1f;color:#fff;border:0;border-radius:8px;padding:10px 12px;font:600 13px 'IBM Plex Sans',sans-serif;cursor:pointer">+ Add batch</button>
          <button data-nav="count" style="flex:1;background:#fff;color:#5b534b;border:1px solid #d9d2c9;border-radius:8px;padding:10px 12px;font:500 13px 'IBM Plex Sans',sans-serif;cursor:pointer">Count stock</button></div></div>
    </div>`;

  // channels + activity
  const chMax = Math.max(1, ...D.channels_sales.map(c => c.units));
  const channels = D.channels_sales.map(c => `<div style="display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;font-size:13px;gap:8px">
        <span style="font-weight:500">${esc(c.name)}</span>
        <span style="color:#7d746b;font-variant-numeric:tabular-nums">${c.units.toLocaleString("en-US")} jars · ${c.revenue?money(c.revenue):"—"}</span></div>
      <div style="height:6px;background:#f0ebe4;border-radius:3px"><div style="height:100%;width:${c.units/chMax*100}%;background:${c.revenue?ACCENT:"#b9b0a6"};border-radius:3px"></div></div>
    </div>`).join("");
  const channelsCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px;flex:1 1 340px;min-width:0">
      <div><h2 style="margin:0;font-size:16px;font-weight:600">Sales by channel</h2>
        <p style="margin:3px 0 0;font-size:13px;color:#7d746b">Jars sold · revenue</p></div>
      <div style="display:flex;flex-direction:column;gap:14px">${channels}</div></div>`;

  const activity = D.ledger.slice(0,7).map(activityRow).join("");
  const activityCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:12px;flex:1 1 340px;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <h2 style="margin:0;font-size:16px;font-weight:600">Recent activity</h2>
        <button data-nav="inventory" style="background:transparent;border:0;padding:0;font:500 13px 'IBM Plex Sans',sans-serif;color:#7a1f1f;cursor:pointer">Full ledger →</button></div>
      <div style="display:flex;flex-direction:column">${activity}</div></div>`;

  return `<div style="display:flex;flex-direction:column;gap:20px">
    ${alert}
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:16px">${kpis}</section>
    <section style="display:flex;flex-wrap:wrap;gap:16px">${chart}${stockMini}</section>
    <section style="display:flex;flex-wrap:wrap;gap:16px">${channelsCard}${activityCard}</section>
  </div>`;
}

// stock outlook from the last 90 days of sales (v_reorder_suggestion): 14-day lead + 7 safety days
function stockOutlook(p){
  const r = (D.reorder || []).find(x => x.code === p.code), daily = r && r.avg_daily > 0 ? r.avg_daily : 0;
  if (!daily) return null;
  const plan = r.lead + r.safety, days = Math.floor(p.on_hand / daily), startIn = days - plan;
  const at = n => new Date(Date.now() + n * 864e5).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { daily, days, runOut: at(days), startIn, startBy: at(Math.max(0, startIn)), suggested: r.suggested,
           lead: r.lead, safety: r.safety, plan, window: r.window };
}
function stockRow(p){
  const low = /LOW/.test(p.status), oh = p.on_hand, o = stockOutlook(p);
  return `<div style="display:flex;flex-direction:column;gap:10px;padding-bottom:16px;border-bottom:1px solid #f0ebe4">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="font-weight:600;font-size:14px">${esc(p.name)}</span>
        <span style="${badge(low?"#fbeeee":"#e9f4ec", low?"#b42318":"#1d6b35")}">${low?"Reorder":"In stock"}</span></div>
      <div style="display:flex;align-items:baseline;gap:6px">
        <span style="font-size:28px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${oh.toLocaleString("en-US")}</span>
        <span style="font-size:13px;color:#8f867c">jars</span></div>
      <div style="position:relative;height:8px;background:#f0ebe4;border-radius:4px">
        <div style="position:absolute;left:0;top:0;bottom:0;width:${Math.min(100,oh/stockScale()*100)}%;background:${low?"#b42318":"#2f7d4a"};border-radius:4px"></div>
        <div style="position:absolute;top:-3px;bottom:-3px;left:${p.reorder/stockScale()*100}%;width:2px;background:#221e1b"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#8f867c">
        <span>Reorder at ${p.reorder.toLocaleString("en-US")}</span>
        <span>Sold ${short(p.sold)} · Adj. ${sgn(p.adjusted)}</span></div>
      ${o ? `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;background:#f7f4f0;border-radius:8px;padding:10px 12px">
          <div><div style="font-size:11px;color:#8f867c">Sells / day</div><div style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">${o.daily.toFixed(1)}</div></div>
          <div><div style="font-size:11px;color:#8f867c">Days left</div><div style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:${o.days <= o.plan ? "#b42318" : o.days <= o.plan * 2 ? "#8a5a00" : "#221e1b"}">${o.days}</div></div>
          <div><div style="font-size:11px;color:#8f867c">Runs out</div><div style="font-size:15px;font-weight:600">~${o.runOut}</div></div></div>
        <div style="font-size:12px;color:${o.startIn <= 0 ? "#b42318" : "#5b534b"}">${o.startIn <= 0
          ? `<strong>Start a batch now</strong> — production takes about ${o.lead} days.`
          : `Start the next batch by <strong>${o.startBy}</strong> (in ${o.startIn} days) to stay ahead of the ${o.lead}-day lead time + ${o.safety} safety days.`}</div>` : ""}
    </div>`;
}

function activityRow(a){
  const [bg,fg] = TYPE_COLOR[a.type] || ["#eee","#555"];
  return `<div style="display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid #f0ebe4;${a.today?"background:#fbf8f3":""}">
      <span style="display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:5px;width:58px;text-align:center;background:${bg};color:${fg}">${TYPE_LABEL[a.type]||a.type}</span>
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(productName(a.code))} · ${esc(a.ref)}</div>
        <div style="font-size:12px;color:#8f867c">${esc(a.date)}${a.today?' · <span style="color:#1d6b35;font-weight:600">NEW</span>':""}</div></div>
      <span class="mono" style="font-size:13px;font-weight:500;color:${a.qty>0?"#1d6b35":"#b42318"}">${sgn(a.qty)}</span>
    </div>`;
}

// =============================================================================
//  SALES
// =============================================================================
// PREVIEW ONLY — mirrors fn_finalize_sale so the owner sees the result before
// saving. The database recomputes everything when the sale is recorded. Every
// price, cost, rate and fee below comes from the product / channel / county data.
function splitByShare(total, counts){            // same rule as app.py split_by_share
  const n = counts.reduce((a, b) => a + b, 0), parts = counts.map(c => n ? r2(total * c / n) : 0);
  if (parts.length) parts[0] = r2(total - parts.slice(1).reduce((a, b) => a + b, 0));
  return parts;
}
// lines = [{code, qty, rev}]
function calcPart({channelName, countyCode, lines, shipRev = 0, shipExp = 0, fee = 0}){
  const ch = channelByName(channelName) || {taxable:false, fee_pct:0, fee_fixed:0};
  const c = countyByCode(countyCode);
  const jars = lines.reduce((a, l) => a + l.qty, 0), rev = lines.reduce((a, l) => a + l.rev, 0);
  const food = lines.length > 0 && lines.every(l => productByCode(l.code).is_qualifying_food);
  // tax on items + shipping: the county's food rate for qualifying food, otherwise its general
  // rate; a county with no food rate is in a state where the business doesn't collect
  const collected = !!(ch.taxable && c && c.food_rate != null);
  const rate = collected ? (food ? c.food_rate : (c.rate || 0)) : 0;
  const tax = r2((rev + shipRev) * rate);
  const autoFee = (ch.fee_pct > 0 || ch.fee_fixed > 0) && jars > 0;
  const fees = autoFee ? r2(ch.fee_pct * (rev + shipRev + tax) + ch.fee_fixed) : fee;
  const sch = r2(lines.reduce((a, l) => a + l.rev * schRate(l.code), 0));          // each product's licence rate
  const cost = r2(lines.reduce((a, l) => a + l.qty * (productByCode(l.code).unit_cost || 0), 0));
  return { channel: channelName, county: c, jars, byCode: Object.fromEntries(lines.map(l => [l.code, l.qty])),
           codes: lines.map(l => l.code), rev, shipRev, shipExp, tax, fees, autoFee, sch, cost, rate, food,
           taxable: !!ch.taxable, collected, profit: rev + shipRev - fees - shipExp - cost - sch };
}
const productCodes = () => (D.products || []).map(p => p.code);
function marketParts(){
  const f = S.sale, codes = productCodes(), mkt = CFG("market_channel");
  return ["cash", "card"].map(kind => {
    const part = f[kind], counts = codes.map(c => num(part.jars[c]));
    if (!counts.some(Boolean)) return null;
    const revs = splitByShare(num(part.total), counts);
    return calcPart({ channelName: mkt, countyCode: f.county, fee: kind === "card" ? num(part.fee) : 0,
                      lines: codes.map((c, i) => ({ code: c, qty: counts[i], rev: revs[i] })).filter(l => l.qty) });
  }).filter(Boolean);
}
function salePreviewData(){
  const f = S.sale;
  if (f.mode === "market") {
    const parts = marketParts();
    if (!parts.length) return calcPart({ channelName: CFG("market_channel"), countyCode: f.county, lines: [] });
    return parts.reduce((a, p) => ({ ...a,
      ...Object.fromEntries(["jars","rev","shipRev","shipExp","tax","fees","sch","cost","profit"].map(k => [k, a[k] + p[k]])),
      byCode: Object.fromEntries(productCodes().map(c => [c, (a.byCode[c] || 0) + (p.byCode[c] || 0)])),
      codes: [...new Set([...a.codes, ...p.codes])] }));
  }
  const ships = SHIPS(f.channel);
  const lines = productCodes().map(c => ({ code: c, qty: num(f.qty[c]), rev: r2(num(f.qty[c]) * num(f.price[c])) })).filter(l => l.qty);
  return calcPart({ channelName: f.channel, countyCode: f.county, lines,
                    shipRev: ships ? num(f.shipRev) : 0, shipExp: ships ? num(f.shipExp) : 0 });
}

function pageSales(){
  const isMarket = S.sale.mode === "market", mkt = CFG("market_channel"), home = HOME();
  const modes = [["single","Single sale"],["market", `${esc(mkt)} day`]].map(([k,l]) =>
    `<button data-salemode="${k}" style="${pill(S.sale.mode===k)}">${l}</button>`).join("");

  const channelChips = D.channels.map(c =>
    `<button data-channel="${esc(c.name)}" style="${opt(S.sale.channel===c.name)}">${esc(c.name)}</button>`).join("");
  // channel hint built from the channel's own settings
  const ch = channelByName(S.sale.channel) || {};
  const food = homeFoodRate();
  const channelHint = [
    ch.price_basis === "free" ? "No charge — stock still goes down." : `Default price: ${ch.price_basis === "wholesale" ? "wholesale" : "retail"} price of each product.`,
    ch.taxable ? `Taxed${food != null ? ` (qualifying food in ${home}: ${pctTxt(food)})` : ""}.` : "Not taxed.",
    feeText(ch) ? `Card fee ${feeText(ch)} is added automatically.` : "",
    ch.ships ? "Can be shipped." : "",
  ].filter(Boolean).join(" ");

  const sel = "width:100%;padding:10px 12px;border:1px solid #d9d2c9;border-radius:8px;font:400 15px 'IBM Plex Sans',sans-serif;background:#fff;color:#221e1b";
  const stateOpts = [...D.tax_states].sort((a,b) => (b===home)-(a===home) || a.localeCompare(b)).map(st =>
    `<option value="${esc(st)}" ${S.sale.state===st?"selected":""}>${esc(st)}${st===home && CFG("home_state_name") ? " — " + esc(CFG("home_state_name")) : ""}</option>`).join("");
  const countyOpts = countiesOf(S.sale.state).map(c =>
    `<option value="${esc(c.code)}" ${S.sale.county===c.code?"selected":""}>${esc(cty(c.county))}</option>`).join("");
  const outOfState = S.sale.state !== home;
  const location = (step, title) => `<div style="display:flex;flex-direction:column;gap:10px">
      <div style="font-size:13px;font-weight:600;color:#5b534b">${step} · ${title}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;max-width:560px">
        <select id="s-state" style="${sel}" aria-label="State">${stateOpts}</select>
        <select id="s-county" style="${sel}" aria-label="County">${countyOpts}</select></div>
      <div style="font-size:12px;color:${outOfState?"#8a5a00":"#8f867c"}">${outOfState
        ? `Outside ${esc(home)} — no ${esc(home)} sales tax is collected (the business is registered only in ${esc(home)}).`
        : `${esc(home)} taxes qualifying food at ${food != null ? pctTxt(food) : "its food rate"} in every county, including shipping charges.`}</div></div>`;

  const inputStyle = "width:100%;padding:10px 12px;border:1px solid #d9d2c9;border-radius:8px;font:400 15px 'IBM Plex Sans',sans-serif;background:#fff;color:#221e1b";
  const field = (attrs, label, val, step = "1") =>
    `<label class="fld">${label}<input ${attrs} type="number" min="0" step="${step}" value="${esc(val)}" style="${inputStyle}"></label>`;
  const grid = inner => `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px">${inner}</div>`;
  const stepTitle = t => `<div style="font-size:13px;font-weight:600;color:#5b534b">${t}</div>`;
  const ships = SHIPS(S.sale.channel);
  // one row per product in the database: jars + price per jar
  const productRows = D.products.map(p => grid(
      field(`data-q="${esc(p.code)}"`, `${esc(p.name)} (jars)`, S.sale.qty[p.code] ?? "0")
    + field(`data-p="${esc(p.code)}"`, `${esc(p.name)} — price per jar ($)`, S.sale.price[p.code] ?? "0", "0.01"))).join("");
  const marketRows = kind => grid(D.products.map(p =>
      field(`data-m="${kind}" data-code="${esc(p.code)}"`, `${esc(p.name)} (jars)`, S.sale[kind].jars[p.code] ?? "0")).join("")
    + field(`id="s-${kind}-total"`, kind === "cash" ? "Cash collected ($)" : "Card sales total ($)", S.sale[kind].total, "0.01")
    + (kind === "card" ? field(`id="s-card-fee"`, "Card fees ($)", S.sale.card.fee, "0.01") : ""));

  const singleInputs = `<div style="display:flex;flex-direction:column;gap:22px">
      <div style="display:flex;flex-direction:column;gap:10px">
        ${stepTitle("1 · Where was it sold?")}
        <div style="display:flex;flex-wrap:wrap;gap:8px">${channelChips}</div>
        <div style="font-size:12px;color:#8f867c">${esc(channelHint)}</div></div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${stepTitle("2 · What was sold?")}
        ${productRows}
        <div style="font-size:12px;color:#8f867c">Prices start at the channel's price for each product. Discount or bundle deal? Enter the price actually charged per jar.</div></div>
      ${location(3, "Where is the customer?")}
      ${ships ? `<div style="display:flex;flex-direction:column;gap:10px">
        ${stepTitle("4 · Shipping (leave 0 if picked up)")}
        ${grid(field(`id="s-shiprev"`,"Shipping the customer paid ($)",S.sale.shipRev,"0.01")
               + field(`id="s-shipexp"`,"Shipping you paid — label cost ($)",S.sale.shipExp,"0.01"))}
        <div style="font-size:12px;color:#8f867c">Both numbers are on the order. Shipping charged is taxed; the label cost comes off profit.</div></div>` : ""}
    </div>`;
  const marketInputs = `<div style="display:flex;flex-direction:column;gap:22px">
      <p style="margin:0;font-size:13px;color:#7d746b;line-height:1.5">No need to log each customer. Enter end-of-day totals — the money is split between the products by jar count, so a bundle deal is shared fairly and the scholarship is based on money actually received.</p>
      <div style="display:flex;flex-direction:column;gap:10px">${stepTitle("1 · Cash box")}${marketRows("cash")}</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${stepTitle("2 · Card reader (leave 0 if none)")}${marketRows("card")}
        <div style="font-size:12px;color:#8f867c">Card total and fees are on the card reader's payout report for the day.</div></div>
      ${location(3, "Where was the market?")}
    </div>`;

  const formCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:22px;flex:3 1 460px;min-width:0">
      ${isMarket ? marketInputs : singleInputs}</div>`;

  const previewCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:16px;flex:2 1 320px;min-width:0">
      <h2 style="margin:0;font-size:16px;font-weight:600">What this sale does</h2>
      <div id="salePreview">${salePreviewInner()}</div>
      <button id="recordSale" style="${btnPrimary}">${S.loading ? "Saving…" : isMarket ? "Record market day" : "Record sale"}</button>
    </div>`;

  const dash = v => v ? cents(v) : '<span style="color:#b9b0a6">—</span>';
  const jarsText = j => productCodes().filter(c => j[c]).map(c => `${j[c]} ${esc(c)}`).join(" · ") || "0";
  const rows = D.recent_sales.map(r => `<tr style="${r.date===D.today_date?"background:#fbf8f3":""}">
      <td style="white-space:nowrap">${esc(r.date)}</td>
      <td class="mono" style="font-size:12px;color:#7d746b;white-space:nowrap">${esc(r.ref)}</td>
      <td>${esc(r.channel)}</td>
      <td style="white-space:nowrap">${esc(cty(r.county))}${r.state && r.state!==home ? ` <span style="${badge("#fbf1e3","#8a5a00")}">${esc(r.state)}</span>` : ""}</td>
      <td class="num" style="white-space:nowrap">${jarsText(r.jars || {})}</td><td class="num">${cents(r.rev)}</td>
      <td class="num" style="color:#7d746b">${dash(r.ship)}</td>
      <td class="num" style="color:#7d746b">${cents(r.tax)}</td>
      <td class="num" style="color:#7d746b">${dash(r.fees)}</td>
      <td class="num" style="color:#7d746b">${dash(r.ship_exp)}</td>
      <td class="num" style="color:#7d746b">${cents(r.sch)}</td>
      <td class="num" style="font-weight:600">${cents(r.profit)}</td></tr>`).join("");
  const recent = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap"><div><h2 style="margin:0;font-size:16px;font-weight:600">Recent sales</h2>
        <p style="margin:3px 0 0;font-size:13px;color:#7d746b">Every column after Jars is filled in automatically — the same fields you used to type into the spreadsheet by hand.</p></div>${dlBtn("sales", "every sale (not just the 25 shown)", {}, "Download all sales")}</div>
      <div class="tw"><table style="min-width:1080px"><thead><tr>
        <th>Date</th><th>Ref</th><th>Channel</th><th>Customer location</th><th class="num">Jars</th><th class="num">Revenue</th>
        <th class="num">Shipping charged</th><th class="num">Sales tax</th><th class="num">Card fees</th><th class="num">Shipping paid</th>
        <th class="num">Scholarship</th><th class="num">Profit</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;

  return `<div style="display:flex;flex-direction:column;gap:20px">
    <div style="display:flex;background:#fff;border:1px solid #e6e0d8;border-radius:8px;padding:3px;gap:2px;align-self:flex-start">${modes}</div>
    <section style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">${formCard}${previewCard}</section>
    ${recent}</div>`;
}

// the card fee with its working shown, e.g.
//   2.9% × $26.52 + $0.30 = $1.07
//   $26.52 = items $18.00 + shipping $8.00 + sales tax $0.52
function feeWorking(ch, pv){
  const base = r2(pv.rev + pv.shipRev + pv.tax);
  const parts = [`items ${cents(pv.rev)}`, pv.shipRev ? `shipping ${cents(pv.shipRev)}` : null, pv.tax ? `sales tax ${cents(pv.tax)}` : null].filter(Boolean);
  return `${pctTxt(ch.fee_pct)} × ${cents(base)}${ch.fee_fixed ? ` + ${cents(ch.fee_fixed)}` : ""} = ${cents(pv.fees)}`
    + (parts.length > 1 ? `\n${cents(base)} = ${parts.join(" + ")}` : "");
}
function salePreviewInner(){
  const pv = salePreviewData(), home = HOME();
  const c = countyByCode(S.sale.county);
  const where = c ? `${cty(c.county)}, ${c.state}` : "—";
  const taxSub = !pv.taxable ? `${pv.channel} is not taxed`
    : !pv.collected ? `Outside ${home} (${c ? c.state : "—"}) — no ${home} tax collected`
    : `${pctTxt(pv.rate)} ${pv.food ? `${home} qualifying-food rate` : "general rate"} on items${pv.shipRev ? " + shipping" : ""} · ${where}`;
  const costs = [...new Set(pv.codes.map(code => productByCode(code).unit_cost))];
  const ch = channelByName(pv.channel);
  const rows = [
    ["Revenue", `${pv.jars} jars`, cents(pv.rev)],
    pv.shipRev ? ["Shipping charged", "paid by the customer", "+" + cents(pv.shipRev)] : null,
    ["Product cost", costs.length === 1 ? `$${Number(costs[0]).toFixed(2)} per jar` : "each product's unit cost", "−" + cents(pv.cost)],
    ["Scholarship", `${schPct()} of ${cobrandName()} revenue`, "−" + cents(pv.sch)],
    pv.fees ? [S.sale.mode === "market" ? "Card fees" : `${pv.channel} fee`,
               pv.autoFee ? feeWorking(ch, pv) : "from the card-reader payout", "−" + cents(pv.fees), pv.autoFee] : null,
    pv.shipExp ? ["Shipping paid", "label cost", "−" + cents(pv.shipExp)] : null,
  ].filter(Boolean);
  const auto = `<span style="${badge("#e9f4ec","#1d6b35")};margin-left:6px;font-size:10px;vertical-align:1px">CALCULATED AUTOMATICALLY</span>`;
  const lines = rows.map(([l,sub,v,isAuto]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #f0ebe4;font-size:14px">
      <span style="color:#5b534b">${esc(l)}${isAuto ? auto : ""}<span style="display:block;font-size:12px;color:#8f867c;line-height:1.5">${esc(sub).replace(/\n/g, "<br>")}</span></span>
      <span style="font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap">${v}</span></div>`).join("");
  const taxBox = `<div style="display:flex;justify-content:space-between;gap:12px;background:#eef2fb;color:#2a4f9a;border-radius:8px;padding:10px 12px;font-size:13px;margin-top:12px">
      <span><strong>Sales tax collected:</strong> ${esc(taxSub)}<span style="display:block;font-size:12px;opacity:.85">Held for ${esc(CFG("tax_authority") || "the tax authority")} — not part of profit.</span></span>
      <span style="font-variant-numeric:tabular-nums;font-weight:600">${cents(pv.tax)}</span></div>`;

  const stock = productCodes().map(code => {
    const oh = onHand(code), qty = pv.byCode[code] || 0, to = oh - qty;
    const col = to<0 ? "#b42318" : to<prod(code).reorder ? "#8a5a00" : "#221e1b";
    return `<div style="display:flex;justify-content:space-between;font-size:13px;gap:8px">
        <span>${esc(productName(code))}</span>
        <span style="font-variant-numeric:tabular-nums;font-weight:500;color:${col}">${oh.toLocaleString("en-US")} → ${to<0?"Not enough stock":to.toLocaleString("en-US")}</span></div>`;
  }).join("");

  return `${lines}
    <div style="display:flex;justify-content:space-between;gap:12px;padding:12px 0 4px;font-size:16px;font-weight:600">
      <span>Gross profit</span><span style="font-variant-numeric:tabular-nums">${cents(pv.profit)}</span></div>
    ${taxBox}
    <div style="background:#f7f4f0;border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;margin-top:12px">
      <div style="font-size:12px;font-weight:600;color:#5b534b">Stock after this sale</div>${stock}</div>`;
}

function bindSales(){
  root.querySelectorAll("[data-salemode]").forEach(b => b.onclick = () => { S.sale.mode = b.dataset.salemode; render(); });
  root.querySelectorAll("[data-channel]").forEach(b => b.onclick = () => {
    S.sale.channel = b.dataset.channel; setChannelPrices();          // prices follow the channel's price basis
    render();
  });
  const refreshPrev = () => { const el = root.querySelector("#salePreview"); if (el) el.innerHTML = salePreviewInner(); };
  root.querySelectorAll("[data-q]").forEach(el => el.oninput = () => { S.sale.qty[el.dataset.q] = el.value; refreshPrev(); });
  root.querySelectorAll("[data-p]").forEach(el => el.oninput = () => { S.sale.price[el.dataset.p] = el.value; refreshPrev(); });
  root.querySelectorAll("[data-m]").forEach(el => el.oninput = () => { S.sale[el.dataset.m].jars[el.dataset.code] = el.value; refreshPrev(); });
  const bindVal = (id, set) => { const el = root.querySelector("#" + id); if (el) el.oninput = () => { set(el.value); refreshPrev(); }; };
  bindVal("s-shiprev", v => S.sale.shipRev = v);  bindVal("s-shipexp", v => S.sale.shipExp = v);
  bindVal("s-cash-total", v => S.sale.cash.total = v);  bindVal("s-card-total", v => S.sale.card.total = v);
  bindVal("s-card-fee", v => S.sale.card.fee = v);
  const st = root.querySelector("#s-state");
  if (st) st.onchange = () => { S.sale.state = st.value; S.sale.county = defaultCounty(st.value); render(); };
  const cty = root.querySelector("#s-county"); if (cty) cty.onchange = () => { S.sale.county = cty.value; refreshPrev(); };
  const rec = root.querySelector("#recordSale");
  if (rec) rec.onclick = () => {
    const f = S.sale, codes = productCodes();
    const jarsOf = kind => Object.fromEntries(codes.map(c => [c, num(f[kind].jars[c])]));
    if (f.mode === "market") post("/api/market", { county: f.county,
      cash: { total: num(f.cash.total), jars: jarsOf("cash") },
      card: { total: num(f.card.total), fee: num(f.card.fee), jars: jarsOf("card") } });
    else { const ships = SHIPS(f.channel);
      post("/api/sale", { channel: (channelByName(f.channel) || {}).id, county: f.county,
        items: codes.map(c => ({ code: c, jars: num(f.qty[c]), price: num(f.price[c]) })),
        ship_rev: ships ? num(f.shipRev) : 0, ship_exp: ships ? num(f.shipExp) : 0 }); }
  };
}

// =============================================================================
//  INVENTORY
// =============================================================================
function pageInventory(){
  const cards = D.inventory.map(p => {
    const low = /LOW/.test(p.status);
    return `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="font-weight:600;font-size:15px">${esc(p.name)}</span>
        <span style="${badge(low?"#fbeeee":"#e9f4ec", low?"#b42318":"#1d6b35")}">${low?"Reorder":"In stock"}</span></div>
      <div style="display:flex;align-items:baseline;gap:6px">
        <span style="font-size:34px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${p.on_hand.toLocaleString("en-US")}</span>
        <span style="font-size:14px;color:#8f867c">jars on hand</span></div>
      <div style="position:relative;height:8px;background:#f0ebe4;border-radius:4px">
        <div style="position:absolute;left:0;top:0;bottom:0;width:${Math.min(100,p.on_hand/stockScale()*100)}%;background:${low?"#b42318":"#2f7d4a"};border-radius:4px"></div>
        <div style="position:absolute;top:-3px;bottom:-3px;left:${p.reorder/stockScale()*100}%;width:2px;background:#221e1b"></div></div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding-top:4px">
        ${[["Produced",p.produced],["Sold",p.sold],["Adjusted",sgn(p.adjusted)],["Reorder at",p.reorder]].map(([l,v])=>
          `<div><div style="font-size:11px;color:#8f867c">${l}</div><div style="font-size:14px;font-weight:600;font-variant-numeric:tabular-nums">${typeof v==="number"?v.toLocaleString("en-US"):v}</div></div>`).join("")}
      </div></div>`;
  }).join("");

  const modes = [["restock","Add production batch"],["adjust","Adjust stock"]].map(([k,l]) =>
    `<button data-invmode="${k}" style="${pill(S.inv.mode===k)}">${l}</button>`).join("");
  const prodChips = D.inventory.map(p =>
    `<button data-invproduct="${p.code}" style="${opt(S.inv.product===p.code)}">${esc(p.name)}</button>`).join("");
  const inputStyle = "width:100%;padding:10px 12px;border:1px solid #d9d2c9;border-radius:8px;font:400 15px 'IBM Plex Sans',sans-serif;background:#fff;color:#221e1b";

  let formBody;
  if (S.inv.mode === "restock") {
    formBody = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px">
        <label class="fld">Jars produced<input id="i-jars" type="number" min="1" value="${esc(S.inv.jars)}" style="${inputStyle}"></label>
        <label class="fld">Batch code<input id="i-code" value="${esc(S.inv.code)}" style="${inputStyle}" class="mono"></label></div>`;
  } else {
    const reasons = ["Breakage","Spoilage","Samples","Found","Other"].map(r =>
      `<button data-reason="${r}" style="${opt(S.inv.reason===r)}">${r}</button>`).join("");
    const reasonHints = { Breakage:"Jars broken in storage or transit — removes stock.", Spoilage:"Expired or spoiled jars — removes stock.",
      Samples:"Free tastings and samples — removes stock.", Found:"Jars found that weren't in the system — adds stock.", Other:"Anything else — choose a direction." };
    const dir = S.inv.reason === "Found" ? `<div style="font-size:12px;color:#8f867c">${reasonHints.Found}</div>`
      : S.inv.reason === "Other"
        ? `<div style="display:flex;gap:8px">${[["loss","Loss (−)"],["gain","Gain (+)"]].map(([k,l])=>`<button data-dir="${k}" style="${chip(S.inv.direction===k)}">${l}</button>`).join("")}</div>`
        : `<div style="font-size:12px;color:#8f867c">${reasonHints[S.inv.reason]}</div>`;
    formBody = `<div style="display:flex;flex-direction:column;gap:20px">
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="font-size:13px;font-weight:600;color:#5b534b">Reason</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">${reasons}</div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px">
          <label class="fld">Jars<input id="i-adjjars" type="number" min="1" value="${esc(S.inv.adjJars)}" style="${inputStyle}"></label>
          <label class="fld">Note (optional)<input id="i-note" value="${esc(S.inv.note)}" placeholder="e.g. Case dropped" style="${inputStyle}"></label></div>
        ${dir}</div>`;
  }

  const formCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:20px;flex:3 1 460px;min-width:0">
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:13px;font-weight:600;color:#5b534b">Product</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${prodChips}</div></div>
      ${formBody}</div>`;

  const previewCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:16px;flex:2 1 320px;min-width:0">
      <h2 style="margin:0;font-size:16px;font-weight:600">${esc(prod(S.inv.product).name)}</h2>
      <div id="invPreview">${invPreviewInner()}</div>
      <button id="submitInv" style="${btnPrimary}">${S.loading ? "Saving…" : S.inv.mode==="restock" ? "Add batch" : "Record adjustment"}</button>
    </div>`;

  // ledger
  const fmap = { all:null, Sales:"SALE", Batches:"PRODUCTION", Adjustments:"ADJUSTMENT" };
  const filters = [["all","All"],["Sales","Sales"],["Batches","Batches"],["Adjustments","Adjustments"]].map(([k,l]) =>
    `<button data-ledfilter="${k}" style="${chip(S.ledgerFilter===k)}">${l}</button>`).join("");
  const want = fmap[S.ledgerFilter];
  const ledRows = D.ledger.filter(a => !want || a.type===want).map(a => {
    const [bg,fg] = TYPE_COLOR[a.type] || ["#eee","#555"];
    return `<tr style="${a.today?"background:#fbf8f3":""}">
      <td style="white-space:nowrap">${esc(a.date)}</td>
      <td><span style="display:inline-block;font-size:11px;font-weight:600;padding:3px 8px;border-radius:5px;background:${bg};color:${fg}">${TYPE_LABEL[a.type]||a.type}</span></td>
      <td>${esc(productName(a.code))}</td><td style="color:#5b534b">${esc(a.ref)}</td>
      <td class="num"><span class="mono" style="font-weight:500;color:${a.qty>0?"#1d6b35":"#b42318"}">${sgn(a.qty)}</span></td></tr>`;
  }).join("");
  const ledger = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin:0;font-size:16px;font-weight:600">Inventory ledger</h2>
          <p style="margin:3px 0 0;font-size:13px;color:#7d746b">Every jar in and out, newest first</p></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${filters}${dlBtn("ledger", "the full inventory ledger (current filter)", {type: S.ledgerFilter.toLowerCase()}, "Download")}</div></div>
      <div class="tw"><table style="min-width:560px"><thead><tr>
        <th>Date</th><th>Type</th><th>Product</th><th>Detail</th><th class="num">Change (jars)</th></tr></thead>
        <tbody>${ledRows}</tbody></table></div></div>`;

  return `<div style="display:flex;flex-direction:column;gap:20px">
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px">${cards}</section>
    <div style="display:flex;background:#fff;border:1px solid #e6e0d8;border-radius:8px;padding:3px;gap:2px;align-self:flex-start">${modes}</div>
    <section style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">${formCard}${previewCard}</section>
    ${ledger}</div>`;
}

// after a batch is saved, suggest the next number: SS-B051 or SS-B051-1 -> SS-B052
// the next free code from the database (older server: fall back to a guess)
const suggestBatch = code => (D && D.next_batch && D.next_batch[code]) || code + "-B051";
function nextBatchCode(code){
  const m = String(code).replace(/-\d+$/, "").match(/^(.*?)(\d+)$/);
  return m ? m[1] + String(+m[2] + 1).padStart(m[2].length, "0") : code + "-2";
}
function invDelta(){
  const p = S.inv;
  if (p.mode === "restock") return num(p.jars);
  const jars = num(p.adjJars);
  const gain = p.reason === "Found" || (p.reason === "Other" && p.direction === "gain");
  return gain ? jars : -jars;
}
function invPreviewInner(){
  const code = S.inv.product, oh = onHand(code), delta = invDelta(), to = oh + delta;
  const rl = prod(code).reorder;
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f7f4f0;border-radius:8px;padding:16px">
      <div><div style="font-size:12px;color:#8f867c">On hand now</div><div style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums">${oh.toLocaleString("en-US")}</div></div>
      <div class="mono" style="font-size:15px;font-weight:500;color:${delta>=0?"#1d6b35":"#b42318"}">${sgn(delta)}</div>
      <div style="text-align:right"><div style="font-size:12px;color:#8f867c">After</div><div style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums">${(to<0?0:to).toLocaleString("en-US")}</div></div></div>
    <div style="font-size:13px;color:#5b534b;margin-top:12px">${to<rl?`Still below the reorder level of ${rl.toLocaleString("en-US")}.`:`Above the reorder level of ${rl.toLocaleString("en-US")}.`}</div>`;
}

function bindInventory(){
  root.querySelectorAll("[data-invmode]").forEach(b => b.onclick = () => { S.inv.mode = b.dataset.invmode; render(); });
  root.querySelectorAll("[data-invproduct]").forEach(b => b.onclick = () => {
    S.inv.product = b.dataset.invproduct;
    S.inv.code = suggestBatch(S.inv.product);
    render();
  });
  root.querySelectorAll("[data-reason]").forEach(b => b.onclick = () => { S.inv.reason = b.dataset.reason; render(); });
  root.querySelectorAll("[data-dir]").forEach(b => b.onclick = () => { S.inv.direction = b.dataset.dir; render(); });
  root.querySelectorAll("[data-ledfilter]").forEach(b => b.onclick = () => { S.ledgerFilter = b.dataset.ledfilter; render(); });
  const refreshPrev = () => { const el = root.querySelector("#invPreview"); if (el) el.innerHTML = invPreviewInner(); };
  const jars = root.querySelector("#i-jars"); if (jars) jars.oninput = () => { S.inv.jars = jars.value; refreshPrev(); };
  const code = root.querySelector("#i-code"); if (code) code.oninput = () => { S.inv.code = code.value; };
  const aj = root.querySelector("#i-adjjars"); if (aj) aj.oninput = () => { S.inv.adjJars = aj.value; refreshPrev(); };
  const note = root.querySelector("#i-note"); if (note) note.oninput = () => { S.inv.note = note.value; };
  const sub = root.querySelector("#submitInv");
  if (sub) sub.onclick = () => {
    const p = S.inv;
    if (p.mode === "restock") {
      if (!num(p.jars)) { S.notice = {ok:false, text:"Enter how many jars were produced."}; render(); return; }
      post("/api/restock", { product:p.product, jars:num(p.jars), code:(p.code||"B-NEW").trim() })
        .then(j => { if (j && j.ok && j.data && j.data.batch) { S.inv.code = (D.next_batch && D.next_batch[p.product]) || nextBatchCode(j.data.batch); render(); } });
    } else {
      if (!num(p.adjJars)) { S.notice = {ok:false, text:"Enter a number of jars."}; render(); return; }
      const gain = p.reason === "Found" || (p.reason === "Other" && p.direction === "gain");
      post("/api/adjust", { product:p.product, jars:num(p.adjJars), direction:gain?"gain":"loss", reason:p.reason, note:p.note });
    }
  };
}

// =============================================================================
//  STOCK COUNT
// =============================================================================
function pageCount(){
  if (!S.cnt.typed) S.cnt.counted = String(onHand(S.cnt.product));   // start from the live system number
  const prodChips = D.inventory.map(p =>
    `<button data-cntproduct="${p.code}" style="${opt(S.cnt.product===p.code)}">${esc(p.name)}</button>`).join("");
  const inputStyle = "width:100%;padding:12px 14px;border:1px solid #d9d2c9;border-radius:8px;background:#fff;color:#221e1b";

  const left = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:22px;flex:3 1 420px;min-width:0">
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:13px;font-weight:600;color:#5b534b">1 · Which product did you count?</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${prodChips}</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px">
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:#5b534b">2 · Jars on the shelf<input id="c-counted" type="number" min="0" value="${esc(S.cnt.counted)}" style="${inputStyle};font:500 20px 'IBM Plex Sans',sans-serif"></label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:#5b534b">Note (optional)<input id="c-note" value="${esc(S.cnt.note)}" style="${inputStyle};font-size:15px"></label></div>
      <label style="display:flex;gap:10px;align-items:flex-start;font-size:14px;cursor:pointer">
        <input id="c-reconcile" type="checkbox" ${S.cnt.reconcile?"checked":""} style="width:18px;height:18px;margin:1px 0 0;accent-color:#7a1f1f">
        <span>Update the system to match my count<span style="display:block;font-size:12px;color:#8f867c;margin-top:2px">Posts a "Count correction" adjustment for the difference.</span></span></label></div>`;

  const right = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:16px;flex:2 1 320px;min-width:0">
      <h2 style="margin:0;font-size:16px;font-weight:600">3 · Check the difference</h2>
      <div id="cntPreview">${cntPreviewInner()}</div>
      <button id="saveCount" style="${btnPrimary}">${S.loading ? "Saving…" : "Save count"}</button></div>`;

  const rows = D.count_variance.map(r => {
    const v = r.variance;
    const col = v==null||v===0 ? "#5b534b" : v<0 ? "#b42318" : "#8a5a00";
    return `<tr><td style="font-weight:500">${esc(r.name)}</td>
      <td class="num">${r.system_on_hand.toLocaleString("en-US")}</td>
      <td class="num">${r.counted!=null?r.counted.toLocaleString("en-US"):"—"}</td>
      <td style="color:#5b534b">${r.count_date||"Not counted yet"}</td>
      <td class="num"><span style="font-weight:600;color:${col}">${v!=null?sgn(v):"—"}</span></td></tr>`;
  }).join("");
  const table = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2 style="margin:0;font-size:16px;font-weight:600">Latest count vs system</h2>${dlBtn("counts", "the latest count vs system")}</div>
      <div class="tw"><table style="min-width:560px"><thead><tr>
        <th>Product</th><th class="num">System on hand</th><th class="num">Last counted</th><th>Count date</th><th class="num">Difference</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;

  return `<div style="display:flex;flex-direction:column;gap:20px">
    <section style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">${left}${right}</section>${table}</div>`;
}
function cntPreviewInner(){
  const sys = onHand(S.cnt.product), counted = num(S.cnt.counted), v = counted - sys;
  const tone = v===0 ? ["#e9f4ec","#1d6b35"] : v<0 ? ["#fbeeee","#b42318"] : ["#fbf1e3","#8a5a00"];
  const txt = v===0 ? "Matches the system." : v<0 ? `${Math.abs(v).toLocaleString("en-US")} jars missing from the shelf.` : `${v.toLocaleString("en-US")} more jars than the system expects.`;
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div style="background:#f7f4f0;border-radius:8px;padding:14px"><div style="font-size:12px;color:#8f867c">System says</div><div style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums">${sys.toLocaleString("en-US")}</div></div>
      <div style="background:#f7f4f0;border-radius:8px;padding:14px"><div style="font-size:12px;color:#8f867c">You counted</div><div style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums">${counted.toLocaleString("en-US")}</div></div></div>
    <div style="border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:2px;background:${tone[0]};color:${tone[1]};margin-top:12px">
      <div style="font-size:12px;font-weight:600">Difference</div>
      <div style="font-size:30px;font-weight:600;font-variant-numeric:tabular-nums">${sgn(v)}</div>
      <div style="font-size:13px">${txt}</div></div>`;
}
function bindCount(){
  root.querySelectorAll("[data-cntproduct]").forEach(b => b.onclick = () => { S.cnt.product = b.dataset.cntproduct; S.cnt.typed = false; render(); });
  const refreshPrev = () => { const el = root.querySelector("#cntPreview"); if (el) el.innerHTML = cntPreviewInner(); };
  const c = root.querySelector("#c-counted"); if (c) c.oninput = () => { S.cnt.counted = c.value; S.cnt.typed = true; refreshPrev(); };
  const nt = root.querySelector("#c-note"); if (nt) nt.oninput = () => { S.cnt.note = nt.value; };
  const rc = root.querySelector("#c-reconcile"); if (rc) rc.onchange = () => { S.cnt.reconcile = rc.checked; };
  const sv = root.querySelector("#saveCount");
  if (sv) sv.onclick = () => post("/api/count", { product:S.cnt.product, counted:num(S.cnt.counted), note:S.cnt.note, reconcile:S.cnt.reconcile })
    .then(j => { if (j && j.ok) { S.cnt.typed = false; render(); } });
}

// =============================================================================
//  REPORTS
// =============================================================================
function pageReports(){
  const m = D.monthly || [];
  const T = m.reduce((a,r) => ({ rev:a.rev+r.revenue, prof:a.prof+r.gross_profit, sch:a.sch+r.scholarship,
      exp:a.exp+r.expenses, jars:a.jars+r.jars }), {rev:0,prof:0,sch:0,exp:0,jars:0});
  // per product, from the monthly product rows: jars, revenue, cost (unit_cost) and scholarship (rate)
  const PT = D.products.map(p => { const jars = m.reduce((a,r) => a + ((r.by||{})[p.code]||0), 0);
    const rev = m.reduce((a,r) => a + ((r.by_rev||{})[p.code]||0), 0);
    return { ...p, jars, rev, cost: jars * p.unit_cost, sch: rev * p.scholarship_rate }; });
  const jarsT = T.jars, costT = PT.reduce((a,p) => a + p.cost, 0), feesT = Math.max(0, T.exp - costT);
  const costs = [...new Set(D.products.map(p => p.unit_cost))];
  const costLabel = costs.length === 1 ? `$${Number(costs[0]).toFixed(2)} per jar` : "each product's unit cost";
  const margin = T.rev ? Math.round(T.prof/T.rev*100) : 0;
  const best = m.reduce((x,y) => y.revenue>x.revenue?y:x, m[0]||{revenue:0,month:"—"});
  const worst = m.reduce((x,y) => y.revenue<x.revenue?y:x, m[0]||{revenue:0,month:"—"});

  // outlook (reorder + on hand)
  const outlook = D.reorder.map(r => {
    const oh = onHand(r.code), daily = r.avg_daily || 0.0001;
    const days = Math.floor(oh / daily), plan = r.lead + r.safety;     // planning days come from the product
    const urgent = days <= plan, soon = days <= plan * 2;
    const runOut = new Date(Date.now() + days*864e5);
    return { ...r, oh, days, urgent, soon,
      runOut: runOut.toLocaleDateString("en-US",{month:"short",day:"numeric"}),
      badge: urgent?"Order now":soon?"Order soon":"Healthy",
      badgeStyle: badge(urgent?"#fbeeee":soon?"#fbf1e3":"#e9f4ec", urgent?"#b42318":soon?"#8a5a00":"#1d6b35"),
      advice: urgent?`Less than ${plan} days of stock (lead time + safety). Start a batch now — production takes about ${r.lead} days.`
        : soon?`About ${days-plan} days before you need to start the next batch.`
        : `Plenty of stock. Next batch needed in roughly ${days-plan} days.` };
  });
  const tightest = outlook.reduce((x,y) => y.days<x.days?y:x, outlook[0]||{days:0,name:"—",runOut:"—"});
  const topChannel = D.channels_sales[0] || {name:"—"};
  const chTotUnits = D.channels_sales.reduce((a,c)=>a+c.units,0) || 1;

  const takeaways = [
    ["Best month", fmtMonth(best.month), `${money(best.revenue)} in revenue. Slowest was ${fmtMonth(worst.month)} at ${money(worst.revenue)}.`],
    ["Profit margin", margin+"%", `Out of every $1 earned, about ${margin}¢ is kept as gross profit.`],
    ["Top channel", esc(topChannel.name), `Sells ${Math.round(topChannel.units/chTotUnits*100)}% of all jars.`],
    ["Next to run out", tightest.days+" days", `${esc(tightest.name)} runs out around ${tightest.runOut} at the current pace.`],
  ].map(([l,v,t]) => `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:6px">
      <div style="font-size:13px;color:#7d746b;font-weight:500">${l}</div>
      <div style="font-size:26px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${v}</div>
      <div style="font-size:13px;color:#5b534b;line-height:1.45">${t}</div></div>`).join("");

  // where each $1 goes
  const splitRaw = [
    ["Gross profit","What the business keeps", T.prof, ACCENT],
    ["Product cost", costLabel, costT, "#8f867c"],
    ["Scholarship",`${schPct()} of ${esc(cobrandName())} sales`, T.sch, "#c49a3a"],
    ["Fees & shipping","Card fees + shipping paid", feesT, "#cfc6bb"],
  ];
  const splitBar = splitRaw.map(([l,sub,v,c]) => { const p = T.rev?v/T.rev:0;
    return `<div style="flex:${p} 1 0;background:${c};color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;min-width:4px">${p>0.06?Math.round(p*100)+"¢":""}</div>`; }).join("");
  const splitRows = splitRaw.map(([l,sub,v,c]) => { const p = T.rev?v/T.rev:0;
    return `<div style="display:grid;grid-template-columns:12px 1fr auto auto;gap:12px;align-items:center;padding:9px 0;border-top:1px solid #f0ebe4;font-size:14px">
        <span style="width:12px;height:12px;border-radius:3px;background:${c}"></span>
        <span>${l}<span style="display:block;font-size:12px;color:#8f867c">${sub}</span></span>
        <span style="font-variant-numeric:tabular-nums;color:#7d746b">${Math.round(p*100)}%</span>
        <span style="font-variant-numeric:tabular-nums;font-weight:600;min-width:80px;text-align:right">${money(v)}</span></div>`; }).join("");
  const splitCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px;flex:3 1 440px;min-width:0">
      <div><h2 style="margin:0;font-size:16px;font-weight:600">Where each $1 of revenue goes</h2><p style="margin:3px 0 0;font-size:13px;color:#7d746b">${money(T.rev)} total revenue</p></div>
      <div style="display:flex;height:36px;border-radius:8px;overflow:hidden;gap:2px">${splitBar}</div>
      <div style="display:flex;flex-direction:column">${splitRows}</div></div>`;

  // product comparison
  const compare = PT.map(p => `<div style="background:#f7f4f0;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px">
      <div style="font-weight:600;font-size:14px">${esc(p.name)}</div>
      <div><div style="font-size:11px;color:#8f867c">Jars sold</div><div style="font-size:20px;font-weight:600;font-variant-numeric:tabular-nums">${p.jars.toLocaleString("en-US")}</div></div>
      <div><div style="font-size:11px;color:#8f867c">Share of jars</div><div style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">${jarsT?Math.round(p.jars/jarsT*100):0}%</div></div>
      <div><div style="font-size:11px;color:#8f867c">Revenue</div><div style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">${money(p.rev)}</div></div>
      <div><div style="font-size:11px;color:#8f867c">Scholarship</div><div style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">${p.is_cobranded ? money(p.sch) : "Not co-branded"}</div></div></div>`).join("");
  const compareCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px;flex:2 1 320px;min-width:0">
      <div><h2 style="margin:0;font-size:16px;font-weight:600">Product comparison</h2><p style="margin:3px 0 0;font-size:13px;color:#7d746b">Jars sold, side by side</p></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px">${compare}</div>
      <p style="margin:0;font-size:13px;color:#5b534b;line-height:1.5">Only ${esc(cobrandName())} ${(D.products.filter(p => p.is_cobranded).length > 1) ? "are" : "is"} co-branded with ${esc(licensor())}, so only those sales fund the ${schPct()} scholarship.</p></div>`;

  // month by month
  const maxRev = Math.max(1, ...m.map(r => r.revenue));
  const mrows = m.map((r,i) => {
    const prev = i ? m[i-1].revenue : null;
    const chg = prev ? (r.revenue-prev)/prev*100 : null;
    const mg = r.revenue ? r.gross_profit/r.revenue*100 : 0;
    const jars = r.jars;
    return `<tr style="${r.revenue===maxRev?"background:#fbf8f3":""}">
      <td style="white-space:nowrap">${fmtMonth(r.month)}</td>
      <td class="num">${jars.toLocaleString("en-US")}</td><td class="num">${money(r.revenue)}</td>
      <td class="num"><span style="font-size:12px;font-weight:600;color:${chg==null?"#8f867c":chg>=0?"#1d6b35":"#b42318"}">${chg==null?"—":(chg>=0?"▲ ":"▼ ")+pctAbs(chg)+"%"}</span></td>
      <td class="num" style="color:#7d746b">${money(r.expenses)}</td><td class="num" style="color:#7d746b">${money(r.scholarship)}</td>
      <td class="num" style="font-weight:600">${money(r.gross_profit)}</td>
      <td style="min-width:140px"><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;background:#f0ebe4;border-radius:3px"><div style="height:100%;width:${mg}%;background:${ACCENT};border-radius:3px"></div></div><span style="font-size:12px;font-variant-numeric:tabular-nums;color:#5b534b;width:32px;text-align:right">${mg.toFixed(0)}%</span></div></td></tr>`;
  }).join("");
  const totalRow = `<tr style="background:#faf7f3;font-weight:600">
      <td>Total</td><td class="num">${jarsT.toLocaleString("en-US")}</td><td class="num">${money(T.rev)}</td><td></td>
      <td class="num">${money(T.exp)}</td><td class="num">${money(T.sch)}</td><td class="num">${money(T.prof)}</td>
      <td><span style="font-size:12px;color:#5b534b">${margin}%</span></td></tr>`;
  const monthTable = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap"><div><h2 style="margin:0;font-size:16px;font-weight:600">Month by month</h2><p style="margin:3px 0 0;font-size:13px;color:#7d746b">Expenses = product cost + card fees + shipping paid. Arrows compare with the month before.</p></div>${dlBtn("monthly", "the month-by-month report")}</div>
      <div class="tw"><table style="min-width:800px"><thead><tr>
        <th>Month</th><th class="num">Jars sold</th><th class="num">Revenue</th><th class="num">vs. prior</th>
        <th class="num">Expenses</th><th class="num">Scholarship</th><th class="num">Gross profit</th><th>Margin</th></tr></thead>
        <tbody>${mrows}${totalRow}</tbody></table></div></div>`;

  // channels table + tax by county
  const chShareMax = Math.max(1, ...D.channels_sales.map(c=>c.units));
  const chRows = D.channels_sales.map(c => `<tr>
      <td style="font-weight:500;white-space:nowrap">${esc(c.name)}</td>
      <td style="min-width:120px"><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;background:#f0ebe4;border-radius:3px"><div style="height:100%;width:${c.units/chShareMax*100}%;background:${c.revenue?ACCENT:"#b9b0a6"};border-radius:3px"></div></div><span style="font-size:12px;color:#5b534b;width:30px;text-align:right;font-variant-numeric:tabular-nums">${Math.round(c.units/chTotUnits*100)}%</span></div></td>
      <td class="num">${c.units.toLocaleString("en-US")}</td><td class="num" style="color:#7d746b">${c.revenue?"$"+(c.revenue/c.units).toFixed(2):"—"}</td>
      <td class="num" style="font-weight:600">${c.revenue?money(c.revenue):"—"}</td></tr>`).join("");
  const channelsTable = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px;flex:1 1 520px;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap"><div><h2 style="margin:0;font-size:16px;font-weight:600">Sales channels</h2><p style="margin:3px 0 0;font-size:13px;color:#7d746b">Includes cash &amp; market sales online stores never see</p></div>${dlBtn("channels", "sales by channel")}</div>
      <div class="tw"><table><thead><tr><th>Channel</th><th>Share of jars</th><th class="num">Jars</th><th class="num">Avg $/jar</th><th class="num">Revenue</th></tr></thead><tbody>${chRows}</tbody></table></div></div>`;

  const taxTot = D.tax_by_county.reduce((a,t)=>a+t.tax,0);
  const oos = D.out_of_state || {orders:0, sales:0};
  const taxRows = D.tax_by_county.map(t => `<tr>
      <td style="white-space:nowrap">${esc(cty(t.county))}</td><td class="num" style="color:#7d746b">${t.base?(t.tax/t.base*100).toFixed(2)+"%":"—"}</td>
      <td class="num">${money(t.base)}</td><td class="num" style="font-weight:600">${money(t.tax)}</td></tr>`).join("");
  const taxTable = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px;flex:1 1 520px;min-width:0">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap"><div><h2 style="margin:0;font-size:16px;font-weight:600">Sales tax collected by county</h2><p style="margin:3px 0 0;font-size:13px;color:#7d746b">To remit to ${esc(CFG("tax_authority"))}, reported by county · ${homeFoodRate() != null ? pctTxt(homeFoodRate()) + " qualifying-food rate" : "food rate"} on items + shipping · ${money(taxTot)} total (top ${D.tax_by_county.length} counties shown).
        ${oos.orders ? `Outside ${esc(HOME())}: ${oos.orders.toLocaleString("en-US")} orders, ${money(oos.sales)} — no ${esc(HOME())} tax.` : ""}</p></div>${dlBtn("tax_by_county", `tax collected for every ${HOME()} county (not just the top ${D.tax_by_county.length})`, {}, "Download all counties")}</div>
      <div class="tw"><table><thead><tr><th>County</th><th class="num">Rate charged</th><th class="num">Taxable sales</th><th class="num">Tax</th></tr></thead><tbody>${taxRows}</tbody></table></div></div>`;

  // Function 3: licensing report (co-branded products only; licensor from business_setting)
  const SM = D.scholarship_monthly || [];
  if (!S.schMonth || !SM.find(r => r.month === S.schMonth)) S.schMonth = SM.length ? SM[SM.length-1].month : null;
  const sm = SM.find(r => r.month === S.schMonth) || {co_jars:0, co_revenue:0, ex_jars:0, ex_revenue:0, owed:0, month:""};
  const yr = String(sm.month).split("-")[2];
  const ytd = SM.filter(r => String(r.month).split("-")[2] === yr)
                .reduce((a,r) => ({j:a.j+r.co_jars, rev:a.rev+r.co_revenue, owed:a.owed+r.owed}), {j:0,rev:0,owed:0});
  const monthOpts = [...SM].reverse().map(r => `<option value="${esc(r.month)}" ${r.month===S.schMonth?"selected":""}>${fmtMonth(r.month)}</option>`).join("");
  const big = (l, v) => `<div style="background:#f7f4f0;border-radius:10px;padding:14px 16px;flex:1 1 150px">
      <div style="font-size:12px;color:#8f867c">${l}</div><div style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums">${v}</div></div>`;
  const scholarshipCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin:0;font-size:16px;font-weight:600">${esc(licensor())} scholarship report</h2>
          <p style="margin:3px 0 0;font-size:13px;color:#7d746b">The monthly licensing report: co-branded ${esc(cobrandName())} only. ${esc(otherNames())} ${D.products.filter(p => !p.is_cobranded).length > 1 ? "are" : "is"} excluded automatically (0% rate).</p></div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#5b534b">Month
          <select id="sch-month" style="padding:8px 10px;border:1px solid #d9d2c9;border-radius:8px;font-size:14px;background:#fff">${monthOpts}</select></label>${dlBtn("scholarship", "the scholarship report for every month", {}, "Download all months")}</div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${big(`${esc(cobrandName())} bottles sold`, sm.co_jars.toLocaleString("en-US"))}
        ${big(`${esc(cobrandName())} revenue received`, cents(sm.co_revenue))}
        ${big(`Scholarship owed (${schPct()})`, cents(sm.owed))}</div>
      <div style="font-size:14px;background:#eef2fb;color:#2a4f9a;border-radius:8px;padding:10px 14px">
        <strong>For the report:</strong> ${fmtMonth(sm.month)} — ${sm.co_jars.toLocaleString("en-US")} bottles of ${esc(cobrandName())} sold, ${cents(sm.co_revenue)} revenue received, ${cents(sm.owed)} scholarship owed.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;font-size:13px">
        <div style="border:1px solid #ece6dd;border-radius:8px;padding:10px 12px;color:#5b534b">
          <div style="font-weight:600;color:#221e1b;margin-bottom:2px">How it's calculated</div>
          ${schPct()} × ${cents(sm.co_revenue)} co-branded revenue = <strong>${cents(sm.owed)}</strong>
          <span style="color:#8f867c">(worked out on each sale, so it can differ by a few cents from ${schPct()} of the monthly total)</span></div>
        <div style="border:1px solid #ece6dd;border-radius:8px;padding:10px 12px;color:#5b534b">
          <div style="font-weight:600;color:#221e1b;margin-bottom:2px">Excluded automatically</div>
          ${esc(otherNames())}: ${(sm.ex_jars||0).toLocaleString("en-US")} bottles, ${cents(sm.ex_revenue||0)} revenue × 0% = <strong>$0.00</strong>
          <span style="color:#8f867c">— not co-branded, so it never counts toward the scholarship.</span></div></div>
      <div style="font-size:13px;color:#5b534b">Year ${esc(yr)} so far: ${ytd.j.toLocaleString("en-US")} bottles · ${cents(ytd.rev)} revenue · <strong>${cents(ytd.owed)} owed</strong>. The scholarship is ${schPct()} of what was actually received, so discounts and wholesale prices are already reflected.</div></div>`;

  const outlookCards = outlook.map(o => `<div style="border:1px solid #ece6dd;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-weight:600;font-size:15px">${esc(o.name)}</span><span style="${o.badgeStyle}">${o.badge}</span></div>
      <div style="display:flex;align-items:baseline;gap:8px"><span style="font-size:32px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${o.days}</span><span style="font-size:14px;color:#5b534b">days of stock left · runs out ~${o.runOut}</span></div>
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px">
        ${[["On hand",o.oh.toLocaleString("en-US")],["Sells / day",o.avg_daily.toFixed(1)],["Suggested",o.suggested.toLocaleString("en-US")],["Current",o.current.toLocaleString("en-US")]].map(([l,v])=>
          `<div><div style="font-size:11px;color:#8f867c">${l}</div><div style="font-size:14px;font-weight:600;font-variant-numeric:tabular-nums">${v}</div></div>`).join("")}</div>
      <div style="font-size:13px;color:#5b534b;background:#f7f4f0;border-radius:8px;padding:10px 12px;line-height:1.45">${o.advice}</div></div>`).join("");
  const outlookCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:16px">
      <div><h2 style="margin:0;font-size:16px;font-weight:600">Stock outlook &amp; reorder guidance</h2><p style="margin:3px 0 0;font-size:13px;color:#7d746b">Average daily sales over the last ${(D.reorder[0]||{}).window || ""} days. Suggested reorder point = daily demand × (lead time + safety days): ${D.reorder.map(r => `${esc(r.name)} ${r.lead}+${r.safety} days`).join(", ")}.</p></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:12px">${outlookCards}</div></div>`;

  return `<div style="display:flex;flex-direction:column;gap:20px">
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:16px">${takeaways}</section>
    ${scholarshipCard}
    <section style="display:flex;flex-wrap:wrap;gap:16px">${splitCard}${compareCard}</section>
    ${monthTable}
    <section style="display:flex;flex-wrap:wrap;gap:16px">${channelsTable}${taxTable}</section>
    ${outlookCard}</div>`;
}

// =============================================================================
//  TAX RATES  (Function 1)
// =============================================================================
function pageTax(){
  const s = D.tax_summary, nc = s.home_status || {}, H = esc(HOME()), AUTH = esc(CFG("tax_authority")), food = homeFoodRate();
  const ncCurrent = (nc["Verified"]||0) + (nc["Refreshed"]||0);
  const tile = (l,v,note) => `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:8px">
      <div style="font-size:13px;color:#7d746b;font-weight:500">${l}</div>
      <div style="font-size:30px;font-weight:600;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${v}</div>
      <div style="font-size:12px;color:#8f867c">${note}</div></div>`;
  const tiles = [
    tile(`Qualifying-food rate (${H})`, food != null ? pctTxt(food) : "—", `Every ${H} county · includes shipping`),
    tile("Counties loaded", s.counties_loaded.toLocaleString("en-US"), "From Function 1 — County_Tax_Lookup.csv"),
    tile("States covered", s.states_covered.toLocaleString("en-US"), "Full US county dataset"),
    tile("Review required", s.review_required.toLocaleString("en-US"), "No single rate found — can't be used for sales"),
    tile(`${H} general rates`, s.home_last_refreshed ? "Updated" : "Estimates",
      s.home_last_refreshed
        ? `Refreshed ${esc(s.home_last_refreshed)} · ${nc["Verified"]||0} verified, ${nc["Refreshed"]||0} refreshed`
        : "Function 1 estimates — not refreshed yet"),
  ].join("");

  // ---- "Keep the home state's rates up to date" card ----------------------
  const P = S.taxPlan;
  let planBody = "";
  if (P === "loading") {
    planBody = `<div style="font-size:14px;color:#5b534b">Downloading the latest ${H} rate file…</div>`;
  } else if (P && P.error) {
    planBody = `<div style="background:#fbeeee;border:1px solid #efc9c9;color:#8a1c12;border-radius:8px;padding:12px 14px;font-size:14px">${esc(P.error)}</div>`;
  } else if (P) {
    const pct = r => r == null ? "—" : (r*100).toFixed(2) + "%";
    const fromLine = P.how === "live"
      ? `Downloaded the latest rate file just now (${esc(P.downloaded)}).`
      : `Couldn't reach the internet, so this uses the copy saved on ${esc(P.downloaded)}.`;
    const nChange = P.rate_changes.length;
    const summary = `${fromLine} Checked ${P.checked} ${H} counties: <strong>${nChange} ${nChange===1?"rate changes":"rates change"}</strong>, ${P.confirmed} confirmed unchanged.`;

    const changeRows = P.rate_changes.map(r => {
      const parts = (r.parts||[]).map(x => `${(x.rate*100).toFixed(2)}% ${esc(x.label === HOME() + " state" ? "state" : x.label)}`).join(" + ");
      const up = r.old == null || r.new > r.old;
      return `<tr>
        <td style="white-space:nowrap;font-weight:500">${esc(cty(r.county))}</td>
        <td class="num" style="color:#7d746b">${pct(r.old)}</td>
        <td class="num" style="font-weight:600;color:${up?"#b42318":"#1d6b35"}">${pct(r.new)}</td>
        <td style="font-size:13px;color:#5b534b;min-width:260px">${parts}</td>
        <td style="white-space:nowrap;color:#5b534b">${esc(r.effective||"—")}</td>
        <td>${statusBadge(r.status)}</td>
        <td style="font-size:13px;white-space:nowrap">${safeLink(r.source, r.status==="Verified" ? "tax_rates.csv" : "Rate file")}</td></tr>`;
    }).join("");
    const changesTable = nChange
      ? `<div class="tw"><table style="min-width:820px"><thead><tr><th>County</th><th class="num">Now</th><th class="num">New</th><th>What makes up the new rate</th><th>Effective</th><th>Status</th><th>Source</th></tr></thead><tbody>${changeRows}</tbody></table></div>`
      : `<div style="background:#e9f4ec;color:#1d6b35;border-radius:8px;padding:12px 14px;font-size:14px">Every ${H} county already matches the latest rate file.</div>`;

    const notes = (P.notes||[]).map(n => `<li><strong>${esc(cty(n.county))}:</strong> ${esc(n.note)}</li>`).join("");
    const upcoming = (P.upcoming||[]).map(u => `<li>${esc(u.name)} — ${(u.rate*100).toFixed(2)}% from ${esc(u.effective)}</li>`).join("");
    const missing = (P.missing||[]).length ? `<div style="font-size:13px;color:#8a5a00">Not in the rate file (kept as is): ${P.missing.map(m=>esc(cty(m))).join(", ")}</div>` : "";

    planBody = `<div style="font-size:14px;color:#221e1b;line-height:1.5">${summary}</div>
      ${changesTable}
      ${notes ? `<div style="background:#fbf1e3;color:#8a5a00;border-radius:8px;padding:10px 14px;font-size:13px"><strong>Please double-check</strong><ul style="margin:6px 0 0;padding-left:18px">${notes}</ul></div>` : ""}
      ${upcoming ? `<div style="font-size:13px;color:#5b534b"><strong>Coming up</strong> (not applied until the date arrives — check again then):<ul style="margin:6px 0 0;padding-left:18px">${upcoming}</ul></div>` : ""}
      ${missing}
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button id="tax-apply" style="${btnPrimary}">${S.loading ? "Saving…" : P.already_current ? "Apply again" : "Apply update"}</button>
        <button id="tax-cancel" style="background:#fff;color:#5b534b;border:1px solid #d9d2c9;border-radius:8px;padding:12px 16px;font:500 14px 'IBM Plex Sans',sans-serif;cursor:pointer">${P.already_current?"Close":"Cancel"}</button>
        <span style="font-size:12px;color:#8f867c">Only new sales use updated rates — past sales keep the tax they were charged. Official list: ${safeLink(P.official_url, CFG("tax_authority") + " current rates")}</span>
      </div>`;
  }

  const refreshCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="max-width:720px"><h2 style="margin:0;font-size:16px;font-weight:600">General ${H} rates (non-food items) — keep up to date</h2>
          <p style="margin:4px 0 0;font-size:13px;color:#5b534b;line-height:1.55">These full rates apply to <strong>non-food</strong> items (e.g. merchandise) — qualifying food doesn't use them. Function 1's file adds the <strong>state</strong> rate and the <strong>county</strong> rate; some counties also charge a <strong>local transit or special-district tax</strong>, so their real general rate is higher. <em>Check for updates</em> downloads the latest ${H} rate file, adds those local taxes in, and uses your hand-checked rates from <span class="mono">tax_rates.csv</span>. You'll see every change before anything is saved.</p></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="tax-check" style="${btnPrimary};padding:11px 16px;font-size:14px">${P==="loading" ? "Checking…" : P && !P.error ? "Check again" : "Check for updates"}</button>
          ${`<button id="tax-revert" style="background:transparent;border:0;padding:4px;font:500 13px 'IBM Plex Sans',sans-serif;color:#7a1f1f;cursor:pointer;text-decoration:underline">Undo — go back to Function 1 rates</button>`}
        </div></div>
      ${planBody}</div>`;

  // ---- county table --------------------------------------------------------
  const stateOpts = D.tax_states.map(st => `<option value="${esc(st)}" ${S.taxState===st?"selected":""}>${esc(st)}</option>`).join("");
  let countyBody;
  if (S.taxCounties == null) {
    countyBody = `<tr><td colspan="7" style="color:#8f867c">Loading ${esc(S.taxState)} counties…</td></tr>`;
  } else if (S.taxCounties.length === 0) {
    countyBody = `<tr><td colspan="7" style="color:#8f867c">No counties for ${esc(S.taxState)}.</td></tr>`;
  } else {
    countyBody = S.taxCounties.map(c => {
      const differs = c.lookup_rate != null && c.rate != null && Math.abs(c.lookup_rate - c.rate) > 1e-6;
      return `<tr><td style="font-family:'IBM Plex Mono',monospace;font-size:13px;color:#7d746b;white-space:nowrap">${esc(c.code)}</td>
        <td style="white-space:nowrap">${esc(c.county)}</td>
        <td class="num" style="font-weight:600">${c.food_rate != null ? pctR(c.food_rate) : '<span style="color:#8a5a00;font-weight:500">not collected</span>'}</td>
        <td class="num">${pctR(c.rate)}</td>
        <td class="num" style="color:#7d746b">${differs ? pctR(c.lookup_rate) : '<span style="color:#b9b0a6">same</span>'}</td>
        <td>${statusBadge(c.status)}</td>
        <td style="white-space:nowrap;color:#5b534b">${esc(c.effective||"—")}</td></tr>`;
    }).join("");
  }
  const countyCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin:0;font-size:16px;font-weight:600">County sales-tax rates</h2>
          <p style="margin:3px 0 0;font-size:13px;color:#7d746b">"Qualifying-food rate" is what new sales of food products are charged. Other states show "not collected" — the business is registered only in ${H}.</p></div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#5b534b">State
          <select id="tax-state" style="padding:8px 10px;border:1px solid #d9d2c9;border-radius:8px;font-size:14px;background:#fff">${stateOpts}</select></label>${dlBtn("tax_rates", "tax rates for the selected state", {state: S.taxState})}</div></div>
      <div class="tw" style="max-height:460px;overflow-y:auto"><table><thead><tr><th>Tax code</th><th>County</th><th class="num">Qualifying-food rate</th><th class="num">General rate</th><th class="num">Function 1 estimate</th><th>Status</th><th>Effective</th></tr></thead><tbody>${countyBody}</tbody></table></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:#5b534b;align-items:center">
        <span>${statusBadge("Verified")} checked by hand against ${AUTH}</span>
        <span>${statusBadge("Refreshed")} from the latest ${H} rate file</span>
        <span>${statusBadge("Provisional")} Function 1 estimate (state + county only)</span>
        <span>${statusBadge("Review Required")} no single rate — can't be used</span></div></div>`;

  const reviewRows = D.tax_review.length
    ? D.tax_review.map(r => `<tr><td>${esc(r.state)}</td><td>${esc(r.county)}</td><td>${statusBadge(r.status)}</td></tr>`).join("")
    : `<tr><td colspan="3" style="color:#1d6b35">No records flagged for review.</td></tr>`;
  const reviewCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap"><div><h2 style="margin:0;font-size:16px;font-weight:600">Records flagged for review</h2>
        <p style="margin:3px 0 0;font-size:13px;color:#7d746b">Function 1 found more than one rate for these counties, so it left the rate blank. ${D.tax_review.some(r => r.state === HOME()) ? `Some are in ${H} — check them before selling there.` : `None are in ${H}, so sales aren't affected.`}</p></div>${dlBtn("tax_review", "the records flagged for review")}</div>
      <div class="tw" style="max-height:360px;overflow-y:auto"><table><thead><tr><th>State</th><th>County</th><th>Status</th></tr></thead><tbody>${reviewRows}</tbody></table></div></div>`;

  if (S.taxCounties == null) loadTaxCounties(S.taxState);

  const rule = (t, d) => `<div style="background:#f7f4f0;border-radius:10px;padding:14px 16px;flex:1 1 230px">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px">${t}</div><div style="font-size:13px;color:#5b534b;line-height:1.5">${d}</div></div>`;
  // the rules below are generated from the data: food rate (tax_code), channels (sales_channel), settings
  const foods = D.products.filter(p => p.is_qualifying_food).map(p => p.name).join(" & ");
  const untaxed = D.channels.filter(c => !c.taxable).map(c => c.name);
  const howCard = `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div><h2 style="margin:0;font-size:16px;font-weight:600">How sales tax is charged</h2>
        <p style="margin:3px 0 0;font-size:13px;color:#7d746b">Applied automatically on every sale, from the rates and settings in the database.</p></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${rule(`${H} customers: ${food != null ? pctTxt(food) : "—"} food rate`, `${esc(foods) || "Products marked as qualifying food"} ${foods.includes("&") ? "are" : "is"} <em>qualifying food</em> in ${H}, taxed at the county's food rate (${food != null ? pctTxt(food) : "—"}) instead of the general rate. Shipping charged to the customer is taxed too.`)}
        ${rule(`Outside ${H}: no ${H} tax`, `Orders shipped to another state aren't charged ${H} tax — the business is registered to collect only in ${H}. The county is still recorded from Function 1's nationwide list.`)}
        ${rule(untaxed.length ? esc(untaxed.join(", ")) : "Untaxed channels", untaxed.length ? `Not taxed (set per channel). Stock still goes down.` : "Every channel is taxed.")}
      </div>
      <div style="font-size:12px;color:#8f867c">Tax collected is reported to ${AUTH} by county (Reports → Sales tax collected by county). Source: ${safeLink(CFG("tax_guidance_url"), CFG("tax_authority") + " sales-tax guidance")}.</div></div>`;

  return `<div style="display:flex;flex-direction:column;gap:20px">
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:16px">${tiles}</section>
    ${howCard}${countyCard}${refreshCard}${reviewCard}</div>`;
}
async function loadTaxCounties(state){
  try {
    const r = await fetch("/api/tax?state=" + encodeURIComponent(state));
    const j = await r.json();
    if (S.page === "tax" && S.taxState === state) { S.taxCounties = j.counties || []; render(); }
  } catch (e) { if (S.page === "tax") { S.taxCounties = []; render(); } }
}
async function checkTaxUpdates(){
  S.taxPlan = "loading"; S.notice = null; render();
  try {
    const r = await fetch("/api/tax/refresh/preview");
    const j = await r.json();
    S.taxPlan = j.error ? { error: j.error } : j;
  } catch (e) { S.taxPlan = { error: "Couldn't reach the server: " + e }; }
  if (S.page === "tax") render();
}
async function taxAction(path){
  S.taxPlan = null;
  await post(path, {});            // shows the server's message and re-pulls all data
  S.taxCounties = null;            // reload the county table only AFTER the save finished
  if (S.page === "tax") render();
}
function bindTax(){
  const sel = root.querySelector("#tax-state");
  if (sel) sel.onchange = () => { S.taxState = sel.value; S.taxCounties = null; render(); };
  const chk = root.querySelector("#tax-check");    if (chk) chk.onclick = checkTaxUpdates;
  const app = root.querySelector("#tax-apply");    if (app) app.onclick = () => taxAction("/api/tax/refresh/apply");
  const can = root.querySelector("#tax-cancel");   if (can) can.onclick = () => { S.taxPlan = null; render(); };
  const rev = root.querySelector("#tax-revert");
  if (rev) rev.onclick = () => {
    if (confirm(`Put every ${HOME()} county back to Function 1's estimate (state + county rate only)? Past sales are not changed.`))
      taxAction("/api/tax/refresh/revert");
  };
}

// =============================================================================
//  SETTINGS  — edit the data every rule reads: products, channels, business settings.
//  Each row keeps an editable draft; its Save turns maroon once it differs from the
//  database. The server validates everything and saves all-or-nothing.
// =============================================================================
const fx = (n, d) => n == null || n === "" || isNaN(n) ? "" : String(+Number(n).toFixed(d));   // 16.0 -> "16"
const prodDraft = p => ({ code: p.code, name: p.name, retail_price: p.retail_price.toFixed(2),
  wholesale_price: p.wholesale_price.toFixed(2), unit_cost: p.unit_cost.toFixed(2),
  reorder_level: String(p.reorder_level), lead_time_days: String(p.lead_time_days), safety_days: String(p.safety_days),
  is_qualifying_food: p.is_qualifying_food, is_cobranded: p.is_cobranded, scholarship_pct: fx(p.scholarship_rate * 100, 1) });
const chDraft = c => ({ id: c.id, name: c.name, is_taxable: c.taxable, price_basis: c.price_basis,
  ships_orders: c.ships, fee_pct: fx(c.fee_pct * 100, 2), fee_fixed: c.fee_fixed.toFixed(2) });
const blankProd = () => ({ code: "", name: "", retail_price: "", wholesale_price: "", unit_cost: "", reorder_level: "",
  lead_time_days: "", safety_days: "", is_qualifying_food: false, is_cobranded: false, scholarship_pct: "" });
const blankCh = () => ({ id: null, name: "", is_taxable: false, price_basis: "retail", ships_orders: false, fee_pct: "", fee_fixed: "" });
const bizDraft = () => ({ values: Object.fromEntries((D.setting_rows || []).map(r => [r.key, r.value])),
  food_rate_pct: homeFoodRate() != null ? fx(homeFoodRate() * 100, 2) : "" });
const PRICE_BASIS = [["retail", "Retail price"], ["wholesale", "Wholesale price"], ["free", "Free (samples)"]];
const humanKey = k => k.replace(/_/g, " ").replace(/\burl\b/i, "URL").replace(/^./, c => c.toUpperCase());

function settingsDrafts(){
  const T = S.set;
  D.products.forEach(p => { if (!T.prod[p.code]) T.prod[p.code] = prodDraft(p); });
  D.channels.forEach(c => { if (!T.ch[c.id]) T.ch[c.id] = chDraft(c); });
  if (!T.newProd) T.newProd = blankProd();
  if (!T.newCh) T.newCh = blankCh();
  if (!T.biz) T.biz = bizDraft();
}
const sameAs = (a, b) => Object.keys(b).every(k => String(a[k]) === String(b[k]));
const anyTyped = d => Object.entries(d).some(([k, v]) => k !== "price_basis" && k !== "id" && v !== "" && v !== false);
function isDirty(kind, key){
  const T = S.set;
  if (kind === "prod") return key === "__new" ? anyTyped(T.newProd) : !sameAs(T.prod[key], prodDraft(productByCode(key)));
  if (kind === "ch")   return key === "__new" ? anyTyped(T.newCh) : !sameAs(T.ch[key], chDraft(D.channels.find(c => String(c.id) === String(key))));
  const b = bizDraft();
  return T.biz.food_rate_pct !== b.food_rate_pct || !sameAs(T.biz.values, b.values);
}
const saveBtn = (kind, key, label = "Save") =>
  `<button class="sv${isDirty(kind, key) ? " dirty" : ""}" data-save="${kind}" data-key="${esc(key)}">${S.loading && S.set.saving === kind + key ? "Saving…" : label}</button>`;

function pageSettings(){
  settingsDrafts();
  const T = S.set;
  const at = (kind, key, f) => `data-kind="${kind}" data-key="${esc(key)}" data-f="${f}"`;
  const tin = (kind, key, f, val, cls = "si r", extra = "") => `<input ${at(kind, key, f)} class="${cls}" value="${esc(val)}" ${extra}>`;
  const nin = (kind, key, f, val) => tin(kind, key, f, val, "si r", `inputmode="decimal" aria-label="${f.replace(/_/g, " ")}"`);
  const cbx = (kind, key, f, on) => `<input type="checkbox" class="ck" ${at(kind, key, f)} ${on ? "checked" : ""} aria-label="${f.replace(/_/g, " ")}">`;
  // the save result is shown inside the card that was saved (the top banner may be off-screen)
  const msgFor = kind => T.msg && T.msg.kind === kind ? `<div role="status" style="display:flex;gap:12px;align-items:center;border-radius:8px;padding:11px 14px;font-size:14px;background:${T.msg.ok ? "#e9f4ec" : "#fbeeee"};border:1px solid ${T.msg.ok ? "#b5dcc0" : "#efc9c9"};color:${T.msg.ok ? "#1d5b30" : "#8a1c12"}">
      <span style="flex:1">${esc(T.msg.text)}</span><button data-msgclose style="background:transparent;border:0;font:500 13px 'IBM Plex Sans',sans-serif;color:inherit;cursor:pointer;text-decoration:underline">Dismiss</button></div>` : "";
  const card = (kind, title, sub, dl, inner) => `<div style="background:#fff;border:1px solid #e6e0d8;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div style="max-width:900px"><h2 style="margin:0;font-size:16px;font-weight:600">${title}</h2>
          <p style="margin:4px 0 0;font-size:13px;color:#5b534b;line-height:1.55">${sub}</p></div>${dl}</div>${inner}${msgFor(kind)}</div>`;

  // ---- products --------------------------------------------------------------
  const prodRow = (key, d, isNew) => `<tr>
      <td class="st" style="${isNew ? "" : "font-family:'IBM Plex Mono',monospace;font-size:13px;color:#7d746b;padding-left:12px"}">${isNew
        ? tin("prod", key, "code", d.code, "si", `placeholder="Code" maxlength="4" style="text-transform:uppercase;min-width:58px" aria-label="new product code"`)
        : esc(d.code)}</td>
      <td class="st" style="min-width:170px">${tin("prod", key, "name", d.name, "si", `placeholder="${isNew ? "New product name" : ""}" aria-label="product name"`)}</td>
      <td class="st">${nin("prod", key, "retail_price", d.retail_price)}</td>
      <td class="st">${nin("prod", key, "wholesale_price", d.wholesale_price)}</td>
      <td class="st">${nin("prod", key, "unit_cost", d.unit_cost)}</td>
      <td class="st">${nin("prod", key, "reorder_level", d.reorder_level)}</td>
      <td class="st">${nin("prod", key, "lead_time_days", d.lead_time_days)}</td>
      <td class="st">${nin("prod", key, "safety_days", d.safety_days)}</td>
      <td class="st" style="text-align:center">${cbx("prod", key, "is_qualifying_food", d.is_qualifying_food)}</td>
      <td class="st" style="text-align:center">${cbx("prod", key, "is_cobranded", d.is_cobranded)}</td>
      <td class="st">${nin("prod", key, "scholarship_pct", d.scholarship_pct)}</td>
      <td class="st" style="padding-right:12px">${saveBtn("prod", key, isNew ? "+ Add" : "Save")}</td></tr>`;
  const prodTable = `<div class="tw"><table style="min-width:1180px"><thead><tr>
      <th class="st" style="padding-left:12px">Code</th><th class="st">Product</th><th class="st num">Retail $</th><th class="st num">Wholesale $</th>
      <th class="st num">Cost / jar $</th><th class="st num">Reorder at (jars)</th><th class="st num">Lead time (days)</th><th class="st num">Safety (days)</th>
      <th class="st" style="text-align:center">Qualifying food</th><th class="st" style="text-align:center">Co-branded</th><th class="st num">Scholarship %</th><th class="st"></th></tr></thead>
      <tbody>${D.products.map(p => prodRow(p.code, T.prod[p.code], false)).join("")}
      <tr><td colspan="12" style="padding:8px 12px;background:#faf7f3;font-size:12px;font-weight:600;color:#7d746b">Add a product</td></tr>
      ${prodRow("__new", T.newProd, true)}</tbody></table></div>`;
  const prodCard = card("prod", "Products",
    `Prices, cost per jar, reorder level and planning days for each product. <strong>Qualifying food</strong> products are taxed at the
     home state's food rate; <strong>co-branded</strong> products pay the scholarship % of the money received to ${esc(licensor())}.
     Changes apply to new sales and batches — past sales keep what they were recorded with.`,
    dlBtn("products", "the product settings"), prodTable);

  // ---- channels ---------------------------------------------------------------
  const basisSel = (key, val) => `<select ${at("ch", key, "price_basis")} class="si" style="min-width:140px">${PRICE_BASIS.map(([v, l]) =>
      `<option value="${v}" ${val === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const chRow = (key, d, isNew) => `<tr>
      <td class="st" style="min-width:170px;padding-left:12px">${tin("ch", key, "name", d.name, "si", `maxlength="20" placeholder="${isNew ? "New channel name" : ""}" aria-label="channel name"`)}</td>
      <td class="st">${basisSel(key, d.price_basis)}</td>
      <td class="st" style="text-align:center">${cbx("ch", key, "is_taxable", d.is_taxable)}</td>
      <td class="st" style="text-align:center">${cbx("ch", key, "ships_orders", d.ships_orders)}</td>
      <td class="st">${nin("ch", key, "fee_pct", d.fee_pct)}</td>
      <td class="st">${nin("ch", key, "fee_fixed", d.fee_fixed)}</td>
      <td class="st" style="color:#7d746b;font-size:12px;min-width:150px">${!isNew && d.name === CFG("market_channel") ? "Market channel — fee typed on the market form" : ""}</td>
      <td class="st" style="padding-right:12px">${saveBtn("ch", key, isNew ? "+ Add" : "Save")}</td></tr>`;
  const chTable = `<div class="tw"><table style="min-width:960px"><thead><tr>
      <th class="st" style="padding-left:12px">Channel</th><th class="st">Default price</th><th class="st" style="text-align:center">Sales tax</th>
      <th class="st" style="text-align:center">Ships orders</th><th class="st num">Card fee %</th><th class="st num">Fixed fee $</th><th class="st" style="width:28%"></th><th class="st"></th></tr></thead>
      <tbody>${D.channels.map(c => chRow(c.id, T.ch[c.id], false)).join("")}
      <tr><td colspan="8" style="padding:8px 12px;background:#faf7f3;font-size:12px;font-weight:600;color:#7d746b">Add a channel</td></tr>
      ${chRow("__new", T.newCh, true)}</tbody></table></div>`;
  const chCard = card("ch", "Sales channels",
    `<strong>Default price</strong> is the product price the sale form fills in. <strong>Ships orders</strong> adds the shipping fields.
     A <strong>card fee</strong> (percent of items + shipping + tax, plus a fixed amount) is charged automatically; leave both at 0 when
     the owner types the actual fee instead.`,
    dlBtn("channel_setup", "the sales channel settings"), chTable);

  // ---- business settings -------------------------------------------------------
  const v = T.biz.values, home = v.home_state || "";
  const fieldBox = (label, help, control, wide) => `<label class="fld" style="${wide ? "grid-column:1/-1" : ""}">
      <span style="font-weight:600">${label}</span>${control}<span style="font-size:12px;color:#8f867c;line-height:1.45">${help}</span></label>`;
  const sel = (f, opts, val) => `<select ${at("biz", "all", f)} class="in">${opts.map(([o, l]) =>
      `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const rows = [...(D.setting_rows || [])].sort((a, b) => (/_url$/.test(a.key) - /_url$/.test(b.key)) || a.key.localeCompare(b.key));
  const fields = rows.map(r => {
    const f = r.key, val = v[f] ?? "";
    let control;
    if (f === "home_state") control = sel(f, D.tax_states.map(s => [s, s]), val);
    else if (f === "default_county") control = sel(f, countiesOf(home).filter(c => c.status !== "State only")
        .map(c => [c.code, `${cty(c.county)} (${c.code})`]), val);
    else if (f === "market_channel") control = sel(f, D.channels.map(c => [c.name, c.name]), val);
    else control = `<input ${at("biz", "all", f)} class="in" value="${esc(val)}" ${f === "demand_window_days" ? 'inputmode="numeric"' : ""}>`;
    return fieldBox(esc(humanKey(f)), esc(r.description), control, /_url$/.test(f));
  }).join("");
  const foodField = fieldBox(`Qualifying-food tax rate — ${esc(home)} (%)`,
    `Charged on qualifying-food products (plus shipping) in every ${esc(home)} county. Other states are not collected.`,
    `<input ${at("biz", "all", "food_rate_pct")} class="in" inputmode="decimal" value="${esc(T.biz.food_rate_pct)}">`, false);
  const bizCard = card("biz", "Business settings",
    `Business-wide values the app reads instead of hard-coding them. Changing the home state moves sales-tax collection to that state;
     after that, check its general rates on the Tax rates tab.`,
    dlBtn("settings", "the business settings"),
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:18px 20px">${foodField}${fields}</div>
     <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">${saveBtn("biz", "all", "Save business settings")}
       <button id="biz-reset" style="background:transparent;border:0;padding:4px;font:500 13px 'IBM Plex Sans',sans-serif;color:#7a1f1f;cursor:pointer;text-decoration:underline">Discard unsaved changes</button></div>`);

  return `<div style="display:flex;flex-direction:column;gap:20px">${prodCard}${chCard}${bizCard}</div>`;
}

// after a settings save: forms elsewhere pick up the new values (prices, channel, home state)
function afterSettingsSaved(kind){
  if (!channelByName(S.sale.channel)) S.sale.channel = (D.channels[0] || {}).name || null;
  setChannelPrices();
  if (kind === "biz") {
    S.sale.state = HOME(); S.sale.county = defaultCounty(HOME());
    S.taxState = HOME(); S.taxCounties = null; S.taxPlan = null;
  }
  if (!productByCode(S.inv.product).code) { S.inv.product = (D.products[0] || {}).code; S.inv.code = suggestBatch(S.inv.product); }
}

function bindSettings(){
  const T = S.set;
  const mark = (kind, key) => {
    const b = root.querySelector(`[data-save="${kind}"][data-key="${CSS.escape(String(key))}"]`);
    if (b) b.classList.toggle("dirty", isDirty(kind, key));
  };
  root.querySelectorAll("[data-kind]").forEach(el => {
    const live = el.type === "checkbox" || el.tagName === "SELECT" ? "onchange" : "oninput";
    el[live] = () => {
      const { kind, key, f } = el.dataset, val = el.type === "checkbox" ? el.checked : el.value;
      if (kind === "prod") (key === "__new" ? T.newProd : T.prod[key])[f] = f === "code" ? val.toUpperCase() : val;
      else if (kind === "ch") (key === "__new" ? T.newCh : T.ch[key])[f] = val;
      else if (f === "food_rate_pct") T.biz.food_rate_pct = val;
      else {
        T.biz.values[f] = val;
        if (f === "home_state") {                      // county list follows the chosen state
          const list = countiesOf(val).filter(c => c.status !== "State only");
          if (!list.some(c => c.code === T.biz.values.default_county)) T.biz.values.default_county = (list[0] || {}).code || "";
          render(); return;
        }
      }
      mark(kind, key);
    };
  });
  root.querySelectorAll("[data-save]").forEach(b => b.onclick = async () => {
    const { save: kind, key } = b.dataset;
    let path, body;
    if (kind === "prod") { path = "/api/settings/product"; body = key === "__new" ? { ...T.newProd, new: true } : { ...T.prod[key] }; }
    else if (kind === "ch") { path = "/api/settings/channel"; body = key === "__new" ? { ...T.newCh, id: null } : { ...T.ch[key] }; }
    else { path = "/api/settings/business"; body = { values: T.biz.values, food_rate_pct: T.biz.food_rate_pct }; }
    T.saving = kind + key; T.msg = null;
    const j = await post(path, body);
    T.saving = null;
    if (S.notice) { T.msg = { kind, ok: S.notice.ok, text: S.notice.text }; S.notice = null; }
    if (j && j.ok) {                                   // re-read this row from the database
      if (kind === "prod") { if (key === "__new") T.newProd = null; else delete T.prod[key]; }
      else if (kind === "ch") { if (key === "__new") T.newCh = null; else delete T.ch[key]; }
      else T.biz = null;
      afterSettingsSaved(kind);
    }
    render();
  });
  const rs = root.querySelector("#biz-reset"); if (rs) rs.onclick = () => { T.biz = null; T.msg = null; render(); };
  root.querySelectorAll("[data-msgclose]").forEach(b => b.onclick = () => { T.msg = null; render(); });
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (D && S.page === "overview") render(); }, 200);
});

boot();
})();

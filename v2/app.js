// anyplans : helper condivisi per le pagine /v2 (sessione, rpc, catalogo, date)
const SB_URL = "https://uudccbzihhgoeaevkewr.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1ZGNjYnppaGhnb2VhZXZrZXdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzk0NzEsImV4cCI6MjEwMTk1NTQ3MX0.OHJC3vmT8eRLczFkH0QdZybbjudDfSi4VEX8Mc22ABQ";
// google places (new) per il punto di ritrovo: chiave pubblica limitata al referrer anyplans.in.
// vuota = si usa photon (openstreetmap). TODO Filippo: incollare qui la chiave creata su console.cloud.google.com
const GOOGLE_MAPS_KEY = "AIzaSyDyIS3owtm8TQamqAN9wMKsJz-0Qg9UjqA";

let session = null;
try { session = JSON.parse(localStorage.getItem("anyplans_session")); } catch (_) {}
if (!session) { try { session = JSON.parse(sessionStorage.getItem("anyplans_session")); } catch (_) {} }

function saveSession(s){
  session = s;
  try { localStorage.setItem("anyplans_session", JSON.stringify(s)); } catch (_) {
    try { sessionStorage.setItem("anyplans_session", JSON.stringify(s)); } catch (_) {}
  }
}
function logout(){
  try { localStorage.removeItem("anyplans_session"); } catch (_) {}
  try { sessionStorage.removeItem("anyplans_session"); } catch (_) {}
  location.href = "login.html";
}
function requireLogin(){
  if (!session || !session.access_token) {
    try { sessionStorage.setItem("anyplans_next", location.pathname + location.search); } catch (_) {}
    location.replace("login.html");
  }
}
function myUid(){
  try { return JSON.parse(atob(session.access_token.split(".")[1])).sub; } catch (_) { return null; }
}

async function refreshSession(){
  try {
    const r = await fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: {"apikey": SB_ANON, "Content-Type": "application/json"},
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!r.ok) return false;
    const b = await r.json();
    saveSession({ ...session, access_token: b.access_token, refresh_token: b.refresh_token });
    return true;
  } catch (_) { return false; }
}

// escape per tutto ciò che viene dal backend o da terzi e finisce in innerHTML
function esc(t){
  return String(t ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// rpc autenticata se c'è la sessione, altrimenti anonima; null se la rete fallisce
async function rpc(name, body, retry = true){
  let r;
  try {
    r = await fetch(SB_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {"apikey": SB_ANON, "Content-Type": "application/json", "Authorization": "Bearer " + ((session && session.access_token) || SB_ANON)},
      body: JSON.stringify(body || {})
    });
  } catch (_) { return null; }
  if (r.status === 401 && retry && session && session.refresh_token) {
    if (await refreshSession()) return rpc(name, body, false);
    logout(); return null;
  }
  return r;
}

function toast(msg){
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div"); t.id = "toast";
    t.style.cssText = "position:fixed; left:50%; bottom:26px; transform:translateX(-50%);" +
      "background:#191919; color:#fff; font-size:14px; font-weight:600; padding:12px 18px;" +
      "border-radius:999px; z-index:99; max-width:86vw; text-align:center;";
    document.body.appendChild(t);
  }
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 4500);
}

// catalogo sport/attività (docs/UI.md §1) : slug -> {emoji, label it, cat sito}
const CATALOG = {
  running:   { e:"🏃", l:"corsa",                     c:"sport" },
  trail:     { e:"⛰️", l:"corsa in montagna",             c:"sport" },
  hyrox:     { e:"🏋️", l:"Hyrox (gara in palestra)",                     c:"sport" },
  walking:   { e:"🚶", l:"camminata",                 c:"sport" },
  cycling:   { e:"🚴", l:"bici da strada",            c:"sport" },
  mtb:       { e:"🚵", l:"mountain bike",              c:"sport" },
  moto:      { e:"🏍️", l:"moto",                      c:"sport" },
  hiking:    { e:"🥾", l:"escursionismo",             c:"sport" },
  climbing:  { e:"🧗", l:"arrampicata",               c:"sport" },
  skitouring:{ e:"🎿", l:"scialpinismo",              c:"sport" },
  gym:       { e:"💪", l:"palestra",       c:"sport" },
  yoga:      { e:"🧘", l:"yoga / pilates",            c:"benessere" },
  football:  { e:"⚽", l:"calcio",                    c:"sport" },
  basketball:{ e:"🏀", l:"basket",                    c:"sport" },
  volleyball:{ e:"🏐", l:"volley",                    c:"sport" },
  tennis:    { e:"🎾", l:"tennis",                    c:"sport" },
  padel:     { e:"🏸", l:"padel",                     c:"sport" },
  swimming:  { e:"🏊", l:"nuoto",                     c:"sport" },
  surf:      { e:"🏄", l:"surf / sup",                c:"sport" },
  paddling:  { e:"🚣", l:"canoa / kayak",             c:"sport" },
  skiing:    { e:"⛷️", l:"sci",                       c:"sport" },
  snowboard: { e:"🏂", l:"snowboard",                 c:"sport" },
  skating:   { e:"⛸️", l:"pattinaggio",               c:"sport" },
  ceramics:  { e:"🏺", l:"ceramica",                  c:"creatività" },
  cooking:   { e:"🍳", l:"cucina",                    c:"cucina" },
  dinner:    { e:"🍽️", l:"cena / aperitivo",          c:"cucina" },
  painting:  { e:"🎨", l:"pittura / arte",            c:"creatività" },
  gardening: { e:"🌱", l:"giardinaggio / volontariato", c:"giardinaggio" },
  festival:  { e:"🎪", l:"feste, sagre ed eventi di paese",     c:"cultura" }
};

// date in italiano
const DAYS = ["domenica","lunedì","martedì","mercoledì","giovedì","venerdì","sabato"];
const MONTHS = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
function timeStr(d){ return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); }
function dayKey(d){ return d.toDateString(); }
// città e luoghi salvati in minuscolo si mostrano con le maiuscole ("bergamo" → "Bergamo", "città alta" → "Città Alta")
function cityCase(t){
  const small = new Set(["di","del","della","dei","delle","da","in","a","al","alla","e","sul","sulla","con","per"]);
  return String(t || "").split(/(\s+|-|')/).map((w, i) => (!w || /^\s+$|^[-']$/.test(w)) ? w : (i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1))).join("");
}
function goingTxt(n){ n = Number(n) || 0; return n === 0 ? "nessuno ancora" : n === 1 ? "1 ci va" : n + " ci vanno"; }
// prezzo: null/0 = gratis; "12 €" oppure "12,50 €" (spazio non separabile)
function fmtPrice(c){ if (c == null || c <= 0) return "gratis";
  const e = Math.floor(c / 100), r = c % 100;
  return (r ? e + "," + String(r).padStart(2, "0") : e) + "\u00a0€"; }
function fmtAmount(c){ return fmtPrice(c).replace("\u00a0€", ""); }
function parsePrice(s){ const t = String(s).trim().replace(/[\s€]/g, "").replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return NaN; return Math.round(parseFloat(t) * 100); }
function dayLabel(d){
  const today = new Date(); const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  if (dayKey(d) === dayKey(today)) return "oggi";
  if (dayKey(d) === dayKey(tomorrow)) return "domani";
  return DAYS[d.getDay()] + " " + d.getDate();
}
function daySub(d){ return DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; }
// "tra 2h", "tra 3 giorni": quanto manca, a colpo d'occhio
function relTime(d){
  const ms = d - Date.now(), min = Math.round(ms / 60000);
  if (min < -180) return "già passato";
  if (min <= 0) return "in corso";
  if (min < 60) return "tra " + min + " minuti";
  const h = Math.round(min / 60);
  if (h < 24) return "tra " + h + (h === 1 ? " ora" : " ore");
  const days = Math.round(h / 24);
  return "tra " + days + (days === 1 ? " giorno" : " giorni");
}

// analytics first-party (supabase/migrations/0046): nessun cookie, nessun dato personale
function track(name, path){
  if (location.protocol === "file:") return;
  let ref = "";
  try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch (_) {}
  if (ref === location.hostname) ref = "";
  try {
    fetch(SB_URL + "/rest/v1/rpc/log_site_event", {
      method: "POST", keepalive: true,
      headers: {"apikey": SB_ANON, "Content-Type": "application/json"},
      body: JSON.stringify({ p_name: name, p_path: path || location.pathname, p_ref: ref || null, p_city: "bergamo" })
    }).catch(() => {});
  } catch (_) {}
}
track("page_view");


// menu unico in alto per le pagine da loggato: eventi · i miei eventi · gruppi · crea evento · avvisi · profilo
function mountNav(active, opts){
  opts = opts || {};
  const st = document.createElement("style");
  st.textContent = `
    header.sn{padding:0 22px;}
    .sn .nav{display:flex; align-items:center; gap:22px; height:62px; max-width:${opts.wide ? "none" : "1000px"}; margin:0 auto;}
    .sn .brand{display:flex; align-items:center; gap:9px; font-family:"Bricolage Grotesque", ui-rounded, system-ui, sans-serif; font-weight:800;
               font-size:20px; letter-spacing:-.045em; line-height:1; color:#191919; text-decoration:none;}
    .sn .brand img{width:28px; height:28px; display:block;}
    .sn .lnk{font-weight:600; font-size:15px; color:#6E6E73; text-decoration:none;}
    .sn .lnk.on{font-weight:700; color:#1B4FD8;}
    .sn .right{margin-left:auto; display:flex; align-items:center; gap:12px;}
    .sn .cta{background:#1B4FD8; color:#fff; font-weight:700; font-size:13.5px; padding:9px 16px; border-radius:999px; white-space:nowrap; text-decoration:none;}
    .sn .ib{width:36px; height:36px; border-radius:999px; background:#E9EEFB; border:none; cursor:pointer; display:flex; align-items:center;
            justify-content:center; font-weight:800; font-size:14px; color:#1B4FD8; font-family:inherit; position:relative; text-decoration:none;
            background-size:cover; background-position:center;}
    .sn #bell-dot{position:absolute; top:6px; right:6px; width:8px; height:8px; border-radius:999px; background:#1B4FD8; display:none;}
    .sn #menu{position:absolute; right:0; top:44px; background:#fff; border:1.5px solid rgba(25,25,25,.14); border-radius:14px; padding:8px;
              min-width:220px; box-shadow:0 8px 24px rgba(0,0,0,.1); z-index:50;}
    .sn #menu a, .sn #menu button{display:block; width:100%; text-align:left; background:none; border:none; cursor:pointer; padding:10px 12px;
              border-radius:9px; font-family:inherit; font-weight:600; font-size:14px; color:#191919; text-decoration:none;}
    .sn #menu a:hover, .sn #menu button:hover{background:#E9EEFB;}
    @media (max-width:700px){ .sn .lnk, .sn .cta{display:none;} header.sn{padding:0 18px;} }`;
  document.head.appendChild(st);
  const links = [["eventi","eventi.html"],["i miei eventi","miei.html"],["gruppi","gruppi.html"]];
  const initial = ((session && session.email) || "?")[0].toLowerCase();
  const h = document.createElement("header"); h.className = "sn";
  h.innerHTML = `<div class="nav">
    <a class="brand" href="/v2/eventi.html"><img src="/logo.png" alt=""><span>anyplans<span style="font-size:.92em">?</span></span></a>
    ${links.map(([l, href]) => `<a class="lnk${l === active ? " on" : ""}" href="${href}">${l}</a>`).join("")}
    <div class="right">
      <a class="cta" href="crea.html">crea evento</a>
      <a class="ib" id="bell" href="notifiche.html" title="avvisi" aria-label="avvisi">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#1B4FD8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10 C 6 6.7, 8.7 4, 12 4 C 15.3 4, 18 6.7, 18 10 L18 15 L20 17.5 L4 17.5 L6 15 Z"/><path d="M10 20.5 C 10.5 21.3, 13.5 21.3, 14 20.5"/></svg>
        <span id="bell-dot"></span>
      </a>
      <div style="position:relative">
        <button class="ib" id="avatar" title="il tuo profilo" aria-label="il tuo profilo">${esc(initial)}</button>
        <div id="menu" hidden>
          <div style="padding:9px 12px; border-bottom:1px solid rgba(25,25,25,.08); margin-bottom:4px">
            <div id="menu-name" style="font-weight:700; font-size:14px"></div>
            <div id="menu-email" style="font-size:12px; color:#6E6E73; overflow:hidden; text-overflow:ellipsis">${esc((session && session.email) || "")}</div>
          </div>
          <a href="profilo.html">il mio profilo</a>
          <a href="miei.html">i miei eventi</a>
          <a href="gruppi.html">gruppi</a>
          <a href="notifiche.html">avvisi</a>
          <a href="impostazioni.html">impostazioni</a>
          <button onclick="if(confirm('vuoi uscire?')) logout()">esci</button>
        </div>
      </div>
    </div></div>`;
  const old = document.querySelector("body > header");
  if (old) old.replaceWith(h); else document.body.prepend(h);
  // griglia unica (design/sito-landing/spec-griglia.md): menu a tutta larghezza, foglio centrato sotto
  const grid = document.createElement("style");
  grid.textContent = `
    :root{ --nav-h:64px; --pad-x:32px; --gap-title:16px; --h1:36px; --h1-hero:44px; --col-form:760px; --col-list:860px; --col-detail:1000px; --card:480px; --pad-bottom:72px; }
    @media (max-width:700px){ :root{ --nav-h:60px; --pad-x:18px; --gap-title:8px; --h1:28px; --h1-hero:28px; --pad-bottom:96px; } }
    header.sn{padding:0 var(--pad-x);}
    .sn .nav{height:var(--nav-h); max-width:none;}
    ${opts.col ? `main{width:100%; max-width:calc(${opts.col}px + 2*var(--pad-x)); margin:0 auto; padding:var(--gap-title) var(--pad-x) var(--pad-bottom);}
    main h1{font-size:${opts.hero ? "var(--h1-hero)" : "var(--h1)"};}` : `
    .topbar{padding:8px var(--pad-x) 16px;} .list{padding-left:var(--pad-x);}
    @media (max-width:700px){ .topbar{padding:4px var(--pad-x) 10px;} .list{padding:12px var(--pad-x) 96px;} }`}
    ${opts.card ? `main .card, main #view{max-width:var(--card);}` : ""}`;
  document.head.appendChild(grid);
  document.getElementById("avatar").onclick = (e) => { e.stopPropagation(); const m = document.getElementById("menu"); m.hidden = !m.hidden; };
  document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) { const m = document.getElementById("menu"); if (m) m.hidden = true; } });
  // nome e foto dal profilo, pallino avvisi: in silenzio se falliscono
  rpc("my_profile").then(async r => {
    if (!r || !r.ok) return;
    const me = (await r.json().catch(() => []))[0];
    if (!me) return;
    if (me.display_name) { document.getElementById("menu-name").textContent = me.display_name; document.getElementById("avatar").textContent = me.display_name[0].toLowerCase(); }
    if (me.avatar_url) { const av = document.getElementById("avatar"); av.style.backgroundImage = "url('" + me.avatar_url.replace(/'/g, "") + "')"; av.textContent = ""; }
  }).catch(() => {});
  rpc("unread_notifications").then(async r => {
    if (!r || !r.ok) return;
    const n = await r.json().catch(() => 0);
    if (Number(n) > 0) document.getElementById("bell-dot").style.display = "block";
  }).catch(() => {});
}

// tab bar mobile (scopri · crea · i miei eventi · profilo), solo sotto i 700px
function mountTabbar(active){
  const tabs = [
    ["eventi",  "eventi.html",        '<svg viewBox="0 0 24 24"><path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/></svg>'],
    ["crea",    "crea.html",          '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'],
    ["i miei eventi", "miei.html",          '<svg viewBox="0 0 24 24"><path d="M5 5.5h14v15l-7-4-7 4z"/></svg>'],
    ["profilo", "profilo.html",'<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/></svg>']
  ];
  const st = document.createElement("style");
  st.textContent = `
    #tabbar{display:none;}
    @media (max-width:700px){
      body{padding-bottom:calc(66px + env(safe-area-inset-bottom));}
      #tabbar{display:flex; position:fixed; left:0; right:0; bottom:0; z-index:45; background:#fff;
        border-top:1.5px solid rgba(25,25,25,.10); padding:6px 4px calc(6px + env(safe-area-inset-bottom));}
      #tabbar a{flex:1; display:flex; flex-direction:column; align-items:center; gap:3px;
        font-weight:700; font-size:10.5px; color:#6E6E73; text-decoration:none; padding:4px 0;}
      #tabbar a svg{width:24px; height:24px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round;}
      #tabbar a.on{color:#1B4FD8;}
      #tabbar a.crea svg{width:40px; height:40px; background:#1B4FD8; color:#fff; border-radius:999px; padding:9px; margin-top:-16px; box-shadow:0 4px 12px rgba(27,79,216,.35);}
      #tabbar a.crea{color:#1B4FD8;}
    }`;
  document.head.appendChild(st);
  const bar = document.createElement("nav"); bar.id = "tabbar";
  bar.innerHTML = tabs.map(([l, h, i]) =>
    `<a href="${h}" class="${l === "crea" ? "crea" : ""}${l === active ? " on" : ""}">${i}<span>${l}</span></a>`).join("");
  document.body.appendChild(bar);
}

// url carini: anyplans.in/bergamo/nome-evento
function slugify(t){
  return t.toLowerCase()
    .replace(/[àáâä]/g,"a").replace(/[èéêë]/g,"e").replace(/[ìíîï]/g,"i")
    .replace(/[òóôö]/g,"o").replace(/[ùúûü]/g,"u").replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"").slice(0, 60);
}
function eventUrl(ev, city){
  const s = slugify(ev.title);
  if (ev.visibility === "private") return location.origin + "/v2/evento.html?id=" + ev.id;
  return s ? location.origin + "/" + (city || "bergamo") + "/" + s
           : location.origin + "/v2/evento.html?id=" + ev.id;
}

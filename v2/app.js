// anyplans — helper condivisi per le pagine /v2 (sessione, rpc, catalogo, date)
const SB_URL = "https://uudccbzihhgoeaevkewr.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1ZGNjYnppaGhnb2VhZXZrZXdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzk0NzEsImV4cCI6MjEwMTk1NTQ3MX0.OHJC3vmT8eRLczFkH0QdZybbjudDfSi4VEX8Mc22ABQ";
// google places (new) per il punto di ritrovo: chiave pubblica limitata al referrer anyplans.in.
// vuota = si usa photon (openstreetmap). TODO Filippo: incollare qui la chiave creata su console.cloud.google.com
const GOOGLE_MAPS_KEY = "";

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

// catalogo sport/attività (docs/UI.md §1) — slug -> {emoji, label it, cat sito}
const CATALOG = {
  running:   { e:"🏃", l:"corsa",                     c:"sport" },
  trail:     { e:"⛰️", l:"trail running",             c:"sport" },
  hyrox:     { e:"🏋️", l:"hyrox",                     c:"sport" },
  walking:   { e:"🚶", l:"camminata",                 c:"sport" },
  cycling:   { e:"🚴", l:"bici da strada",            c:"sport" },
  mtb:       { e:"🚵", l:"mtb / gravel",              c:"sport" },
  moto:      { e:"🏍️", l:"moto",                      c:"sport" },
  hiking:    { e:"🥾", l:"escursionismo",             c:"sport" },
  climbing:  { e:"🧗", l:"arrampicata",               c:"sport" },
  skitouring:{ e:"🎿", l:"scialpinismo",              c:"sport" },
  gym:       { e:"💪", l:"palestra / crossfit",       c:"sport" },
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
  painting:  { e:"🎨", l:"pittura / arte",            c:"creatività" },
  gardening: { e:"🌱", l:"giardinaggio / volontariato", c:"giardinaggio" },
  festival:  { e:"🎪", l:"feste & eventi locali",     c:"cultura" }
};

// date in italiano
const DAYS = ["domenica","lunedì","martedì","mercoledì","giovedì","venerdì","sabato"];
const MONTHS = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];
function timeStr(d){ return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0"); }
function dayKey(d){ return d.toDateString(); }
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
  if (min < -180) return "passato";
  if (min <= 0) return "in corso";
  if (min < 60) return "tra " + min + " min";
  const h = Math.round(min / 60);
  if (h < 24) return "tra " + h + "h";
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

// tab bar mobile (scopri · crea · i miei eventi · profilo), solo sotto i 700px
function mountTabbar(active){
  const tabs = [
    ["scopri",  "eventi.html",        '<svg viewBox="0 0 24 24"><path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/></svg>'],
    ["crea",    "crea.html",          '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'],
    ["miei eventi", "miei.html",          '<svg viewBox="0 0 24 24"><path d="M5 5.5h14v15l-7-4-7 4z"/></svg>'],
    ["profilo", "profilo.html?edit=1",'<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/></svg>']
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
  return s ? location.origin + "/" + (city || "bergamo") + "/" + s
           : location.origin + "/v2/evento.html?id=" + ev.id;
}

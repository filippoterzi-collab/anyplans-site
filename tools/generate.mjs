#!/usr/bin/env node
// anyplans SEO: static public pages for Google (design/sito-landing/plan-seo.md).
// Node 20, no dependencies. Reads Supabase with the anon key and writes into --out:
//   /bergamo/<slug>/index.html            one page per event slug (all dates of a multi-day festa)
//   /bergamo/gruppi/index.html            public list of groups
//   /bergamo/gruppi/<slug>/index.html     one page per group
//   /bergamo/<tipo>/ and /bergamo/<paese>/ flat indexes (>= MIN_INDEX events)
//   /bergamo/cosa-fare/index.html         hub
//   /sitemap.xml, /robots.txt
// Usage: node generate.mjs --out <dir> [--fixture <rows.json>] [--groups <groups.json>]
// Env: SUPABASE_URL, SUPABASE_ANON_KEY.
// Every subdirectory of <out>/bergamo/ is removed and regenerated: it must contain only generated pages.

import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = "https://anyplans.in";
const CITY = "bergamo";
const CITY_NAME = "Bergamo";
const DEFAULT_TZ = "Europe/Rome";
const PAST_DAYS = 400;          // pages live ~13 months after the last date
const INDEX_WINDOW_DAYS = 365;  // indexes count future + past within 12 months
const MIN_INDEX = 3;            // minimum events for an index page
const OG_DEFAULT = SITE + "/og.png";
const NOW = new Date();

// ── args & env ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT = arg("--out");
if (!OUT) { console.error("uso: node generate.mjs --out <cartella> [--fixture rows.json] [--groups groups.json]"); process.exit(2); }
const FIXTURE = arg("--fixture");
const GROUPS_FIXTURE = arg("--groups");
const SB_URL = process.env.SUPABASE_URL;
const SB_ANON = process.env.SUPABASE_ANON_KEY;

const TESTI = JSON.parse(await readFile(path.join(HERE, "testi.json"), "utf8"));
const TIPI = TESTI.tipi;
const RESERVED = new Set((await readFile(path.join(HERE, "riservati.txt"), "utf8"))
  .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")));

// ── helpers ───────────────────────────────────────────────────────────────────
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// same as slugify() in bergamo/app.js: shared links /bergamo/<slug> must match
function slugify(t) {
  return String(t ?? "").toLowerCase()
    .replace(/[àáâä]/g, "a").replace(/[èéêë]/g, "e").replace(/[ìíîï]/g, "i")
    .replace(/[òóôö]/g, "o").replace(/[ùúûü]/g, "u").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 60);
}
const norm = (t) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const cut = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…"; };
const dateKey = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); // YYYY-MM-DD
const fmtLong = (d, tz) => cap(new Intl.DateTimeFormat("it-IT", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d));
const fmtShort = (d, tz) => new Intl.DateTimeFormat("it-IT", { timeZone: tz, day: "numeric", month: "long" }).format(d);
const fmtDay = (d, tz) => cap(new Intl.DateTimeFormat("it-IT", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d));
const fmtTime = (d, tz) => new Intl.DateTimeFormat("it-IT", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
function isoLocal(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).formatToParts(d).map(x => [x.type, x.value]));
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
function fmtPrice(c) {
  if (c == null || c <= 0) return "Gratis";
  const e = Math.floor(c / 100), r = c % 100;
  return (r ? e + "," + String(r).padStart(2, "0") : e) + "\u00a0€";
}
function photoSrc(url) {
  if (!url) return null;
  // Supabase image transformation (checked: available on this project), 800px wide
  const m = String(url).match(/^(https:\/\/[^/]+)\/storage\/v1\/object\/public\/(.+)$/);
  return m ? `${m[1]}/storage/v1/render/image/public/${m[2]}?width=800` : url;
}
function mapsUrl(lat, lng, label) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lng)}`;
}
const tipo = (sport) => TIPI[sport] || { key: slugify(sport), e: "📍", label: cap(sport || "Evento"), c: "altro", frase: "" };
const jsonld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;

// ── data ──────────────────────────────────────────────────────────────────────
async function rpc(name, body) {
  if (!SB_URL || !SB_ANON) throw new Error("mancano SUPABASE_URL / SUPABASE_ANON_KEY");
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) throw new Error(`rpc ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// the RPC (migration 0061) takes no parameters and returns future + recent past rows: the 13-month window is applied here
const rawRows = FIXTURE ? JSON.parse(await readFile(FIXTURE, "utf8")) : await rpc("public_activities_for_seo", {});
const rawGroups = GROUPS_FIXTURE ? JSON.parse(await readFile(GROUPS_FIXTURE, "utf8")) : await rpc("list_communities", { p_city: CITY });
// ritrovi fissi dei gruppi (migrazione 0070): "ogni mercoledì alle 18:45 al parco della Trucca"
const SCHEDULES_FIXTURE = arg("--schedules");
const rawSchedules = SCHEDULES_FIXTURE ? JSON.parse(await readFile(SCHEDULES_FIXTURE, "utf8")) : await rpc("list_community_schedules", { p_city: CITY }).catch(() => []);
const schedules = Array.isArray(rawSchedules) ? rawSchedules : [];
if (!Array.isArray(rawRows) || rawRows.length === 0) { console.error("nessun evento dalla RPC: non tocco niente"); process.exit(1); }

// normalize rows; only the public columns of the contract are used
const rows = rawRows.map(r => {
  const tz = r.timezone || DEFAULT_TZ;
  const start = new Date(r.start_at);
  const end = r.end_at ? new Date(r.end_at) : null;
  const isFest = r.sport === "festival";
  const t = tipo(r.sport);
  return {
    id: r.id, title: String(r.title || "").trim(), description: String(r.description || "").trim(),
    sport: r.sport, emoji: r.emoji || t.e, tipo: t, tz, start, end,
    // an event is "upcoming" until it ends (end, or 3 hours after start)
    future: (end || new Date(start.getTime() + 3 * 3600e3)) >= NOW,
    meeting: r.visibility === "request" ? null : (r.meeting_point_text || null),
    lat: r.visibility === "request" ? null : r.lat, lng: r.visibility === "request" ? null : r.lng,
    price_cents: r.price_cents, price_note: r.price_note, photo: r.photo_url || null,
    club: r.club_name || null, town: isFest && r.club_name ? String(r.club_name).trim() : null,
    community_slug: r.community_slug || null, community_name: r.community_name || null,
    community_avatar: r.community_avatar_url || null,
    co: Array.isArray(r.co_communities) ? r.co_communities : [],
    source_url: r.source_url || null, source: r.source, visibility: r.visibility,
    updated: r.updated_at ? new Date(r.updated_at) : start
  };
}).filter(r => r.title && !isNaN(r.start) && r.visibility !== "private"
             && r.start >= new Date(NOW.getTime() - PAST_DAYS * 86400e3));

const groups = (Array.isArray(rawGroups) ? rawGroups : []).filter(g => g.slug && g.name);

// ── group rows into pages: one page per slug (same title + same club = same event, all dates) ─
const bySlug = new Map();
for (const r of rows) {
  const s = slugify(r.title);
  if (!s) continue; // the app links these with ?id=: no static page
  const key = norm(r.title) + "|" + norm(r.club);
  if (!bySlug.has(s)) bySlug.set(s, new Map());
  const sub = bySlug.get(s);
  if (!sub.has(key)) sub.set(key, []);
  sub.get(key).push(r);
}
function makePage(rowsOfEvent) {
  const dates = rowsOfEvent.slice().sort((a, b) => a.start - b.start);
  const up = dates.filter(d => d.future), past = dates.filter(d => !d.future);
  const main = up[0] || dates[dates.length - 1];   // nearest upcoming, else the most recent past
  return { ...main, dates, up, past, isPast: up.length === 0,
           anchor: up[0] ? up[0].start : dates[dates.length - 1].start,
           updated: new Date(Math.max(...dates.map(d => d.updated))) };
}
let pages = [];
for (const [s, sub] of bySlug) {
  // nearest event keeps the base slug (upcoming first, then the most recent past), the others get the date suffix
  const list = [...sub.values()].map(makePage).sort((a, b) =>
    a.isPast !== b.isPast ? (a.isPast ? 1 : -1) : a.isPast ? b.anchor - a.anchor : a.anchor - b.anchor);
  list.forEach((p, i) => { p.slug = i === 0 ? s : s + "-" + dateKey(p.anchor, p.tz); });
  pages.push(...list);
}
// poor past UGC pages are not worth a page
pages = pages.filter(p => !(p.isPast && p.source === "ugc" && !p.photo && p.description.length < 80));

// ── indexes (types and towns), threshold on distinct events in the 12-month window ─
const windowStart = new Date(NOW.getTime() - INDEX_WINDOW_DAYS * 86400e3);
const inWindow = (p) => p.dates.some(d => d.start >= windowStart);
const typeIdx = new Map();  // sport -> pages
const townIdx = new Map();  // town name -> pages
for (const p of pages) {
  if (!inWindow(p)) continue;
  if (!typeIdx.has(p.sport)) typeIdx.set(p.sport, []);
  typeIdx.get(p.sport).push(p);
  if (p.town) { if (!townIdx.has(p.town)) townIdx.set(p.town, []); townIdx.get(p.town).push(p); }
}
const types = [...typeIdx].filter(([, l]) => l.length >= MIN_INDEX)
  .map(([sport, list]) => ({ kind: "tipo", sport, t: tipo(sport), slug: tipo(sport).key, list }));
const towns = [...townIdx].filter(([, l]) => l.length >= MIN_INDEX)
  .map(([town, list]) => ({ kind: "paese", town, slug: slugify(town), list }));
const indexSlugs = new Set();
for (const ix of [...types, ...towns]) {
  if (RESERVED.has(ix.slug)) { console.error(`indice "${ix.slug}" collide con un nome riservato: mi fermo`); process.exit(1); }
  if (indexSlugs.has(ix.slug)) { console.error(`indice "${ix.slug}" duplicato tra tipo e paese: mi fermo`); process.exit(1); }
  indexSlugs.add(ix.slug);
}
// events colliding with a reserved name or an index get the date suffix
const taken = new Set([...RESERVED, ...indexSlugs]);
for (const p of pages) {
  if (taken.has(p.slug)) p.slug = p.slug + "-" + dateKey(p.anchor, p.tz);
  while (taken.has(p.slug)) p.slug += "-2";
  taken.add(p.slug);
}
const eventUrl = (p) => `${SITE}/${CITY}/${p.slug}/`;
const groupUrl = (g) => `${SITE}/${CITY}/gruppi/${g.slug}/`;
const groupBySlug = new Map(groups.map(g => [g.slug, g]));
const byDate = (a, b) => a.anchor - b.anchor;
const upcomingPages = pages.filter(p => !p.isPast).sort(byDate);

// ── shared layout ─────────────────────────────────────────────────────────────
const CSS = `
@font-face{font-family:"Bricolage Grotesque";src:url("/bricolage-grotesque-latin-800-normal.woff2") format("woff2");font-weight:800;font-style:normal;font-display:swap}
:root{--blue:#1B4FD8;--blue-lo:#1440AF;--tint:#E9EEFB;--ink:#191919;--grey:#6E6E73;--bg:#FBF9F5;--round:ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",sans-serif;--display:"Bricolage Grotesque",var(--round)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--round);color:var(--ink);background:var(--bg);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
h1,h2,.brand{font-family:var(--display);font-weight:800;letter-spacing:-.045em;line-height:1.05}
h1{font-size:36px;overflow-wrap:anywhere}h2{font-size:20px}
header{padding:0 22px}
.nav{display:flex;align-items:center;justify-content:space-between;height:64px;max-width:860px;margin:0 auto}
.brand{display:flex;align-items:center;gap:9px;font-size:20px}.brand img{width:28px;height:28px}.q{font-size:.92em}
.btn{display:inline-block;background:var(--blue);color:#fff;font-weight:700;padding:12px 24px;border-radius:999px;font-size:15.5px;text-align:center}
.btn:hover{background:var(--blue-lo)}
.btn.ghost{background:transparent;color:var(--blue);box-shadow:inset 0 0 0 2px var(--blue)}.btn.ghost:hover{background:var(--tint)}
.btn.sm{padding:9px 16px;font-size:13.5px}
.lnk{font-weight:700;color:var(--blue)}
main{max-width:860px;margin:0 auto;padding:16px 22px 70px;display:flex;flex-direction:column;gap:18px}
.crumbs{font-size:13px;color:var(--grey);display:flex;gap:6px;flex-wrap:wrap}.crumbs a:hover{color:var(--ink)}
.cover{width:100%;height:230px;background:var(--tint);border-radius:22px;display:flex;align-items:center;justify-content:center;font-size:96px;overflow:hidden}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{background:var(--tint);color:var(--blue);font-weight:700;font-size:13px;padding:6px 12px;border-radius:999px}
.chip.w{background:#fff;border:1.5px solid rgba(25,25,25,.12);color:var(--ink)}
.chip.past{background:#fff;border:1.5px solid rgba(25,25,25,.12);color:var(--grey)}
.box{background:#fff;border:1.5px solid rgba(25,25,25,.12);border-radius:18px;padding:20px 22px;display:flex;flex-direction:column;gap:12px}
.box.in{background:var(--tint);border:2px solid var(--blue)}
.box .m{font-size:14px;color:var(--grey)}
.when{display:flex;align-items:center;gap:14px}
.datebox{width:48px;border:1.5px solid rgba(25,25,25,.12);border-radius:10px;overflow:hidden;text-align:center;background:#fff;flex-shrink:0}
.datebox .mo{background:var(--blue);color:#fff;font-size:10px;font-weight:700;padding:2px 0}
.datebox .d{font-weight:800;font-size:18px;padding:3px 0}
.when.old .datebox .mo{background:var(--grey)}
.when .t{font-weight:700;font-size:15px}.when .t b{color:var(--blue)}.when .s{font-size:13.5px;color:var(--grey)}
.desc{font-size:15px;line-height:1.6;white-space:pre-line;overflow-wrap:anywhere}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.avatar{width:40px;height:40px;border-radius:999px;background:var(--blue);color:#fff;font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover;display:block}
.n{font-weight:700;font-size:14.5px}.s{font-size:12.5px;color:var(--grey)}
.list{display:flex;flex-direction:column;gap:10px}
.card{display:flex;align-items:center;gap:12px;background:#fff;border:1.5px solid rgba(25,25,25,.12);border-radius:16px;padding:12px 14px}
.rc-days{position:sticky;top:0;z-index:5;display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;background:var(--bg);padding:10px 0;margin:-4px 0 4px;border-bottom:1px solid rgba(25,25,25,.08)}
.rc-days::-webkit-scrollbar{display:none}
.rc-days a{flex-shrink:0;height:40px;padding:0 14px;border-radius:999px;background:#fff;border:1.5px solid rgba(25,25,25,.14);font-weight:600;font-size:13.5px;color:var(--ink);display:inline-flex;align-items:center;white-space:nowrap;text-decoration:none}
.rc-days a:hover{border-color:var(--blue);color:var(--blue)}
.rc-day{display:flex;align-items:baseline;gap:10px;margin-top:18px;scroll-margin-top:64px}
.rc-day h2{margin:0}
.rc-day .n{font-size:13.5px;font-weight:600;color:var(--grey)}
.rc-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
.rc{display:grid;grid-template-columns:56px minmax(0,1fr) auto;grid-template-areas:"logo body go" "logo foot go";gap:6px 14px;align-items:center;background:#fff;border:1.5px solid rgba(25,25,25,.10);border-radius:16px;padding:14px 16px;min-width:0}
.rc .logo{grid-area:logo;width:56px;height:56px;border-radius:14px;background:var(--tint) center/cover no-repeat;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}
.rc .logo img{width:100%;height:100%;object-fit:cover}
.rc .body{grid-area:body;min-width:0;display:flex;flex-direction:column;gap:3px}
.rc .name{font-weight:700;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc .when{font-size:13.5px;font-weight:600}
.rc .when b{color:var(--blue)}
.rc .when.unknown{color:var(--grey);font-weight:500}
.rc .foot{grid-area:foot;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rc .go{grid-area:go;height:40px;min-width:132px;padding:0 16px;border-radius:999px;border:1.5px solid var(--blue);background:#fff;color:var(--blue);font-weight:700;font-size:14px;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;text-decoration:none}
.ini{font-weight:800;letter-spacing:-.045em;line-height:1;color:var(--blue);font-size:28px}
.cost{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:999px;font-size:12.5px;font-weight:700;background:var(--tint);color:var(--blue);white-space:nowrap}
.ig{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:700;color:var(--blue);text-decoration:none}
.ig svg{width:15px;height:15px}
.ig.wa{color:#1E8E3E}
.btn.ico{display:inline-flex;align-items:center;gap:7px}
.btn.ico svg{width:16px;height:16px}
.btn.ico.wa{color:#1E8E3E;border-color:#1E8E3E}
.meet{display:flex;align-items:flex-start;gap:8px;font-size:15px;font-weight:600;margin:6px 0}
.meet .n{color:var(--grey);font-weight:500}
@media (max-width:700px){.rc-grid{grid-template-columns:1fr}.rc{grid-template-columns:56px minmax(0,1fr);grid-template-areas:"logo body" "foot foot" "go go"}.rc .go{justify-self:start}}
.card:hover{border-color:var(--blue)}
.card .em{font-size:28px;width:36px;text-align:center;flex-shrink:0}
.card>span:last-child{min-width:0}.row>div{min-width:0}
.card .t{font-weight:700;font-size:14.5px;overflow-wrap:anywhere}.card .m{font-size:12.5px;color:var(--grey)}
.card.old{opacity:.7}
.tags{display:flex;gap:8px;flex-wrap:wrap}
.tags a{background:#fff;border:1.5px solid rgba(25,25,25,.12);border-radius:999px;padding:7px 14px;font-weight:700;font-size:13.5px}
.tags a:hover{border-color:var(--blue);color:var(--blue)}
.lead{font-size:16px;color:var(--grey);line-height:1.55}
.cta{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
footer{border-top:1px solid rgba(0,0,0,.06);padding:32px 22px 44px;color:var(--grey);font-size:13.5px}
footer .wrap{max-width:860px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center}
footer a:hover{color:var(--ink)}
@media (max-width:600px){h1{font-size:28px}.cover{height:180px;font-size:72px}}
`.trim();

function layout({ title, description, url, image, jsonLd, body, ogType = "website" }) {
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
<link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="preload" as="font" type="font/woff2" href="/bricolage-grotesque-latin-800-normal.woff2" crossorigin>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="anyplans">
<meta property="og:locale" content="it_IT">
<meta name="twitter:card" content="summary_large_image">
${jsonLd || ""}
<style>${CSS}</style>
</head>
<body>
<header><div class="nav">
  <a class="brand" href="/"><img src="/logo.png" alt="" width="28" height="28"><span>anyplans<span class="q">?</span></span></a>
  <a class="btn sm" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a>
</div></header>
<main>
${body}
</main>
<footer><div class="wrap">
  <span>© 2026 Filippo Terzi · anyplans</span>
  <a href="/${CITY}/cosa-fare/">Cosa fare a ${CITY_NAME}</a>
  <a href="/${CITY}/gruppi/">Gruppi</a>
  <a href="/${CITY}/running-club/">Running club</a>
  <a href="/${CITY}/">anyplans a ${CITY_NAME}</a>
  <a href="/guidelines.html">Le regole di anyplans</a>
  <a href="/privacy-it.html">Privacy</a>
  <a href="/terms-it.html">Condizioni d'uso</a>
  <a href="https://instagram.com/anyplans_bergamo" rel="noopener">Instagram</a>
</div></footer>
</body>
</html>
`;
}
const crumbs = (items) => `<nav class="crumbs" aria-label="Percorso">${items.map(([l, h], i) =>
  (h ? `<a href="${esc(h)}">${esc(l)}</a>` : `<span>${esc(l)}</span>`) + (i < items.length - 1 ? "<span>›</span>" : "")).join("")}</nav>`;

// date range of a page, for lists: "Sabato 5 settembre" or "Dal 5 al 10 settembre"
function whenLabel(p) {
  const d = p.up.length ? p.up : p.dates;
  if (d.length === 1) return fmtDay(d[0].start, p.tz) + " alle " + fmtTime(d[0].start, p.tz);
  return "Dal " + fmtShort(d[0].start, p.tz) + " al " + fmtShort(d[d.length - 1].start, p.tz) + ", " + d.length + " date";
}
const placeShort = (p) => p.town || p.meeting || CITY_NAME;
function cardHtml(p) {
  return `<a class="card${p.isPast ? " old" : ""}" href="${esc(eventUrl(p))}"><span class="em">${p.emoji}</span><span><span class="t">${esc(p.title)}</span><br><span class="m">${esc(whenLabel(p))} · ${esc(placeShort(p))}</span></span></a>`;
}
const listHtml = (list) => `<div class="list">${list.map(cardHtml).join("\n")}</div>`;

// ── event page ────────────────────────────────────────────────────────────────
function organizer(p) {
  if (p.community_slug && p.community_name) return { name: p.community_name, url: groupUrl({ slug: p.community_slug }), kind: "gruppo" };   // slug del gruppo, non dell'evento
  if (p.club) return { name: p.club, url: null, kind: "club" };
  return { name: "Un utente di anyplans", url: null, kind: "utente" };
}
function eventJsonLd(p, url) {
  const org = organizer(p);
  const image = p.photo ? photoSrc(p.photo) : OG_DEFAULT;
  const location = { "@type": "Place", name: p.meeting || (p.town ? p.town : CITY_NAME + " e dintorni"),
    address: { "@type": "PostalAddress", addressLocality: p.town || CITY_NAME, addressRegion: "BG", addressCountry: "IT",
               ...(p.meeting ? { streetAddress: p.meeting } : {}) } };
  if (p.visibility === "open" && p.lat != null && p.lng != null) location.geo = { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng };
  const offers = { "@type": "Offer", price: p.price_cents ? (p.price_cents / 100).toFixed(2) : "0", priceCurrency: "EUR", url, availability: "https://schema.org/InStock" };
  const events = p.dates.map(d => ({
    "@context": "https://schema.org", "@type": "Event",
    name: p.title, startDate: isoLocal(d.start, d.tz), ...(d.end ? { endDate: isoLocal(d.end, d.tz) } : {}),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location, image: [image], description: cut(p.description, 500) || `${p.tipo.label} a ${placeShort(p)}`,
    offers, organizer: { "@type": "Organization", name: org.name, url: org.url || SITE }, url
  }));
  return jsonld(events.length === 1 ? events[0] : events);
}
function whenRow(d, tz, old) {
  const mo = new Intl.DateTimeFormat("it-IT", { timeZone: tz, month: "short" }).format(d.start).replace(".", "");
  const day = new Intl.DateTimeFormat("it-IT", { timeZone: tz, day: "numeric" }).format(d.start);
  const endTxt = d.end ? " alle " + fmtTime(d.end, tz) : "";
  return `<div class="when${old ? " old" : ""}"><div class="datebox"><div class="mo">${esc(cap(mo))}</div><div class="d">${esc(day)}</div></div>
    <div><div class="t">${esc(fmtLong(d.start, tz))}</div><div class="s">Dalle <b>${esc(fmtTime(d.start, tz))}</b>${esc(endTxt)}</div></div></div>`;
}
function similar(p, n = 4) {
  const sameType = upcomingPages.filter(x => x.slug !== p.slug && x.sport === p.sport);
  const sameTown = p.town ? upcomingPages.filter(x => x.slug !== p.slug && x.town === p.town && x.sport !== p.sport) : [];
  const seen = new Set(); const out = [];
  for (const x of [...sameType, ...sameTown, ...upcomingPages]) { if (x.slug !== p.slug && !seen.has(x.slug)) { seen.add(x.slug); out.push(x); } if (out.length >= n) break; }
  return out;
}
function eventPage(p) {
  const url = eventUrl(p);
  const tz = p.tz, t = p.tipo, org = organizer(p);
  const where = placeShort(p);
  const first = p.up[0] || p.dates[p.dates.length - 1];
  const title = cut(`${p.title} a ${where}, ${fmtShort(first.start, tz)}`, 60) + " | anyplans";
  const descr = p.isPast
    ? cut(`${t.label} a ${where}. Ultima data: ${fmtShort(first.start, tz)}. Questo evento è passato: su anyplans trovi le prossime date e gli eventi simili.`, 160)
    : cut(`${t.label} a ${where} ${fmtDay(first.start, tz).toLowerCase()} alle ${fmtTime(first.start, tz)}. ${cut(p.description, 100) || ""} ${fmtPrice(p.price_cents)}. Ci vai insieme ad altri.`.replace(/\s+/g, " ").replace(/\.\s*\./g, "."), 160);
  const image = p.photo ? photoSrc(p.photo) : OG_DEFAULT;
  const sim = similar(p);
  const typeIndex = types.find(x => x.sport === p.sport);
  const townIndex = p.town ? towns.find(x => x.town === p.town) : null;
  const crumbItems = [["anyplans", "/"], [CITY_NAME, `/${CITY}/cosa-fare/`]];
  if (typeIndex) crumbItems.push([t.label, `/${CITY}/${typeIndex.slug}/`]);
  crumbItems.push([p.title, null]);

  const body = `
${crumbs(crumbItems)}
<div class="cover">${p.photo ? `<img src="${esc(photoSrc(p.photo))}" alt="${esc(p.title)}" width="800" height="230" loading="lazy" decoding="async">` : p.emoji}</div>
<div class="chips"><span class="chip">${p.emoji} ${esc(t.label)}</span><span class="chip w">${esc(fmtPrice(p.price_cents))}</span>${p.isPast ? `<span class="chip past">Evento passato</span>` : ""}${townIndex ? `<a class="chip w" href="/${CITY}/${townIndex.slug}/">${esc(p.town)}</a>` : ""}</div>
<h1>${esc(p.title)}</h1>
${p.isPast ? `<div class="box in"><h2>Questo evento è passato</h2><div class="m">L'ultima data è stata ${esc(fmtLong(first.start, tz).toLowerCase())}. Se torna, le date nuove compaiono qui.</div><div class="cta"><a class="btn" href="/${CITY}/eventi.html">Vedi cosa c'è adesso</a></div></div>` : ""}
<div class="box">
  <h2>${p.up.length > 1 ? "Le date" : "Quando"}</h2>
  ${p.up.map(d => whenRow(d, tz, false)).join("\n")}
  ${p.past.length ? (p.up.length ? `<div class="m">Date già passate</div>` : "") + p.past.slice(-12).reverse().map(d => whenRow(d, tz, true)).join("\n") : ""}
</div>
<div class="box">
  <h2>Dove</h2>
  ${p.meeting ? `<div>${esc(p.meeting)}${p.town && !norm(p.meeting).includes(norm(p.town)) ? `, ${esc(p.town)}` : ""}</div>` : `<div>Zona indicativa: ${esc(CITY_NAME)} e dintorni, luogo esatto dopo l'approvazione.</div>`}
  ${p.visibility === "open" && p.lat != null && p.lng != null ? `<div><a class="lnk" href="${esc(mapsUrl(p.lat, p.lng))}" rel="noopener">Apri in Mappe</a></div>` : ""}
</div>
${p.description ? `<div class="box"><h2>Di cosa si tratta</h2><div class="desc">${esc(p.description)}</div></div>` : ""}
<div class="box">
  <h2>Prezzo</h2>
  <div><b>${esc(fmtPrice(p.price_cents))}</b>${p.price_note ? ` <span class="m">${esc(p.price_note)}</span>` : ""}</div>
</div>
<div class="box">
  <h2>Organizza</h2>
  <div class="row">${org.kind === "gruppo" ? `<div class="avatar">${p.community_avatar ? `<img src="${esc(p.community_avatar)}" alt="" width="40" height="40" loading="lazy">` : esc(org.name[0].toUpperCase())}</div><div><a class="n" href="${esc(org.url)}">${esc(org.name)}</a><div class="s">Gruppo su anyplans</div></div>`
    : `<div><div class="n">${esc(org.name)}</div>${org.kind === "club" ? `<div class="s">Comune o associazione</div>` : ""}</div>`}</div>
${p.co.length ? `<div class="box"><h2>Insieme a</h2><div class="tags">${p.co.map(slug => { const c = groups.find(x => x.slug === slug); return c ? `<a href="${esc(groupUrl(c))}">${c.emoji || "👥"} ${esc(c.name)}</a>` : ""; }).join("")}</div></div>` : ""}
</div>
<div class="cta">
  ${p.isPast ? "" : `<a class="btn" href="/${CITY}/evento.html?id=${esc(p.id)}&amp;join=1">Ci vado</a>`}
  <a class="btn ghost" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a>
  ${p.source_url && p.source !== "ugc" ? `<a class="lnk" href="${esc(p.source_url)}" rel="noopener nofollow">Dettagli sul sito ufficiale</a>` : ""}
</div>
${sim.length ? `<h2>Eventi simili</h2>${listHtml(sim)}` : ""}
`;
  return layout({ title, description: descr, url, image, jsonLd: eventJsonLd(p, url), body, ogType: "article" });
}

// ── run club (0070: community.sport = 'running' | 'walking', community_schedule) ────────────
const WEEKDAYS = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];
const isRunClub = g => g.sport === "running" || g.sport === "walking";
const runClubs = groups.filter(isRunClub);
const hhmm = t => String(t || "").slice(0, 5);
const initial = g => `<span class="ini">${esc((g.name || "?").trim()[0].toUpperCase())}</span>`;
const logoHtml = g => g.avatar_url ? `<img src="${esc(g.avatar_url)}" alt="" width="56" height="56" loading="lazy">` : initial(g);
function costChip(g, sch) {
  const txt = ((sch || []).map(x => x.note || "").join(" ") + " " + (g.description || "")).toLowerCase();
  if (/tesseramento|€|euro|a pagamento|rimborso/.test(txt)) return `<span class="cost">Tesseramento o quota</span>`;
  if (/gratis|gratuit/.test(txt)) return `<span class="cost">Gratis</span>`;
  return "";
}
const IG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>';
const WA_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 L5.3 15.9 A8.5 8.5 0 1 1 8.4 18.9 Z"/><path d="M9 9.5 c0 3 2.5 5.5 5.5 5.5 l1.2-1.4 -1.8-1 -0.9 0.9 c-1.2-0.5-2-1.3-2.5-2.5 l0.9-0.9 -1-1.8 Z" fill="currentColor" stroke="none"/></svg>';
const igLink = g => g.instagram_handle ? `<a class="ig" href="https://instagram.com/${esc(String(g.instagram_handle).replace(/^@/, ""))}" rel="noopener" aria-label="Instagram di ${esc(g.name)}">${IG_SVG}@${esc(String(g.instagram_handle).replace(/^@/, ""))}</a>` : "";
const waLink = g => g.whatsapp_url ? `<a class="ig wa" href="${esc(g.whatsapp_url)}" rel="noopener" aria-label="Gruppo WhatsApp di ${esc(g.name)}">${WA_SVG}WhatsApp</a>` : "";
function meetLine(x) { return `${WEEKDAYS[x.weekday]} · <b>${esc(hhmm(x.start_time))}</b>${x.meeting_point_text ? ` · ${esc(x.meeting_point_text)}` : ""}`; }
function rcCard(g, x) {
  const sch = schedules.filter(s => s.community_slug === g.slug);
  const when = x ? `<div class="when">${meetLine(x)}</div>`
                 : sch.length ? `<div class="when">${sch.slice(0, 2).map(meetLine).join("<br>")}</div>`
                 : `<div class="when unknown">Giorno e orario: chiedi su Instagram</div>`;
  return `<div class="rc"><div class="logo">${logoHtml(g)}</div><div class="body"><div class="name">${esc(g.name)}</div>${when}</div><div class="foot">${costChip(g, sch)}${igLink(g)}${waLink(g)}</div><a class="go" href="${esc(groupUrl(g))}">Vedi il gruppo</a></div>`;
}
const FAQ = [
  { q: "Devo essere allenato per correre con un run club a Bergamo?", a: "No. Quasi tutti i run club di Bergamo sono aperti a chiunque: si corre a ritmo tranquillo e spesso ci sono più gruppi per passo. Basta presentarsi al ritrovo con scarpe da corsa. Se non hai mai corso, Fun Run a Calcinate è un vero corso per imparare, e Sabato alla Trucca è pensato anche per chi cammina." },
  { q: "Quanto costa entrare in un run club?", a: "Nella maggior parte dei casi niente: ci si presenta e si corre. Alcuni gruppi chiedono un tesseramento annuale (per esempio i Podisti Insonni, 35 euro) o una quota per l'assicurazione. Nella pagina di ogni club trovi scritto se è gratis." },
  { q: "Che giorno e a che ora si corre?", a: "Ogni club ha il suo giorno fisso: il lunedì PTRUNBG alle 18:15 al parco della Trucca e MRCBG alle 18:45 a Osio Sotto, il martedì Le Scalette del Martedì alle 19, il mercoledì Cor Run alle 18:45 alla Trucca, il sabato mattina Sabato alla Trucca. L'elenco completo per giorno è in cima a questa pagina." },
  { q: "Quanti chilometri si fanno?", a: "Di solito tra i 5 e i 10 chilometri, in un'ora circa. Le uscite in pista (giovedì ad Azzano, mercoledì a Mozzo) sono allenamenti più strutturati; le uscite del fine settimana possono essere più lunghe. Ogni club lo scrive nel ritrovo." },
  { q: "Devo iscrivermi prima?", a: "Quasi mai. Per sapere se il gruppo esce davvero quella settimana, il posto giusto è il gruppo WhatsApp o la pagina Instagram del club, che trovi nella sua pagina qui su anyplans. Se ti registri su anyplans puoi dire che ci vai e vedere chi altro viene." },
  { q: "Qual è il run club più grande di Bergamo?", a: "Dipende da cosa cerchi: Runners Bergamo è la società storica con più gruppi di allenamento e gare organizzate, Cor Run e WeRunBergamo sono i gruppi serali più frequentati in città, PTRUNBG e MRCBG i più regolari del lunedì. Tutti e ventiquattro sono in questa pagina." },
];
function runningHub() {
  const url = `${SITE}/${CITY}/running-club/`;
  const T = TESTI.running_club || {};
  const title = cut(T.titolo || `Running club a ${CITY_NAME}: ${runClubs.length} gruppi di corsa`, 60) + " | anyplans";
  const descr = cut(T.sotto || `${runClubs.length} run club a ${CITY_NAME} e provincia, uno quasi ogni sera: scegli il giorno, vai, corri insieme ad altri. Quasi tutti gratis.`, 160);
  const byDay = WEEKDAYS.map((d, i) => ({ d, i, rows: schedules.filter(s => s.weekday === i && runClubs.some(g => g.slug === s.community_slug)) }));
  const withDay = new Set(schedules.map(s => s.community_slug));
  const noDay = runClubs.filter(g => !withDay.has(g.slug));
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Running club a ${CITY_NAME}`, url,
    itemListElement: runClubs.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: groupUrl(g), name: g.name })) });
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, `/${CITY}/cosa-fare/`], ["Gruppi", `/${CITY}/gruppi/`], ["Running club", null]])}
<h1>${esc(T.titolo || `Running club a ${CITY_NAME} e provincia`)}</h1>
<p class="lead">${esc(T.sotto || descr)}</p>
<div class="rc-days">${byDay.map(x => `<a href="#${x.d.toLowerCase()}"${x.rows.length ? "" : ' aria-disabled="true"'}>${x.d}</a>`).join("")}${noDay.length ? `<a href="#altri">Senza giorno fisso</a>` : ""}</div>
${byDay.filter(x => x.rows.length).map(x => `
<div class="rc-day" id="${x.d.toLowerCase()}"><h2>${x.d}</h2><span class="n">${x.rows.length} ${x.rows.length === 1 ? "ritrovo" : "ritrovi"}</span></div>
<div class="rc-grid">${x.rows.map(r => rcCard(runClubs.find(g => g.slug === r.community_slug), r)).join("\n")}</div>`).join("\n")}
${noDay.length ? `
<div class="rc-day" id="altri"><h2>Senza giorno fisso</h2><span class="n">${noDay.length}</span></div>
<p class="lead">Escono quando decidono sul momento: il giorno lo trovi sulla loro pagina Instagram.</p>
<div class="rc-grid">${noDay.map(g => rcCard(g, null)).join("\n")}</div>` : ""}
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a><a class="btn ghost" href="/${CITY}/login.html">Organizzi un run club? Crea il tuo gruppo</a></div>
<div class="box"><h2>Come funziona un run club</h2>
<p>Un run club è un gruppo di persone che si trova a un'ora e in un posto fissi per correre insieme, di solito una volta a settimana. Non è una società sportiva: non ci sono gare, classifiche o tesseramenti obbligatori (salvo dove indicato), e non serve essere allenati. Si corre a ritmo tranquillo, spesso in più gruppi per passo, e chi va piano non resta indietro. Alla fine, quasi sempre, si beve qualcosa insieme.</p>
<p>A ${esc(CITY_NAME)} e provincia i run club sono ${runClubs.length}: dal lunedì al parco della Trucca (PTRUNBG) e a Osio Sotto (MRCBG), al martedì sulle scalette di Città Alta, al mercoledì con Cor Run, fino al sabato mattina. Qui sopra li trovi per giorno; nella pagina di ogni club ci sono il ritrovo, le prossime uscite e i contatti Instagram e WhatsApp. Questa pagina si aggiorna da sola ogni notte.</p></div>
<div class="box" id="domande"><h2>Domande frequenti</h2>
${FAQ.map(f => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join("")}</div>
`;
  const faqLd = jsonld({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map(f => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) });
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd, body }), lastmod: NOW };
}

// ── group pages ───────────────────────────────────────────────────────────────
function groupPage(g) {
  const url = groupUrl(g);
  const evs = pages.filter(p => p.community_slug === g.slug || p.co.includes(g.slug)).sort(byDate);
  const up = evs.filter(p => !p.isPast), past = evs.filter(p => p.isPast).reverse().slice(0, 20);
  const t = tipo(g.category); // group category is a site category, not a sport: fall back to emoji from the group
  const emoji = g.emoji || "👥";
  let title = cut(`${g.name}: gruppo a ${cap(g.city || CITY_NAME)}`, 60) + " | anyplans";
  let descr = cut(`${g.name} è un gruppo su anyplans a ${cap(g.city || CITY_NAME)}${up.length ? ` con ${up.length} ${up.length === 1 ? "evento in programma" : "eventi in programma"}` : ""}. ${g.description || ""}`, 160);
  const image = g.avatar_url || OG_DEFAULT;
  const sch = schedules.filter(s => s.community_slug === g.slug);
  // run club: titolo e descrizione con le parole che la gente cerca ("running club Bergamo", "run club Bergamo", "corsa di gruppo")
  if (isRunClub(g)) {
    const when = sch.length ? `ogni ${WEEKDAYS[sch[0].weekday].toLowerCase()} alle ${hhmm(sch[0].start_time)}${sch[0].meeting_point_text ? " · " + sch[0].meeting_point_text : ""}` : "";
    title = cut(`${g.name}: ${g.sport === "walking" ? "camminate di gruppo" : "running club"} a ${CITY_NAME}${when ? ", " + when.split(" · ")[0] : ""}`, 60) + " | anyplans";
    descr = cut(`${g.name}, ${g.sport === "walking" ? "gruppo di camminata" : "run club"} a ${CITY_NAME} e provincia${when ? ": si corre " + when : ""}. ${g.description || "Corsa di gruppo, nessuno corre da solo."} Tutti i running club di Bergamo su anyplans.`, 160);
  }
  const ld = jsonld({ "@context": "https://schema.org", "@type": isRunClub(g) ? "SportsOrganization" : "Organization", name: g.name, url,
    ...(isRunClub(g) ? { sport: g.sport === "walking" ? "Walking" : "Running" } : {}),
    ...(g.avatar_url ? { logo: g.avatar_url } : {}), ...(g.description ? { description: cut(g.description, 300) } : {}),
    ...(g.instagram_handle ? { sameAs: [`https://instagram.com/${String(g.instagram_handle).replace(/^@/, "")}`] } : {}),
    address: { "@type": "PostalAddress", addressLocality: cap(g.city || CITY_NAME), addressCountry: "IT" } });
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, `/${CITY}/cosa-fare/`], ["Gruppi", `/${CITY}/gruppi/`], [g.name, null]])}
<div class="row"><div class="avatar" style="width:64px;height:64px;font-size:26px${g.avatar_url ? "" : ";background:var(--tint)"}">${g.avatar_url ? `<img src="${esc(g.avatar_url)}" alt="" width="64" height="64">` : isRunClub(g) ? initial(g) : emoji}</div>
  <div><h1>${esc(g.name)}</h1><div class="s">${esc(cap(g.city || CITY_NAME))}${g.is_verified ? " · Gruppo verificato" : ""}${g.review_count > 0 && g.review_avg != null ? ` · ${esc(String(g.review_avg).replace(".", ","))} su 5 (${g.review_count} ${g.review_count === 1 ? "recensione" : "recensioni"})` : ""}</div></div></div>
// (06/09/2026) niente riquadro "Quando ci si trova": i ritrovi sono già in "Prossimi eventi" (materialize_schedules, 0073)
${g.description ? `<div class="box"><h2>Chi siamo</h2><div class="desc">${esc(g.description)}</div></div>` : ""}
<div class="cta"><a class="btn" href="/${CITY}/community.html?slug=${esc(g.slug)}">Segui il gruppo</a>${g.instagram_handle ? `<a class="btn ghost ico" href="https://instagram.com/${esc(String(g.instagram_handle).replace(/^@/, ""))}" rel="noopener">${IG_SVG}Instagram</a>` : ""}${g.whatsapp_url ? `<a class="btn ghost ico wa" href="${esc(g.whatsapp_url)}" rel="noopener">${WA_SVG}Gruppo WhatsApp</a>` : ""}<a class="btn ghost" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a></div>
<h2>${up.length ? "Prossimi eventi" : "Nessun evento in programma"}</h2>
${up.length ? listHtml(up) : `<p class="lead">Quando il gruppo pubblica un evento, compare qui.</p>`}
${past.length ? `<h2>Eventi già passati</h2>${listHtml(past)}` : ""}
${isRunClub(g) && runClubs.length > 1 ? `<h2>Altri run club a ${esc(CITY_NAME)}</h2><div class="rc-grid">${runClubs.filter(o => o.slug !== g.slug).slice(0, 4).map(o => rcCard(o, null)).join("\n")}</div><div class="cta"><a class="btn ghost" href="/${CITY}/running-club/">Tutti i running club</a></div>` : ""}
`;
  return { html: layout({ title, description: descr, url, image, jsonLd: ld, body }), lastmod: evs.length ? new Date(Math.max(...evs.map(p => p.updated))) : NOW };
}
function groupsIndex() {
  const url = `${SITE}/${CITY}/gruppi/`;
  const title = `Gruppi a ${CITY_NAME}: ${groups.length} ${groups.length === 1 ? "comunità" : "comunità"} a cui unirti | anyplans`;
  const descr = cut(`I gruppi di ${CITY_NAME} su anyplans: associazioni, club e comunità che organizzano eventi aperti a tutti. Li segui e vedi i loro prossimi piani.`, 160);
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, `/${CITY}/cosa-fare/`], ["Gruppi", null]])}
<h1>Gruppi a ${esc(CITY_NAME)}</h1>
<p class="lead">${esc(descr)}</p>
${runClubs.length >= 3 ? `<div class="cta"><a class="btn" href="/${CITY}/running-club/">🏃 Running club a ${esc(CITY_NAME)}: ${runClubs.length} gruppi</a></div>` : ""}
<div class="list">${groups.map(g => `<a class="card" href="${esc(groupUrl(g))}"><span class="em">${g.emoji || "👥"}</span><span><span class="t">${esc(g.name)}</span><br><span class="m">${esc(cap(g.city || CITY_NAME))}${g.upcoming_count > 0 ? ` · ${g.upcoming_count} ${g.upcoming_count === 1 ? "evento in programma" : "eventi in programma"}` : ""}</span></span></a>`).join("\n")}</div>
<div class="cta"><a class="btn ghost" href="/${CITY}/login.html">Organizzi eventi? Crea il tuo gruppo</a></div>
`;
  return layout({ title, description: descr, url, image: OG_DEFAULT, body });
}

// ── index pages (type / town) and hub ─────────────────────────────────────────
function indexPage(ix) {
  const url = `${SITE}/${CITY}/${ix.slug}/`;
  const list = ix.list.slice().sort(byDate);
  const up = list.filter(p => !p.isPast), past = list.filter(p => p.isPast).reverse().slice(0, Math.max(0, Math.min(20, 100 - up.length)));
  let h1, title, intro, emoji;
  if (ix.kind === "tipo") {
    h1 = `${ix.t.label} a ${CITY_NAME} e provincia`; emoji = ix.t.e;
    title = cut(`${ix.t.label} a ${CITY_NAME}`, 44) + (up.length ? `: ${up.length} ${up.length === 1 ? "evento" : "eventi"}` : "") + " | anyplans";
    intro = `${up.length ? `A ${CITY_NAME} e provincia ci sono ${up.length} ${up.length === 1 ? "evento" : "eventi"} di ${ix.t.label.toLowerCase()} nei prossimi mesi.` : `Al momento non ci sono eventi di ${ix.t.label.toLowerCase()} in programma: qui sotto quelli già passati.`} ${ix.t.frase}`;
  } else {
    h1 = `Feste ed eventi a ${ix.town}`; emoji = "🎉";
    title = cut(`Feste ed eventi a ${ix.town}${up.length ? ": " + up.length + " in programma" : ""}`, 60) + " | anyplans";
    intro = `${up.length ? `A ${ix.town} ${up.length === 1 ? "c'è 1 evento" : "ci sono " + up.length + " eventi"} nei prossimi mesi.` : `A ${ix.town} non c'è niente in programma adesso: qui sotto le feste già passate, che spesso tornano ogni anno.`} ${TESTI.paese.frase.replace("{paese}", ix.town)}`;
  }
  const descr = cut(intro, 160);
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, `/${CITY}/cosa-fare/`], [ix.kind === "tipo" ? ix.t.label : ix.town, null]])}
<div class="chips"><span class="chip">${emoji} ${esc(ix.kind === "tipo" ? ix.t.c ? cap(ix.t.c) : "" : "Paese")}</span></div>
<h1>${esc(h1)}</h1>
<p class="lead">${esc(intro)}</p>
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a></div>
${up.length ? `<h2>Prossimi</h2>${listHtml(up)}` : ""}
${past.length ? `<h2>Già passati</h2>${listHtml(past)}` : ""}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, body }), lastmod: new Date(Math.max(...list.map(p => p.updated))) };
}
function hubPage() {
  const url = `${SITE}/${CITY}/cosa-fare/`;
  const next = upcomingPages.slice(0, 30);
  const title = `${TESTI.hub.titolo}: ${upcomingPages.length} eventi in programma | anyplans`;
  const descr = cut(`${TESTI.hub.sotto} ${upcomingPages.length} eventi in programma, ${types.length} tipi di attività, ${groups.length} gruppi.`, 160);
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, null]])}
<h1>${esc(TESTI.hub.titolo)}</h1>
<p class="lead">${esc(TESTI.hub.sotto)}</p>
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a><a class="btn ghost" href="/${CITY}/gruppi/">I gruppi</a></div>
${types.length ? `<h2>Per tipo</h2><div class="tags">${types.map(x => `<a href="/${CITY}/${x.slug}/">${x.t.e} ${esc(x.t.label)}</a>`).join("")}</div>` : ""}
${towns.length ? `<h2>Per paese</h2><div class="tags">${towns.slice().sort((a, b) => a.town.localeCompare(b.town, "it")).map(x => `<a href="/${CITY}/${x.slug}/">${esc(x.town)}</a>`).join("")}</div>` : ""}
${runClubs.length >= 3 ? `<h2>Correre in compagnia</h2><div class="tags"><a href="/${CITY}/running-club/">🏃 Running club a ${esc(CITY_NAME)}</a></div>` : ""}
${groups.length ? `<h2>Gruppi</h2><div class="tags">${groups.map(g => `<a href="${esc(groupUrl(g))}">${g.emoji || "👥"} ${esc(g.name)}</a>`).join("")}</div>` : ""}
<h2>Prossimi eventi</h2>
${next.length ? listHtml(next) : `<p class="lead">Niente in programma adesso.</p>`}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, body }), lastmod: pages.length ? new Date(Math.max(...pages.map(p => p.updated))) : NOW };
}

// ── robots & sitemap ──────────────────────────────────────────────────────────
const ROBOTS = `User-agent: *
Disallow: /${CITY}/login.html
Disallow: /${CITY}/profilo.html
Disallow: /${CITY}/crea.html
Disallow: /${CITY}/crea-community.html
Disallow: /${CITY}/dashboard.html
Disallow: /${CITY}/checkin.html
Disallow: /${CITY}/notifiche.html
Disallow: /${CITY}/impostazioni.html
Disallow: /${CITY}/miei.html
Disallow: /${CITY}/seguo.html
Disallow: /${CITY}/chiedi.html
Disallow: /${CITY}/tipo-account.html
Disallow: /${CITY}/raccontaci-gruppo.html
Disallow: /v2/
Disallow: /index-waitlist.html

Sitemap: ${SITE}/sitemap.xml
`;
const sitemapEntries = []; // {loc, lastmod}
const addUrl = (loc, lastmod) => sitemapEntries.push({ loc, lastmod: (lastmod || NOW).toISOString().slice(0, 10) });
function sitemapXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.map(e => `  <url><loc>${esc(e.loc)}</loc><lastmod>${e.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
}

// ── write ─────────────────────────────────────────────────────────────────────
async function writePage(rel, html) {
  const dir = path.join(OUT, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html);
}
const cityDir = path.join(OUT, CITY);
await mkdir(cityDir, { recursive: true });
for (const e of await readdir(cityDir, { withFileTypes: true })) if (e.isDirectory()) await rm(path.join(cityDir, e.name), { recursive: true, force: true });

addUrl(SITE + "/", NOW);
const hub = hubPage(); await writePage(`${CITY}/cosa-fare`, hub.html); addUrl(`${SITE}/${CITY}/cosa-fare/`, hub.lastmod);
for (const ix of [...types, ...towns]) { const r = indexPage(ix); await writePage(`${CITY}/${ix.slug}`, r.html); addUrl(`${SITE}/${CITY}/${ix.slug}/`, r.lastmod); }
if (groups.length) { await writePage(`${CITY}/gruppi`, groupsIndex()); addUrl(`${SITE}/${CITY}/gruppi/`, NOW); }
if (runClubs.length >= 3) { const r = runningHub(); await writePage(`${CITY}/running-club`, r.html); addUrl(`${SITE}/${CITY}/running-club/`, r.lastmod); }
for (const g of groups) { const r = groupPage(g); await writePage(`${CITY}/gruppi/${g.slug}`, r.html); addUrl(groupUrl(g), r.lastmod); }
for (const p of pages) { await writePage(`${CITY}/${p.slug}`, eventPage(p)); addUrl(eventUrl(p), p.updated); }
await writeFile(path.join(OUT, "sitemap.xml"), sitemapXml());
await writeFile(path.join(OUT, "robots.txt"), ROBOTS);

console.log(`eventi: ${rows.length} righe, ${pages.length} pagine (${upcomingPages.length} futuri, ${pages.length - upcomingPages.length} passati)`);
console.log(`indici: ${types.length} tipi (${types.map(x => x.slug).join(", ")}), ${towns.length} paesi`);
console.log(`gruppi: ${groups.length} (run club: ${runClubs.length}, ritrovi: ${schedules.length}); sitemap: ${sitemapEntries.length} url → ${OUT}`);

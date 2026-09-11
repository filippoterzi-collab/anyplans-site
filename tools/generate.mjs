#!/usr/bin/env node
// anyplans SEO: static public pages for Google (design/sito-landing/plan-seo.md).
// Node 20, no dependencies. Reads Supabase with the anon key and writes into --out:
//   /bergamo/<slug>/index.html            one page per event slug (all dates of a multi-day festa)
//   /bergamo/gruppi/index.html            public list of groups
//   /bergamo/gruppi/<slug>/index.html     one page per group
//   /bergamo/<tipo>/ and /bergamo/<paese>/ flat indexes (>= MIN_INDEX events)
//   /bergamo/cosa-fare/index.html         hub
//   /en/bergamo/...                       the same pages in English (things-to-do, festivals, running-clubs, groups, events)
//   /sitemap.xml, /robots.txt, /llms.txt, /llms-full.txt
// Usage: node generate.mjs --out <dir> [--fixture <rows.json>] [--groups <groups.json>]
// Env: SUPABASE_URL, SUPABASE_ANON_KEY.
// Every subdirectory of <out>/bergamo/ and the whole <out>/en/bergamo/ are removed and regenerated: they must contain only generated pages.

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

// ── locales: the Italian pages are the original; the English ones (for visitors and tourists) live under /en/ ──
// per sport: [slug under /en/bergamo/, label, phrase for the index page]
const EN_TYPES = {
  running: ["running", "Running", "Group runs and road races in the city and the province: you sign up and run with others, at your own pace."],
  trail: ["trail-running", "Trail running", "Trail races on the paths of the Bergamo valleys, from the Orobie to the hills."],
  hyrox: ["hyrox", "Hyrox", "Hyrox training sessions and races in the gym, to prepare as a group."],
  walking: ["walking", "Walking", "Group walks in the city and on the hills: the easiest way to get out of the house."],
  cycling: ["road-cycling", "Road cycling", "Group rides on the road, from the plain to the mountain passes."],
  mtb: ["mountain-biking", "Mountain biking", "Mountain bike rides on the trails around Bergamo."],
  moto: ["motorbike", "Motorbike rides", "Motorbike rides in group through the valleys and the lakes."],
  hiking: ["hiking", "Hiking", "Hikes in the Orobie Alps and on the hills, in group."],
  climbing: ["climbing", "Climbing", "Climbing sessions on the wall and on the rock, with others."],
  skitouring: ["ski-touring", "Ski touring", "Ski touring outings in the Orobie Alps."],
  gym: ["gym", "Gym", "Training sessions in the gym, in group."],
  yoga: ["yoga", "Yoga & pilates", "Yoga and pilates classes and sessions in the park."],
  football: ["football", "Football", "Five-a-side matches and pick-up games."],
  basketball: ["basketball", "Basketball", "Pick-up basketball games."],
  volleyball: ["volleyball", "Volleyball", "Volleyball and beach volley games."],
  tennis: ["tennis", "Tennis", "Tennis matches and lessons."],
  padel: ["padel", "Padel", "Open padel matches, tournaments and lessons in the clubs around Bergamo."],
  swimming: ["swimming", "Swimming", "Swimming sessions and open water."],
  surf: ["surf", "Surf & SUP", "Surf and stand-up paddle outings."],
  paddling: ["canoe-kayak", "Canoe & kayak", "Canoe and kayak outings on the lakes and rivers."],
  skiing: ["skiing", "Skiing", "Ski days in group."],
  snowboard: ["snowboard", "Snowboarding", "Snowboard days in group."],
  skating: ["skating", "Skating", "Skating sessions."],
  golf: ["golf", "Golf", "Golf rounds and lessons."],
  bowling: ["bowling", "Bowling", "Bowling nights."],
  ceramics: ["pottery", "Pottery", "Pottery classes, also for beginners."],
  cooking: ["cooking", "Cooking classes", "Cooking classes and dinners cooked together."],
  dinner: ["dinners", "Dinners & aperitivo", "Dinners and aperitivo with people you don't know yet."],
  painting: ["painting", "Painting & art", "Painting and art workshops."],
  gardening: ["volunteering", "Gardening & volunteering", "Community gardens and volunteering mornings."],
  festival: ["festivals", "Town festivals & fairs", "The parish festivals (feste dell'oratorio), food fairs (sagre) and village events of the Bergamo area, with the dates of every evening."],
  estivo: ["summer-venues", "Summer venues", "The open-air summer venues (estivi) of Bergamo and the province, evening by evening until they close: bars in the parks, food, DJ sets and parties."],
};
const LOCALES = {
  it: { code: "it", tag: "it-IT", og: "it_IT", intl: "it-IT", prefix: "", hub: "cosa-fare", groups: "gruppi", running: "running-club",
        days: ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"], daySlug: ["lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato", "domenica"],
        and: " e ", free: "Gratis", privacy: "/privacy-it.html", terms: "/terms-it.html", home: "/" },
  en: { code: "en", tag: "en", og: "en_GB", intl: "en-GB", prefix: "/en", hub: "things-to-do", groups: "groups", running: "running-clubs",
        days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], daySlug: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
        and: " and ", free: "Free", privacy: "/privacy.html", terms: "/terms.html", home: "/en/" },
};
let L = LOCALES.it;           // the locale of the page being built (the write loop at the bottom switches it)
const en = () => L.code === "en";
// run fn with another locale active (to compute the hreflang alternate of the page being built)
function inLocale(code, fn) { const prev = L; L = LOCALES[code]; try { return fn(); } finally { L = prev; } }

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
const fmtLong = (d, tz) => cap(new Intl.DateTimeFormat(L.intl, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d));
const fmtShort = (d, tz) => new Intl.DateTimeFormat(L.intl, { timeZone: tz, day: "numeric", month: "long" }).format(d);
const fmtDay = (d, tz) => cap(new Intl.DateTimeFormat(L.intl, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d));
const fmtTime = (d, tz) => new Intl.DateTimeFormat("it-IT", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const fmtMonthShort = (d, tz) => cap(new Intl.DateTimeFormat(L.intl, { timeZone: tz, month: "short" }).format(d).replace(".", ""));
const fmtDayNum = (d, tz) => new Intl.DateTimeFormat(L.intl, { timeZone: tz, day: "numeric" }).format(d);
function isoLocal(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).formatToParts(d).map(x => [x.type, x.value]));
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
function fmtPrice(c) {
  if (c == null || c <= 0) return L.free;
  const e = Math.floor(c / 100), r = c % 100;
  if (en()) return "€" + (r ? e + "." + String(r).padStart(2, "0") : e);
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
const tipo = (sport) => ({ sport, ...(TIPI[sport] || { key: slugify(sport), e: "📍", label: cap(sport || "Evento"), c: "altro", frase: "" }) });
// label / slug / phrase of a type in the active language
const tLabel = (t) => en() ? (EN_TYPES[t.sport]?.[1] || t.label) : t.label;
const tSlug = (t) => en() ? (EN_TYPES[t.sport]?.[0] || t.key) : t.key;
const tPhrase = (t) => en() ? (EN_TYPES[t.sport]?.[2] || "") : t.frase;
const catLabel = (c) => en() ? ({ sport: "Sports", cucina: "Food", creatività: "Creativity", giardinaggio: "Gardening", cultura: "Culture", benessere: "Wellbeing", altro: "Other" }[c] || cap(c)) : cap(c);
const jsonld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const INSTAGRAM = "https://instagram.com/anyplans_bergamo";
// the same Organization node as the home page (branding/legal/index.html): keep the two identical
const ORG = { "@type": "Organization", "@id": SITE + "/#org", name: "anyplans", url: SITE + "/", email: "hello@anyplans.in",
  logo: { "@type": "ImageObject", url: SITE + "/favicon-192.png", width: 192, height: 192 },
  description: "La mappa degli eventi veri di Bergamo e provincia: feste di paese, corsi, volontariato, sport e running club. Ne scegli uno e ci vai insieme ad altri. Solo maggiorenni.",
  foundingLocation: { "@type": "City", name: "Bergamo" }, areaServed: { "@type": "City", name: "Bergamo" }, sameAs: [INSTAGRAM],
  founder: { "@type": "Person", name: "Filippo Terzi", image: SITE + "/founder.jpg", jobTitle: "Fondatore" } };
const fmtDate = (d) => new Intl.DateTimeFormat(L.intl, { timeZone: DEFAULT_TZ, day: "numeric", month: "long", year: "numeric" }).format(d);
// answer engines (ChatGPT, Perplexity, AI Overviews) lift question + short answer: every page gets a visible FAQ and its FAQPage schema
// domande chiuse (details): si aprono al tocco, il testo resta nella pagina per Google (FAQPage in JSON-LD)
const faqHtml = (faq) => `<div class="box" id="domande"><h2>${en() ? "Frequently asked questions" : "Domande frequenti"}</h2>${faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div>`;
const faqLd = (faq) => jsonld({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(f => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) });
const joinIt = (a) => a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + L.and + a[a.length - 1];

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
    price_cents: r.price_cents, price_note: r.price_note, photo: r.photo_url || null, going: r.going_count || 0,
    club: r.club_name || null, town: isFest && r.club_name ? String(r.club_name).trim() : null,
    community_slug: r.community_slug || null, community_name: r.community_name || null,
    community_avatar: r.community_avatar_url || null,
    co: Array.isArray(r.co_communities) ? r.co_communities : [],
    // 0082: chi organizza con il nome (host + collaboratori) e posti massimi
    host_name: r.host_name ? String(r.host_name).trim() : null,
    admins: Array.isArray(r.organizer_names) ? r.organizer_names.filter(Boolean) : [],
    max: Number(r.max_participants) || 0,
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
// every public url depends on the active locale: /bergamo/gruppi/x/ vs /en/bergamo/groups/x/
const base = () => `${SITE}${L.prefix}/${CITY}`;
const eventUrl = (p) => `${base()}/${p.slug}/`;
const groupUrl = (g) => `${base()}/${L.groups}/${g.slug}/`;
const hubUrl = () => `${base()}/${L.hub}/`;
const groupsUrl = () => `${base()}/${L.groups}/`;
const runningUrl = () => `${base()}/${L.running}/`;
const dayUrl = (i) => `${runningUrl()}${L.daySlug[i]}/`;
const ixSlug = (ix) => ix.kind === "tipo" ? tSlug(ix.t) : ix.slug;
const indexUrl = (ix) => `${base()}/${ixSlug(ix)}/`;
const rel = (u) => u.slice(SITE.length);
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
.rc .when{display:block;font-size:13.5px;font-weight:600}
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
.box h3{font-size:15.5px;font-weight:700;margin-top:6px}.box p{font-size:15px;line-height:1.6}
.upd{font-size:12.5px;color:var(--grey)}
.cta{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.cover #map{display:block;width:100%;height:100%;cursor:pointer}
.hero-when{align-items:flex-start}.hero-when .place{color:var(--blue);font-weight:700;display:block;margin-top:2px}.hero-when .t b.rel{color:#B4530A;margin-left:6px}.hero-when .t b.rel.now{color:#1E8E3E}
#domande details{border-top:1px solid rgba(25,25,25,.08);padding:10px 0}#domande details:first-of-type{border-top:0}#domande summary{cursor:pointer;font-weight:700;font-size:15px;list-style:none;display:flex;justify-content:space-between;gap:10px}#domande summary::-webkit-details-marker{display:none}#domande summary::after{content:"+";color:var(--blue);font-weight:800}#domande details[open] summary::after{content:"–"}#domande details p{margin:8px 0 0;color:var(--grey);font-size:14.5px}
footer{border-top:1px solid rgba(0,0,0,.06);padding:32px 22px 44px;color:var(--grey);font-size:13.5px}
footer .wrap{max-width:860px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center}
footer a:hover{color:var(--ink)}
@media (max-width:600px){h1{font-size:28px}.cover{height:180px;font-size:72px}}
`.trim();

let lastCrumbs = null; // set by crumbs() while the body is built, read by layout() right after (pages are built one at a time)
function layout({ title, description, url, image, jsonLd, body, ogType = "website", modified = NOW, head = "", alt = null }) {
  // alt: the same page in the other language (hreflang); Italian is the default for everyone else
  const itUrl = en() ? alt : url, enUrl = en() ? url : alt;
  const crumbLd = lastCrumbs ? jsonld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: lastCrumbs.map(([l, h], i) =>
    ({ "@type": "ListItem", position: i + 1, name: l, ...(h ? { item: h.startsWith("http") ? h : SITE + h } : { item: url }) })) }) : "";
  lastCrumbs = null;
  // WebPage with dateModified: freshness signal for answer engines (Event/Organization have no modified date of their own)
  const pageLd = jsonld({ "@context": "https://schema.org", "@type": "WebPage", "@id": url, url, name: title, description, inLanguage: L.tag,
    dateModified: modified.toISOString(), primaryImageOfPage: image,
    isPartOf: { "@type": "WebSite", "@id": SITE + "/#website", name: "anyplans", url: SITE + "/" },
    publisher: ORG });
  return `<!DOCTYPE html>
<html lang="${L.code}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${itUrl && enUrl ? `<link rel="alternate" hreflang="it" href="${esc(itUrl)}">
<link rel="alternate" hreflang="en" href="${esc(enUrl)}">
<link rel="alternate" hreflang="x-default" href="${esc(itUrl)}">` : ""}
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
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
<meta property="og:locale" content="${L.og}">
<meta name="twitter:card" content="summary_large_image">
${pageLd}
${crumbLd}
${jsonLd || ""}
<style>${CSS}</style>
${head}
</head>
<body>
<header><div class="nav">
  <a class="brand" href="${L.home}"><img src="/logo.png" alt="" width="28" height="28"><span>anyplans<span class="q">?</span></span></a>
  <span class="row" style="gap:10px">${alt ? `<a class="lnk" href="${esc(alt)}" hreflang="${en() ? "it" : "en"}" style="font-size:13.5px">${en() ? "Italiano" : "English"}</a>` : ""}<a class="btn sm" href="/${CITY}/eventi.html">${en() ? "See all events" : "Vedi tutti gli eventi"}</a></span>
</div></header>
<main>
${body}
</main>
<footer><div class="wrap">
  <span>© 2026 Filippo Terzi · anyplans</span>
  <span class="upd">${en() ? "Page updated on" : "Pagina aggiornata il"} ${esc(fmtDate(modified))}</span>
  <a href="${rel(hubUrl())}">${en() ? `Things to do in ${CITY_NAME}` : `Cosa fare a ${CITY_NAME}`}</a>
  <a href="${rel(groupsUrl())}">${en() ? "Groups" : "Gruppi"}</a>
  <a href="${rel(runningUrl())}">${en() ? "Running clubs" : "Running club"}</a>
  <a href="/${CITY}/">anyplans ${en() ? "in" : "a"} ${CITY_NAME}</a>
  <a href="/guidelines.html">${en() ? "Community guidelines" : "Le regole di anyplans"}</a>
  <a href="${L.privacy}">Privacy</a>
  <a href="${L.terms}">${en() ? "Terms of use" : "Condizioni d'uso"}</a>
  ${alt ? `<a href="${esc(alt)}" hreflang="${en() ? "it" : "en"}">${en() ? "Questa pagina in italiano" : "This page in English"}</a>` : ""}
  <a href="https://instagram.com/anyplans_bergamo" rel="noopener">Instagram</a>
</div></footer>
</body>
</html>
`;
}
const crumbs = (items) => (lastCrumbs = items, `<nav class="crumbs" aria-label="${en() ? "Breadcrumb" : "Percorso"}">${items.map(([l, h], i) =>
  (h ? `<a href="${esc(h)}">${esc(l)}</a>` : `<span>${esc(l)}</span>`) + (i < items.length - 1 ? "<span>›</span>" : "")).join("")}</nav>`);

// date range of a page, for lists: "Sabato 5 settembre" or "Dal 5 al 10 settembre"
function whenLabel(p) {
  const d = p.up.length ? p.up : p.dates;
  if (en()) {
    if (d.length === 1) return fmtDay(d[0].start, p.tz) + " at " + fmtTime(d[0].start, p.tz);
    return "From " + fmtShort(d[0].start, p.tz) + " to " + fmtShort(d[d.length - 1].start, p.tz) + ", " + d.length + " dates";
  }
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
  if (p.community_slug && p.community_name) {
    const g = groupBySlug.get(p.community_slug);
    return { name: p.community_name, url: groupUrl({ slug: p.community_slug }), kind: "gruppo", instagram: g?.instagram_handle ? `https://instagram.com/${String(g.instagram_handle).replace(/^@/, "")}` : null };   // slug del gruppo, non dell'evento
  }
  if (p.club) return { name: p.club, url: null, kind: "club" };
  if (p.host_name) return { name: p.host_name, url: null, kind: "utente" };
  return { name: en() ? "An anyplans member" : "Un utente di anyplans", url: null, kind: "utente" };
}
// "Piazzale della Chiesa, Carvico" -> Carvico; a last segment with digits or the city name itself is not a locality
function localityOf(p) {
  if (p.town) return p.town === "Bergamo Città" ? CITY_NAME : p.town; // eventi.bergamo.it says "Bergamo Città" for the city itself
  const parts = String(p.meeting || "").split(",").map(x => x.trim()).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return last && !/\d/.test(last) && last.length <= 40 ? last.replace(/\s*\(.*\)\s*$/, "") : CITY_NAME;
}
function eventJsonLd(p, url) {
  // Google wants Event markup only for events still to come: past dates get no Event node at all
  const dates = p.dates.filter(d => d.future);
  if (!dates.length) return "";
  const org = organizer(p);
  const image = p.photo ? photoSrc(p.photo) : OG_DEFAULT;
  const location = { "@type": "Place", name: p.meeting || (p.town ? p.town : CITY_NAME + " e dintorni"),
    address: { "@type": "PostalAddress", addressLocality: localityOf(p), addressRegion: "BG", addressCountry: "IT",
               ...(p.meeting ? { streetAddress: p.meeting } : {}) } };
  // organizer (Search Console 08/09/2026: "missing field organizer/performer"): a group on anyplans (with its page), a named association,
  // the town's Comune for the feste it publishes on its own portal (eventi.bergamo.it / app.bergamo.it), never anyplans itself.
  // Events opened by a single user (no group) carry no organizer: the RPC exposes no host name (privacy, SCHEMA §5) and we don't invent one.
  const organizerNode = org.kind === "gruppo" ? { "@type": "Organization", name: org.name, url: org.url, ...(org.instagram ? { sameAs: [org.instagram] } : {}) }
    : org.kind === "club" ? { "@type": "Organization", name: p.town ? `Comune di ${localityOf(p)}` : org.name } : null; // the Comune keeps its Italian name in both languages
  if (p.visibility === "open" && p.lat != null && p.lng != null) location.geo = { "@type": "GeoCoordinates", latitude: p.lat, longitude: p.lng };
  // validFrom: since when one can join = when the event was published (updated_at is the closest date the public RPC exposes)
  const validFrom = isoLocal(p.updated instanceof Date && !isNaN(p.updated) ? p.updated : NOW, p.tz || "Europe/Rome");
  const offers = { "@type": "Offer", price: p.price_cents ? (p.price_cents / 100).toFixed(2) : "0", priceCurrency: "EUR", url, availability: "https://schema.org/InStock", validFrom };
  const events = dates.map(d => ({
    "@context": "https://schema.org", "@type": "Event",
    // Google wants endDate: without an end time we use the same rule as the "upcoming" logic above (3 hours after the start)
    name: p.title, startDate: isoLocal(d.start, d.tz), endDate: isoLocal(d.end || new Date(d.start.getTime() + 3 * 3600e3), d.tz),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location, image: [image], description: cut(p.description, 500) || `${tLabel(p.tipo)} ${en() ? "in" : "a"} ${placeShort(p)}`,
    offers, isAccessibleForFree: !(p.price_cents > 0),
    // performer: who runs the evening = the organizer (a sagra or a run club has no separate act); Google recommends it and otherwise warns
    ...(organizerNode ? { organizer: organizerNode, performer: organizerNode } : {}), url
  }));
  return jsonld(events.length === 1 ? events[0] : events);
}
function whenRow(d, tz, old) {
  const endTxt = d.end ? (en() ? " to " : " alle ") + fmtTime(d.end, tz) : "";
  return `<div class="when${old ? " old" : ""}"><div class="datebox"><div class="mo">${esc(fmtMonthShort(d.start, tz))}</div><div class="d">${esc(fmtDayNum(d.start, tz))}</div></div>
    <div><div class="t">${esc(fmtLong(d.start, tz))}</div><div class="s">${en() ? "From" : "Dalle"} <b>${esc(fmtTime(d.start, tz))}</b>${esc(endTxt)}</div></div></div>`;
}
function similar(p, n = 4) {
  const sameType = upcomingPages.filter(x => x.slug !== p.slug && x.sport === p.sport);
  const sameTown = p.town ? upcomingPages.filter(x => x.slug !== p.slug && x.town === p.town && x.sport !== p.sport) : [];
  const seen = new Set(); const out = [];
  for (const x of [...sameType, ...sameTown, ...upcomingPages]) { if (x.slug !== p.slug && !seen.has(x.slug)) { seen.add(x.slug); out.push(x); } if (out.length >= n) break; }
  return out;
}
// one sentence that answers "what, where, when, how much" before anything else: what answer engines quote
function eventSummary(p, org, first) { return en() ? eventSummaryEn(p, org, first) : eventSummaryIt(p, org, first); }
function eventSummaryEn(p, org, first) {
  const tz = p.tz, where = placeShort(p), last = p.up[p.up.length - 1];
  const orgTxt = org.kind === "gruppo" ? ` Organised by ${org.name}.` : "";
  const kind = p.sport === "festival" ? "Town festival" : tLabel(p.tipo);
  if (p.isPast) return `${kind} in ${where}: it already took place, the last date was ${fmtLong(first.start, tz)}.${orgTxt}`;
  const when = `${fmtDay(first.start, tz)} at ${fmtTime(first.start, tz)}${p.up.length > 1 ? ` (${p.up.length} dates, until ${fmtShort(last.start, tz)})` : ""}`;
  const going = p.going > 0 ? ` ${p.going} ${p.going === 1 ? "person has" : "people have"} already said they're going.` : "";
  return `${kind} in ${where}, ${when}. ${fmtPrice(p.price_cents)}${p.price_note ? ` (${p.price_note})` : ""}.${orgTxt}${going}`;
}
function eventSummaryIt(p, org, first) {
  const tz = p.tz, where = placeShort(p), last = p.up[p.up.length - 1];
  const orgTxt = org.kind === "gruppo" ? ` Lo organizza ${org.name}.` : "";
  const kind = p.sport === "festival" ? "Festa di paese" : p.tipo.label; // the catalogue label is plural ("Feste, sagre ed eventi di paese")
  if (p.isPast) return `${kind} a ${where}: si è già svolto, l'ultima data è stata ${fmtLong(first.start, tz).toLowerCase()}.${orgTxt}`;
  const when = `${fmtDay(first.start, tz).toLowerCase()} alle ${fmtTime(first.start, tz)}${p.up.length > 1 ? ` (${p.up.length} date, fino al ${fmtShort(last.start, tz)})` : ""}`;
  const going = p.going > 0 ? ` ${p.going} ${p.going === 1 ? "persona ha già detto che ci va" : "persone hanno già detto che ci vanno"}.` : "";
  return `${kind} a ${where}, ${when}. ${fmtPrice(p.price_cents)}${p.price_note ? ` (${p.price_note})` : ""}.${orgTxt}${going}`;
}
// questions people actually type ("quando è la festa di X", "quanto costa"), answered from the data only
function eventFaq(p, org) { return en() ? eventFaqEn(p, org) : eventFaqIt(p, org); }
function eventFaqEn(p, org) {
  const tz = p.tz, where = placeShort(p);
  const endOk = (d) => d.end && fmtTime(d.end, tz) !== "23:59";
  const dayAt = (d) => `${fmtDay(d.start, tz)} at ${fmtTime(d.start, tz)}${endOk(d) ? ` (until ${fmtTime(d.end, tz)})` : ""}`;
  const when = p.isPast
    ? `${p.title} already took place: the last date was ${fmtLong(p.dates[p.dates.length - 1].start, tz)}. If it comes back, the new dates appear on this anyplans page.`
    : p.up.length === 1
      ? `${p.title} takes place on ${dayAt(p.up[0])}, in ${where}.`
      : `${p.title} has ${p.up.length} dates, from ${fmtShort(p.up[0].start, tz)} to ${fmtShort(p.up[p.up.length - 1].start, tz)}: ${joinIt(p.up.slice(0, 6).map(dayAt))}${p.up.length > 6 ? " and more" : ""}.`;
  const place = p.meeting
    ? `The meeting point is ${p.meeting}${p.town && !norm(p.meeting).includes(norm(p.town)) ? `, ${p.town}` : ""}${p.lat != null && p.lng != null ? ", in the province of Bergamo; the page has a link to the map" : ""}.`
    : p.town ? `In ${p.town}, in the province of Bergamo. The organiser shares the exact place after you sign up.`
    : `In the Bergamo area: the organiser shares the exact place after you sign up on anyplans.`;
  const price = p.price_cents > 0
    ? `${p.title} costs ${fmtPrice(p.price_cents)}${p.price_note ? ` (${p.price_note})` : ""}.`
    : `${p.title} is free: no ticket needed${p.price_note ? ` (${p.price_note})` : ""}.`;
  const who = org.kind === "gruppo" ? `It is organised by ${org.name}, a group that publishes its events on anyplans: on its page you find the other dates and the contacts.`
    : org.kind === "club" ? (p.town ? `It is a village event in ${p.town}: anyplans collects it from the programme published by the town council, the parish or the association, and shows you who else is going.` : `It is organised by ${org.name}. anyplans collects the event and shows you who else is going.`)
    : p.host_name ? `It is organised by ${org.name}, a member of anyplans${p.admins.length ? `, together with ${p.admins.join(", ")}` : ""}.`
    : `It is organised by a member of anyplans.`;
  return [
    { q: `When ${p.isPast ? "was" : "is"} ${p.title}?`, a: when },
    { q: `Where is ${p.title}?`, a: place },
    { q: `How much does ${p.title} cost?`, a: price },
    { q: `Who organises ${p.title}?`, a: who },
    { q: `How do I join ${p.title}?`, a: `Sign up on anyplans with your email, open the event and say you're going: you see who organises it and who else is coming, so you don't go alone. You must be 18 or older.` },
  ];
}
function eventFaqIt(p, org) {
  const tz = p.tz, where = placeShort(p);
  const endOk = (d) => d.end && fmtTime(d.end, tz) !== "23:59";
  const dayAt = (d) => `${fmtDay(d.start, tz).toLowerCase()} alle ${fmtTime(d.start, tz)}${endOk(d) ? ` (fino alle ${fmtTime(d.end, tz)})` : ""}`;
  const dal = (d) => (/^(8|11)\b/.test(fmtShort(d.start, tz)) ? "dall'" : "dal ") + fmtShort(d.start, tz);
  const when = p.isPast
    ? `${p.title} si è già svolto: l'ultima data è stata ${fmtLong(p.dates[p.dates.length - 1].start, tz).toLowerCase()}. Se torna, le date nuove compaiono su questa pagina di anyplans.`
    : p.up.length === 1
      ? `${p.title} si tiene ${dayAt(p.up[0])}, a ${where}.`
      : `${p.title} ha ${p.up.length} date, ${dal(p.up[0])} al ${fmtShort(p.up[p.up.length - 1].start, tz)}: ${joinIt(p.up.slice(0, 6).map(dayAt))}${p.up.length > 6 ? " e altre" : ""}.`;
  const place = p.meeting
    ? `Il ritrovo è a ${p.meeting}${p.town && !norm(p.meeting).includes(norm(p.town)) ? `, ${p.town}` : ""}${p.lat != null && p.lng != null ? ", in provincia di Bergamo; nella pagina c'è il collegamento alle mappe" : ""}.`
    : p.town ? `A ${p.town}, in provincia di Bergamo. Il luogo esatto lo comunica chi organizza dopo che ti sei iscritto.`
    : `Nella zona di Bergamo: il luogo esatto lo comunica chi organizza dopo che ti sei iscritto su anyplans.`;
  const price = p.price_cents > 0
    ? `${p.title} costa ${fmtPrice(p.price_cents)}${p.price_note ? ` (${p.price_note})` : ""}.`
    : `${p.title} è gratis: non serve biglietto${p.price_note ? ` (${p.price_note})` : ""}.`;
  const who = org.kind === "gruppo" ? `Lo organizza ${org.name}, un gruppo che pubblica i suoi eventi su anyplans: nella sua pagina trovi le altre date e i contatti.`
    : org.kind === "club" ? (p.town ? `È un evento di paese a ${p.town}: anyplans lo raccoglie dal programma pubblicato dal comune, dall'oratorio o dall'associazione, e ti fa vedere chi altro ci va.` : `Lo organizza ${org.name}. anyplans raccoglie l'evento e ti fa vedere chi altro ci va.`)
    : p.host_name ? `Lo organizza ${org.name}, una persona registrata su anyplans${p.admins.length ? `, insieme a ${p.admins.join(", ")}` : ""}.`
    : `Lo organizza una persona registrata su anyplans.`;
  return [
    { q: `Quando si tiene ${p.title}?`, a: when },
    { q: `Dove si trova ${p.title}?`, a: place },
    { q: `Quanto costa ${p.title}?`, a: price },
    { q: `Chi organizza ${p.title}?`, a: who },
    { q: `Come faccio a partecipare a ${p.title}?`, a: `Ti registri su anyplans con la tua email, apri l'evento e dici che ci vai: così vedi chi organizza e chi altro viene, e non ci vai da solo. Serve avere almeno 18 anni.` },
  ];
}
function eventPage(p) {
  const url = eventUrl(p);
  const tz = p.tz, t = p.tipo, org = organizer(p);
  const hasMap = p.visibility === "open" && p.lat != null && p.lng != null && !p.isPast;
  const where = placeShort(p);
  const faq = eventFaq(p, org);
  const first = p.up[0] || p.dates[p.dates.length - 1];
  const full = `${p.title} ${en() ? "in" : "a"} ${where}, ${fmtShort(first.start, tz)}`;
  // long titles from the sources ("Festa X, Oratorio Y – Paese"): keep the part before the first separator when it stands alone
  const head = p.title.split(/ – |, /)[0];
  const title = (full.length <= 49 ? full : head.length >= 12 && head.length <= 49 ? head : cut(p.title, 49)) + " | anyplans";
  const descr = en()
    ? (p.isPast
      ? cut(`${tLabel(t)} in ${where}. Last date: ${fmtShort(first.start, tz)}. This event is over: on anyplans you find the next dates and similar events.`, 160)
      : cut(`${tLabel(t)} in ${where}, ${fmtDay(first.start, tz)} at ${fmtTime(first.start, tz)}. ${cut(p.description, 100) || ""} ${fmtPrice(p.price_cents)}. Go with others.`.replace(/\s+/g, " ").replace(/\.\s*\./g, "."), 160))
    : p.isPast
    ? cut(`${t.label} a ${where}. Ultima data: ${fmtShort(first.start, tz)}. Questo evento è passato: su anyplans trovi le prossime date e gli eventi simili.`, 160)
    : cut(`${t.label} a ${where} ${fmtDay(first.start, tz).toLowerCase()} alle ${fmtTime(first.start, tz)}. ${cut(p.description, 100) || ""} ${fmtPrice(p.price_cents)}. Ci vai insieme ad altri.`.replace(/\s+/g, " ").replace(/\.\s*\./g, "."), 160);
  const image = p.photo ? photoSrc(p.photo) : OG_DEFAULT;
  const sim = similar(p);
  const typeIndex = types.find(x => x.sport === p.sport);
  const townIndex = p.town ? towns.find(x => x.town === p.town) : null;
  const crumbItems = [["anyplans", L.home], [CITY_NAME, rel(hubUrl())]];
  if (typeIndex) crumbItems.push([tLabel(t), rel(indexUrl(typeIndex))]);
  crumbItems.push([p.title, null]);
  const E = en();
  const S = E ? { maps: "Open in Maps", past: "Past event", going1: "1 person is going", goingN: `${p.going} are going`, full: "full",
      free1: "spot left", freeN: "spots left", first: `Organised by ${esc(org.name)}: be the first to join`, join: "I'm going", pastTitle: "This event is over",
      pastTxt: `The last date was ${esc(fmtLong(first.start, tz))}. If it comes back, the new dates appear here.`, now: "See what's on now", dates: "The dates", when: "When",
      pastDates: "Past dates", where: "Where", area: `Approximate area: ${esc(CITY_NAME)} and surroundings, exact place after approval.`, about: "What it is", price: "Price",
      who: "Who's going", of: "of", whoSee: "You see who's going once you sign up.", org: "Organiser", groupOn: "Group on anyplans", council: "Town council or association", organises: "Organises",
      collab: "Co-organiser", with: "Together with", allEvents: "See all events", official: "Details on the official website", similar: "Similar events", until: "until", openMaps: "open in maps →", zone: "Approximate area" }
    : { maps: "Apri in Mappe", past: "Evento passato", going1: "1 persona ci va", goingN: `${p.going} ci vanno`, full: "pieno",
      free1: "posto libero", freeN: "posti liberi", first: `Organizzato da ${esc(org.name)}: sei il primo ad aggiungerti`, join: "Ci vado", pastTitle: "Questo evento è passato",
      pastTxt: `L'ultima data è stata ${esc(fmtLong(first.start, tz).toLowerCase())}. Se torna, le date nuove compaiono qui.`, now: "Vedi cosa c'è adesso", dates: "Le date", when: "Quando",
      pastDates: "Date già passate", where: "Dove", area: `Zona indicativa: ${esc(CITY_NAME)} e dintorni, luogo esatto dopo l'approvazione.`, about: "Di cosa si tratta", price: "Prezzo",
      who: "Chi ci va", of: "su", whoSee: "Chi ci va lo vedi quando ti iscrivi.", org: "Chi organizza", groupOn: "Gruppo su anyplans", council: "Comune o associazione", organises: "Organizza",
      collab: "Collaboratore", with: "Insieme a", allEvents: "Vedi tutti gli eventi", official: "Dettagli sul sito ufficiale", similar: "Eventi simili", until: "fino alle", openMaps: "apri nelle mappe →", zone: "Zona indicativa" };
  const joinTitle = E ? (p.going >= 2 ? `Join ${p.going} people` : p.going === 1 ? "Join 1 person" : org.kind === "gruppo" ? "Join: the event is already on" : "Are you in?")
    : (p.going >= 2 ? `Aggiungiti a ${p.going} persone` : p.going === 1 ? "Aggiungiti a 1 persona" : org.kind === "gruppo" ? "Aggiungiti: l'evento c'è già" : "Ci sei?");
  const spots = p.max ? ` · ${p.going >= p.max ? S.full : `${p.max - p.going} ${p.max - p.going === 1 ? S.free1 : S.freeN}`}` : "";

  const body = `
${crumbs(crumbItems)}
<div class="cover">${hasMap ? `<a id="map" href="${esc(mapsUrl(p.lat, p.lng))}" rel="noopener" aria-label="${S.maps}"></a>` : p.photo ? `<img src="${esc(photoSrc(p.photo))}" alt="${esc(p.title)}" width="800" height="230" loading="lazy" decoding="async">` : p.emoji}</div>
<div class="chips"><span class="chip">${p.emoji} ${esc(tLabel(t))}</span><span class="chip w">${esc(fmtPrice(p.price_cents))}</span>${p.isPast ? `<span class="chip past">${S.past}</span>` : ""}${townIndex ? `<a class="chip w" href="${rel(indexUrl(townIndex))}">${esc(p.town)}</a>` : ""}</div>
<h1>${esc(p.title)}</h1>
${p.isPast ? "" : `<div class="when hero-when"><div class="datebox"><div class="mo">${esc(fmtMonthShort(first.start, tz))}</div><div class="d">${esc(fmtDayNum(first.start, tz))}</div></div>
  <div><div class="t"><span class="rel-day" data-start="${first.start.toISOString()}"></span>${esc(fmtDay(first.start, tz))} · <b>${esc(fmtTime(first.start, tz))}</b>${first.end ? ` <span class="s">(${S.until} ${esc(fmtTime(first.end, tz))})</span>` : ""}<b class="rel" data-start="${first.start.toISOString()}"${first.end ? ` data-end="${first.end.toISOString()}"` : ""}></b></div>
  ${hasMap ? `<a class="s place" href="${esc(mapsUrl(p.lat, p.lng))}" rel="noopener">${esc(p.meeting || S.zone)} · ${S.openMaps}</a>` : p.meeting ? `<div class="s">${esc(p.meeting)}</div>` : ""}</div></div>
<div class="box">
  <h2>${joinTitle}</h2>
  <div class="cta"><a class="btn" href="/${CITY}/evento.html?id=${esc(p.id)}&amp;join=1">${S.join}</a><span class="m">${p.going > 0 ? `${p.going === 1 ? S.going1 : S.goingN}${spots}` : S.first}</span></div>
</div>`}
<p class="lead">${esc(eventSummary(p, org, first))}</p>
${p.isPast ? `<div class="box in"><h2>${S.pastTitle}</h2><div class="m">${S.pastTxt}</div><div class="cta"><a class="btn" href="/${CITY}/eventi.html">${S.now}</a></div></div>` : ""}
${p.isPast || p.up.length > 1 || p.past.length ? `<div class="box">
  <h2>${p.up.length > 1 ? S.dates : S.when}</h2>
  ${p.up.map(d => whenRow(d, tz, false)).join("\n")}
  ${p.past.length ? (p.up.length ? `<div class="m">${S.pastDates}</div>` : "") + p.past.slice(-12).reverse().map(d => whenRow(d, tz, true)).join("\n") : ""}
</div>` : ""}
${hasMap ? "" : `<div class="box">
  <h2>${S.where}</h2>
  ${p.meeting ? `<div>${esc(p.meeting)}${p.town && !norm(p.meeting).includes(norm(p.town)) ? `, ${esc(p.town)}` : ""}</div>` : `<div>${S.area}</div>`}
  ${p.visibility === "open" && p.lat != null && p.lng != null ? `<div><a class="lnk" href="${esc(mapsUrl(p.lat, p.lng))}" rel="noopener">${S.maps}</a></div>` : ""}
</div>`}
${p.description ? `<div class="box"><h2>${S.about}</h2>${E ? `<div class="m">${/[a-z]/i.test(p.description) ? "Description as written by the organiser, in Italian." : ""}</div>` : ""}<div class="desc">${esc(p.description)}</div></div>` : ""}
<div class="box">
  <h2>${S.price}</h2>
  <div><b>${esc(fmtPrice(p.price_cents))}</b>${p.price_note ? ` <span class="m">${esc(p.price_note)}</span>` : ""}</div>
</div>
${p.going > 0 && !p.isPast ? `<div class="box">
  <h2>${S.who} <span class="s">(${p.going})</span></h2>
  <div><b style="color:#1E8E3E">${p.going === 1 ? (E ? "1 is going" : "1 ci va") : (E ? `${p.going} are going` : `${p.going} ci vanno`)}</b>${p.max ? ` <span class="m">· ${p.going >= p.max ? S.full : `${p.max - p.going} ${p.max - p.going === 1 ? S.free1 : S.freeN} ${S.of} ${p.max}`}</span>` : ""}</div>
  ${p.max ? `<div style="height:8px;border-radius:999px;background:#E6F4EA;overflow:hidden"><i style="display:block;height:100%;width:${Math.min(100, Math.round(p.going / p.max * 100))}%;background:${p.going >= p.max ? "#B3261E" : "#1E8E3E"};border-radius:999px"></i></div>` : ""}
  <div class="m">${S.whoSee}</div>
</div>` : ""}
<div class="box">
  <h2>${S.org}</h2>
  <div class="row">${org.kind === "gruppo" ? `<div class="avatar">${p.community_avatar ? `<img src="${esc(p.community_avatar)}" alt="" width="40" height="40" loading="lazy">` : esc(org.name[0].toUpperCase())}</div><div><a class="n" href="${esc(org.url)}">${esc(org.name)}</a><div class="s">${S.groupOn}</div></div>`
    : org.kind === "club" ? `<div><div class="n">${esc(org.name)}</div><div class="s">${S.council}</div></div>`
    : `<div class="avatar">${esc(org.name[0].toUpperCase())}</div><div><div class="n">${esc(org.name)}</div><div class="s">${S.organises}</div></div>`}</div>
  ${p.admins.map(n => `<div class="row"><div class="avatar" style="background:var(--tint);color:var(--blue)">${esc(n[0].toUpperCase())}</div><div><div class="n">${esc(n)}</div><div class="s">${S.collab}</div></div></div>`).join("\n  ")}
${p.co.length ? `<div class="box"><h2>${S.with}</h2><div class="tags">${p.co.map(slug => { const c = groups.find(x => x.slug === slug); return c ? `<a href="${esc(groupUrl(c))}">${c.emoji || "👥"} ${esc(c.name)}</a>` : ""; }).join("")}</div></div>` : ""}
</div>
<div class="cta">
  ${p.isPast ? "" : `<a class="btn" href="/${CITY}/evento.html?id=${esc(p.id)}&amp;join=1">${S.join}</a>`}
  <a class="btn ghost" href="/${CITY}/eventi.html">${S.allEvents}</a>
  ${p.source_url && p.source !== "ugc" ? `<a class="lnk" href="${esc(p.source_url)}" rel="noopener nofollow">${S.official}</a>` : ""}
</div>
${faqHtml(faq)}
${sim.length ? `<h2>${S.similar}</h2>${listHtml(sim)}` : ""}
`;
  // Logged-in visitors (session in storage, same key as app.js) jump to the app page, which has join state, faces and
  // live counts; crawlers and visitors without an account have empty storage and stay on this static page.
  const appScript = p.isPast ? "" : `<script>(function(){try{var s=JSON.parse(localStorage.getItem("anyplans_session")||sessionStorage.getItem("anyplans_session")||"null");if(s&&s.access_token)location.replace("/${CITY}/evento.html?id=${esc(p.id)}");}catch(_){}})();</script>`;
  const mapHead = appScript + (hasMap ? `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.css">` : "");
  const mapScript = hasMap ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min.js"></script>
<script>
  (function(){ var lat = ${Number(p.lat)}, lng = ${Number(p.lng)};
    var map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/liberty", center: [lng, lat], zoom: 14.5, interactive: false, attributionControl: false });
    var el = document.createElement("div");
    el.style.cssText = "width:40px;height:40px;background:#1B4FD8;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:19px;box-shadow:0 1px 5px rgba(0,0,0,.2)";
    el.textContent = ${JSON.stringify(p.emoji || "📍")};
    new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  })();
</script>` : "";
  const relScript = p.isPast ? "" : `<script>
  (function(){ var el = document.querySelector(".rel"), day = document.querySelector(".rel-day"); if (!el) return;
    var s = new Date(el.dataset.start), e = el.dataset.end ? new Date(el.dataset.end) : new Date(s.getTime() + 3 * 3600e3), now = new Date();
    var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()), diffDays = Math.round((new Date(s.getFullYear(), s.getMonth(), s.getDate()) - d0) / 864e5);
    var T = ${JSON.stringify(E ? { today: "Today · ", tomorrow: "Tomorrow · ", now: "happening now", in: "in ", day: " day", days: " days" } : { today: "Oggi · ", tomorrow: "Domani · ", now: "in corso adesso", in: "tra ", day: " giorno", days: " giorni" })};
    if (day) day.textContent = diffDays === 0 ? T.today : diffDays === 1 ? T.tomorrow : "";
    var min = Math.round((s - now) / 60000), txt = "";
    if (now >= s && now <= e) { txt = T.now; el.classList.add("now"); }
    else if (min > 0 && min < 60) txt = T.in + min + " min";
    else if (min > 0 && min < 1440) { var h = Math.floor(min / 60), m = min % 60; txt = T.in + h + " h" + (m ? " " + m + " min" : ""); }
    else if (min > 0 && diffDays <= 7) txt = T.in + diffDays + (diffDays === 1 ? T.day : T.days);
    el.textContent = txt ? "· " + txt : "";
  })();
</script>`;
  return layout({ title, description: descr, url, image, jsonLd: [eventJsonLd(p, url), faqLd(faq)].filter(Boolean).join("\n"), body: body + mapScript + relScript, ogType: "article", modified: p.updated, head: mapHead,
    alt: inLocale(E ? "it" : "en", () => eventUrl(p)) });
}

// ── run club (0070: community.sport = 'running' | 'walking', community_schedule) ────────────
const WEEKDAYS_IT = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];
const WEEKDAYS = new Proxy([], { get: (_, k) => L.days[k] }); // day names in the active language
const isRunClub = g => g.sport === "running" || g.sport === "walking";
const runClubs = groups.filter(isRunClub);
const hhmm = t => String(t || "").slice(0, 5);
const initial = g => `<span class="ini">${esc((g.name || "?").trim()[0].toUpperCase())}</span>`;
const logoHtml = g => g.avatar_url ? `<img src="${esc(g.avatar_url)}" alt="" width="56" height="56" loading="lazy">` : initial(g);
function costChip(g, sch) {
  const txt = ((sch || []).map(x => x.note || "").join(" ") + " " + (g.description || "")).toLowerCase();
  if (/tesseramento|€|euro|a pagamento|rimborso/.test(txt)) return `<span class="cost">${en() ? "Membership or fee" : "Tesseramento o quota"}</span>`;
  if (/gratis|gratuit/.test(txt)) return `<span class="cost">${L.free}</span>`;
  return "";
}
const IG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>';
const WA_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 L5.3 15.9 A8.5 8.5 0 1 1 8.4 18.9 Z"/><path d="M9 9.5 c0 3 2.5 5.5 5.5 5.5 l1.2-1.4 -1.8-1 -0.9 0.9 c-1.2-0.5-2-1.3-2.5-2.5 l0.9-0.9 -1-1.8 Z" fill="currentColor" stroke="none"/></svg>';
const igLink = g => g.instagram_handle ? `<a class="ig" href="https://instagram.com/${esc(String(g.instagram_handle).replace(/^@/, ""))}" rel="noopener" aria-label="${en() ? "Instagram of" : "Instagram di"} ${esc(g.name)}">${IG_SVG}@${esc(String(g.instagram_handle).replace(/^@/, ""))}</a>` : "";
const waLink = g => g.whatsapp_url ? `<a class="ig wa" href="${esc(g.whatsapp_url)}" rel="noopener" aria-label="${en() ? "WhatsApp group of" : "Gruppo WhatsApp di"} ${esc(g.name)}">${WA_SVG}WhatsApp</a>` : "";
function meetLine(x) { return `${WEEKDAYS[x.weekday]} · <b>${esc(hhmm(x.start_time))}</b>${x.meeting_point_text ? ` · ${esc(x.meeting_point_text)}` : ""}`; }
function rcCard(g, x) {
  const sch = schedules.filter(s => s.community_slug === g.slug);
  const when = x ? `<div class="when">${meetLine(x)}</div>`
                 : sch.length ? `<div class="when">${sch.slice(0, 2).map(meetLine).join("<br>")}</div>`
                 : `<div class="when unknown">${en() ? "Day and time: ask on Instagram" : "Giorno e orario: chiedi su Instagram"}</div>`;
  return `<div class="rc"><div class="logo">${logoHtml(g)}</div><div class="body"><div class="name">${esc(g.name)}</div>${when}</div><div class="foot">${costChip(g, sch)}${igLink(g)}${waLink(g)}</div><a class="go" href="${esc(groupUrl(g))}">${en() ? "See the group" : "Vedi il gruppo"}</a></div>`;
}
const FAQ = [
  { q: "Devo essere allenato per correre con un run club a Bergamo?", a: "No. Quasi tutti i run club di Bergamo sono aperti a chiunque: si corre a ritmo tranquillo e spesso ci sono più gruppi per passo. Basta presentarsi al ritrovo con scarpe da corsa. Se non hai mai corso, Fun Run a Calcinate è un vero corso per imparare, e Sabato alla Trucca è pensato anche per chi cammina." },
  { q: "Quanto costa entrare in un run club?", a: "Nella maggior parte dei casi niente: ci si presenta e si corre. Alcuni gruppi chiedono un tesseramento annuale (per esempio i Podisti Insonni, 35 euro) o una quota per l'assicurazione. Nella pagina di ogni club trovi scritto se è gratis." },
  { q: "Che giorno e a che ora si corre?", a: "Ogni club ha il suo giorno fisso: il lunedì PTRUNBG alle 18:15 al parco della Trucca e MRCBG alle 18:45 a Osio Sotto, il martedì Le Scalette del Martedì alle 19, il mercoledì Cor Run alle 18:45 alla Trucca, il sabato mattina Sabato alla Trucca. L'elenco completo per giorno è in cima a questa pagina." },
  { q: "Quanti chilometri si fanno?", a: "Di solito tra i 5 e i 10 chilometri, in un'ora circa. Le uscite in pista (giovedì ad Azzano, mercoledì a Mozzo) sono allenamenti più strutturati; le uscite del fine settimana possono essere più lunghe. Ogni club lo scrive nel ritrovo." },
  { q: "Devo iscrivermi prima?", a: "Quasi mai. Per sapere se il gruppo esce davvero quella settimana, il posto giusto è il gruppo WhatsApp o la pagina Instagram del club, che trovi nella sua pagina qui su anyplans. Se ti registri su anyplans puoi dire che ci vai e vedere chi altro viene." },
  { q: "Qual è il run club più grande di Bergamo?", a: "Dipende da cosa cerchi: Runners Bergamo è la società storica con più gruppi di allenamento e gare organizzate, Cor Run e WeRunBergamo sono i gruppi serali più frequentati in città, PTRUNBG e MRCBG i più regolari del lunedì. Tutti e ventiquattro sono in questa pagina." },
];
const FAQ_EN = [
  { q: "Do I need to be fit to run with a running club in Bergamo?", a: "No. Almost every run club in Bergamo is open to anyone: the pace is easy and there are often several groups by pace. Just show up at the meeting point with running shoes. If you have never run, Fun Run in Calcinate is a real beginners' course, and Sabato alla Trucca also welcomes walkers." },
  { q: "How much does it cost to join a run club?", a: "In most cases nothing: you show up and run. Some clubs ask for a yearly membership (for example Podisti Insonni, 35 euros) or a fee for the insurance. Each club's page says whether it is free." },
  { q: "Which day and what time do they run?", a: "Every club has its fixed day: on Monday PTRUNBG at 18:15 at Trucca park and MRCBG at 18:45 in Osio Sotto, on Tuesday Le Scalette del Martedì at 19:00, on Wednesday Cor Run at 18:45 at the Trucca, on Saturday morning Sabato alla Trucca. The full list by day is at the top of this page." },
  { q: "How many kilometres do they run?", a: "Usually between 5 and 10 kilometres, in about an hour. Track sessions (Thursday in Azzano, Wednesday in Mozzo) are more structured workouts; weekend runs can be longer. Each club writes it in its meeting point." },
  { q: "Do I need to register first?", a: "Almost never. To know whether the group really goes out that week, the right place is the club's WhatsApp group or Instagram page, which you find on its page here on anyplans. If you sign up on anyplans you can say you're going and see who else is coming." },
  { q: "I'm visiting Bergamo: can I join a run for one evening?", a: "Yes, that is exactly how these clubs work: nobody expects you to come back every week. Pick the day, show up at the meeting point a few minutes early, say hello. The run usually ends with a drink together." },
];
function runningHub() { return en() ? runningHubEn() : runningHubIt(); }
function runningHubEn() {
  const url = runningUrl();
  const title = `Run clubs in ${CITY_NAME}: ${runClubs.length} running groups, free | anyplans`;
  const lead = `Every run club and running group in ${CITY_NAME} and its province, with a group run almost every evening: pick the day, show up, run with others. Almost all of them are free, open to visitors, with no registration.`;
  const descr = cut(lead, 160);
  const byDay = L.days.map((d, i) => ({ d, i, rows: schedules.filter(s => s.weekday === i && runClubs.some(g => g.slug === s.community_slug)) }));
  const withDay = new Set(schedules.map(s => s.community_slug));
  const noDay = runClubs.filter(g => !withDay.has(g.slug));
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Running clubs in ${CITY_NAME}`, url,
    itemListElement: runClubs.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: groupUrl(g), name: g.name })) });
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], ["Groups", rel(groupsUrl())], ["Running clubs", null]])}
<h1>Running clubs in ${esc(CITY_NAME)}: run with a group, any day of the week</h1>
<p class="lead">${esc(lead)}</p>
<div class="rc-days">${byDay.map(x => `<a href="${x.rows.length ? rel(dayUrl(x.i)) : "#"}"${x.rows.length ? "" : ' aria-disabled="true"'}>${x.d}</a>`).join("")}${noDay.length ? `<a href="#others">No fixed day</a>` : ""}</div>
${byDay.filter(x => x.rows.length).map(x => `
<div class="rc-day" id="${x.d.toLowerCase()}"><h2><a href="${rel(dayUrl(x.i))}" style="color:inherit">${x.d}</a></h2><span class="n">${x.rows.length} ${x.rows.length === 1 ? "meeting point" : "meeting points"}</span></div>
<div class="rc-grid">${x.rows.map(r => rcCard(runClubs.find(g => g.slug === r.community_slug), r)).join("\n")}</div>`).join("\n")}
${noDay.length ? `
<div class="rc-day" id="others"><h2>No fixed day</h2><span class="n">${noDay.length}</span></div>
<p class="lead">They go out when they decide on the spot: the day is on their Instagram page.</p>
<div class="rc-grid">${noDay.map(g => rcCard(g, null)).join("\n")}</div>` : ""}
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">See all events</a><a class="btn ghost" href="/${CITY}/login.html">Do you run a club? Create your group</a></div>
<div class="box"><h2>How a run club works</h2>
<p>A run club is a group of people who meet at a fixed time and place to run together, usually once a week. It is not a sports club: no races, no rankings, no compulsory membership (unless stated), and you don't need to be trained. The pace is easy, often in several groups by speed, and nobody is left behind. At the end, almost always, a drink together.</p>
<p>In ${esc(CITY_NAME)} and its province there are ${runClubs.length} run clubs: from Monday at Trucca park (PTRUNBG) and in Osio Sotto (MRCBG), to Tuesday on the steps of Città Alta, to Wednesday with Cor Run, up to Saturday morning. Above you find them by day; on each club's page there are the meeting point, the next runs and the Instagram and WhatsApp contacts. This page updates itself every night.</p></div>
${faqHtml(FAQ_EN)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(FAQ_EN), body, alt: inLocale("it", runningUrl) }), lastmod: NOW };
}
function runningHubIt() {
  const url = runningUrl();
  const T = TESTI.running_club || {};
  const title = cut(T.titolo || `Running club a ${CITY_NAME}: ${runClubs.length} gruppi di corsa`, 49) + " | anyplans";
  const descr = cut(T.sotto || `${runClubs.length} run club a ${CITY_NAME} e provincia, uno quasi ogni sera: scegli il giorno, vai, corri insieme ad altri. Quasi tutti gratis.`, 160);
  const byDay = WEEKDAYS.map((d, i) => ({ d, i, rows: schedules.filter(s => s.weekday === i && runClubs.some(g => g.slug === s.community_slug)) }));
  const withDay = new Set(schedules.map(s => s.community_slug));
  const noDay = runClubs.filter(g => !withDay.has(g.slug));
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Running club a ${CITY_NAME}`, url,
    itemListElement: runClubs.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: groupUrl(g), name: g.name })) });
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, rel(hubUrl())], ["Gruppi", rel(groupsUrl())], ["Running club", null]])}
<h1>${esc(T.titolo || `Running club a ${CITY_NAME} e provincia`)}</h1>
<p class="lead">${esc(T.sotto || descr)}</p>
<div class="rc-days">${byDay.map(x => `<a href="${x.rows.length ? rel(dayUrl(x.i)) : "#"}"${x.rows.length ? "" : ' aria-disabled="true"'}>${x.d}</a>`).join("")}${noDay.length ? `<a href="#altri">Senza giorno fisso</a>` : ""}</div>
${byDay.filter(x => x.rows.length).map(x => `
<div class="rc-day" id="${x.d.toLowerCase()}"><h2><a href="${rel(dayUrl(x.i))}" style="color:inherit">${x.d}</a></h2><span class="n">${x.rows.length} ${x.rows.length === 1 ? "ritrovo" : "ritrovi"}</span></div>
<div class="rc-grid">${x.rows.map(r => rcCard(runClubs.find(g => g.slug === r.community_slug), r)).join("\n")}</div>`).join("\n")}
${noDay.length ? `
<div class="rc-day" id="altri"><h2>Senza giorno fisso</h2><span class="n">${noDay.length}</span></div>
<p class="lead">Escono quando decidono sul momento: il giorno lo trovi sulla loro pagina Instagram.</p>
<div class="rc-grid">${noDay.map(g => rcCard(g, null)).join("\n")}</div>` : ""}
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a><a class="btn ghost" href="/${CITY}/login.html">Organizzi un run club? Crea il tuo gruppo</a></div>
<div class="box"><h2>Come funziona un run club</h2>
<p>Un run club è un gruppo di persone che si trova a un'ora e in un posto fissi per correre insieme, di solito una volta a settimana. Non è una società sportiva: non ci sono gare, classifiche o tesseramenti obbligatori (salvo dove indicato), e non serve essere allenati. Si corre a ritmo tranquillo, spesso in più gruppi per passo, e chi va piano non resta indietro. Alla fine, quasi sempre, si beve qualcosa insieme.</p>
<p>A ${esc(CITY_NAME)} e provincia i run club sono ${runClubs.length}: dal lunedì al parco della Trucca (PTRUNBG) e a Osio Sotto (MRCBG), al martedì sulle scalette di Città Alta, al mercoledì con Cor Run, fino al sabato mattina. Qui sopra li trovi per giorno; nella pagina di ogni club ci sono il ritrovo, le prossime uscite e i contatti Instagram e WhatsApp. Questa pagina si aggiorna da sola ogni notte.</p></div>
${faqHtml(FAQ)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(FAQ), body, alt: inLocale("en", runningUrl) }), lastmod: NOW };
}

function runningDayPage(i) { return en() ? runningDayPageEn(i) : runningDayPageIt(i); }
function runningDayPageEn(i) {
  const d = L.days[i], rows = schedules.filter(x => x.weekday === i && runClubs.some(g => g.slug === x.community_slug));
  const url = dayUrl(i);
  const names = rows.map(r => r.community_name).join(", ");
  const title = `Run clubs in ${CITY_NAME} on ${d}: ${rows.length} ${rows.length === 1 ? "group" : "groups"} | anyplans`;
  const descr = cut(`Group runs in ${CITY_NAME} on ${d}: ${names}. Time, meeting point, Instagram and WhatsApp of every run club. Free, open to everyone, every week.`, 160);
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Run clubs in ${CITY_NAME} on ${d}`, url,
    itemListElement: rows.map((r, k) => ({ "@type": "ListItem", position: k + 1, url: groupUrl({ slug: r.community_slug }), name: r.community_name })) });
  const sorted = rows.slice().sort((a, b) => hhmm(a.start_time).localeCompare(hhmm(b.start_time)));
  const faq = [
    { q: `Which run clubs go out on ${d} in ${CITY_NAME}?`, a: `On ${d} in ${CITY_NAME} and its province ${rows.length === 1 ? "1 run club goes" : `${rows.length} run clubs go`} out: ${joinIt(sorted.map(r => `${r.community_name} at ${hhmm(r.start_time)}${r.meeting_point_text ? ` from ${r.meeting_point_text}` : ""}`))}.` },
    { q: `What time do they run on ${d} in ${CITY_NAME}?`, a: sorted.length === 1 ? `At ${hhmm(sorted[0].start_time)}, with ${sorted[0].community_name}.` : `The first meeting point is at ${hhmm(sorted[0].start_time)} (${sorted[0].community_name}), the last at ${hhmm(sorted[sorted.length - 1].start_time)} (${sorted[sorted.length - 1].community_name}). Each run lasts about an hour.` },
    { q: `Do I need to register or to be fit to run on ${d}?`, a: `No. Show up at the meeting point with running shoes: the pace is easy and nobody is left behind. To know whether the group really goes out that week, write on its WhatsApp group or on Instagram, which you find on the club's page on anyplans.` },
  ];
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], ["Running clubs", rel(runningUrl())], [d, null]])}
<h1>Run clubs in ${esc(CITY_NAME)} on <span>${d}</span></h1>
<p class="lead">${rows.length} ${rows.length === 1 ? "group goes" : "groups go"} out to run together on ${d} in ${esc(CITY_NAME)} and its province. Pick the most convenient time and place, show up at the meeting point with running shoes: no registration, no training needed.</p>
<div class="rc-days">${L.days.map((x, k) => `<a href="${rel(dayUrl(k))}"${k === i ? ' class="on"' : ""}>${x}</a>`).join("")}</div>
<div class="rc-grid">${rows.map(r => rcCard(runClubs.find(g => g.slug === r.community_slug), r)).join("\n")}</div>
<div class="box"><h2>Running on ${d} in ${esc(CITY_NAME)}</h2>
<p>${rows.map(r => `<b>${esc(r.community_name)}</b> at ${esc(hhmm(r.start_time))}${r.meeting_point_text ? ` from ${esc(r.meeting_point_text)}` : ""}${r.note ? ` (${esc(r.note)})` : ""}`).join("; ")}. Each run lasts about an hour; the group sets the pace, and nobody is left behind. If it is your first time, write on the club's WhatsApp group or Instagram to know whether they go out that week.</p>
<p><a href="${rel(runningUrl())}">All the running clubs of ${esc(CITY_NAME)}, by day →</a></p></div>
${faqHtml(faq)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("it", () => dayUrl(i)) }), lastmod: NOW };
}
function runningDayPageIt(i) {
  const d = WEEKDAYS[i], rows = schedules.filter(x => x.weekday === i && runClubs.some(g => g.slug === x.community_slug));
  const url = dayUrl(i);
  const names = rows.map(r => r.community_name).join(", ");
  const title = `Run club a ${CITY_NAME} il ${d.toLowerCase()}: ${rows.length} ${rows.length === 1 ? "gruppo" : "gruppi"} | anyplans`;
  const descr = cut(`Correre in gruppo a ${CITY_NAME} il ${d.toLowerCase()}: ${names}. Orario, punto di ritrovo, Instagram e WhatsApp di ogni run club. Gratis, aperti a tutti, ogni settimana.`, 160);
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Run club a ${CITY_NAME} il ${d.toLowerCase()}`, url,
    itemListElement: rows.map((r, k) => ({ "@type": "ListItem", position: k + 1, url: groupUrl({ slug: r.community_slug }), name: r.community_name })) });
  const sorted = rows.slice().sort((a, b) => hhmm(a.start_time).localeCompare(hhmm(b.start_time)));
  const faq = [
    { q: `Quali run club escono il ${d.toLowerCase()} a ${CITY_NAME}?`, a: `Il ${d.toLowerCase()} a ${CITY_NAME} e provincia escono ${rows.length} run club: ${joinIt(sorted.map(r => `${r.community_name} alle ${hhmm(r.start_time)}${r.meeting_point_text ? ` a ${r.meeting_point_text}` : ""}`))}.` },
    { q: `A che ora si corre il ${d.toLowerCase()} a ${CITY_NAME}?`, a: sorted.length === 1 ? `Alle ${hhmm(sorted[0].start_time)}, con ${sorted[0].community_name}.` : `Il primo ritrovo è alle ${hhmm(sorted[0].start_time)} (${sorted[0].community_name}), l'ultimo alle ${hhmm(sorted[sorted.length - 1].start_time)} (${sorted[sorted.length - 1].community_name}). Ogni uscita dura circa un'ora.` },
    { q: `Devo iscrivermi o essere allenato per correre il ${d.toLowerCase()}?`, a: `No. Ti presenti al ritrovo con le scarpe da corsa: si corre a ritmo tranquillo e chi va piano non resta indietro. Per sapere se quella settimana il gruppo esce davvero, scrivi sul suo gruppo WhatsApp o su Instagram, che trovi nella pagina del club su anyplans.` },
  ];
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, rel(hubUrl())], ["Running club", rel(runningUrl())], [d, null]])}
<h1>Run club a ${esc(CITY_NAME)} il <span>${d.toLowerCase()}</span></h1>
<p class="lead">${rows.length} ${rows.length === 1 ? "gruppo esce" : "gruppi escono"} a correre insieme il ${d.toLowerCase()} a ${esc(CITY_NAME)} e provincia. Scegli l'orario e il posto più comodo, presentati al ritrovo con le scarpe da corsa: non serve iscriversi né essere allenati.</p>
<div class="rc-days">${L.days.map((x, k) => `<a href="${rel(dayUrl(k))}"${k === i ? ' class="on"' : ""}>${x}</a>`).join("")}</div>
<div class="rc-grid">${rows.map(r => rcCard(runClubs.find(g => g.slug === r.community_slug), r)).join("\n")}</div>
<div class="box"><h2>Correre il ${d.toLowerCase()} a ${esc(CITY_NAME)}</h2>
<p>${rows.map(r => `<b>${esc(r.community_name)}</b> alle ${esc(hhmm(r.start_time))}${r.meeting_point_text ? ` a ${esc(r.meeting_point_text)}` : ""}${r.note ? ` (${esc(r.note.toLowerCase())})` : ""}`).join("; ")}. Ogni uscita dura circa un'ora; il ritmo lo fa il gruppo, e chi va piano non resta indietro. Se è la prima volta, scrivi sul gruppo WhatsApp o su Instagram del club per sapere se quella settimana si esce.</p>
<p><a href="${rel(runningUrl())}">Tutti i running club di ${esc(CITY_NAME)}, per giorno →</a></p></div>
${faqHtml(faq)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("en", () => dayUrl(i)) }), lastmod: NOW };
}

// ── group pages ───────────────────────────────────────────────────────────────
function groupPage(g) {
  const url = groupUrl(g);
  const evs = pages.filter(p => p.community_slug === g.slug || p.co.includes(g.slug)).sort(byDate);
  const up = evs.filter(p => !p.isPast), past = evs.filter(p => p.isPast).reverse().slice(0, 20);
  const t = tipo(g.category); // group category is a site category, not a sport: fall back to emoji from the group
  const emoji = g.emoji || "👥";
  const E = en(), city = cap(g.city || CITY_NAME);
  let title = cut(E ? `${g.name}: group in ${city}` : `${g.name}: gruppo a ${city}`, 49) + " | anyplans";
  let descr = cut(E ? `${g.name} is a group on anyplans in ${city}${up.length ? ` with ${up.length} upcoming ${up.length === 1 ? "event" : "events"}` : ""}. ${g.description || ""}`
    : `${g.name} è un gruppo su anyplans a ${city}${up.length ? ` con ${up.length} ${up.length === 1 ? "evento in programma" : "eventi in programma"}` : ""}. ${g.description || ""}`, 160);
  const image = g.avatar_url || OG_DEFAULT;
  const sch = schedules.filter(s => s.community_slug === g.slug);
  const faq = groupFaq(g, sch, up);
  // run club: titolo e descrizione con le parole che la gente cerca ("running club Bergamo", "run club Bergamo", "corsa di gruppo")
  if (isRunClub(g) && E) {
    const when = sch.length ? `every ${L.days[sch[0].weekday]} at ${hhmm(sch[0].start_time)}${sch[0].meeting_point_text ? " · " + sch[0].meeting_point_text : ""}` : "";
    const baseT = `${g.name}: ${g.sport === "walking" ? "walking group" : "running club"} in ${CITY_NAME}`, withDay = baseT + (when ? ", " + when.split(" · ")[0] : "");
    title = (withDay.length <= 49 ? withDay : cut(baseT, 49)) + " | anyplans";
    descr = cut(`${g.name}, ${g.sport === "walking" ? "walking group" : "run club"} in ${CITY_NAME} and its province${when ? ": they run " + when : ""}. ${g.description || "Group runs, nobody runs alone."} All the running clubs of Bergamo on anyplans.`, 160);
  } else if (isRunClub(g)) {
    const when = sch.length ? `ogni ${WEEKDAYS[sch[0].weekday].toLowerCase()} alle ${hhmm(sch[0].start_time)}${sch[0].meeting_point_text ? " · " + sch[0].meeting_point_text : ""}` : "";
    const baseT = `${g.name}: ${g.sport === "walking" ? "camminate di gruppo" : "running club"} a ${CITY_NAME}`, withDay = baseT + (when ? ", " + when.split(" · ")[0] : "");
    title = (withDay.length <= 49 ? withDay : cut(baseT, 49)) + " | anyplans";
    descr = cut(`${g.name}, ${g.sport === "walking" ? "gruppo di camminata" : "run club"} a ${CITY_NAME} e provincia${when ? ": si corre " + when : ""}. ${g.description || "Corsa di gruppo, nessuno corre da solo."} Tutti i running club di Bergamo su anyplans.`, 160);
  }
  const S = E ? { groups: "Groups", verified: "Verified group", outOf: "out of 5", rev1: "review", revN: "reviews", about: "About us", descNote: "As written by the group, in Italian.", follow: "Follow the group", wa: "WhatsApp group",
      all: "See all events", next: "Upcoming events", none: "No upcoming events", empty: "When the group publishes an event, it appears here.", past: "Past events", others: `Other run clubs in ${esc(CITY_NAME)}`, allRc: "All the running clubs" }
    : { groups: "Gruppi", verified: "Gruppo verificato", outOf: "su 5", rev1: "recensione", revN: "recensioni", about: "Chi siamo", descNote: "", follow: "Segui il gruppo", wa: "Gruppo WhatsApp",
      all: "Vedi tutti gli eventi", next: "Prossimi eventi", none: "Nessun evento in programma", empty: "Quando il gruppo pubblica un evento, compare qui.", past: "Eventi già passati", others: `Altri run club a ${esc(CITY_NAME)}`, allRc: "Tutti i running club" };
  const ld = jsonld({ "@context": "https://schema.org", "@type": isRunClub(g) ? "SportsOrganization" : "Organization", name: g.name, url,
    ...(isRunClub(g) ? { sport: g.sport === "walking" ? "Walking" : "Running" } : {}),
    ...(g.avatar_url ? { logo: g.avatar_url } : {}), ...(g.description ? { description: cut(g.description, 300) } : {}),
    ...(g.instagram_handle ? { sameAs: [`https://instagram.com/${String(g.instagram_handle).replace(/^@/, "")}`] } : {}),
    address: { "@type": "PostalAddress", addressLocality: cap(g.city || CITY_NAME), addressCountry: "IT" } });
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], [S.groups, rel(groupsUrl())], [g.name, null]])}
<div class="row"><div class="avatar" style="width:64px;height:64px;font-size:26px${g.avatar_url ? "" : ";background:var(--tint)"}">${g.avatar_url ? `<img src="${esc(g.avatar_url)}" alt="" width="64" height="64">` : isRunClub(g) ? initial(g) : emoji}</div>
  <div><h1>${esc(g.name)}</h1><div class="s">${esc(city)}${g.is_verified ? ` · ${S.verified}` : ""}${g.review_count > 0 && g.review_avg != null ? ` · ${esc(E ? String(g.review_avg) : String(g.review_avg).replace(".", ","))} ${S.outOf} (${g.review_count} ${g.review_count === 1 ? S.rev1 : S.revN})` : ""}</div></div></div>
<p class="lead">${esc(groupSummary(g, sch, up))}</p>
${g.description ? `<div class="box"><h2>${S.about}</h2>${S.descNote ? `<div class="m">${S.descNote}</div>` : ""}<div class="desc">${esc(g.description)}</div></div>` : ""}
<div class="cta"><a class="btn" href="/${CITY}/community.html?slug=${esc(g.slug)}">${S.follow}</a>${g.instagram_handle ? `<a class="btn ghost ico" href="https://instagram.com/${esc(String(g.instagram_handle).replace(/^@/, ""))}" rel="noopener">${IG_SVG}Instagram</a>` : ""}${g.whatsapp_url ? `<a class="btn ghost ico wa" href="${esc(g.whatsapp_url)}" rel="noopener">${WA_SVG}${S.wa}</a>` : ""}<a class="btn ghost" href="/${CITY}/eventi.html">${S.all}</a></div>
<h2>${up.length ? S.next : S.none}</h2>
${up.length ? listHtml(up) : `<p class="lead">${S.empty}</p>`}
${past.length ? `<h2>${S.past}</h2>${listHtml(past)}` : ""}
${faq ? faqHtml(faq) : ""}
${isRunClub(g) && runClubs.length > 1 ? `<h2>${S.others}</h2><div class="rc-grid">${runClubs.filter(o => o.slug !== g.slug).slice(0, 4).map(o => rcCard(o, null)).join("\n")}</div><div class="cta"><a class="btn ghost" href="${rel(runningUrl())}">${S.allRc}</a></div>` : ""}
`;
  const lastmod = evs.length ? new Date(Math.max(...evs.map(p => p.updated))) : NOW;
  return { html: layout({ title, description: descr, url, image, jsonLd: ld + (faq ? "\n" + faqLd(faq) : ""), body, modified: lastmod, alt: inLocale(E ? "it" : "en", () => groupUrl(g)) }), lastmod };
}
function groupSummary(g, sch, up) { return en() ? groupSummaryEn(g, sch, up) : groupSummaryIt(g, sch, up); }
function groupSummaryEn(g, sch, up) {
  const city = cap(g.city || CITY_NAME);
  const followers = g.follower_count > 0 ? ` ${g.follower_count} ${g.follower_count === 1 ? "person follows" : "people follow"} it on anyplans.` : "";
  const stars = g.review_count > 0 && g.review_avg != null ? ` Rated ${g.review_avg} out of 5 (${g.review_count} ${g.review_count === 1 ? "review" : "reviews"}).` : "";
  if (isRunClub(g)) {
    const kind = g.sport === "walking" ? "walking group" : "run club";
    const when = sch.length ? ` that goes out ${joinIt(sch.map(x => `on ${L.days[x.weekday]} at ${hhmm(x.start_time)}${x.meeting_point_text ? ` from ${x.meeting_point_text}` : ""}`))}` : " with no fixed day: the outings are announced on its channels";
    return `${g.name} is a ${kind} in ${city}${when}. Open to everyone, ${g.sport === "walking" ? "walking" : "running"} at an easy pace.${followers}${stars}`;
  }
  return `${g.name} is a group in ${city} that publishes its events on anyplans${up.length ? `: ${up.length} upcoming, ${up.length === 1 ? "" : "the next one "}${lc1(whenLabel(up[0]))}` : ", with no upcoming events at the moment"}.${followers}${stars}`;
}
function groupSummaryIt(g, sch, up) {
  const city = cap(g.city || CITY_NAME);
  const followers = g.follower_count > 0 ? ` ${g.follower_count} ${g.follower_count === 1 ? "persona lo segue" : "persone lo seguono"} su anyplans.` : "";
  const stars = g.review_count > 0 && g.review_avg != null ? ` Voto ${String(g.review_avg).replace(".", ",")} su 5 (${g.review_count} ${g.review_count === 1 ? "recensione" : "recensioni"}).` : "";
  if (isRunClub(g)) {
    const kind = g.sport === "walking" ? "gruppo di camminata" : "run club";
    const when = sch.length ? ` che esce ${joinIt(sch.map(x => `il ${WEEKDAYS[x.weekday].toLowerCase()} alle ${hhmm(x.start_time)}${x.meeting_point_text ? ` da ${x.meeting_point_text}` : ""}`))}` : " senza un giorno fisso: le uscite le annuncia sui suoi canali";
    return `${g.name} è un ${kind} di ${city}${when}. Aperto a tutti, ${g.sport === "walking" ? "si cammina" : "si corre"} a ritmo tranquillo.${followers}${stars}`;
  }
  return `${g.name} è un gruppo di ${city} che pubblica i suoi eventi su anyplans${up.length ? `: ${up.length} ${up.length === 1 ? "in programma, " + whenLabel(up[0]).toLowerCase() : "in programma, il prossimo " + whenLabel(up[0]).toLowerCase()}` : ", al momento senza eventi in programma"}.${followers}${stars}`;
}
const meetTxt = (sch) => joinIt([...new Set(sch.filter(x => x.meeting_point_text).map(x => x.meeting_point_text))]);
// questions answered from community_schedule, the events and the group's own texts (nothing invented)
function groupFaq(g, sch, up) { return en() ? groupFaqEn(g, sch, up) : groupFaqIt(g, sch, up); }
function groupFaqEn(g, sch, up) {
  const ig = g.instagram_handle ? `on Instagram (@${String(g.instagram_handle).replace(/^@/, "")})` : "";
  if (!isRunClub(g)) {
    const contacts = joinIt([g.whatsapp_url ? "on its WhatsApp group" : "", ig].filter(Boolean));
    return [
      { q: `What is ${g.name}?`, a: `${g.name} is a group in ${cap(g.city || CITY_NAME)} that organises events open to everyone and publishes them on anyplans.${g.description ? " In its own words (in Italian): " + cut(g.description, 220) : ""}` },
      { q: `When is the next event of ${g.name}?`, a: up.length ? `${up[0].title}, ${lc1(whenLabel(up[0]))}${evTown(up[0]) ? `, in ${evTown(up[0]).replace(/, $/, "")}` : ""}${up.length > 1 ? `. ${up.length} upcoming events in total: they are in the list above` : ""}.` : `At the moment ${g.name} has no upcoming events: when it publishes one, it appears on this page.` },
      { q: `How do I follow ${g.name}?`, a: `Sign up on anyplans with your email, open this page and press "Follow the group": its events appear among those of the groups you follow.` },
      { q: `How do I contact ${g.name}?`, a: contacts ? `Directly ${contacts}: the links are on this page.` : `From the page of one of its events on anyplans: say you're going and you see who organises it.` },
    ];
  }
  const walk = g.sport === "walking", inf = walk ? "walk" : "run";
  const contacts = joinIt([g.whatsapp_url ? "on the WhatsApp group" : "", ig].filter(Boolean)) || "through the contacts on this page";
  const meets = sch.map(x => `on ${L.days[x.weekday]} at ${hhmm(x.start_time)}${x.meeting_point_text ? ` from ${x.meeting_point_text}` : ""}${x.note ? ` (${x.note})` : ""}`);
  const txt = (sch.map(x => x.note || "").join(" ") + " " + (g.description || "")).toLowerCase();
  const cost = /tesseramento|€|euro|a pagamento|rimborso/.test(txt) ? `${g.name} asks for a membership or a fee: the details are in the group's description above (in Italian).`
    : /gratis|gratuit/.test(txt) ? `Nothing: ${walk ? "walking" : "running"} with ${g.name} is free, you show up at the meeting point and go.`
    : `The group doesn't say: most groups in ${CITY_NAME} are free, but ask ${contacts} before your first outing.`;
  return [
    { q: `When does ${g.name} ${inf}?`, a: meets.length ? `${g.name} meets ${joinIt(meets)}, every week. If they skip a week, they write it ${contacts}.` : `${g.name} has no published fixed day: it goes out when it decides, and you find the day ${contacts}.` },
    { q: `Where is the meeting point of ${g.name}?`, a: sch.some(x => x.meeting_point_text) ? `${meetTxt(sch)}${norm(meetTxt(sch)).includes(norm(g.city || CITY_NAME)) ? "" : `, in ${cap(g.city || CITY_NAME)} or in the province`}.` : `The group shares the meeting point ${contacts}.` },
    { q: `How much does it cost to ${inf} with ${g.name}?`, a: cost },
    { q: `Do I need to register to ${inf} with ${g.name}? I'm only in Bergamo for a few days.`, a: `Usually not, and one-off visitors are welcome: show up at the meeting point with ${walk ? "comfortable shoes" : "running shoes"} and ${inf} with the others, at an easy pace. If it is your first time, let them know ${contacts}. On anyplans you can follow the group and see the next outings.` },
  ];
}
function groupFaqIt(g, sch, up) {
  if (!isRunClub(g)) {
    const contacts = joinIt([g.whatsapp_url ? "sul suo gruppo WhatsApp" : "", g.instagram_handle ? `su Instagram (@${String(g.instagram_handle).replace(/^@/, "")})` : ""].filter(Boolean));
    return [
      { q: `Cos'è ${g.name}?`, a: `${g.name} è un gruppo di ${cap(g.city || CITY_NAME)} che organizza eventi aperti a tutti e li pubblica su anyplans.${g.description ? " " + cut(g.description, 220) : ""}` },
      { q: `Quando è il prossimo evento di ${g.name}?`, a: up.length ? `${up[0].title}, ${whenLabel(up[0]).toLowerCase()}, a ${placeShort(up[0])}${up.length > 1 ? `. In tutto ${up.length} eventi in programma: sono nella lista qui sopra` : ""}.` : `Al momento ${g.name} non ha eventi in programma: quando ne pubblica uno compare in questa pagina.` },
      { q: `Come seguo ${g.name}?`, a: `Ti registri su anyplans con la tua email, apri questa pagina e premi "Segui il gruppo": i suoi eventi ti compaiono tra quelli dei gruppi che segui.` },
      { q: `Come contatto ${g.name}?`, a: contacts ? `Direttamente ${contacts}: i collegamenti sono in questa pagina.` : `Dalla pagina di un suo evento su anyplans: dici che ci vai e vedi chi organizza.` },
    ];
  }
  const verb = g.sport === "walking" ? "cammina" : "corre", inf = g.sport === "walking" ? "camminare" : "correre";
  const contacts = joinIt([g.whatsapp_url ? "sul gruppo WhatsApp" : "", g.instagram_handle ? `su Instagram (@${String(g.instagram_handle).replace(/^@/, "")})` : ""].filter(Boolean)) || "sui contatti che trovi in questa pagina";
  const meets = sch.map(x => `il ${WEEKDAYS[x.weekday].toLowerCase()} alle ${hhmm(x.start_time)}${x.meeting_point_text ? ` a ${x.meeting_point_text}` : ""}${x.note ? ` (${x.note})` : ""}`);
  const txt = (sch.map(x => x.note || "").join(" ") + " " + (g.description || "")).toLowerCase();
  const cost = /tesseramento|€|euro|a pagamento|rimborso/.test(txt) ? `${g.name} chiede un tesseramento o una quota: i dettagli sono scritti nella descrizione del gruppo qui sopra.`
    : /gratis|gratuit/.test(txt) ? `Niente: ${inf} con ${g.name} è gratis, ci si presenta al ritrovo e si parte.`
    : `Il gruppo non lo indica: nella maggior parte dei gruppi di ${CITY_NAME} è gratis, ma chiedi ${contacts} prima della prima uscita.`;
  return [
    { q: `Quando si ${verb} con ${g.name}?`, a: meets.length ? `${g.name} si trova ${joinIt(meets)}, ogni settimana. Se una settimana salta, lo scrivono ${contacts}.` : `${g.name} non ha un giorno fisso pubblicato: esce quando decide, e il giorno lo trovi ${contacts}.` },
    { q: `Dov'è il ritrovo di ${g.name}?`, a: sch.some(x => x.meeting_point_text) ? `${meetTxt(sch)}${norm(meetTxt(sch)).includes(norm(g.city || CITY_NAME)) ? "" : `, a ${cap(g.city || CITY_NAME)} o in provincia`}.` : `Il punto di ritrovo lo comunica il gruppo ${contacts}.` },
    { q: `Quanto costa ${inf} con ${g.name}?`, a: cost },
    { q: `Devo iscrivermi per ${inf} con ${g.name}?`, a: `Di solito no: ti presenti al ritrovo con ${verb === "cammina" ? "scarpe comode" : "le scarpe da corsa"} e ${verb === "cammina" ? "cammini" : "corri"} con gli altri, a ritmo tranquillo. Se è la prima volta, avvisa ${contacts}. Su anyplans puoi seguire il gruppo e vedere le prossime uscite.` },
  ];
}
function groupsIndex() { return en() ? groupsIndexEn() : groupsIndexIt(); }
function groupsIndexEn() {
  const url = groupsUrl();
  const title = `Meet people in ${CITY_NAME}: ${groups.length} groups and clubs to join | anyplans`;
  const descr = cut(`Where to meet people in ${CITY_NAME}: ${groups.length} run clubs, sports groups, associations and communities that organise events open to everyone, visitors and expats included. Follow them and see their next plans.`, 160);
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Groups in ${CITY_NAME}`, url,
    itemListElement: groups.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: groupUrl(g), name: g.name })) });
  const active = groups.filter(g => g.upcoming_count > 0).length;
  const faq = [
    { q: `What is a group on anyplans?`, a: `A group is an association, a club, a run club, a pro loco or a parish that organises events open to everyone and publishes them on anyplans. In ${CITY_NAME} and its province there are ${groups.length} groups${runClubs.length ? `, ${runClubs.length} of them run clubs` : ""}${active ? `; ${active} ${active === 1 ? "has" : "have"} upcoming events right now` : ""}.` },
    { q: `How do I follow a group?`, a: `Sign up on anyplans with your email, open the group's page and press "Follow the group": from then on its events appear among those of the groups you follow, and you see right away when it publishes a new one.` },
    { q: `How do I meet people in ${CITY_NAME}?`, a: `Join something that already happens every week: a run club (there ${runClubs.length === 1 ? "is" : "are"} ${runClubs.length} in ${CITY_NAME} and its province), a walk, a dinner, a town festival. On anyplans you see who organises it and who else is going before you show up, so you never arrive alone. It works for people who have just moved here, students and expats as much as for locals.` },
    { q: `I'm visiting Bergamo: can I join these groups?`, a: `Yes. Run clubs, walks, dinners and festivals are open to everyone, for one evening too. Pick an event, say you're going and show up: you see in advance who organises it and who else is coming.` },
    { q: `How do I create a group for my association?`, a: `Sign up, choose "Create your group" and enter name, description and contacts. Then publish the dates: whoever follows you sees them on the map and can say they're going. Every group also gets a public page on anyplans, like these.` },
  ];
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], ["Groups", null]])}
<h1>Groups in ${esc(CITY_NAME)}: meet people and join a community</h1>
<p class="lead">${esc(descr)}</p>
${runClubs.length >= 3 ? `<div class="cta"><a class="btn" href="${rel(runningUrl())}">🏃 Running clubs in ${esc(CITY_NAME)}: ${runClubs.length} groups</a></div>` : ""}
<div class="list">${groups.map(g => `<a class="card" href="${esc(groupUrl(g))}"><span class="em">${g.emoji || "👥"}</span><span><span class="t">${esc(g.name)}</span><br><span class="m">${esc(cap(g.city || CITY_NAME))}${g.upcoming_count > 0 ? ` · ${g.upcoming_count} upcoming ${g.upcoming_count === 1 ? "event" : "events"}` : ""}</span></span></a>`).join("\n")}</div>
<div class="cta"><a class="btn ghost" href="/${CITY}/login.html">Do you organise events? Create your group</a></div>
${faqHtml(faq)}
`;
  return layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("it", groupsUrl) });
}
function groupsIndexIt() {
  const url = groupsUrl();
  const title = `Gruppi a ${CITY_NAME}: ${groups.length} comunità a cui unirti | anyplans`;
  const descr = cut(`I gruppi di ${CITY_NAME} su anyplans: associazioni, club e comunità che organizzano eventi aperti a tutti. Li segui e vedi i loro prossimi piani.`, 160);
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Gruppi a ${CITY_NAME}`, url,
    itemListElement: groups.map((g, i) => ({ "@type": "ListItem", position: i + 1, url: groupUrl(g), name: g.name })) });
  const active = groups.filter(g => g.upcoming_count > 0).length;
  const faq = [
    { q: `Cos'è un gruppo su anyplans?`, a: `Un gruppo è un'associazione, un club, un run club, una pro loco o un oratorio che organizza eventi aperti a tutti e li pubblica su anyplans. A ${CITY_NAME} e provincia ci sono ${groups.length} gruppi${runClubs.length ? `, di cui ${runClubs.length} run club` : ""}${active ? `; ${active} ${active === 1 ? "ha" : "hanno"} eventi in programma adesso` : ""}.` },
    { q: `Come seguo un gruppo?`, a: `Ti registri su anyplans con la tua email, apri la pagina del gruppo e premi "Segui il gruppo": da quel momento i suoi eventi ti compaiono tra quelli dei gruppi che segui, e vedi subito quando ne pubblica uno nuovo.` },
    { q: `Come creo un gruppo per la mia associazione?`, a: `Ti registri, scegli "Crea il tuo gruppo" e inserisci nome, descrizione e contatti. Poi pubblichi le date: chi ti segue le vede sulla mappa e può dire che ci va. Ogni gruppo ha anche una pagina pubblica su anyplans, come queste.` },
  ];
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, rel(hubUrl())], ["Gruppi", null]])}
<h1>Gruppi a ${esc(CITY_NAME)}</h1>
<p class="lead">${esc(descr)}</p>
${runClubs.length >= 3 ? `<div class="cta"><a class="btn" href="${rel(runningUrl())}">🏃 Running club a ${esc(CITY_NAME)}: ${runClubs.length} gruppi</a></div>` : ""}
<div class="list">${groups.map(g => `<a class="card" href="${esc(groupUrl(g))}"><span class="em">${g.emoji || "👥"}</span><span><span class="t">${esc(g.name)}</span><br><span class="m">${esc(cap(g.city || CITY_NAME))}${g.upcoming_count > 0 ? ` · ${g.upcoming_count} ${g.upcoming_count === 1 ? "evento in programma" : "eventi in programma"}` : ""}</span></span></a>`).join("\n")}</div>
<div class="cta"><a class="btn ghost" href="/${CITY}/login.html">Organizzi eventi? Crea il tuo gruppo</a></div>
${faqHtml(faq)}
`;
  return layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("en", groupsUrl) });
}

// ── index pages (type / town) and hub ─────────────────────────────────────────
function indexPage(ix) { return en() ? indexPageEn(ix) : indexPageIt(ix); }
function indexPageEn(ix) {
  const url = indexUrl(ix);
  const list = ix.list.slice().sort(byDate);
  const up = list.filter(p => !p.isPast), past = list.filter(p => p.isPast).reverse().slice(0, Math.max(0, Math.min(20, 100 - up.length)));
  let h1, title, intro, emoji;
  const label = ix.kind === "tipo" ? tLabel(ix.t) : "";
  if (ix.kind === "tipo") {
    h1 = ix.sport === "festival" ? `Town festivals and sagre in ${CITY_NAME} and its province` : ix.sport === "estivo" ? `Summer venues in ${CITY_NAME}: open-air bars and evenings` : `${label} in ${CITY_NAME} and its province`; emoji = ix.t.e;
    title = cut(`${ix.sport === "festival" ? "Festivals & sagre near" : label + " in"} ${CITY_NAME}`, 36) + (up.length ? `: ${up.length} ${up.length === 1 ? "event" : "events"}` : "") + " | anyplans";
    const nounIntro = { festival: "town festivals and sagre", estivo: "summer venue evenings", dinner: "dinners and aperitivo", running: "group runs and races", padel: "padel matches and tournaments", walking: "group walks" }[ix.sport] || `${label.toLowerCase()} events`;
    intro = `${up.length ? `In ${CITY_NAME} and its province there are ${up.length} ${nounIntro} in the coming months.` : `There are no ${nounIntro} scheduled right now: below, the past ones.`} ${tPhrase(ix.t)}`;
  } else {
    h1 = `Festivals and events in ${ix.town} (Bergamo)`; emoji = "🎉";
    title = cut(`Festivals and events in ${ix.town}, Bergamo${up.length ? ": " + up.length + " upcoming" : ""}`, 49) + " | anyplans";
    intro = `${up.length ? `In ${ix.town} there ${up.length === 1 ? "is 1 event" : "are " + up.length + " events"} in the coming months.` : `Nothing is scheduled in ${ix.town} right now: below, the past festivals, which often come back every year.`} On anyplans you find the festivals and events of ${ix.town} with dates, times and place. You sign up and go with others.`;
  }
  const descr = cut(intro, 160);
  const nounOf = { festival: "town festivals and sagre", estivo: "summer venue evenings", dinner: "dinners and aperitivo", running: "group runs and races", padel: "padel matches and tournaments", walking: "group walks" };
  const noun = ix.kind === "tipo" ? (nounOf[ix.sport] || `${label.toLowerCase()} events`) : "festivals and events";
  const nextNoun = { festival: "town festival or sagra", estivo: "summer venue evening", dinner: "dinner or aperitivo", running: "group run or race", padel: "padel match", walking: "group walk" }[ix.sport] || (ix.kind === "tipo" ? `${label.toLowerCase()} event` : "festival");
  const what = ix.kind === "tipo" ? `${noun} in ${CITY_NAME} and its province` : `${noun} in ${ix.town}`;
  const evLine = (p) => `${p.title} (${evTown(p)}${lc1(whenLabel(p))})`;
  const free = up.filter(p => !(p.price_cents > 0)).length;
  const faq = [
    { q: `Which ${what} are coming up?`, a: up.length ? `${up.length === 1 ? "There is 1 event" : `There are ${up.length} events`}: ${joinIt(up.slice(0, 6).map(evLine))}${up.length > 6 ? " and more, all in the list above" : ""}.` : `None right now. The last dates were ${joinIt(past.slice(0, 3).map(evLine))}: they often come back every year, and the new dates appear here.` },
    { q: `When is the next ${nextNoun}${ix.kind === "tipo" ? "" : " in " + ix.town}?`, a: up.length ? `${up[0].title}, ${lc1(whenLabel(up[0]))}${evTown(up[0]) ? `, in ${evTown(up[0]).replace(/, $/, "")}` : ""}. ${fmtPrice(up[0].price_cents)}.` : `No date has been published yet. Sign up on anyplans: when it comes out, you see it on the map.` },
    { q: `${cap(what)}: are they free?`, a: up.length ? `${free === up.length ? "Yes, all of them" : `${free} out of ${up.length}`}. When there is a ticket or a fee, the price is on the event's page.` : `Almost always yes: town festivals, food fairs and group outings are free; if there is a fee it is on the event's page.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: h1, url,
    itemListElement: up.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], [ix.kind === "tipo" ? label : ix.town, null]])}
<div class="chips"><span class="chip">${emoji} ${esc(ix.kind === "tipo" ? ix.t.c ? catLabel(ix.t.c) : "" : "Town")}</span></div>
<h1>${esc(h1)}</h1>
<p class="lead">${esc(intro)}</p>
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">See all events</a></div>
${up.length ? `<h2>Upcoming</h2>${listHtml(up)}` : ""}
${past.length ? `<h2>Past</h2>${listHtml(past)}` : ""}
${faqHtml(faq)}
`;
  const lastmod = new Date(Math.max(...list.map(p => p.updated)));
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, modified: lastmod, alt: inLocale("it", () => indexUrl(ix)) }), lastmod };
}
function indexPageIt(ix) {
  const url = indexUrl(ix);
  const list = ix.list.slice().sort(byDate);
  const up = list.filter(p => !p.isPast), past = list.filter(p => p.isPast).reverse().slice(0, Math.max(0, Math.min(20, 100 - up.length)));
  let h1, title, intro, emoji;
  if (ix.kind === "tipo") {
    h1 = `${ix.t.label} a ${CITY_NAME} e provincia`; emoji = ix.t.e;
    title = cut(`${ix.sport === "festival" ? "Feste e sagre" : ix.t.label} a ${CITY_NAME}`, 36) + (up.length ? `: ${up.length} ${up.length === 1 ? "evento" : "eventi"}` : "") + " | anyplans";
    intro = `${up.length ? `A ${CITY_NAME} e provincia ci sono ${up.length} ${up.length === 1 ? "evento" : "eventi"} di ${ix.t.label.toLowerCase()} nei prossimi mesi.` : `Al momento non ci sono eventi di ${ix.t.label.toLowerCase()} in programma: qui sotto quelli già passati.`} ${ix.t.frase}`;
  } else {
    h1 = `Feste ed eventi a ${ix.town}`; emoji = "🎉";
    title = cut(`Feste ed eventi a ${ix.town}${up.length ? ": " + up.length + " in programma" : ""}`, 49) + " | anyplans";
    intro = `${up.length ? `A ${ix.town} ${up.length === 1 ? "c'è 1 evento" : "ci sono " + up.length + " eventi"} nei prossimi mesi.` : `A ${ix.town} non c'è niente in programma adesso: qui sotto le feste già passate, che spesso tornano ogni anno.`} ${TESTI.paese.frase.replace("{paese}", ix.town)}`;
  }
  const descr = cut(intro, 160);
  const what = ix.kind === "tipo" ? `${ix.t.label.toLowerCase()} a ${CITY_NAME} e provincia` : `feste ed eventi a ${ix.town}`;
  const evLine = (p) => `${p.title} (${evTown(p)}${whenLabel(p).toLowerCase()})`;
  const free = up.filter(p => !(p.price_cents > 0)).length;
  const faq = [
    { q: `Quali ${what} ci sono in programma?`, a: up.length ? `${up.length === 1 ? "C'è 1 evento" : `Ci sono ${up.length} eventi`}: ${joinIt(up.slice(0, 6).map(evLine))}${up.length > 6 ? " e altri, tutti nella lista qui sopra" : ""}.` : `Adesso nessuno. Le ultime date sono state ${joinIt(past.slice(0, 3).map(evLine))}: spesso tornano ogni anno, e le date nuove compaiono qui.` },
    { q: `Quando è ${ix.kind === "tipo" ? "il prossimo evento di " + ix.t.label.toLowerCase() : "la prossima festa a " + ix.town}?`, a: up.length ? `${up[0].title}, ${whenLabel(up[0]).toLowerCase()}${evTown(up[0]) ? `, a ${evTown(up[0]).replace(/, $/, "")}` : ""}. ${fmtPrice(up[0].price_cents)}.` : `Non c'è ancora una data pubblicata. Registrati su anyplans: quando esce, la vedi sulla mappa.` },
    { q: `${cap(what)}: sono gratis?`, a: up.length ? `${free === up.length ? "Sì, tutti" : `${free} su ${up.length}`}. Quando c'è un biglietto o una quota, il prezzo è scritto nella pagina dell'evento.` : `Quasi sempre sì: feste di paese, sagre e uscite di gruppo sono gratis; se c'è una quota è scritta nella pagina dell'evento.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: h1, url,
    itemListElement: up.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, rel(hubUrl())], [ix.kind === "tipo" ? ix.t.label : ix.town, null]])}
<div class="chips"><span class="chip">${emoji} ${esc(ix.kind === "tipo" ? ix.t.c ? cap(ix.t.c) : "" : "Paese")}</span></div>
<h1>${esc(h1)}</h1>
<p class="lead">${esc(intro)}</p>
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a></div>
${up.length ? `<h2>Prossimi</h2>${listHtml(up)}` : ""}
${past.length ? `<h2>Già passati</h2>${listHtml(past)}` : ""}
${faqHtml(faq)}
`;
  const lastmod = new Date(Math.max(...list.map(p => p.updated)));
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, modified: lastmod, alt: inLocale("en", () => indexUrl(ix)) }), lastmod };
}
function hubPage() { return en() ? hubPageEn() : hubPageIt(); }
// "Spritz & Burger (Clusone, 12 September)": the town only, and nothing when the town is already in the title
const lc1 = (t) => t && t.startsWith("From ") ? "from " + t.slice(5) : t; // "From 11 September" -> "from 11 September" mid-sentence; weekdays keep their capital
const evTown = (p) => { const t = localityOf(p); return t && !norm(p.title).includes(norm(t)) ? t + ", " : ""; };
function hubPageEn() {
  const url = hubUrl();
  const next = upcomingPages.slice(0, 30);
  const title = `Things to do in ${CITY_NAME} this week: ${upcomingPages.length} events | anyplans`;
  const sotto = `What's on in ${CITY_NAME} and its province, today, tonight and this weekend: town festivals and sagre, running clubs, walks, cooking and pottery classes, volunteering, open-air summer venues. Pick a plan and go with others.`;
  const descr = cut(`Things to do in ${CITY_NAME} today and this weekend: ${upcomingPages.length} events, ${types.length} kinds of activity, ${groups.length} groups. Town festivals, run clubs, classes, sports. You sign up and go with others.`, 160);
  const today = dateKey(NOW, DEFAULT_TZ);
  const dow = (d) => new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, weekday: "short" }).format(d);
  const todayList = upcomingPages.filter(p => p.up.some(d => dateKey(d.start, d.tz) === today));
  const wkEnd = new Date(NOW.getTime() + 7 * 86400e3);
  const isWk = (d) => d.start >= NOW && d.start <= wkEnd && ["Sat", "Sun"].includes(dow(d.start));
  const evName = (p) => `${p.title} (${evTown(p)}${fmtShort((p.up.find(isWk) || p.up[0]).start, p.tz)})`;
  const weekend = upcomingPages.filter(p => p.up.some(isWk));
  const free = upcomingPages.filter(p => !(p.price_cents > 0)).length;
  const faq = [
    { q: `What to do in ${CITY_NAME} this weekend?`, a: weekend.length ? `This weekend in ${CITY_NAME} and its province there are ${weekend.length} events on anyplans: ${joinIt(weekend.slice(0, 6).map(evName))}${weekend.length > 6 ? " and more" : ""}. The full dates are in the list above.` : `Nothing is published yet for this weekend on anyplans: the next events are ${joinIt(next.slice(0, 4).map(evName))}.` },
    { q: `What's on in ${CITY_NAME} today and tonight?`, a: todayList.length ? `Today, ${fmtDate(NOW)}, in ${CITY_NAME} and its province there ${todayList.length === 1 ? "is 1 event" : `are ${todayList.length} events`} on anyplans: ${joinIt(todayList.slice(0, 6).map(p => p.title + (evTown(p) ? " in " + evTown(p).replace(/, $/, "") : "")))}.` : `Today, ${fmtDate(NOW)}, there is no event published on anyplans in ${CITY_NAME}. The next ones: ${joinIt(next.slice(0, 4).map(evName))}.` },
    { q: `What kind of events are there in ${CITY_NAME} on anyplans?`, a: `Town festivals and food fairs (sagre), group runs and running clubs, walks, cooking and pottery classes, volunteering, summer venues and cultural events. Right now ${upcomingPages.length} events are scheduled, published by ${groups.length} groups or collected from the websites of the town councils and associations.` },
    { q: `Are the events in ${CITY_NAME} on anyplans free?`, a: `${free} of the ${upcomingPages.length} upcoming events are free. When there is a ticket or a fee, the price is on the event's page. Signing up on anyplans is free and only needs your email; you must be 18 or older.` },
    { q: `I'm a tourist in ${CITY_NAME}: can I join?`, a: `Yes: run clubs, walks, festivals and dinners are open to everyone, for one evening too. Most descriptions are in Italian because the organisers write them, but times, places and prices are on every page in English, and you can see who else is going before you show up.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Upcoming events in ${CITY_NAME}`, url,
    itemListElement: next.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, null]])}
<h1>Things to do in ${esc(CITY_NAME)}, today and this weekend</h1>
<p class="lead">${esc(sotto)}</p>
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">See all events</a><a class="btn ghost" href="${rel(groupsUrl())}">The groups</a></div>
${types.length ? `<h2>By kind</h2><div class="tags">${types.map(x => `<a href="${rel(indexUrl(x))}">${x.t.e} ${esc(tLabel(x.t))}</a>`).join("")}</div>` : ""}
${towns.length ? `<h2>By town</h2><div class="tags">${towns.slice().sort((a, b) => a.town.localeCompare(b.town, "it")).map(x => `<a href="${rel(indexUrl(x))}">${esc(x.town)}</a>`).join("")}</div>` : ""}
${runClubs.length >= 3 ? `<h2>Running with others</h2><div class="tags"><a href="${rel(runningUrl())}">🏃 Running clubs in ${esc(CITY_NAME)}</a></div>` : ""}
${groups.length ? `<h2>Groups</h2><div class="tags">${groups.map(g => `<a href="${esc(groupUrl(g))}">${g.emoji || "👥"} ${esc(g.name)}</a>`).join("")}</div>` : ""}
<h2>Upcoming events</h2>
${next.length ? listHtml(next) : `<p class="lead">Nothing scheduled right now.</p>`}
${faqHtml(faq)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("it", hubUrl) }), lastmod: pages.length ? new Date(Math.max(...pages.map(p => p.updated))) : NOW };
}
function hubPageIt() {
  const url = hubUrl();
  const next = upcomingPages.slice(0, 30);
  const title = `${TESTI.hub.titolo}: ${upcomingPages.length} eventi | anyplans`;
  const descr = cut(`${TESTI.hub.sotto} ${upcomingPages.length} eventi in programma, ${types.length} tipi di attività, ${groups.length} gruppi.`, 160);
  // "cosa fare a Bergamo oggi / questo weekend": the page is rebuilt every night, so "today" is right at 03:30
  const today = dateKey(NOW, DEFAULT_TZ);
  const dow = (d) => new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, weekday: "short" }).format(d);
  const todayList = upcomingPages.filter(p => p.up.some(d => dateKey(d.start, d.tz) === today));
  const wkEnd = new Date(NOW.getTime() + 7 * 86400e3);
  const isWk = (d) => d.start >= NOW && d.start <= wkEnd && ["Sat", "Sun"].includes(dow(d.start));
  const evName = (p) => `${p.title} (${evTown(p)}${fmtShort((p.up.find(isWk) || p.up[0]).start, p.tz)})`;
  const weekend = upcomingPages.filter(p => p.up.some(isWk));
  const free = upcomingPages.filter(p => !(p.price_cents > 0)).length;
  const faq = [
    { q: `Cosa fare a ${CITY_NAME} questo fine settimana?`, a: weekend.length ? `Questo fine settimana a ${CITY_NAME} e provincia ci sono ${weekend.length} eventi su anyplans: ${joinIt(weekend.slice(0, 6).map(evName))}${weekend.length > 6 ? " e altri" : ""}. Le date complete sono nella lista qui sopra.` : `Per questo fine settimana non c'è ancora niente pubblicato su anyplans: i prossimi eventi sono ${joinIt(next.slice(0, 4).map(evName))}.` },
    { q: `Cosa fare a ${CITY_NAME} oggi?`, a: todayList.length ? `Oggi, ${fmtDate(NOW)}, a ${CITY_NAME} e provincia ${todayList.length === 1 ? "c'è 1 evento" : `ci sono ${todayList.length} eventi`} su anyplans: ${joinIt(todayList.slice(0, 6).map(p => p.title + (evTown(p) ? " a " + evTown(p).replace(/, $/, "") : "")))}.` : `Oggi, ${fmtDate(NOW)}, non c'è nessun evento pubblicato su anyplans a ${CITY_NAME}. I prossimi: ${joinIt(next.slice(0, 4).map(evName))}.` },
    { q: `Che tipo di eventi ci sono a ${CITY_NAME} su anyplans?`, a: `Feste di paese e sagre, uscite di corsa e running club, camminate, corsi di cucina e di ceramica, volontariato, eventi culturali. In questo momento sono in programma ${upcomingPages.length} eventi, pubblicati da ${groups.length} gruppi o raccolti dai siti dei comuni e delle associazioni.` },
    { q: `Gli eventi a ${CITY_NAME} su anyplans sono gratis?`, a: `${free} dei ${upcomingPages.length} eventi in programma sono gratis. Quando c'è un biglietto o una quota, il prezzo è scritto nella pagina dell'evento. Registrarsi su anyplans è gratis e serve solo la tua email; bisogna avere almeno 18 anni.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Prossimi eventi a ${CITY_NAME}`, url,
    itemListElement: next.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, null]])}
<h1>${esc(TESTI.hub.titolo)}</h1>
<p class="lead">${esc(TESTI.hub.sotto)}</p>
<div class="cta"><a class="btn" href="/${CITY}/eventi.html">Vedi tutti gli eventi</a><a class="btn ghost" href="${rel(groupsUrl())}">I gruppi</a></div>
${types.length ? `<h2>Per tipo</h2><div class="tags">${types.map(x => `<a href="${rel(indexUrl(x))}">${x.t.e} ${esc(x.t.label)}</a>`).join("")}</div>` : ""}
${towns.length ? `<h2>Per paese</h2><div class="tags">${towns.slice().sort((a, b) => a.town.localeCompare(b.town, "it")).map(x => `<a href="${rel(indexUrl(x))}">${esc(x.town)}</a>`).join("")}</div>` : ""}
${runClubs.length >= 3 ? `<h2>Correre in compagnia</h2><div class="tags"><a href="${rel(runningUrl())}">🏃 Running club a ${esc(CITY_NAME)}</a></div>` : ""}
${groups.length ? `<h2>Gruppi</h2><div class="tags">${groups.map(g => `<a href="${esc(groupUrl(g))}">${g.emoji || "👥"} ${esc(g.name)}</a>`).join("")}</div>` : ""}
<h2>Prossimi eventi</h2>
${next.length ? listHtml(next) : `<p class="lead">Niente in programma adesso.</p>`}
${faqHtml(faq)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("en", hubUrl) }), lastmod: pages.length ? new Date(Math.max(...pages.map(p => p.updated))) : NOW };
}

// ── llms.txt: what the site is and where the answers are, for AI crawlers (llmstxt.org) ──
function llmsTxt() {
  const line = (name, href, note) => `- [${name}](${href})${note ? `: ${note}` : ""}`;
  const dayLines = [];
  for (let i = 0; i < 7; i++) {
    const rows = schedules.filter(x => x.weekday === i && runClubs.some(g => g.slug === x.community_slug));
    if (rows.length) dayLines.push(line(`Run club il ${WEEKDAYS_IT[i].toLowerCase()}`, `${SITE}/${CITY}/running-club/${LOCALES.it.daySlug[i]}/`, rows.map(r => `${r.community_name} alle ${hhmm(r.start_time)}`).join(", ")));
  }
  return `# anyplans

> anyplans (anyplans.in) è la mappa degli eventi veri di ${CITY_NAME} e provincia: feste di paese e sagre, corsi di cucina e di ceramica, volontariato, uscite sportive, running club. Raccoglie gli eventi già esistenti dai siti dei comuni e delle associazioni e quelli pubblicati dai gruppi; chi li vede si iscrive e ci va insieme ad altri. Solo maggiorenni. Registrazione gratuita con email. Per ora solo ${CITY_NAME}; Milano e Brescia in arrivo.

Le pagine si rigenerano ogni notte dai dati: date, orari, luoghi e prezzi sono quelli pubblicati da chi organizza. Ultimo aggiornamento: ${NOW.toISOString().slice(0, 10)}. Instagram: ${INSTAGRAM}. Contatto: hello@anyplans.in.

## Pagine principali

${line(`Cosa fare a ${CITY_NAME}`, `${SITE}/${CITY}/cosa-fare/`, `tutti gli eventi in programma (${upcomingPages.length}), per tipo e per paese; risponde a "cosa fare a ${CITY_NAME} oggi / questo weekend"`)}
${line(`Running club a ${CITY_NAME}`, `${SITE}/${CITY}/running-club/`, `${runClubs.length} run club per giorno della settimana, con ritrovo, orario e domande frequenti`)}
${line(`Gruppi a ${CITY_NAME}`, `${SITE}/${CITY}/gruppi/`, `${groups.length} associazioni, club e comunità che pubblicano eventi`)}
${line("Le regole di anyplans", `${SITE}/guidelines.html`)}
${line("Privacy", `${SITE}/privacy-it.html`)}
${line("Condizioni d'uso", `${SITE}/terms-it.html`)}

## Eventi per tipo e per paese

${types.map(x => line(`${x.t.label} a ${CITY_NAME}`, `${SITE}/${CITY}/${x.slug}/`, `${x.list.filter(p => !p.isPast).length} in programma`)).join("\n")}
${towns.map(x => line(`Feste ed eventi a ${x.town}`, `${SITE}/${CITY}/${x.slug}/`, `${x.list.filter(p => !p.isPast).length} in programma`)).join("\n")}

## Running club per giorno

${dayLines.join("\n")}

## Gruppi

${groups.map(g => line(g.name, groupUrl(g), isRunClub(g) ? (g.sport === "walking" ? "gruppo di camminata" : "run club") : (g.upcoming_count > 0 ? `${g.upcoming_count} eventi in programma` : ""))).join("\n")}

## Prossimi eventi

${upcomingPages.slice(0, 40).map(p => line(p.title, eventUrl(p), `${whenLabel(p)}, ${placeShort(p)}, ${fmtPrice(p.price_cents)}`)).join("\n")}

## Optional

${line("Tutte le pagine in un file", `${SITE}/llms-full.txt`, "titolo, riassunto e domande frequenti di ogni pagina")}
${line("Sitemap", `${SITE}/sitemap.xml`)}
${line("Versione inglese della home", `${SITE}/en/`)}

## English pages (same content, for visitors)

${line(`Things to do in ${CITY_NAME}`, `${SITE}/en/${CITY}/${LOCALES.en.hub}/`, "all upcoming events, by kind and by town; answers \"what to do in Bergamo today / this weekend\"")}
${line(`Running clubs in ${CITY_NAME}`, `${SITE}/en/${CITY}/${LOCALES.en.running}/`, `${runClubs.length} run clubs by weekday, open to visitors too`)}
${line(`Groups in ${CITY_NAME}`, `${SITE}/en/${CITY}/${LOCALES.en.groups}/`)}
${types.map(x => line(`${EN_TYPES[x.sport]?.[1] || x.t.label} in ${CITY_NAME}`, `${SITE}/en/${CITY}/${EN_TYPES[x.sport]?.[0] || x.slug}/`)).join("\n")}
`;
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

# AI answer engines are welcome on the public pages (same rules as everyone)
User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: Bingbot
Allow: /

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
const unesc = (t) => String(t ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const fullTxt = [];
async function writePage(rel, html) {
  const dir = path.join(OUT, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html);
  const pick = (re) => { const m = html.match(re); return m ? unesc(m[1]).trim() : ""; };
  const title = pick(/<title>(.*?)<\/title>/s), descr = pick(/<meta name="description" content="(.*?)">/s), lead = pick(/<p class="lead">(.*?)<\/p>/s);
  const faq = [...html.matchAll(/<h3>(.*?)<\/h3><p>(.*?)<\/p>/gs)].map(m => `**${unesc(m[1])}**\n${unesc(m[2])}`);
  fullTxt.push(`## ${title.replace(/ \| anyplans$/, "")}\n${SITE}/${rel}/\n\n${lead || descr}\n${faq.length ? "\n" + faq.join("\n\n") + "\n" : ""}`);
}
const cityDir = path.join(OUT, CITY);
await mkdir(cityDir, { recursive: true });
for (const e of await readdir(cityDir, { withFileTypes: true })) if (e.isDirectory()) await rm(path.join(cityDir, e.name), { recursive: true, force: true });
await rm(path.join(OUT, "en", CITY), { recursive: true, force: true }); // /en/index.html (the English home) stays

addUrl(SITE + "/", NOW);
addUrl(SITE + "/en/", NOW);
// the same pages in Italian and in English: urls, labels and texts come from the active locale
const relOf = (u) => rel(u).replace(/^\/|\/$/g, "");
for (const code of ["it", "en"]) {
  L = LOCALES[code];
  const hub = hubPage(); await writePage(relOf(hubUrl()), hub.html); addUrl(hubUrl(), hub.lastmod);
  for (const ix of [...types, ...towns]) { const r = indexPage(ix); await writePage(relOf(indexUrl(ix)), r.html); addUrl(indexUrl(ix), r.lastmod); }
  if (groups.length) { await writePage(relOf(groupsUrl()), groupsIndex()); addUrl(groupsUrl(), NOW); }
  if (runClubs.length >= 3) {
    const r = runningHub(); await writePage(relOf(runningUrl()), r.html); addUrl(runningUrl(), r.lastmod);
    for (let i = 0; i < 7; i++) {
      if (!schedules.some(x => x.weekday === i && runClubs.some(g => g.slug === x.community_slug))) continue;
      const d = runningDayPage(i); await writePage(relOf(dayUrl(i)), d.html); addUrl(dayUrl(i), d.lastmod);
    }
  }
  for (const g of groups) { const r = groupPage(g); await writePage(relOf(groupUrl(g)), r.html); addUrl(groupUrl(g), r.lastmod); }
  for (const p of pages) { await writePage(relOf(eventUrl(p)), eventPage(p)); addUrl(eventUrl(p), p.updated); }
}
L = LOCALES.it;
await writeFile(path.join(OUT, "sitemap.xml"), sitemapXml());
await writeFile(path.join(OUT, "robots.txt"), ROBOTS);
await writeFile(path.join(OUT, "llms.txt"), llmsTxt());
await writeFile(path.join(OUT, "llms-full.txt"), llmsTxt() + "\n---\n\n# Tutte le pagine di anyplans a " + CITY_NAME + " (italiano, poi inglese)\n\n" + fullTxt.join("\n"));

console.log(`eventi: ${rows.length} righe, ${pages.length} pagine (${upcomingPages.length} futuri, ${pages.length - upcomingPages.length} passati)`);
console.log(`indici: ${types.length} tipi (${types.map(x => x.slug).join(", ")}), ${towns.length} paesi`);
console.log(`gruppi: ${groups.length} (run club: ${runClubs.length}, ritrovi: ${schedules.length}); sitemap: ${sitemapEntries.length} url (it + en) → ${OUT}`);

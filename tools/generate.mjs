#!/usr/bin/env node
// anyplans SEO: static public pages for Google (design/sito-landing/plan-seo.md).
// Node 20, no dependencies. Reads Supabase with the anon key and writes into --out:
//   /<citta>/<slug>/index.html            one page per event slug (all dates of a multi-day festa)
//   /<citta>/gruppi/index.html            public list of groups (Bergamo only, for now)
//   /<citta>/gruppi/<slug>/index.html     one page per group
//   /<citta>/<tipo>/ and /<citta>/<paese>/ flat indexes (>= MIN_INDEX events)
//   /<citta>/cosa-fare/index.html         hub, plus oggi / domani / weekend / months
//   /en/<citta>/...                       the same pages in English (things-to-do, festivals, running-clubs, groups, events)
//   /sitemap-<citta>.xml, /llms-<citta>.txt
// and, with --indice: /sitemap.xml (indice), /robots.txt, /llms.txt, /citta/, /en/cities/
// Usage: node generate.mjs --out <dir>                  tutte le citta, poi l'indice (quello che fa il workflow)
//        node generate.mjs --out <dir> --citta milano   una citta sola
//        node generate.mjs --out <dir> --indice         solo sitemap.xml, robots.txt, llms.txt, /citta/
//        [--fixture <rows.json>] [--groups <groups.json>] per le prove
// Env: SUPABASE_URL, SUPABASE_ANON_KEY.
// UNA citta per run (le citta stanno in citta.json); il workflow le fa in fila e poi lancia --indice.
// Every subdirectory of <out>/<citta>/ and the whole <out>/en/<citta>/ are removed and regenerated: they must contain only generated pages.

import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readFileSync as fsReadSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = "https://anyplans.in";
// ── le città del sito ─────────────────────────────────────────────────────────
// Dal 15/09/2026 il database ha eventi in tutta Italia e il sito fa le pagine di 29 città (citta.json:
// centro, raggio e sigla della provincia). Ogni run del generatore fa UNA città.
// Un evento appartiene alla città PIÙ VICINA fra queste: così lo stesso evento non finisce sia in
// /milano/ sia in /bergamo/ (pagine doppie = Google ne indicizza una sola e le conta come copie).
// Gli eventi senza coordinate (visibilità "request") restano alla città del run.
const CITTA = JSON.parse(await readFile(path.join(HERE, "citta.json"), "utf8"));
const HOME_CITY = "bergamo";       // l'unica città con l'app web (mappa, iscrizioni) sotto /bergamo/*.html
const argvCity = (() => { const i = process.argv.indexOf("--citta"); return i > 0 ? process.argv[i + 1] : HOME_CITY; })();
const C = CITTA.find(c => c.slug === argvCity);
if (!C) { console.error(`città sconosciuta: ${argvCity} (in citta.json: ${CITTA.map(c => c.slug).join(", ")})`); process.exit(2); }
const INDICE = process.argv.includes("--indice");   // niente pagine: scrive sitemap, robots, llms e /citta/
const CITY = C.slug;
// il nome della città nella lingua della pagina: chi cerca in inglese scrive "things to do in Naples",
// non "in Napoli" (18/09/2026). L'indirizzo resta quello italiano: /en/napoli/ è già indicizzato.
const CITY_NAME_IT = C.nome;
const CITY_NAME_EN = C.nome_en || C.nome;
let CITY_NAME = CITY_NAME_IT;
const PROV = C.prov;
const CITY_CENTER = { lat: C.lat, lng: C.lng };
const CITY_KM = C.km;
const MIN_CITY = 40;              // sotto questa soglia una città (che non sia Bergamo) non ha pagine sue
// multi-city sources (Milano is 45 km away, Monza 35): for them only the province core, 30 km
const MULTI_CITY_SOURCES = [/^https:\/\/(www\.)?comehome\.fun\//, /^https:\/\/(www\.)?weroad\.(it|com)\/wemeet\//, /^https:\/\/(www\.)?meeters\.org\//, /^https:\/\/(www\.)?tabloapp\.com\//, /^https:\/\/(www\.)?(lu\.ma|luma\.com)\//, /^https:\/\/share\.nomadtable\.app\//, /^https:\/\/(www\.)?panesalamina\.com\//, /^https:\/\/(www\.)?play2match\.it\//, /^https:\/\/(www\.)?2d2web\.com\//];
const MULTI_CITY_KM = 30;
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
// ── senza --citta: le fa tutte, una per volta, e poi l'indice ─────────────────
// Ogni città è un processo suo perché mezzo generatore (rows, pages, indici) è costruito una volta
// sola, all'avvio, sulla città del run. Un processo per città costa qualche secondo e non rompe niente.
if (!process.argv.includes("--citta") && !INDICE && !FIXTURE) {
  const { spawnSync } = await import("node:child_process");
  const self = fileURLToPath(import.meta.url);
  // deno serve per provarlo qui sul mac (node non c'è); in GitHub Actions gira node
  const base = globalThis.Deno ? [Deno.execPath(), "run", "-A", self] : [process.execPath, self];
  for (const passo of [...CITTA.map(c => ["--citta", c.slug]), ["--indice"]]) {
    const r = spawnSync(base[0], [...base.slice(1), "--out", OUT, ...passo], { stdio: "inherit" });
    if (r.status !== 0) { console.error(`generate: "${passo.join(" ")}" è fallita, mi fermo`); process.exit(1); }
  }
  process.exit(0);
}

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
  concert: ["concerts", "Concerts & live music", "Concerts and live music nights in Bergamo and the province: bands, tribute acts and singer-songwriters, from village festivals to theatres."],
  show: ["shows", "Shows & theatre", "Theatre, dialect comedies, cabaret and musicals in Bergamo and the province, with the dates of every performance."],
  market: ["markets", "Markets", "The markets of Bergamo and the province: antiques, crafts, vintage and second-hand, weekend by weekend."],
  karaoke: ["karaoke", "Karaoke", "Karaoke nights in the bars of Bergamo and the province: open mic, you sing with whoever is there."],
  tour: ["guided-tours", "Guided tours", "Guided tours of churches, towers, museums and parks around Bergamo: you go with a guide and with others."],
  culture: ["talks-and-culture", "Talks & culture", "Book presentations, talks and exhibitions in Bergamo and the province."],
  fair: ["fairs", "Fairs", "The fairs of the Bergamo area: patron saint fairs, livestock and farming shows, model-making, with the dates of every day."],
  // 15/09/2026 (migrazione 0087): le categorie nate con gli eventi di tutta Italia
  dancing: ["dancing", "Dancing", "Tango, salsa and swing nights, plus dance classes you can try out on your own."],
  nightlife: ["nights-out", "Nights out", "Club nights, dj sets and theme nights, evening by evening."],
  match: ["live-sport", "Live sport", "Home matches of the local teams: date, ground and how to get a ticket."],
  cinema: ["cinema", "Cinema", "Screenings, festivals and open-air cinema, with every date."],
  games: ["board-games", "Board games", "Board game nights, quizzes and chess: you sit at a table with whoever is there."],
  exhibition: ["exhibitions", "Exhibitions", "The exhibitions open right now: paintings, photography, archaeology and installations, with opening days."],
  singles: ["singles", "Singles nights", "Speed dates and singles nights, by age group: going alone is the point."],
};
const LOCALES = {
  it: { code: "it", tag: "it-IT", og: "it_IT", intl: "it-IT", prefix: "", hub: "cosa-fare", groups: "gruppi", running: "running-club",
        when: { oggi: "cosa-fare-oggi", domani: "cosa-fare-domani", weekend: "cosa-fare-nel-weekend" },
        monthSlug: (label) => "eventi-" + slugify(label),
        days: ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"], daySlug: ["lunedi", "martedi", "mercoledi", "giovedi", "venerdi", "sabato", "domenica"],
        and: " e ", free: "Gratis", privacy: "/privacy-it.html", terms: "/terms-it.html", home: "/", citta: "citta", locali: "locali" },
  en: { code: "en", tag: "en", og: "en_GB", intl: "en-GB", prefix: "/en", hub: "things-to-do", groups: "groups", running: "running-clubs",
        when: { oggi: "what-to-do-today", domani: "what-to-do-tomorrow", weekend: "what-to-do-this-weekend" },
        monthSlug: (label) => "events-" + slugify(label),
        days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], daySlug: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
        and: " and ", free: "Free", privacy: "/privacy.html", terms: "/terms.html", home: "/en/", citta: "cities", locali: "venues" },
};
let L = LOCALES.it;           // the locale of the page being built (the write loop at the bottom switches it)
const setLocale = (code) => { L = LOCALES[code]; CITY_NAME = code === "en" ? CITY_NAME_EN : CITY_NAME_IT; };
const en = () => L.code === "en";
// run fn with another locale active (to compute the hreflang alternate of the page being built)
function inLocale(code, fn) { const prev = L.code; setLocale(code); try { return fn(); } finally { setLocale(prev); } }

// ── helpers ───────────────────────────────────────────────────────────────────
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Le descrizioni delle fonti aggregate (AllEvents in testa) arrivano dal database con dentro l'HTML del
// sito di partenza: "<br /><b>About this Event</b>". Passate a esc() diventano tag scritti a lettere sulla
// pagina, che il lettore legge e Google conta come contenuto copiato male. Qui i tag tornano a essere righe
// e le entity tornano caratteri, una volta sola: se nel testo c'è una "&" scritta apposta, resta una "&".
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", euro: "€", deg: "°", middot: "·", bull: "•" };
const decodeEntities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  }
  const c = ENTITIES[e.toLowerCase()];
  return c === undefined ? m : c;
});
function plainText(s) {
  let t = String(s ?? "");
  if (!/[<&]/.test(t)) return t.trim();
  t = t.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
       .replace(/<\s*li[^>]*>/gi, "\n· ")
       .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table)[^>]*>/gi, "\n")
       .replace(/<[^>]*>/g, "");
  // la fonte taglia la descrizione a N caratteri e la coda resta un tag monco: "...booking.</stro"
  const cutTag = /<[^>]*$/.test(t);
  t = decodeEntities(t.replace(/<[^>]*$/, ""));
  t = t.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // un testo lungo che finisce senza punteggiatura l'ha tagliato la fonte a tot caratteri ("...si incontrano"):
  // i puntini dicono a chi legge che il pezzo continua, e il link alla fonte e' gia' in fondo alla pagina
  const troncato = cutTag || (t.length > 200 && !/[.!?…:;)»"'\]]$/.test(t));
  return troncato && t && !/[.!?…:;)»"'\]]$/.test(t) ? t + "…" : t;
}
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
// le frasi di testi.json e di EN_TYPES parlano di Bergamo ("le valli orobiche", "le sagre bergamasche"):
// nelle altre citta sarebbero false, quindi li' l'indice vive di lead + lista + domande, senza frase
const tPhrase = (t) => CITY !== HOME_CITY ? GENERIC_PHRASE() : en() ? (EN_TYPES[t.sport]?.[2] || "") : t.frase;
const GENERIC_PHRASE = () => en()
  ? "Each one has the date, the time, the place and the price; you sign up and go with other people."
  : "In ogni pagina ci sono data, ora, posto e prezzo, e ci vai insieme ad altre persone.";
const catLabel = (c) => en() ? ({ sport: "Sports", cucina: "Food", creatività: "Creativity", giardinaggio: "Gardening", cultura: "Culture", benessere: "Wellbeing", altro: "Other" }[c] || cap(c)) : cap(c);
// visite delle pagine statiche (16/09/2026): stesso evento page_view dell'app, stesso rpc, chiave anon gia' pubblica in app.js.
// Senza, le 13.990 pagine erano invisibili: non si sapeva se Google o i motori di risposta le mandassero qualcuno.
// I crawler che eseguono js (Googlebot in primis) non contano: appena online, il 16/09, i primi page_view erano loro.
const TRACK = `<script>(function(){try{if(location.protocol==="file:")return;if(navigator.webdriver||/bot|crawl|spider|slurp|headless|lighthouse|gptbot|claudebot|perplexity/i.test(navigator.userAgent))return;var r="";try{r=document.referrer?new URL(document.referrer).hostname:""}catch(e){}if(r===location.hostname)r="";var v=null;try{v=localStorage.getItem("anyplans_visitor");if(!v){v=Math.random().toString(36).slice(2,12)+Date.now().toString(36);localStorage.setItem("anyplans_visitor",v)}}catch(e){}fetch("${SB_URL}/rest/v1/rpc/log_site_event",{method:"POST",keepalive:true,headers:{"apikey":"${SB_ANON}","Content-Type":"application/json"},body:JSON.stringify({p_name:"page_view",p_path:location.pathname,p_ref:r||null,p_city:"${CITY}",p_visitor:v})}).catch(function(){})}catch(e){}})();</script>
`;
const jsonld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const INSTAGRAM = "https://instagram.com/anyplans_bergamo";
// the same Organization node as the home page (branding/legal/index.html): keep the two identical
const ORG = { "@type": "Organization", "@id": SITE + "/#org", name: "anyplans", url: SITE + "/", email: "hello@anyplans.in",
  logo: { "@type": "ImageObject", url: SITE + "/favicon-192.png", width: 192, height: 192 },
  // anyplans e' una sola: la sua descrizione e' nazionale e finiva in ogni pagina di ogni citta dicendo "Bergamo"
  description: `La mappa degli eventi veri d'Italia: feste di paese, concerti, mercati, corsi, volontariato, sport e cene in ${CITTA.length} città. Ne scegli uno e ci vai insieme ad altri. Solo maggiorenni.`,
  foundingLocation: { "@type": "City", name: "Bergamo" }, areaServed: { "@type": "Country", name: "Italia" }, sameAs: [INSTAGRAM],
  founder: { "@type": "Person", name: "Filippo Terzi", image: SITE + "/founder.jpg", jobTitle: "Fondatore" } };
const fmtDate = (d) => new Intl.DateTimeFormat(L.intl, { timeZone: DEFAULT_TZ, day: "numeric", month: "long", year: "numeric" }).format(d);
// answer engines (ChatGPT, Perplexity, AI Overviews) lift question + short answer: every page gets a visible FAQ and its FAQPage schema
// domande chiuse (details): si aprono al tocco, il testo resta nella pagina per Google (FAQPage in JSON-LD)
const faqHtml = (faq) => `<div class="box" id="domande"><h2>${en() ? "Frequently asked questions" : "Domande frequenti"}</h2>${faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div>`;
const faqLd = (faq) => jsonld({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(f => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) });
const nf = (n) => new Intl.NumberFormat(L.intl).format(n);   // 6.267, non 6267
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
// il 18/09/2026 la corsa notturna è morta su Milano con "canceling statement due to statement
// timeout": il database ci mette più del limite a rispondere quando la città è grossa e c'è carico.
// Un errore così non è definitivo, è un momento storto: si riprova. Senza, salta la rigenerazione
// di tutte e 29 le città e il sito resta fermo al giorno prima.
async function rpcRetry(name, body, tentativi = 4) {
  let ultimo;
  for (let i = 0; i < tentativi; i++) {
    try { return await rpc(name, body); }
    catch (e) {
      ultimo = e;
      const riprovabile = /HTTP (5\d\d|408|429)|timeout|fetch failed|ECONNRESET|socket/i.test(String(e && e.message));
      if (!riprovabile || i === tentativi - 1) throw e;
      const attesa = 2000 * Math.pow(2, i);        // 2s, 4s, 8s
      console.error(`rpc ${name}: ${String(e.message).slice(0, 90)} — riprovo fra ${attesa / 1000}s`);
      await new Promise(r => setTimeout(r, attesa));
    }
  }
  throw ultimo;
}
// PostgREST restituisce al massimo 1000 righe per chiamata (db-max-rows) e per le FUNZIONI ignora l'header
// Range: si pagina con il parametro p_offset (migrazione 0086). Senza, il sito vedeva solo le prime 1000
// righe della finestra — cioè quasi solo passato — e perdeva tutte le date oltre pochi giorni.
async function rpcPaged(name, body, page = 500, max = 20000) {
  const out = [];
  for (let off = 0; off < max; off += page) {
    const rows = await rpcRetry(name, { ...body, p_limit: page, p_offset: off });
    if (!Array.isArray(rows)) throw new Error(`rpc ${name}: risposta inattesa`);
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}
// the RPC (migration 0061) takes no parameters and returns future + recent past rows: the 13-month window is applied here
// dal 15/09/2026 (migrazione 0086) la RPC accetta centro e raggio: il sito fa le pagine di UNA città, e senza
// filtro il limite di righe verrebbe mangiato dalle fonti nazionali (Tablo, comehome, Playtomic su tutta Italia)
const rawRows = INDICE ? [] : FIXTURE ? JSON.parse(await readFile(FIXTURE, "utf8"))
  : await rpcPaged("public_activities_for_seo", { p_lat: CITY_CENTER.lat, p_lng: CITY_CENTER.lng, p_radius_km: CITY_KM });
const rawGroups = INDICE ? [] : GROUPS_FIXTURE ? JSON.parse(await readFile(GROUPS_FIXTURE, "utf8")) : await rpcRetry("list_communities", { p_city: CITY });
// ritrovi fissi dei gruppi (migrazione 0070): "ogni mercoledì alle 18:45 al parco della Trucca"
const SCHEDULES_FIXTURE = arg("--schedules");
const rawSchedules = INDICE ? [] : SCHEDULES_FIXTURE ? JSON.parse(await readFile(SCHEDULES_FIXTURE, "utf8")) : await rpcRetry("list_community_schedules", { p_city: CITY }).catch(() => []);
const schedules = Array.isArray(rawSchedules) ? rawSchedules : [];
// i siti dei circoli (migrazione 0088 club_sites): servono al link dell'organizzatore nei dati
// strutturati — Search Console segnala "Missing field url (in organizer)" su 4 eventi su 5.
// Difensivo di proposito: se la funzione non c'è ancora sul database, le pagine si generano lo
// stesso, solo senza quel link. Così il generatore può andare online prima della migrazione.
const clubSites = await (async () => {
  if (INDICE) return new Map();
  let righe = [];
  try { righe = await rpc("club_sites", {}); } catch { return new Map(); }
  if (!Array.isArray(righe)) return new Map();
  // un indirizzo che appartiene a tre circoli diversi non è il sito di nessuno dei tre: è la
  // piattaforma dove si prenota (playtomic.io). Come url dell'organizzatore sarebbe una bugia.
  // due circoli diversi non possono avere la stessa identica pagina: quando succede quella pagina non
  // è di nessuno dei due, è la piattaforma dove si prenota (playtomic.io). Si confronta l'indirizzo
  // intero, non il dominio: instagram.com/kz_padel è la pagina di quel circolo e va tenuta.
  const chiave = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, "").toLowerCase() + x.pathname.replace(/\/+$/, "").toLowerCase(); } catch { return ""; } };
  const quanti = new Map();
  for (const r of righe) { const k = chiave(r.website_url); if (k) quanti.set(k, (quanti.get(k) || 0) + 1); }
  const m = new Map();
  for (const r of righe) {
    if (!r.name || !r.website_url) continue;
    const u = String(r.website_url).trim();
    const k = chiave(u);
    if (!k || quanti.get(k) >= 2 || !/^https?:\/\//i.test(u)) continue;
    m.set(norm(r.name), u);
  }
  return m;
})();
const siteDelClub = (nome) => clubSites.get(norm(nome)) || null;
if (!INDICE && (!Array.isArray(rawRows) || rawRows.length === 0)) { console.error("nessun evento dalla RPC: non tocco niente"); process.exit(1); }

// normalize rows; only the public columns of the contract are used
const rows = rawRows.map(r => {
  const tz = r.timezone || DEFAULT_TZ;
  const start = new Date(r.start_at);
  const end = r.end_at ? new Date(r.end_at) : null;
  const isFest = r.sport === "festival";
  const t = tipo(r.sport);
  return {
    // il titolo si mostra ripulito, ma lo slug resta quello del titolo grezzo: e' lo stesso slugify(title)
    // che fa l'app (bergamo/app.js) sui link che la gente ha gia' condiviso, e deve continuare a combaciare
    id: r.id, title: plainText(r.title), rawTitle: String(r.title || "").trim(), description: plainText(r.description),
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
             && r.start >= new Date(NOW.getTime() - PAST_DAYS * 86400e3)
             && (r.lat == null || r.lng == null
                 || (distKm(CITY_CENTER, r) <= (MULTI_CITY_SOURCES.some(rx => rx.test(r.source_url || "")) ? MULTI_CITY_KM : CITY_KM)
                     && cittaPiuVicina(r) === CITY)));

// la città del sito più vicina all'evento (null se nessuna lo copre): decide di chi è la pagina
function cittaPiuVicina(r) {
  let best = null, bd = Infinity;
  for (const c of CITTA) {
    const d = distKm({ lat: c.lat, lng: c.lng }, r);
    if (d <= c.km && d < bd) { bd = d; best = c.slug; }
  }
  return best;
}

function distKm(a, b) { // haversine, enough to keep or drop an event
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const groups = (Array.isArray(rawGroups) ? rawGroups : []).filter(g => g.slug && g.name);

// ── group rows into pages: one page per slug (same title + same club = same event, all dates) ─
const bySlug = new Map();
for (const r of rows) {
  const s = slugify(r.rawTitle);
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
// i paesi che il database dichiara davvero (p.town): servono a riconoscere il paese anche quando il
// campo manca. "Mercato di Ponte Nossa" diceva a Google di essere a Bergamo, perché il ritrovo è
// "Via G. Frua" e da lì non si ricava niente: il paese però sta nel titolo, e Ponte Nossa è un paese
// che conosciamo da altri eventi. Senza, il mercato non compariva nemmeno nella pagina del suo paese
// (18/09/2026).
const PAESI_NOTI = (() => {
  const m = new Map();
  for (const p of pages) if (p.town && p.town !== "Bergamo Città") m.set(norm(p.town), p.town);
  return [...m.entries()].sort((a, b) => b[0].length - a[0].length);   // prima i nomi lunghi: "Bonate Sotto" batte "Bonate"
})();
const paeseDalTitolo = (p) => {
  const t = norm(p.title);
  for (const [k, nome] of PAESI_NOTI) if (k.length >= 4 && new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(t)) return nome;
  return "";
};
// un paese non è la città stessa scritta in un altro modo ("Milan" per Milano) e non è un locale
// ("Artevox Teatro"): quelli hanno la loro pagina sotto /locali/.
// le piattaforme da cui arrivano gli eventi non sono paesi: capita che finiscano nel campo del club
const PIATTAFORME = new Set(["nomadtable", "tablo", "luma", "lu.ma", "eventbrite", "allevents", "meeters",
  "weroad", "wemeet", "playtomic", "comehome", "panesalamina", "sivola", "zest", "feverup", "fever", "play2match", "2d2web"]);
const paeseValido = (nome) => {
  const n = norm(nome), c = norm(CITY_NAME);
  if (n.length < 3 || n === c || c.startsWith(n) || n.startsWith(c)) return false;
  if (PIATTAFORME.has(n)) return false;
  return !/\b(teatro|cinema|club|circolo|museo|stadio|arena|auditorium|palazzetto|hotel|ristorante|pizzeria|birreria|discoteca|osteria|taverna)\b/.test(n);
};
// il paese dell'evento: quello dichiarato, poi quello dell'indirizzo, poi quello scritto nel titolo
const paeseDi = (p) => {
  if (p.town) {
    const t = p.town === "Bergamo Città" ? CITY_NAME : p.town;
    return norm(t) === norm(CITY_NAME) || paeseValido(t) ? t : "";
  }
  const parts = String(p.meeting || "").split(",").map(x => x.trim()).filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const dallIndirizzo = last && !/\d/.test(last) && last.length <= 40 ? last.replace(/\s*\(.*\)\s*$/, "") : "";
  const nome = dallIndirizzo || paeseDalTitolo(p);
  return nome && paeseValido(nome) ? nome : "";
};
const townIdx = new Map();  // nome normalizzato -> { nomi, pagine }: "EUR" e "Eur" sono lo stesso paese
                            // e lo stesso indirizzo, e due indici con lo stesso indirizzo fermavano la corsa
for (const p of pages) {
  if (!inWindow(p)) continue;
  if (!typeIdx.has(p.sport)) typeIdx.set(p.sport, []);
  typeIdx.get(p.sport).push(p);
  const paese = paeseDi(p);
  if (paese && norm(paese) !== norm(CITY_NAME)) {
    const k = norm(paese);
    if (!townIdx.has(k)) townIdx.set(k, { nomi: new Map(), list: [] });
    const t = townIdx.get(k);
    t.nomi.set(paese, (t.nomi.get(paese) || 0) + 1);
    t.list.push(p);
  }
}
const types = [...typeIdx].filter(([, l]) => l.length >= MIN_INDEX)
  .map(([sport, list]) => ({ kind: "tipo", sport, t: tipo(sport), slug: tipo(sport).key, list }));
let towns = [...townIdx.values()].filter(t => t.list.length >= MIN_INDEX)
  .map(t => { const town = [...t.nomi.entries()].sort((a, b) => b[1] - a[1])[0][0]; return { kind: "paese", town, slug: slugify(town), list: t.list }; });

// ── i locali ─────────────────────────────────────────────────────────────────
// La gente cerca il posto per nome: "circolino astino", "vog summer club", "zero club bergamo",
// "27 bistrot", "bar8 pontida". In Search Console sono oltre cento impressioni al mese solo a
// Bergamo, tutte intorno alla decima posizione, perché rispondiamo con la pagina di un singolo
// evento invece che con la pagina del locale. Qui nasce quella pagina (17/09/2026).
const MIN_LOCALE = 2;             // sotto due eventi in programma la pagina del locale direbbe quello che dice gia la pagina dell'evento
// i nomi dei paesi visti in questa città: un paese non è un locale ("Dalmine", "Zogno", "Seriate")
const PAESI = new Set(pages.flatMap(p => [p.town, localityOf(p)]).filter(Boolean).map(norm)
  .concat(CITTA.map(c => norm(c.nome))));
// nomi che non identificano un posto: ce n'è uno per paese e tutti si chiamano così
const GENERICI = new Set(["sala polivalente", "sala civica", "pista di atletica", "rocca", "centro sportivo",
  "palazzetto dello sport", "area feste", "oratorio", "campo sportivo", "palazzetto", "palestra comunale",
  "centro anziani", "sala consiliare", "auditorium", "biblioteca comunale", "teatro comunale", "cinema teatro",
  "piazza del mercato", "centro civico", "casa della comunita", "parco comunale", "campo sportivo comunale"]);
const nomeLocale = (p) => {
  const raw = String(p.club || String(p.meeting || "").split(/\s*[,–]\s*/)[0] || "").trim();
  if (raw.length < 4 || raw.length > 60) return "";
  // un indirizzo non è un locale, e nemmeno il nome del paese o un nome che hanno tutti i paesi
  if (/^(via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|contrada|localit|lungo|parcheggio|oratorio di|centro sportivo di)\b/i.test(raw)) return "";
  if (PAESI.has(norm(raw)) || GENERICI.has(norm(raw))) return "";
  return raw;
};
const venueIdx = new Map();
for (const p of pages) {
  const nome = nomeLocale(p);
  if (!nome) continue;
  const k = slugify(nome);
  if (!k || RESERVED.has(k)) continue;
  if (!venueIdx.has(k)) venueIdx.set(k, { kind: "locale", slug: k, nomi: new Map(), list: [] });
  const v = venueIdx.get(k);
  v.nomi.set(nome, (v.nomi.get(nome) || 0) + 1);
  v.list.push(p);
}
const venues = [...venueIdx.values()]
  .map(v => ({ ...v, nome: [...v.nomi.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
  // Un locale merita la pagina se ha qualcosa in programma E una storia: due eventi futuri, oppure
  // uno solo ma almeno tre in tutto contando i passati. Il Circolino Astino vale 629 impressioni al
  // mese su Google (Search Console, 22/09/2026) e con la vecchia regola — due futuri — restava senza
  // pagina, perché d'estate fa una rassegna sola per volta. Senza un evento in programma invece la
  // pagina non si fa: direbbe solo che non c'è niente.
  // e i locali fermi ma con una storia vera (cinque eventi passati) la pagina ce l'hanno lo stesso:
  // il Circolino Astino d'estate fa una rassegna e d'inverno chiude, ma "circolino astino" vale 629
  // impressioni al mese su Google e chi lo cerca vuole sapere se c'è qualcosa, anche quando non c'è.
  .filter(v => { const f = v.list.filter(p => !p.isPast).length;
                 return (f >= 1 && (f >= MIN_LOCALE || v.list.length >= 3)) || (f === 0 && v.list.length >= 5); })
  .sort((a, b) => b.list.length - a.list.length);
const indexSlugs = new Set();
for (const ix of types) {
  if (RESERVED.has(ix.slug)) { console.error(`indice "${ix.slug}" collide con un nome riservato: mi fermo`); process.exit(1); }
  if (indexSlugs.has(ix.slug)) { console.error(`tipo "${ix.slug}" duplicato: mi fermo`); process.exit(1); }
  indexSlugs.add(ix.slug);
}
// un paese che finirebbe sullo stesso indirizzo di un tipo (o di un altro paese) si toglie e basta:
// i tipi sono gli stessi in tutte le città, i paesi no, e una corsa non deve fermarsi per questo.
const townsScartati = [];
towns = towns.filter(ix => {
  if (RESERVED.has(ix.slug) || indexSlugs.has(ix.slug)) { townsScartati.push(ix.slug); return false; }
  indexSlugs.add(ix.slug);
  return true;
});
if (townsScartati.length) console.error(`paesi saltati, l'indirizzo era già preso: ${townsScartati.join(", ")}`);
// events colliding with a reserved name or an index get the date suffix
// gli slug delle pagine "quando" sono riservati prima che gli eventi scelgano il loro (in entrambe le lingue:
// lo slug dell'evento è lo stesso per /bergamo/ e /en/bergamo/). I mesi si riservano per un anno avanti.
for (const code of ["it", "en"]) inLocale(code, () => {
  for (const k of Object.keys(L.when)) indexSlugs.add(L.when[k]);
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + i, 15));
    const t = new Intl.DateTimeFormat(L.intl, { timeZone: DEFAULT_TZ, month: "long", year: "numeric" }).format(d);
    indexSlugs.add(L.monthSlug(en() ? cap(t) : t.toLowerCase()));
  }
});
const taken = new Set([...RESERVED, ...indexSlugs]);
// la data si attacca una volta sola: chi l'ha gia' presa sopra (stesso titolo, giorni diversi) qui
// prenderebbe la seconda, e veniva fuori /padel-manca-1-giocatore-2026-09-15-2026-09-15-2/
const hasDate = (s) => /-\d{4}-\d{2}-\d{2}$/.test(s);
for (const p of pages) {
  if (taken.has(p.slug) && !hasDate(p.slug)) p.slug += "-" + dateKey(p.anchor, p.tz);
  if (taken.has(p.slug)) {
    const stem = p.slug;
    for (let n = 2; taken.has(p.slug); n++) p.slug = `${stem}-${n}`;
  }
  taken.add(p.slug);
}
// Le partite aperte di Playtomic si chiamano tutte uguale: a Milano ci sono dodici pagine "Padel: mancano
// 2 giocatori (competitiva)". Sono partite vere e diverse — cambia il circolo — ma con lo stesso titolo si
// prendono anche lo stesso <title>, e in un risultato di ricerca diventano dodici righe identiche che si
// fanno concorrenza fra loro. Chi ha un titolo che si ripete si porta il posto nel titolo della pagina.
const titoliRipetuti = new Set();
{
  const visti = new Map();
  for (const p of pages) {
    const k = norm(p.title);
    visti.set(k, (visti.get(k) || 0) + 1);
    if (visti.get(k) > 1) titoliRipetuti.add(k);
  }
}
// 16/09/2026: il conteggio qui sopra guardava il titolo INTERO, ma nel <title> ci finiva la parte
// prima della virgola ("Visita guidata, Museo della Valle" → "Visita guidata"): titoli diversi
// collassavano nello stesso e il controllo non scattava mai. Su Bergamo erano 41 pagine con lo
// stesso <title> di un'altra, e Google ne sceglie una sola. Ora il titolo si costruisce in un
// posto solo (titoloEvento) e il conteggio si fa su quello che esce davvero, per lingua.
// Il posto nel titolo serve anche a rispondere alle ricerche che già ci portano gente:
// "festa oratorio alzano sopra", "festa conca fiorita bergamo" (Search Console, 16/09/2026).
function titoloEvento(p, conData) {
  const where = placeShort(p);
  const tz = p.tz;
  const first = p.up[0] || p.dates[p.dates.length - 1];
  const intero = `${p.title} ${en() ? "in" : "a"} ${where}, ${fmtShort(first.start, tz)}`;
  if (intero.length <= 49 && !conData) return intero;
  // "Festa X, Oratorio Y – Paese" → "Festa X" quando quella parte sta in piedi da sola
  const head = p.title.split(/ – |, /)[0];
  const base = head.length >= 12 && head.length <= 49 ? head : p.title;
  // il posto da mettere nel titolo è il paese; se manca, il nome del ritrovo — ma non un indirizzo
  // ("Via G. Frua", "Piazza Dante"): la via non distingue niente e ruba spazio al titolo.
  // solo chi comincia come una via è un indirizzo: "27 Padel" e "MERATE A 4" sono nomi di circoli.
  const rit = String(where || "").split(/\s*[,–]\s*/)[0].trim();
  const indirizzo = /^(via|viale|v\.le|piazza|p\.zza|piazzale|p\.le|corso|c\.so|largo|vicolo|strada|contrada|localit|lungo)\b/i.test(rit);
  const luogo = p.town || (rit && !indirizzo ? rit : "");
  const nuovo = (l) => l && !norm(base).includes(norm(l)) && !norm(l).includes(norm(base)) ? l : null;
  const giaDetto = luogo && !nuovo(luogo);      // "Mercato di Ponte Nossa": il posto è già nel titolo
  // il ripiego è il comune vero (localityOf lo ricava dall'indirizzo quando il campo manca), non il
  // capoluogo: un mercato a Rovetta non si intitola "– Bergamo", e se il paese è già nel titolo
  // ("Mercato di Rovetta") non si aggiunge niente.
  const v = nuovo(luogo), c = nuovo(localityOf(p));
  // in ordine: il posto se ci sta senza tagliare, poi la città (è quella che la gente cerca,
  // "candlelight milano"). Quando non ci sta nei 60 caratteri il comune si aggiunge lo stesso, in coda
  // a un titolo intero: la coda la taglia Google nel risultato, ma nell'html il titolo resta diverso
  // da quello delle altre città, ed è quello che conta per non farsi scartare come doppione. Gli eventi che
  // girano per l'Italia (Candlelight, WeRoad, le passeggiate fotografiche) avevano lo stesso titolo
  // in dodici città: senza la città Google ne sceglie una e ignora le altre (16/09/2026).
  const t = giaDetto ? cut(base, 57)
    : v && base.length + 3 + v.length <= 60 ? `${base} – ${v}`
    : c && base.length + 3 + c.length <= 60 ? `${base} – ${c}`
    : c ? `${cut(base, 75)} – ${c}`
    : cut(base, 57);
  if (!conData) return t;
  // ultima spiaggia per due pagine che finirebbero uguali: il posto anche stretto, poi la data
  const stretto = v && !t.includes(v) ? `${cut(base, Math.max(24, 57 - v.length))} – ${v}` : t;
  return `${stretto}, ${fmtShort(first.start, tz)}`;
}
// quante pagine finirebbero con lo stesso <title>: si conta per lingua, il titolo cambia ("a" / "in")
const finaliPerLingua = new Map();
function titoloRipetuto(t) {
  let m = finaliPerLingua.get(L.code);
  if (!m) {
    m = new Map();
    for (const q of pages) { const k = norm(titoloEvento(q, false)); m.set(k, (m.get(k) || 0) + 1); }
    finaliPerLingua.set(L.code, m);
  }
  return (m.get(norm(t)) || 0) > 1;
}

// every public url depends on the active locale: /bergamo/gruppi/x/ vs /en/bergamo/groups/x/
const base = () => `${SITE}${L.prefix}/${CITY}`;
// L'app web (mappa, iscrizioni, login) sta solo sotto /bergamo/: e' una sola app, non una per citta.
// Dalle pagine delle altre citta si arriva alla stessa mappa gia centrata li: ?luogo=Milano&lat=&lng=&km=
const APP = `/${HOME_CITY}`;
// 17/09/2026: da ogni pagina di una citta si entra dalla home, gia' su quella citta: "dove"
// compilato, mappa e lista li'. Prima si finiva su /bergamo/eventi.html?luogo=..., che e' un'altra
// pagina e un altro design.
const MAP_URL = `/?citta=${CITY}`;
const eventUrl = (p) => `${base()}/${p.slug}/`;
const groupUrl = (g) => `${base()}/${L.groups}/${g.slug}/`;
// A Bergamo /bergamo/ e' la home dell'app web, quindi l'hub sta in /bergamo/cosa-fare/; nelle altre
// citta l'indirizzo e' libero e l'hub sta li', che e' anche l'indirizzo che la gente prova a mano.
const cittaUrl = () => `${SITE}${L.prefix}/${L.citta}/`;   // l'elenco delle città del sito
// 17/09/2026: in italiano /milano/ apre la home (mappa + ricerca, gia' su Milano) come /bergamo/,
// quindi l'elenco di link vive sotto /milano/cosa-fare/. In inglese resta dov'era.
const hubUrl = () => (!en() || CITY === HOME_CITY) ? `${base()}/${L.hub}/` : `${base()}/`;
const groupsUrl = () => `${base()}/${L.groups}/`;
const venuesUrl = () => `${base()}/${L.locali}/`;
const venueUrl = (v) => `${base()}/${L.locali}/${v.slug}/`;
const runningUrl = () => `${base()}/${L.running}/`;
const dayUrl = (i) => `${runningUrl()}${L.daySlug[i]}/`;
// "cosa fare a Bergamo oggi / domani / nel weekend" e "eventi a Bergamo a ottobre": le ricerche più frequenti
const whenUrl = (k) => `${base()}/${L.when[k]}/`;
const monthUrl = (m) => `${base()}/${L.monthSlug(monthLabel(m))}/`;
const ixSlug = (ix) => ix.kind === "tipo" ? tSlug(ix.t) : ix.slug;
const indexUrl = (ix) => `${base()}/${ixSlug(ix)}/`;
const rel = (u) => u.slice(SITE.length);
const groupBySlug = new Map(groups.map(g => [g.slug, g]));
const byDate = (a, b) => a.anchor - b.anchor;
const upcomingPages = pages.filter(p => !p.isPast).sort(byDate);

// ── quando: oggi, domani, weekend, e i prossimi mesi ──────────────────────────
// Una pagina per ognuno, solo con almeno MIN_WHEN eventi (niente pagine vuote su Google).
const MIN_WHEN = 3;
const MONTHS_AHEAD = 3;
const dowEn = (d) => new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, weekday: "short" }).format(d);
const dayAfter = (n) => new Date(NOW.getTime() + n * 86400e3);
const datesOf = (p) => p.up || p.dates.filter(d => d.start >= NOW);
const onDay = (p, key) => datesOf(p).some(d => dateKey(d.start, d.tz) === key);
const TODAY_KEY = dateKey(NOW, DEFAULT_TZ);
const TOMORROW_KEY = dateKey(dayAfter(1), DEFAULT_TZ);
// il weekend "prossimo": sabato e domenica che stanno entro 7 giorni (se oggi è sabato, questo weekend)
const weekendKeys = [...Array(8).keys()].map(dayAfter).filter(d => ["Sat", "Sun"].includes(dowEn(d))).slice(0, 2).map(d => dateKey(d, DEFAULT_TZ));
const WHEN = {
  oggi: { keys: [TODAY_KEY], list: upcomingPages.filter(p => onDay(p, TODAY_KEY)) },
  domani: { keys: [TOMORROW_KEY], list: upcomingPages.filter(p => onDay(p, TOMORROW_KEY)) },
  weekend: { keys: weekendKeys, list: upcomingPages.filter(p => weekendKeys.some(k => onDay(p, k))) },
};
const monthKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit" }).format(d).slice(0, 7);
const monthLabel = (m) => { const [y, mm] = m.split("-"); const t = new Intl.DateTimeFormat(L.intl, { timeZone: DEFAULT_TZ, month: "long", year: "numeric" }).format(new Date(Date.UTC(+y, +mm - 1, 15))); return en() ? cap(t) : t.toLowerCase(); };
const monthsWanted = [...Array(MONTHS_AHEAD).keys()].map(i => monthKey(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + i, 15))));
const monthIdx = new Map(monthsWanted.map(m => [m, upcomingPages.filter(p => datesOf(p).some(d => monthKey(d.start) === m))]));
const months = monthsWanted.filter(m => (monthIdx.get(m) || []).length >= MIN_WHEN);

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
.tags.citta a{display:inline-flex;align-items:center;gap:8px}
.tags.citta .n{background:var(--sand,#F1ECE3);border-radius:999px;padding:1px 8px;font-size:12px;color:#555}
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
@media (max-width:600px){h1{font-size:28px}.cover{height:180px;font-size:72px}
.nav{height:auto;flex-wrap:wrap;gap:8px 12px;padding:10px 0}.nav>.row{width:100%;justify-content:space-between}}
`.trim();

let lastCrumbs = null; // set by crumbs() while the body is built, read by layout() right after (pages are built one at a time)
// la città come entità (non come parola): dice a Google e ai motori di risposta DI DOVE parla la pagina,
// con coordinate e provincia. Le pagine che non parlano di una città sola passano about: ITALIA.
const CITY_LD = { "@type": "City", name: CITY_NAME,
  address: { "@type": "PostalAddress", addressLocality: CITY_NAME, addressRegion: PROV, addressCountry: "IT" },
  geo: { "@type": "GeoCoordinates", latitude: C.lat, longitude: C.lng } };
const ITALIA = { "@type": "Country", name: "Italia" };
function layout({ title, description, url, image, jsonLd, body, ogType = "website", modified = NOW, head = "", alt = null, about = CITY_LD, vecchio = false }) {
  // alt: the same page in the other language (hreflang); Italian is the default for everyone else
  const itUrl = en() ? alt : url, enUrl = en() ? url : alt;
  const crumbLd = lastCrumbs ? jsonld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: lastCrumbs.map(([l, h], i) =>
    ({ "@type": "ListItem", position: i + 1, name: l, ...(h ? { item: h.startsWith("http") ? h : SITE + h } : { item: url }) })) }) : "";
  lastCrumbs = null;
  // WebPage with dateModified: freshness signal for answer engines (Event/Organization have no modified date of their own)
  const pageLd = jsonld({ "@context": "https://schema.org", "@type": "WebPage", "@id": url, url, name: title, description, inLanguage: L.tag,
    dateModified: modified.toISOString(), primaryImageOfPage: image, about,
    // speakable: le due righe che rispondono alla domanda (titolo e primo paragrafo), quelle che un
    // assistente vocale legge ad alta voce e che i motori di risposta citano per prime
    speakable: { "@type": "SpeakableSpecification", cssSelector: ["h1", ".lead"] },
    isPartOf: { "@type": "WebSite", "@id": SITE + "/#website", name: "anyplans", url: SITE + "/",
                // la ricerca del sito: da qui Google può mostrare la casella di ricerca di anyplans nei risultati
                potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${SITE}/${HOME_CITY}/eventi.html?q={search_term_string}` }, "query-input": "required name=search_term_string" } },
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
${vecchio ? '<meta name="robots" content="noindex, follow">'
  : '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">'}
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
  <span class="row" style="gap:10px">${alt ? `<a class="lnk" href="${esc(alt)}" hreflang="${en() ? "it" : "en"}" style="font-size:13.5px">${en() ? "Italiano" : "English"}</a>` : ""}<a class="btn sm" href="${MAP_URL}">${en() ? "See all events" : "Vedi tutti gli eventi"}</a></span>
</div></header>
<main>
${body}
</main>
<footer><div class="wrap">
  <span>© 2026 Filippo Terzi · anyplans</span>
  <span class="upd">${en() ? "Page updated on" : "Pagina aggiornata il"} ${esc(fmtDate(modified))}</span>
  <a href="${rel(hubUrl())}">${en() ? `Things to do in ${CITY_NAME}` : `Cosa fare a ${CITY_NAME}`}</a>
  ${groups.length ? `<a href="${rel(groupsUrl())}">${en() ? "Groups" : "Gruppi"}</a>` : ""}
  ${runClubs.length >= 3 ? `<a href="${rel(runningUrl())}">${en() ? "Running clubs" : "Running club"}</a>` : ""}
  <a href="${rel(cittaUrl())}">${en() ? "All the cities" : "Tutte le città"}</a>
  <a href="${MAP_URL}">anyplans ${en() ? "in" : "a"} ${CITY_NAME}</a>
  <a href="/guidelines.html">${en() ? "Community guidelines" : "Le regole di anyplans"}</a>
  <a href="${L.privacy}">Privacy</a>
  <a href="${L.terms}">${en() ? "Terms of use" : "Condizioni d'uso"}</a>
  ${alt ? `<a href="${esc(alt)}" hreflang="${en() ? "it" : "en"}">${en() ? "Questa pagina in italiano" : "This page in English"}</a>` : ""}
  <a href="https://instagram.com/anyplans_bergamo" rel="noopener">Instagram</a>
</div></footer>
${TRACK}</body>
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
  if (p.club) return { name: p.club, url: siteDelClub(p.club), kind: "club" };
  if (p.host_name) return { name: p.host_name, url: null, kind: "utente" };
  return { name: en() ? "An anyplans member" : "Un utente di anyplans", url: null, kind: "utente" };
}
// "Piazzale della Chiesa, Carvico" -> Carvico; a last segment with digits or the city name itself is not a locality
function localityOf(p) { return paeseDi(p) || CITY_NAME; }
function eventJsonLd(p, url) {
  // Google wants Event markup only for events still to come: past dates get no Event node at all
  const dates = p.dates.filter(d => d.future);
  if (!dates.length) return "";
  const org = organizer(p);
  const image = p.photo ? photoSrc(p.photo) : OG_DEFAULT;
  const location = { "@type": "Place", name: p.meeting || (p.town ? p.town : CITY_NAME + " e dintorni"),
    address: { "@type": "PostalAddress", addressLocality: localityOf(p), addressRegion: PROV, addressCountry: "IT",
               ...(p.meeting ? { streetAddress: p.meeting } : {}) } };
  // organizer (Search Console 08/09/2026: "missing field organizer/performer"): a group on anyplans (with its page), a named association,
  // the town's Comune for the feste it publishes on its own portal (eventi.bergamo.it / app.bergamo.it), never anyplans itself.
  // Events opened by a single user (no group) carry no organizer: the RPC exposes no host name (privacy, SCHEMA §5) and we don't invent one.
  const organizerNode = org.kind === "gruppo" ? { "@type": "Organization", name: org.name, url: org.url, ...(org.instagram ? { sameAs: [org.instagram] } : {}) }
    : org.kind === "club" ? { "@type": "Organization", name: p.town ? `Comune di ${localityOf(p)}` : org.name,
        ...(!p.town && org.url ? { url: org.url } : {}) } : null; // the Comune keeps its Italian name in both languages
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
  const paeseQui = paeseDi(p);
  const sameTown = paeseQui ? upcomingPages.filter(x => x.slug !== p.slug && norm(paeseDi(x)) === norm(paeseQui) && x.sport !== p.sport) : [];
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
    ? `The meeting point is ${p.meeting}${p.town && !norm(p.meeting).includes(norm(p.town)) ? `, ${p.town}` : ""}${p.lat != null && p.lng != null ? `, in the province of ${CITY_NAME}; the page has a link to the map` : ""}.`
    : p.town ? `In ${p.town}, in the province of ${CITY_NAME}. The organiser shares the exact place after you sign up.`
    : `In the ${CITY_NAME} area: the organiser shares the exact place after you sign up on anyplans.`;
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
    ? `Il ritrovo è a ${p.meeting}${p.town && !norm(p.meeting).includes(norm(p.town)) ? `, ${p.town}` : ""}${p.lat != null && p.lng != null ? `, in provincia di ${CITY_NAME}; nella pagina c'è il collegamento alle mappe` : ""}.`
    : p.town ? `A ${p.town}, in provincia di ${CITY_NAME}. Il luogo esatto lo comunica chi organizza dopo che ti sei iscritto.`
    : `Nella zona di ${CITY_NAME}: il luogo esatto lo comunica chi organizza dopo che ti sei iscritto su anyplans.`;
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
// Un evento finito da più di 45 giorni non serve a chi cerca: la pagina resta (chi ci arriva da un
// link vecchio la trova, e i suoi link continuano a valere) ma non si chiede più a Google di
// indicizzarla, e sparisce dalla sitemap. Search Console il 18/09/2026: 3.394 pagine "scansionate,
// attualmente non indicizzate" — 1.319 sono eventi già passati, e chiedere l'indicizzazione di roba
// che non si può più fare consuma la scansione che serve alle altre. I primi 45 giorni restano
// indicizzabili perché dopo una festa la gente la cerca ancora ("conca fiorita in festa", 12 impressioni).
const GIORNI_VECCHIO = 45;
const vecchioDi = (p) => {
  if (!p.isPast) return false;
  const ultima = p.dates.length ? p.dates[p.dates.length - 1].start : null;
  return !!ultima && (NOW - ultima) > GIORNI_VECCHIO * 86400e3;
};
function eventPage(p) {
  const url = eventUrl(p);
  const tz = p.tz, t = p.tipo, org = organizer(p);
  const hasMap = p.visibility === "open" && p.lat != null && p.lng != null && !p.isPast;
  const where = placeShort(p);
  const faq = eventFaq(p, org);
  const first = p.up[0] || p.dates[p.dates.length - 1];
  // un titolo solo, costruito in titoloEvento; se un'altra pagina finirebbe uguale si aggiunge la data
  const t0 = titoloEvento(p, false);
  const title = (titoloRipetuto(t0) ? titoloEvento(p, true) : t0) + " | anyplans";
  // nella descrizione il ritrovo va col nome corto ("Bridge Brew Bar", non "Bridge Brew Bar -
  // Birreria, Cocktails & Sport Bar, Napoli"): l'indirizzo intero si mangiava i 160 caratteri e
  // quello che distingue l'evento non ci entrava più.
  const dove = String(where || "").split(/\s*[,–]\s*/)[0].trim() || where;
  // la descrizione comincia dal nome dell'evento: prima non c'era, e sedici eventi diversi dello stesso
  // organizzatore nello stesso bar (i networking di Eventbrite, che dalla fonte arrivano tutti con la
  // stessa frase) finivano con la stessa identica descrizione. Sul sito erano 249 pagine (16/09/2026).
  const descr = en()
    ? (p.isPast
      ? cut(`${cut(p.title, 60)}: ${tLabel(t).toLowerCase()} in ${dove}. Last date: ${fmtShort(first.start, tz)}. This event is over: on anyplans you find the next dates and similar events.`, 160)
      : cut(`${cut(p.title, 60)}: ${tLabel(t).toLowerCase()} in ${dove}, ${fmtDay(first.start, tz)} at ${fmtTime(first.start, tz)}. ${cut(p.description, 70)} ${fmtPrice(p.price_cents)}. Go with others.`.replace(/\s+/g, " ").replace(/\.\s*\./g, "."), 160))
    : p.isPast
    ? cut(`${cut(p.title, 60)}: ${t.label.toLowerCase()} a ${dove}. Ultima data: ${fmtShort(first.start, tz)}. Questo evento è passato: su anyplans trovi le prossime date e gli eventi simili.`, 160)
    : cut(`${cut(p.title, 60)}: ${t.label.toLowerCase()} a ${dove} ${fmtDay(first.start, tz).toLowerCase()} alle ${fmtTime(first.start, tz)}. ${cut(p.description, 70)} ${fmtPrice(p.price_cents)}. Ci vai insieme ad altri.`.replace(/\s+/g, " ").replace(/\.\s*\./g, "."), 160);
  const image = p.photo ? photoSrc(p.photo) : OG_DEFAULT;
  const sim = similar(p);
  const typeIndex = types.find(x => x.sport === p.sport);
  const townIndex = towns.find(x => norm(x.town) === norm(paeseDi(p))) || null;
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
  // aggregated events (15/09/2026): "Ci vado" goes straight to the source site, where the sign-up is; logged-in visitors
  // are sent to the app page anyway (appScript below), where the same button also marks them as going here
  const external = !!(p.source_url && p.source !== "ugc");
  const joinBtn = external ? `<a class="btn" href="${esc(p.source_url)}" rel="noopener nofollow">${S.join}</a>`
                           : `<a class="btn" href="${APP}/evento.html?id=${esc(p.id)}&amp;join=1">${S.join}</a>`;

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
  <div class="cta">${joinBtn}<span class="m">${p.going > 0 ? `${p.going === 1 ? S.going1 : S.goingN}${spots}` : S.first}</span></div>
</div>`}
<p class="lead">${esc(eventSummary(p, org, first))}</p>
${p.isPast ? `<div class="box in"><h2>${S.pastTitle}</h2><div class="m">${S.pastTxt}</div><div class="cta"><a class="btn" href="${MAP_URL}">${S.now}</a></div></div>` : ""}
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
  ${p.isPast ? "" : joinBtn}
  <a class="btn ghost" href="${MAP_URL}">${S.allEvents}</a>
  ${external && p.isPast ? `<a class="lnk" href="${esc(p.source_url)}" rel="noopener nofollow">${S.official}</a>` : ""}
</div>
${faqHtml(faq)}
${sim.length ? `<h2>${S.similar}</h2>${listHtml(sim)}` : ""}
`;
  // Logged-in visitors (session in storage, same key as app.js) jump to the app page, which has join state, faces and
  // live counts; crawlers and visitors without an account have empty storage and stay on this static page.
  const appScript = p.isPast ? "" : `<script>(function(){try{var s=JSON.parse(localStorage.getItem("anyplans_session")||sessionStorage.getItem("anyplans_session")||"null");if(s&&s.access_token)location.replace("${APP}/evento.html?id=${esc(p.id)}");}catch(_){}})();</script>`;
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
  return layout({ vecchio: vecchioDi(p), title, description: descr, url, image, jsonLd: [eventJsonLd(p, url), faqLd(faq)].filter(Boolean).join("\n"), body: body + mapScript + relScript, ogType: "article", modified: p.updated, head: mapHead,
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
<div class="cta"><a class="btn" href="${MAP_URL}">See all events</a><a class="btn ghost" href="${APP}/login.html">Do you run a club? Create your group</a></div>
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
<div class="cta"><a class="btn" href="${MAP_URL}">Vedi tutti gli eventi</a><a class="btn ghost" href="${APP}/login.html">Organizzi un run club? Crea il tuo gruppo</a></div>
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
<div class="cta"><a class="btn" href="${APP}/community.html?slug=${esc(g.slug)}">${S.follow}</a>${g.instagram_handle ? `<a class="btn ghost ico" href="https://instagram.com/${esc(String(g.instagram_handle).replace(/^@/, ""))}" rel="noopener">${IG_SVG}Instagram</a>` : ""}${g.whatsapp_url ? `<a class="btn ghost ico wa" href="${esc(g.whatsapp_url)}" rel="noopener">${WA_SVG}${S.wa}</a>` : ""}<a class="btn ghost" href="${MAP_URL}">${S.all}</a></div>
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
<div class="cta"><a class="btn ghost" href="${APP}/login.html">Do you organise events? Create your group</a></div>
${faqHtml(faq)}
`;
  return layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("it", groupsUrl) });
}
function groupsIndexIt() {
  const url = groupsUrl();
  const title = `Gruppi a ${CITY_NAME}: ${groups.length} comunità a cui unirti | anyplans`;
  const descr = cut(`I gruppi di ${CITY_NAME} su anyplans: associazioni, club e comunità che organizzano eventi aperti a tutti. Li segui e vedi i loro prossimi eventi.`, 160);
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
<div class="cta"><a class="btn ghost" href="${APP}/login.html">Organizzi eventi? Crea il tuo gruppo</a></div>
${faqHtml(faq)}
`;
  return layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("en", groupsUrl) });
}

// ── le pagine dei locali ─────────────────────────────────────────────────────
// Una per locale, più l'elenco. Rispondono alla ricerca fatta col nome del posto ("circolino
// astino", "vog summer club"), che oggi ci trova solo con la pagina di un evento singolo.
const indirizzoLocale = (v) => {
  const p = v.list.find(x => x.meeting) || v.list[0];
  const m = String(p && p.meeting || "").trim();
  return m && norm(m) !== norm(v.nome) ? m : "";
};
const paeseLocale = (v) => {
  const c = new Map();
  for (const p of v.list) { const t = localityOf(p); if (t) c.set(t, (c.get(t) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || CITY_NAME;
};
function venuePage(v) {
  const url = venueUrl(v);
  const E = en();
  const nome = v.nome, paese = paeseLocale(v), indirizzo = indirizzoLocale(v);
  const list = v.list.slice().sort(byDate);
  const up = list.filter(p => !p.isPast), past = list.filter(p => p.isPast).reverse().slice(0, 20);
  const dove = norm(nome).includes(norm(paese)) ? "" : (E ? ` in ${paese}` : ` a ${paese}`);
  // "eventi e serate" solo dove le serate ci sono davvero: in un museo suonerebbe falso
  const notturno = up.some(x => ["nightlife", "concert", "karaoke", "dance", "dinner"].includes(x.sport));
  const h1 = `${nome}: ${E ? (notturno ? "events and nights out" : "what's on") : (notturno ? "eventi e serate" : (up.length ? "eventi in programma" : "eventi e date"))}${dove}`;
  const title = cut(h1, 57) + " | anyplans";
  const tipi = [...new Map(up.map(p => [p.sport, p.tipo])).values()].slice(0, 4).map(t => tLabel(t).toLowerCase());
  const free = up.filter(p => !(p.price_cents > 0)).length;
  // quando non c'è niente in programma la frase di prima diceva "0 eventi in programma. Di ognuno
  // data, ora e prezzo": una contraddizione. I locali fermi ma con una storia la pagina ce l'hanno
  // (il Circolino d'inverno chiude e la gente lo cerca lo stesso): la pagina lo dice e mostra
  // quello che c'è stato.
  const passati = list.filter(p => p.isPast).length;
  const lead = up.length
    ? (E ? `${nome}${dove}: ${up.length} upcoming ${up.length === 1 ? "event" : "events"}${tipi.length ? ` — ${joinIt(tipi)}` : ""}. Date, time, price and how to join, one page each. You go with other people.`
         : `${nome}${dove}: ${up.length} ${up.length === 1 ? "evento in programma" : "eventi in programma"}${tipi.length ? ` — ${joinIt(tipi)}` : ""}. Di ognuno data, ora, prezzo e come iscriversi. Ci vai insieme ad altri.`)
    : (E ? `${nome}${dove}: nothing on right now. Below are the last ${passati} events held here; new dates show up on this page as soon as they are announced.`
         : `${nome}${dove}: al momento non c'è niente in programma. Qui sotto gli ultimi ${passati} eventi che ci sono stati; le date nuove compaiono su questa pagina appena le pubblicano.`);
  const descr = cut(lead, 160);
  const riga = (p) => `${p.title} (${whenLabel(p).toLowerCase()})`;
  const faq = E ? [
    { q: `${nome}: what's on?`, a: up.length ? `${up.length} upcoming ${up.length === 1 ? "event" : "events"}: ${joinIt(up.slice(0, 6).map(riga))}${up.length > 6 ? ", and more in the list above" : ""}.` : `Nothing scheduled right now. Past events are listed below, and new dates appear here as soon as they are published.` },
    { q: `${nome}: where is it?`, a: indirizzo ? `${indirizzo}${norm(indirizzo).includes(norm(paese)) ? "" : ", " + paese}. Every event page has the meeting point and a link to the map.` : `In ${paese}. Every event page has the exact meeting point and a link to the map.` },
    { q: `${nome}: how much is it?`, a: up.length ? `${free === up.length ? "All the upcoming events are free" : free ? `${free} of the ${up.length} upcoming events are free` : "All the upcoming events have a ticket or a fee"}. The price is on each event page.` : `It depends on the event: the price is on each event page.` },
    { q: `${nome}: can I go alone?`, a: `Yes. On anyplans you see who else is going and you join them. Sign-up is free, you only need an email, and you must be 18 or older.` },
  ] : [
    { q: `${nome}: che eventi ci sono?`, a: up.length ? `${up.length === 1 ? "C'è 1 evento in programma" : `Ci sono ${up.length} eventi in programma`}: ${joinIt(up.slice(0, 6).map(riga))}${up.length > 6 ? ", e altri nella lista qui sopra" : ""}.` : `Al momento non c'è niente in programma. Qui sotto ci sono quelli già passati, e le date nuove compaiono qui appena vengono pubblicate.` },
    { q: `${nome}: dove si trova?`, a: indirizzo ? `${indirizzo}${norm(indirizzo).includes(norm(paese)) ? "" : ", " + paese}. In ogni pagina dell'evento c'è il punto di ritrovo e il link alla mappa.` : `A ${paese}. In ogni pagina dell'evento c'è il punto di ritrovo esatto e il link alla mappa.` },
    { q: `${nome}: si paga?`, a: up.length ? `${free === up.length ? "Gli eventi in programma sono tutti gratis" : free ? `${free} eventi su ${up.length} sono gratis` : "Gli eventi in programma hanno tutti un biglietto o una quota"}. Il prezzo è scritto nella pagina di ogni evento.` : `Dipende dall'evento: il prezzo è scritto nella pagina di ognuno.` },
    { q: `${nome}: ci posso andare da solo?`, a: `Sì. Su anyplans vedi chi altro ci va e ti unisci. Registrarsi è gratis, serve solo l'email, e bisogna avere almeno 18 anni.` },
  ];
  const conGeo = v.list.find(p => p.visibility === "open" && p.lat != null && p.lng != null);
  const place = { "@type": "Place", "@id": url + "#locale", name: nome,
    address: { "@type": "PostalAddress", ...(indirizzo ? { streetAddress: indirizzo } : {}), addressLocality: paese, addressRegion: PROV, addressCountry: "IT" },
    ...(conGeo ? { geo: { "@type": "GeoCoordinates", latitude: conGeo.lat, longitude: conGeo.lng } } : {}) };
  const ld = jsonld({ "@context": "https://schema.org", "@graph": [place,
    { "@type": "ItemList", name: h1, url, itemListElement: up.slice(0, 50).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) }] });
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], [E ? "Venues" : "Locali", rel(venuesUrl())], [nome, null]])}
<h1>${esc(h1)}</h1>
<p class="lead">${esc(lead)}</p>
${indirizzo ? `<div class="chips"><span class="chip">📍 ${esc(indirizzo)}</span></div>` : ""}
<div class="cta"><a class="btn" href="${MAP_URL}">${E ? "See it on the map" : "Vedi sulla mappa"}</a><a class="btn ghost" href="${rel(venuesUrl())}">${E ? "All the venues" : "Tutti i locali"}</a></div>
${up.length ? `<h2>${E ? "Upcoming" : "Prossimi"}</h2>${listHtml(up)}` : ""}
${past.length ? `<h2>${E ? "Past" : "Già passati"}</h2>${listHtml(past)}` : ""}
${faqHtml(faq)}
`;
  const lastmod = new Date(Math.max(...list.map(p => p.updated)));
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, modified: lastmod, alt: inLocale(E ? "it" : "en", () => venueUrl(v)) }), lastmod };
}
function venuesIndex() {
  const url = venuesUrl(), E = en();
  const title = `${E ? `Venues in ${CITY_NAME}` : `Locali a ${CITY_NAME}`}: ${venues.length} | anyplans`;
  const descr = cut(E
    ? `${venues.length} venues in ${CITY_NAME} and its province with something on: clubs, bars, sports centres, theatres and squares. One page each, with the upcoming dates.`
    : `${venues.length} locali a ${CITY_NAME} e provincia dove c'è qualcosa in programma: circoli, bar, centri sportivi, teatri e piazze. Ognuno ha la sua pagina con le prossime date.`, 160);
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: title, url,
    itemListElement: venues.map((v, i) => ({ "@type": "ListItem", position: i + 1, url: venueUrl(v), name: v.nome })) });
  const faq = E ? [
    { q: `Which venues are on anyplans in ${CITY_NAME}?`, a: `${venues.length}: ${joinIt(venues.slice(0, 8).map(v => v.nome))}${venues.length > 8 ? " and more" : ""}. Each has its own page with the upcoming dates.` },
    { q: `I run a venue: how do I get on here?`, a: `Publish your dates on anyplans: sign up, create your group and add the events. The page of your venue builds itself from the dates you publish.` },
  ] : [
    { q: `Quali locali ci sono su anyplans a ${CITY_NAME}?`, a: `${venues.length}: ${joinIt(venues.slice(0, 8).map(v => v.nome))}${venues.length > 8 ? " e altri" : ""}. Ognuno ha la sua pagina con le prossime date.` },
    { q: `Ho un locale: come ci finisco?`, a: `Pubblicando le tue date su anyplans: ti registri, crei il tuo gruppo e inserisci gli eventi. La pagina del locale si costruisce da sola con le date che pubblichi.` },
  ];
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], [E ? "Venues" : "Locali", null]])}
<h1>${E ? `Venues in ${esc(CITY_NAME)}` : `Locali a ${esc(CITY_NAME)}`}</h1>
<p class="lead">${esc(descr)}</p>
<div class="list">${venues.map(v => { const n = v.list.filter(p => !p.isPast).length; return `<a class="card" href="${esc(venueUrl(v))}"><span class="em">📍</span><span><span class="t">${esc(v.nome)}</span><br><span class="m">${esc(paeseLocale(v))} · ${n} ${E ? (n === 1 ? "event" : "events") : (n === 1 ? "evento" : "eventi")}</span></span></a>`; }).join("")}</div>
${faqHtml(faq)}
`;
  return layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale(E ? "it" : "en", venuesUrl) });
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
    const nounIntro = { festival: "town festivals and sagre", estivo: "summer venue evenings", dinner: "dinners and aperitivo", running: "group runs and races", padel: "padel matches and tournaments", walking: "group walks",
                        dancing: "dance nights and classes", nightlife: "club nights and dj sets", match: "matches to watch", cinema: "screenings", games: "board game nights", exhibition: "exhibitions", singles: "singles nights" }[ix.sport] || `${label.toLowerCase()} events`;
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
<div class="cta"><a class="btn" href="${MAP_URL}">See all events</a></div>
${up.length ? `<h2>Upcoming</h2>${listHtml(up)}` : ""}
${past.length ? `<h2>Past</h2>${listHtml(past)}` : ""}
${stessoTipoAltrove(ix)}
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
    // "mercatini" è come lo chiamiamo noi, "mercato di Rovetta" è come lo cerca la gente: il titolo
    // della categoria porta tutte e due le parole (testi.json "titolo").
    h1 = `${ix.t.titolo || ix.t.label} a ${CITY_NAME} e provincia`; emoji = ix.t.e;
    title = cut(`${ix.t.titolo || ix.t.label} a ${CITY_NAME}`, 36) + (up.length ? `: ${up.length} ${up.length === 1 ? "evento" : "eventi"}` : "") + " | anyplans";
    // "8 mostre", non "8 eventi di mostre": ogni tipo dice come si chiama quando lo si conta (testi.json "conta")
    const [sing, plur] = String(ix.t.conta || `evento di ${ix.t.label.toLowerCase()}|eventi di ${ix.t.label.toLowerCase()}`).split("|");
    const quanti = `${up.length} ${up.length === 1 ? sing : plur}`;
    intro = `${up.length ? `A ${CITY_NAME} e provincia ci sono ${quanti} nei prossimi mesi.` : `Al momento non ci sono ${plur} in programma: qui sotto quelli già passati.`} ${tPhrase(ix.t)}`;
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
<div class="cta"><a class="btn" href="${MAP_URL}">Vedi tutti gli eventi</a></div>
${up.length ? `<h2>Prossimi</h2>${listHtml(up)}` : ""}
${past.length ? `<h2>Già passati</h2>${listHtml(past)}` : ""}
${stessoTipoAltrove(ix)}
${faqHtml(faq)}
`;
  const lastmod = new Date(Math.max(...list.map(p => p.updated)));
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, modified: lastmod, alt: inLocale("en", () => indexUrl(ix)) }), lastmod };
}
function hubPage() { return en() ? hubPageEn() : hubPageIt(); }
// "Spritz & Burger (Clusone, 12 September)": the town only, and nothing when the town is already in the title
const lc1 = (t) => t && t.startsWith("From ") ? "from " + t.slice(5) : t; // "From 11 September" -> "from 11 September" mid-sentence; weekdays keep their capital
const evTown = (p) => { const t = localityOf(p); return t && !norm(p.title).includes(norm(t)) ? t + ", " : ""; };
// i tipi di evento più numerosi di QUESTA città: i testi dell'hub li elencavano a mano (quelli di
// Bergamo), e a Milano o a Bari erano falsi. Adesso li dice il database.
// le città del sito più vicine a questa: un lettore di Bergamo che non trova niente va a vedere
// Milano o Brescia, e Google arriva a tutte le città anche senza passare dalla sitemap
const vicine = (n = 5) => CITTA.filter(x => x.slug !== CITY)
  .map(x => ({ ...x, d: distKm({ lat: x.lat, lng: x.lng }, { lat: C.lat, lng: C.lng }) }))
  .sort((a, b) => a.d - b.d).slice(0, n);
const cityHref = (x) => `/${en() ? "en/" : ""}${x.slug}${en() ? (x.slug === HOME_CITY ? "/things-to-do" : "") : "/cosa-fare"}/`;
// ── le stesse categorie nelle altre città ────────────────────────────────────
// "feste a Bergamo" sta in posizione 85 su Google mentre "festa oratorio alzano sopra" sta in 6:
// le pagine dei nomi precisi reggono, quelle generiche no. L'unica leva che abbiamo in casa sono i
// link interni: ogni pagina di categoria adesso punta alla stessa categoria nelle città vicine, e
// le 29 pagine "feste" si tengono su a vicenda invece di stare ognuna per conto suo (17/09/2026).
// Le categorie delle altre città si leggono da tools/stato/<citta>.json, scritto dalla corsa
// precedente: si linka solo quello che in quella corsa esisteva davvero, mai un indirizzo inventato.
let _statoAltre = null;
function statoAltre() {
  if (_statoAltre) return _statoAltre;
  _statoAltre = new Map();
  for (const c of CITTA) {
    if (c.slug === CITY) continue;
    try {
      const j = JSON.parse(fsReadSync(path.join(OUT, "tools", "stato", c.slug + ".json"), "utf8"));
      if (j && j.tipi) _statoAltre.set(c.slug, j.tipi);
    } catch { /* città mai generata, o stato vecchio senza tipi */ }
  }
  return _statoAltre;
}
const stessoTipoAltrove = (ix) => {
  if (ix.kind !== "tipo") return "";
  const st = statoAltre();
  const righe = vicine(28).filter(x => (st.get(x.slug) || {})[ix.sport] >= MIN_INDEX).slice(0, 8);
  if (righe.length < 2) return "";
  const nome = tLabel(ix.t);
  return `<h2>${esc(nome)} ${en() ? "in other cities" : "nelle altre città"}</h2><div class="tags">${
    righe.map(x => `<a href="/${en() ? "en/" : ""}${x.slug}/${tSlug(ix.t)}/">${esc(nome)} ${en() ? "in" : "a"} ${esc(x.nome)}</a>`).join("")
  }<a href="${rel(cittaUrl())}">${en() ? "All the cities" : "Tutte le città"}</a></div>`;
};
const vicineHtml = () => `<h2>${en() ? "Nearby cities" : "Qui vicino"}</h2><div class="tags">${
  vicine().map(x => `<a href="${cityHref(x)}">${en() ? "Events in " : "Eventi a "}${esc(x.nome)}</a>`).join("")
}<a href="${rel(cittaUrl())}">${en() ? "All the cities" : "Tutte le città"}</a></div>`;
const topKinds = (n = 6) => [...types].sort((a, b) => b.list.length - a.list.length).slice(0, n).map(x => tLabel(x.t).toLowerCase());
const hubTitolo = () => String(TESTI.hub.titolo).replace("{citta}", CITY_NAME);
const hubSotto = () => CITY === HOME_CITY ? TESTI.hub.sotto
  : `${cap(joinIt(topKinds(5)))}: quello che succede a ${CITY_NAME} e dintorni, in un posto solo. Scegli un evento e ci vai insieme ad altre persone.`;
function hubPageEn() {
  const url = hubUrl();
  const next = upcomingPages.slice(0, 30);
  const title = `Things to do in ${CITY_NAME}: ${upcomingPages.length} events | anyplans`;
  const sotto = `What's on in ${CITY_NAME} and its province, today, tonight and this weekend: ${joinIt(topKinds(6))}. Pick one and go with other people.`;
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
    { q: `What kind of events are there in ${CITY_NAME} on anyplans?`, a: `${cap(joinIt(topKinds(8)))}. Right now ${upcomingPages.length} events are scheduled${groups.length ? `, published by ${groups.length} groups or` : ", "} collected every day from the organisers, the town councils and the platforms where they are announced.` },
    { q: `Are the events in ${CITY_NAME} on anyplans free?`, a: `${free} of the ${upcomingPages.length} upcoming events are free. When there is a ticket or a fee, the price is on the event's page. Signing up on anyplans is free and only needs your email; you must be 18 or older.` },
    { q: `I'm a tourist in ${CITY_NAME}: can I join?`, a: `Yes: run clubs, walks, festivals and dinners are open to everyone, for one evening too. Most descriptions are in Italian because the organisers write them, but times, places and prices are on every page in English, and you can see who else is going before you show up.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Upcoming events in ${CITY_NAME}`, url,
    itemListElement: next.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, null]])}
<h1>Things to do in ${esc(CITY_NAME)}, today and this weekend</h1>
<p class="lead">${esc(sotto)}</p>
<div class="cta"><a class="btn" href="${MAP_URL}">See all events</a>${groups.length ? `<a class="btn ghost" href="${rel(groupsUrl())}">The groups</a>` : `<a class="btn ghost" href="${rel(cittaUrl())}">Other cities</a>`}</div>
${whenLinksEn()}
${types.length ? `<h2>By kind</h2><div class="tags">${types.map(x => `<a href="${rel(indexUrl(x))}">${x.t.e} ${esc(tLabel(x.t))}</a>`).join("")}</div>` : ""}
${towns.length ? `<h2>By town</h2><div class="tags">${towns.slice().sort((a, b) => a.town.localeCompare(b.town, "it")).map(x => `<a href="${rel(indexUrl(x))}">${esc(x.town)}</a>`).join("")}</div>` : ""}
${runClubs.length >= 3 ? `<h2>Running with others</h2><div class="tags"><a href="${rel(runningUrl())}">🏃 Running clubs in ${esc(CITY_NAME)}</a></div>` : ""}
${groups.length ? `<h2>Groups</h2><div class="tags">${groups.map(g => `<a href="${esc(groupUrl(g))}">${g.emoji || "👥"} ${esc(g.name)}</a>`).join("")}</div>` : ""}
${venues.length ? `<h2>Venues</h2><p class="subl">The places where things happen: clubs, bars, sports centres, theatres and squares. Each with its own dates.</p><div class="tags">${venues.slice(0, 12).map(v => `<a href="${esc(venueUrl(v))}">📍 ${esc(v.nome)}</a>`).join("")}<a href="${rel(venuesUrl())}">All the venues</a></div>` : ""}
${vicineHtml()}
<h2>Upcoming events</h2>
${next.length ? listHtml(next) : `<p class="lead">Nothing scheduled right now.</p>`}
${faqHtml(faq)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("it", hubUrl) }), lastmod: pages.length ? new Date(Math.max(...pages.map(p => p.updated))) : NOW };
}
function hubPageIt() {
  const url = hubUrl();
  const next = upcomingPages.slice(0, 30);
  const title = `${hubTitolo()}: ${upcomingPages.length} eventi | anyplans`;
  const descr = cut(`${hubSotto()} ${upcomingPages.length} eventi in programma, ${types.length} tipi di attività${groups.length ? `, ${groups.length} gruppi` : ""}.`, 160);
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
    { q: `Che tipo di eventi ci sono a ${CITY_NAME} su anyplans?`, a: `${cap(joinIt(topKinds(8)))}. In questo momento sono in programma ${upcomingPages.length} eventi${groups.length ? `, pubblicati da ${groups.length} gruppi o` : ","} raccolti ogni giorno da chi li organizza, dai comuni e dalle piattaforme dove vengono annunciati.` },
    { q: `Gli eventi a ${CITY_NAME} su anyplans sono gratis?`, a: `${free} dei ${upcomingPages.length} eventi in programma sono gratis. Quando c'è un biglietto o una quota, il prezzo è scritto nella pagina dell'evento. Registrarsi su anyplans è gratis e serve solo la tua email; bisogna avere almeno 18 anni.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: `Prossimi eventi a ${CITY_NAME}`, url,
    itemListElement: next.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const body = `
${crumbs([["anyplans", "/"], [CITY_NAME, null]])}
<h1>${esc(hubTitolo())}</h1>
<p class="lead">${esc(hubSotto())}</p>
<div class="cta"><a class="btn" href="${MAP_URL}">Vedi tutti gli eventi</a>${groups.length ? `<a class="btn ghost" href="${rel(groupsUrl())}">I gruppi</a>` : `<a class="btn ghost" href="${rel(cittaUrl())}">Le altre città</a>`}</div>
${whenLinksIt()}
${types.length ? `<h2>Per tipo</h2><div class="tags">${types.map(x => `<a href="${rel(indexUrl(x))}">${x.t.e} ${esc(x.t.label)}</a>`).join("")}</div>` : ""}
${towns.length ? `<h2>Per paese</h2><div class="tags">${towns.slice().sort((a, b) => a.town.localeCompare(b.town, "it")).map(x => `<a href="${rel(indexUrl(x))}">${esc(x.town)}</a>`).join("")}</div>` : ""}
${runClubs.length >= 3 ? `<h2>Correre in compagnia</h2><div class="tags"><a href="${rel(runningUrl())}">🏃 Running club a ${esc(CITY_NAME)}</a></div>` : ""}
${groups.length ? `<h2>Gruppi</h2><div class="tags">${groups.map(g => `<a href="${esc(groupUrl(g))}">${g.emoji || "👥"} ${esc(g.name)}</a>`).join("")}</div>` : ""}
${venues.length ? `<h2>I locali</h2><p class="subl">I posti dove succedono le cose: circoli, bar, centri sportivi, teatri e piazze. Ognuno con le sue prossime date.</p><div class="tags">${venues.slice(0, 12).map(v => `<a href="${esc(venueUrl(v))}">📍 ${esc(v.nome)}</a>`).join("")}<a href="${rel(venuesUrl())}">Tutti i locali</a></div>` : ""}
${vicineHtml()}
<h2>Prossimi eventi</h2>
${next.length ? listHtml(next) : `<p class="lead">Niente in programma adesso.</p>`}
${faqHtml(faq)}
`;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, alt: inLocale("en", hubUrl) }), lastmod: pages.length ? new Date(Math.max(...pages.map(p => p.updated))) : NOW };
}

// ── pagine "quando": oggi, domani, weekend, e i prossimi mesi ─────────────────
// Rispondono alle ricerche vere ("cosa fare a Bergamo stasera", "eventi Bergamo ottobre"): stessa lista
// del sito, ma con un testo che dice cosa c'è, dove e a che ora, e le domande frequenti con i numeri veri.
const ixOf = (sport) => [...types].find(x => x.sport === sport) || null;
function typeChips(list) {
  const byType = new Map();
  for (const p of list) byType.set(p.sport, (byType.get(p.sport) || 0) + 1);
  return [...byType].sort((a, b) => b[1] - a[1]).map(([sport, n]) => {
    const t = tipo(sport), ix = ixOf(sport);
    const label = `${t.e} ${esc(tLabel(t))} (${n})`;
    return ix ? `<a href="${rel(indexUrl(ix))}">${label}</a>` : `<span>${label}</span>`;
  }).join("");
}
function townLine(list) {
  const byTown = new Map();
  // "Bergamo Città" è come lo scrive eventi.bergamo.it: sulle nostre pagine è Bergamo (come townName)
  for (const p of list) { const t0 = localityOf(p), t = t0 === "Bergamo Città" ? CITY_NAME : t0; if (t) byTown.set(t, (byTown.get(t) || 0) + 1); }
  return [...byTown].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t} (${n})`);
}
const whenOther = (kind) => ["oggi", "domani", "weekend"].filter(k => k !== kind && WHEN[k].list.length >= MIN_WHEN);
const whenName = (k) => en() ? ({ oggi: "today", domani: "tomorrow", weekend: "this weekend" })[k] : ({ oggi: "oggi", domani: "domani", weekend: "nel weekend" })[k];

const whenLinksIt = () => { const l = ["oggi", "domani", "weekend"].filter(k => WHEN[k].list.length >= MIN_WHEN)
    .map(k => `<a href="${rel(whenUrl(k))}">Cosa fare ${whenName(k)} (${WHEN[k].list.length})</a>`)
    .concat(months.map(m => `<a href="${rel(monthUrl(m))}">Eventi a ${monthLabel(m)} (${monthIdx.get(m).length})</a>`));
  return l.length ? `<h2>Quando</h2><div class="tags">${l.join("")}</div>` : ""; };
const whenLinksEn = () => { const l = ["oggi", "domani", "weekend"].filter(k => WHEN[k].list.length >= MIN_WHEN)
    .map(k => `<a href="${rel(whenUrl(k))}">What to do ${whenName(k)} (${WHEN[k].list.length})</a>`)
    .concat(months.map(m => `<a href="${rel(monthUrl(m))}">Events in ${monthLabel(m)} (${monthIdx.get(m).length})</a>`));
  return l.length ? `<h2>When</h2><div class="tags">${l.join("")}</div>` : ""; };

function whenPage(kind) {
  const w = WHEN[kind], url = whenUrl(kind), list = w.list.slice().sort(byDate);
  const days = w.keys.map(k => { const [y, m, d] = k.split("-"); return new Date(Date.UTC(+y, +m - 1, +d, 12)); });
  const dayNames = days.map(d => fmtDay(d, DEFAULT_TZ));
  const free = list.filter(p => !(p.price_cents > 0)).length;
  const towns = townLine(list);
  const when = kind === "weekend" ? (en() ? `this weekend (${joinIt(dayNames)})` : `nel weekend (${joinIt(dayNames)})`)
             : kind === "oggi" ? (en() ? `today, ${fmtDate(NOW)}` : `oggi, ${fmtDate(NOW)}`)
             : (en() ? `tomorrow, ${fmtDate(dayAfter(1))}` : `domani, ${fmtDate(dayAfter(1))}`);
  const h1 = en() ? `What to do in ${CITY_NAME} ${kind === "weekend" ? "this weekend" : kind === "oggi" ? "today" : "tomorrow"}`
                  : `Cosa fare a ${CITY_NAME} ${kind === "weekend" ? "nel weekend" : kind === "oggi" ? "oggi" : "domani"}`;
  const title = cut(h1, 44) + `: ${list.length} ${en() ? "events" : "eventi"} | anyplans`;
  const lead = en()
    ? `${list.length} events in ${CITY_NAME} and its province ${when}: ${joinIt(towns.slice(0, 4).map(t => t.replace(/ \(\d+\)$/, "")))} and more. Town festivals, markets, concerts, runs, dinners: pick one and go with other people. Updated every night.`
    : `${list.length} eventi a ${CITY_NAME} e provincia ${when}: ${joinIt(towns.slice(0, 4).map(t => t.replace(/ \(\d+\)$/, "")))} e altri. Feste di paese, mercati, concerti, uscite di corsa, cene: ne scegli uno e ci vai insieme ad altre persone. Aggiornato ogni notte.`;
  const descr = cut(lead, 160);
  const first = list.slice(0, 8).map(p => `${p.title}${evTown(p) ? (en() ? " in " : " a ") + evTown(p).replace(/, $/, "") : ""}`);
  const faq = en() ? [
    { q: `What is on in ${CITY_NAME} ${kind === "weekend" ? "this weekend" : kind === "oggi" ? "today" : "tomorrow"}?`,
      a: `${list.length} events ${when}: ${joinIt(first)}${list.length > 8 ? " and more, all in the list above" : ""}.` },
    { q: `Is there anything free ${kind === "weekend" ? "this weekend" : kind === "oggi" ? "today" : "tomorrow"} in ${CITY_NAME}?`,
      a: `${free} of the ${list.length} are free, mostly town festivals, markets and group walks. When there is a ticket or a fee, the price is on the event page.` },
    { q: `Where are they?`, a: `In ${CITY_NAME} and its province: ${joinIt(towns)}. Every page has the meeting point and a link to the map.` },
    { q: `Can I go alone?`, a: `Yes, that is the point: on anyplans you see who else is going and you join them. Sign-up is free, you only need an email, and you must be 18 or older.` },
  ] : [
    { q: `Cosa si fa a ${CITY_NAME} ${kind === "weekend" ? "questo weekend" : kind === "oggi" ? "oggi" : "domani"}?`,
      a: `${list.length} eventi ${when}: ${joinIt(first)}${list.length > 8 ? " e altri, tutti nella lista qui sopra" : ""}.` },
    { q: `C'è qualcosa di gratis ${kind === "weekend" ? "questo weekend" : kind === "oggi" ? "oggi" : "domani"} a ${CITY_NAME}?`,
      a: `${free} eventi su ${list.length} sono gratis: soprattutto feste di paese, mercati e camminate di gruppo. Quando c'è un biglietto o una quota, il prezzo è scritto nella pagina dell'evento.` },
    { q: `In che paesi?`, a: `A ${CITY_NAME} e in provincia: ${joinIt(towns)}. In ogni pagina c'è il punto di ritrovo e il link alla mappa.` },
    { q: `Ci posso andare da solo?`, a: `Sì, è il senso di anyplans: vedi chi altro ci va e ti unisci. Registrarsi è gratis, serve solo l'email, e bisogna avere almeno 18 anni.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: h1, url,
    itemListElement: list.slice(0, 50).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const others = whenOther(kind).map(k => `<a href="${rel(whenUrl(k))}">${en() ? "What to do " : "Cosa fare "}${whenName(k)}</a>`)
    .concat(months.map(m => `<a href="${rel(monthUrl(m))}">${en() ? "Events in " : "Eventi a "}${monthLabel(m)}</a>`)).join("");
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], [en() ? (kind === "weekend" ? "This weekend" : kind === "oggi" ? "Today" : "Tomorrow") : cap(whenName(kind)), null]])}
<h1>${esc(h1)}</h1>
<p class="lead">${esc(lead)}</p>
<div class="cta"><a class="btn" href="${MAP_URL}">${en() ? "See them on the map" : "Vedili sulla mappa"}</a><a class="btn ghost" href="${rel(hubUrl())}">${en() ? "All events" : "Tutti gli eventi"}</a></div>
${list.length ? `<h2>${en() ? "By kind" : "Per tipo"}</h2><div class="tags">${typeChips(list)}</div>` : ""}
<h2>${en() ? "The list" : "La lista"}</h2>
${listHtml(list.slice(0, 80))}
${others ? `<h2>${en() ? "Other days" : "Altri giorni"}</h2><div class="tags">${others}</div>` : ""}
${faqHtml(faq)}
`;
  const lastmod = list.length ? new Date(Math.max(...list.map(p => p.updated))) : NOW;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, modified: lastmod, alt: inLocale(en() ? "it" : "en", () => whenUrl(kind)) }), lastmod };
}

function monthPage(m) {
  const url = monthUrl(m), label = monthLabel(m);
  const list = (monthIdx.get(m) || []).slice().sort(byDate);
  const free = list.filter(p => !(p.price_cents > 0)).length;
  const towns = townLine(list);
  const h1 = en() ? `Events in ${CITY_NAME} in ${label}` : `Eventi a ${CITY_NAME} a ${label}`;
  const title = cut(h1, 44) + `: ${list.length} | anyplans`;
  const kinds = [...new Map(list.map(p => [p.sport, p.sport])).keys()].slice(0, 5).map(x => tLabel(tipo(x)).toLowerCase());
  const lead = en()
    ? `${list.length} events in ${CITY_NAME} and its province in ${label}: ${joinIt(kinds)}. Day by day, with times, place and price, in ${joinIt(towns.slice(0, 4).map(t => t.replace(/ \(\d+\)$/, "")))} and other towns. You sign up and go with other people.`
    : `${list.length} eventi a ${CITY_NAME} e provincia a ${label}: ${joinIt(kinds)}. Giorno per giorno, con orari, luogo e prezzo, a ${joinIt(towns.slice(0, 4).map(t => t.replace(/ \(\d+\)$/, "")))} e in altri paesi. Ti iscrivi e ci vai insieme ad altre persone.`;
  const descr = cut(lead, 160);
  const evLine = (p) => `${p.title} (${evTown(p)}${whenLabel(p).toLowerCase()})`;
  const faq = en() ? [
    { q: `What is on in ${CITY_NAME} in ${label}?`, a: `${list.length} events: ${joinIt(list.slice(0, 8).map(evLine))}${list.length > 8 ? " and more, all in the list above" : ""}.` },
    { q: `Which towns?`, a: `${joinIt(towns)}. Every page has the meeting point and a link to the map.` },
    { q: `How much do they cost?`, a: `${free} of the ${list.length} are free. When there is a ticket or a fee, the price is on the event page; you pay the organiser, not anyplans.` },
  ] : [
    { q: `Cosa c'è a ${CITY_NAME} a ${label}?`, a: `${list.length} eventi: ${joinIt(list.slice(0, 8).map(evLine))}${list.length > 8 ? " e altri, tutti nella lista qui sopra" : ""}.` },
    { q: `In che paesi?`, a: `${joinIt(towns)}. In ogni pagina c'è il punto di ritrovo e il link alla mappa.` },
    { q: `Quanto costano?`, a: `${free} su ${list.length} sono gratis. Quando c'è un biglietto o una quota il prezzo è nella pagina dell'evento: si paga a chi organizza, non ad anyplans.` },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: h1, url,
    itemListElement: list.slice(0, 50).map((p, i) => ({ "@type": "ListItem", position: i + 1, url: eventUrl(p), name: p.title })) });
  const others = months.filter(x => x !== m).map(x => `<a href="${rel(monthUrl(x))}">${en() ? "Events in " : "Eventi a "}${monthLabel(x)}</a>`)
    .concat(whenOther(null).map(k => `<a href="${rel(whenUrl(k))}">${en() ? "What to do " : "Cosa fare "}${whenName(k)}</a>`)).join("");
  const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], [label, null]])}
<h1>${esc(h1)}</h1>
<p class="lead">${esc(lead)}</p>
<div class="cta"><a class="btn" href="${MAP_URL}">${en() ? "See them on the map" : "Vedili sulla mappa"}</a><a class="btn ghost" href="${rel(hubUrl())}">${en() ? "All events" : "Tutti gli eventi"}</a></div>
<h2>${en() ? "By kind" : "Per tipo"}</h2><div class="tags">${typeChips(list)}</div>
<h2>${en() ? "The list" : "La lista"}</h2>
${listHtml(list.slice(0, 80))}
${others ? `<h2>${en() ? "Other periods" : "Altri periodi"}</h2><div class="tags">${others}</div>` : ""}
${faqHtml(faq)}
`;
  const lastmod = list.length ? new Date(Math.max(...list.map(p => p.updated))) : NOW;
  return { html: layout({ title, description: descr, url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body, modified: lastmod, alt: inLocale(en() ? "it" : "en", () => monthUrl(m)) }), lastmod };
}

// ── llms.txt: what the site is and where the answers are, for AI crawlers (llmstxt.org) ──
function llmsTxt() {
  const line = (name, href, note) => `- [${name}](${href})${note ? `: ${note}` : ""}`;
  // una sezione senza righe non si stampa: "## Gruppi" seguito dal vuoto e' rumore per chi legge il file
  const section = (title, lines) => lines.filter(Boolean).length ? `\n## ${title}\n\n${lines.filter(Boolean).join("\n")}\n` : "";
  // gli indirizzi veri delle pagine, non ricostruiti a mano: a Bergamo l'hub e' /bergamo/cosa-fare/ (in
  // /bergamo/ c'e' l'app), nelle altre citta e' /milano/. Scritti a mano, le 28 citta nuove mandavano
  // ChatGPT, Claude e Perplexity su tre 404 in cima al file.
  const itHub = inLocale("it", hubUrl), enHub = inLocale("en", hubUrl);
  const itRunning = inLocale("it", runningUrl), enRunning = inLocale("en", runningUrl);
  const itGroups = inLocale("it", groupsUrl), enGroups = inLocale("en", groupsUrl);
  const dayLines = [];
  for (let i = 0; i < 7; i++) {
    const rows = schedules.filter(x => x.weekday === i && runClubs.some(g => g.slug === x.community_slug));
    if (rows.length) dayLines.push(line(`Run club il ${WEEKDAYS_IT[i].toLowerCase()}`, `${itRunning}${LOCALES.it.daySlug[i]}/`, rows.map(r => `${r.community_name} alle ${hhmm(r.start_time)}`).join(", ")));
  }
  const altre = CITTA.filter(c => c.slug !== CITY).map(c => c.nome);
  return `# anyplans

> anyplans (anyplans.in) è la mappa degli eventi veri di ${CITY_NAME} e provincia: feste di paese e sagre, concerti, mercati, corsi di cucina e di ceramica, volontariato, uscite sportive, cene con sconosciuti. Raccoglie gli eventi già esistenti dai siti dei comuni, delle associazioni e delle piattaforme dove vengono annunciati, più quelli pubblicati dai gruppi; chi li vede si iscrive e ci va insieme ad altri. Solo maggiorenni. Registrazione gratuita con email. Questo file parla di ${CITY_NAME}: il sito copre ${CITTA.length} città italiane (${altre.join(", ")}), l'indice è ${SITE}/llms.txt.

Le pagine si rigenerano ogni notte dai dati: date, orari, luoghi e prezzi sono quelli pubblicati da chi organizza. Ultimo aggiornamento: ${NOW.toISOString().slice(0, 10)}. Instagram: ${INSTAGRAM}. Contatto: hello@anyplans.in.
${section("Pagine principali", [
  line(`Cosa fare a ${CITY_NAME}`, itHub, `tutti gli eventi in programma (${upcomingPages.length}), per tipo e per paese; risponde a "cosa fare a ${CITY_NAME} oggi / questo weekend"`),
  runClubs.length ? line(`Running club a ${CITY_NAME}`, itRunning, `${runClubs.length} run club per giorno della settimana, con ritrovo, orario e domande frequenti`) : "",
  groups.length ? line(`Gruppi a ${CITY_NAME}`, itGroups, `${groups.length} associazioni, club e comunità che pubblicano eventi`) : "",
  line("Tutte le città", `${SITE}/citta/`, "l'elenco delle città con quanti eventi ha ognuna"),
  line("Le regole di anyplans", `${SITE}/guidelines.html`),
  line("Privacy", `${SITE}/privacy-it.html`),
  line("Condizioni d'uso", `${SITE}/terms-it.html`),
])}${section("Eventi per tipo e per paese", [
  ...types.map(x => line(`${x.t.label} a ${CITY_NAME}`, `${SITE}/${CITY}/${x.slug}/`, `${x.list.filter(p => !p.isPast).length} in programma`)),
  ...towns.map(x => line(`Feste ed eventi a ${x.town}`, `${SITE}/${CITY}/${x.slug}/`, `${x.list.filter(p => !p.isPast).length} in programma`)),
])}${section("Running club per giorno", dayLines)}${section("Gruppi",
  groups.map(g => line(g.name, groupUrl(g), isRunClub(g) ? (g.sport === "walking" ? "gruppo di camminata" : "run club") : (g.upcoming_count > 0 ? `${g.upcoming_count} eventi in programma` : ""))),
)}${section("Prossimi eventi",
  upcomingPages.slice(0, 40).map(p => line(p.title, eventUrl(p), `${whenLabel(p)}, ${placeShort(p)}, ${fmtPrice(p.price_cents)}`)),
)}${section("Optional", [
  line("Tutte le pagine in un file", `${SITE}/${LLMS_FILE}`, "titolo, riassunto e domande frequenti di ogni pagina"),
  line("Sitemap", `${SITE}/sitemap.xml`),
  line("Versione inglese della home", `${SITE}/en/`),
])}${section("English pages (same content, for visitors)", [
  line(`Things to do in ${CITY_NAME}`, enHub, `all upcoming events, by kind and by town; answers "what to do in ${CITY_NAME} today / this weekend"`),
  runClubs.length ? line(`Running clubs in ${CITY_NAME}`, enRunning, `${runClubs.length} run clubs by weekday, open to visitors too`) : "",
  groups.length ? line(`Groups in ${CITY_NAME}`, enGroups) : "",
  ...types.map(x => line(`${EN_TYPES[x.sport]?.[1] || x.t.label} in ${CITY_NAME}`, `${SITE}/en/${CITY}/${EN_TYPES[x.sport]?.[0] || x.slug}/`)),
])}`;
}

// ── robots & sitemap ──────────────────────────────────────────────────────────
const ROBOTS = `User-agent: *
Disallow: ${APP}/login.html
Disallow: ${APP}/profilo.html
Disallow: ${APP}/crea.html
Disallow: ${APP}/crea-community.html
Disallow: ${APP}/dashboard.html
Disallow: ${APP}/checkin.html
Disallow: ${APP}/notifiche.html
Disallow: ${APP}/impostazioni.html
Disallow: ${APP}/miei.html
Disallow: ${APP}/seguo.html
Disallow: ${APP}/chiedi.html
Disallow: ${APP}/tipo-account.html
Disallow: ${APP}/raccontaci-gruppo.html
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
const LLMS_FILE = CITY === HOME_CITY ? "llms-full.txt" : `llms-${CITY}.txt`;
// una sitemap per citta (sitemap-milano.xml) e un indice che le tiene insieme: Google vuole al massimo
// 50.000 url per file e, soprattutto, cosi si vede in Search Console quale citta e' indicizzata e quale no
// ── IndexNow ──────────────────────────────────────────────────────────────────
// deploy-site.sh avvisa gia' IndexNow, ma solo quando Filippo deploya dal Mac e solo per una manciata di
// pagine. Le pagine nuove nascono di notte, qui dentro: un ping dice a Bing (e quindi a Copilot e a ChatGPT,
// che pescano da li) quali sono cambiate, senza aspettare che ripassi da solo. Si manda solo cio' che e'
// cambiato davvero: il lastmod di un evento e' il suo updated_at, quindi in una notte tranquilla partono
// gli indici e poco altro.
// Si accende da solo dentro GitHub Actions (il file del workflow non si puo' toccare da qui: il token del
// deploy non ha il permesso "workflow") oppure a mano con --indexnow. I giri di prova in locale non avvisano nessuno.
const INDEXNOW_KEY = "7f26113ec56cadfa6f45d689241489b1";
// api.indexnow.org e bing.com rispondono 403 a questo sito (la verifica della chiave non passa, non si sa
// perche': il file c'e' ed e' raggiungibile). yandex.com accetta e per protocollo passa gli url agli altri,
// Bing compreso: e' lo stesso endpoint che usa gia' deploy-site.sh. Verificato il 15/09/2026.
const INDEXNOW_ENDPOINT = "https://yandex.com/indexnow";
const INDEXNOW = args.includes("--indexnow") || process.env.GITHUB_ACTIONS === "true";
async function indexNow() {
  if (!INDEXNOW || FIXTURE) return;
  const today = NOW.toISOString().slice(0, 10);
  const cambiati = [...new Set((args.includes("--indexnow-tutto") ? sitemapEntries : sitemapEntries.filter(e => e.lastmod === today)).map(e => e.loc))];
  if (!cambiati.length) return console.log("indexnow: niente di cambiato oggi");
  // se una fonte ritocca updated_at a ogni passata, "cambiato oggi" diventa tutta la citta e ogni notte
  // partirebbero tredicimila indirizzi: un elenco cosi non e' piu' una notizia. Si manda il primo migliaio,
  // e sono gli indici e le pagine "oggi / domani / weekend", che stanno in cima perche' scritti per primi.
  const TETTO = 1000;
  const urls = cambiati.slice(0, TETTO);
  if (cambiati.length > TETTO) console.log(`indexnow: ${cambiati.length} pagine cambiate, ne mando ${TETTO} (le altre le trova dalla sitemap)`);
  for (let i = 0; i < urls.length; i += 10000) {
    const chunk = urls.slice(i, i + 10000);
    try {
      const res = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: "anyplans.in", key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: chunk }),
      });
      console.log(`indexnow: ${chunk.length} url → HTTP ${res.status}`);
    } catch (e) {
      console.log(`indexnow: non risponde (${e.message}) — le pagine sono comunque nella sitemap`);
    }
  }
}

function sitemapIndexXml(files) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${files.map(f => `  <sitemap><loc>${SITE}/${f}</loc><lastmod>${NOW.toISOString().slice(0, 10)}</lastmod></sitemap>`).join("\n")}
</sitemapindex>
`;
}
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
const scritte = new Set();          // quello che questa corsa ha scritto: serve alle lapidi
async function writePage(rel, html) {
  scritte.add(rel);
  const dir = path.join(OUT, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html);
  const pick = (re) => { const m = html.match(re); return m ? unesc(m[1]).trim() : ""; };
  const title = pick(/<title>(.*?)<\/title>/s), descr = pick(/<meta name="description" content="(.*?)">/s), lead = pick(/<p class="lead">(.*?)<\/p>/s);
  const faq = [...html.matchAll(/<h3>(.*?)<\/h3><p>(.*?)<\/p>/gs)].map(m => `**${unesc(m[1])}**\n${unesc(m[2])}`);
  fullTxt.push(`## ${title.replace(/ \| anyplans$/, "")}\n${SITE}/${rel}/\n\n${lead || descr}\n${faq.length ? "\n" + faq.join("\n\n") + "\n" : ""}`);
}

// ── /citta/ (e /en/cities/): l'elenco delle città, scritto dal run --indice ────
// Serve a tre cose: dà a Google una porta d'ingresso unica verso tutte le città (senza, le pagine di
// Torino sarebbero raggiungibili solo dalla sitemap), risponde da sola alla domanda "in che città c'è
// anyplans" e tiene i numeri veri, aggiornati ogni notte.
function cittaPage(stato) {
  const url = cittaUrl();
  const tot = stato.reduce((n, c) => n + c.eventi, 0);
  const first = stato.slice(0, 6).map(c => c.nome);
  const h1 = en() ? "Events in Italy, city by city" : "Gli eventi in Italia, città per città";
  const title = (en() ? `Events in Italy: ${stato.length} cities` : `Eventi in Italia: ${stato.length} città`) + " | anyplans";
  const lead = en()
    ? `anyplans has ${nf(tot)} upcoming events in ${stato.length} Italian cities: ${first.join(", ")} and more. Concerts, town festivals, markets, dinners with strangers, group runs and open padel matches, each with date, place, price and how to sign up. Updated every night.`
    : `Su anyplans ci sono ${nf(tot)} eventi in programma in ${stato.length} città italiane: ${first.join(", ")} e altre. Concerti, feste di paese, mercati, cene con sconosciuti, uscite di corsa e partite di padel aperte, ognuno con data, luogo, prezzo e come iscriversi. Aggiornato ogni notte.`;
  const cards = stato.map(c => `<a href="/${en() ? "en/" : ""}${c.slug}${en() ? (c.slug === HOME_CITY ? "/things-to-do" : "") : "/cosa-fare"}/">${esc(c.nome)}<span class="n">${c.eventi}</span></a>`).join("");
  const faq = en() ? [
    { q: "Which cities is anyplans in?", a: `${stato.length} cities: ${joinIt(stato.map(c => `${c.nome} (${c.eventi} events)`))}.` },
    { q: "My city is not here. Why?", a: "Because there are not enough events yet to make a page worth reading. The map covers the whole country: open it and drag it where you live, the events load as you go." },
    { q: "Where do the events come from?", a: "From the people and groups who publish them on anyplans, and from public sources we read every day (town councils, venues, clubs and event platforms). Every page links back to the organiser." },
    { q: "How much does it cost?", a: "anyplans is free. When an event has a ticket or a fee, the price is on its page and you pay the organiser, not us." },
  ] : [
    { q: "In che città c'è anyplans?", a: `In ${stato.length} città: ${joinIt(stato.map(c => `${c.nome} (${c.eventi} eventi)`))}.` },
    { q: "La mia città non c'è, perché?", a: "Perché per ora non ci sono abbastanza eventi da farne una pagina che valga la pena leggere. La mappa però copre tutta Italia: aprila e trascinala dove vivi, gli eventi si caricano mentre ti sposti." },
    { q: "Da dove arrivano gli eventi?", a: "Da chi li pubblica su anyplans (persone e gruppi) e da fonti pubbliche che leggiamo ogni giorno: comuni, locali, associazioni e piattaforme di eventi. In ogni pagina c'è il link a chi organizza." },
    { q: "Quanto costa?", a: "anyplans è gratis. Quando un evento ha un biglietto o una quota il prezzo è scritto nella sua pagina e si paga a chi organizza, non a noi." },
  ];
  const ld = jsonld({ "@context": "https://schema.org", "@type": "ItemList", name: h1, url, numberOfItems: stato.length,
    itemListElement: stato.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.nome,
      url: `${SITE}${en() ? "/en" : ""}/${c.slug}${en() ? (c.slug === HOME_CITY ? "/things-to-do" : "") : "/cosa-fare"}/` })) });
  const body = `
${crumbs([["anyplans", L.home], [en() ? "Cities" : "Città", null]])}
<h1>${esc(h1)}</h1>
<p class="lead">${esc(lead)}</p>
<div class="cta"><a class="btn" href="${APP}/eventi.html">${en() ? "Open the map" : "Apri la mappa"}</a></div>
<h2>${en() ? "The cities" : "Le città"}</h2>
<div class="tags citta">${cards}</div>
${faqHtml(faq)}
`;
  return layout({ title, description: cut(lead, 160), url, image: OG_DEFAULT, jsonLd: ld + "\n" + faqLd(faq), body,
                  about: ITALIA, alt: inLocale(en() ? "it" : "en", () => cittaUrl()) });
}

const cityDir = path.join(OUT, CITY);
const statoDir = path.join(OUT, "tools", "stato");

// ── --indice: nessuna città, solo i file che tengono insieme il sito ──────────
if (INDICE) {
  const stato = [];
  for (const c of CITTA) {
    try { stato.push(JSON.parse(await readFile(path.join(statoDir, c.slug + ".json"), "utf8"))); } catch { /* città saltata */ }
  }
  if (!stato.length) { console.error("--indice: nessuna città generata, non tocco niente"); process.exit(1); }
  stato.sort((a, b) => b.eventi - a.eventi);
  const sitemaps = [];
  for (const code of ["it", "en"]) {
    setLocale(code);
    await writePage(rel(cittaUrl()).replace(/^\/|\/$/g, ""), cittaPage(stato));
    addUrl(cittaUrl(), NOW);
  }
  setLocale('it');
  addUrl(SITE + "/", NOW);
  addUrl(SITE + "/en/", NOW);
  // pagine del sito fuori dal generatore (16/09/2026): la pagina dei viaggi di gruppo e il blog
  addUrl(SITE + "/viaggi-di-gruppo/", NOW);
  addUrl(SITE + "/blog.html", NOW);
  await writeFile(path.join(OUT, "sitemap-sito.xml"), sitemapXml());
  sitemaps.push("sitemap-sito.xml", ...stato.map(c => `sitemap-${c.slug}.xml`));
  await writeFile(path.join(OUT, "sitemap.xml"), sitemapIndexXml(sitemaps));
  await writeFile(path.join(OUT, "robots.txt"), ROBOTS);
  const tot = stato.reduce((n, c) => n + c.eventi, 0);
  await writeFile(path.join(OUT, "llms.txt"), `# anyplans

> La mappa degli eventi veri d'Italia: ${tot} eventi in programma in ${stato.length} città. Feste di paese, concerti,
> mercati, cene con sconosciuti, uscite di corsa, partite di padel aperte. Di ognuno: data, luogo, prezzo,
> chi organizza e come iscriversi. Si entra con l'email, solo maggiorenni. Aggiornato ogni notte.
> Ha anche una pagina che confronta i viaggi di gruppo per chi parte da solo (WeRoad, SiVola, Zest Family).

Le pagine sono statiche e leggibili senza javascript. Ogni città ha il suo file completo con titolo,
riassunto e domande frequenti di ogni pagina.

## Le città

${stato.map(c => `- [${c.nome}](${SITE}/${c.slug}/cosa-fare/): ${c.eventi} eventi in programma, ${c.pagine} pagine — testo completo: ${SITE}/${c.slug === HOME_CITY ? "llms-full.txt" : `llms-${c.slug}.txt`}`).join("\n")}

## Il sito

- [Tutte le città](${SITE}/citta/): l'elenco con quanti eventi ci sono in ognuna
- [Viaggi di gruppo](${SITE}/viaggi-di-gruppo/): le partenze di WeRoad, SiVola e Zest Family a confronto (destinazione, date, durata, prezzo, età, volo); si prenota da loro
- [Sitemap](${SITE}/sitemap.xml): l'indice delle sitemap, una per città
- [Le regole](${SITE}/guidelines.html) · [Privacy](${SITE}/privacy-it.html) · [Condizioni](${SITE}/terms-it.html)

## Come citarci

anyplans, ${SITE} — scrivere il nome dell'evento, la data e il link alla sua pagina su anyplans.
I dati cambiano ogni notte: le pagine portano la data di aggiornamento in fondo.
`);
  console.log(`indice: ${stato.length} città, ${tot} eventi, ${sitemaps.length} sitemap → ${OUT}`);
  process.exit(0);
}

// ── una città con pochi eventi tiene solo l'essenziale ────────────────────────
// Sotto la soglia restano l'hub (l'indirizzo /torino/ non deve mai sparire: ci puntano i link delle
// altre città) e le pagine degli eventi, che sono contenuto vero. Saltano gli indici per tipo e per
// paese e le pagine oggi/domani/weekend/mese: con quattro eventi sarebbero pagine mezze vuote.
const SOLO_HUB = CITY !== HOME_CITY && upcomingPages.length < MIN_CITY;
if (SOLO_HUB) console.log(`${CITY}: ${upcomingPages.length} eventi futuri, sotto ${MIN_CITY}: solo hub e pagine evento`);

// ── le lapidi ────────────────────────────────────────────────────────────────
// Un evento sparisce dalla fonte quando si riempie o viene tolto (le cene di Tablo, le partite di
// padel): la sua pagina spariva e chi ci arrivava da Google trovava un "non trovato". Il 19/09/2026
// erano 71 pagine, tutte già indicizzate: posti nell'indice guadagnati e buttati via.
// Adesso la pagina resta e dice che l'evento non c'è più, con i link per trovarne altri. Non si fa
// indicizzare (noindex) ma i suoi link continuano a valere (follow). Dopo GIORNI_TOMBA giorni sparisce
// davvero: a quel punto Google l'ha tolta dall'indice e tenerla non serve a nessuno.
const GIORNI_TOMBA = 60;
const TOMBA = /<!--tomba:(\d{4}-\d{2}-\d{2})-->/;
async function cosaCera(dir) {
  const out = new Map();
  let voci = [];
  try { voci = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of voci) {
    if (!e.isDirectory()) continue;
    let h = "";
    try { h = await readFile(path.join(dir, e.name, "index.html"), "utf8"); } catch { continue; }
    const t = (h.match(/<title>(.*?)<\/title>/s) || [])[1] || "";
    const tomba = (h.match(TOMBA) || [])[1] || null;
    out.set(e.name, { titolo: unesc(t).replace(/ \| anyplans$/, "").trim(), tomba });
  }
  return out;
}
const ceraIt = await cosaCera(cityDir);
const ceraEn = await cosaCera(path.join(OUT, "en", CITY));

await mkdir(cityDir, { recursive: true });
for (const e of await readdir(cityDir, { withFileTypes: true })) if (e.isDirectory()) await rm(path.join(cityDir, e.name), { recursive: true, force: true });
await rm(path.join(OUT, "en", CITY), { recursive: true, force: true }); // /en/index.html (the English home) stays

// the same pages in Italian and in English: urls, labels and texts come from the active locale
const relOf = (u) => rel(u).replace(/^\/|\/$/g, "");
for (const code of ["it", "en"]) {
  setLocale(code);
  const hub = hubPage(); await writePage(relOf(hubUrl()), hub.html); addUrl(hubUrl(), hub.lastmod);
  for (const k of SOLO_HUB ? [] : ["oggi", "domani", "weekend"]) {       // "cosa fare a Bergamo oggi/domani/nel weekend"
    if (WHEN[k].list.length < MIN_WHEN) continue;
    const r = whenPage(k); await writePage(relOf(whenUrl(k)), r.html); addUrl(whenUrl(k), r.lastmod);
  }
  for (const m of (SOLO_HUB ? [] : months)) {                            // "eventi a Bergamo a ottobre"
    const r = monthPage(m); await writePage(relOf(monthUrl(m)), r.html); addUrl(monthUrl(m), r.lastmod);
  }
  for (const ix of (SOLO_HUB ? [] : [...types, ...towns])) { const r = indexPage(ix); await writePage(relOf(indexUrl(ix)), r.html); addUrl(indexUrl(ix), r.lastmod); }
  if (groups.length) { await writePage(relOf(groupsUrl()), groupsIndex()); addUrl(groupsUrl(), NOW); }
  if (!SOLO_HUB && venues.length) {                                       // "circolino astino", "vog summer club": la gente cerca il posto per nome
    await writePage(relOf(venuesUrl()), venuesIndex()); addUrl(venuesUrl(), NOW);
    for (const v of venues) { const r = venuePage(v); await writePage(relOf(venueUrl(v)), r.html); addUrl(venueUrl(v), r.lastmod); }
  }
  if (runClubs.length >= 3) {
    const r = runningHub(); await writePage(relOf(runningUrl()), r.html); addUrl(runningUrl(), r.lastmod);
    for (let i = 0; i < 7; i++) {
      if (!schedules.some(x => x.weekday === i && runClubs.some(g => g.slug === x.community_slug))) continue;
      const d = runningDayPage(i); await writePage(relOf(dayUrl(i)), d.html); addUrl(dayUrl(i), d.lastmod);
    }
  }
  for (const g of groups) { const r = groupPage(g); await writePage(relOf(groupUrl(g)), r.html); addUrl(groupUrl(g), r.lastmod); }
  for (const p of pages) { await writePage(relOf(eventUrl(p)), eventPage(p)); if (!vecchioDi(p)) addUrl(eventUrl(p), p.updated); }
}
setLocale('it');

// le lapidi: quello che c'era prima e questa corsa non ha riscritto
async function lapidi(cera, prefisso, code) {
  setLocale(code);
  const E = code === "en";
  const oggi = NOW.toISOString().slice(0, 10);
  let messe = 0, sepolte = 0;
  for (const [slug, info] of cera) {
    if (scritte.has(`${prefisso}/${slug}`)) continue;
    if (info.tomba && (NOW - new Date(info.tomba)) > GIORNI_TOMBA * 86400e3) { sepolte++; continue; }
    const nome = info.titolo && !/^anyplans$/i.test(info.titolo) ? info.titolo.split(/ [–|] /)[0].trim() : "";
    const url = `${SITE}/${prefisso}/${slug}/`;
    const h1 = nome
      ? (E ? `${nome}: this event is no longer listed` : `${nome}: questo evento non è più in programma`)
      : (E ? "This event is no longer listed" : "Questo evento non è più in programma");
    const descr = E
      ? `This event is no longer on anyplans: it filled up, or whoever organises it took it down. Here is what is on in ${CITY_NAME} now.`
      : `Questo evento non è più su anyplans: si è riempito, oppure chi lo organizza l'ha tolto. Qui sotto c'è quello che c'è adesso a ${CITY_NAME}.`;
    const body = `
${crumbs([["anyplans", L.home], [CITY_NAME, rel(hubUrl())], [E ? "Not listed" : "Non più in programma", null]])}
<h1>${esc(h1)}</h1>
<p class="lead">${esc(descr)}</p>
<div class="cta"><a class="btn" href="${rel(hubUrl())}">${E ? `What's on in ${esc(CITY_NAME)}` : `Cosa c'è a ${esc(CITY_NAME)}`}</a><a class="btn ghost" href="${MAP_URL}">${E ? "See the map" : "Vedi la mappa"}</a></div>
${vicineHtml()}
`;
    const html = layout({ vecchio: true, title: cut(h1, 57) + " | anyplans", description: cut(descr, 160),
                          url, image: OG_DEFAULT, jsonLd: "", body, alt: null })
      .replace("</head>", `<!--tomba:${info.tomba || oggi}-->\n</head>`);
    const dir = path.join(OUT, prefisso, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), html);
    messe++;
  }
  return { messe, sepolte };
}
{
  const it = await lapidi(ceraIt, CITY, "it");
  const en = await lapidi(ceraEn, `en/${CITY}`, "en");
  setLocale('it');
  if (it.messe + en.messe + it.sepolte + en.sepolte)
    console.log(`${CITY}: lapidi ${it.messe + en.messe} (eventi spariti dalla fonte), tolte dopo ${GIORNI_TOMBA} giorni: ${it.sepolte + en.sepolte}`);
}

// ── /<citta>/ e' la home, gia' su quella citta' ───────────────────────────────
// 17/09/2026 (Filippo: "voglio che apra questo", indicando anyplans.in). La radice di ogni citta'
// serve la home del sito con window.ANYPLANS_CITY impostato: dove compilato, mappa e lista li'.
// Titolo, descrizione e canonical restano quelli della citta', cosi' la pagina resta indicizzabile.
if (CITY !== HOME_CITY) {
  try {
    const home = await readFile(path.join(OUT, "index.html"), "utf8");
    const url = `${SITE}/${CITY}/`;
    const tit = `Eventi a ${CITY_NAME}: cosa fare oggi e nei prossimi giorni | anyplans`;
    const des = `Gli eventi di ${CITY_NAME} su una mappa: feste, concerti, mercati, corsi, sport e cene. `
              + `Ne scegli uno e ci vai insieme ad altri.`;
    const conCitta = home
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(tit)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(des)}">`)
      .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${url}">`)
      .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(tit)}">`)
      .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`)
      // il titolo dentro la pagina diceva "Che eventi ci sono a Bergamo?" anche su Napoli: il nome lo
      // metteva il javascript, e Google leggeva Bergamo su tutte e 51 le altre città (18/09/2026).
      .replace(/(<span class="blue" id="(?:hcity|mcity2)">)[^<]*(<\/span>)/g, `$1${esc(CITY_NAME)}$2`)
      // il segmento "Dove" della barra parte già sulla città, come fa il javascript
      .replace(/(<span class="v" id="v-dove">)[^<]*(<\/span>)/, `$1${esc(CITY_NAME)}$2`)
      .replace(/(<p class="sub">)([^<]*)/, (_m, tag, txt) =>
        `${tag}${esc(CITY_NAME)} e dintorni: ${txt.charAt(0).toLowerCase()}${txt.slice(1)}`)
      .replace("</head>", `<script>window.ANYPLANS_CITY=${JSON.stringify(CITY)};</script>\n</head>`);
    await writeFile(path.join(cityDir, "index.html"), conCitta);
    addUrl(url, NOW);
    console.log(`${CITY}: /${CITY}/ e' la home su ${CITY_NAME} (elenco sotto /${CITY}/cosa-fare/)`);
  } catch (e) {
    console.log(`${CITY}: home non copiata (${e.message}); /${CITY}/ resta l'elenco`);
  }
}

await writeFile(path.join(OUT, `sitemap-${CITY}.xml`), sitemapXml());
await indexNow();
await writeFile(path.join(OUT, LLMS_FILE), llmsTxt() + "\n---\n\n# Tutte le pagine di anyplans a " + CITY_NAME + " (italiano, poi inglese)\n\n" + fullTxt.join("\n"));
await mkdir(statoDir, { recursive: true });
await writeFile(path.join(statoDir, CITY + ".json"), JSON.stringify(
  { slug: CITY, nome: CITY_NAME, eventi: upcomingPages.length, pagine: sitemapEntries.length,
    tipi: Object.fromEntries(types.map(x => [x.sport, x.list.filter(p => !p.isPast).length])),
    aggiornato: NOW.toISOString() }, null, 1));

console.log(`${CITY}: ${rows.length} righe, ${pages.length} pagine (${upcomingPages.length} futuri, ${pages.length - upcomingPages.length} passati)`);
console.log(`indici: ${types.length} tipi (${types.map(x => x.slug).join(", ")}), ${towns.length} paesi`);
console.log(`quando: oggi ${WHEN.oggi.list.length}, domani ${WHEN.domani.list.length}, weekend ${WHEN.weekend.list.length} (${weekendKeys.join(" + ")}); mesi: ${months.map(m => m + " (" + monthIdx.get(m).length + ")").join(", ") || "nessuno"}`);
console.log(`gruppi: ${groups.length} (run club: ${runClubs.length}, ritrovi: ${schedules.length}); sitemap: ${sitemapEntries.length} url (it + en) → ${OUT}`);

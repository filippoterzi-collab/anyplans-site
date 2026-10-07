#!/usr/bin/env node
// anyplans — la pagina dei viaggi di gruppo (/viaggi-di-gruppo/) dai dati veri del database.
// Node 20 (GitHub Actions) o deno (sul Mac), nessuna dipendenza. Legge la RPC public_trips_for_seo
// (migrazione 0091: tabelle trip / trip_departure riempite ogni sera dalla skill /viaggi-di-gruppo) e
// riempie travel/index.template.html, che è la pagina disegnata il 15/09/2026 con i dati tolti.
// Lanciato dall'orchestratore di generate.mjs (passo --travel) dopo le città e prima dell'indice; da solo:
//   deno run -A generate-travel.mjs --out <cartella>        (env: SUPABASE_URL, SUPABASE_ANON_KEY)
// Output deterministico: le date in pagina vengono dai dati (price_seen_at, updated_at), mai da "adesso".
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT = arg("--out");
if (!OUT) { console.error("uso: generate-travel.mjs --out <cartella> [--fixture trips.json]"); process.exit(2); }
const FIXTURE = arg("--fixture");
const SB_URL = process.env.SUPABASE_URL, SB_ANON = process.env.SUPABASE_ANON_KEY;

async function rpc(name, body) {
  if (!SB_URL || !SB_ANON) throw new Error("mancano SUPABASE_URL / SUPABASE_ANON_KEY");
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON, "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`rpc ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function rpcRetry(name, body, tentativi = 5) {
  let ultimo;
  for (let i = 0; i < tentativi; i++) {
    try { return await rpc(name, body); }
    catch (e) { ultimo = e; if (i === tentativi - 1) throw e; const w = Math.min(30000, 2000 * 2 ** i); console.error(`rpc ${name}: ${String(e.message).slice(0, 90)} — riprovo fra ${w / 1000}s`); await new Promise(r => setTimeout(r, w)); }
  }
  throw ultimo;
}

// ── paesi: il dizionario della pagina (slug, nome, bandiera, continente) + sinonimi delle fonti ──────────
const WORLD = JSON.parse(await readFile(path.join(HERE, "travel", "world.json"), "utf8"));
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const BY_NAME = new Map();   // nome normalizzato → slug
for (const list of Object.values(WORLD)) for (const [slug, name] of list) { BY_NAME.set(norm(name), slug); BY_NAME.set(norm(slug), slug); }
// quello che gli operatori scrivono al posto del paese (città, isole, regioni, nomi in inglese)
const ALIAS = {
  "usa": "stati-uniti", "new york": "stati-uniti", "florida": "stati-uniti", "california": "stati-uniti", "west coast": "stati-uniti", "miami": "stati-uniti",
  "lapponia": "finlandia", "lapponia finlandese": "finlandia", "lapponia svedese": "svezia", "tromso": "norvegia", "lofoten": "norvegia", "capo nord": "norvegia",
  "canarie": "spagna", "fuerteventura": "spagna", "tenerife": "spagna", "lanzarote": "spagna", "gran canaria": "spagna", "andalusia": "spagna", "maiorca": "spagna", "ibiza": "spagna", "baleari": "spagna",
  "rodi": "grecia", "kos": "grecia", "creta": "grecia", "santorini": "grecia", "mykonos": "grecia", "corfu": "grecia", "zante": "grecia", "cicladi": "grecia",
  "transilvania": "romania", "azzorre": "portogallo", "madeira": "portogallo", "lisbona": "portogallo", "peniche": "portogallo", "amsterdam": "paesi-bassi", "olanda": "paesi-bassi",
  "parigi": "francia", "corsica": "francia", "londra": "regno-unito", "inghilterra": "regno-unito", "edimburgo": "scozia", "dublino": "irlanda", "berlino": "germania", "praga": "repubblica-ceca", "budapest": "ungheria", "vienna": "austria",
  "sicilia": "italia", "sardegna": "italia", "puglia": "italia", "dolomiti": "italia", "livigno": "italia", "alagna valsesia": "italia", "milano": "italia", "roma": "italia", "torino": "italia", "napoli": "italia", "toscana": "italia", "trentino": "italia", "val d aosta": "italia", "cervinia": "italia", "courmayeur": "italia",
  "sharm el sheikh": "egitto", "sharm": "egitto", "marsa alam": "egitto", "mar rosso": "egitto", "cairo": "egitto", "marrakech": "marocco", "sahara": "marocco", "zanzibar": "zanzibar", "safari": "tanzania", "kilimangiaro": "tanzania",
  "istanbul": "turchia", "cappadocia": "turchia", "dubai": "emirati", "emirati arabi uniti": "emirati", "emirati arabi": "emirati", "abu dhabi": "emirati", "petra": "giordania",
  "bali": "indonesia", "giava": "indonesia", "lombok": "indonesia", "gili": "indonesia", "phuket": "thailandia", "bangkok": "thailandia", "koh": "thailandia", "tokyo": "giappone", "kyoto": "giappone", "osaka": "giappone", "kyushu": "giappone", "japan": "giappone", "hokkaido": "giappone",
  "hong kong": "cina", "pechino": "cina", "shanghai": "cina", "corea": "corea-del-sud", "seoul": "corea-del-sud", "hanoi": "vietnam", "saigon": "vietnam", "angkor": "cambogia", "siem reap": "cambogia", "kathmandu": "nepal", "everest": "nepal", "rajasthan": "india", "kerala": "india", "goa": "india", "borneo": "malesia", "turkmenistan": "uzbekistan",
  "yucatan": "messico", "tulum": "messico", "cancun": "messico", "havana": "cuba", "l avana": "cuba", "santo domingo": "repubblica-dominicana", "punta cana": "repubblica-dominicana", "repubblica dominicana": "repubblica-dominicana", "giamaica": "cuba",
  "rio de janeiro": "brasile", "rio": "brasile", "amazzonia": "brasile", "patagonia": "argentina", "buenos aires": "argentina", "machu picchu": "peru", "lima": "peru", "cusco": "peru", "galapagos": "ecuador", "atacama": "cile", "salar": "bolivia", "uyuni": "bolivia", "cartagena": "colombia",
  "sydney": "australia", "sri lanka e maldive": "sri-lanka", "vietnam e cambogia": "vietnam", "vietnam cambogia": "vietnam", "capo verde": "capo-verde", "sal": "capo-verde", "boa vista": "capo-verde",
};
delete ALIAS["giamaica"];   // non c'è nel dizionario: resta testo
const CONTINENTS = new Map([["europa", "Europa"], ["europe", "Europa"], ["africa", "Africa"], ["asia", "Asia"], ["oceania", "Oceania"], ["medio oriente", "Medio Oriente"], ["middle east", "Medio Oriente"], ["nord america", "Nord America"], ["sud america", "Sud America"], ["america", "America"]]);
const KEYS = [...BY_NAME.keys(), ...Object.keys(ALIAS)].filter(k => k.length >= 3).sort((a, b) => b.length - a.length);
function slugsOf(dest) {
  const n = norm(dest);
  if (!n || CONTINENTS.has(n)) return [];
  if (BY_NAME.has(n)) return [BY_NAME.get(n)];
  if (ALIAS[n]) return [ALIAS[n]];
  const found = [];
  for (const k of KEYS) if (new RegExp(`(^| )${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(n)) { found.push(BY_NAME.get(k) || ALIAS[k]); if (found.length >= 2) break; }
  return found;
}
const contOf = (dest) => CONTINENTS.get(norm(dest)) || null;

// ── dati ─────────────────────────────────────────────────────────────────────────────────────────────────
const data = FIXTURE ? JSON.parse(await readFile(FIXTURE, "utf8")) : await rpcRetry("public_trips_for_seo");
if (!data || !Array.isArray(data.trips) || data.trips.length === 0) { console.error("viaggi: nessun viaggio dalla RPC, non tocco niente"); process.exit(1); }
const STATUS = { available: "available", few_left: "few_left", sold_out: "sold_out", to_confirm: "PLANNED" };   // quelli che la pagina sa mostrare
const eur = (c) => c == null ? null : Math.round(c) / 100;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// operatori in ordine di catalogo (quanti viaggi hanno), non alfabetico: è l'ordine delle schede e dei filtri in pagina
const perOpCount = {}; for (const t of data.trips) perOpCount[t.operator] = (perOpCount[t.operator] || 0) + 1;
const ops = {}; for (const o of [...data.operators].sort((a, b) => (perOpCount[b.slug] || 0) - (perOpCount[a.slug] || 0))) ops[o.slug] = { name: o.name, url: o.website_url };
let seen = "", modified = "", nDeps = 0; const unmapped = new Map();
const trips = data.trips.filter(t => ops[t.operator]).map(t => {
  const slugs = [...new Set(t.destinations.flatMap(slugsOf))];
  const hint = t.destinations.map(contOf).find(Boolean) || null;
  const rest = t.destinations.filter(d => !slugsOf(d).length && !contOf(d));
  for (const r of rest) unmapped.set(r, (unmapped.get(r) || 0) + 1);
  const deps = (t.departures || []).map(d => {
    nDeps++;
    if (d.price_seen_at && d.price_seen_at > seen) seen = d.price_seen_at;
    if (d.updated_at > modified) modified = d.updated_at;
    const o = { s: d.starts_on, e: d.ends_on || addDays(d.starts_on, t.duration_days - 1) };
    if (STATUS[d.seats_status]) o.st = STATUS[d.seats_status];
    if (d.price_cents != null) o.p = eur(d.price_cents);
    if (d.price_full_cents != null) o.full = eur(d.price_full_cents);
    if (d.price_with_flight_cents != null) o.pf = eur(d.price_with_flight_cents);
    if (d.age_min) o.age = `${d.age_min}-${d.age_max ?? ""}`.replace(/-$/, "+");
    if (d.seats_left != null && d.seats_status !== "sold_out") o.free = d.seats_left;
    return o;
  });
  if (t.price_seen_at && t.price_seen_at > seen) seen = t.price_seen_at;
  if (t.updated_at > modified) modified = t.updated_at;
  return {
    op: t.operator, id: `${t.operator}-${t.external_id}`.slice(0, 80), title: t.title, url: t.source_url, days: t.duration_days,
    age: null, type: t.trip_type, air: t.departure_cities.length ? t.departure_cities.join(" o ") : null,
    from: eur(t.price_from_cents), full: eur(t.price_full_cents), flight: t.flight_included,
    dest: slugs, destText: rest.join(", ") || null, contHint: hint, deps, nDeps: t.departures_count,
  };
});
const fmtIt = (iso) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };
const names = Object.values(ops).map(o => o.name);
const joinIt = (a) => a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " e " + a[a.length - 1];
const operatorsLong = joinIt(names);
const operatorsShort = joinIt(names.map(n => n.replace(/ Family$/, "")));
const page = (await readFile(path.join(HERE, "travel", "index.template.html"), "utf8"))
  .replaceAll("__TRIPS_JSON__", JSON.stringify({ seen: seen ? fmtIt(seen) : "—", ops, world: WORLD, trips }).replace(/</g, "\\u003c"))
  .replaceAll("__SEEN__", seen ? fmtIt(seen) : "—")
  .replaceAll("__OPERATORS__", operatorsLong)
  .replaceAll("__OPERATORS_SHORT__", operatorsShort)
  .replaceAll("__DATE_MODIFIED__", (modified || seen || "").slice(0, 10));
if (/__[A-Z_]+__/.test(page)) { console.error("viaggi: segnaposto non riempiti nel template", page.match(/__[A-Z_]+__/g)); process.exit(1); }
await mkdir(path.join(OUT, "viaggi-di-gruppo"), { recursive: true });
await writeFile(path.join(OUT, "viaggi-di-gruppo", "index.html"), page);
await mkdir(path.join(OUT, "tools", "stato"), { recursive: true });
await writeFile(path.join(OUT, "tools", "stato", "viaggi.json"), JSON.stringify({ viaggi: trips.length, partenze: nDeps, operatori: names, aggiornato: (modified || "").slice(0, 10), prezzi_letti_il: seen ? fmtIt(seen) : null }));
const perOp = {}; for (const t of trips) perOp[t.op] = (perOp[t.op] || 0) + 1;
console.log(`viaggi: ${trips.length} viaggi (${Object.entries(perOp).map(([k, v]) => `${k} ${v}`).join(", ")}), ${nDeps} partenze, prezzi letti il ${seen ? fmtIt(seen) : "—"} → ${OUT}/viaggi-di-gruppo/`);
if (unmapped.size) console.log(`viaggi: destinazioni senza paese nel dizionario (restano come testo): ${[...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} (${v})`).join(", ")}`);

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
  "transilvania": "romania", "rep ceca": "repubblica-ceca", "cechia": "repubblica-ceca", "stati uniti d america": "stati-uniti",  "azzorre": "portogallo", "madeira": "portogallo", "lisbona": "portogallo", "peniche": "portogallo", "amsterdam": "paesi-bassi", "olanda": "paesi-bassi",
  "parigi": "francia", "corsica": "francia", "londra": "regno-unito", "inghilterra": "regno-unito", "edimburgo": "scozia", "dublino": "irlanda", "berlino": "germania", "praga": "repubblica-ceca", "budapest": "ungheria", "vienna": "austria",
  "sicilia": "italia", "sardegna": "italia", "puglia": "italia", "dolomiti": "italia", "livigno": "italia", "alagna valsesia": "italia", "milano": "italia", "roma": "italia", "torino": "italia", "napoli": "italia", "toscana": "italia", "trentino": "italia", "val d aosta": "italia", "cervinia": "italia", "courmayeur": "italia",
  "sharm el sheikh": "egitto", "sharm": "egitto", "marsa alam": "egitto", "mar rosso": "egitto", "cairo": "egitto", "marrakech": "marocco", "sahara": "marocco", "zanzibar": "zanzibar", "safari": "tanzania", "kilimangiaro": "tanzania",
  "istanbul": "turchia", "cappadocia": "turchia", "dubai": "emirati", "emirati arabi uniti": "emirati", "emirati arabi": "emirati", "abu dhabi": "emirati", "petra": "giordania",
  "bali": "indonesia", "giava": "indonesia", "lombok": "indonesia", "gili": "indonesia", "phuket": "thailandia", "bangkok": "thailandia", "koh": "thailandia", "tokyo": "giappone", "kyoto": "giappone", "osaka": "giappone", "kyushu": "giappone", "japan": "giappone", "hokkaido": "giappone",
  "hong kong": "cina", "pechino": "cina", "shanghai": "cina", "corea": "corea-del-sud", "seoul": "corea-del-sud", "hanoi": "vietnam", "saigon": "vietnam", "angkor": "cambogia", "siem reap": "cambogia", "kathmandu": "nepal", "everest": "nepal", "rajasthan": "india", "kerala": "india", "goa": "india", "borneo": "malesia", "turkmenistan": "uzbekistan",
  "yucatan": "messico", "tulum": "messico", "cancun": "messico", "havana": "cuba", "l avana": "cuba", "santo domingo": "repubblica-dominicana", "punta cana": "repubblica-dominicana", "repubblica dominicana": "repubblica-dominicana", 
  "rio de janeiro": "brasile", "rio": "brasile", "amazzonia": "brasile", "patagonia": "argentina", "buenos aires": "argentina", "machu picchu": "peru", "lima": "peru", "cusco": "peru", "galapagos": "ecuador", "atacama": "cile", "salar": "bolivia", "uyuni": "bolivia", "cartagena": "colombia",
  "umbria": "italia", "lazio": "italia", "calabria": "italia", "friuli venezia giulia": "italia", "friuli": "italia", "veneto": "italia", "lombardia": "italia", "piemonte": "italia", "liguria": "italia", "emilia romagna": "italia", "marche": "italia", "abruzzo": "italia", "molise": "italia", "campania": "italia", "basilicata": "italia", "alto adige": "italia", "valle d aosta": "italia", "val d aosta": "italia", "cinque terre": "italia", "venezia": "italia", "padova": "italia", "ischia": "italia", "marina di grosseto": "italia", "montegrotto": "italia", "firenze": "italia", "bologna": "italia", "verona": "italia", "matera": "italia", "lecce": "italia", "salento": "italia", "gargano": "italia", "amalfi": "italia", "costiera amalfitana": "italia", "etna": "italia", "eolie": "italia", "isole eolie": "italia", "elba": "italia", "maremma": "italia", "val d orcia": "italia", "langhe": "italia", "monferrato": "italia", "garda": "italia", "lago di garda": "italia", "lago maggiore": "italia", "lago di como": "italia", "appennino": "italia", "gran sasso": "italia", "majella": "italia", "pollino": "italia", "sila": "italia", "aspromonte": "italia", "monti sibillini": "italia", "casentinesi": "italia", "stelvio": "italia", "ortles": "italia", "adamello": "italia", "brenta": "italia", "pale di san martino": "italia", "val gardena": "italia", "val di fassa": "italia", "alta badia": "italia", "cortina": "italia", "monte rosa": "italia", "gran paradiso": "italia", "monte bianco": "italia", "cervino": "italia", "madrid": "spagna", "barcellona": "spagna", "siviglia": "spagna", "valencia": "spagna", "baleari": "spagna", "minorca": "spagna", "formentera": "spagna", "pirenei": "spagna", "camino de santiago": "spagna", "cammino di santiago": "spagna", "nara": "giappone", "kanazawa": "giappone", "hiroshima": "giappone", "nikko": "giappone", "kamakura": "giappone", "alpi giapponesi": "giappone", "luxor": "egitto", "assuan": "egitto", "nilo": "egitto", "xi an": "cina", "chengdu": "cina", "grande muraglia": "cina", "esercito di terracotta": "cina", "yunnan": "cina", "guilin": "cina", "colmar": "francia", "strasburgo": "francia", "alsazia": "francia", "provenza": "francia", "bretagna": "francia", "normandia": "francia", "costa azzurra": "francia", "nizza": "francia", "king s cross": "regno-unito", "cornovaglia": "regno-unito", "galles": "regno-unito", "fiordi norvegesi": "norvegia", "cracovia": "polonia", "varsavia": "polonia", "lisbona": "portogallo", "porto": "portogallo", "algarve": "portogallo", "atene": "grecia", "meteore": "grecia", "peloponneso": "grecia", "dubrovnik": "croazia", "spalato": "croazia", "istria": "croazia", "sarajevo": "bosnia", "tirana": "albania", "riviera albanese": "albania", "salisburgo": "austria", "tirolo": "austria", "innsbruck": "austria", "baviera": "germania", "foresta nera": "germania", "monaco di baviera": "germania", "bruxelles": "belgio", "bruges": "belgio", "copenaghen": "danimarca", "stoccolma": "svezia", "oslo": "norvegia", "helsinki": "finlandia", "rovaniemi": "finlandia", "reykjavik": "islanda", "tallinn": "estonia", "riga": "lettonia", "vilnius": "lituania", "lubiana": "slovenia", "bled": "slovenia", "bratislava": "slovacchia", "belgrado": "serbia", "sofia": "bulgaria", "bucarest": "romania", "transilvania": "romania", "chisinau": "moldavia", "tbilisi": "georgia", "yerevan": "armenia", "baku": "azerbaigian", "san pietroburgo": "russia", "mosca": "russia", "marrakech": "marocco", "fes": "marocco", "chefchaouen": "marocco", "essaouira": "marocco", "merzouga": "marocco", "il cairo": "egitto", "siwa": "egitto", "sinai": "egitto", "amman": "giordania", "mascate": "oman", "salalah": "oman", "doha": "qatar", "gerusalemme": "israele", "beirut": "libano", "teheran": "iran", "samarcanda": "uzbekistan", "bukhara": "uzbekistan", "khiva": "uzbekistan", "bishkek": "kirghizistan", "almaty": "kazakistan", "ulan bator": "mongolia", "gobi": "mongolia", "lhasa": "cina", "kathmandu": "nepal", "annapurna": "nepal", "thimphu": "bhutan", "colombo": "sri-lanka", "male": "maldive", "mumbai": "india", "delhi": "india", "varanasi": "india", "jaipur": "india", "bangkok": "thailandia", "chiang mai": "thailandia", "krabi": "thailandia", "phi phi": "thailandia", "luang prabang": "laos", "vientiane": "laos", "phnom penh": "cambogia", "ha long": "vietnam", "hoi an": "vietnam", "sapa": "vietnam", "yangon": "myanmar", "bagan": "myanmar", "kuala lumpur": "malesia", "giacarta": "indonesia", "yogyakarta": "indonesia", "flores": "indonesia", "manila": "filippine", "cebu": "filippine", "boracay": "filippine", "seoul": "corea-del-sud", "busan": "corea-del-sud", "taipei": "taiwan", "new orleans": "stati-uniti", "chicago": "stati-uniti", "las vegas": "stati-uniti", "san francisco": "stati-uniti", "los angeles": "stati-uniti", "grand canyon": "stati-uniti", "yellowstone": "stati-uniti", "route 66": "stati-uniti", "toronto": "canada", "vancouver": "canada", "montreal": "canada", "quebec": "canada", "citta del messico": "messico", "oaxaca": "messico", "chiapas": "messico", "baja california": "messico", "guatemala city": "guatemala", "tikal": "guatemala", "san jose": "costa-rica", "panama city": "panama", "bogota": "colombia", "medellin": "colombia", "quito": "ecuador", "la paz": "bolivia", "santiago": "cile", "torres del paine": "cile", "isola di pasqua": "cile", "ushuaia": "argentina", "salta": "argentina", "iguazu": "argentina", "montevideo": "uruguay", "salvador de bahia": "brasile", "amazzonia": "brasile", "pantanal": "brasile", "lima": "peru", "arequipa": "peru", "titicaca": "peru", "nairobi": "kenya", "masai mara": "kenya", "serengeti": "tanzania", "ngorongoro": "tanzania", "kilimangiaro": "tanzania", "arusha": "tanzania", "okavango": "botswana", "chobe": "botswana", "victoria falls": "zambia", "cascate vittoria": "zambia", "windhoek": "namibia", "sossusvlei": "namibia", "etosha": "namibia", "citta del capo": "sudafrica", "cape town": "sudafrica", "kruger": "sudafrica", "addis abeba": "etiopia", "lalibela": "etiopia", "dakar": "senegal", "accra": "ghana", "tunisi": "tunisia", "djerba": "tunisia", "antananarivo": "madagascar", "nosy be": "madagascar", "kigali": "ruanda", "gorilla": "uganda", "sydney": "australia", "alaska": "stati-uniti", "hawaii": "stati-uniti", "aconcagua": "argentina", "baikal": "russia", "kamchatka": "russia", "siberia": "russia", "cirenaica": "libia", "dancalia": "etiopia", "dahlak": "eritrea", "socotra": "yemen", "zanzibar": "zanzibar", "madeira": "portogallo", "svalbard": "norvegia", "isole faroe": "isole-faroe", "faer oer": "isole-faroe", "faroe": "isole-faroe", "fær øer": "isole-faroe", "tibet": "cina", "ladakh": "india", "sikkim": "india", "borneo": "malesia", "sumatra": "indonesia", "komodo": "indonesia", "raja ampat": "indonesia", "palawan": "filippine", "okinawa": "giappone", "jeju": "corea-del-sud", "petra wadi rum": "giordania", "wadi rum": "giordania", "tanzania zanzibar": "tanzania", "capo verde": "capo-verde", "sal": "capo-verde", "boa vista": "capo-verde", "azerbaijan": "azerbaigian", "sao tome": "sao-tome", "rep democratica del congo": "rd-congo", "repubblica democratica del congo": "rd-congo", "polinesia francese": "polinesia", "bora bora": "polinesia", "tahiti": "polinesia", "cuba l avana": "cuba", "sri lanka e maldive": "sri-lanka", "vietnam e cambogia": "vietnam", "vietnam cambogia": "vietnam", "capo verde": "capo-verde", "sal": "capo-verde", "boa vista": "capo-verde",
};
const CONTINENTS = new Map([["europa", "Europa"], ["europe", "Europa"], ["africa", "Africa"], ["asia", "Asia"], ["oceania", "Oceania"], ["medio oriente", "Medio Oriente"], ["middle east", "Medio Oriente"], ["nord america", "Nord America"], ["sud america", "Sud America"], ["america", "America"], ["americhe", "America"], ["centro america", "Nord America"], ["caraibi", "Nord America"], ["nord europa", "Europa"], ["sud est asiatico", "Asia"], ["sudest asiatico", "Asia"], ["africa australe", "Africa"], ["africa orientale", "Africa"], ["africa occidentale", "Africa"], ["mediterraneo", "Europa"], ["mediterraneo occidentale", "Europa"], ["mediterraneo orientale", "Europa"], ["mar rosso", "Africa"], ["caraibi", "Nord America"], ["isole greche", "Europa"], ["baltico", "Europa"], ["balcani", "Europa"], ["scandinavia", "Europa"], ["lapponia", "Europa"], ["sahara", "Africa"], ["himalaya", "Asia"], ["patagonia", "Sud America"], ["ande", "Sud America"], ["mediterraneo e isole", "Europa"], ["centro e sud america", "America"], ["america del sud", "Sud America"], ["america centrale", "Nord America"], ["america del nord", "Nord America"], ["estremo oriente", "Asia"], ["asia centrale", "Asia"], ["sud est asia", "Asia"], ["europa del nord", "Europa"], ["europa dell est", "Europa"], ["est europa e balcani", "Europa"], ["europa centrale", "Europa"], ["europa del sud", "Europa"], ["africa del nord", "Africa"], ["nord africa", "Africa"], ["africa subsahariana", "Africa"], ["oceano indiano", "Asia"], ["medio oriente e africa", "Medio Oriente"]]);
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
// una chiamata per operatore (0092): con 43 operatori e 28.000 partenze la chiamata unica superava il timeout
// della chiave anon (07/10/2026 sera) e la pagina restava a ieri. Prima l'elenco (p_operator = ''), poi uno alla volta.
const data = FIXTURE ? JSON.parse(await readFile(FIXTURE, "utf8")) : await (async () => {
  const head = await rpcRetry("public_trips_for_seo", { p_operator: "" });
  const trips = [];
  for (const o of head.operators) {
    const part = await rpcRetry("public_trips_for_seo", { p_operator: o.slug });
    trips.push(...(part.trips || []));
  }
  return { generated_at: head.generated_at, operators: head.operators, trips };
})();
if (!data || !Array.isArray(data.trips) || data.trips.length === 0) { console.error("viaggi: nessun viaggio dalla RPC, non tocco niente"); process.exit(1); }
const STATUS = { available: "available", few_left: "few_left", sold_out: "sold_out", to_confirm: "PLANNED" };   // quelli che la pagina sa mostrare
const eur = (c) => c == null ? null : Math.round(c) / 100;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// operatori in ordine di catalogo (quanti viaggi hanno), non alfabetico: è l'ordine delle schede e dei filtri in pagina
const perOpCount = {}; for (const t of data.trips) perOpCount[t.operator] = (perOpCount[t.operator] || 0) + 1;
const ops = {}; for (const o of [...data.operators].sort((a, b) => (perOpCount[b.slug] || 0) - (perOpCount[a.slug] || 0))) ops[o.slug] = { name: o.name, url: o.website_url };
let seen = "", modified = "", nDeps = 0; const unmapped = new Map();
// cosa il prezzo non comprende, operatore per operatore (Filippo 07/10/2026: "scrivi tu"): la cassa comune di Vagabondo
// e della Compagnia dei Cammini non è nel prezzo pubblicato, e va detto accanto al prezzo
const NOTE = { "vagabondo": "prezzo senza cassa comune", "compagnia-dei-cammini": "prezzo senza cassa comune, serve la tessera soci", "avventure-nel-mondo": "quota indicativa, il prezzo per data è sul loro sito" };
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
    dest: slugs, destText: rest.join(", ") || null, contHint: hint, deps, nDeps: t.departures_count, note: NOTE[t.operator] || null,
  };
});
const fmtIt = (iso) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };
// nei testi si nominano i primi quattro operatori per catalogo e si contano gli altri: con venti nomi la frase non si legge
const names = Object.values(ops).map(o => o.name);
const joinIt = (a) => a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " e " + a[a.length - 1];
const altri = names.length > 4 ? ` e altri ${names.length - 4} operatori` : "";
const operatorsLong = names.length > 4 ? names.slice(0, 4).join(", ") + altri : joinIt(names);
const operatorsShort = names.length > 4 ? names.slice(0, 4).map(n => n.replace(/ Family$/, "")).join(", ") + altri : joinIt(names.map(n => n.replace(/ Family$/, "")));
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

// anyplans — SEO e AEO dei viaggi di gruppo (07/10/2026).
// La pagina /viaggi-di-gruppo/ mostra i viaggi con JavaScript: senza JS (Google al primo passaggio, e
// sempre ChatGPT, Perplexity, Claude) restavano 3.500 caratteri e nessuna destinazione. Qui nascono le
// pagine statiche che rispondono alle ricerche vere: una per paese ("viaggi di gruppo in Giappone"), una
// per Capodanno, una per i prossimi mesi, una per operatore ("viaggi WeRoad", +300% su Trends) e il
// confronto fra operatori (chi cerca "weroad" cerca anche "sivola" +2.950%). Più llms-viaggi.txt per i
// motori di risposta, sitemap-viaggi.xml, e un blocco di link veri dentro la pagina principale.
// Solo fatti letti dai cataloghi: prezzi, date, durate, età, volo. Si prenota dall'operatore.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SITE = "https://anyplans.in";
const BASE = "/viaggi-di-gruppo";
const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const MIN_PAESE = 3;          // viaggi con partenze future per avere la pagina del paese
const MIN_OPERATORE = 5;      // idem per la pagina dell'operatore

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const jsonld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const cut = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…"; };
const joinIt = (a) => a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " e " + a[a.length - 1];
const euro = (n) => n == null ? "" : `${Math.round(n).toLocaleString("it-IT")} €`;
const dataIt = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MESI[m - 1]} ${y}`; };
// "il 3 ottobre", ma "l'8 ottobre" e "l'11 ottobre"
const ilData = (iso) => { const d = +iso.slice(8, 10); return `${d === 8 || d === 11 ? "l'" : "il "}${dataIt(iso)}`; };
const elenco = (a, max = 5) => a.length > max ? `${a.slice(0, max).join(", ")} e altri` : joinIt(a);
const MAX_SCHEDE = 80;
// "in Giappone", ma "negli Stati Uniti", "alle Maldive", "a Cuba": la preposizione giusta per ogni paese che non vuole "in"
const PREP = { "Malta": "a", "Cipro": "a", "Paesi Bassi": "nei", "Repubblica Ceca": "nella", "Regno Unito": "nel", "Isole Fær Øer": "alle",
  "San Marino": "a", "Capo Verde": "a", "Zanzibar": "a", "Mauritius": "a", "Comore": "alle", "Seychelles": "alle",
  "Repubblica Democratica del Congo": "nella", "Emirati Arabi": "negli", "Filippine": "nelle", "Maldive": "alle", "Stati Uniti": "negli",
  "Cuba": "a", "Haiti": "ad", "Bahamas": "alle", "Barbados": "alle", "Trinidad e Tobago": "a", "Saint Lucia": "a", "Polinesia Francese": "nella",
  "Figi": "alle", "Samoa": "alle", "Tonga": "alle", "Isole Cook": "alle", "Nuova Caledonia": "in", "Repubblica Dominicana": "nella", "Paesi Baschi": "nei" };
const inPaese = (name) => `${PREP[name] || "in"} ${name}`;
const dataCorta = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${d} ${MESI[m - 1].slice(0, 3)}`; };
const flagOf = (iso) => !iso || iso.length !== 2 ? "✈️" : String.fromCodePoint(...[...iso.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
const viaggi = (n) => `${n} viagg${n === 1 ? "io" : "i"}`;
const partenze = (n) => `${n} partenz${n === 1 ? "a" : "e"}`;

const CSS = `@font-face{font-family:Bricolage;src:url(/bricolage-grotesque-latin-800-normal.woff2) format("woff2");font-weight:800;font-display:swap}
:root{--blue:#1B4FD8;--paper:#FBF9F5;--ink:#191919;--grey:#5f5f5f;--line:rgba(25,25,25,.12);--tint:#EEF2FD;--green:#137333}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--paper);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--blue)}.wrap{max-width:860px;margin:0 auto;padding:0 16px}
header{padding:14px 0;border-bottom:1px solid var(--line);background:#fff}header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:flex;align-items:center;gap:8px;font:800 22px Bricolage,sans-serif;letter-spacing:-.04em;color:var(--ink);text-decoration:none}.brand img{width:30px;height:30px}
.btn{display:inline-block;background:var(--blue);color:#fff;text-decoration:none;font-weight:700;border-radius:999px;padding:10px 18px;font-size:15px}.btn.ghost{background:#fff;color:var(--blue);border:1.5px solid var(--blue)}
main{padding:22px 0 40px}.crumbs{font-size:13.5px;color:var(--grey);margin-bottom:12px}.crumbs a{color:var(--grey);text-decoration:none}
h1{font:800 clamp(28px,6vw,40px)/1.05 Bricolage,sans-serif;letter-spacing:-.045em;margin-bottom:12px}
h2{font:800 22px/1.15 Bricolage,sans-serif;letter-spacing:-.04em;margin:28px 0 10px}
.lead{font-size:17px;color:#333;margin-bottom:14px}.m{color:var(--grey);font-size:14px}
.box{background:#fff;border:1.5px solid var(--line);border-radius:16px;padding:16px;margin:12px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}.kpi{background:#fff;border:1.5px solid var(--line);border-radius:14px;padding:12px}.kpi b{display:block;font:800 22px Bricolage,sans-serif;letter-spacing:-.03em}.kpi span{font-size:13px;color:var(--grey)}
.trip{background:#fff;border:1.5px solid var(--line);border-radius:16px;padding:14px 16px;margin:10px 0}.trip h3{font-size:17px;line-height:1.3;margin-bottom:4px}
.trip .row{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:14px;color:var(--grey);margin:4px 0}.trip .p{font-weight:800;color:var(--ink)}.trip .go{display:inline-block;margin-top:6px;font-weight:700;font-size:14.5px}
.chip{display:inline-block;background:var(--tint);color:var(--blue);border-radius:999px;padding:2px 10px;font-size:12.5px;font-weight:600}
.tags{display:flex;flex-wrap:wrap;gap:8px}.tags a{background:#fff;border:1.5px solid var(--line);border-radius:999px;padding:6px 12px;text-decoration:none;color:var(--ink);font-size:14.5px}.tags a small{color:var(--grey);margin-left:4px}
table{width:100%;border-collapse:collapse;background:#fff;border:1.5px solid var(--line);border-radius:14px;overflow:hidden;font-size:14.5px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}th{background:var(--tint);font-weight:700}
.tablewrap{overflow-x:auto}
details{background:#fff;border:1.5px solid var(--line);border-radius:14px;padding:12px 14px;margin:8px 0}summary{font-weight:700;cursor:pointer}details p{margin-top:8px;color:#333}
footer{border-top:1px solid var(--line);padding:22px 0;font-size:13.5px;color:var(--grey)}footer a{color:var(--grey)}
@media (max-width:600px){h2{font-size:20px}.trip{padding:12px}}`;

function layout({ title, description, url, body, ld, crumbs }) {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${SITE}/og.png"><meta property="og:locale" content="it_IT">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
<link rel="alternate" type="text/plain" title="I viaggi di gruppo in testo, per i motori di risposta" href="${SITE}/llms-viaggi.txt">
<style>${CSS}</style>
${ld.filter(Boolean).join("\n")}
${jsonld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs.map(([n, u], i) => ({ "@type": "ListItem", position: i + 1, name: n, ...(u ? { item: SITE + u } : {}) })) })}
</head><body>
<header><div class="wrap"><a class="brand" href="/"><img src="/logo.png" alt="" width="30" height="30">anyplans</a><a class="btn" href="${BASE}/">Tutti i viaggi</a></div></header>
<main class="wrap">
<nav class="crumbs" aria-label="Percorso">${crumbs.map(([n, u]) => u ? `<a href="${esc(u)}">${esc(n)}</a>` : esc(n)).join(" › ")}</nav>
${body}
</main>
<footer><div class="wrap">anyplans confronta i viaggi di gruppo: i prezzi e le date sono quelli pubblicati dagli operatori il giorno indicato, si prenota sul loro sito. <a href="/guidelines.html">Regole</a> · <a href="/privacy-it.html">Privacy</a> · <a href="/terms-it.html">Condizioni</a></div></footer>
</body></html>
`;
}
const faqHtml = (faq) => faq.length ? `<h2>Domande frequenti</h2>${faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}` : "";
const faqLd = (faq) => faq.length ? jsonld({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(f => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }) : "";

export async function scriviPagineSeo({ OUT, trips, ops, WORLD, seenIt, oggi }) {
  // il dizionario dei paesi: slug → nome, bandiera, continente
  const PAESE = {};
  for (const [cont, list] of Object.entries(WORLD)) for (const [slug, name, iso] of list) PAESE[slug] = { slug, name, flag: iso === "SCT" ? "🏴" : flagOf(iso), cont };
  const today = oggi;
  // un viaggio "vivo": ha partenze future. Il prezzo di una partenza: senza volo se c'è, altrimenti col volo
  const prezzo = (d, t) => d.p ?? d.pf ?? t.from ?? null;
  const vivi = trips.map(t => ({ ...t, fut: (t.deps || []).filter(d => d.s >= today && d.st !== "sold_out").sort((a, b) => a.s.localeCompare(b.s)) }))
    .filter(t => t.fut.length);
  const minDi = (list) => { let m = Infinity; for (const t of list) for (const d of t.fut) { const p = prezzo(d, t); if (p != null && p < m) m = p; } return m === Infinity ? null : m; };
  const nDep = (list) => list.reduce((n, t) => n + t.fut.length, 0);
  const prossima = (list) => list.flatMap(t => t.fut.map(d => d.s)).sort()[0] || null;
  const opName = (slug) => ops[slug]?.name || slug;
  const pagine = [];          // { url, lastmod }
  const llms = [];

  // la scheda di un viaggio, in HTML statico: si legge senza JavaScript
  const scheda = (t, maxDate = 4) => {
    const p = minDi([t]);
    const eta = [...new Set(t.fut.map(d => d.age).filter(Boolean))].slice(0, 3);
    const posti = t.fut.find(d => d.free != null && d.free <= 5);
    const date = t.fut.slice(0, maxDate).map(d => dataCorta(d.s));
    return `<article class="trip"><h3>${esc(t.title)}</h3>
<div class="row"><span class="chip">${esc(opName(t.op))}</span><span>${t.days} giorni</span>${p != null ? `<span>da <span class="p">${euro(p)}</span>${t.note ? ` (${esc(t.note)})` : ""}</span>` : ""}<span>${t.flight ? "volo incluso" : "volo escluso"}${t.air ? ` · da ${esc(t.air)}` : ""}</span>${eta.length ? `<span>età ${esc(eta.join(", "))}</span>` : ""}</div>
<div class="row"><span>${partenze(t.fut.length)}: ${esc(date.join(", "))}${t.fut.length > maxDate ? "…" : ""}</span>${posti ? `<span>ultimi ${posti.free} posti il ${dataCorta(posti.s)}</span>` : ""}</div>
<a class="go" href="${esc(t.url)}" rel="noopener nofollow">Vedi date e prenota su ${esc(opName(t.op))} →</a></article>`;
  };
  const tripLd = (t) => {
    const p = minDi([t]);
    return { "@type": "TouristTrip", name: t.title, url: t.url,
      provider: { "@type": "Organization", name: opName(t.op), ...(ops[t.op]?.url ? { url: ops[t.op].url } : {}) },
      ...(t.dest.length ? { itinerary: { "@type": "ItemList", itemListElement: t.dest.filter(s => PAESE[s]).map((s, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "Country", name: PAESE[s].name } })) } } : {}),
      ...(p != null ? { offers: { "@type": "Offer", price: p.toFixed(2), priceCurrency: "EUR", url: t.url, availability: "https://schema.org/InStock", validFrom: t.fut[0].s } } : {}) };
  };
  const itemList = (name, url, list) => jsonld({ "@context": "https://schema.org", "@type": "ItemList", name, url, numberOfItems: list.length,
    itemListElement: list.slice(0, 40).map((t, i) => ({ "@type": "ListItem", position: i + 1, item: tripLd(t) })) });
  // ordine delle schede: prima la partenza più vicina, a pari data il prezzo più basso
  const ordina = (list) => list.slice().sort((a, b) => a.fut[0].s.localeCompare(b.fut[0].s) || (minDi([a]) ?? 9e9) - (minDi([b]) ?? 9e9));

  // ── paesi ──────────────────────────────────────────────────────────────────
  const perPaese = new Map();
  for (const t of vivi) for (const s of t.dest) if (PAESE[s]) { if (!perPaese.has(s)) perPaese.set(s, []); perPaese.get(s).push(t); }
  const paesi = [...perPaese.entries()].filter(([, l]) => l.length >= MIN_PAESE).sort((a, b) => b[1].length - a[1].length);
  const urlPaese = (s) => `${BASE}/${s}/`;
  for (const [s, list] of paesi) {
    const P = PAESE[s], url = urlPaese(s);
    const opsQui = [...new Set(list.map(t => t.op))].sort((a, b) => list.filter(t => t.op === b).length - list.filter(t => t.op === a).length);
    const min = minDi(list), next = prossima(list), dur = list.map(t => t.days).filter(Boolean), dmin = Math.min(...dur), dmax = Math.max(...dur);
    const conVolo = opsQui.filter(o => list.some(t => t.op === o && t.flight)).map(opName);
    const eta = [...new Set(list.flatMap(t => t.fut.map(d => d.age)).filter(Boolean))];
    // partenze per mese, sui prossimi 12 mesi
    const mesi = new Map();
    for (const t of list) for (const d of t.fut) { const k = d.s.slice(0, 7); if (!mesi.has(k)) mesi.set(k, { n: 0, min: Infinity }); const x = mesi.get(k); x.n++; const p = prezzo(d, t); if (p != null && p < x.min) x.min = p; }
    const righeMesi = [...mesi.entries()].sort().slice(0, 12);
    const top = righeMesi.slice().sort((a, b) => b[1].n - a[1].n)[0];
    const nomiOps = opsQui.map(opName);
    const title = `${cut(`Viaggi di gruppo ${inPaese(P.name)}: ${viaggi(list.length)}${min != null ? ` da ${euro(min)}` : ""}`, 60)} | anyplans`;
    const lead = `${viaggi(list.length)} di gruppo ${inPaese(P.name)} di ${opsQui.length === 1 ? nomiOps[0] : `${opsQui.length} operatori (${elenco(nomiOps)})`}, con ${partenze(nDep(list))} in calendario: da ${dmin === dmax ? `${dmin} giorni` : `${dmin} a ${dmax} giorni`}${min != null ? `, da ${euro(min)}` : ""}. La prossima partenza è ${ilData(next)}. Qui li confronti, prenoti sul sito di chi organizza.`;
    const faq = [
      { q: `Quanto costa un viaggio di gruppo ${inPaese(P.name)}?`, a: `${min != null ? `Il prezzo più basso in calendario è ${euro(min)}` : "I prezzi sono sui siti degli operatori"}; ${viaggi(list.length)} vanno da ${dmin} a ${dmax} giorni. ${conVolo.length ? `Il volo è incluso nei viaggi di ${joinIt(conVolo)}; negli altri va comprato a parte.` : "Il volo di solito non è incluso e va comprato a parte."} Prezzi letti dai cataloghi il ${seenIt}.` },
      { q: `Quando partono i viaggi di gruppo ${inPaese(P.name)}?`, a: `Ci sono ${partenze(nDep(list))} da ${dataIt(next)} in poi${top ? `; il mese con più partenze è ${MESI[+top[0].slice(5) - 1]} ${top[0].slice(0, 4)} (${top[1].n})` : ""}. Le date sono nell'elenco qui sopra, mese per mese.` },
      { q: `Chi organizza viaggi di gruppo ${inPaese(P.name)}?`, a: `${joinIt(nomiOps)}. Ognuno ha le sue regole su caparra, cancellazione e assicurazione: si leggono sul loro sito al momento della prenotazione.` },
      { q: `Si può andare ${inPaese(P.name)} con un viaggio di gruppo da soli?`, a: `Sì: i viaggi di gruppo sono pensati proprio per chi parte da solo. Si viaggia con un coordinatore e con persone che non si conoscono${eta.length ? `; i gruppi sono per fasce d'età (${eta.slice(0, 4).join(", ")})` : ""}.` },
      { q: `Si prenota su anyplans?`, a: `No: anyplans confronta i viaggi, il bottone porta sulla pagina dell'operatore, dove si paga e si leggono le condizioni.` },
    ];
    const altri = paesi.filter(([x]) => x !== s && PAESE[x].cont === P.cont).slice(0, 12);
    const body = `<h1>${P.flag} Viaggi di gruppo ${esc(inPaese(P.name))}</h1>
<p class="lead">${esc(lead)}</p>
<div class="kpis"><div class="kpi"><b>${list.length}</b><span>viaggi</span></div><div class="kpi"><b>${nDep(list)}</b><span>partenze in calendario</span></div>${min != null ? `<div class="kpi"><b>${euro(min)}</b><span>prezzo più basso</span></div>` : ""}<div class="kpi"><b>${opsQui.length}</b><span>operator${opsQui.length === 1 ? "e" : "i"}</span></div></div>
<p class="m">Prezzi e date letti dai cataloghi degli operatori il ${esc(seenIt)}. Fa fede il prezzo sul sito dell'operatore al momento della prenotazione.</p>
<h2>Chi organizza viaggi di gruppo ${esc(inPaese(P.name))}</h2>
<div class="tablewrap"><table><thead><tr><th>Operatore</th><th>Viaggi</th><th>Da</th><th>Volo</th></tr></thead><tbody>
${opsQui.map(o => { const l = list.filter(t => t.op === o); const m = minDi(l); const v = l.some(t => t.flight); return `<tr><td>${esc(opName(o))}</td><td>${l.length}</td><td>${m != null ? euro(m) : "—"}</td><td>${v ? "incluso" : "escluso"}</td></tr>`; }).join("")}
</tbody></table></div>
<h2>Quando partire</h2>
<div class="tablewrap"><table><thead><tr><th>Mese</th><th>Partenze</th><th>Da</th></tr></thead><tbody>
${righeMesi.map(([k, x]) => `<tr><td>${MESI[+k.slice(5) - 1]} ${k.slice(0, 4)}</td><td>${x.n}</td><td>${x.min < Infinity ? euro(x.min) : "—"}</td></tr>`).join("")}
</tbody></table></div>
<h2>Tutti i viaggi di gruppo ${esc(inPaese(P.name))}</h2>
${ordina(list).slice(0, MAX_SCHEDE).map(t => scheda(t)).join("\n")}
${list.length > MAX_SCHEDE ? `<p class="m">E altri ${list.length - MAX_SCHEDE}: <a href="${BASE}/">tutti nella pagina dei viaggi</a>, con il filtro per paese.</p>` : ""}
${faqHtml(faq)}
${altri.length ? `<h2>Altre destinazioni in ${esc(P.cont)}</h2><div class="tags">${altri.map(([x, l]) => `<a href="${urlPaese(x)}">${PAESE[x].flag} ${esc(PAESE[x].name)}<small>${l.length}</small></a>`).join("")}</div>` : ""}
<p style="margin-top:22px"><a class="btn" href="${BASE}/">Confronta tutti i viaggi di gruppo</a></p>`;
    await scrivi(OUT, url, layout({ title, description: cut(lead, 158), url: SITE + url, body,
      ld: [itemList(`Viaggi di gruppo ${inPaese(P.name)}`, SITE + url, ordina(list)), faqLd(faq)],
      crumbs: [["anyplans", "/"], ["Viaggi di gruppo", `${BASE}/`], [P.name, null]] }));
    pagine.push(url);
    llms.push(`## Viaggi di gruppo ${inPaese(P.name)}\n${SITE}${url}\n\n${lead}\n\n${ordina(list).slice(0, 25).map(t => `- ${t.title} (${opName(t.op)}): ${t.days} giorni${minDi([t]) != null ? `, da ${euro(minDi([t]))}` : ""}${t.flight ? ", volo incluso" : ""}; partenze: ${t.fut.slice(0, 4).map(d => dataCorta(d.s)).join(", ")}${t.fut.length > 4 ? "…" : ""}. ${t.url}`).join("\n")}\n`);
  }

  // ── Capodanno: si parte tra il 20 e il 31 dicembre e si rientra nell'anno nuovo ─────────────────
  const anno = +today.slice(0, 4) + (today.slice(5, 7) === "01" ? -1 : 0);
  const capoList = vivi.map(t => ({ ...t, fut: t.fut.filter(d => d.s >= `${anno}-12-20` && d.s <= `${anno}-12-31` && d.e >= `${anno + 1}-01-01`) })).filter(t => t.fut.length);
  if (capoList.length >= 3) {
    const url = `${BASE}/capodanno/`, min = minDi(capoList);
    const dest = new Map(); for (const t of capoList) for (const s of t.dest) if (PAESE[s]) dest.set(s, (dest.get(s) || 0) + 1);
    const topDest = [...dest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => PAESE[s].name);
    const lead = `${viaggi(capoList.length)} di gruppo che passano la notte del 31 dicembre ${anno} fuori casa: si parte tra il 20 e il 31 dicembre e si rientra nel ${anno + 1}${min != null ? `, da ${euro(min)}` : ""}. Le mete con più partenze: ${joinIt(topDest)}. Con un gruppo e un coordinatore, anche partendo da soli.`;
    const faq = [
      { q: `Dove andare a Capodanno ${anno + 1} con un viaggio di gruppo?`, a: `Le mete con più partenze di gruppo a cavallo del 31 dicembre sono ${joinIt(topDest)}. In tutto ci sono ${viaggi(capoList.length)} di ${new Set(capoList.map(t => t.op)).size} operatori.` },
      { q: `Quanto costa un Capodanno in viaggio di gruppo?`, a: `${min != null ? `Si parte da ${euro(min)}` : "I prezzi sono sui siti degli operatori"}; il prezzo di ogni partenza è nell'elenco, letto dai cataloghi il ${seenIt}.` },
      { q: `Si può fare Capodanno in gruppo partendo da soli?`, a: `Sì: è il motivo per cui esistono i viaggi di gruppo. Si viaggia con persone che non si conoscono e un coordinatore, e la notte del 31 si passa insieme.` },
    ];
    const body = `<h1>🎆 Capodanno ${anno + 1} in viaggio di gruppo</h1>
<p class="lead">${esc(lead)}</p>
<p class="m">Prezzi e date letti dai cataloghi degli operatori il ${esc(seenIt)}.</p>
<h2>Per destinazione</h2><div class="tags">${[...dest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([s, n]) => `<a href="${perPaese.get(s)?.length >= MIN_PAESE ? urlPaese(s) : `${BASE}/`}">${PAESE[s].flag} ${esc(PAESE[s].name)}<small>${n}</small></a>`).join("")}</div>
<h2>Le partenze di Capodanno</h2>
${ordina(capoList).slice(0, MAX_SCHEDE).map(t => scheda(t, 3)).join("\n")}
${capoList.length > MAX_SCHEDE ? `<p class="m">E altre ${capoList.length - MAX_SCHEDE}: <a href="${BASE}/">tutte nella pagina dei viaggi</a>, con il filtro Capodanno.</p>` : ""}
${faqHtml(faq)}
<p style="margin-top:22px"><a class="btn" href="${BASE}/">Confronta tutti i viaggi di gruppo</a></p>`;
    await scrivi(OUT, url, layout({ title: `${cut(`Capodanno ${anno + 1} in viaggio di gruppo${min != null ? `, da ${euro(min)}` : ""}`, 60)} | anyplans`,
      description: cut(lead, 158), url: SITE + url, body, ld: [itemList(`Capodanno ${anno + 1} in viaggio di gruppo`, SITE + url, ordina(capoList)), faqLd(faq)],
      crumbs: [["anyplans", "/"], ["Viaggi di gruppo", `${BASE}/`], ["Capodanno", null]] }));
    pagine.push(url);
    llms.push(`## Capodanno ${anno + 1} in viaggio di gruppo\n${SITE}${url}\n\n${lead}\n`);
  }

  // ── i prossimi sei mesi ──────────────────────────────────────────────────────
  const urlMese = (k) => `${BASE}/${MESI[+k.slice(5) - 1]}-${k.slice(0, 4)}/`;
  const mesiPagine = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(today + "T12:00:00Z"); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + i);
    const k = d.toISOString().slice(0, 7), nome = `${MESI[+k.slice(5) - 1]} ${k.slice(0, 4)}`;
    const list = vivi.map(t => ({ ...t, fut: t.fut.filter(x => x.s.startsWith(k)) })).filter(t => t.fut.length);
    if (list.length < 5) continue;
    const url = urlMese(k), min = minDi(list);
    const dest = new Map(); for (const t of list) for (const s of t.dest) if (PAESE[s]) dest.set(s, (dest.get(s) || 0) + 1);
    const topDest = [...dest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const lead = `${viaggi(list.length)} di gruppo con partenza a ${nome}, ${partenze(nDep(list))} in tutto${min != null ? `, da ${euro(min)}` : ""}. Le mete con più partenze: ${joinIt(topDest.map(([s]) => PAESE[s].name))}.`;
    const faq = [
      { q: `Dove andare a ${nome} con un viaggio di gruppo?`, a: `Le destinazioni con più partenze di gruppo a ${nome} sono ${joinIt(topDest.map(([s, n]) => `${PAESE[s].name} (${n})`))}.` },
      { q: `Quanto costa un viaggio di gruppo a ${nome}?`, a: `${min != null ? `Il prezzo più basso è ${euro(min)}` : "I prezzi sono sui siti degli operatori"}; il prezzo di ogni partenza è nell'elenco, letto dai cataloghi il ${seenIt}.` },
    ];
    const body = `<h1>Viaggi di gruppo a ${esc(nome)}</h1>
<p class="lead">${esc(lead)}</p>
<h2>Per destinazione</h2><div class="tags">${topDest.map(([s, n]) => perPaese.has(s) && perPaese.get(s).length >= MIN_PAESE ? `<a href="${urlPaese(s)}">${PAESE[s].flag} ${esc(PAESE[s].name)}<small>${n}</small></a>` : `<a href="${BASE}/">${PAESE[s].flag} ${esc(PAESE[s].name)}<small>${n}</small></a>`).join("")}</div>
<h2>Le partenze di ${esc(nome)}</h2>
${ordina(list).slice(0, 60).map(t => scheda(t, 3)).join("\n")}
${list.length > 60 ? `<p class="m">E altri ${list.length - 60}: <a href="${BASE}/">tutti nella pagina dei viaggi</a>.</p>` : ""}
${faqHtml(faq)}`;
    await scrivi(OUT, url, layout({ title: `${cut(`Viaggi di gruppo a ${nome}${min != null ? `, da ${euro(min)}` : ""}`, 60)} | anyplans`,
      description: cut(lead, 158), url: SITE + url, body, ld: [itemList(`Viaggi di gruppo a ${nome}`, SITE + url, ordina(list)), faqLd(faq)],
      crumbs: [["anyplans", "/"], ["Viaggi di gruppo", `${BASE}/`], [nome, null]] }));
    pagine.push(url); mesiPagine.push([url, nome, list.length]);
  }

  // ── operatori ────────────────────────────────────────────────────────────────
  const perOp = new Map(); for (const t of vivi) { if (!perOp.has(t.op)) perOp.set(t.op, []); perOp.get(t.op).push(t); }
  const opsPagine = [...perOp.entries()].filter(([, l]) => l.length >= MIN_OPERATORE).sort((a, b) => b[1].length - a[1].length);
  const urlOp = (o) => `${BASE}/operatori/${o}/`;
  const riga = [];
  for (const [o, list] of [...perOp.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const min = minDi(list), volo = list.filter(t => t.flight).length, eta = [...new Set(list.flatMap(t => t.fut.map(d => d.age)).filter(Boolean))].slice(0, 4);
    const nPaesi = new Set(list.flatMap(t => t.dest)).size;
    riga.push({ o, n: list.length, dep: nDep(list), min, volo: volo === list.length ? "sempre" : volo === 0 ? "mai" : "in alcuni", eta, nPaesi });
  }
  for (const [o, list] of opsPagine) {
    const url = urlOp(o), nome = opName(o), r = riga.find(x => x.o === o);
    const dest = new Map(); for (const t of list) for (const s of t.dest) if (PAESE[s]) dest.set(s, (dest.get(s) || 0) + 1);
    const topDest = [...dest.entries()].sort((a, b) => b[1] - a[1]);
    const lead = `${nome} ha ${viaggi(list.length)} di gruppo con ${partenze(r.dep)} in calendario, in ${r.nPaesi} paesi${r.min != null ? `, da ${euro(r.min)}` : ""}. ${r.volo === "sempre" ? "Il volo è incluso in tutti i viaggi" : r.volo === "mai" ? "Il volo non è incluso: si compra a parte" : "Il volo è incluso solo in alcuni viaggi"}.${r.eta.length ? ` Fasce d'età dichiarate: ${r.eta.join(", ")}.` : ""} Qui li vedi tutti e li confronti con gli altri operatori; si prenota sul sito di ${nome}.`;
    const faq = [
      { q: `Quanto costano i viaggi di ${nome}?`, a: `${r.min != null ? `Il prezzo più basso in calendario è ${euro(r.min)}` : "I prezzi sono sul sito dell'operatore"}. ${r.volo === "mai" ? "Il volo non è incluso." : r.volo === "sempre" ? "Il volo è incluso." : "Il volo è incluso solo in alcuni viaggi."} Prezzi letti dal catalogo il ${seenIt}.` },
      { q: `Dove va ${nome}?`, a: `Le destinazioni con più viaggi sono ${joinIt(topDest.slice(0, 8).map(([s, n]) => `${PAESE[s].name} (${n})`))}; in tutto ${r.nPaesi} paesi.` },
      { q: `Ci sono alternative a ${nome}?`, a: `Sì: su anyplans ci sono ${perOp.size} operatori di viaggi di gruppo a confronto. Per le stesse destinazioni trovi spesso più operatori, con prezzi, durate e fasce d'età diverse.` },
    ];
    const body = `<h1>Viaggi di gruppo ${esc(nome)}: destinazioni, date e prezzi</h1>
<p class="lead">${esc(lead)}</p>
<p class="m">anyplans non è ${esc(nome)}: confrontiamo i viaggi letti dal loro catalogo pubblico il ${esc(seenIt)}. ${ops[o]?.url ? `Il sito ufficiale è <a href="${esc(ops[o].url)}" rel="noopener nofollow">${esc(ops[o].url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>.` : ""}</p>
<h2>Destinazioni</h2><div class="tags">${topDest.slice(0, 30).map(([s, n]) => `<a href="${perPaese.get(s)?.length >= MIN_PAESE ? urlPaese(s) : `${BASE}/`}">${PAESE[s].flag} ${esc(PAESE[s].name)}<small>${n}</small></a>`).join("")}</div>
<h2>I viaggi</h2>
${ordina(list).slice(0, 60).map(t => scheda(t, 3)).join("\n")}
${list.length > 60 ? `<p class="m">E altri ${list.length - 60}: <a href="${BASE}/">tutti nella pagina dei viaggi</a>.</p>` : ""}
${faqHtml(faq)}
<p style="margin-top:22px"><a class="btn" href="${BASE}/confronto-operatori/">Confronta ${esc(nome)} con gli altri operatori</a></p>`;
    await scrivi(OUT, url, layout({ title: `${cut(`Viaggi di gruppo ${nome}: ${viaggi(list.length)}${r.min != null ? ` da ${euro(r.min)}` : ""}`, 60)} | anyplans`,
      description: cut(lead, 158), url: SITE + url, body, ld: [itemList(`Viaggi di gruppo ${nome}`, SITE + url, ordina(list)), faqLd(faq)],
      crumbs: [["anyplans", "/"], ["Viaggi di gruppo", `${BASE}/`], ["Operatori", `${BASE}/confronto-operatori/`], [nome, null]] }));
    pagine.push(url);
  }
  // il confronto: una tabella, un operatore per riga
  {
    const url = `${BASE}/confronto-operatori/`;
    const top = riga.slice(0, 4).map(r => opName(r.o));
    const lead = `${riga.length} operatori di viaggi di gruppo a confronto, con i dati dei loro cataloghi letti il ${seenIt}: quanti viaggi hanno, da che prezzo, se il volo è incluso, quante destinazioni e per che età. I più grandi per numero di viaggi sono ${joinIt(top)}.`;
    const faq = [
      { q: `Qual è il miglior operatore per viaggi di gruppo?`, a: `Dipende da cosa cerchi: chi include il volo (${riga.filter(r => r.volo === "sempre").slice(0, 3).map(r => opName(r.o)).join(", ") || "pochi"}), chi ha più destinazioni (${riga.slice().sort((a, b) => b.nPaesi - a.nPaesi).slice(0, 3).map(r => opName(r.o)).join(", ")}), chi parte da prezzi più bassi. La tabella mette questi dati uno accanto all'altro.` },
      { q: `${top[0] || "WeRoad"} o ${top[1] || "SiVola"}?`, a: (() => { const a = riga[0], b = riga[1]; if (!a || !b) return ""; return `${opName(a.o)} ha ${viaggi(a.n)}${a.min != null ? ` da ${euro(a.min)}` : ""}, volo incluso ${a.volo}; ${opName(b.o)} ha ${viaggi(b.n)}${b.min != null ? ` da ${euro(b.min)}` : ""}, volo incluso ${b.volo}. Per la stessa meta conviene guardare le due pagine del paese, dove i viaggi sono uno accanto all'altro.`; })() },
      { q: `Si prenota su anyplans?`, a: `No: anyplans confronta, si prenota sul sito dell'operatore.` },
    ];
    const body = `<h1>Viaggi di gruppo: gli operatori a confronto</h1>
<p class="lead">${esc(lead)}</p>
<div class="tablewrap"><table><thead><tr><th>Operatore</th><th>Viaggi</th><th>Partenze</th><th>Da</th><th>Volo incluso</th><th>Paesi</th><th>Età</th></tr></thead><tbody>
${riga.map(r => `<tr><td>${perOp.get(r.o).length >= MIN_OPERATORE ? `<a href="${urlOp(r.o)}">${esc(opName(r.o))}</a>` : esc(opName(r.o))}</td><td>${r.n}</td><td>${r.dep}</td><td>${r.min != null ? euro(r.min) : "—"}</td><td>${r.volo}</td><td>${r.nPaesi}</td><td>${esc(r.eta.join(", ") || "—")}</td></tr>`).join("")}
</tbody></table></div>
${faqHtml(faq)}
<p style="margin-top:22px"><a class="btn" href="${BASE}/">Confronta tutti i viaggi</a></p>`;
    await scrivi(OUT, url, layout({ title: `Viaggi di gruppo: ${riga.length} operatori a confronto | anyplans`, description: cut(lead, 158), url: SITE + url, body,
      ld: [faqLd(faq)], crumbs: [["anyplans", "/"], ["Viaggi di gruppo", `${BASE}/`], ["Operatori a confronto", null]] }));
    pagine.push(url);
    llms.push(`## Operatori di viaggi di gruppo a confronto\n${SITE}${url}\n\n${lead}\n\n${riga.map(r => `- ${opName(r.o)}: ${viaggi(r.n)}, ${partenze(r.dep)}${r.min != null ? `, da ${euro(r.min)}` : ""}, volo incluso ${r.volo}, ${r.nPaesi} paesi${r.eta.length ? `, età ${r.eta.join(", ")}` : ""}`).join("\n")}\n`);
  }

  // ── il blocco di link veri per la pagina principale (JavaScript non lo tocca) ──
  const conts = [...new Set(paesi.map(([s]) => PAESE[s].cont))];
  const blocco = `<section class="sec" id="per-destinazione">
    <h2>Viaggi di gruppo per destinazione</h2><p class="subl">Una pagina per paese, con tutti gli operatori a confronto: prezzi, date, durata ed età.</p>
    ${conts.map(c => `<h3 style="margin:14px 0 8px;font-size:15px">${esc(c)}</h3><div class="tr-dests">${paesi.filter(([s]) => PAESE[s].cont === c).map(([s, l]) => `<a class="city" href="${urlPaese(s)}"><span class="flag">${PAESE[s].flag}</span><span class="n">${esc(PAESE[s].name)}</span><span class="meta">${viaggi(l.length)}${minDi(l) != null ? ` · da ${euro(minDi(l))}` : ""}</span></a>`).join("")}</div>`).join("\n    ")}
    <h3 style="margin:18px 0 8px;font-size:15px">Per periodo</h3><div class="tr-dests">${pagine.includes(`${BASE}/capodanno/`) ? `<a class="city" href="${BASE}/capodanno/"><span class="flag">🎆</span><span class="n">Capodanno</span><span class="meta">${viaggi(capoList.length)}</span></a>` : ""}${mesiPagine.map(([u, n, c]) => `<a class="city" href="${u}"><span class="flag">📅</span><span class="n">${esc(n)}</span><span class="meta">${viaggi(c)}</span></a>`).join("")}</div>
    <h3 style="margin:18px 0 8px;font-size:15px">Per operatore</h3><div class="tr-dests"><a class="city" href="${BASE}/confronto-operatori/"><span class="flag">⚖️</span><span class="n">Tutti a confronto</span><span class="meta">${riga.length} operatori</span></a>${opsPagine.map(([o, l]) => `<a class="city" href="${urlOp(o)}"><span class="flag">🧭</span><span class="n">${esc(opName(o))}</span><span class="meta">${viaggi(l.length)}</span></a>`).join("")}</div>
  </section>`;

  // ── llms-viaggi.txt e sitemap-viaggi.xml ─────────────────────────────────────
  await writeFile(path.join(OUT, "llms-viaggi.txt"), `# anyplans · viaggi di gruppo

> Confronto dei viaggi di gruppo per chi parte da solo: ${viaggi(vivi.length)} con partenze future di ${perOp.size} operatori italiani (${joinIt(riga.slice(0, 6).map(r => opName(r.o)))} e altri), ${partenze(nDep(vivi))} in calendario. Prezzi e date letti dai cataloghi pubblici il ${seenIt}; si prenota sul sito dell'operatore. Pagina principale: ${SITE}${BASE}/

${llms.join("\n")}`);
  const oggiIso = today;
  await writeFile(path.join(OUT, "sitemap-viaggi.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[`${BASE}/`, ...pagine].map(u => `  <url><loc>${SITE}${u}</loc><lastmod>${oggiIso}</lastmod></url>`).join("\n")}
</urlset>
`);
  return { blocco, pagine, paesi: paesi.length, mesi: mesiPagine.length, operatori: opsPagine.length };
}

async function scrivi(OUT, url, html) {
  const dir = path.join(OUT, url.replace(/^\/|\/$/g, ""));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html);
}

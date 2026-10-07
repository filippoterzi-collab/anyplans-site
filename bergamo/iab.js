// Browser interno di Instagram, TikTok e Facebook (UI.md §3.19, deciso 07/10/2026): da lì il sito sparisce
// appena si chiude l'app e la sessione non è quella di Safari/Chrome. Una striscia in basso offre di aprire
// la stessa pagina nel browser vero: iOS passa a Safari con lo schema `x-safari-https://`, Android a Chrome
// con un `intent://`. Niente redirect automatico: i browser interni lo bloccano, serve il tocco.
// Lo caricano la home (index.html) e tutte le pagine statiche (TRACK in branding/seo/generate.mjs).
(function () {
  try {
    var ua = navigator.userAgent || "";
    var app = /TikTok|musical_ly|Bytedance/i.test(ua) ? "TikTok"
            : /FBAN|FBAV|FB_IAB/i.test(ua) ? "Facebook"
            : /Instagram/i.test(ua) ? "Instagram" : "";
    if (!app) return;
    var ios = /iPhone|iPad|iPod/i.test(ua), android = /Android/i.test(ua);
    if (!ios && !android) return;
    try { if (sessionStorage.getItem("anyplans_iab_off")) return; } catch (_) {}
    var url = location.href;   // utm comprese: la sorgente arriva anche nel browser vero
    var href = ios ? "x-safari-" + url
      : "intent://" + location.host + location.pathname + location.search + "#Intent;scheme=https;S.browser_fallback_url=" + encodeURIComponent(url) + ";end";
    var browser = ios ? "Safari" : "Chrome";

    var st = document.createElement("style");
    st.textContent = "#iab{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px));background:#1B4FD8;color:#FBF9F5;font:15px/1.35 -apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;box-shadow:0 -4px 16px rgba(0,0,0,.18)}" +
      "#iab span{flex:1 1 180px}#iab a{flex:0 0 auto;background:#FBF9F5;color:#1B4FD8;font-weight:700;text-decoration:none;padding:9px 14px;border-radius:999px}" +
      "#iab button{flex:0 0 auto;background:none;border:0;color:#FBF9F5;font-size:22px;line-height:1;padding:4px 6px;opacity:.85}";
    document.head.appendChild(st);

    var bar = document.createElement("div"); bar.id = "iab";
    var txt = document.createElement("span");
    txt.textContent = "Sei nel browser di " + app + ": da qui anyplans sparisce quando chiudi l'app.";
    var a = document.createElement("a"); a.href = href; a.rel = "noopener"; a.textContent = "Apri in " + browser;
    a.onclick = function () { (window.apTrack || window.track || function () {})("iab_open", location.pathname); };
    var x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Chiudi"); x.textContent = "×";
    x.onclick = function () { bar.remove(); try { sessionStorage.setItem("anyplans_iab_off", "1"); } catch (_) {} };
    bar.appendChild(txt); bar.appendChild(a); bar.appendChild(x);
    (document.body || document.documentElement).appendChild(bar);
  } catch (_) {}
})();

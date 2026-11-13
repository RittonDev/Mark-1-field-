// Maxx Field: service worker mínimo para o app instalável.
// Não guarda nada em cache (chamado é sempre o dado do momento). Só cuida de abrir uma página
// sem internet: em vez da tela de erro do navegador, um aviso claro.

const OFFLINE_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sem internet · Maxx Field</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#1b1f26}
  main{max-width:360px;padding:32px;text-align:center}
  h1{font-size:18px;margin:0 0 8px}
  p{font-size:14px;line-height:1.5;color:#5d6676;margin:0 0 20px}
  button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;background:#2447ff;color:#fff;cursor:pointer}
</style></head>
<body><main>
  <h1>Sem conexão com a internet</h1>
  <p>Assim que a conexão voltar, abra de novo para enviar ou acompanhar suas solicitações.</p>
  <button onclick="location.reload()">Tentar de novo</button>
</main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    ),
  );
});

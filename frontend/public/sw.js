// Maxx Field: service worker mínimo para o app instalável.
// Não guarda nada em cache, nem páginas nem respostas da API (chamado é sempre o dado do momento).
// Só cuida de abrir uma página quando a rede falha: em vez da tela de erro do navegador, um aviso
// claro, que separa "sem internet" de "servidor fora" e recarrega sozinho quando a conexão volta.
// Versão nova deste arquivo assume na hora (skipWaiting + clients.claim).

const OFFLINE_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sem conexão · Maxx Field</title>
<style>
  body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#1b1f26}
  main{max-width:360px;padding:32px;text-align:center}
  h1{font-size:18px;margin:0 0 8px}
  p{font-size:14px;line-height:1.5;color:#525a68;margin:0 0 20px}
  button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;background:#2447ff;color:#fff;cursor:pointer}
  button:focus-visible{outline:2px solid #1a36d6;outline-offset:2px}
  @media (prefers-color-scheme: dark){
    body{background:#08090b;color:#ececf0}
    p{color:#9ba1ac}
    button{background:#3d5af7}
    button:focus-visible{outline-color:#5470ff}
  }
</style></head>
<body><main role="alert">
  <h1 id="t">Sem conexão com a internet</h1>
  <p id="d">Assim que a conexão voltar, a página abre sozinha.</p>
  <button type="button" onclick="location.reload()">Tentar de novo</button>
</main>
<script>
  if (navigator.onLine) {
    document.getElementById("t").textContent = "O Maxx Field não respondeu";
    document.getElementById("d").textContent = "O servidor pode estar em atualização. Tente de novo em instantes.";
  }
  addEventListener("online", function () { location.reload(); });
</script>
</body></html>`;

const offlineResponse = () =>
  new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // A página começa a carregar junto com o acordar do worker (sem esperar por ele a cada navegação).
      self.registration.navigationPreload ? self.registration.navigationPreload.enable() : Promise.resolve(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode !== "navigate") return;
  // Arquivos e respostas da API abertos em aba (anexos, relatórios): direto para a rede, como sem worker.
  if (new URL(request.url).pathname.startsWith("/api/")) return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch {
        return offlineResponse();
      }
    })(),
  );
});

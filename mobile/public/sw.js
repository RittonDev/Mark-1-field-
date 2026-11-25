/*
 * Service worker do app dos técnicos instalado pelo navegador (PWA).
 *
 * Só guarda a "casca" do app (index, pacote JS, fontes, ícones, o WebAssembly do SQLite), para ele abrir sem
 * internet depois da primeira visita. Os dados (OS, fotos, fila de envio) continuam no SQLite do próprio app; a
 * API (/api/...) nunca passa por este cache.
 *
 * O build da homologação (deploy/homolog/gateway/Dockerfile) troca __BUILD_ID__ por um número novo a cada
 * publicação: o service worker novo apaga o cache da versão anterior e o app pega o pacote novo.
 */
const BUILD = "__BUILD_ID__";
const SHELL = `maxx-shell-${BUILD}`;
const ASSETS = `maxx-assets-${BUILD}`;
const PRECACHE = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

/**
 * O export separa o app em pacotes por tela (carregados quando a tela abre). Para qualquer tela abrir sem internet,
 * todos entram no cache já na instalação: a lista sai do build (precache.json). Um arquivo que falhar não impede a
 * instalação: ele entra no cache na primeira vez que for usado com internet.
 */
function precacheBuild() {
  return fetch("/precache.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : []))
    .then((list) =>
      caches.open(ASSETS).then((cache) => Promise.allSettled(list.map((path) => cache.add(path)))),
    )
    .catch(() => undefined);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(precacheBuild)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith("maxx-") && key !== SHELL && key !== ASSETS).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Arquivos com hash no nome (pacote, fontes, wasm) e ícones: não mudam dentro de uma mesma versão. */
function isStatic(url) {
  return (
    url.pathname.startsWith("/_expo/") ||
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    /\.(?:js|mjs|css|wasm|png|jpe?g|svg|ico|ttf|otf|woff2?)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    // Rede primeiro (pega a versão nova); sem internet, a página guardada (o app é uma página só).
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached || Response.error())),
    );
    return;
  }

  if (isStatic(url)) {
    // Cache primeiro; o que vier da rede fica guardado para a próxima vez sem internet.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok && response.type === "basic") {
              const copy = response.clone();
              caches.open(ASSETS).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

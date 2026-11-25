# Gateway da homologação: serve o app dos técnicos (PWA, export web do Expo) e repassa /api para a API;
# no domínio da central, repassa o resto para o Next.js. Contexto do build: a raiz do repositório
# (a lista do que entra fica em Dockerfile.dockerignore, ao lado deste arquivo).

FROM node:22-alpine AS pwa
WORKDIR /app
COPY mobile/package.json mobile/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY mobile/ ./
# Endereço da API embutido no pacote (EXPO_PUBLIC_*): a mesma origem do app, que o gateway repassa.
ARG EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL} \
    EXPO_NO_TELEMETRY=1 \
    CI=1
# Depois do export: a versão do service worker (cada build apaga o cache do anterior) e a lista dos pacotes que ele
# guarda na instalação (precache.json: os pacotes por tela, fontes e o wasm do SQLite), para o app abrir sem internet.
RUN test -n "$EXPO_PUBLIC_API_URL" \
    && npx expo export --platform web --output-dir dist \
    && sed -i "s/__BUILD_ID__/$(date +%Y%m%d%H%M%S)/" dist/sw.js \
    && node -e 'const fs = require("fs"), path = require("path"); const out = []; (function walk(dir) { for (const name of fs.readdirSync(dir)) { const full = path.join(dir, name); if (fs.statSync(full).isDirectory()) walk(full); else out.push("/" + path.relative("dist", full).split(path.sep).join("/")); } })("dist"); fs.writeFileSync("dist/precache.json", JSON.stringify(out.filter((p) => p.startsWith("/_expo/") || p.startsWith("/assets/")))); console.log("precache:", out.length, "arquivos no dist");' \
    && test -f dist/index.html \
    && test -f dist/manifest.json \
    && test -f dist/precache.json \
    && test -f dist/icons/apple-touch-icon.png

FROM nginx:1.27-alpine
# O nginx oficial gera /etc/nginx/conf.d/default.conf a partir do template no start, com TECNICO_HOST e
# CENTRAL_HOST do ambiente.
COPY deploy/homolog/gateway/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=pwa /app/dist /usr/share/nginx/pwa

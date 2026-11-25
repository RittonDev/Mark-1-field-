# Homologação no Coolify (app dos técnicos instalável + central)

Ambiente de teste do MaxxChamados na **mesma VPS da homologação do site** (`2.25.97.113`, a do
`field-homolog.maxxsystem.net`), gerida pelo Coolify. Serve para os técnicos instalarem o app pelo navegador
(PWA, Android e iPhone, sem loja) e para a central criar as OS de teste.

| Endereço | O que abre |
|---|---|
| `https://tecnico-homolog.maxxsystem.net` | app dos técnicos (PWA) — é o link que vai para os técnicos |
| `https://chamados-homolog.maxxsystem.net` | central (analistas e gestores) |
| `…/api/v1` nos dois | a mesma API (o gateway repassa) |

**Dados:** banco novo, só com os dados de exemplo do seed (empresas, lojas, OS e usuários `@exemplo.com.br`).
Nada do banco local nem do Field Control vai para lá. As contas dos técnicos que vão testar são criadas na
central da homologação (Técnicos › Novo, ou o link de cadastro).

## Como está montado

`docker-compose.yml` (esta pasta), cinco serviços na rede interna do recurso:

| Serviço | Imagem | Papel |
|---|---|---|
| `db` | `postgres:16-alpine` | banco, sem porta pública; volume `pgdata` |
| `redis` | `redis:7-alpine` | barramento do tempo real |
| `api` | `backend/Dockerfile` | `ENVIRONMENT=production`; no start roda `alembic upgrade head`, o seed (idempotente) e a API |
| `web` | `frontend/Dockerfile` | central Next.js com `NEXT_PUBLIC_API_URL`/`WS_URL`/`WEB_URL` do domínio da central |
| `gateway` | `deploy/homolog/gateway/Dockerfile` | nginx: o PWA (export web do Expo) e `/api` no domínio do técnico; a central e `/api` no domínio da central |

Só o `gateway` recebe domínio. O proxy do Coolify termina o HTTPS (Let's Encrypt) e manda para a porta 80 dele.

**PWA:** o build do gateway roda `npx expo export --platform web` com
`EXPO_PUBLIC_API_URL=https://tecnico-homolog.maxxsystem.net/api/v1` (mesma origem: sem CORS) e serve `dist/` com:

- `Cross-Origin-Opener-Policy: same-origin` e `Cross-Origin-Embedder-Policy: require-corp` (o SQLite do app roda
  em WebAssembly com `SharedArrayBuffer`; o Safari do iPhone não aceita `credentialless`);
- o `index.html` de `mobile/public/` (manifesto, ícones, metas do iOS) e o `sw.js` (casca do app guardada para
  abrir sem internet; a `/api` nunca passa pelo cache; cada build troca a versão e apaga o cache anterior);
- qualquer rota cai no `index.html` (o app é uma página só); `/_expo` e `/assets` com cache longo.

**Segredos:** variáveis mágicas do Coolify, geradas uma vez e guardadas por ele — ninguém digita senha:

| Variável | Uso |
|---|---|
| `SERVICE_PASSWORD_POSTGRES` | senha do banco (`db` e `DATABASE_URL` da `api`) |
| `SERVICE_PASSWORD_64_JWT` | `JWT_SECRET` da API (64 caracteres) |
| `SERVICE_PASSWORD_SEED` | senha dos usuários de exemplo do seed (`admin@exemplo.com.br` e os outros) |

Outras variáveis (com padrão; mude no Coolify só se os endereços mudarem): `TECNICO_HOST`
(`tecnico-homolog.maxxsystem.net`), `CENTRAL_HOST` (`chamados-homolog.maxxsystem.net`), `PUBLIC_SCHEME` (`https`),
`WS_SCHEME` (`wss`). Endereço novo pede **build novo** (os endereços entram no pacote do PWA e da central).

## Publicar (primeira vez)

1. **DNS (Cloudflare de `maxxsystem.net`)**: dois registros `A` para `2.25.97.113` — `tecnico-homolog` e
   `chamados-homolog` — em **DNS only** (nuvem cinza), como o `field-homolog`: o certificado sai pelo Coolify.
   Conferir com `nslookup tecnico-homolog.maxxsystem.net`.
2. **Coolify** › o projeto da homologação › **+ New** › **Public Repository** (ou o GitHub App, se o repositório
   estiver nele): `https://github.com/RittonDev/Mark-1-field-`, branch `main`, build pack **Docker Compose**.
   - Base Directory: `/deploy/homolog` · Docker Compose Location: `/docker-compose.yml`.
3. Na tela do recurso, em **Domains**, no serviço `gateway`:
   `https://tecnico-homolog.maxxsystem.net:80,https://chamados-homolog.maxxsystem.net:80`. Os outros serviços
   ficam sem domínio.
4. **Environment Variables**: conferir que o Coolify gerou as três `SERVICE_PASSWORD_*` (e que os endereços estão
   com o padrão). Nada a digitar.
5. **Deploy**. O primeiro build demora (instala as dependências da central e do app). Pronto quando os cinco
   serviços ficam *healthy*.
6. Conferir:
   - `https://tecnico-homolog.maxxsystem.net/healthz` → `ok`; `…/api/v1/health` → `{"status":"ok",…}`;
   - `https://tecnico-homolog.maxxsystem.net/manifest.json` e `/sw.js` → 200;
   - a central abre em `https://chamados-homolog.maxxsystem.net` e entra com `admin@exemplo.com.br` e a senha de
     `SERVICE_PASSWORD_SEED` (Environment Variables, no Coolify).
7. Na central: criar as contas dos técnicos que vão testar (ou mandar o link de cadastro) e as OS de teste.
8. Mandar aos técnicos o guia de instalação (PDF) com o link `https://tecnico-homolog.maxxsystem.net`.

**Atualizar:** cada push na `main` pode publicar sozinho (Webhook do Coolify) ou pelo botão **Redeploy**. O banco
e as fotos ficam nos volumes `pgdata` e `media`. A migração roda no start da API.

**Desligar:** parar o recurso no Coolify e apagar os dois registros DNS. Apagar o recurso ou os volumes apaga o
banco de teste (ação sem volta).

## Testar no computador (antes de publicar)

Na raiz do repositório, com um arquivo de variáveis **fora do repositório** (senhas aleatórias, `http` e os nomes
`*.localhost`, que o navegador trata como contexto seguro) e um override que publica o gateway na porta 80:

```sh
# local.env (fora do repositório)
SERVICE_PASSWORD_POSTGRES=<aleatória>
SERVICE_PASSWORD_64_JWT=<aleatória, 64>
SERVICE_PASSWORD_SEED=<aleatória>
PUBLIC_SCHEME=http
WS_SCHEME=ws
TECNICO_HOST=tecnico.localhost
CENTRAL_HOST=chamados.localhost

# local-override.yml (fora do repositório)
services:
  gateway:
    ports:
      - "80:80"
```

```sh
docker compose -p mc-homolog -f deploy/homolog/docker-compose.yml -f <local-override.yml> --env-file <local.env> up -d --build
```

Abrir `http://tecnico.localhost` (app) e `http://chamados.localhost` (central). Para parar e apagar o banco de teste:
`docker compose -p mc-homolog -f deploy/homolog/docker-compose.yml down -v`.

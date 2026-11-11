# Arquitetura

```
┌──────────────┐   HTTPS (REST + JWT)   ┌──────────────────────┐     ┌──────────────┐
│ Web Next.js  │ ─────────────────────► │  API FastAPI         │ ──► │ PostgreSQL   │
│ (gestão)     │ ◄──── WebSocket ────── │  (uvicorn, async)    │     │ (SQLAlchemy  │
└──────────────┘                        │                      │     │  + Alembic)  │
┌──────────────┐   /sync/pull|push      │  services/           │     └──────────────┘
│ App iOS/     │ ─────────────────────► │   tickets  workflow  │     ┌──────────────┐
│ Android      │ ◄──── WebSocket ────── │   sla      sync      │ ◄─► │ Redis        │
│ (técnicos)   │ ◄──── push (FCM) ───── │   realtime push      │     │ (Pub/Sub)    │
└──────────────┘                        └──────────────────────┘     └──────────────┘
```

## Backend (`backend/`)

| Pasta | Conteúdo |
|---|---|
| `app/core` | configuração (variáveis de ambiente), segurança (JWT, bcrypt), enums e rótulos |
| `app/db` | base declarativa, sessão assíncrona |
| `app/models` | tabelas: usuários/grupos, clientes/locais, ativos, categorias/SLA, OS e filhos, sync |
| `app/schemas` | contratos Pydantic de entrada e saída (o que web e mobile recebem) |
| `app/services` | **regras de negócio**: `workflow` (máquina de estados), `sla`, `tickets` (casos de uso), `sync` (mobile), `realtime` (WebSocket + Redis), `push`, `storage` |
| `app/api` | rotas HTTP finas, que só validam a entrada e chamam os serviços |
| `alembic/` | migrations versionadas do PostgreSQL |
| `tests/` | unitários (fluxo, SLA, eventos) e integração contra PostgreSQL real |

### Decisões

- **Regras só nos serviços.** Web, mobile (sync) e rotinas automáticas chamam as mesmas funções de
  `services/tickets.py`, então uma regra vale para todos os canais.
- **Eventos depois do commit.** O serviço enfileira o evento na sessão; `commit_and_publish` grava e
  só então publica. Nenhum cliente recebe evento de algo que não foi gravado.
- **Redis Pub/Sub** espalha os eventos entre várias instâncias da API. Sem `REDIS_URL`, a entrega é
  local (uma instância).
- **Concorrência otimista:** coluna `version` na OS. Web e app mandam `expected_version` e a API
  responde 409 se outra pessoa alterou antes.
- **Enums como VARCHAR** (não ENUM nativo do Postgres): adicionar um status não exige migration de tipo.
- **Número da OS** com `IDENTITY` do PostgreSQL, exibido como `OS-000123` (`TICKET_PREFIX`).
- **Histórico imutável** em `ticket_events` (JSONB), base da auditoria e da revogação no sync mobile.
- **Anexos** com chave relativa (`storage_key`). Hoje vão para disco local; trocar por S3/R2 é só
  reimplementar `services/storage.py`.

## Frontend (`frontend/`)

Next.js 16 (App Router) + React 19 + Tailwind 4 + TanStack Query.

| Caminho | Conteúdo |
|---|---|
| `src/app/login` | login |
| `src/app/(app)/dashboard` | indicadores, backlog por status/prioridade, carga por analista |
| `src/app/(app)/chamados` | lista com filtros, nova OS e detalhe (ações, atribuição, acompanhamentos, histórico, apontamentos, anexos) |
| `src/app/(app)/quadro` | kanban por status com arrastar e soltar |
| `src/app/(app)/clientes`, `ativos`, `usuarios`, `configuracoes` | cadastros, SLA e categorias |
| `src/lib/api.ts` | cliente HTTP com renovação automática do token |
| `src/lib/realtime.tsx` | WebSocket com reconexão, invalida o cache e mostra avisos |
| `src/lib/constants.ts`, `workflow.ts` | espelho dos rótulos e regras do backend |

## Modelo de dados (resumo)

- `users` (papel, grupo) · `teams`
- `customers` → `locations` (endereço, coordenadas, contato) → `assets` (tipo, marca, modelo, série, patrimônio, IP)
- `categories` (hierárquica, grupo padrão) · `sla_policies` (por prioridade)
- `tickets` (status, prioridade, impacto, urgência, cliente/local/ativo, solicitante, **analista**, grupo, agenda, prazos de SLA, `version`)
  - `ticket_comments` (público ou interno) · `ticket_events` (histórico) · `ticket_worklogs` (horas, GPS) · `ticket_attachments`
- `device_tokens` (push) · `sync_operations` (idempotência do app)

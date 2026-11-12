# MaxxChamados

Gestão de chamados / ordens de serviço de T.I. com atendimento em campo: manutenção de impressoras,
computadores, redes, CFTV e telefonia. Referências de produto: **Field Control** (a ferramenta que a
operação usa hoje) e o **GLPI** (Field Service, ITIL). Em caso de dúvida, seguir o Field Control.

A ferramenta tem **dois acessos**, e o backend aplica essa separação no login (`channel`):

| Acesso | Quem | Para quê |
|---|---|---|
| **Navegador** (`frontend/`) | Analistas, supervisores e administradores. O solicitante também, no portal dele. | Toda a gestão das OS: ver, abrir, editar, atribuir, mudar status, SLA, dashboard e cadastros |
| **Celular** (`mobile/`, Android e iOS) | **Técnicos de campo**, e só eles | Atender as OS dele: agenda, deslocamento, check-in GPS, fotos, apontamentos, offline |

O técnico que tenta entrar pelo navegador (ou o analista pelo app) recebe a orientação de qual acesso usar.
Os dois canais ficam sincronizados em tempo real.

| Camada | Stack |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, TanStack Query |
| Backend | Python 3.12, FastAPI, SQLAlchemy 2 (async), Pydantic 2, Alembic |
| Banco | PostgreSQL 16 |
| Tempo real | WebSocket + Redis Pub/Sub |

## Funcionalidades

- **OS com ciclo de vida padrão de mercado** (ITIL / ServiceNow / Jira SM + estados de campo):
  Novo, Em triagem, Atribuído, Agendado, Em deslocamento, Em atendimento, Aguardando cliente,
  Aguardando fornecedor/peça, Resolvido, Fechado, Cancelado, Reaberto. Ver [docs/STATUS_E_SLA.md](docs/STATUS_E_SLA.md).
- **Atribuição a analista ou técnico** (com a carga atual de cada um), "assumir OS", grupos técnicos e roteamento por categoria.
- **SLA** de 1ª resposta e de solução por prioridade (matriz impacto × urgência), pausado nas pendências, com alertas "em risco" e "violado".
- **Detalhe da OS:** acompanhamentos públicos e notas internas, histórico/auditoria, apontamento de horas, anexos e fotos, check-in por GPS.
- **Quadro kanban** com arrastar e soltar, que só aceita transições válidas.
- **Dashboard:** backlog, SLA, conformidade em 30 dias, tempo médio de solução, carga por analista.
- **Locais como filiais** (como no Field Control): cada local tem código e CNPJ próprio, tela própria com busca e paginação, e histórico resumido (OS abertas, total, última OS). A OS aceita um **endereço do atendimento** separado do endereço do local.
- **Tipos de serviço com duração estimada × real** (o "Tipo de OS" do Field Control, inclusive por cliente). A real é medida pelo tempo em atendimento; a tela compara as duas e o catálogo sugere corrigir a estimativa pela mediana do que aconteceu (a estimativa aprende). Agendar só com o início usa a duração estimada.
- **Atividades do dia** (tela própria, como no Field Control): as visitas do dia agrupadas por técnico, com agendado × início real × término na mesma linha, atraso, check-in com GPS, estimada × real, situações (agendada, atrasada, em deslocamento, em atendimento, pendente, reagendada, concluída) e atualização em tempo real.
- **Cadastros:** clientes (CPF/CNPJ validado, inclusive alfanumérico), locais (com coordenadas), ativos (impressora, desktop, switch, câmera, DVR/NVR…), usuários, grupos, categorias e SLA.
- **Tempo real:** toda mudança aparece na hora para quem pode ver a OS (web e apps).
- **Pronto para mobile:** sync offline idempotente, revogação de OS reatribuídas, registro de aparelhos para push. Ver [docs/MOBILE_SYNC.md](docs/MOBILE_SYNC.md).
- **Papéis:** administrador, supervisor, analista (gestão completa na web), técnico de campo (app) e solicitante.

## Rodar localmente (Docker)

Pré-requisito: Docker Desktop.

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

```bash
docker compose exec api python -m app.seed
```

- Web: http://localhost:3001
- API e documentação interativa: http://localhost:8000/docs
- PostgreSQL: `localhost:5433` (usuário/senha `chamados`)

O seed cria grupos, categorias (Impressoras, Computadores, Redes, CFTV, Telefonia, Software), clientes,
locais, ativos e 11 OS em vários status. Usuários de exemplo, todos com a senha de `SEED_PASSWORD`
no `.env`:

| Papel | E-mail |
|---|---|
| Administrador | `admin@exemplo.com.br` |
| Supervisor | `supervisor@exemplo.com.br` |
| Analista (web) | `bruno@exemplo.com.br` |
| Técnicos de campo (app) | `carlos@`, `rafael@`, `juliana@exemplo.com.br` |
| Solicitante | `solicitante@exemplo.com.br` |

As portas foram escolhidas para não colidir com o ambiente local do MaxxField (3000, 5432, 8080).

## Testes e qualidade

```bash
docker compose run --rm api sh -c "ruff format --check . && ruff check . && pytest -q"
```

```bash
docker compose run --rm api sh -c "alembic upgrade head && alembic check"
```

O frontend roda `npm run typecheck`, `npm run lint` e `npm run build` (o build da imagem `web` executa o último).

> Neste Docker Desktop, pastas do drive D: não podem ser montadas em containers. Por isso o código entra
> na imagem pelo build. Depois de alterar o backend, rode `docker compose build api` antes de testar.

## Banco de dados e migrations

As migrations ficam em `backend/alembic/versions` e a API aplica todas ao subir (`alembic upgrade head`).
Para criar uma nova depois de mudar um modelo:

```bash
docker compose run --name mig api alembic revision --autogenerate -m "descricao"
```

```bash
docker cp mig:/app/alembic/versions/. backend/alembic/versions && docker rm mig
```

Revise o arquivo gerado antes de commitar. Para apontar para outro PostgreSQL, troque `DATABASE_URL`
(formato `postgresql+asyncpg://usuario:senha@host:5432/banco`).

## Sincronização com o GitHub

Repositório: https://github.com/RittonDev/Mark-1-field- (branch `main`, **público**).

Para manter a pasta sincronizada continuamente (commit e push automáticos de cada alteração, mais
pull do que chegar no GitHub), deixe rodando num terminal:

```bash
powershell -ExecutionPolicy Bypass -File scripts/sync-github.ps1
```

- Verifica a cada 20 s (`-IntervalSeconds 10` para mudar) e só commita quando as alterações ficam
  estáveis por um ciclo, para não pegar um arquivo no meio do salvamento.
- Recusa enviar `.env`, chaves (`.pem`, `.key`…) e arquivos acima de 50 MB. Como o repositório é
  público, segredos ficam só no `.env`, que está no `.gitignore`.
- Para no primeiro conflito com o GitHub, sem forçar nada: resolva com `git status` e rode de novo.
- `-Once` faz uma única rodada (útil para testar).

## Documentação

- [docs/API.md](docs/API.md): contrato da API e eventos WebSocket
- [docs/STATUS_E_SLA.md](docs/STATUS_E_SLA.md): fluxo de status, permissões, prioridade e SLA
- [docs/MOBILE_SYNC.md](docs/MOBILE_SYNC.md): como os apps iOS/Android sincronizam
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): camadas, decisões e modelo de dados

## Ainda não feito

- Apps iOS e Android (a API e o contrato de sync estão prontos).
- Envio real de push: `LogPushProvider` só registra no log; falta ligar o Firebase Cloud Messaging.
- SLA em horário comercial e feriados (hoje 24x7), SLA por contrato e escalonamento automático.
- Limite de tentativas de login, recuperação de senha e SSO (Entra ID).
- Armazenamento de anexos em S3/R2 (hoje em disco, no volume `media`).
- Abertura de OS por e-mail/WhatsApp, base de conhecimento, pesquisa de satisfação e relatórios exportáveis.

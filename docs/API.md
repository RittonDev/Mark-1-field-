# Contrato da API — Maxx Field (MaxxChamados)

Base: `http://localhost:8000/api/v1` · JSON · datas em ISO-8601 com fuso (UTC) · IDs são UUID.
OpenAPI interativo: `http://localhost:8000/docs`.

Autenticação: `Authorization: Bearer <access_token>`. Erros seguem `{"detail": "mensagem"}`
(422 de validação do FastAPI traz `detail` como lista). Códigos: 401 sem token/expirado,
403 sem permissão, 404 não encontrado, 409 conflito de versão, 422 regra de negócio/validação.

## Papéis

| Papel | Valor | Vê | Pode |
|---|---|---|---|
| Administrador | `admin` | tudo | tudo, inclusive usuários e SLA |
| Supervisor | `supervisor` | tudo | o mesmo do analista + grupos e categorias |
| Analista | `analyst` | **todas as OS** (interface web) | gestão completa das OS: abrir, editar, atribuir a qualquer técnico ou analista, mudar qualquer status, comentar, apontar horas; cadastrar clientes, locais e ativos |
| Técnico de campo (terceiro) | `technician` | **só as OS atribuídas a ele** (app mobile), e delas **só o básico**: cliente, local (nome e endereço da loja), agenda e escopo; grupo ou fila não bastam | sair, iniciar e concluir a visita, formulários, fotos, assinatura e pedir peça **nas OS dele**. Nunca mexe no horário (agenda, pausa e horas são da central; o tempo dele corre do início à conclusão). Não assume nem se atribui OS: quem coloca o técnico na OS é a gestão, ou ele aceita pelo valor uma oferta que a central mandou para ele ([Ofertas de OS](#ofertas-de-os-2026-11-18)). Sem acompanhamentos (a central fala com ele pelo WhatsApp) |
| Cliente (portal) | `requester` | **pelo portal**, as solicitações de todas as lojas da empresa dele (`users.customer_id`), com lista fechada de campos | abrir solicitação e acompanhar a visita; cancelar enquanto a central não começou (nova ou em triagem). Não usa as rotas internas: `/tickets`, cadastros, painel e grupos respondem 403 (ou 404 por id) |

Supervisor e analista: as telas que cada um vê e edita e as filas que vê dependem do **perfil de acesso** (os
perfis padrão reproduzem a tabela acima). Ver [Acesso: perfis por tela e visibilidade de filas](#acesso-perfis-por-tela-e-visibilidade-de-filas).

**Técnico é terceiro: só o básico.** Na OS (detalhe, sync e respostas do push) o servidor zera para o
técnico: prazos, motivos e veredito de SLA (`resolution_sla_met_at`), analista (`owner`), grupo, projeto,
categoria, etiquetas, solicitante, quem abriu, nº do chamado do cliente, CNPJ e contato da loja (nome e telefone:
quem fala com a loja é a central), reincidência e dados migrados (`services/tickets.py::field_view`). E-mail dos colegas e de quem
lançou custos também sai. Anexos: só fotos, fotos dos formulários, assinatura e o que ele mesmo enviou
(documentos do escritório ficam fora). Horas: não aponta (só a gestão) e vê só as dele. Comentários: nem lê nem escreve (403; no sync, `comments` vem vazio e a
operação `comment` é recusada). Rotas de cadastro, usuários, grupos, painel, relatórios de SLA,
atividades do dia, catálogo (exceto motivos de violação e de visita improdutiva), listagem de OS e
histórico da OS respondem 403 para ele (`NoTechnicianUser` / `TicketManagerUser`). No WebSocket ele
recebe só que a OS mudou (tipo, OS, status, versão e, na equipe da visita, `added_ids`).

## Status da OS

| Valor | Rótulo | Grupo | SLA |
|---|---|---|---|
| `new` | Novo | open | corre |
| `triage` | Em triagem | open | corre |
| `assigned` | Atribuído | active | corre |
| `scheduled` | Agendado | active | corre |
| `en_route` | Em deslocamento | active | corre |
| `in_progress` | Em atendimento | active | corre |
| `on_hold_customer` | Aguardando cliente | pending | **pausado** |
| `on_hold_vendor` | Aguardando fornecedor/peça | pending | **pausado** |
| `resolved` | Resolvido | done | para |
| `closed` | Fechado | final | — |
| `cancelled` | Cancelado | final | — |
| `reopened` | Reaberto | open | corre |

Transições permitidas e regras: `GET /meta` e `docs/STATUS_E_SLA.md`. Cada OS detalhada traz
`allowed_transitions` já filtradas pelo papel do usuário logado — a UI só precisa exibir esses botões.

Prioridades: `critical` (P1), `high` (P2), `medium` (P3), `low` (P4).
Tipos: `incident`, `service_request`, `preventive`, `installation`.
Origem: `web`, `mobile`, `email`, `phone`, `whatsapp`, `monitoring`.
`sla_status`: `ok`, `at_risk`, `breached`, `paused`, `met`.

## Endpoints

### Auth
- `POST /auth/login` `{email, password, channel?: "web" | "mobile"}` → `TokenResponse {access_token, refresh_token, token_type, expires_in, user: UserOut}`
  - **Canais de acesso:** `web` aceita `admin`, `supervisor`, `analyst` e `requester`; `mobile` aceita só `technician`.
    Papel fora do canal → **403** com a orientação em `detail`. Senha errada é sempre 401.
    Sem `channel` (integrações e scripts), não há restrição.
- `POST /auth/refresh` `{refresh_token}` → `TokenResponse`. O canal vai gravado no refresh token: se o
  papel do usuário mudou e não é mais aceito no canal, responde **401** e o cliente faz logout.
- `GET /auth/me` → `UserOut`
- `POST /auth/change-password` `{current_password, new_password (min 8)}` → `TokenResponse` (200). Encerra as outras sessões do usuário (`sessions_revoked_at`) e devolve tokens novos para este aparelho. 422 com "Senha atual incorreta" ou "A nova senha precisa ser diferente da atual". `UserOut.must_change_password = true` (senha provisória): o app obriga a trocar antes de seguir.
- **Sessões encerradas:** tokens emitidos antes de `sessions_revoked_at` (troca/redefinição de senha, desativação) recebem **401** "Sessão encerrada" na API, no refresh e no WebSocket (fecha com 4401). Trate como logout.
- `GET /auth/providers` → `{microsoft, password_for_staff, microsoft_domains}` (tela de login).
- **Login Microsoft (Entra ID), só gestão:** o navegador abre `GET /auth/microsoft/start` (302 para a Microsoft, com PKCE). A volta `GET /auth/microsoft/callback` redireciona para `WEB_URL/login/microsoft#code=<código de uso único, 60 s>` ou `WEB_URL/login?sso_error=<not_registered|domain_not_allowed|wrong_tenant|role_not_allowed|inactive|account_mismatch|cancelled|invalid_state|invalid_token|provider_error>`. O site troca o código em `POST /auth/microsoft/exchange` `{code}` → `TokenResponse`. Com `ENTRA_ENFORCE_FOR_STAFF`, analistas e gestores do domínio recebem 403 no login com senha.

### Meta
- `GET /meta` → `{statuses:[{value,label,group,color,sla_paused,final,requires_assignee,description}], transitions:{status:[status]}, priorities:[{value,label,code,color}], priority_matrix:[{impact,urgency,priority}], ticket_types, sources, asset_types, roles, impacts, urgencies, access_channels:{web:[role], mobile:[role]}}` (`ticket_types`…`urgencies` como `[{value,label}]`)

### Usuários e grupos
- `GET /users?role=&team_id=&q=&active=` → `UserOut[]`
- `GET /users/assignable?team_id=` → `[{id,name,role,team_id,team_name,open_tickets}]` (analistas, técnicos e supervisores ativos, com carga)
- `POST /users` (admin) `UserCreate` → `UserOut`
- `GET /users/{id}` · `PATCH /users/{id}` (admin) `UserUpdate`
- `GET /teams` → `TeamOut[]` · `POST /teams` · `PATCH /teams/{id}` (admin/supervisor)

`UserOut = {id,name,email,phone,role,job_title,team_id,team:{id,name}|null,is_active,last_login_at,location_consent_at,must_change_password,created_at}`

### Clientes, locais e ativos
Modelo inspirado no Field Control: o eixo da operação é o **local** (filial com CNPJ próprio), não o cliente.

- `GET /customers?q=` → `CustomerOut[]` · `POST /customers` · `GET/PATCH /customers/{id}`. `q` busca por palavras em nome e CNPJ/CPF (ver "Busca por palavras")
  - `CustomerOut = {id, name, document, email, phone, notes, is_active, created_at, locations_count, open_tickets, total_tickets, last_ticket_at, tags, contacts, address_line, district, city, state, zip_code, latitude, longitude, logo_url, legacy}` (ficha completa: ver "Fichas completas")
- `GET /locations?q=&customer_id=&active=&page=&page_size=` → `Page<LocationOut>` (até 200 por página). `q` busca por palavras em nome, código, CNPJ (com ou sem pontuação), endereço, bairro, cidade e nome do cliente
- `GET /locations/{id}` · `PATCH /locations/{id}` · `GET/POST /customers/{id}/locations` (lista sem paginação, para um cliente;
  `GET ?order=tickets&limit=8`: as lojas com mais OS primeiro, contando só as OS que a pessoa vê, e o empate pelo nome;
  sem `order`, por nome)
  - `LocationOut = {id, customer_id, customer:{id,name}, name, code, document, address_line, district, city, state, zip_code, latitude, longitude, contact_name, contact_phone, notes, is_active, open_tickets, total_tickets, last_ticket_at, contacts, legacy}`
- **Métricas derivadas:** `open_tickets`, `total_tickets` e `last_ticket_at` são calculadas a partir das OS, no escopo que o usuário pode ver. Não são digitadas.
- **CPF/CNPJ** (`document`): aceita com ou sem pontuação e valida os dígitos verificadores, inclusive o **CNPJ alfanumérico** (Receita, jul/2026). Guardado sem pontuação e em maiúsculas. Inválido → 422.
- `GET /assets?customer_id=&location_id=&asset_type=&q=` → `AssetOut[]` · `POST /assets` · `GET/PATCH /assets/{id}`

### Catálogo e SLA
- `GET /categories` → `CategoryOut[]` (`{id,name,full_name,description,parent_id,default_team_id,default_team,is_active}`; `full_name` = "Impressoras > Atolamento de papel")
- `POST /categories` · `PATCH /categories/{id}` (admin/supervisor)
- `GET /sla-policies` → `[{priority,response_minutes,resolution_minutes}]`
- `PUT /sla-policies/{priority}` (admin) `{response_minutes, resolution_minutes}`

### Tipos de serviço (duração estimada × real)
Equivale ao "Tipo de OS" do Field Control. Sem `customer_id`, o tipo vale para todos os clientes; com ele, entra no catálogo daquele cliente.

- `GET /service-types?customer_id=&q=&active=` → `ServiceTypeOut[]`. Com `customer_id`, devolve os tipos gerais mais os daquele cliente (é o que a Nova OS usa).
  - `ServiceTypeOut = {id, name, description, estimated_minutes, customer_id, customer, category_id, is_active, observed_median_minutes, observed_count, suggested_minutes}`
- `POST /service-types` · `PATCH /service-types/{id}` (analista, supervisor, admin)
- `POST /service-types/{id}/apply-observed`: adota a mediana observada como nova estimativa (arredondada a 5 min). Dá 422 se não houver sugestão.
- **A estimativa aprende:** `observed_median_minutes` é a mediana do tempo em atendimento das OS concluídas do tipo. `suggested_minutes` aparece com 3 ou mais OS e quando a mediana fica 25% acima ou 20% abaixo da estimativa. Quem aplica é uma pessoa.

### OS / Chamados
- `GET /tickets` → `Page<TicketListItem> {items,total,page,page_size}`
  - filtros: `status` (repetível), `priority` (repetível), `type`, `source`, `project_id`, `assignee_id`, `team_id`, `customer_id`, `location_id`, `service_type_id`, `violation_pending=true`, `category_id`, `asset_id`, `owner_id`, `no_owner=true`, `q` (título, descrição, número), `mine=true` (analista: executa ou é o responsável), `unassigned=true`, `open_only=true`, `sla_breached=true`
  - lista de atividades (como no Field Control): `number` (nº exato da OS, o "Identificador"), `created_from`/`created_to` e
    `scheduled_from`/`scheduled_to`, `resolved_from`/`resolved_to` (resolvida nesses dias: houve a resolução no período, mesmo se reaberta depois, como os rankings dos relatórios) (AAAA-MM-DD, dias inteiros no fuso da operação, inclusive; OS sem agenda saem do filtro de
    agendamento; datas fora de 2000–2100 → 422), `tag` (repetível, até 20: OS com qualquer uma dessas etiquetas, sem
    diferenciar maiúsculas nem espaços sobrando), `technician_id` (técnico que atuou: o responsável atual, quem foi junto
    ou quem já foi o responsável antes de uma troca, inclusive no histórico importado do FC; `assignee_id` continua sendo só
    o atual)
  - `page` (1..), `page_size` (1..500, padrão 25), `order_by` ∈ `updated_at, created_at, priority, resolution_due_at, number, scheduled_start, customer` (nome do cliente) com `-` para desc (padrão `-updated_at`); vazios (sem agenda, sem cliente) por último nas duas direções
- `GET /tickets/export` (gestão) → `text/csv; charset=utf-8` com BOM, separado por `;`, `Content-Disposition: attachment;
  filename="chamados-AAAA-MM-DD.csv"` (dia de hoje no fuso da operação). Os mesmos filtros e o mesmo `order_by` da lista,
  mais `ids` (repetível, até 300: vão na URL; para mais, exporte pelos filtros) para exportar só as OS escolhidas; até
  20.000 linhas (as primeiras na ordem pedida).
  Colunas: `Identificador; Etiquetas; Data do agendamento; Cliente; Localização; Cidade; Situação; Técnico; Tipo de OS;
  Escopo; Analista; Criada em` (datas `dd/mm/aaaa HH:MM` no fuso da operação; Localização sem loja = endereço do
  atendimento; Cidade `cidade/UF`; Escopo = descrição, ou o título sem descrição). Célula que começa com `=`, `+`, `-`, `@`,
  tab ou retorno ganha um `'` na frente (a planilha não roda como fórmula).
- `POST /tickets/bulk-tags` `{ids: uuid[] (1..500), add: [{name, color}], remove: [nome]}` (gestão) → `{updated}`: inclui e tira
  etiquetas nas OS que a pessoa pode editar (ids desconhecidos ficam de fora; `updated` conta só as que mudaram). 422 sem
  nada para incluir ou tirar, com nome vazio ou com a mesma etiqueta nos dois lados. Cada OS alterada ganha um evento no
  histórico e um `ticket.updated` `{fields: ["tags"]}` só para a gestão.
- `POST /tickets` `TicketCreate` → `TicketDetail` (201). `tags: [{name, color}] | null` (até 20): sem informar (ou `null`),
  a OS nasce com as etiquetas automáticas da abertura (`on_project` com `project_id`, senão `on_create`); uma lista, mesmo
  vazia, vale como está (a web manda a que o analista vê, já preenchida pelas regras).
- `GET /tickets/{id}` → `TicketDetail`
- `PATCH /tickets/{id}` `TicketUpdate` → `TicketDetail`
- `POST /tickets/{id}/assign` `{assignee_id|null, team_id?, note?, expected_version?}` → `TicketDetail`
- `POST /tickets/{id}/take` → `TicketDetail` (atribui ao usuário logado); se a OS não tem analista responsável, ele passa a ser
- `POST /tickets/{id}/claim` → `TicketDetail` (puxa para a fila do usuário logado: vira o `owner`; o técnico não muda)
- `POST /tickets/{id}/transition` `{to_status, note?, resolution_notes?, scheduled_start?, scheduled_end?, latitude?, longitude?, expected_version?}` → `TicketDetail`
- `GET /tickets/{id}/comments` → `CommentOut[]` · `POST` `{body, is_internal}` → `CommentOut`
- `GET /tickets/{id}/events` → `EventOut[]` (histórico, mais recente primeiro)
- `GET /tickets/{id}/worklogs` → `WorklogOut[]` · `POST` `{description, started_at, ended_at?|minutes?, latitude?, longitude?}`
- `GET /tickets/{id}/attachments` → `AttachmentOut[]` · `POST` multipart `file` + `kind` (`file|photo|signature`)
  - O comprovante de um custo extra (`receipt_attachment_id`) é custo: a gestão sem Custos extras não o recebe na
    lista, e `PATCH|DELETE /attachments/{id}` dele respondem 404, como se não existisse.
  - `DELETE /attachments/{id}`: assinatura não sai (nem a de um atendimento anterior, 422); comprovante de custo
    reembolsado também não (422 "Comprovante de custo já reembolsado: volte o custo para Aprovado antes de
    excluir"); nos outros custos, o custo fica sem comprovante (`receipt_attachment_id: null`).
- `GET /attachments/{id}/download?token=` → arquivo (o `download_url` da listagem já vem assinado, expira em 15 min)

`TicketListItem = {id, number, code:"OS-000123", title, status, priority, type, source, category:{id,name,full_name}|null, customer:{id,name}|null, location:{id,name,code,document,address_line,city,state,latitude,longitude,contact_name,contact_phone}|null, assignee:{id,name,email,role}|null, team:{id,name}|null, requester_name, scheduled_start, scheduled_end, response_due_at, resolution_due_at, first_response_at, resolved_at, sla_paused_at, resolution_sla_met_at, sla_paused_seconds, created_at, updated_at, version, sla_status, tags:[{name,color}], service_type:{id,name,estimated_minutes}|null, description}`
(na lista, `description` é o começo do escopo, até 300 caracteres; `service_type` vem preenchido em `GET /tickets` e
pode vir null em outras listas; `resolution_sla_met_at`: o prazo de solução encerrado antes da conclusão, na OS
migrada em que o Field Control deu o prazo como cumprido; o relógio de solução para aí, ver `docs/STATUS_E_SLA.md`;
`work_started_at`: a entrada na loja da visita em curso, só em `in_progress`, null fora dela; o tempo na loja das
listas conta daí, e não da 1ª chegada, `arrived_at`)

`TicketDetail = TicketListItem + {description, impact, urgency, asset:{id,name,asset_type,brand,model,serial_number,asset_tag,ip_address}|null, requester:UserRef|null, requester_contact, service_address, service_type:{id,name,estimated_minutes}|null, estimated_minutes, work_seconds, work_started_at, actual_minutes, created_by:UserRef|null, closed_at, cancelled_at, reopen_count, resolution_notes, open_offers, allowed_transitions:[status], can_edit, can_assign}`
(`open_offers`: ofertas da OS esperando o técnico responder, pendentes e no prazo; toda a gestão recebe o número,
e o técnico recebe 0. Ver [Ofertas de OS](#ofertas-de-os-2026-11-18).)

`CommentOut = {id, ticket_id, author:UserRef|null, body, is_internal, created_at}`
`EventOut = {id, ticket_id, actor:UserRef|null, event_type, from_value, to_value, note, data, created_at}` — `event_type` ∈ `created, updated, status_changed, assigned, comment_added, worklog_added, attachment_added`
`WorklogOut = {id, ticket_id, user:UserRef|null, description, started_at, ended_at, minutes, latitude, longitude, created_at}`
`AttachmentOut = {id, ticket_id, filename, content_type, size_bytes, kind, uploaded_by, created_at, download_url}`

**Concorrência:** toda OS tem `version`. Envie `expected_version` em PATCH/assign/transition;
se outra pessoa (web ou app) alterou antes, a API responde **409** e o cliente recarrega.

### Motivos de violação de SLA
O "Motivo da violação" do Field Control: um campo por relógio, escolhido de um cadastro. Assim o motivo vira estatística em vez de texto solto.

- `GET /violation-reasons?active=` → `[{id, name, description, applies_to, responsibility, is_active}]`.
  - `applies_to` ∈ `response`, `resolution`, `both`.
  - `responsibility` ∈ `internal`, `customer`, `third_party`.
  - `POST` e `PATCH /violation-reasons/{id}`: supervisor e admin.
- Na OS:
  - os campos `response_violation_reason`, `resolution_violation_reason` (`{id, name, responsibility}`) e `violation_note`;
  - os calculados `response_breached`, `resolution_breached` e `violation_reason_pending` (resolvida ou fechada com prazo violado e sem o motivo correspondente).
- Para informar o motivo:
  - ao resolver: `POST /tickets/{id}/transition` com `response_violation_reason_id`, `resolution_violation_reason_id` e `violation_note`. O motivo precisa valer para aquele relógio; se não valer, a resposta é 422;
  - depois, inclusive com a OS fechada: `PATCH /tickets/{id}/violation` (analista ou supervisor; técnico só nas OS dele ou do grupo).
- O técnico pode resolver sem informar o motivo. A OS fica pendente, e `GET /tickets?violation_pending=true` lista as que faltam justificar.
- `GET /reports/sla-violations?days=30` → `{period_days, tickets_total, response, resolution, by_responsibility, pending_justification}`. A janela começa à 0h (fuso da operação) do dia de `days` atrás, o mesmo corte de `created_from` na lista de OS. Cada relógio vem como `{breached, justified, by_reason:[{reason_id, name, responsibility, count}]}`.

### Atividades do dia
Tela própria da operação, como no Field Control (aquela em que, segundo o levantamento, quem opera passa o dia).

- `GET /activities/day?date=YYYY-MM-DD&team_id=&assignee_id=` → `DayActivities {date, timezone, is_today, summary, activities[]}`. Sem `date`, usa o dia de hoje no fuso `TIMEZONE`. `date` fora de 2000–2100 → 422 "Escolha uma data entre 2000 e 2100" (o mesmo período de `/reports/daily`, `/my-queue` e `/tracking/history`).
  - Entram no dia: as OS agendadas para ele; as que tiveram deslocamento, atendimento ou conclusão nele (pelo histórico); e, se for hoje, as que estão em campo agora (há até 12 h, a regra de `services/field.py`).
  - `Activity = {ticket: TicketListItem, state, scheduled_start, scheduled_end, started_at, arrived_at, finished_at, start_delay_minutes, start_has_gps, service_type_name, estimated_minutes, actual_minutes}`: o previsto e o realizado na mesma linha.
  - `state` ∈ `scheduled` (agendada), `late` (30 min ou mais depois do horário, sem saída nem início: a tolerância do "Atrasada" da Minha fila e da Início), `en_route`, `in_progress`, `on_hold`, `rescheduled` (teve atividade no dia e foi remarcada), `done` (concluída no dia), `pending` (voltou para a fila; também a visita do dia que deu improdutiva no horário ou depois).
  - `summary` traz a contagem por `state` e `unassigned`. Hoje, `stuck_in_field` conta as OS a caminho ou em atendimento há mais de 12 h (dado parado): ficam fora da lista e dos outros números.
  - Ordem: pela hora de atuação, a manhã primeiro (a agendada ou, sem agenda, a de início; sem hora no fim),
    e só depois pelo técnico. A tela agrupa por técnico na ordem em que aparecem: quem começa mais cedo
    fica em cima e, dentro do bloco, as OS seguem o relógio.

### Dashboard
- `GET /dashboard/summary` → `{by_status:{status:n}, by_priority:{priority:n}, open_total, unassigned, sla_breached, sla_at_risk, created_today, resolved_today, avg_resolution_minutes_30d, sla_compliance_30d, by_assignee:[{user_id,name,open,in_progress,breached}]}`
  - `sla_compliance_30d`: das resolvidas em 30 dias com prazo de solução (sem as canceladas), a % em que o relógio de solução parou até o prazo (a conclusão ou, antes dela, `resolution_sla_met_at`).
  - `by_assignee[].in_progress`: em campo agora, há até 12 h (a parada há mais tempo não conta).

### Sincronização mobile
Ver `docs/MOBILE_SYNC.md`.
- `GET /sync/pull?since=<iso>` → `{server_time, tickets:TicketDetail[], comments, worklogs, revoked_ticket_ids}`
- `POST /sync/push` `{operations:[{client_op_id, type:"transition"|"comment"|"worklog"|"update"|"form_answers"|"unproductive"|"part_request", ticket_id, payload, client_timestamp?}]}` → `{server_time, results:[{client_op_id, status:"applied"|"duplicate"|"rejected"|"conflict", error?, ticket?}]}`
- `POST /devices` `{platform:"ios"|"android"|"web", token, app_version?}` · `DELETE /devices/{token}`

### Rastreamento do técnico (jornada e GPS)
Coleta só durante a jornada e só depois do aceite do termo (LGPD). Posições fora de uma jornada aberta
(tolerância de 2 min no relógio do aparelho) ou no futuro são descartadas; o mesmo `(técnico, recorded_at)`
não duplica (reenvio seguro do lote). Histórico apagado após `TRACKING_RETENTION_DAYS` (90).
- Técnico: `POST /tracking/consent` (204, grava `location_consent_at`) · `GET /tracking/shift` → `{shift|null}` ·
  `POST /tracking/shift/start {latitude?, longitude?}` (409 sem o aceite; idempotente) · `POST /tracking/shift/end` ·
  `POST /tracking/pings {pings:[{recorded_at, latitude, longitude, accuracy_m?, speed_mps?, heading?, battery_pct?, is_mock}]}` (1–500) → `{accepted, discarded}`
- Gestão: `GET /tracking/live?team_id=` → técnicos com `state` (`offline|no_signal|available|en_route|in_progress`),
  `on_shift`, `last_position` (null fora da jornada), `current_ticket` (com o local e coordenadas) e `open_tickets`.
  `current_ticket` e o estado `en_route|in_progress` só contam a OS em campo há até 12 h (a regra única de
  `services/field.py`): a parada há mais tempo não vira a OS atual (a Início a mostra como alerta).
  `no_signal` = em jornada sem posição há mais de 5 min. `GET /tracking/history?user_id=&date=` → pontos do dia e
  as mudanças de status que o técnico fez, com o GPS de cada uma (`date` fora de 2000–2100: 422).
- As transições de status aceitam `latitude`/`longitude` (check-in); o app deve mandar em deslocamento, atendimento e resolução.

### Calendário e conflito de horário (gestão)
- `GET /calendar?start=&end=&assignee_id=&assignee_id=&unassigned=&team_id=&customer_id=&location_id=&city=&status=` (até 62 dias)
  → `[{id, code, title, status, priority, start, end, end_is_estimated, assignee, team, customer, location{id,name,city}, service_type, conflict_with:[id]}]`.
  Sem fim, a visita dura a estimativa da OS (ou 1 h).
- `GET /calendar/conflicts?assignee_id=&start=&end=&estimated_minutes=&exclude_id=` → `[ConflictItem]` (prévia antes de salvar).
- Abrir, editar horário, atribuir e reagendar (transição com `scheduled_start`) feitos pela gestão respondem
  **409** `{detail, code: "SCHEDULE_CONFLICT", conflicts: [{id, code, title, customer, location, start, end}]}` quando o
  responsável já tem OS ativa sobreposta. Reenviar com `allow_conflict: true` confirma. A ação do técnico (sync offline) não é barrada.

### Homologação de técnicos
Público (sem login, pelo link): `GET /public/onboarding/catalog` (áreas, disponibilidade, níveis, sugestões de skill,
versão do aviso de privacidade) · `GET /public/onboarding/{token}` → `{valid, expires_at}` ·
`POST /public/onboarding/{token}` (ficha + `password` + `privacy_consent: true` + `photo` em data URL) → `{protocol}`;
410 se o link expirou, foi cancelado ou já usado; 422 com CPF/UF/e-mail inválido ou e-mail já cadastrado.
Gestão: `GET|POST /onboarding/invites` (`{label?, reusable, days_valid}`; o `token` só aparece na criação) ·
`DELETE /onboarding/invites/{id}` · `GET /onboarding/applications?status=` · `GET /onboarding/applications/pending-count` ·
`GET /onboarding/applications/{id}` (com `photo_url` assinado) · `POST .../{id}/approve {team_id?, job_title?}` → `UserOut`
(o técnico entra com o e-mail e a senha da ficha) · `POST .../{id}/reject {reason}`.

### Técnicos (gestão do acesso)
Analistas e gestores, e só sobre usuários técnicos: `GET /technicians?q=&team_id=&active=` (com jornada, OS abertas,
foto e o perfil da homologação; `q` busca por palavras em nome, e-mail e telefone; `on_shift` é a jornada aberta e
dentro do limite de 14 h, a mesma regra do mapa: a esquecida aberta não fica "em jornada") · `POST /technicians` →
`{technician, temporary_password}` · `PATCH /technicians/{id}` (nome, e-mail, telefone, grupo, cargo, `is_active`;
desativar encerra as sessões; e a ficha completa: endereço, jornada e serviços, ver "Fichas completas") ·
`POST /technicians/{id}/reset-password` → `{technician, temporary_password}` (encerra as sessões) ·
`POST|DELETE /technicians/{id}/photo` (JPG/PNG/WebP até 2 MB, tipo conferido pelo conteúdo) ·
`POST /technicians/import?dry_run=true|false` (CSV/XLSX: nome, email, telefone, grupo, cargo) →
`{rows:[{line, action: create|update|error, errors}], created, updated, errors, credentials}` (senhas provisórias só na gravação).

### Importação de locais
`POST /locations/import?dry_run=true|false&customer_id=` (CSV/XLSX) → `{rows, created, updated, errors, customers_created}`.
Colunas: cliente, cnpj_cliente, codigo, local, cnpj, endereco, bairro, cidade, uf, cep, latitude, longitude, contato,
telefone, observacoes. Cliente por CNPJ ou nome (criado se não existir, só para quem tem Clientes em Editar; sem
isso, a linha dá erro "Cliente não cadastrado: só quem edita Clientes cadastra cliente novo", na prévia e na
gravação); local por código, CNPJ ou nome (atualiza só o que veio preenchido). CSV em UTF-8 ou Windows-1252,
separado por `;` ou `,`; coordenadas com vírgula decimal.

## Tempo real (WebSocket)

`ws://localhost:8000/api/v1/ws?token=<access_token>`

Servidor envia ao conectar `{"type":"hello","user_id":"..."}` e depois um evento por mudança:

```json
{
  "type": "ticket.status_changed",
  "ticket_id": "uuid",
  "ticket_code": "OS-000042",
  "status": "in_progress",
  "priority": "high",
  "assignee_id": "uuid|null",
  "team_id": "uuid|null",
  "actor_id": "uuid",
  "actor_name": "Carlos Técnico",
  "version": 7,
  "occurred_at": "2026-11-11T19:00:00Z",
  "data": {"from": "assigned", "to": "in_progress"}
}
```

Tipos: `ticket.created`, `ticket.updated`, `ticket.assigned`, `ticket.status_changed`,
`ticket.comment_added`, `ticket.worklog_added`, `ticket.attachment_added`, `ticket.offer` (oferta de OS, só para os
técnicos dela: ver [Ofertas de OS](#ofertas-de-os-2026-11-18)).
Cada usuário só recebe eventos de OS que pode ver (o técnico, só das OS atribuídas a ele, inclusive a que
acabou de sair dele, e o `ticket.offer` das ofertas dele); notas internas não chegam ao solicitante.

Só para a gestão (analistas, supervisores, admin): `technician.location` `{user_id, name, latitude, longitude, recorded_at,
accuracy_m, speed_mps, heading, battery_pct, is_mock}` (o ponto mais novo do lote, inteiro: o que não veio do app vai null),
`technician.shift` `{user_id, name, on_shift}` (esses dois só com o Mapa ao vivo) e `onboarding.submitted` `{application_id, name}`
(ficha nova na homologação).
O cliente pode mandar `{"type":"ping"}` e recebe `{"type":"pong"}`.
Ao receber um evento, recarregue a OS/lista (o evento não carrega o objeto inteiro).

## Duração da OS

- `estimated_minutes`: copiada do tipo de serviço na abertura (ou informada) e gravada na OS. Corrigir o catálogo depois não muda as OS antigas.
- `work_seconds` / `work_started_at`: a API soma o tempo em `in_progress` a cada mudança de status. O técnico não digita nada.
- `actual_minutes`: duração real, calculada na leitura e incluindo o atendimento em andamento.
- Ao agendar (`scheduled`) só com `scheduled_start`, a API preenche `scheduled_end = início + estimated_minutes`.

## Módulos de operação (2026-11)

Todos exigem analista ou gestor, salvo indicação. Valores em R$ chegam como número.

- **Formulários:** `GET|POST /form-templates`, `GET|PUT /form-templates/{id}` (o PUT aceita `base_updated_at`, o `updated_at` de onde a tela partiu: se outra pessoa salvou depois, 409), `GET /form-templates/catalog`.
  Na OS: `GET /tickets/{id}/forms/suggestions` · `POST /tickets/{id}/forms {template_id, required}` ·
  `PATCH|DELETE /tickets/{id}/forms/{form_id}` · `PUT /tickets/{id}/forms/{form_id}/answers {answers, complete}`
  (técnico responsável ou gestão; respostas gravadas mesmo quando a conclusão falha) ·
  `POST|DELETE /tickets/{id}/forms/{form_id}/photos[/{attachment_id}]` (multipart `file` + `field_id`) ·
  `POST /tickets/{id}/signature` (multipart `file`, `signer_name`, `signer_role?`, `latitude?`, `longitude?`).
  `TicketDetail.forms`, `signature_required`, `signer_*`, `signed_at`. Concluir a OS (resolved/closed) devolve 422 sem os
  obrigatórios ou sem a assinatura exigida. Sync offline: operação `form_answers {form_id, answers, complete}`.
- **Custos extras:** `GET|POST /tickets/{id}/expenses` (técnico só lê; solicitante recebe vazio) · `PATCH|DELETE /expenses/{id}` ·
  `GET /expenses?start&end&technician_id&status&customer_id` (relatório) · `POST /expenses/mark-paid {ids}` → `{updated}`
  (marca como reembolsados só os aprovados; os demais ids são ignorados, sem erro, e não entram em `updated`) ·
  `GET|PUT /settings/expenses {km_rate}` (PUT: supervisor/admin). `TicketDetail.expenses`. Lançar um custo inclui na OS as
  etiquetas `on_extra_cost` que ela ainda não tem (ex.: "Custo Extra"; ver "Etiquetas automáticas"). No `POST`,
  `technician_id` (a quem reembolsar): sem o campo, o técnico responsável pela OS; `null`, custo da empresa (não entra
  no reembolso de ninguém).
- **Visita improdutiva:** `GET|POST|PATCH /unproductive-reasons` · `POST /tickets/{id}/unproductive {reason_id, note?, latitude?, longitude?, expected_version?}`
  (técnico responsável ou gestão) → a OS volta para `assigned` sem agenda; `unproductive_count`. Sync: operação `unproductive`.
- **Orçamentos:** `GET|POST /quote-items` e `PUT /quote-items/{id}` (catálogo, com `kind`) · `GET|POST /tickets/{id}/quotes` ·
  `PUT /quotes/{id}` · `POST /quotes/{id}/send` · `POST /quotes/{id}/link/rotate` → `{token, path, url}` ·
  `POST /quotes/{id}/cancel` · `GET /quotes?status&start&end`.
  - Itens: `{description, quantity, unit (medida), unit_price, catalog_item_id?, kind}` com `kind` = `product` (padrão),
    `service` ou `expense`. `QuoteOut.totals_by_kind {product, service, expense}` soma os itens por tipo.
  - **Link do cliente persistente:** `QuoteOut.link {token, path: "/orcamento/{token}", url}` existe a partir do primeiro envio
    (só a gestão vê) e pode ser copiado a qualquer momento. Token `<id>.<HMAC>` (só o id fica no banco). Reenviar e editar
    mantêm o mesmo link; editar volta o orçamento a rascunho (o cliente vê o conteúdo atual "em revisão" e responde depois do
    novo envio). Só `link/rotate` (troca; o anterior para de abrir) e `cancel` (tira do ar) mudam o link. Links antigos (só
    hash, enviados antes desta versão) seguem abrindo até a troca. `send` ainda devolve `token` (= `link.token`).
  - Público (sem login): `GET /public/quotes/{token}` → `PublicQuote` com, além do que já havia, `company` (dados da empresa),
    `customer_info {name, document, email, phone}`, `address {line, district, city, state, zip_code, full}` (endereço do
    atendimento da OS ou o do local), `ticket_number`, `issued_at`, `totals_by_kind`, `approver_registration`,
    `client_comment` e `signature_url` (absoluta, 24 h, só aprovado). `status` pode ser `draft` (em revisão: abre, não aceita
    resposta).
  - `POST /public/quotes/{token}/approve {name, registration? (matrícula), comment?, signature (data URL), accept: true}`
    (`document`/`role` seguem aceitos) · `POST /public/quotes/{token}/reject {name?, reason, comment?}`. 410 para link
    inexistente, trocado ou cancelado; 409 com o motivo quando não aceita resposta (respondido, vencido ou em revisão).
    Evento WS `quote.decided` (gestão).
- **Dados da empresa:** `GET /settings/company` (gestão) · `PUT /settings/company` (supervisor/admin)
  `{name, document?, email?, phone?, address?, website?}`. Vão no cabeçalho do orçamento e do relatório do cliente
  (`PublicQuote.company`, `PublicReport.company`; `PublicReport.company_name` = nome do cadastro).
- **Projetos:** `GET|POST /projects`, `GET|PUT /projects/{id}` (com `stats` e `margin`). OS: `project_id` em criar/editar (gestão)
  e filtro `GET /tickets?project_id=`; `TicketListItem.project`.
- **Assistência externa:** `GET /repairs?status&customer_id&q&open_only` · `GET /repairs/summary` · `POST /repairs` ·
  `GET|PUT /repairs/{id}` · `POST /repairs/{id}/status {to_status, note?, vendor_quote_value?, expected_return_date?}` ·
  `POST /repairs/{id}/photos`. Etapas: withdrawn → received → sent_to_vendor → vendor_quote → in_repair → ready_at_vendor →
  back_in_stock → delivered (e unrepairable/cancelled). No `PUT`, `vendor_quote_value` e `expected_return_date` (que a
  etapa também grava) só mudam quando vêm no corpo; os outros campos são o cadastro inteiro.
- **Relatórios:** `GET /reports/daily?date=` (sem data: o dia anterior, já fechado) · `GET /reports/monthly?month=AAAA-MM`.
- **Sugestão de técnicos:** `GET /tickets/{id}/technician-suggestions` · `GET /technicians/suggest?city&state&latitude&longitude`
  → `[{id, name, home_city, home_state, open_tickets, on_shift, distance_km, score, reasons[]}]`.
- **Textos do WhatsApp:** `GET /tickets/{id}/messages` → `[{key, name, text, suggested}]` já preenchidos com os dados da OS ·
  `GET /message-templates` → `{templates: [{key, name, body}], variables: [{key, description}]}` ·
  `PUT /message-templates {templates}` · `POST /message-templates/reset`. Variáveis desconhecidas ficam como estão;
  `{chegada_prevista}` usa a última posição do técnico na jornada (até 30 min) e cai para o horário agendado.
  Modelos padrão, para o grupo do cliente e nesta ordem: `agendamento` "Atividade confirmada", `deslocamento` "Técnico em
  deslocamento", `chegada` "Técnico chegou", `atraso` "Atraso na chegada", `fechamento` "Atividade encerrada" (termina com
  "Relatório do atendimento: {link_relatorio}"; o técnico vai numa linha própria, "Técnico: {tecnico}.") e `improdutiva`
  "Visita improdutiva". Modelos já gravados pela gestão ficam como estão. `suggested` marca no máximo um texto, o da
  situação da OS: em deslocamento → `deslocamento` (`atraso` quando a chegada já está atrasada; sem esse modelo, o de
  deslocamento); em atendimento → `chegada`; resolvida ou fechada → `fechamento`; última visita improdutiva e a OS ainda
  sem agenda → `improdutiva`; antes de sair para o local (nova, em triagem, atribuída, agendada, reaberta) com técnico e
  agenda em dia → `agendamento`; cancelada ou nada que combine → nenhum.
  - Atraso: na primeira ida, o prazo de chegada vencido (`arrival_due_at`). Na revisita (depois da primeira chegada) e na
    OS reaberta esse prazo não vale mais (não muda depois da chegada): conta a visita marcada para esta ida, com a mesma
    tolerância de 30 min. Visita marcada para esta ida = agenda depois da última saída de "Em atendimento" (concluída,
    pausada, improdutiva) e da última reabertura.
  - Agenda em dia (para `agendamento`): do dia de hoje em diante (fuso da operação) e marcada para esta ida. A OS
    reaberta guarda a agenda da visita anterior: sem remarcar, nenhum texto vem marcado.
  - Dado que falta: nos modelos padrão (mesmo gravados pela gestão sem mudar o texto) a frase com `{chegada_prevista}` sem
    previsão ou com `{tecnico}`/`{equipe}` sem técnico sai inteira (ex.: "O técnico X está a caminho de Loja 27." sem
    "Chegada prevista às __:__."). Nos modelos escritos pela gestão a marca (`__:__`, "(técnico a definir)") fica.
  Variáveis novas: `{hora_chegada}` (início do atendimento; antes disso, a hora atual) e `{hora_conclusao}`.
- **Puxar OS do colega:** `GET /tickets?owner_id=` (fila de outro analista) + `POST /tickets/{id}/claim` (vira o responsável; ver abaixo).

## Fila do analista e relatório do cliente

**Analista responsável (`owner`).** Separado de quem executa (`assignee`, técnico em campo ou analista no
remoto): é a fila em que a OS aparece até o fim. `TicketListItem.owner: UserRef | null` (e no detalhe).
Quem abre pela gestão vira o responsável (ou escolha `owner_id` em `POST /tickets`); OS aberta pelo
solicitante fica sem analista. `PATCH /tickets/{id} {owner_id|null}` transfere ou tira da fila (só gestão;
o destino precisa ser analista/supervisor/admin ativo, senão 422 "Escolha um analista ou gestor").
`POST /tickets/{id}/claim` puxa para a minha fila (422 se já é minha ou se a OS não está em aberto).
Assumir (`/take`) ou iniciar uma OS sem analista também coloca na fila de quem assumiu. Cada troca gera o
evento interno `owner_changed` (`data: {from_name, to_name}`, `note` ex.: "Bruno puxou a OS de Carla").

**Minha fila.** `GET /my-queue?user_id=&date=AAAA-MM-DD` (gestão; sem `user_id`, a minha; sem `date`, hoje no
fuso `TIMEZONE`; `date` fora de 2000–2100: 422) → `{user, date, generated_at, counts, items, total, truncated, executing_only}`. Entram as OS
em aberto em que a pessoa é responsável ou executa, mais as resolvidas no dia (`resolved_at` no dia: o
fechamento automático, dias depois, não conta de novo). A lista vai até 500 itens, primeiro as em aberto de
prazo mais apertado; `total` é o tamanho de verdade e `truncated` avisa do corte. Cada item é um
`TicketListItem` com:
- `section`: `in_field` (em deslocamento/atendimento há até 12 h; parada há mais tempo, vai para `attention`)
  → `done` (resolvida no dia) → `attention` (algum motivo `danger`/`warning`) → `today` (agendada no dia) →
  `waiting` (aguardando cliente/fornecedor) → `upcoming` (agendada depois) → `unscheduled`. Os itens vêm nessa
  ordem de tela: attention (pior primeiro, depois prazo), in_field (mais recente), today/upcoming (horário),
  waiting/unscheduled (prazo), done.
- `reasons: [{code, label, tone}]`: `sla_violated` (danger), `sla_at_risk` (warning), `late_start` (danger,
  agendada que passou 30 min do horário sem sair, a tolerância da Início e do prazo de chegada; não vale com
  visita improdutiva no horário ou depois), `no_technician` (warning, sem técnico de campo),
  `inactive_technician` (warning, "Técnico sem acesso: libere ou troque": técnico inativo no cadastro, sem
  acesso ao app), `unproductive` (warning, improdutiva sem nova agenda, fora de campo; enquanto espera a data
  nova, sem os motivos de chegada), `violation_pending` (info, concluída
  com SLA a justificar), `field_stuck` (danger, "Em campo há 13 h: conclua ou corrija", em dias a partir de
  24 h; dado parado, a regra de `services/field.py`) e as regras de campo (ver abaixo): `arrival_late`,
  `arrival_at_risk`, `onsite_over`, `onsite_warning`, `checkin_far` (warning, check-in a mais de 1 km da
  loja) e `part_request`. Uma OS em campo continua em `in_field`, mas com os motivos; com `field_stuck`, os
  relógios da visita (`arrival_*` e `onsite_*`) saem.
- `counts`: só as OS de que a pessoa é a responsável, sem o limite da lista (a mesma conta da linha dela em
  `GET /queues`): `open` (em aberto), `attention` (seção "atenção" mais as em campo com motivo
  `danger`/`warning`), `today` (em aberto agendadas para o dia), `in_field` (em campo há até 12 h), `done`
  (resolvidas no dia) e `waiting`, `upcoming` e `unscheduled` (o tamanho dessas seções).
- `executing_only`: em aberto em que a pessoa só executa (o responsável é outro ou ninguém): estão na lista,
  fora de `counts`.

`GET /queues` (gestão) → `{queues: [{user, role, open, attention, today, in_field}], unowned, scope, total}`: a
fila de cada analista/gestor ativo e as OS sem analista, com a mesma conta de `counts` da Minha fila
(`services/queues.queue_counts`). `attention` conta a seção "atenção" e também as OS em campo com motivo
`danger`/`warning` (ex.: passou do tempo na loja); a parada em campo há mais de 12 h conta em `attention`, não
em `in_field`.

**Relatório para o cliente.** Como no Field Control, toda OS tem o link público do relatório desde a
abertura (as OS antigas ganharam o link na migração `d5f1a7c3e9b2`). Antes de concluir, a página mostra o
andamento (agendada, técnico a caminho, em atendimento, reaberta); concluída, o resumo do atendimento,
que o cliente pode salvar em PDF. O token é `<id>.<assinatura HMAC>`: só o id fica no banco, então o
link pode ser copiado de novo a qualquer momento e trocado quando preciso.
- `TicketDetail.report_link` (a gestão sempre; o técnico responsável só com a OS concluída, para enviar
  pelo app): `{token, path: "/relatorio/<token>", url, created_at, views, last_viewed_at}` ou `null`
  (link desativado).
- `POST /tickets/{id}/report-link` (a gestão em qualquer status, e cria um link novo se o anterior foi desativado;
  o técnico responsável só com a OS concluída, senão 422 "Disponível quando a OS for concluída", e só pega o link
  que existe: desativado pela central, 422 "O link do relatório foi desativado pela central. Fale com a central no grupo."; outro técnico, 403) ·
  `POST /tickets/{id}/report-link/rotate` (gestão; novo link, o anterior para de funcionar) ·
  `DELETE /tickets/{id}/report-link` (gestão; 204). Nenhum dos três muda a `version` da OS. O link nasce na
  abertura e na conclusão (`resolved`) quando não há um; o fechamento (inclusive o automático) não recria o link
  desativado.
- Na web, o botão "Link do relatório da atividade" (rodapé da OS) compartilha por e-mail, WhatsApp, copia
  o link, abre o relatório, baixa o PDF e gerencia o link (trocar ou desativar).
- Público, sem login: `GET /public/reports/{token}` → `PublicReport {code, title, description, status,
  status_label, company_name, company {name, document, email, phone, address, website}, customer {name, document}, location {name, code, address, city, state},
  service_address, requester_name, service_type, technician {name}, opened_at, scheduled_start,
  scheduled_end, en_route_at, arrived_at, finished_at, closed_at, on_site_minutes, check_in_gps,
  resolution_notes, forms [{name, completed_at, items [{label, type, value, photos [{url, filename}]}]}],
  photos [{url, filename, taken_at}], signature {name, role, signed_at, image_url}, timeline [{at, label}],
  generated_at}`. Respostas formatadas (Sim/Não, dd/mm/aaaa, vírgula decimal); `type: "section"` é título.
  Fotos com URL absoluta assinada (24 h; base `API_PUBLIC_URL` ou o endereço da requisição). 404 "Link
  inválido ou expirado" (token adulterado, trocado ou revogado). Vale em qualquer status: a OS reaberta
  aparece como "reaberta" até ser concluída de novo. `resolution_notes` e `signature` só com a OS concluída
  (como no portal): a nota adiantada pela central numa OS aberta e o resultado anterior de uma OS reaberta não
  saem. Cada visita soma em `views` sem mexer na OS. Nunca inclui acompanhamentos, apontamentos, custos, orçamentos,
  notas internas nem motivos de violação.
- Textos do WhatsApp: variável `{link_relatorio}` (toda OS tem link: antes de concluir, a página mostra o
  andamento), já no texto padrão "Atividade encerrada". Link desativado pela gestão: o texto sai sem a linha do
  link e não cria outro sozinho (um novo sai pelo menu "Link do relatório da atividade"). `{analista}` agora é o
  responsável pela OS.
- Configuração: `COMPANY_NAME` (nome no relatório, padrão "Maxx Field") e `API_PUBLIC_URL` (opcional).

## Regras de campo, horário do técnico e pedido de peça

O que a Maxx Field promete ao varejo, no sistema:
- técnico na loja em até 4h nas capitais;
- até 4h de técnico na loja por chamado, contadas da chegada;
- peça só com orçamento aprovado e assinado.

**Horário: só a central mexe (2026-11-12).** O técnico nunca altera horário: no app ele só sai
(`en_route`), inicia o atendimento (`in_progress`, a chegada) e conclui (`resolved`)
(`workflow.TECHNICIAN_TARGETS`, espelhado em `lib/workflow.ts`). Agendar, reagendar, pausar
(`on_hold_*`), devolver e cancelar são da gestão (403 para o técnico). O tempo dele é automático: corre
do início do atendimento até a conclusão (`work_seconds`). Mudança de status do técnico com
`scheduled_start`/`scheduled_end` volta 403; `PATCH /tickets/{id}` e apontamento de horas
(`POST /tickets/{id}/worklogs` e a operação `worklog` do sync) também são só da gestão. `can_edit` é só
da gestão; o técnico responsável trabalha na OS (formulários, fotos, assinatura) por `can_work`.

**Editar a OS (gestão), a qualquer momento.** `can_edit` e `can_assign` valem para a gestão mesmo com a OS
concluída, fechada ou cancelada (como no Field Control): `PATCH /tickets/{id}` troca cliente, loja, escopo,
agenda, analista, projeto, outros técnicos, `resolution_notes` (descrição da conclusão) e `tags`
(`[{name, color}]`, até 20, sem repetir); `POST /tickets/{id}/assign` troca o técnico. Editar não muda o status.
Com `tags_base` (os nomes das etiquetas que o editor carregou, até 40), `tags` vale como diferença sobre as etiquetas de
agora: o que o analista incluiu entra, o que tirou sai e o que mudou nesse meio-tempo sem mexer na `version` (custo
extra, técnico pago, etiquetas em lote) fica. Sem `tags_base`, `tags` substitui a lista inteira.
**Reabrir** uma OS fechada ou cancelada: `POST /tickets/{id}/transition` `{to_status: "reopened", note}`, só a
gestão e com motivo (técnico 403; sem motivo 422). Limpa `resolved_at`, `closed_at`, `cancelled_at`,
`resolution_sla_met_at` e a assinatura (`signed_at`, `signer_name`, `signer_role`, `signature_attachment_id`; o
anexo e o evento da assinatura ficam no histórico), soma 1 em `reopen_count` e a OS volta ao fluxo; o prazo de SLA
continua o original. Com a assinatura exigida, a nova conclusão pede outra (o técnico volta a mexer nos
formulários); reaberta por engano, conclua com assinatura nova ou torne o formulário opcional.
`GET /ticket-tags` (gestão) lista as etiquetas já usadas, as mais usadas primeiro. Na web a OS abre no formato
do "Editar atividade" do Field Control (abas Geral, Prazos, Localização, Vínculos, Orçamentos, Peças e custos,
Formulários, Anexos, Acompanhamentos e Histórico), na página e por cima das listas; a aba Geral traz os 5
técnicos mais indicados para a loja.

**Etiquetas automáticas (como no Field Control).** `GET /ticket-tag-rules` (gestão) → `{on_create, on_project,
on_extra_cost, remove_on_payout_paid}`, com `on_*: [{name, color}]` e `remove_on_payout_paid: [nome]`. `PUT` com o mesmo
corpo, só supervisor e admin (analista 403): nomes de 1 a 40 caracteres (espaços sobrando saem), sem repetir na mesma
lista (maiúsculas não contam), até 10 por lista; `color` null ou uma das cores do Field Control (`green, pink, yellow,
indigo, purple, field-pale, light-blue, brown, red, blue-grey, blue, teal, orange, grey`). Gravado em `system_settings`
(`tickets.tag_rules`). Padrão: abertura "Pendente Envio PGTO" (field-pale) + "Ticket Avulso" (green); OS de projeto
"Projeto" (purple); custo extra "Custo Extra" (yellow); técnico pago tira "Pendente Envio PGTO". Regras: a OS nova recebe
`on_project` (com projeto) ou `on_create`, a menos que `POST /tickets` traga `tags`; lançar um custo extra inclui as
`on_extra_cost` que faltam; quando todos os valores dos técnicos da OS ficam pagos (`POST /payouts/pay`), saem as
`remove_on_payout_paid` (na OS cancelada o valor ainda pendente conta como cancelado, como na lista de pagamentos: a etiqueta sai quando a
central paga o que vai pagar, ex.: o deslocamento de um dos técnicos). Nada mais mexe nas etiquetas sozinho (as OS migradas só mudam por estes eventos). O nome se
compara sem maiúsculas e a grafia e a cor que a OS já tem ficam. Cada mudança automática (e a em lote) vira um evento
`updated` no histórico (`data: {changes: {tags: [antes, depois]}, added, removed}` e um `note` como "Custo extra lançado.
Incluída: Custo Extra"); muda o `updated_at` e não a `version` da OS (o app do técnico não entra em conflito por etiqueta,
que ele nem vê).

**Correção dos horários reais (gestão).** `PUT /tickets/{id}/times`
`{en_route_at?, arrived_at?, resolved_at?, work_minutes?, reason, expected_version?}` → `TicketDetail`
(403 para técnico e solicitante). Para quando o técnico esqueceu de iniciar ou concluir no app. Só os
campos informados mudam: a saída move o último deslocamento antes da chegada; o início move a chegada
(`arrived_at`, o primeiro "Em atendimento") e recalcula o limite na loja; o término move a conclusão
(`resolved_at`, o último "Resolvido"). O histórico de status acompanha (Atividades do dia e o relatório
do cliente leem dele). `work_minutes` é o tempo de atendimento (menor que o intervalo quando houve
pausa); sem ele, ao mexer no início ou no término, vale o intervalo. Valida: só horários que existem,
saída ≤ início ≤ término, nada no futuro nem antes da abertura; com o atendimento correndo, só o início.
O motivo e os valores antigos ficam no evento `times_corrected` (interno). Na web: "Corrigir horários"
na OS (perto do relógio de chegada) e o botão de relógio em Atividades do dia.

**Autorização do cliente: retirada (2026-11-12).** A central combina a visita com o cliente; o técnico
não espera registro nenhum. Saíram `POST /tickets/{id}/authorization`, o objeto `authorization` da
abertura, os campos `authorization_status` e `authorized_*` da OS, a regra `require_authorization` (valor
antigo guardado é ignorado), o motivo "Aguardando autorização" da fila, a variável `{autorizado_por}` e o
push "Visita autorizada". As colunas ficaram no banco como histórico; a migração `c3f8a1d6e4b2` passou
as OS pendentes ou recusadas para `not_required`.

**Regras (Configurações).** `GET /settings/field` (qualquer usuário logado; o app do técnico usa nos avisos)
e `PUT /settings/field` (supervisor/admin):
`{arrival_hours_capital: 4, arrival_hours_interior: 24, onsite_hours: 4, onsite_warning_minutes: 30}`. `null` no prazo de chegada = sem prazo. Capital ou interior vem da cidade/UF
do local (as 27 capitais, sem acento); OS sem local conta como interior.

**Os dois relógios.** Campos de `TicketListItem` (listas, detalhe, fila e app):
- `arrival_due_at`: prazo de chegada.
  - Conta da abertura (nas OS antigas com autorização registrada, da autorização).
  - Recalculado ao trocar o local antes da chegada.
- `arrived_at`: a primeira vez "Em atendimento".
- `onsite_due_at`: chegada + `onsite_hours`.
- `arrival_status`: `met` | `late` | `at_risk` (falta menos de 1h) | `pending` | `null` (sem prazo, OS
  concluída/cancelada sem visita, ou OS esperando data nova depois da improdutiva: a última visita deu
  improdutiva e nenhuma outra foi marcada depois dela, `services/field.awaiting_new_visit`; o técnico foi e
  não há chegada a cobrar. Com a visita nova marcada, o prazo volta a valer).
- Esperando data nova, a OS também fica sem "Chegada atrasada" e "Chegada em risco" na Minha fila e sem o
  grupo `late_arrival` ("Chegada atrasada") da Início; o motivo é o `unproductive` ("Improdutiva:
  reagendar"), que não aparece com a OS em campo.
- `onsite_status`: `ok` | `warning` (dentro de `onsite_warning_minutes` do limite) | `over` | `null`.
  - Ao vivo em "Em atendimento".
  - Numa OS concluída, compara a conclusão com o limite.

**Pedido de peça (técnico).**
- `POST /tickets/{id}/part-requests` (técnico da OS ou gestão)
  `{description, quantity=1, unit="un", note?, attachment_ids?, client_id?}` → 201.
  - As fotos precisam ser anexos desta OS (422 se não forem).
  - Com `client_id` repetido, devolve o pedido existente, sem duplicar.
- `GET /tickets/{id}/part-requests` (equipe que vê a OS).
- `PATCH /part-requests/{id}` (gestão) `{status?, quote_id?, response_note?}`.
  - Ligar um orçamento desta OS muda o pedido aberto para `quoted`, ou para `approved`/`rejected` se o
    orçamento já foi decidido.
  - Orçamento de outra OS → 422.
- Formato:
  `PartRequestOut {id, ticket_id, description, quantity, unit, note, status (open|quoted|approved|rejected|cancelled), quote_id, quote_code, requested_by: Ref, attachment_ids, attachments: [{id, url}], response_note, created_at, updated_at}`.
  - `url` é o link assinado de download para quem pediu.
- `TicketDetail.part_requests` traz a mesma lista (vazia para o solicitante).
- Quando o cliente aprova ou recusa pelo link o orçamento ligado, o pedido fica `approved`/`rejected` e o
  técnico recebe push.
- Eventos internos: `part_requested`, `part_request_updated`. Tempo real:
  - `part_request.created` (só gestão: `ticket_id`, `ticket_code`, `data {description, quantity, unit, status}`);
  - `ticket.part_request_decided` (técnico e gestão);
  - `ticket.authorization` (técnico e gestão).
- Sync offline: operação `part_request {description, quantity?, unit?, note?, attachment_ids?, client_id?}`.

**Reincidência.**
- `TicketListItem.recurrence_30d`: outras OS no mesmo local nos últimos 30 dias, preenchido em
  `GET /tickets` e em `/my-queue`.
- `TicketDetail.recurrence` (equipe) `{count_30d, previous: [{id, number, code, title, status, created_at}]}`:
  até 5, da mais recente.

**Relatórios e relatório do cliente.**
- `DayNumbers` (diário e mensal) ganhou:
  - `arrivals` (chegadas no período), `arrivals_on_time`;
  - `arrival_on_time_pct`: sobre as chegadas com prazo; `null` sem chegadas;
  - `avg_arrival_minutes`: do início do relógio até a chegada;
  - `avg_onsite_minutes`: tempo em atendimento das OS resolvidas.
- `PublicReport` ganhou `arrival_due_at`, `arrival_minutes` e `arrival_on_time`.

**Textos do WhatsApp.**
- Novas variáveis:
  - `{prazo_chegada}`: HH:MM no fuso da operação, ou "(sem prazo)".
- O texto padrão de deslocamento termina em "Chegada prevista às {chegada_prevista}." (frase que sai sem previsão; ver
  "Textos do WhatsApp" acima).

## Migração do Field Control

Importação única (e repetível sem duplicar) do export do Field Control: o JSON de cada entidade,
como vem da API GraphQL dele. O export tem dados pessoais e **nunca** entra no repositório: a
pasta fica fora dele e é copiada só para o container na hora de rodar.

```
python -m app.importers.fieldcontrol /tmp/fc_export --dry-run
python -m app.importers.fieldcontrol /tmp/fc_export --wipe-demo --report /tmp/fc_report.json
```

- `--dry-run`: tudo numa transação desfeita no fim (mostra as contagens).
- `--wipe-demo`: apaga antes os dados de demonstração. Saem OS e tudo que pende delas, orçamentos, projetos, assistência externa, homologação, clientes, locais, tipos de serviço, formulários, catálogo de preços e usuários que não são admin. Ficam equipes, categorias e configurações.
- `--stale-days 120`: OS em aberto sem atividade há mais tempo entram canceladas, com a nota "Encerrada na migração: sem atividade desde dd/mm/aaaa" em `legacy.migration_note`.
- `--report`: relatório em JSON (contagens por entidade, itens pulados e motivo, tempos), sem dados pessoais.

**Mapeamento.**
- Usuários do escritório: admin/dono vira gestor (`supervisor`), o resto vira analista. Colaboradores viram técnicos (ativos ou inativos como no Field Control), com cidade/UF de moradia. O mesmo e-mail é uma pessoa só. Ninguém entra com senha antes de uma redefinição; a gestão também entra com a Microsoft.
- Clientes: CNPJ só com dígitos (repetido fica vazio e vai para as observações), e-mail/telefone principal e etiquetas (`tags`).
- Locais: o código sai do nome ("43 - Barra Salvador" vira código 43). Também vêm CNPJ, endereço, UF, CEP, coordenadas, contato e observações.
- Tipos de serviço (com a duração) e catálogo de preços. Os produtos entram como produto; os serviços com preço que aparecem nos orçamentos entram como serviço.
- Modelos de formulário: foto/assinatura viram fotos, número, escolha (até 30 opções, senão texto) e texto longo/curto.
- Motivos de violação (SLA e prazo) entram juntos, pelo nome.
- OS:
  - o número do Field Control é mantido; identificador não numérico ganha o próximo número livre, e a sequência continua depois do maior;
  - a situação sai das atividades (a última concluída fecha a OS; cancelada, improdutiva, agendada etc.);
  - responsável e agenda vêm da última atividade, e o analista responsável é quem abriu;
  - prazos de resposta/solução e motivos, tempo em atendimento e chegada;
  - etiquetas, assinatura (anexo externo) e solicitação do portal (`source = portal`, mensagem e anexos);
  - `legacy`: valores, itens, arquivos e situação dos prazos no Field Control.
- Histórico:
  - cada atividade concluída vira apontamento e eventos (em atendimento, resolvida);
  - improdutivas viram `unproductive_visit`; canceladas viram evento de status;
  - comentários entram como notas internas;
  - formulários respondidos entram com as respostas, e as fotos como anexos externos ligados ao campo.
- Orçamentos: só os que têm OS. Mantêm itens (produto/serviço, medida), desconto, total, validade, situação, quem aprovou, comentário e assinatura (em `legacy.signature_url`). O código antigo fica em `legacy.identifier`.

**API.**
- `TicketListItem.tags` e `CustomerOut.tags`: `[{name, color}]`.
- `TicketDetail.legacy`, só para a equipe: `{source, identifier, fc_status, values {products, services, expenses, total}, items [{type, name, quantity, value, total}], request {subject, message, contact_email, contact_phone, created_at} | null, files [{url, title, type}], deadline {response_status, solution_status} | null, migration_note}`.
- `TicketSource` ganhou `portal`.
- Anexos: `TicketAttachment.external_url` (arquivo que continua no armazenamento do Field Control) e `storage_key` opcional.
  - A lista de anexos devolve o link de origem em `download_url`.
  - O link interno `/attachments/{id}/download` redireciona (307) para ele.
  - O relatório público usa o link de origem nas fotos e na assinatura.
- Orçamento migrado: `signature_url` cai para `legacy.signature_url` (também no link público).
- `legacy_refs (source, kind, external_id → internal_id)` guarda a origem de cada registro. Rodar de novo atualiza clientes, locais, usuários e catálogos, e não duplica OS, formulários, comentários nem orçamentos.

## Região de atuação dos técnicos e técnicos mais próximos

O endereço que veio do Field Control não é confiável para a maioria dos técnicos (muitos ficaram com o
endereço padrão do escritório). Por isso a **região de atuação** (`base_*`) sai principalmente do
histórico: a cidade onde o técnico mais atendeu nos últimos 36 meses (OS em que ele é o responsável,
não canceladas, e OS em que ele apontou trabalho). Sem histórico, vale o endereço dele, se tiver
coordenadas de verdade. A importação limpa o endereço quando a mesma coordenada é usada por mais de 20
colaboradores.

- **Usuário (técnico):** `home_latitude`/`home_longitude` e a base: `base_city`, `base_state`,
  `base_source` (`history` | `home` | null), `base_visits`, `last_visit_at`, `base_updated_at`.
  `TechnicianOut` traz `base_city`, `base_state`, `base_source`, `base_visits`, `last_visit_at`.
- **Recalcular:** automático no fim da importação e quando a conta tem mais de 6 h (a lista, a busca e
  as sugestões verificam antes de responder); manual: `POST /technicians/regions/refresh` (gestão)
  -> `{technicians, history, home, none}`.
- **Filtros da lista:** `GET /technicians?state=CE&city=fortaleza` (além de `q`, `team_id`, `active`).
  A UF e a cidade batem com a base **ou** com o endereço; cidade sem acento e sem diferença de
  maiúsculas.
- **Estados e cidades:** `GET /technicians/regions?active=` ->
  `[{state, total, cities: [{city, total}]}]` (região efetiva: a base, senão o endereço; ordenado pelo
  total).
- **Mais próximos:** `GET /technicians/nearby` com **um** destes pontos: `location_id` (a loja),
  `latitude`+`longitude` (coordenadas coladas) ou `city`+`state` (centro das lojas da cidade). Opcionais:
  `limit` (1-50, padrão 15), `include_inactive` (padrão `true`) e `max_km`.
  - Distância = a menor entre: as lojas que ele atendeu nos últimos 36 meses, o endereço e a posição ao
    vivo (em jornada, sinal dos últimos 30 min). Calculada no banco (haversine), sem uma consulta por
    técnico.
  - Resposta: `{point: {latitude, longitude, label}, technicians: [{id, name, email, phone, is_active,
    avatar_url, base_city, base_state, base_source, distance_km, nearest_kind (store_history | home |
    live), visits_at_location, last_visit_at_location, visits_in_city, total_visits, last_visit_at,
    open_tickets, on_shift, reasons[]}]}`, do mais perto para o mais longe (empate: mais visitas à loja).
  - `reasons`, por exemplo: "Atendeu esta loja 5x (última em 03/10/2026)", "Em jornada agora a 4 km",
    "Já atendeu a 1,2 km daqui", "Mora a 3 km", "Base em Fortaleza-CE (128 OS)", "3 OS abertas agora",
    "Inativo no app".
  - Erros (422): "A loja não tem coordenadas"; "Não há lojas com coordenadas em {cidade}-{UF} para
    calcular a distância"; sem ponto: "Informe a loja, as coordenadas ou a cidade com o estado". Loja
    inexistente: 404.
- **Sugestões da OS** (`GET /tickets/{id}/technician-suggestions` e `GET /technicians/suggest`): usam o
  mesmo cálculo (distância pelo histórico/endereço/ao vivo, visitas a esta mesma loja e a base na
  cidade), somado a agenda livre, skill, equipe do projeto e carga. Só técnicos **ativos**.
  `home_city`/`home_state` trazem a região efetiva (a base, senão o endereço). Os favoritos da cidade da loja
  ganham pontos e vaga garantida (ver "Técnicos favoritos por cidade").
- **Coordenadas de loja inválidas** (`app/services/geo.py`): não valem para distância nem mapa o
  `(0, 0)`, o centro do Brasil (`-14,2350, -51,9253`, ponto padrão do geocodificador quando o endereço
  não foi achado) e qualquer ponto repetido em lojas de **2 ou mais UFs** (lojas do mesmo shopping, na
  mesma UF, continuam valendo). A importação ignora esses pontos; `python -m app.services.geo` limpa os
  que já estão na base e recalcula a região dos técnicos. A busca e as sugestões também filtram na hora.
- **Loja sem coordenada** no `nearby`: mede pelo centro das lojas válidas da cidade, com o rótulo
  "<loja> (centro de <Cidade>-<UF>, a loja não tem coordenadas)"; as visitas a essa loja continuam
  contando. 422 só quando a cidade também não tem nenhuma loja válida ("A loja não tem coordenadas e não
  há lojas com coordenadas em {Cidade}-{UF} para calcular a distância").
- O mapa ao vivo, o ETA/link do mapa dos textos do WhatsApp e as sugestões da OS também ignoram
  coordenada inválida.

## Técnicos favoritos por cidade

Até 3 técnicos por cidade pela regra automática, mais os que a central fixar. Só as decisões manuais ficam no banco
(`technician_favorites`); a regra é calculada na hora (cerca de 50 ms no banco real).

**Regra automática** (`app/services/technician_favorites.py`):
- Cidade = a da **loja** da OS, com a UF: `(UF em maiúsculas, cidade sem acento)`, a mesma chave das cidades
  padronizadas. Loja sem UF ou sem cidade fica fora. "SANTOS" e "Santos" são a mesma cidade; Bom Jesus-PI e
  Bom Jesus-RS, não.
- Atendimento = o mesmo de "Base em X (N OS)": responsável ou outro técnico da visita numa OS não cancelada que teve
  chegada ou foi concluída, ou quem apontou trabalho. Conta 1 por técnico e OS.
- Janela de 365 dias, mínimo de 2 OS, até 3 por cidade.
- Ordem: mais OS; no empate, quem tem acesso ao app (`is_active`), depois a visita mais recente, depois o nome.
- Os inativos (sem acesso ao app) entram na regra e aparecem na lista, mas nunca nas sugestões da OS.

**Decisões da central** (analista, supervisor e admin):
- Fixado: favorito mesmo sem OS ou fora do top 3. Até 10 por cidade, com nota opcional (até 300 caracteres; espaços
  das pontas saem e vazio vira `null`). Fixar não muda os automáticos.
- Tirado: sai da regra daquela cidade e o próximo sobe. Vale até alguém desfazer.
- Favorito efetivo = fixado ou automático. Ordem: os fixados (mais OS, depois o nome), depois os automáticos pelo
  ranking.
- `set_by`/`set_at`: quem gravou a decisão por último e quando. Desfazer apaga a decisão e só deixa o registro no log.
  Técnico apagado leva as decisões junto.

**Rotas** (técnico e solicitante recebem 403):
- `GET /technicians/favorites?state=&technician_id=` → `FavoritesOut {window_days, min_visits, top, max_pinned,
  cities: [FavoriteCity]}`.
  - Todas as cidades com loja, também as sem favorito. Ordem: OS na janela, depois UF, depois cidade.
  - `technician_id`: só as cidades em que ele é favorito ou foi tirado.
- `FavoriteCity {state, city, key, stores, visits, favorites: [FavoriteTechnician], hidden_count, others_count}`:
  - `city` é a grafia mais usada nas lojas; `stores` conta as lojas ativas;
  - `visits` = OS distintas atendidas nas lojas da cidade na janela (uma OS com 2 técnicos conta 1);
  - `others_count` = quantos mais atenderam na janela sem ser favoritos nem tirados.
- `FavoriteTechnician {id, name, email, phone, avatar_url, is_active, on_shift, open_tickets, base_city, base_state,
  visits, last_visit_at, rank, automatic, pinned, hidden, note, set_by: Ref | null, set_at}`. `visits` e
  `last_visit_at` são da cidade, na janela; `rank` é a posição no ranking da cidade (`null` sem OS na janela).
- `GET /technicians/favorites/city?location_id=` ou `?state=SP&city=Santos` → `FavoriteCityDetail` =
  `FavoriteCity` + `hidden: [FavoriteTechnician]` + `others` (até 10, pelo ranking).
- `PUT /technicians/favorites/{technician_id}` `{state, city, favorite: true, note?}` → `FavoriteCityDetail`.
  - `favorite=true`: fixa o técnico; um tirado vira fixado. A nota do corpo substitui a gravada.
  - `favorite=false`: se ele está tirado, só troca a nota; se é automático agora, tira da lista com a nota; senão,
    apaga a decisão.
  - `hide=true` (só o Desfazer de um tirado usa): com `favorite=false`, grava tirado mesmo fora do top 3.
  - Decisões de quem deixou de ser técnico ficam guardadas, mas não contam (voltam se ele voltar a ser técnico).
- `DELETE /technicians/favorites/{technician_id}?state=&city=` → `FavoriteCityDetail`. Volta a valer só a regra;
  sem decisão gravada, responde 200 do mesmo jeito.
- Erros:
  - 404: "Técnico não encontrado" (não existe ou não é técnico), "Loja não encontrada", "Nenhuma loja em
    Santos-SP";
  - 422: "UF inválida", "Até 10 técnicos fixados por cidade", "A loja não tem cidade e UF", "Informe a loja ou a
    cidade com a UF" e nota com mais de 300 caracteres ("No máximo 300 caracteres", com `label` "Nota" ao
    fixar e "Motivo" ao tirar, como a tela chama esse texto).
  - O limite de 10 fixados vale também para dois "Fixar" ao mesmo tempo (trava por cidade na gravação).

**Nas sugestões da OS** (`GET /tickets/{id}/technician-suggestions` e `GET /technicians/suggest`):
- `TechnicianSuggestion` ganhou `favorite: "auto" | "manual" | null` (manual = fixado) e `favorite_note`.
- O favorito ativo da cidade da loja ganha +25 pontos e o primeiro motivo "Favorito em Santos-SP".
- Vaga garantida: os favoritos entram sempre entre os `limit` (se forem mais, os de mais pontos); as outras vagas
  seguem o ranking. Sem UF no alvo, não há favoritos.
- `GET /technicians/suggest` aceita `exclude_ticket_id`: no editor de uma OS aberta, a própria OS não deixa o técnico
  "Ocupado no horário" nem conta na carga do dia.

## Fichas completas (técnico, cliente e loja)

Tudo o que o Field Control tinha de cada cadastro fica guardado aqui. A importação preenche a ficha e, ao rodar de novo,
atualiza os dados de cadastro.

**Contatos** (`contacts` em cliente e loja): `[{kind: "email" | "phone", value, name, label, primary}]`.
- Telefone só com dígitos e com o DDI na frente (`"5585999991111"`). Na entrada, um número com DDD e sem DDI
  (10 ou 11 dígitos) ganha o 55; começando com `+`, fica como veio. Mínimo de 8 dígitos.
- E-mail em minúsculas, com `@`. `label` (`work`, `personal`, `mobile`, `home`, como no Field Control, ou livre) também
  em minúsculas.
- Sem repetidos (mesmo tipo e valor). Se o repetido era o principal ou tinha nome/rótulo, isso passa para o que ficou.
- **Os campos únicos seguem a lista:** ao gravar `contacts`, o principal de cada tipo (ou o primeiro, se nenhum estiver
  marcado) vai para `email`/`phone` do cliente e para `contact_phone`/`contact_name` da loja. O telefone fica legível:
  `"(85) 3333-2222"`. Um campo único enviado no mesmo pedido vale mais que a lista. Até 50 contatos.

**Cliente** (`CustomerOut`, `POST /customers`, `PATCH /customers/{id}`):
- `contacts`, endereço da matriz (`address_line`, `district`, `city`, `state`, `zip_code`, `latitude`, `longitude`) e
  `logo_url`. `created_at` é a data de cadastro no Field Control.
- `legacy` (só leitura, só para a equipe interna; `null` para os outros): `{source, id, created_at, rating: {average,
  last_star, last_comment} | null, service: {first_at, last_at, total} | null, attachments: [{url, title, type}]}`.

**Loja** (`LocationOut`, `POST /customers/{id}/locations`, `PATCH /locations/{id}`): `contacts` e `legacy` (só para a
equipe: `{source, id, created_at, territories: [nome]}`). `created_at` é a data de cadastro no Field Control.

**Técnico** (`TechnicianOut`):
- `address_line`, `address_district`, `address_zip` (o endereço padrão do escritório, usado por mais de 20
  colaboradores, não entra).
- `work_schedule: {start, end, break_start, break_end} | null`, com horários em `"HH:MM:SS"`.
- `services: [{id, name}]`: os tipos de serviço que ele faz (as skills do Field Control).
- `legacy: {source, id, territories: [nome]} | null`.
- `avatar_url`: a foto enviada aqui (link assinado) ou, sem ela, a foto que veio do Field Control.

`PATCH /technicians/{id}` aceita também:
- `address_line`, `address_district` e `address_zip` (o CEP é gravado como `00000-000`);
- `work_schedule`: horários em `HH:MM` ou `HH:MM:SS`. Horário inválido → 422 ("Horário inválido: use HH:MM"). Jornada
  toda em branco ou `null` limpa;
- `service_type_ids: [uuid]`: ids repetidos contam uma vez; id que não existe → 422 ("Tipo de serviço não encontrado");
  `[]` ou `null` limpa.

**Importação** (relatório em `counts`): `customers.with_2plus_contacts`, `locations.with_2plus_contacts`,
`technicians.with_address`, `technicians.with_schedule`, `technicians.with_services` e `cities_normalized`
(`{"tabela.coluna": registros alterados}`).

## Busca por palavras

`GET /locations?q=`, `GET /customers?q=` e `GET /technicians?q=` separam a busca em palavras (até 8). Cada palavra
precisa aparecer em algum dos campos, em qualquer ordem, sem diferença de acento ou de maiúscula. Pontuação separa
palavras, então CNPJ e telefone acham com ou sem pontuação. "Le Biscuit Iguatemi Fortaleza" acha "Le Biscuit - Shopping
Iguatemi Fortaleza".

| Rota | Campos |
| --- | --- |
| `/locations` | nome, código, CNPJ, endereço, bairro, cidade e nome do cliente |
| `/customers` | nome e CNPJ/CPF |
| `/technicians` | nome, e-mail e telefone |

Ordem: primeiro o código ou o documento igual à busca (só lojas e clientes), depois o nome que começa com a busca
inteira, depois o nome que começa com a primeira palavra, e o resto pelo nome.

## Cidades padronizadas

A mesma cidade vinha escrita de vários jeitos ("FORTALEZA" e "Fortaleza"; "SAO BERNARDO DO CAMPO" e "São Bernardo do
Campo"). Agora cada cidade tem uma grafia só, por UF. Vale para as lojas, a matriz dos clientes, a cidade de casa e a
de atuação dos técnicos, e por isso também para as regiões (`GET /technicians/regions`).

Para escolher a grafia, as variantes são comparadas sem acento e sem maiúsculas. Fica, nesta ordem:
1. a mais usada com grafia de nome próprio e acento ("São Paulo");
2. sem nenhuma assim, a mais usada com grafia de nome próprio ("Aracaju" ganha de "ARACAJÚ");
3. sem nenhuma de nome próprio, a mais usada (a acentuada, se houver) em título pt-BR, com "de", "da", "do", "das",
   "dos" e "e" em minúsculas ("SAO JOAO DEL-REI" vira "Sao Joao del-Rei").

Grafia de nome próprio = iniciais maiúsculas, o resto minúsculo e os conectores em minúsculas.

A importação padroniza no fim, antes de recalcular a região dos técnicos. Para rodar avulso (padroniza e recalcula as
bases): `python -m app.services.cities`.

## Portal do cliente e valor por chamado (2026-11-13)

**Por quê.** Os chamados chegavam pelo WhatsApp e por e-mail e o analista digitava a OS. Pelo portal o
próprio cliente abre (no navegador ou no app instalado no Windows), a central analisa, chama um técnico
parceiro pelo WhatsApp e, quando ele topa, coloca na OS. Os técnicos não têm vínculo: recebem por chamado.

### Portal (papel `requester`, ligado à empresa por `users.customer_id`)
- `GET /portal/me` → `{customer: {id, name}, locations}`. Sem empresa → 403 com a orientação.
- `GET /portal/locations?q=` → lojas ativas da empresa (`id, code, name, address, city, state`).
- `GET /portal/requests?scope=open|done|all&location_id=&q=&page=&page_size=` → `Page[PortalRequestItem] + {waiting}`
  (todas da empresa; `q` busca no assunto, no nº da OS e no nº do chamado do cliente; `waiting`: quantas aguardam um
  retorno do cliente com os mesmos filtros, em todas as páginas).
- `POST /portal/requests` `{location_id, title, description?, urgency: low|medium|high, contact?, client_reference?}`
  → 201 `PortalRequestDetail`. Vira OS `source=portal`, `status=new`, prioridade pela matriz (impacto médio ×
  urgência), sem analista e sem técnico. Loja de outra empresa → 422.
- `GET /portal/requests/{id}` → `PortalRequestDetail` (`timeline` de status, `technician`, visita,
  `resolution_notes` e `report_url` quando concluída, `can_cancel`). De outra empresa → 404.
- `POST /portal/requests/{id}/cancel` `{reason}` → só com a OS `new`/`triage` (depois, 422: fala com a central).
- `GET /portal/inbox-count` (gestão) → `{pending}`: OS do portal esperando a central (menu "Solicitações").
- O portal devolve só os campos acima: nada de etiquetas, analista, grupo, prazos de SLA, custos, pedidos de
  peça ou valores do técnico.
- `GET /tickets?source=portal` filtra a lista interna pela origem (a tela "Solicitações" usa isso).
- Usuários: `POST/PATCH /users` aceitam `customer_id`; para `role=requester` é obrigatório (422 sem ele) e para
  os outros papéis é limpo.

### App instalável (Windows)
`/manifest.webmanifest` (ícone oficial, `start_url=/`, atalho "Nova solicitação") e `/sw.js` (só mostra um
aviso quando a página abre sem internet; não guarda dados em cache). No Edge/Chrome aparece "Instalar no
computador" no portal: vira app com ícone na área de trabalho e no menu Iniciar.

### Valor por chamado (técnicos parceiros)
- `ServiceType.technician_fee` (opcional): valor padrão ao colocar o técnico na OS.
- `PUT /tickets/{id}/payouts/{technician_id}` `{amount, note?}` (gestão) → `Payout[]`. O técnico precisa estar
  na OS (responsável ou junto); pago não muda (422: desfaça antes). `DELETE` tira o valor ainda não pago.
- Regras automáticas (só para técnico parceiro, papel `technician`): ao colocar o técnico como responsável, entra o
  padrão do tipo de serviço; trocar o responsável leva o valor ainda não pago para o novo técnico; quem sai da
  visita perde o valor não pago (o pago fica). Analista ou supervisor que assume a OS (equipe interna) não ganha o
  padrão nem herda o valor de quem saiu (o valor não pago do técnico é retirado, com histórico); o "Definir valor"
  continua valendo para qualquer um na OS.
- `TicketDetail.payouts` (só a gestão) e `TicketDetail.my_payout` (só o técnico, o dele).
- `GET /payouts?technician_id=&status=pending|paid&concluded=&date_from=&date_to=` (gestão) → `{items, summary}`
  com `summary = {to_pay (OS concluídas), expected (OS abertas), paid}`; o período vale pela conclusão da OS.
- `POST /payouts/pay` e `POST /payouts/unpay` `{ids}` → `{changed}`. Pagar o último valor pendente de uma OS tira dela as
  etiquetas `remove_on_payout_paid` (ex.: "Pendente Envio PGTO"); desfazer o pagamento não traz de volta.
- `GET /me/earnings?month=AAAA-MM` (técnico) → os chamados dele, o resumo e os reembolsos (custos extras
  aprovados a receber e pagos no mês).
- Mudar o valor ou pagar marca a OS como alterada (`updated_at`), para o app do técnico baixar de novo.

## Orçamentos: cobrança, aberturas e preço do cliente (2026-11-17)

**Campos novos** em `QuoteOut`, `QuoteSent` e `QuoteListRow` (sempre presentes no JSON):
- `client_views`, `client_first_viewed_at`, `client_last_viewed_at`: aberturas do link pelo cliente.
- `reminder_count`, `last_reminded_at`, `last_reminded_by: Ref | null`: cobranças registradas pelo "Cobrar".
- `follow_up`: `not_opened` | `no_answer` | `expiring` | `in_review` | `expired` | `null` (por que está na fila
  "Para cobrar").
- `legacy_code` (código do Field Control), `legacy_description` (só quando difere do título) e
  `legacy_attachments: [{url, title, type}]`. Nada disso vai para o `PublicQuote`.
- `QuoteListRow.customer_id` e `QuoteListRow.ticket_status` (situação da OS: cancelada, a lista não oferece renovar,
  enviar, cobrar, editar nem duplicar, que a API recusa).

**Fila "Para cobrar".** A mesma regra vale para a lista, o campo `follow_up` e o Início. Contato = a última cobrança
ou, sem ela, o envio. Orçamento de OS cancelada nunca entra. Motivos, nesta ordem:
1. `expired`: vencido (situação vencido, ou enviado com a validade passada) há até 7 dias;
2. `expiring`: enviado, vence hoje ou amanhã e ainda sem contato hoje;
3. `not_opened`: enviado há até 30 dias, sem contato há 48 h, com link e nenhuma abertura;
4. `no_answer`: como o anterior, mas já aberto (ou sem link);
5. `in_review`: voltou a rascunho depois de enviado e está parado há 24 h.

**Rotas.**
- `GET /quotes?follow_up=true[&q=&customer_id=&start=&end=&limit=]` → `QuoteListRow[]` só da fila. Ordem: validade
  (sem validade no fim), depois o contato mais antigo. `X-Total-Count` = tamanho da fila. Sem `follow_up`, a lista
  funciona como antes.
- `GET /quotes?q=` também acha o orçamento pelo código do Field Control, sem diferença de maiúsculas.
- `POST /quotes/{id}/remind` (analista, supervisor e admin) → `QuoteOut` com `reminder_count + 1`,
  `last_reminded_at`, `last_reminded_by` e `follow_up: null`.
  - Grava na OS o evento interno `quote_reminded` (`to_value` "ORC-000123", `data {quote_id, count, total}`); o
    solicitante não vê.
  - 422: "Só orçamento aguardando o cliente pode ser cobrado", "O orçamento venceu: renove a validade antes de
    cobrar", "Gere o link antes de cobrar", "A OS foi cancelada: reabra a OS antes de mexer no orçamento".
  - 403 para técnico e solicitante; 404 "Orçamento não encontrado".
- `GET /quote-items` → `CatalogItemOut` com `uses_12m` (orçamentos não cancelados criados nos últimos 365 dias com o
  item) e `last_used_at`. `POST` e `PUT` devolvem `uses_12m = 0`.
- `GET /quote-items/last-prices?customer_id=` (gestão; 422 sem `customer_id`) →
  `[{catalog_item_id, unit_price, quote_id, quote_code, decided_at}]`: o preço mais recente de cada item do catálogo
  em orçamentos aprovados de OS do cliente.

**Aberturas.** `GET /public/quotes/{token}[?preview=1]`, com `Authorization` opcional, devolve o mesmo
`PublicQuote` de antes.
- Conta uma abertura sem sessão válida (ou com sessão de solicitante) e sem `preview=1`. A equipe com sessão e a
  prévia não contam.
- Aberturas repetidas em 10 min contam uma vez. Contar não muda o `updated_at` do orçamento.
- `GET /public/reports/{token}?preview=1` também não conta visita no relatório.

**Início e relatórios.**
- Grupo de atenção `quotes_waiting`: "Orçamentos para cobrar", link `/orcamentos?cobrar=1`, `count` = tamanho da
  fila e o motivo em cada item (ex.: "ORC-000123 (R$ 300,00) enviado há 3 dias, não aberto").
- Orçamentos aguardando e aprovados de OS cancelada saem do Financeiro do Início, do relatório mensal e dos projetos.
  A lista de orçamentos continua mostrando o aprovado.

**Outros.**
- O evento WS `quote.decided` ganha `total`.
- Cancelar um orçamento devolve os pedidos de peça ligados a ele (abertos ou orçados) para `open`, sem `quote_id`,
  com o evento `part_request_updated`.

## Ofertas de OS (2026-11-18)

**Por quê.** A central manda o chamado com o preço para os técnicos parceiros aceitarem, sem a opção de
contraproposta. Quem aceita primeiro fica com a OS, como no "quem pega?" do grupo de WhatsApp, mas com o valor
combinado de antemão. Código: `services/offers.py` (regras), `api/routes/offers.py`, `models/offer.py` e os
ganchos na OS em `services/tickets.py` (`close_pending_offers`).

**Regras.**
- A central (gestão com Pagamentos em Editar, que pode atribuir técnico) oferta uma OS **sem técnico** e **em
  aberto** (não resolvida, fechada nem cancelada) para 1 a 10 técnicos de campo ativos que ainda não estão na OS,
  com o valor do técnico (R$, ≥ 0, 2 casas), o prazo para responder (opcional, no futuro) e um recado (até 500).
- O técnico responde "Aceitar por R$ X" ou "Recusar" (motivo opcional, até 300). Não há contraproposta nem chat (a
  conversa é pelo WhatsApp).
- Para aceitar, ele precisa ter aberto a oferta: `GET /me/offers/{id}` grava `viewed_at` (sem ele, 422
  `OFFER_NOT_VIEWED`). O "Escopo lido" é do app.
- **Quem aceita primeiro leva.** O aceite trava a OS (`SELECT ... FOR UPDATE`), confere que a oferta está pendente e
  no prazo e que a OS continua em aberto e sem técnico, e faz a atribuição normal (`tickets._assign`, a mesma do
  `POST /tickets/{id}/assign`, com o técnico como autor e `data.via = "offer"` no evento `assigned`). Depois dela, o
  valor da oferta vira o valor do técnico na OS (`payouts.set_payout`, nota "Valor da oferta aceita", autor = quem
  mandou a oferta ou, sem ele, o técnico): vence o padrão do tipo de serviço ou o valor transferido. Se o técnico já
  tem nesta OS um valor **pago** (foi o técnico dela antes), o valor não muda (a central acerta). As outras ofertas
  pendentes da OS fecham como canceladas (`taken`, "outro técnico aceitou"); o segundo aceite recebe 409
  `OFFER_TAKEN`.
- **Status depois do aceite** = o da central colocando o técnico pela tela (o editor manda o técnico pelo
  `POST /assign`; o PATCH e o `PUT /times` não mudam o status): `new`/`triage`/`reopened` → `assigned`; a agenda que a
  OS já tinha fica, e ela **não** vira `scheduled` sozinha (o "Agendado" continua sendo a transição da central, como
  na tela); em espera (`on_hold_*`) continua em espera. Conta como 1ª resposta (o técnico é da equipe), como a
  atribuição pela central. O aceite não confere conflito de agenda (as ações do técnico não conferem; a central vê
  no calendário).
- Definir o técnico na mão (`/assign`, `PATCH assignee_id`, `/take`, o "Atribuído" do menu) fecha as pendentes como
  `assigned`; cancelar, resolver ou fechar a OS (`/transition` e o cancelamento pelo portal) fecha como
  `ticket_closed`. Cada fechamento grava um `offer_cancelled` e avisa a gestão e os técnicos afetados.
- Reenviar para quem já tem oferta pendente (ou vencida) da mesma OS **substitui** a anterior: a antiga vira
  cancelada com `cancel_reason: "replaced"`, sem evento próprio (o `offer_sent` traz `data.replaced`).
- Prazo vencido não tem rotina: a oferta continua gravada como pendente e o estado efetivo é `expired` quando
  `expires_at <= agora` (relógio do servidor). A vencida não conta em `open_offers` e não é fechada pelos ganchos
  (continua `expired`); a central ainda pode cancelá-la.
- O preço é dado de Pagamentos: ver as ofertas com os valores pede Pagamentos (Visualizar); mandar e cancelar pedem
  Editar. Quem não tem a tela vê só `TicketDetail.open_offers` (contador sem valores) e não recebe os `offer_*` do
  histórico.

**Estados** (`state`): `pending` | `expired` | `accepted` | `declined` | `cancelled`. Gravados (`OfferStatus`):
`pending`, `accepted`, `declined`, `cancelled`. `cancel_reason`: `central` (a central cancelou) | `taken` (outro
técnico aceitou) | `assigned` (a central definiu o técnico) | `ticket_closed` (OS cancelada, resolvida ou fechada) |
`replaced` (trocada por uma oferta nova da mesma OS).

**Central** (gestão, sempre dentro da fila de quem pede: OS de outra fila → 403 `QUEUE_FORBIDDEN`):
- `GET /tickets/{id}/offers` (Pagamentos em Visualizar) → `TicketOfferOut[]`, todas as ofertas da OS (também as
  fechadas e as substituídas), a mais nova primeiro (as de um mesmo envio, pelo nome do técnico).
- `POST /tickets/{id}/offers` (Pagamentos em Editar) `{technician_ids: uuid[1..10], amount, expires_at?, note?}` →
  **201** `TicketOfferOut[]` (as criadas, na ordem dos ids, sem repetir). `amount` aceita número ou texto
  (`"90.00"`); `expires_at` sem fuso vale como hora de Brasília. 422: "A OS já tem técnico: só dá para ofertar uma OS
  sem técnico", "Só dá para ofertar uma OS em aberto (não resolvida, fechada nem cancelada)", "O prazo para responder
  precisa ser no futuro", "Técnico não encontrado", "<nome> não é técnico de campo", "<nome> está sem acesso ao app:
  libere o acesso em Técnicos antes de ofertar", "<nome> já está na OS"; validação com `label` "Técnicos", "Valor",
  "Prazo para responder" e "Recado". O envio trava a OS: dois envios juntos para o mesmo técnico viram uma troca
  (`replaced`); o índice único parcial é a rede de segurança (409 "Este técnico já tem uma oferta em aberto nesta OS").
- `POST /tickets/{id}/offers/{offer_id}/cancel` (Pagamentos em Editar, sem corpo) → `TicketOfferOut` (pendente ou
  vencida → `cancelled`/`central`; já cancelada: devolve como está). Já respondida pelo técnico: 422 "O técnico já
  respondeu esta oferta. Recarregue a OS."; oferta de outra OS: 404 "Oferta não encontrada".

`TicketOfferOut = {id, ticket_id, technician: {id, name}, amount: number, state, expires_at|null, note|null,
decline_reason|null, cancel_reason|null, viewed_at|null, responded_at|null, created_by: {id, name}|null, created_at}`
(`amount` sai como número, como os outros valores da API: `90.0`).

**Técnico** (só papel `technician`; os outros: 403 "Sem permissão para esta ação"):
- `GET /me/offers` → `FieldOfferOut[]`: as pendentes no prazo e as que fecharam nas últimas 24 h (aceitas,
  recusadas, canceladas pelo `updated_at`; vencidas pelo `expires_at`), a mais nova primeiro, até 50. A substituída
  (`replaced`) não aparece (a nova aparece). Nas que não estão pendentes, o recorte da OS vem mínimo: sem escopo
  (`description: null`), sem formulários (`forms: []`) e sem bairro (`district: null`).
- `GET /me/offers/{id}` → `FieldOfferOut`; grava `viewed_at` na primeira vez (só a pendente no prazo) e a gestão
  recebe o `ticket.updated` com `offer.action: "viewed"`. Oferta de outro técnico: 404.
- `POST /me/offers/{id}/accept` (sem corpo) → `TicketDetail` da OS na visão do técnico (como o `GET /tickets/{id}`
  devolve a ele), já atribuída: agora vêm cliente, loja e endereço, e `my_payout` com o valor da oferta. Aceite
  repetido da oferta que já é dele (toque duplo, outro aparelho): 200 com a OS, sem mudar nada.
- `POST /me/offers/{id}/decline` `{reason?: até 300}` (corpo opcional) → `FieldOfferOut` (`declined`). Recusa repetida:
  200 como está. Recusar não exige abrir a oferta.

`FieldOfferOut = {id, state, amount: number, expires_at|null, note|null, cancel_reason|null, viewed_at|null,
responded_at|null, created_at, ticket: {id, code, title, description|null, service_type: {id, name}|null,
forms: [{name, required}], district|null, city|null, state|null, scheduled_start|null, scheduled_end|null}}`.
Sem cliente, loja (nome, código, CNPJ), endereço, contato, recado da visita (`visit_note`), SLA, analista, etiquetas,
projeto nem valores de outros técnicos (a regra do convite: "só serviço, bairro e cidade, data e valor"). Sem agenda,
`scheduled_start` vem null ("data a combinar"); bairro, cidade e UF são os da loja (OS sem loja: null).
`cancel_reason` (acréscimo ao contrato inicial) diz ao app por que fechou ("outro técnico aceitou" = `taken`).

**Erros do aceite e da recusa** (`{"detail": "...", "code": "..."}`):

| HTTP | code | detail | Quando |
|---|---|---|---|
| 409 | `OFFER_TAKEN` | Outro técnico já aceitou esta OS. | cancelada como `taken` |
| 409 | `OFFER_EXPIRED` | O prazo para responder esta oferta acabou. | pendente com `expires_at` vencido |
| 409 | `OFFER_CANCELLED` | A central cancelou esta oferta. | cancelada como `central` ou `replaced` (o app busca as ofertas de novo e acha a nova) |
| 409 | `OFFER_UNAVAILABLE` | Esta OS não está mais disponível. | cancelada como `assigned`/`ticket_closed`; a OS já tem técnico ou foi encerrada; aceite de uma oferta aceita cuja OS não é mais dele |
| 409 | `OFFER_ANSWERED` | Você já respondeu esta oferta. | aceitar a recusada ou recusar a aceita (acréscimo ao contrato inicial) |
| 422 | `OFFER_NOT_VIEWED` | Abra a oferta e leia o escopo antes de aceitar. | aceite sem `viewed_at` |

A ordem das conferências: o estado da oferta (aceita, recusada, cancelada), o prazo, a OS (em aberto e sem
técnico) e, só no aceite, a leitura.

**Histórico** (eventos novos, só para quem tem Pagamentos: levam o valor; `HISTORY_ITEMS`):
- `offer_sent` (autor: quem mandou): `to_value` "90.00", `note` = recado, `data {amount: "R$ 90,00", expires_at,
  offers: [{id, technician_id, technician}], replaced?: [nomes]}`.
- `offer_accepted` (autor: o técnico): `to_value` "90.00", `data {offer_id, technician_id, technician, amount}`.
- `offer_declined` (autor: o técnico): `to_value` "90.00", `note` = motivo, `data {offer_id, technician_id,
  technician, amount}`.
- `offer_cancelled` (autor: quem cancelou, definiu o técnico ou encerrou a OS; null no `taken`): `to_value` = motivo,
  `note` ("Cancelada pela central", "Outro técnico aceitou a OS", "A central definiu o técnico da OS", "OS cancelada",
  "OS resolvida", "OS fechada"), `data {reason, offers: [{id, technician_id, technician, amount}]}`.
- O aceite também grava o `assigned` normal (autor: o técnico, `note` "Aceitou a oferta", `data.via = "offer"`), o
  `status_changed` da atribuição e os `payout_set` (o padrão do tipo de serviço, quando houver, e o valor da oferta).

**Tempo real.**
- Gestão: `ticket.updated` com `data {fields: ["offers"], offer: {action, technician_name|null, reason|null}}`,
  interno e só da gestão, **sem valor**. `action`: `sent` | `viewed` | `accepted` | `declined` | `cancelled`
  (`viewed` é acréscimo ao contrato inicial). `technician_name` quando é um técnico só; `reason` = o
  `cancel_reason` no `cancelled` e o motivo do técnico no `declined`. Vai a toda a gestão que vê a OS (com ou sem
  Pagamentos: não leva valor).
- Técnicos da oferta: `ticket.offer` com `audience.user_ids` = os técnicos afetados (só eles recebem), em `sent`,
  `accepted`, `declined` e `cancelled` (inclusive `taken`, `assigned` e `ticket_closed`). No app o evento chega como
  `{type: "ticket.offer", ticket_id, ticket_code, status: null, assignee_id: null, actor_id: null, version: null,
  occurred_at, data: {action}}`: sem versão (a oferta não muda a OS, e o app não descarta o aviso pela versão que já
  tem). O app repassa os `ticket.*`: ao receber, sincroniza e busca `GET /me/offers`.
- O aceite gera também o `ticket.assigned` normal (o técnico que aceitou recebe, como numa atribuição) e o
  `ticket.status_changed`.
- Push (o provedor ainda só registra no log): `ticket.offer` com `action: "sent"` avisa os técnicos da oferta ("OS
  para aceitar: OS-000123" · "Veja o valor e o escopo no app e responda").

**Na central (web).** Nenhuma rota nova; o que a tela usa:
- Aba Geral da OS sem técnico: o bloco "Ofertas" (`components/ticket/OffersCard.tsx`, chave `["ticket", id,
  "offers"]`) lista as ofertas (sem as `replaced`) com o técnico, o valor e a situação ("Vista às 14:41 · vence às
  15:30", "Recusou às 14:50: motivo", "Outro técnico aceitou"...), o "Cancelar" da pendente (com confirmação), o
  "Copiar texto para o grupo" e o "Ofertar com preço" (Pagamentos em Editar, OS em aberto e sem técnico; travado com
  alteração não salva, como a Situação). Nada disso entra no formulário da OS. Escolher o técnico na mão com ofertas
  em aberto mostra o aviso de que elas serão canceladas ao salvar.
- Diálogo "Ofertar a OS com preço" (também no resumo da OS recém-criada): de 1 a 10 técnicos (`GET
  /technicians/suggest` com `exclude_ticket_id` e `limit=10`, mais a busca: `GET /technicians` com a tela Técnicos,
  senão os técnicos de `GET /users/assignable`; sem acesso ao app e já na OS aparecem travados), o valor (começa no
  `technician_fee` do tipo de serviço), o prazo (sem prazo, 30 min, 1 h, 2 h, 4 h ou até o fim do dia; o `expires_at` é
  calculado no clique) e o recado. Depois do envio, o aviso "Oferta enviada" com "Copiar texto para o grupo".
- Texto do grupo de técnicos (`offerText` em `components/new-ticket/invite.ts`): serviço, bairro e cidade, data (ou
  "data a combinar"), valor, para quem foi no app e "Aceite pelo app até HH:MM" (ou sem prazo). Nunca cliente, loja
  ou endereço.
- Cabeçalho da OS (toda a gestão, pelo `open_offers`): sem técnico e com oferta esperando resposta, o chip "Sem
  técnico" vira "Oferta enviada" / "N ofertas enviadas", em tom neutro. Sem Pagamentos, a Geral também mostra só
  esse contador, sem valores.
- Histórico: os quatro `offer_*` (técnicos e valor no envio, valor no aceite, motivo na recusa, motivo no
  encerramento) e o `assigned` com `via: "offer"` ("assumiu a OS pela oferta").
- Tempo real: o `ticket.updated` com `fields: ["offers"]` recarrega a OS (a lista de ofertas e o contador ficam sob
  `["ticket", id]`) e as listas de OS, como todo `ticket.*`, sem as telas extras (Pagamentos, relatórios...); o
  aceite e a recusa viram aviso para o analista da OS (sem analista, para a central toda), sem o valor.

## Acesso: perfis por tela e visibilidade de filas

O papel (`users.role`) continua decidindo o canal (web ou app), a hierarquia de cadastro (quem cria e altera
quem em Usuários) e as regras duras (o SLA é só do administrador; a exclusão da ficha de homologação, de
admin e supervisor). Por cima do papel:

- **Perfil de acesso** (`access_profiles`), só de supervisor e analista: o nível de cada tela do menu
  (`none` | `view` | `edit`) e a visibilidade de filas. Os perfis padrão "Supervisor" e "Analista"
  (`system_key`) nascem vazios e reproduzem o acesso de antes; tela sem nível gravado segue o padrão do papel.
- **Ajustes da pessoa** (`users.access_overrides`): `{items?: {tela: nível}, queue_scope?, queue_unowned?}`
  por cima do perfil, item por item. Ajuste igual ao perfil não é gravado.
- **Administrador**: acesso total sempre (ignora perfil e ajustes).
- **Técnico e cliente**: fora da matriz (`access: null`); valem as regras do papel.
- **Núcleo sem tela**: Início, Minha fila, Solicitações, Chamados, Nova OS e tudo dentro da OS ficam com a
  gestão (admin, supervisor e analista), sempre com a visibilidade de filas. As exceções dentro da OS são os
  blocos comerciais (abaixo).

### Catálogo (`core/permissions.py`)

| Tela | Chave | Níveis | Supervisor | Analista |
|---|---|---|---|---|
| Calendário (`/agenda`) | `operation.calendar` | none, view, edit | edit | edit |
| Atividades do dia (`/dia`) | `operation.day` | none, view | view | view |
| Mapa ao vivo (`/mapa`) | `operation.map` | none, view | view | view |
| Assistência externa (`/assistencia`) | `operation.repairs` | none, view, edit | edit | edit |
| Orçamentos (`/orcamentos`, aba da OS) | `commercial.quotes` | none, view, edit | edit | edit |
| Projetos (`/projetos`) | `commercial.projects` | none, view, edit | edit | edit |
| Custos extras (`/custos`, custos da OS) | `commercial.expenses` | none, view, edit | edit | edit |
| Pagamentos (`/pagamentos`, valor do técnico na OS) | `commercial.payouts` | none, view, edit | edit | edit |
| Clientes (`/clientes`) | `base.customers` | none, view, edit | edit | edit |
| Locais (`/locais`) | `base.locations` | none, view, edit | edit | edit |
| Técnicos (`/tecnicos`; editar inclui Liberar acesso) | `base.technicians` | none, view, edit | edit | edit |
| Homologação (`/homologacao`) | `base.onboarding` | none, view, edit | edit | edit |
| Dashboard (`/dashboard`) | `analysis.dashboard` | none, view | view | view |
| Relatórios (`/relatorios`) | `analysis.reports` | none, view | view | view |
| Formulários (`/formularios`) | `setup.forms` | none, view, edit | edit | edit |
| Textos do WhatsApp (`/textos`) | `setup.messages` | none, view, edit | edit | edit |
| Tipos de serviço (`/tipos-servico`) | `setup.service_types` | none, view, edit | edit | edit |
| Usuários (`/usuarios`) | `setup.users` | none, view, edit | edit | view |
| Configurações (`/configuracoes`) | `setup.settings` | none, view, edit | edit | none |

Fila padrão dos dois perfis: todas as filas. "Editar" em Usuários deixa o supervisor cadastrar só os papéis
que ele já cuidava (analista e cliente) e os grupos técnicos; "Editar" no Calendário é remarcar arrastando
(o editor da OS é do núcleo).

### Erros 403

| Corpo | Quando |
|---|---|
| `{"detail": "Sem acesso a Pagamentos.", "code": "MODULE_FORBIDDEN", "item": "commercial.payouts", "module": "commercial", "required": "view"}` | tela fora do perfil |
| `{"detail": "Seu acesso a Orçamentos é só de visualização.", "code": "MODULE_FORBIDDEN", "item": "commercial.quotes", "module": "commercial", "required": "edit"}` | gravação com Visualizar |
| `{"detail": "Esta OS é de outra fila.", "code": "QUEUE_FORBIDDEN"}` | OS fora da fila de quem pede (qualquer rota da OS e as ações por orçamento ou custo) |
| `{"detail": "Seu acesso mostra só a sua fila.", "code": "QUEUE_FORBIDDEN"}` | `GET /my-queue?user_id=<outro>` com "Somente a própria fila" |
| `{"detail": "Você não pode dar mais acesso do que tem.", "code": "ACCESS_CAP"}` | supervisor dando acesso acima do dele |
| `{"detail": "Só o administrador troca a senha ou o e-mail de quem tem mais acesso que você.", "code": "ACCESS_CAP"}` | supervisor trocando a senha ou o e-mail de quem tem mais acesso que ele |

Técnico e cliente numa rota da gestão recebem o 403 de sempre (`{"detail": "Sem permissão para esta ação"}`);
numa OS que não é deles, 404.

### Rotas

- `GET /access/catalog` (gestão) → `{modules: [{key, label, items: [{key, label, href, levels, hint}]}],
  defaults: {supervisor: {...}, analyst: {...}}}`.
- `GET /access/profiles` (Usuários em Visualizar) → `[{id, name, description, system_key, items, effective_items,
  queue_scope, queue_unowned, users_count, updated_at}]`: Supervisor, Analista e depois por nome; `items` só o
  gravado e `effective_items` todas as 19 telas; `users_count` conta ativos e inativos. Cria os perfis padrão
  que faltarem.
- Só o administrador:
  - `POST /access/profiles` `{name, description?, copy_from_id?, items?, queue_scope?, queue_unowned?}` → 201.
    Grava o `effective_items` do perfil de origem (sem ele, o do Analista) mais as telas enviadas, sempre
    completo. 409 "Já existe um perfil com este nome".
  - `PATCH /access/profiles/{id}` (parcial; em `items`, `null` tira a tela e ela volta ao padrão). Perfil
    padrão: 422 "O nome dos perfis padrão não muda".
  - `POST /access/profiles/{id}/reset`: perfil padrão volta a `items {}` e todas as filas (422 nos outros).
  - `DELETE /access/profiles/{id}` → 204; 409 "Perfis padrão não são excluídos." ou "Perfil em uso por N
    usuários. Troque o perfil deles antes."
- Validação (422): "Tela desconhecida: <chave>"; "<Tela> só tem Sem acesso ou Visualizar".
- Depois de mudar um perfil, todos que o usam (e, num perfil padrão, quem do mesmo papel está sem perfil)
  recebem `access.changed`.

**Usuários.** `UserOut` ganha `access_profile_id`, `access_profile: Ref | null`, `access_overrides` e
`access: EffectiveAccessOut | null` = `{full, profile: Ref | null, customized, items: {19 telas: nível},
queues: {scope: "own" | "all", unowned}}` (admin: `full: true`, tudo no máximo; técnico e cliente: `null`).
Vem também em `/auth/me` e no `user` do login, do refresh, da troca de senha e do login Microsoft.

- `POST /users` e `PATCH /users/{id}` (Usuários em Editar, admin e supervisor, com a hierarquia de antes)
  aceitam `access: {profile_id: uuid | null, overrides: {items?, queue_scope?, queue_unowned?} | null}`;
  `profile_id` `null` é o perfil padrão do papel.
  - Supervisor ou analista sem `access` entra no perfil padrão do papel; outros papéis com `access`: 422 "Este
    papel não usa perfil de acesso".
  - Troca de papel sem `access`: quem estava no padrão do papel antigo (ou sem perfil) passa ao padrão do
    novo; papel fora da matriz fica sem perfil e sem ajustes.
  - Teto do supervisor: nenhuma tela acima do nível dele (a não ser que a pessoa já tivesse esse nível) e, se
    ele só vê a própria fila, nada de "todas as filas" nem de OS sem analista que ele não vê (403
    `ACCESS_CAP`). Ao criar alguém, o teto vale para o acesso inteiro.
  - Senha e e-mail: o supervisor só troca os de quem cabe no teto dele (o acesso atual da pessoa, telas e
    fila); senão, 403 `ACCESS_CAP` (entrar como a pessoa daria a ele o acesso que o teto não deixa dar).
  - Mudança de acesso publica `access.changed` para a pessoa.
- `GET /users?access_profile_id=` filtra por perfil (num perfil padrão, também quem do papel está sem perfil,
  que cai nele; o `users_count` do perfil padrão conta essas pessoas).
- Supervisor ou analista sem perfil (`access_profile_id: null`, de antes dos perfis): `GET /users`,
  `GET /users/{id}` e a resposta do `PATCH` mostram em `access` o perfil padrão gravado do papel, o mesmo que vale
  no `/auth/me` e nas guardas. O autocadastro pelo login Microsoft e o escritório importado do Field Control já
  entram com o perfil padrão do papel gravado.

### Visibilidade de filas

A fila de X são as OS com `owner_id = X` (analista responsável). "Somente a própria fila" vê as OS de que a
pessoa é a responsável **ou** a executora (`assignee_id`) e, com `queue_unowned`, as "sem analista" (sem
responsável, ou com responsável desativado ou fora da gestão). "Todas as filas" vê tudo e já inclui as sem
analista.

Vale em:
- `GET /tickets`, `/tickets/export` e `/tickets/bulk-tags` (OS de outra fila fica de fora; `owner_id=<outro>`
  e `no_owner` sem a opção voltam vazios); toda rota de uma OS (`QUEUE_FORBIDDEN`).
- `GET /tickets/lookup?number=N` (novo) → `{id, code}`; 404 "OS não encontrada"; 403 `QUEUE_FORBIDDEN` quando
  existe mas é de outra fila (técnico e cliente: 404).
- `GET /queues` → `TeamQueues {queues, unowned: QueueCounts | null, scope, total}`: com "própria fila", só a
  linha de quem pede e a sem analista se ele a vê; `total` soma as linhas devolvidas e a sem analista.
- `GET /my-queue?user_id=` (403 acima); Início (`/home/overview`: números, grupos, exemplos, sugestões e sinais
  vitais; com "própria fila" sem a opção, o grupo `no_owner` e o motivo antigo `no_owner` não saem, como no
  `/queues` e no Dashboard, mesmo para a OS sem analista que a pessoa executa); `/search/smart` (OS, chip
  "OS nº" e OS abertas de cada cliente); `/dashboard/summary`, `/reports/daily`, `/reports/monthly`,
  `/reports/sla-violations`; `/activities/day`; `/portal/inbox-count`.
- `GET /calendar` (só as OS visíveis); conflitos (`/calendar/conflicts` e o 409 `SCHEDULE_CONFLICT`): a OS de
  outra fila vem como `{who, id: null, code: null, title: "OS de outra fila", customer: null, location: null,
  start, end, hidden: true}`.
- `GET /tracking/live`: OS em campo de outra fila → `current_ticket: null`, `current_ticket_hidden: true` (o
  estado continua); `/tracking/history` só com as mudanças de status das OS visíveis.
- Comercial: `/quotes` e `/quotes/summary`, `/expenses`, `/payouts` só com as OS visíveis; `mark-paid`, `pay` e
  `unpay` ignoram os ids de outra fila; ações por orçamento ou custo de outra fila: 403. Projetos contam só as
  OS visíveis.
- Clientes e locais: contagens de OS; `GET /intake/context` (agendadas, 30 dias e última visita) e o novo
  `other_queues_open` (OS abertas da loja em filas que a pessoa não vê; só com "própria fila").
- Reincidência do detalhe e das listas.
- Ficam globais, por serem agregados: `/users/assignable` (carga), OS abertas por técnico, sugestões de técnico.
- Passar a OS para outra fila (`PATCH owner_id`) continua permitido; depois disso a OS some para quem passou.

**Blocos comerciais da OS** (`GET /tickets/{id}` da gestão): sem Custos extras, `expenses: []`; sem
Pagamentos, `payouts: []`; sem Orçamentos, `legacy.values` e o `value`/`total` dos itens do pedido migrado vêm
`null`. No Início, `pulse.finance` só com Custos extras e Pagamentos, `pulse.quotes` só com Orçamentos, e os
grupos `costs_pending`, `payouts_pending`, `quotes_waiting` e a sugestão `slow_service_type` só com a tela deles.
Os mesmos valores fora dessas telas:
- `GET /tickets/{id}/events` (Histórico): sem a tela, saem inteiros os eventos com o valor dela
  (`payout_set`/`payout_removed` e `offer_sent`/`offer_accepted`/`offer_declined`/`offer_cancelled`;
  `expense_added`/`expense_updated`/`expense_removed`; `quote_sent`/`quote_approved`/`quote_rejected`/`quote_reminded`).
- Ofertas de OS: sem Pagamentos, só o contador `open_offers` do detalhe (a lista `GET /tickets/{id}/offers` é 403).
- `GET /projects` e `/projects/{id}`: sem Projetos, `contract_value`, `pricing_notes` e `margin` vêm `null` e
  os totais em dinheiro, 0 (a lista continua aberta para o seletor da Nova OS). Cada total de `stats`
  (`expenses_total`, `payouts_total`, `quotes_approved_total`) também pede a tela dele (sem ela, 0), e
  `margin` pede Custos extras, Pagamentos e "Todas as filas" (com a própria fila, os totais são só das OS dela e o
  contrato é do projeto inteiro: `margin` vem `null`).
- Anexos da OS: sem Custos extras, o comprovante de custo não vem na lista (nem pelo id: 404).
- `GET /reports/monthly`: `expenses_total` `null` sem Custos extras e `quotes_approved_total` `null` sem
  Orçamentos.
- `pulse.finance` sem Orçamentos: `quotes_waiting*` e `quotes_approved_month*` saem 0.
- `GET /tickets/{id}/expenses` segue as regras do detalhe (o técnico vê o reembolso dele e o material da OS,
  sem quem lançou).

### Tempo real

- Eventos de OS ganham `owner_id`; a `audience` interna ganha `owner_id`, `previous_owner_id` e `unowned`. Na
  troca de analista, `data` traz `from_id` e `to_id` (além dos nomes).
- Quem só vê a própria fila recebe só eventos das OS dele (responsável atual ou anterior, executor) e, com a
  opção, das sem analista. `quote.decided` só vai para quem tem Orçamentos; `onboarding.submitted`, para quem
  tem Homologação; `technician.location` e `technician.shift`, para quem tem o Mapa ao vivo.
- `{"type": "access.changed"}` vai só para a pessoa afetada; logo depois o servidor fecha o socket com 4401 e o
  cliente renova o token e reconecta com o acesso novo. O vigia de 5 minutos também fecha quando o acesso muda.

### Tabela rota → tela

V = Visualizar, E = Editar; "a \| b" = basta uma das telas.

| Tela | Rotas |
|---|---|
| `operation.calendar` | V: `GET /calendar` |
| `operation.day` \| `operation.map` | V: `GET /activities/day` |
| `operation.map` | V: `GET /tracking/live`, `/tracking/distances`, `/tracking/history` |
| `operation.repairs` | V: `GET /repairs`, `/repairs/summary`, `/repairs/{id}`. E: `POST /repairs`, `PUT /repairs/{id}`, `POST /repairs/{id}/status`, `POST /repairs/{id}/photos` |
| `commercial.quotes` | V: `GET /quote-items`, `/quote-items/last-prices`, `/tickets/{id}/quotes`, `/quotes`, `/quotes/summary`. E: `POST`/`PUT /quote-items`, `POST /tickets/{id}/quotes`, `PUT /quotes/{id}`, `POST /quotes/{id}/send`, `/remind`, `/link/rotate`, `/cancel` |
| `commercial.projects` | V: `GET /projects/{id}`. E: `POST /projects`, `PUT /projects/{id}` |
| `commercial.expenses` | V: `GET /tickets/{id}/expenses` (só a gestão; o técnico como antes). E: `POST /tickets/{id}/expenses`, `PATCH`/`DELETE /expenses/{id}`, `POST /expenses/mark-paid` |
| `commercial.expenses` \| `commercial.payouts` | V: `GET /expenses` |
| `commercial.payouts` | V: `GET /payouts`, `GET /tickets/{id}/offers`. E: `PUT`/`DELETE /tickets/{id}/payouts/{tech}`, `POST /payouts/pay`, `/payouts/unpay`, `POST /tickets/{id}/offers`, `POST /tickets/{id}/offers/{offer_id}/cancel` |
| `base.customers` | V: `GET /customers/{id}`, `GET /assets`, `/assets/{id}`. E: `POST /customers`, `PATCH /customers/{id}`, `POST`/`PATCH /assets` |
| `base.locations` | E: `POST /customers/{id}/locations`, `PATCH /locations/{id}`, `POST /locations/import` |
| `base.technicians` | V: `GET /technicians`, `/technicians/favorites`. E: `POST /technicians`, `PATCH /technicians/{id}`, `POST /technicians/{id}/reset-password`, `POST`/`DELETE /technicians/{id}/photo`, `POST /technicians/import`, `POST /technicians/regions/refresh`, `PUT`/`DELETE /technicians/favorites/{id}` |
| `base.technicians` \| `base.onboarding` | V: `GET /technicians/regions` |
| `base.technicians` \| `base.locations` | V: `GET /technicians/nearby` |
| `base.onboarding` | V: `GET /onboarding/invites`, `/onboarding/applications`, `/applications/pending-count`, `/applications/{id}`. E: `POST`/`DELETE /onboarding/invites`, `POST .../approve`, `.../reject`; `DELETE /onboarding/applications/{id}` (E e só admin e supervisor) |
| `analysis.dashboard` | V: `GET /dashboard/summary` |
| `analysis.dashboard` \| `analysis.reports` | V: `GET /reports/sla-violations`, `GET /reports/daily` |
| `analysis.reports` | V: `GET /reports/monthly` |
| `setup.forms` | V: `GET /form-templates/catalog`, `/form-templates/{id}`. E: `POST /form-templates`, `PUT /form-templates/{id}` |
| `setup.messages` | V: `GET /message-templates`. E: `PUT /message-templates`, `POST /message-templates/reset` |
| `setup.service_types` | E: `POST /service-types`, `PATCH /service-types/{id}`, `POST /service-types/{id}/apply-observed` |
| `setup.users` | V: `GET /access/profiles`. E: `POST /users`, `PATCH /users/{id}` (admin e supervisor), `POST`/`PATCH /teams` |
| `setup.settings` | E: `PUT /settings/company`, `/settings/expenses`, `/settings/field`, `/ticket-tag-rules`, `POST`/`PATCH /categories`, `POST`/`PATCH /violation-reasons` |

Sem tela (toda a gestão): as leituras que a Nova OS, o editor, a OS, os filtros, a Minha fila e o Início usam
(`/customers`, `/customers/{id}/locations`, `/locations`, `/locations/{id}`, `/intake/context`,
`/service-types`, `/categories`, `/sla-policies`, `/violation-reasons`, `/unproductive-reasons`,
`/ticket-tags`, `/ticket-tag-rules`, `/form-templates`, `/users`, `/users/assignable`, `/users/{id}`,
`/teams`, `/technicians/suggest`, `/technicians/favorites/city`, `/tickets/{id}/technician-suggestions`,
`/calendar/conflicts`, `/projects`, `/queues`, `/settings/company`, `/settings/expenses`, `/settings/field`,
`/portal/inbox-count`, `/access/catalog`) e o núcleo da OS. `PUT /sla-policies` continua só do administrador
e os motivos de visita improdutiva continuam com toda a gestão. O inventário completo está em
`backend/tests/test_access_routes.py` (rota nova sem classificação faz o teste falhar).

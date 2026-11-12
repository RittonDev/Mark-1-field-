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
| Técnico de campo | `technician` | **só as OS atribuídas a ele** (app mobile); grupo ou fila não bastam | mudar status, comentar, apontar horas, fotos e cadastrar ativos **nas OS dele**. Não assume nem se atribui OS: quem coloca o técnico na OS é a gestão |
| Solicitante | `requester` | OS que abriu | abrir OS, comentar (público), cancelar enquanto nova, aceitar (fechar) ou recusar (reabrir) solução |

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

- `GET /customers?q=` → `CustomerOut[]` · `POST /customers` · `GET/PATCH /customers/{id}`
  - `CustomerOut = {id, name, document, email, phone, notes, is_active, created_at, locations_count, open_tickets, total_tickets, last_ticket_at}`
- `GET /locations?q=&customer_id=&active=&page=&page_size=` → `Page<LocationOut>` (até 200 por página). `q` busca em nome, código, CNPJ (com ou sem pontuação), endereço, cidade e nome do cliente
- `GET /locations/{id}` · `PATCH /locations/{id}` · `GET/POST /customers/{id}/locations` (lista sem paginação, para um cliente)
  - `LocationOut = {id, customer_id, customer:{id,name}, name, code, document, address_line, district, city, state, zip_code, latitude, longitude, contact_name, contact_phone, notes, is_active, open_tickets, total_tickets, last_ticket_at}`
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
  - filtros: `status` (repetível), `priority` (repetível), `type`, `assignee_id`, `team_id`, `customer_id`, `location_id`, `service_type_id`, `violation_pending=true`, `category_id`, `asset_id`, `q` (título, descrição, número), `mine=true`, `unassigned=true`, `open_only=true`, `sla_breached=true`
  - `page` (1..), `page_size` (1..500, padrão 25), `order_by` ∈ `updated_at, created_at, priority, resolution_due_at, number` com `-` para desc (padrão `-updated_at`)
- `POST /tickets` `TicketCreate` → `TicketDetail` (201)
- `GET /tickets/{id}` → `TicketDetail`
- `PATCH /tickets/{id}` `TicketUpdate` → `TicketDetail`
- `POST /tickets/{id}/assign` `{assignee_id|null, team_id?, note?, expected_version?}` → `TicketDetail`
- `POST /tickets/{id}/take` → `TicketDetail` (atribui ao usuário logado)
- `POST /tickets/{id}/transition` `{to_status, note?, resolution_notes?, scheduled_start?, scheduled_end?, latitude?, longitude?, expected_version?}` → `TicketDetail`
- `GET /tickets/{id}/comments` → `CommentOut[]` · `POST` `{body, is_internal}` → `CommentOut`
- `GET /tickets/{id}/events` → `EventOut[]` (histórico, mais recente primeiro)
- `GET /tickets/{id}/worklogs` → `WorklogOut[]` · `POST` `{description, started_at, ended_at?|minutes?, latitude?, longitude?}`
- `GET /tickets/{id}/attachments` → `AttachmentOut[]` · `POST` multipart `file` + `kind` (`file|photo|signature`)
- `GET /attachments/{id}/download?token=` → arquivo (o `download_url` da listagem já vem assinado, expira em 15 min)

`TicketListItem = {id, number, code:"OS-000123", title, status, priority, type, source, category:{id,name,full_name}|null, customer:{id,name}|null, location:{id,name,code,document,address_line,city,state,latitude,longitude,contact_name,contact_phone}|null, assignee:{id,name,email,role}|null, team:{id,name}|null, requester_name, scheduled_start, scheduled_end, response_due_at, resolution_due_at, first_response_at, resolved_at, sla_paused_at, sla_paused_seconds, created_at, updated_at, version, sla_status}`

`TicketDetail = TicketListItem + {description, impact, urgency, asset:{id,name,asset_type,brand,model,serial_number,asset_tag,ip_address}|null, requester:UserRef|null, requester_contact, service_address, service_type:{id,name,estimated_minutes}|null, estimated_minutes, work_seconds, work_started_at, actual_minutes, created_by:UserRef|null, closed_at, cancelled_at, reopen_count, resolution_notes, allowed_transitions:[status], can_edit, can_assign}`

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
- `GET /reports/sla-violations?days=30` → `{period_days, tickets_total, response, resolution, by_responsibility, pending_justification}`. Cada relógio vem como `{breached, justified, by_reason:[{reason_id, name, responsibility, count}]}`.

### Atividades do dia
Tela própria da operação, como no Field Control (aquela em que, segundo o levantamento, quem opera passa o dia).

- `GET /activities/day?date=YYYY-MM-DD&team_id=&assignee_id=` → `DayActivities {date, timezone, is_today, summary, activities[]}`. Sem `date`, usa o dia de hoje no fuso `TIMEZONE`.
  - Entram no dia: as OS agendadas para ele; as que tiveram deslocamento, atendimento ou conclusão nele (pelo histórico); e, se for hoje, as que estão em campo agora.
  - `Activity = {ticket: TicketListItem, state, scheduled_start, scheduled_end, started_at, arrived_at, finished_at, start_delay_minutes, start_has_gps, service_type_name, estimated_minutes, actual_minutes}`: o previsto e o realizado na mesma linha.
  - `state` ∈ `scheduled` (agendada), `late` (horário passou e não saiu), `en_route`, `in_progress`, `on_hold`, `rescheduled` (teve atividade no dia e foi remarcada), `done` (concluída no dia), `pending` (voltou para a fila).
  - `summary` traz a contagem por `state` e `unassigned`.

### Dashboard
- `GET /dashboard/summary` → `{by_status:{status:n}, by_priority:{priority:n}, open_total, unassigned, sla_breached, sla_at_risk, created_today, resolved_today, avg_resolution_minutes_30d, sla_compliance_30d, by_assignee:[{user_id,name,open,in_progress,breached}]}`

### Sincronização mobile
Ver `docs/MOBILE_SYNC.md`.
- `GET /sync/pull?since=<iso>` → `{server_time, tickets:TicketDetail[], comments, worklogs, revoked_ticket_ids}`
- `POST /sync/push` `{operations:[{client_op_id, type:"transition"|"comment"|"worklog"|"update", ticket_id, payload, client_timestamp?}]}` → `{server_time, results:[{client_op_id, status:"applied"|"duplicate"|"rejected"|"conflict", error?, ticket?}]}`
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
  `no_signal` = em jornada sem posição há mais de 5 min. `GET /tracking/history?user_id=&date=` → pontos do dia e
  as mudanças de status que o técnico fez, com o GPS de cada uma.
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
foto e o perfil da homologação) · `POST /technicians` → `{technician, temporary_password}` · `PATCH /technicians/{id}`
(nome, e-mail, telefone, grupo, cargo, `is_active`; desativar encerra as sessões) ·
`POST /technicians/{id}/reset-password` → `{technician, temporary_password}` (encerra as sessões) ·
`POST|DELETE /technicians/{id}/photo` (JPG/PNG/WebP até 2 MB, tipo conferido pelo conteúdo) ·
`POST /technicians/import?dry_run=true|false` (CSV/XLSX: nome, email, telefone, grupo, cargo) →
`{rows:[{line, action: create|update|error, errors}], created, updated, errors, credentials}` (senhas provisórias só na gravação).

### Importação de locais
`POST /locations/import?dry_run=true|false&customer_id=` (CSV/XLSX) → `{rows, created, updated, errors, customers_created}`.
Colunas: cliente, cnpj_cliente, codigo, local, cnpj, endereco, bairro, cidade, uf, cep, latitude, longitude, contato,
telefone, observacoes. Cliente por CNPJ ou nome (criado se não existir); local por código, CNPJ ou nome (atualiza só o
que veio preenchido). CSV em UTF-8 ou Windows-1252, separado por `;` ou `,`; coordenadas com vírgula decimal.

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
`ticket.comment_added`, `ticket.worklog_added`, `ticket.attachment_added`.
Cada usuário só recebe eventos de OS que pode ver (o técnico, só das OS atribuídas a ele, inclusive a que
acabou de sair dele); notas internas não chegam ao solicitante.

Só para a gestão (analistas, supervisores, admin): `technician.location` `{user_id, name, latitude, longitude, recorded_at}`,
`technician.shift` `{user_id, name, on_shift}` e `onboarding.submitted` `{application_id, name}` (ficha nova na homologação).
O cliente pode mandar `{"type":"ping"}` e recebe `{"type":"pong"}`.
Ao receber um evento, recarregue a OS/lista (o evento não carrega o objeto inteiro).

## Duração da OS

- `estimated_minutes`: copiada do tipo de serviço na abertura (ou informada) e gravada na OS. Corrigir o catálogo depois não muda as OS antigas.
- `work_seconds` / `work_started_at`: a API soma o tempo em `in_progress` a cada mudança de status. O técnico não digita nada.
- `actual_minutes`: duração real, calculada na leitura e incluindo o atendimento em andamento.
- Ao agendar (`scheduled`) só com `scheduled_start`, a API preenche `scheduled_end = início + estimated_minutes`.

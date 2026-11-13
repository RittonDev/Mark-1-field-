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
| Técnico de campo (terceiro) | `technician` | **só as OS atribuídas a ele** (app mobile), e delas **só o básico**: cliente, local (nome e endereço da loja), agenda e escopo; grupo ou fila não bastam | sair, iniciar e concluir a visita, formulários, fotos, assinatura e pedir peça **nas OS dele**. Nunca mexe no horário (agenda, pausa e horas são da central; o tempo dele corre do início à conclusão). Não assume nem se atribui OS: quem coloca o técnico na OS é a gestão. Sem acompanhamentos (a central fala com ele pelo WhatsApp) |
| Solicitante | `requester` | OS que abriu | abrir OS, comentar (público), cancelar enquanto nova, aceitar (fechar) ou recusar (reabrir) solução |

**Técnico é terceiro: só o básico.** Na OS (detalhe, sync e respostas do push) o servidor zera para o
técnico: prazos e motivos de SLA, analista (`owner`), grupo, projeto, categoria, etiquetas, solicitante,
quem abriu, nº do chamado do cliente, CNPJ e contato da loja (nome e telefone: quem fala com a loja é a
central), reincidência e dados migrados (`services/tickets.py::field_view`). E-mail dos colegas e de quem
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
- `GET /locations/{id}` · `PATCH /locations/{id}` · `GET/POST /customers/{id}/locations` (lista sem paginação, para um cliente)
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
  - filtros: `status` (repetível), `priority` (repetível), `type`, `assignee_id`, `team_id`, `customer_id`, `location_id`, `service_type_id`, `violation_pending=true`, `category_id`, `asset_id`, `owner_id`, `no_owner=true`, `q` (título, descrição, número), `mine=true` (analista: executa ou é o responsável), `unassigned=true`, `open_only=true`, `sla_breached=true`
  - `page` (1..), `page_size` (1..500, padrão 25), `order_by` ∈ `updated_at, created_at, priority, resolution_due_at, number` com `-` para desc (padrão `-updated_at`)
- `POST /tickets` `TicketCreate` → `TicketDetail` (201)
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
  - Ordem: pela hora de atuação, a manhã primeiro (a agendada ou, sem agenda, a de início; sem hora no fim),
    e só depois pelo técnico. A tela agrupa por técnico na ordem em que aparecem: quem começa mais cedo
    fica em cima e, dentro do bloco, as OS seguem o relógio.

### Dashboard
- `GET /dashboard/summary` → `{by_status:{status:n}, by_priority:{priority:n}, open_total, unassigned, sla_breached, sla_at_risk, created_today, resolved_today, avg_resolution_minutes_30d, sla_compliance_30d, by_assignee:[{user_id,name,open,in_progress,breached}]}`

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
foto e o perfil da homologação; `q` busca por palavras em nome, e-mail e telefone) · `POST /technicians` →
`{technician, temporary_password}` · `PATCH /technicians/{id}` (nome, e-mail, telefone, grupo, cargo, `is_active`;
desativar encerra as sessões; e a ficha completa: endereço, jornada e serviços, ver "Fichas completas") ·
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

## Módulos de operação (2026-11)

Todos exigem analista ou gestor, salvo indicação. Valores em R$ chegam como número.

- **Formulários:** `GET|POST /form-templates`, `GET|PUT /form-templates/{id}`, `GET /form-templates/catalog`.
  Na OS: `GET /tickets/{id}/forms/suggestions` · `POST /tickets/{id}/forms {template_id, required}` ·
  `PATCH|DELETE /tickets/{id}/forms/{form_id}` · `PUT /tickets/{id}/forms/{form_id}/answers {answers, complete}`
  (técnico responsável ou gestão; respostas gravadas mesmo quando a conclusão falha) ·
  `POST|DELETE /tickets/{id}/forms/{form_id}/photos[/{attachment_id}]` (multipart `file` + `field_id`) ·
  `POST /tickets/{id}/signature` (multipart `file`, `signer_name`, `signer_role?`, `latitude?`, `longitude?`).
  `TicketDetail.forms`, `signature_required`, `signer_*`, `signed_at`. Concluir a OS (resolved/closed) devolve 422 sem os
  obrigatórios ou sem a assinatura exigida. Sync offline: operação `form_answers {form_id, answers, complete}`.
- **Custos extras:** `GET|POST /tickets/{id}/expenses` (técnico só lê; solicitante recebe vazio) · `PATCH|DELETE /expenses/{id}` ·
  `GET /expenses?start&end&technician_id&status&customer_id` (relatório) · `POST /expenses/mark-paid {ids}` ·
  `GET|PUT /settings/expenses {km_rate}` (PUT: supervisor/admin). `TicketDetail.expenses`.
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
  back_in_stock → delivered (e unrepairable/cancelled).
- **Relatórios:** `GET /reports/daily?date=` (sem data: o dia anterior, já fechado) · `GET /reports/monthly?month=AAAA-MM`.
- **Sugestão de técnicos:** `GET /tickets/{id}/technician-suggestions` · `GET /technicians/suggest?city&state&latitude&longitude`
  → `[{id, name, home_city, home_state, open_tickets, on_shift, distance_km, score, reasons[]}]`.
- **Textos do WhatsApp:** `GET /tickets/{id}/messages` → `[{key, name, text}]` já preenchidos com os dados da OS ·
  `GET /message-templates` → `{templates: [{key, name, body}], variables: [{key, description}]}` ·
  `PUT /message-templates {templates}` · `POST /message-templates/reset`. Variáveis desconhecidas ficam como estão;
  `{chegada_prevista}` usa a última posição do técnico na jornada (até 30 min) e cai para o horário agendado.
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
fuso `TIMEZONE`) → `{user, date, generated_at, counts, items}`. Entram as OS em aberto em que a pessoa é
responsável ou executa, mais as concluídas no dia. Cada item é um `TicketListItem` com:
- `section`: `in_field` (em deslocamento/atendimento) → `done` (resolvida/fechada no dia) → `attention`
  (algum motivo `danger`/`warning`) → `today` (agendada no dia) → `waiting` (aguardando cliente/fornecedor)
  → `upcoming` (agendada depois) → `unscheduled`. Os itens vêm nessa ordem de tela: attention (pior primeiro,
  depois prazo), in_field (mais recente), today/upcoming (horário), waiting/unscheduled (prazo), done.
- `reasons: [{code, label, tone}]`: `sla_violated` (danger), `sla_at_risk` (warning), `late_start` (danger,
  agendada que passou do horário sem sair), `no_technician` (warning, sem técnico de campo), `unproductive`
  (warning, improdutiva sem nova agenda), `violation_pending` (info, concluída com SLA a justificar) e as
  regras de campo (ver abaixo): `authorization_pending`, `arrival_late`, `arrival_at_risk`, `onsite_over`,
  `onsite_warning`, `part_request`. Uma OS em campo continua em `in_field`, mas com os motivos.
- `counts`: `open` (em aberto) e o tamanho de cada seção.

`GET /queues` (gestão) → `{queues: [{user, role, open, attention, today, in_field}], unowned: {...}}`: a
fila de cada analista/gestor ativo e as OS sem analista. `attention` conta a seção "atenção" e também as OS em campo
com motivo `danger`/`warning` (ex.: passou do tempo na loja).

**Relatório para o cliente.** Ao concluir (resolvida ou fechada) a OS ganha um link público com o resumo
do atendimento, que o cliente pode salvar em PDF. O token é `<id>.<assinatura HMAC>`: só o id fica no
banco, então o link pode ser copiado de novo a qualquer momento e trocado quando preciso.
- `TicketDetail.report_link` (a gestão sempre; o técnico responsável, com a OS concluída, para enviar
  pelo app): `{token, path: "/relatorio/<token>", url, created_at, views, last_viewed_at}` ou `null`.
- `POST /tickets/{id}/report-link` (gestão ou técnico responsável; cria se não houver; 422 "Disponível
  quando a OS for concluída") ·
  `POST /tickets/{id}/report-link/rotate` (gestão; novo link, o anterior para de funcionar) ·
  `DELETE /tickets/{id}/report-link` (gestão; 204). Nenhum dos três muda a `version` da OS.
- Público, sem login: `GET /public/reports/{token}` → `PublicReport {code, title, description, status,
  status_label, company_name, company {name, document, email, phone, address, website}, customer {name, document}, location {name, code, address, city, state},
  service_address, requester_name, service_type, technician {name}, opened_at, scheduled_start,
  scheduled_end, en_route_at, arrived_at, finished_at, closed_at, on_site_minutes, check_in_gps,
  resolution_notes, forms [{name, completed_at, items [{label, type, value, photos [{url, filename}]}]}],
  photos [{url, filename, taken_at}], signature {name, role, signed_at, image_url}, timeline [{at, label}],
  generated_at}`. Respostas formatadas (Sim/Não, dd/mm/aaaa, vírgula decimal); `type: "section"` é título.
  Fotos com URL absoluta assinada (24 h; base `API_PUBLIC_URL` ou o endereço da requisição). 404 "Link
  inválido ou expirado" (token adulterado, trocado ou revogado); 409 quando a OS foi reaberta. Cada
  visita soma em `views` sem mexer na OS. Nunca inclui acompanhamentos, apontamentos, custos, orçamentos,
  notas internas nem motivos de violação.
- Textos do WhatsApp: variável `{link_relatorio}` (o link da OS concluída; antes disso, "(disponível quando
  a OS for concluída)"), já no texto padrão de Fechamento. `{analista}` agora é o responsável pela OS.
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
- `arrival_status`: `met` | `late` | `at_risk` (falta menos de 1h) | `pending` | `null` (sem prazo, ou OS
  concluída/cancelada sem visita).
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
- O texto padrão de deslocamento termina em "Chegada prevista às {chegada_prevista} (prazo {prazo_chegada})."

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
  cidade), somado a agenda livre, skill, equipe do projeto e carga. Só técnicos **ativos**. O formato não
  mudou; `home_city`/`home_state` passam a trazer a região efetiva (a base, senão o endereço).
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

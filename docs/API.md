# Contrato da API — MaxxChamados

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
| Técnico de campo | `technician` | OS atribuídas a ele, do seu grupo e a fila sem grupo (app mobile) | assumir OS sem responsável, mudar status das OS dele/do grupo, comentar, apontar horas, fotos, cadastrar ativos |
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

### Meta
- `GET /meta` → `{statuses:[{value,label,group,color,sla_paused,final,requires_assignee,description}], transitions:{status:[status]}, priorities:[{value,label,code,color}], priority_matrix:[{impact,urgency,priority}], ticket_types, sources, asset_types, roles, impacts, urgencies, access_channels:{web:[role], mobile:[role]}}` (`ticket_types`…`urgencies` como `[{value,label}]`)

### Usuários e grupos
- `GET /users?role=&team_id=&q=&active=` → `UserOut[]`
- `GET /users/assignable?team_id=` → `[{id,name,role,team_id,team_name,open_tickets}]` (analistas, técnicos e supervisores ativos, com carga)
- `POST /users` (admin) `UserCreate` → `UserOut`
- `GET /users/{id}` · `PATCH /users/{id}` (admin) `UserUpdate`
- `GET /teams` → `TeamOut[]` · `POST /teams` · `PATCH /teams/{id}` (admin/supervisor)

`UserOut = {id,name,email,phone,role,job_title,team_id,team:{id,name}|null,is_active,last_login_at,created_at}`

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

### OS / Chamados
- `GET /tickets` → `Page<TicketListItem> {items,total,page,page_size}`
  - filtros: `status` (repetível), `priority` (repetível), `type`, `assignee_id`, `team_id`, `customer_id`, `location_id`, `category_id`, `asset_id`, `q` (título, descrição, número), `mine=true`, `unassigned=true`, `open_only=true`, `sla_breached=true`
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

`TicketDetail = TicketListItem + {description, impact, urgency, asset:{id,name,asset_type,brand,model,serial_number,asset_tag,ip_address}|null, requester:UserRef|null, requester_contact, service_address, created_by:UserRef|null, closed_at, cancelled_at, reopen_count, resolution_notes, allowed_transitions:[status], can_edit, can_assign}`

`CommentOut = {id, ticket_id, author:UserRef|null, body, is_internal, created_at}`
`EventOut = {id, ticket_id, actor:UserRef|null, event_type, from_value, to_value, note, data, created_at}` — `event_type` ∈ `created, updated, status_changed, assigned, comment_added, worklog_added, attachment_added`
`WorklogOut = {id, ticket_id, user:UserRef|null, description, started_at, ended_at, minutes, latitude, longitude, created_at}`
`AttachmentOut = {id, ticket_id, filename, content_type, size_bytes, kind, uploaded_by, created_at, download_url}`

**Concorrência:** toda OS tem `version`. Envie `expected_version` em PATCH/assign/transition;
se outra pessoa (web ou app) alterou antes, a API responde **409** e o cliente recarrega.

### Dashboard
- `GET /dashboard/summary` → `{by_status:{status:n}, by_priority:{priority:n}, open_total, unassigned, sla_breached, sla_at_risk, created_today, resolved_today, avg_resolution_minutes_30d, sla_compliance_30d, by_assignee:[{user_id,name,open,in_progress,breached}]}`

### Sincronização mobile
Ver `docs/MOBILE_SYNC.md`.
- `GET /sync/pull?since=<iso>` → `{server_time, tickets:TicketDetail[], comments, worklogs, revoked_ticket_ids}`
- `POST /sync/push` `{operations:[{client_op_id, type:"transition"|"comment"|"worklog"|"update", ticket_id, payload, client_timestamp?}]}` → `{server_time, results:[{client_op_id, status:"applied"|"duplicate"|"rejected"|"conflict", error?, ticket?}]}`
- `POST /devices` `{platform:"ios"|"android"|"web", token, app_version?}` · `DELETE /devices/{token}`

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
Cada usuário só recebe eventos de OS que pode ver; notas internas não chegam ao solicitante.
O cliente pode mandar `{"type":"ping"}` e recebe `{"type":"pong"}`.
Ao receber um evento, recarregue a OS/lista (o evento não carrega o objeto inteiro).

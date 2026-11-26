# Contrato da API — Maxx Field (MaxxChamados)

Base: `http://localhost:8000/api/v1` · JSON · datas em ISO-8601 com fuso (UTC) · IDs são UUID.
OpenAPI interativo: `http://localhost:8000/docs`.

Autenticação: `Authorization: Bearer <access_token>`. Erros seguem `{"detail": "mensagem"}`
(422 de validação do FastAPI traz `detail` como lista). Códigos: 401 sem token/expirado,
403 sem permissão, 404 não encontrado, 409 conflito de versão, 422 regra de negócio/validação.
Os erros em que a tela reage por um código trazem também `code` (`{"detail", "code"}`): os do acesso
(`MODULE_FORBIDDEN`...), das ofertas (`OFFER_*`), do conflito de agenda e, desde 25/11/2026, os de `CodedError`
(`services/errors.py`, com o status dele: `LINK_GONE`, `MAIL_DISABLED`, `CEP_NOT_FOUND`, `PAYOUT_METHOD_DUPLICATE`...;
ver [Cadastro V2](#cadastro-v2-2026-11-25)).

Valor que o banco recusa (SQLSTATE da classe 22, "data exception": texto maior que a coluna, U+0000 num texto que vai
ao banco como está) responde 422 em qualquer rota, com um aviso no log (o SQLSTATE, sem traceback):
`{"detail": "Algum valor está fora do tamanho ou do formato aceito. Confira os campos."}`. O asyncpg entrega esses
erros como `DBAPIError` genérico, e o handler de `main.py` decide pelo SQLSTATE (desde 24/11/2026; antes, a API respondia
500 nesses casos). Registro repetido e referência que não existe (`IntegrityError`) continuam 409 com a mensagem da
restrição; os outros erros do banco seguem como erro não tratado: 500 `{"detail": "Erro interno. Tente de novo; se
continuar, avise a central."}` e o log "Erro não tratado em …". O erro do banco vai para o log com o SQL sem os
valores (`hide_parameters` em `db/session.py`, também no `DB_ECHO`), que levariam dados pessoais (nome, contato,
formação, chave PIX).

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
atividades do dia, catálogo (exceto motivos de violação e de visita improdutiva e o ferramental,
`GET /technician-tools`, que ele recebe só com as ferramentas ativas), listagem de OS e histórico da OS respondem 403
para ele (`NoTechnicianUser` / `TicketManagerUser`). No WebSocket ele
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
  - Limite: a tentativa conta antes de conferir a senha, então pedidos em paralelo não furam o limite. São 5 em 15 min, somando as do Meu cadastro do técnico (e-mail, dados da empresa e formas de recebimento); a partir da 6ª sai 429 com `Retry-After`, sem conferir a senha. A senha certa zera a conta.
  - Técnico: grava no histórico do cadastro (via app, autor o técnico) `password` "criada no app" (era a provisória) ou "trocada no app", e sai `profile.changed` com `fields: ["password"]` via app (só atualiza as listas da central). Ver [Meu cadastro do técnico](#meu-cadastro-do-técnico-2026-11-18).
  - Desde 25/11/2026, a troca também invalida os links de nova senha mandados por e-mail e ainda não usados.
- **Esqueci minha senha e os links do e-mail** (sem login, desde 25/11/2026): `POST /auth/forgot-password` `{email}` →
  202; `POST /auth/password-reset/check` `{token}` → `PasswordResetCheck`; `POST /auth/password-reset`
  `{token, password}` → `PasswordResetDone`; `POST /auth/verify-email` `{token}` → `VerifyEmailResult`. O token chega
  no corpo (a página o lê do `#token=` do link). Ver [Cadastro V2](#cadastro-v2-2026-11-25).
- **Sessões encerradas:** tokens emitidos antes de `sessions_revoked_at` (troca/redefinição de senha, desativação) recebem **401** "Sessão encerrada" na API, no refresh e no WebSocket (fecha com 4401). Trate como logout.
- `GET /auth/providers` → `{microsoft, password_for_staff, microsoft_domains}` (tela de login).
- **Login Microsoft (Entra ID), só gestão:** o navegador abre `GET /auth/microsoft/start` (302 para a Microsoft, com PKCE). A volta `GET /auth/microsoft/callback` redireciona para `WEB_URL/login/microsoft#code=<código de uso único, 60 s>` ou `WEB_URL/login?sso_error=<not_registered|domain_not_allowed|wrong_tenant|role_not_allowed|inactive|account_mismatch|cancelled|invalid_state|invalid_token|provider_error>`. O site troca o código em `POST /auth/microsoft/exchange` `{code}` → `TokenResponse`. Com `ENTRA_ENFORCE_FOR_STAFF`, analistas e gestores do domínio recebem 403 no login com senha.

### Meta
- `GET /meta` → `{statuses:[{value,label,group,color,sla_paused,final,requires_assignee,description}], transitions:{status:[status]}, priorities:[{value,label,code,color}], priority_matrix:[{impact,urgency,priority}], ticket_types, sources, asset_types, roles, impacts, urgencies, access_channels:{web:[role], mobile:[role]}, mail_enabled}` (`ticket_types`…`urgencies` como `[{value,label}]`; `mail_enabled`, desde 25/11/2026: o envio de e-mail está ligado, com `SMTP_HOST` e `MAIL_FROM`; a central usa para mostrar "Não enviado" e oferecer o WhatsApp e a senha provisória)

### Usuários e grupos
- `GET /users?role=&team_id=&q=&active=` → `UserOut[]`
- `GET /users/assignable?team_id=` → `[{id,name,role,team_id,team_name,open_tickets,operational_status,operational_reason,unavailability}]`
  (analistas, técnicos e supervisores ativos, com carga; o técnico, só com o acesso ao app liberado; desde 25/11/2026, ele vem com a situação na
  operação, o motivo só fora de Ativo, e os períodos de indisponibilidade que não terminaram: a web trava Inativo e
  Bloqueado e avisa a indisponibilidade; ver [Cadastro V2](#cadastro-v2-2026-11-25))
- `POST /users` (admin) `UserCreate` → `UserOut`
- `GET /users/{id}` · `PATCH /users/{id}` (admin) `UserUpdate` (desativar o técnico ou tirar dele o papel
  `technician` fecha as ofertas de OS em aberto dele: ver [Ofertas de OS](#ofertas-de-os-2026-11-18); desativar ou
  definir a senha invalida os links de nova senha mandados por e-mail; trocar o e-mail de um técnico troca o login na
  hora e manda a validação para o novo, como em Técnicos)
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
    ou quem já foi o responsável antes de uma troca, inclusive no histórico importado do FC, pelo `data.technician_id` do
    evento; o nome só vale no evento sem esse id; trocar o nome do técnico não tira a OS da busca, salvo nas atribuições
    antigas do FC que ficaram sem o id: nome repetido, também entre papéis, ou sem casamento; `assignee_id` continua
    sendo só o atual)
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
  `forms: [{template_id, required}] | null` (até 20) e `forms_left_out: uuid[] | null` (até 20, só vale com `forms`): os
  formulários, gravados junto com a OS.
  - Sem `forms` (omitido ou `null`): entram os ligados ao tipo de OS e à categoria ([Formulários](#módulos-de-operação-2026-11)),
    como obrigatórios ou opcionais pelo `default_required` de cada modelo, sem autor no histórico e com o motivo.
    `forms_left_out` é ignorado.
  - Com `forms` (uma lista, mesmo vazia): ela, na ordem, com quem abriu como autor (os da lista que são ligados ficam com
    `auto_attached`: saem sozinhos se o tipo ou a categoria mudarem antes da visita). Em `forms_left_out` a Nova OS manda
    todos os formulários que o analista tirou (desmarcou ou pôs e tirou), até 20, sem filtrar pelos vínculos que a tela
    conhece. A API considera só os ligados ao tipo de OS ou à categoria e ignora o resto (o não ligado, o inativo, o id
    desconhecido e o que também está em `forms`): esses ligados vão para `created.data.forms_left_out` e não entram
    sozinhos depois. Os ligados que não vieram em nenhuma das duas listas (a tela não conhecia o vínculo) entram depois
    da lista como automáticos (`auto_attached`), pelo `default_required`, sem autor e com o motivo.
  - `forms` sem `forms_left_out` (ou com `null`, a Nova OS anterior a ele): todos os ligados fora da lista ficam de fora e
    vão para `created.data.forms_left_out`.
  - O `PATCH /tickets/{id}` não tem os dois campos.
  - 422 "Formulário repetido na lista", "Modelo de formulário não encontrado" ou "Modelo de formulário inativo: {nome}"
    antes de gravar: a OS recusada não gasta número. O portal não usa (a solicitação nasce sem tipo e sem categoria).
  - Na web, a Nova OS manda as duas listas sempre que tem os modelos, mesmo sem a lista de categorias (sem os modelos, vai
    sem elas). O `template_id` enviado que não volta em `TicketDetail.forms` (API anterior à lista na abertura) aparece
    no resumo da OS criada como "Formulários que não entraram: …".
- `GET /tickets/{id}` → `TicketDetail`
- `PATCH /tickets/{id}` `TicketUpdate` → `TicketDetail`. Efeitos da troca do tipo de OS (`service_type_id`):
  - a categoria acompanha: vazia, ou a padrão do tipo anterior, passa a ser a padrão do novo (`null` se ele não tem). A
    escolhida à mão fica, `category_id` no mesmo corpo vence e tirar o tipo não mexe na categoria;
  - antes da visita (`new`, `triage`, `assigned`, `scheduled` ou `en_route`, sem chegada), trocar o tipo ou a categoria
    reconcilia os formulários: entram os ligados que faltam, menos os que uma pessoa tirou da OS (`form_removed` com autor)
    ou deixou de fora na abertura; saem só os que entraram sozinhos (`auto_attached`), não casam mais e ninguém começou
    (pendente, sem resposta e sem foto), com `note` "Saiu com a troca do tipo de OS" (ou "da categoria", ou "do tipo de OS
    e da categoria"). Posto à mão, respondido ou de modelo desativado nunca sai (só uma pessoa tira). A exigência de
    assinatura acompanha e entra no `changes` do `updated`; o `ticket.updated` leva `"forms"` em `fields` quando algum
    formulário entrou ou saiu. Depois da chegada, em OS pausada, reaberta, concluída ou cancelada, nada muda sozinho.
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

`TicketDetail = TicketListItem + {description, impact, urgency, asset:{id,name,asset_type,brand,model,serial_number,asset_tag,ip_address}|null, requester:UserRef|null, requester_contact, service_address, service_type:{id,name,estimated_minutes}|null, estimated_minutes, work_seconds, work_started_at, actual_minutes, created_by:UserRef|null, closed_at, cancelled_at, reopen_count, resolution_notes, open_offers, next_offer_expires_at, accepted_offer, allowed_transitions:[status], can_edit, can_assign}`
(`open_offers`: ofertas da OS esperando o técnico responder, pendentes e no prazo; toda a gestão recebe o número,
e o técnico recebe 0. `next_offer_expires_at`: o menor `expires_at` entre essas ofertas, null se nenhuma tem prazo;
sem valor, para toda a gestão; o técnico recebe null. Sem rotina de vencimento, a web relê a OS nesse horário.
`accepted_offer`: `{accepted_at, scope_read_at|null}` da oferta aceita pelo responsável atual (a mais recente, se ele
aceitou mais de uma vez; a mesma consulta do `open_offers`), sem valor, para toda a gestão; null sem ela, e o técnico
recebe null. Ver [Ofertas de OS](#ofertas-de-os-2026-11-18).)

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
  - `responsibility` ∈ `internal`, `customer`, `third_party`, `technician` (o técnico; nos motivos de visita
    improdutiva é o que pesa no elo dele, ver [Elo dos técnicos](#elo-dos-técnicos-2026-11-18)). O
    `by_responsibility` do relatório traz as quatro chaves.
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
- `POST /devices` `{platform:"ios"|"android"|"web", token, app_version?}` → `200 {push:"live"|"simulated"}` (`live`: o provedor entrega push a essa plataforma e o app não repete o aviso com notificação própria; hoje sempre `simulated`, o push ainda não está ligado) · `DELETE /devices/{token}` → 204 (404 para token de outro usuário)

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
versão do aviso de privacidade; o app usa as `skill_suggestions` nas sugestões das Aptidões) ·
`GET /public/onboarding/{token}` → `{valid, expires_at}` ·
`POST /public/onboarding/{token}` (ficha + `password` + `privacy_consent: true` + `photo` em data URL) →
`{protocol, email_verification}` (desde 25/11/2026, a ficha traz também telefone secundário, RG, o endereço em partes,
mini biografia, empresa e veículo, e o link de validação do e-mail vai para a fila: ver
[Cadastro V2](#cadastro-v2-2026-11-25));
410 se o link expirou, foi cancelado ou já usado; 422 com CPF/UF/e-mail inválido ou e-mail ou CPF já cadastrado. E-mail de
domínio da empresa (`ENTRA_ALLOWED_DOMAINS`, o domínio exato): 422 "Use um e-mail que não seja da empresa", antes da
checagem de e-mail já usado, e o link não é gasto. Cada código de `service_areas` e de `availability` tem até 32
caracteres (os de hoje têm até 16): maior, 422 "No máximo 32 caracteres", sem o valor na resposta, e o link não é gasto;
o código desconhecido dentro do limite continua na mensagem ("Área desconhecida: …", "Disponibilidade desconhecida: …").
Gestão: `GET|POST /onboarding/invites` (`{label?, reusable, days_valid}`; o `token` só aparece na criação) ·
`DELETE /onboarding/invites/{id}` · `GET /onboarding/applications?status=` · `GET /onboarding/applications/pending-count` ·
`GET /onboarding/applications/{id}` (com `photo_url` assinado; desde 25/11/2026, também `has_password`, `reviews`,
`reopened_by` e `purge_at`) · `POST .../{id}/approve` (num passo, corpo opcional `{team_id?, job_title?, note?}`; a web
manda `{}`) → `ApplicationApproved {technician: UserOut, welcome: EmailQueued}` (o técnico entra com o e-mail e a senha
da ficha e com tudo o que ela coletou, o perfil técnico já vem com a disponibilidade, o transporte e as aptidões da
ficha, ver [Perfil técnico](#perfil-técnico-2026-11-19), e a boas-vindas vai para a fila) ·
`POST .../{id}/reject {reason}` · `POST .../{id}/reopen {reason}` (a reprovada volta para análise) ·
`POST .../{id}/email-verification` (reenvia a validação do e-mail da ficha). As regras de 25/11/2026 estão em
[Cadastro V2](#cadastro-v2-2026-11-25).

### Técnicos (gestão do acesso)
Analistas e gestores, e só sobre usuários técnicos: `GET /technicians?q=&team_id=&active=&state=&city=&tool_id=&day=&period=`
(com jornada, OS abertas, foto, as áreas da ficha aprovada e o resumo do perfil técnico; `q` busca por palavras em
nome, e-mail e telefone; `on_shift` é a jornada aberta e dentro do limite de 14 h, a mesma regra do mapa: a esquecida
aberta não fica "em jornada"; `tool_id`, `day` e `period` filtram pelo perfil técnico, ver
[Perfil técnico](#perfil-técnico-2026-11-19); paginada por `limit`, 1 a 5000, padrão 2000, e `offset`, com o total
do filtro no cabeçalho `X-Total-Count`) · `POST /technicians` →
`{technician, temporary_password}` · `PATCH /technicians/{id}` (nome, e-mail, telefone, grupo, cargo, `is_active`;
desativar encerra as sessões, fecha as ofertas de OS em aberto dele e invalida os links de nova senha; e a ficha
completa: endereço, jornada e serviços, ver "Fichas completas"; desde 25/11/2026, também CPF, RG, nascimento, telefone
secundário, mini biografia, número, complemento e empresa, e trocar o e-mail troca o login na hora e manda a
validação, ver [Cadastro V2](#cadastro-v2-2026-11-25)) ·
`POST /technicians/{id}/reset-password` → `{technician, temporary_password}` (encerra as sessões e invalida os links
de nova senha) ·
`POST|DELETE /technicians/{id}/photo` (JPG/PNG/WebP até 2 MB, tipo conferido pelo conteúdo; a anterior sai do disco
quando ninguém mais usa; o DELETE tira também a foto do Field Control) ·
`POST /technicians/import?dry_run=true|false` (CSV/XLSX: nome, email, telefone, grupo, cargo) →
`{rows:[{line, action: create|update|error, errors}], created, updated, errors, credentials}` (senhas provisórias só na gravação).
Um técnico e o histórico do cadastro (em páginas, pelo `before`; desde 25/11/2026, `field` filtra um campo)
(`GET /technicians/{id}`, `GET /technicians/{id}/changes`): ver
[Meu cadastro do técnico](#meu-cadastro-do-técnico-2026-11-18). A remoção da chave PIX (`DELETE /technicians/{id}/pix`)
saiu em 25/11/2026: as formas de recebimento ficam em `GET`/`DELETE /technicians/{id}/payout-methods` (Pagamentos).
Também desde 25/11/2026: a situação na operação (`POST /technicians/{id}/operational-status`), os e-mails da central
(`POST /technicians/{id}/email-verification` e `/password-reset-link`, `GET /technicians/{id}/emails`) e os campos novos
de `TechnicianOut` (situação, indisponibilidade, e-mail validado ou pendente, formas de recebimento e, só no detalhe, os
dados pessoais, a empresa e o veículo; saíram `has_pix` e `pix_updated_at`): ver [Cadastro V2](#cadastro-v2-2026-11-25).
`TechnicianOut.skills` passou a vir do perfil técnico (`users.skills`, com o "desde"; as da ficha aprovada foram
copiadas na migração), e a lista traz o resumo do perfil técnico; `GET /technicians/{id}` e as outras respostas de
um técnico trazem também o detalhe (ferramentas, formação e a data de cada parte): ver
[Perfil técnico](#perfil-técnico-2026-11-19). `TechnicianOut.level` (o selo do elo) e as rotas
`/technicians/{id}/level` e `/technicians/{id}/stats`: ver [Elo dos técnicos](#elo-dos-técnicos-2026-11-18) e
[Perfil do técnico: estatísticas e histórico](#perfil-do-técnico-estatísticas-e-histórico-2026-11-19).

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
`technician.shift` `{user_id, name, on_shift}` (esses dois só com o Mapa ao vivo), `onboarding.submitted` `{application_id, name}`
(ficha nova na homologação), `onboarding.updated` `{application_id, name, data: {action}}` (desde 25/11/2026: a ficha
teve o e-mail validado, foi reaberta, aprovada ou reprovada; só com Homologação) e `profile.changed` `{user_id, name,
actor_id, actor_name, occurred_at, data: {fields, via, after_reset?}}` (cadastro do técnico alterado no app, pela
central, pela aprovação da ficha ou pelo link do e-mail, inclusive o perfil técnico; só com Técnicos ou Pagamentos: ver
[Meu cadastro do técnico](#meu-cadastro-do-técnico-2026-11-18) e [Cadastro V2](#cadastro-v2-2026-11-25)).
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
  - **Entram sozinhos** (2026-11-18). O modelo ativo entra na OS cujo tipo de OS está em `service_type_ids` ou cuja
    categoria, ou qualquer uma acima dela (até 10 níveis), está em `category_ids`: ligar à categoria-mãe vale para as
    subcategorias, e tipo e categoria somam. Entra como obrigatório ou opcional pelo `default_required` (padrão `true`); o
    obrigatório que pede assinatura liga `signature_required`. Quando: na abertura (sem lista, ou os ligados que a Nova OS
    não trouxe nem desmarcou: ver `forms_left_out` em `POST /tickets`), na troca do tipo ou da categoria antes da visita
    (`PATCH /tickets/{id}`) e com "Levar também às OS que ainda não começaram" no modelo. Os eventos `form_added` desses
    vêm sem autor ("Sistema"), com `note` 'Pelo tipo de OS “{nome}”' ou 'Pela categoria “{nome completo}”' e
    `data {form_id, template_id, required, auto}`; `form_removed` leva `data.template_id` (os antigos, só com `form_id`,
    ganharam o `template_id` na migração `e4b6d8f0a2c3` quando o nome é de um modelo só: a remoção feita por uma pessoa
    antes da subida também não volta sozinha). Modelo desativado não entra mais. As OS que já têm o formulário continuam
    com ele: a troca do tipo ou da categoria antes da visita não o tira, nem salvar o modelo com "Levar também…" (modelo
    inativo não entra nem sai); só uma pessoa tira.
  - `FormTemplate` ganha `category_ids: uuid[]` (as categorias ligadas; id de categoria apagada é ignorado) e
    `default_required`. No POST, omitidos valem `[]` e `true`; no PUT, omitidos (ou `null`) mantêm o que o modelo tem.
  - `POST /form-templates?apply_to_pending=true` e `PUT /form-templates/{id}?apply_to_pending=true`: além do `applied_to`
    (PUT: a versão nova nas cópias que ninguém começou), os vínculos valem nas OS antes da visita: `attached_to` (em
    quantas o formulário entrou: casam e não o têm, menos onde uma pessoa tirou ou deixou de fora na abertura) e
    `detached_from` (de quantas saiu: entrou sozinho, não casa mais e ninguém começou; `note` "O modelo não está mais
    ligado ao tipo nem à categoria desta OS"). O POST devolve só `attached_to`; sem a opção, os três vêm `null`. Cada
    OS alterada ganha o histórico e um `ticket.updated` `{fields: ["forms"]}`. Salvar só os vínculos (ou o padrão de
    obrigatório) não sobe a `version`.
  - `GET /form-templates/{id}/usage` (Formulários, ver) → `{service_types: [{id, name, customer: {id, name}|null, used,
    total}]}`: os tipos de OS ativos em que o modelo está em pelo menos 3 OS e em pelo menos metade das OS do tipo, nos
    últimos 12 meses (OS não canceladas), os 10 mais usados. Serve para ligar os modelos migrados, que chegam sem vínculo.
  - `GET /tickets/{id}/forms/suggestions`: os modelos ativos ligados ao tipo e à categoria da OS (com as de cima) que ainda
    não estão nela.
  - `TicketFormOut` ganha `auto_attached` (entrou sozinho) e `prefill`.
  - **Resposta automática:** `FormField.prefill` (`null`: a pergunta é do técnico) liga a pergunta a um dado da OS que o
    técnico já vê: `location_name`, `location_code`, `customer`, `address` (o endereço do atendimento; sem ele,
    "rua, bairro, cidade-UF" da loja), `city` ("cidade-UF"), `ticket_code` (OS-000123), `technician`, `service_type` e
    `visit_date`. Texto e texto longo aceitam todas; data, só `visit_date` (combinação inválida volta `null`). O modelo
    grava `prefill` só quando preenchido. `GET /form-templates/catalog` traz `prefill_sources: [{key, label, types}]`.
    - `visit_date` é o dia local da visita, pela mesma regra ao vivo e na conclusão do formulário (a resposta gravada é
      a que a pergunta mostrava):
      - em atendimento (`in_progress`): `work_started_at`, o início do trecho atual (na volta ao local, o dia da volta);
        na OS do Field Control em atendimento, sem ele, `arrived_at`;
      - resolvida ou fechada: `resolved_at` (sem ele, `closed_at`), também quando a central conclui o formulário depois;
      - sem chegada ainda (`arrived_at` nulo): `scheduled_start`, a visita agendada;
      - nos outros casos (pausada, a caminho depois de uma chegada, reaberta sem nova ida, improdutiva depois da
        chegada): não vem, nem na conclusão. A pergunta opcional fica sem resposta e a obrigatória precisa ser digitada.
    - No POST do modelo, a pergunta sem a chave `prefill` é do técnico. No `PUT /form-templates/{id}`, a pergunta enviada
      sem a chave mantém a fonte gravada na pergunta de mesmo `id` (se o tipo ainda aceitar a fonte), sem subir a versão
      por isso; `prefill: null` explícito limpa. O construtor da web sempre manda a chave (uma aba aberta antes da
      resposta automática não apaga a fonte).
  - `TicketFormOut.prefill` = `{campo: valor}` das perguntas com fonte e ainda sem resposta (valor vazio não entra), ao
    vivo enquanto o formulário não está concluído (vem em `TicketDetail.forms`, no sync e nas rotas do formulário). A
    conclusão grava nas respostas, antes de conferir os obrigatórios, o mesmo valor que a pergunta mostrava, sem consulta
    a mais (sem data da visita, a pergunta de data fica sem resposta; se for obrigatória, a conclusão volta 422 "Falta
    preencher: …"); depois disso, trocar o técnico ou remarcar não muda nada e `prefill` vem `{}`. O técnico pode
    corrigir: o app trata `{...prefill, ...answers}` como a resposta do servidor e manda tudo ao salvar.
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
  - a atribuição de cada atividade vira `assigned` com `to_value` = nome do colaborador e
    `data {source: "fieldcontrol", task, technician_id}` (`technician_id` quando o colaborador veio no export). A migração
    `e4b6d8f0a2c3` (só dados) preencheu o `technician_id` das atribuições antigas quando o nome é de um usuário só e ele
    é técnico (o nome repetido, também entre um técnico e um usuário de escritório, fica sem o id), e o `template_id` dos
    `form_removed` antigos (só com `form_id`) quando o nome é de um modelo só. A busca "técnico que atuou" usa o id; o
    nome só vale no evento sem ele;
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
    operational_status, avatar_url, base_city, base_state, base_source, distance_km, nearest_kind (store_history | home |
    live), visits_at_location, last_visit_at_location, visits_in_city, total_visits, last_visit_at,
    open_tickets, on_shift, reasons[]}]}`, do mais perto para o mais longe (empate: mais visitas à loja).
    `operational_status` (desde 25/11/2026): Inativo e Bloqueado aparecem, com o selo na web, e não recebem OS.
  - `reasons`, por exemplo: "Atendeu esta loja 5x (última em 03/10/2026)", "Em jornada agora a 4 km",
    "Já atendeu a 1,2 km daqui", "Mora a 3 km", "Base em Fortaleza-CE (128 OS)", "3 OS abertas agora",
    "Inativo no app".
  - Erros (422): "A loja não tem coordenadas"; "Não há lojas com coordenadas em {cidade}-{UF} para
    calcular a distância"; sem ponto: "Informe a loja, as coordenadas ou a cidade com o estado". Loja
    inexistente: 404.
- **Sugestões da OS** (`GET /tickets/{id}/technician-suggestions` e `GET /technicians/suggest`): usam o
  mesmo cálculo (distância pelo histórico/endereço/ao vivo, visitas a esta mesma loja e a base na
  cidade), somado a agenda livre, skill, equipe do projeto e carga. Só técnicos com acesso ao app e, desde 25/11/2026,
  **Ativos** na operação e sem período de indisponibilidade nos dias da visita (OS sem horário: hoje); as áreas de
  atuação são as do cadastro (`users.service_areas`; vazias, as da ficha aprovada): ver
  [Cadastro V2](#cadastro-v2-2026-11-25).
  `home_city`/`home_state` trazem a região efetiva (a base, senão o endereço). Os favoritos da cidade da loja
  ganham pontos e vaga garantida (ver "Técnicos favoritos por cidade"). Com horário na OS, a disponibilidade que o
  técnico informou no app soma ou tira poucos pontos (`availability`, `availability_gaps` e o motivo "Fora da
  disponibilidade (sáb · tarde)"): ver [Perfil técnico](#perfil-técnico-2026-11-19).
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
- Os sem acesso ao app entram na regra e aparecem na lista (com o "Liberar acesso"), mas nunca nas sugestões da OS.
- Situação na operação (desde 25/11/2026): Inativo e Bloqueado ficam no ranking, mas fora dos automáticos (o
  próximo Ativo sobe); o fixado pela central continua, com o selo. `FavoriteTechnician` ganha `operational_status`.

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
  colaboradores, não entra). Desde 25/11/2026, `address_line` é só o logradouro, com `address_number` e
  `address_complement` no detalhe (a migração separou as linhas "rua, número - complemento"): ver
  [Cadastro V2](#cadastro-v2-2026-11-25).
- `work_schedule: {start, end, break_start, break_end} | null`, com horários em `"HH:MM:SS"`.
- `services: [{id, name}]`: os tipos de serviço que ele faz (as skills do Field Control).
- `legacy: {source, id, territories: [nome]} | null`.
- `avatar_url`: a foto enviada aqui (link assinado) ou, sem ela, a foto que veio do Field Control.

`PATCH /technicians/{id}` aceita também:
- `address_line`, `address_number`, `address_complement`, `address_district` e `address_zip` (o CEP é gravado como
  `00000-000`);
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
- `GET /payouts?technician_id=&status=pending|paid&concluded=&date_from=&date_to=&with_payout_methods=` (gestão) →
  `{items, summary, total_count, payout_methods}` com `summary = {to_pay (OS concluídas), expected (OS abertas), paid}`;
  o período vale pela conclusão da OS. Com `with_payout_methods=true`, `payout_methods` traz, por técnico, a forma de
  recebimento preferencial (inteira, para quem paga copiar) e quantas formas ele tem (ver
  [Cadastro V2](#cadastro-v2-2026-11-25)); sem ele, `{}`. Até 24/11/2026 eram `with_pix` e `pix` (a chave PIX única).
- `POST /payouts/pay` e `POST /payouts/unpay` `{ids}` → `{changed}`. Pagar o último valor pendente de uma OS tira dela as
  etiquetas `remove_on_payout_paid` (ex.: "Pendente Envio PGTO"); desfazer o pagamento não traz de volta. O pagamento
  grava no histórico da OS a forma de recebimento preferencial daquele momento, mascarada (`data.payout_method`; antes
  de 25/11/2026, `data.pix`); sem forma, o pagamento sai do mesmo jeito.
- `GET /me/earnings?month=AAAA-MM` (técnico; os outros papéis: 403 "Só para técnicos") → os chamados dele (até 1.000,
  com `total_count` = quantos batem com o filtro), o resumo e os reembolsos (custos extras aprovados a receber e
  pagos no mês). É o mês do Faturamento do app (`/faturamento/AAAA-MM`). Mês fora de AAAA-MM ou de 2000–2100: 422
  "Mês inválido (use AAAA-MM)".
- `GET /me/earnings/months` (técnico): os meses do Faturamento, ver [Faturamento do app](#faturamento-do-app-2026-11-19).
- `PayoutLine.invoice` (`{id, number, status}` ou null), em `GET /payouts` e `GET /me/earnings`: a nota fiscal do
  técnico que cobre o valor (ver [Notas fiscais dos técnicos](#notas-fiscais-dos-técnicos-2026-11-18)).
- Mudar o valor ou pagar marca a OS como alterada (`updated_at`), para o app do técnico baixar de novo.

### Faturamento do app (2026-11-19)

**Por quê.** A aba Faturamento do app (substitui o Ganhos) mostra o total pago, o que falta receber e um cartão por
mês de conclusão com a situação, calculada aqui para o app não repetir a regra. Tocar no mês abre o mês de
`GET /me/earnings?month=` com as notas fiscais dele; o "Outro mês" da aba abre qualquer mês, de 2000-01 ao atual (também
os que não têm cartão). Código: `services/payouts.py` (`MONTHS_DEFAULT`, `MONTHS_MAX`,
`shift_month`, `month_state`, `my_earnings_months`), `schemas/payout.py` e `api/routes/payouts.py`. Só leitura.

**`GET /me/earnings/months?months=12`** (papel `technician`; gestão e cliente: 403 "Sem permissão para esta ação").
`months` de 1 a 24 (padrão 12; fora: 422 de validação) → `EarningsMonths {since, until, totals, months}`:
- `until` = o mês atual no fuso da operação e `since` = o primeiro mês da janela ("AAAA-MM"). `months` traz **todos**
  os meses da janela, o mais novo primeiro, também os sem valor (`empty`: o app só mostra o que tem nota da
  competência, `invoices` maior que 0).
- `EarningsMonth {month, state, count, total, to_pay, expected, paid, due_without_invoice, due_in_review, due_checked,
  paid_without_invoice, last_paid_at, rejection, invoices}`. Cada balde é `{count, amount}` (quantos valores e a soma):

  | Balde | Valores do técnico no mês |
  |---|---|
  | `to_pay` (a receber) | pendentes de OS resolvida ou fechada |
  | `expected` (previsto) | pendentes de OS em andamento |
  | `paid` (pago) | pagos (também os de OS cancelada que a central pagou) |
  | `due_without_invoice`, `due_in_review`, `due_checked` | partes do `to_pay`: sem nota dele, com a nota aguardando conferência e com a nota conferida |
  | `paid_without_invoice` | parte do `paid` sem nota dele |

  `count` = `to_pay.count + expected.count + paid.count`; `total` = a soma dos três (o "Valor total" do cartão);
  `last_paid_at` = o último pagamento das OS do mês.
- `invoices` = quantas notas do técnico com a competência do mês não foram recusadas (aguardando conferência ou
  conferidas), desde 24/11/2026; a API de antes não manda o campo: ausente, o app conta 0. Não muda o `state`. A nota
  pode cobrir OS de meses anteriores, então o mês da competência pode vir `empty` com nota: o app mostra o cartão dele
  ("Sem valores", R$ 0,00 e "1 nota fiscal"), e é por ele que o técnico abre, apaga ou acompanha a nota. Enviada noutra
  competência, o app vai do envio direto para o mês dela (o aviso diz qual), em vez de voltar ao mês de onde veio.
- **Mês de um valor:** a conclusão da OS (aberta: o lançamento do valor), no fuso da operação: a régua de
  `list_payouts` e do `GET /me/earnings`. A data do pagamento não muda o mês; horário corrigido para o futuro conta no
  mês atual. O pendente de OS cancelada não conta (o pago, sim).
- **Nota de um valor:** só a nota do próprio técnico; a recusada não cobre nada (a recusa solta as OS), e a ligação com
  nota de outro técnico conta como "sem nota".
- **Recusa em aberto** (`rejection {invoice_id, number, reason, rejected_at}`): entre as notas do técnico com a
  competência do mês, a recusada mais recente (pela hora da recusa; sem ela, pelo envio), se nenhuma nota não recusada
  da mesma competência foi enviada depois. A recusada que o técnico apagou não existe mais.
- **Situação** (`state`), a primeira que vale, pelas contagens (valor de R$ 0,00 também conta):
  1. `rejected`: recusa em aberto, e o mês sem valor ou com algum valor sem nota;
  2. `empty`: sem valor;
  3. `in_progress`: só previsto;
  4. `partial`: algo pago e algo a receber ou previsto;
  5. `no_invoice`: nada pago, algo a receber sem nota (só informativo: a central paga com ou sem nota);
  6. `in_review`: nada pago, a receber com nota, alguma aguardando conferência;
  7. `to_pay`: nada pago, a receber com as notas conferidas;
  8. `paid_no_invoice`: tudo pago, algum sem nota;
  9. `paid`: tudo pago, com nota.

  `rejection` pode vir preenchida também quando a situação não é `rejected` (a recusa continua em aberto, mas todas
  as OS do mês têm outra nota): o app decide pelo `state`.
- `totals {paid, to_pay, expected, to_pay_older, last_paid_at, reimbursement_to_receive, reimbursement_paid}`: valores
  das OS de todos os meses, não só da janela; `to_pay_older` é a parte de `to_pay` de meses antes da janela (já
  somada em `to_pay`). Os reembolsos de custos extras ficam à parte: aprovados e não pagos, e pagos.
- Os valores por OS existem desde 13/11/2026 (o Field Control não trazia valores): os meses de antes vêm `empty`.
- Custo: 3 consultas, todas pelo técnico (os valores agrupados por mês, as notas da janela, de onde saem a recusa em
  aberto e o `invoices`, e os reembolsos). Sem tempo real e sem histórico: o app relê ao abrir a aba, ao puxar, depois
  de enviar ou apagar uma nota e depois de uma sincronização (`docs/MOBILE_SYNC.md`).
- A API desta entrega está publicada desde 20/11/2026. Com uma API anterior (sem esta rota: 404), o mês
  (`GET /me/earnings?month=`, que a API anterior tem) abre pelo "Outro mês" (ou por um cartão), mas a linha e os
  cartões só aparecem com os meses guardados no aparelho de uma busca que deu certo antes ("Não deu para atualizar ·
  valores de …"). Sem nada guardado, a aba mostra só "Não foi possível carregar o faturamento." e "Tentar de novo", sem
  cartões e sem o "Outro mês", e o mês e o "Enviar nota fiscal" ficam fora de alcance.

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
ganchos na OS em `services/tickets.py` (`close_pending_offers`, `close_technician_offers`).

**Regras.**
- A central (gestão com Pagamentos em Editar, que pode atribuir técnico) oferta uma OS **sem técnico** e **em
  aberto** (não resolvida, fechada nem cancelada) para 1 a 10 técnicos de campo com acesso ao app (desde 25/11/2026,
  também **Ativos** na operação e sem indisponibilidade nos dias da visita; sem agenda, hoje) que ainda não estão na
  OS, com o valor do técnico (R$, ≥ 0, 2 casas), o prazo para responder (opcional, no futuro) e um recado (até 500).
- O técnico responde "Aceitar por R$ X" ou "Recusar" (motivo opcional, até 300). Não há contraproposta nem chat (a
  conversa é pelo WhatsApp).
- Para aceitar, ele precisa ter aberto a oferta: `GET /me/offers/{id}` grava `viewed_at` (sem ele, 422
  `OFFER_NOT_VIEWED`). O "Escopo lido" é do app (abrir o escopo libera o botão de aceitar); o app guarda a hora em que
  o técnico abriu o escopo e manda no aceite (`scope_read_at`, desde 2026-11-19), e a central vê "escopo lido às
  HH:MM". A hora prova que ele abriu o escopo, não que leu, e vem do relógio do aparelho acertado pelo do servidor.
- **Quem aceita primeiro leva.** O aceite trava a OS (`SELECT ... FOR UPDATE`), confere que a oferta está pendente e
  no prazo e que a OS continua em aberto e sem técnico, e faz a atribuição normal (`tickets._assign`, a mesma do
  `POST /tickets/{id}/assign`, com o técnico como autor e `data.via = "offer"` no evento `assigned`). Depois dela, o
  valor da oferta vira o valor do técnico na OS (`payouts.set_payout`, nota "Valor da oferta aceita", autor = quem
  mandou a oferta ou, sem ele, o técnico): vence o padrão do tipo de serviço ou o valor transferido. As outras
  ofertas pendentes da OS fecham como canceladas (`taken`, "outro técnico aceitou"); o segundo aceite recebe 409
  `OFFER_TAKEN`.
- **O técnico fica com exatamente o valor que aceitou.** O valor pago não muda e é um por técnico na OS, então quem
  já tem valor **pago** nesta OS (foi o técnico dela antes) não recebe oferta dela (422 no envio) e, pago depois do
  envio, não aceita (409 `OFFER_UNAVAILABLE`, conferido antes de mudar qualquer coisa: a oferta continua pendente e a
  OS sem técnico). Se o pagamento entrar no meio do aceite, o aceite inteiro é desfeito com o mesmo 409.
- **Status depois do aceite** = o da central colocando o técnico pela tela (o editor manda o técnico pelo
  `POST /assign`; o PATCH e o `PUT /times` não mudam o status): `new`/`triage`/`reopened` → `assigned`; a agenda que a
  OS já tinha fica, e ela **não** vira `scheduled` sozinha (o "Agendado" continua sendo a transição da central, como
  na tela); em espera (`on_hold_*`) continua em espera. Conta como 1ª resposta (o técnico é da equipe), como a
  atribuição pela central. O aceite não confere conflito de agenda (as ações do técnico não conferem; a central vê
  no calendário).
- Definir o técnico na mão (`/assign`, `PATCH assignee_id`, `/take`, o "Atribuído" do menu) fecha as pendentes como
  `assigned`; colocar o técnico da oferta entre os outros técnicos da visita (`PATCH helper_ids`) fecha a dele como
  `assigned` (nota "A central incluiu o técnico na visita"). Se ele aceitou enquanto a central salvava a visita com a
  OS lida antes, o `PATCH` recebe 409 "A OS foi alterada por outra pessoa..." (`current_version`): mudar só a visita
  não muda a versão, e ele ficaria responsável e na visita ao mesmo tempo. Cancelar, resolver ou fechar a OS
  (`/transition` e o cancelamento pelo portal) fecha como `ticket_closed`. Desativar o técnico
  (`PATCH /technicians/{id}` ou `PATCH /users/{id}` com `is_active: false`) ou tirar dele o papel `technician` fecha
  as pendentes dele em todas as OS como `central` (nota "Técnico sem acesso ao app", autor = quem alterou); reativar
  não as traz de volta. Desde 25/11/2026, tirar o técnico de Ativo na operação (`POST /technicians/{id}/operational-status`)
  também fecha, com a nota "Técnico inativo na operação" ou "Técnico bloqueado na operação". Cada fechamento grava um
  `offer_cancelled` por OS e avisa a gestão e os técnicos afetados (o tempo real sai no commit da rota, inclusive nas
  de Técnicos e Usuários).
- Reenviar para quem já tem oferta pendente (ou vencida) da mesma OS **substitui** a anterior: a antiga vira
  cancelada com `cancel_reason: "replaced"`, sem evento próprio (o `offer_sent` traz `data.replaced`).
- Prazo vencido não tem rotina: a oferta continua gravada como pendente e o estado efetivo é `expired` quando
  `expires_at <= agora` (relógio do servidor). A vencida não conta em `open_offers` e não é fechada pelos ganchos
  (continua `expired`); a central ainda pode cancelá-la. `TicketDetail.next_offer_expires_at` traz o prazo mais
  próximo entre as pendentes no prazo, para a web reler a OS quando ele passa.
- O preço é dado de Pagamentos: ver as ofertas com os valores pede Pagamentos (Visualizar); mandar e cancelar pedem
  Editar. Quem não tem a tela vê só `TicketDetail.open_offers` (contador sem valores) e não recebe os `offer_*` do
  histórico.

**Estados** (`state`): `pending` | `expired` | `accepted` | `declined` | `cancelled`. Gravados (`OfferStatus`):
`pending`, `accepted`, `declined`, `cancelled`. `cancel_reason`: `central` (a central cancelou, ou o técnico ficou
sem acesso ao app) | `taken` (outro técnico aceitou) | `assigned` (a central definiu o técnico, ou pôs o técnico da
oferta na visita) | `ticket_closed` (OS cancelada, resolvida ou fechada) | `replaced` (trocada por uma oferta nova da
mesma OS).

**Central** (gestão, sempre dentro da fila de quem pede: OS de outra fila → 403 `QUEUE_FORBIDDEN`):
- `GET /tickets/{id}/offers` (Pagamentos em Visualizar) → `TicketOfferOut[]`, todas as ofertas da OS (também as
  fechadas e as substituídas), a mais nova primeiro (as de um mesmo envio, pelo nome do técnico).
- `POST /tickets/{id}/offers` (Pagamentos em Editar) `{technician_ids: uuid[1..10], amount, expires_at?, note?}` →
  **201** `TicketOfferOut[]` (as criadas, na ordem dos ids, sem repetir). `amount` aceita número ou texto
  (`"90.00"`); `expires_at` sem fuso vale como hora de Brasília. 422: "A OS já tem técnico: só dá para ofertar uma OS
  sem técnico", "Só dá para ofertar uma OS em aberto (não resolvida, fechada nem cancelada)", "O prazo para responder
  precisa ser no futuro", "Técnico não encontrado", "<nome> não é técnico de campo", "<nome> está sem acesso ao app:
  libere o acesso em Técnicos antes de ofertar", "<nome> já está na OS", "<nome> já tem valor pago nesta OS e não
  pode receber oferta dela" e, desde 25/11/2026, "<nome> está inativo e não recebe OS: <motivo>" (ou "bloqueado") e
  "<nome> está indisponível <período>" ("até 30/11", "de 20/12 a 05/01/2027"); validação com `label` "Técnicos",
  "Valor", "Prazo para responder" e "Recado". O envio
  trava a OS: dois envios juntos para o mesmo técnico viram uma troca (`replaced`); o índice único parcial é a rede de
  segurança (409 "Este técnico já tem uma oferta em aberto nesta OS").
- `POST /tickets/{id}/offers/{offer_id}/cancel` (Pagamentos em Editar, sem corpo) → `TicketOfferOut` (pendente ou
  vencida → `cancelled`/`central`; já cancelada: devolve como está). Já respondida pelo técnico: 422 "O técnico já
  respondeu esta oferta. Recarregue a OS."; oferta de outra OS: 404 "Oferta não encontrada".

`TicketOfferOut = {id, ticket_id, technician: {id, name}, amount: number, state, expires_at|null, note|null,
decline_reason|null, cancel_reason|null, viewed_at|null, scope_read_at|null, responded_at|null, created_by: {id,
name}|null, created_at}` (`amount` sai como número, como os outros valores da API: `90.0`; `scope_read_at`: quando o
técnico abriu o escopo no app, gravado no aceite; null na oferta não aceita e no aceite de app antigo).

**Técnico** (só papel `technician`; os outros: 403 "Sem permissão para esta ação"):
- `GET /me/offers` → `FieldOfferOut[]`, a mais nova primeiro: **todas** as pendentes no prazo e até 50 das que
  fecharam nas últimas 24 h (aceitas, recusadas, canceladas pelo `updated_at`; vencidas pelo `expires_at`). O limite
  é só das fechadas: o app tira do aparelho a oferta que não vem, e a pendente antiga não some atrás de fechadas mais
  novas. A substituída (`replaced`) não aparece (a nova aparece). Nas que não estão pendentes, o recorte da OS vem
  mínimo: sem escopo (`description: null`), sem formulários (`forms: []`) e sem bairro (`district: null`).
- `GET /me/offers/{id}` → `FieldOfferOut`; grava `viewed_at` na primeira vez (só a pendente no prazo) e a gestão
  recebe o `ticket.updated` com `offer.action: "viewed"`. Oferta de outro técnico: 404.
- `POST /me/offers/{id}/accept` (corpo opcional `OfferAccept {scope_read_at?}`) → `TicketDetail` da OS na visão do
  técnico (como o `GET /tickets/{id}` devolve a ele), já atribuída: agora vêm cliente, loja e endereço, e `my_payout`
  com o valor da oferta. Aceite repetido da oferta que já é dele (toque duplo, outro aparelho): 200 com a OS, sem
  mudar nada (a hora da leitura também não muda).
  - `scope_read_at`: quando o técnico abriu o escopo, no relógio do servidor (o app usa `serverNow`: o relógio do
    aparelho mais a diferença medida para o servidor); sem fuso, vale a hora de Brasília. Valor inválido vira null:
    a hora nunca recusa o aceite, e o aceite sem ela (app antigo) continua como antes. Só na passagem para aceita, a
    API grava `offer.scope_read_at = min(max(scope_read_at, criação da oferta), agora)` (relógio errado não põe a
    leitura antes da oferta nem no futuro). Nenhum erro novo.
- `POST /me/offers/{id}/decline` `{reason?: até 300}` (corpo opcional) → `FieldOfferOut` (`declined`). Recusa repetida:
  200 como está. Recusar não exige abrir a oferta.

`FieldOfferOut = {id, state, amount: number, expires_at|null, note|null, cancel_reason|null, viewed_at|null,
scope_read_at|null, responded_at|null, created_at, ticket: {id, code, title, description|null, service_type: {id,
name}|null, forms: [{name, required}], district|null, city|null, state|null, scheduled_start|null, scheduled_end|null,
estimated_minutes|null}}`.
Sem cliente, loja (nome, código, CNPJ), endereço, contato, recado da visita (`visit_note`), SLA, analista, etiquetas,
projeto nem valores de outros técnicos (a regra do convite: "só serviço, bairro e cidade, data e valor"). Sem agenda,
`scheduled_start` vem null ("data a combinar"); bairro, cidade e UF são os da loja (OS sem loja: null).
`ticket.estimated_minutes` (desde 2026-11-19, também no recorte mínimo): a duração estimada da OS (a do tipo de
serviço, copiada na abertura), null sem estimativa; o app mostra a duração ao lado da data e da hora.
`ticket.title` (também no recorte mínimo) sai sem o nome da loja, o código da loja (a partir de 3 caracteres), o nome
do cliente (também sem o sufixo da razão social: "Cliente Exemplo Ltda" tira "Cliente Exemplo"; Ltda, S.A., S/A,
EIRELI, ME, EPP), o nome do projeto e o nº do chamado do cliente (a partir de 3 caracteres), sem diferença de caixa ou
acento e só palavra inteira, junto com a preposição logo antes ("na Matriz"), os separadores que sobram (" · ", " - ",
"–", "|", ":", ","...), os parênteses e aspas que ficam vazios e o sinal solto nas pontas ("&", "+"): o
título automático da Nova OS é "<Tipo de OS> · <Localização>", e "Troca de PDV · Matriz" chega como "Troca de PDV".
Se sobrar menos de 3 caracteres, vem o nome do tipo de serviço (com o mesmo corte) ou "Atendimento técnico". O
título da OS em si não muda. `ticket.service_type.name` passa pelo mesmo corte (desde 2026-11-19: é o destaque do
cartão "Serviços" do app, e um tipo de serviço próprio de um cliente pode trazer o nome dele); se sobrar menos de 3
caracteres, "Atendimento técnico". O cadastro do tipo de serviço e o texto do grupo da web (`offerText`) não mudam.
`cancel_reason` (acréscimo ao contrato inicial) diz ao app por que fechou ("outro técnico aceitou" = `taken`).

**Erros do aceite e da recusa** (`{"detail": "...", "code": "..."}`):

| HTTP | code | detail | Quando |
|---|---|---|---|
| 409 | `OFFER_TAKEN` | Outro técnico já aceitou esta OS. | cancelada como `taken` |
| 409 | `OFFER_EXPIRED` | O prazo para responder esta oferta acabou. | pendente com `expires_at` vencido |
| 409 | `OFFER_CANCELLED` | A central cancelou esta oferta. | cancelada como `central` ou `replaced` (o app busca as ofertas de novo e acha a nova) |
| 409 | `OFFER_UNAVAILABLE` | Esta OS não está mais disponível. | cancelada como `assigned`/`ticket_closed`; a OS já tem técnico ou foi encerrada; o técnico tem valor pago nesta OS; aceite de uma oferta aceita cuja OS não é mais dele; o técnico saiu de Ativo na operação (desde 25/11/2026; ele nunca vê a situação) |
| 409 | `OFFER_ANSWERED` | Você já respondeu esta oferta. | aceitar a recusada ou recusar a aceita (acréscimo ao contrato inicial) |
| 422 | `OFFER_NOT_VIEWED` | Abra a oferta e leia o escopo antes de aceitar. | aceite sem `viewed_at` |

A ordem das conferências: o estado da oferta (aceita, recusada, cancelada), o prazo, a OS (em aberto e sem
técnico) e, só no aceite, a leitura e o valor pago do técnico nesta OS.

**Histórico** (eventos novos, só para quem tem Pagamentos: levam o valor; `HISTORY_ITEMS`):
- `offer_sent` (autor: quem mandou): `to_value` "90.00", `note` = recado, `data {amount: "R$ 90,00", expires_at,
  offers: [{id, technician_id, technician}], replaced?: [nomes]}`.
- `offer_accepted` (autor: o técnico): `to_value` "90.00", `data {offer_id, technician_id, technician, amount,
  scope_read_at}` (`scope_read_at`: a hora gravada na oferta, ISO, ou null; desde 2026-11-19).
- `offer_declined` (autor: o técnico): `to_value` "90.00", `note` = motivo, `data {offer_id, technician_id,
  technician, amount}`.
- `offer_cancelled` (autor: quem cancelou, definiu o técnico, incluiu o técnico na visita, desativou o técnico ou
  encerrou a OS; null no `taken`): `to_value` = motivo, `note` ("Cancelada pela central", "Técnico sem acesso ao
  app", "Outro técnico aceitou a OS", "A central definiu o técnico da OS", "A central incluiu o técnico na visita",
  "OS cancelada", "OS resolvida", "OS fechada"), `data {reason, offers: [{id, technician_id, technician, amount}]}`.
- O aceite também grava o `assigned` normal (autor: o técnico, `note` "Aceitou a oferta", `data.via = "offer"`), o
  `status_changed` da atribuição e os `payout_set` (o padrão do tipo de serviço, quando houver, e o valor da oferta).

**Tempo real.**
- Gestão: `ticket.updated` com `data {fields: ["offers"], offer: {action, technician_name|null, reason|null,
  sender_id|null}}`, interno e só da gestão, **sem valor**. `action`: `sent` | `viewed` | `accepted` | `declined` |
  `cancelled` (`viewed` é acréscimo ao contrato inicial). `technician_name` quando é um técnico só; `reason` = o
  `cancel_reason` no `cancelled` e o motivo do técnico no `declined`; `sender_id` = quem mandou a oferta
  (`created_by` dela) no `accepted` e no `declined`, para a web avisar também quem mandou sem ser o analista da OS
  (null nas outras ações). Vai a toda a gestão que vê a OS (com ou sem Pagamentos: não leva valor).
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
  alteração não salva, como a Situação). Os botões quebram a linha no celular. Nada disso entra no formulário da OS.
  Escolher o técnico na mão com ofertas em aberto mostra o aviso de que elas serão canceladas ao salvar. O
  "Cancelar" de uma oferta que já tinha fechado por outro motivo (lista velha; a API devolve como estava) avisa, em
  tom neutro, "Esta oferta já tinha sido encerrada: <motivo>" e, na `replaced`, que a oferta nova para o técnico
  continua como estava. A aceita mostra "Aceitou às 14:50 · escopo lido às 14:45" (sem a leitura, só o aceite).
- Aba Geral da OS com técnico (toda a gestão, sem valor, pelo `TicketDetail.accepted_offer`): embaixo do valor do
  técnico (`PayoutLine`, para quem tem Pagamentos), a linha `AcceptedOfferLine` "Aceitou a oferta pelo app às 14:50"
  com o chip "Escopo lido às 14:45" (noutro dia: "ontem às 18:10", "em 17/11 às 18:10"). Sem oferta aceita, a linha
  não aparece. Precisa do `accepted_offer` porque, com técnico, a Geral troca o bloco "Ofertas" pelo valor do técnico.
- Diálogo "Ofertar a OS com preço" (também no resumo da OS recém-criada): de 1 a 10 técnicos (`GET
  /technicians/suggest` com `exclude_ticket_id` e `limit=10`, mais a busca: `GET /technicians` com a tela Técnicos,
  senão os técnicos de `GET /users/assignable`; sem acesso ao app e já na OS aparecem travados, e desde 25/11/2026
  também Inativo e Bloqueado, com os chips e o motivo no título, e o indisponível no dia da visita, com "Indisponível
  até 30/11"; o sugerido fora da disponibilidade informada ganha o chip âmbar "Fora da disponibilidade (sáb · tarde)"), o valor (começa no
  `technician_fee` do tipo de serviço), o prazo (sem prazo, 30 min, 1 h, 2 h, 4 h ou até o fim do dia; o `expires_at` é
  calculado no clique) e o recado. Depois do envio, o aviso "Oferta enviada" com "Copiar texto para o grupo". Sem
  texto de exemplo nem explicação fixa nos campos. Escopo ou recado que cita o cliente ou a loja (os nomes que a API
  tira do título: o do cliente também sem o sufixo da razão social e o código da loja a partir de 3 caracteres;
  palavra inteira, sem caixa nem acento) mostra "O escopo cita o cliente ou a loja, e o técnico lê o escopo antes de
  aceitar" (ou o mesmo aviso do recado, embaixo do campo).
  Na aba Geral o diálogo fica fora do bloco: se a OS ganha técnico ou sai de "em aberto" com ele aberto, ele continua
  (com o erro de um envio em andamento), diz "A OS já tem técnico: <nome>." ou "A OS não está mais em aberto." e trava
  o Enviar.
- Texto do grupo de técnicos (`offerText` em `components/new-ticket/invite.ts`): o tipo de serviço (sem ele,
  "Atendimento técnico"; nunca o título da OS, que pode trazer a loja), bairro e cidade, data (ou "data a combinar"),
  valor, para quem foi no app e "Aceite pelo app até HH:MM" (ou sem prazo). Nunca cliente, loja ou endereço. O
  convite antigo (Geral e Nova OS) segue a mesma regra do serviço.
- Cabeçalho da OS (toda a gestão, pelo `open_offers`): sem técnico e com oferta esperando resposta, o chip "Sem
  técnico" vira "Oferta enviada" / "N ofertas enviadas", em tom neutro. Sem Pagamentos, a Geral também mostra só
  esse contador, sem valores. O editor da OS (página e painel, com ou sem Pagamentos) relê o detalhe (`["ticket",
  id]`, exato) e a lista de ofertas 1 s depois do `next_offer_expires_at`, em etapas quando passa do teto do
  `setTimeout`; se a resposta ainda traz o mesmo prazo (relógio do computador adiantado), tenta de novo até 4 vezes,
  a cada 15 s. Trocar de OS ou fechar desarma.
- Histórico: os quatro `offer_*` (técnicos e valor no envio, valor e "escopo lido às HH:MM" no aceite, ou "escopo
  lido em 18/11 às 18:10" quando a leitura foi noutro dia, motivo na recusa, motivo no encerramento) e o `assigned`
  com `via: "offer"` ("assumiu a OS pela oferta"). No `offer_cancelled`, as notas
  "A central incluiu o técnico na visita" e "Técnico sem acesso ao app" viram "encerrou a oferta ao incluir o técnico
  na visita" e "encerrou a oferta: técnico sem acesso ao app".
- Tempo real: o `ticket.updated` com `fields` exatamente `["offers"]` (inclusive o `viewed`) recarrega só a OS
  (`["ticket", id]`: a lista de ofertas, o contador e o histórico); listas de OS, Início e lista de atribuição não
  (o aceite chega também como `ticket.assigned`, que recarrega tudo). O aceite e a recusa viram aviso para o analista
  da OS (sem analista, para a central toda) e para quem mandou a oferta (`sender_id` = usuário logado), sem o valor.
- Técnicos e Usuários: desativar um técnico sempre pede confirmação, que diz que as ofertas em aberto para ele são
  canceladas. Em Usuários, tirar o papel de técnico avisa o mesmo no texto do formulário.

## Notas fiscais dos técnicos (2026-11-18)

**Por quê.** O técnico parceiro emite a nota de serviço (no portal da prefeitura) pelos chamados do mês e envia pelo
app (aba Faturamento, no mês); a central confere em Pagamentos. A nota é opcional e nunca trava pagamento. O Field Control não tem
nota do técnico: segue-se o padrão dele "o colaborador envia pelo app, o escritório confere no painel", com o documento
com metadados do GLPI. Código: `services/invoices.py`, `api/routes/invoices.py`, `models/invoice.py` e, em
`services/storage.py`, `save_upload_in` e `sniff_document`.

**Dados.**
- Tabela `technician_invoices`: `technician_id`, `number` (até 30), `issue_date`, `amount`, `competence` (o mês do
  serviço, gravado como o dia 1; a API usa "AAAA-MM"), `note` (até 500), `status` (`pending` aguardando conferência,
  `checked` conferida, `rejected` recusada), `reject_reason`, `reviewed_at`, `reviewed_by_id`, o arquivo (`filename`,
  `content_type` real, `size_bytes`, `storage_key` em `media/invoices/{técnico}/`) e `client_upload_id` (a chave de
  idempotência do app, única por técnico).
- `ticket_payouts.invoice_id`: a nota que cobre aquele valor. Um valor fica em no máximo uma nota; uma nota cobre
  vários valores do mesmo técnico. A ligação é opcional.

**Rotas do técnico** (papel `technician`; gestão e cliente recebem 403). Tudo pede internet: o envio não entra na fila
offline (`docs/MOBILE_SYNC.md`).
- `GET /me/invoices?month=AAAA-MM` → `MyInvoice[]`, as da competência (sem `month`, todas, até 200), as mais novas
  primeiro. `MyInvoice = {id, number, issue_date, amount, competence, note, status, reject_reason, reviewed_at, filename,
  content_type, size_bytes, file_kind: "pdf"|"xml"|"image", download_url, payouts: InvoicePayoutRef[], payouts_total,
  created_at}`, com `InvoicePayoutRef = {payout_id, ticket_id, code, title, amount, status, concluded}`. Sem o nome de
  quem conferiu. Mês inválido: 422 "Mês inválido (use AAAA-MM)".
- `GET /me/invoices/payouts?month=AAAA-MM` (obrigatório) → `InvoicePayoutCandidate[] = {payout_id, ticket_id, code,
  title, amount, status, resolved_at, in_month, invoice: {id, number, status}|null}`. Primeiro os valores do mês (OS
  resolvida ou fechada, ou valor já pago; a data é a da conclusão, sem ela a do lançamento, no fuso da operação), com
  qualquer situação de nota; depois os de meses anteriores ainda a receber, de OS concluída e sem nota dele (`in_month`
  false). Por data, até 300. A ligação com nota de outro técnico conta como livre: no mês vem com `invoice` null, e
  entre as anteriores também aparece.
- `POST /me/invoices` (multipart): `file`, `number`, `issue_date` (AAAA-MM-DD), `amount` ("1234.56"), `competence`
  (AAAA-MM), `note`, `payout_ids` (UUIDs separados por vírgula) e `client_upload_id` (UUID do app, um por abertura da
  tela, repetido nas novas tentativas) → 201 `MyInvoice`. A mesma `client_upload_id` de novo (resposta perdida): 200 com
  a nota já gravada, sem gravar nada. Dois envios iguais ao mesmo tempo: 409 "Esta nota já foi recebida. Atualize a
  lista.".
- `DELETE /me/invoices/{id}` → 204. Só a própria (a de outro técnico: 404 "Nota fiscal não encontrada") e só enquanto
  a central não conferiu (422 "A central já conferiu esta nota: ela não pode mais ser apagada"); a recusada também. As
  OS ficam livres e o arquivo sai do disco depois do commit.

**Envio, nesta ordem** (422 com a mensagem). Tudo do banco é conferido antes de gravar o arquivo; se a gravação falhar
depois, o arquivo sai do disco. Um envio de cada técnico por vez (trava por técnico até o fim da transação).
1. Campos:
   - sem arquivo: "Escolha o arquivo da nota";
   - número, 1 a 30 caracteres sem os espaços das pontas: "Informe o número da nota", "O número da nota tem no máximo
     30 caracteres";
   - emissão, de 2000-01-01 até hoje no fuso da operação: "Informe a data de emissão", "Data de emissão inválida (use
     AAAA-MM-DD)", "A data de emissão não pode ser no futuro";
   - valor maior que zero, com ponto e até 2 casas: "Informe o valor da nota", "Valor inválido", "O valor da nota
     precisa ser maior que zero";
   - competência, de 2000-01 até o mês atual: "Informe a competência", "Competência inválida (use AAAA-MM)", "A
     competência não pode ser um mês que ainda não chegou";
   - "A observação tem no máximo 500 caracteres"; "Escolha até 200 OS por nota"; `client_upload_id` que não é UUID:
     "Envio inválido: atualize o app e tente de novo".
2. A mesma `client_upload_id` do técnico: 200 com a nota existente.
3. Até 20 notas por técnico em cada competência, contando as recusadas: "Limite de 20 notas por competência: apague
   as recusadas para enviar outra".
4. Número único entre as notas não recusadas do técnico, comparado sem espaços, em maiúsculas e sem zeros à esquerda
   ("01 234" = "1234"): "A nota nº 1234 já foi enviada". Outro técnico pode ter o mesmo número.
5. As OS escolhidas, travadas (`FOR UPDATE`): do técnico ("Uma das OS escolhidas não é sua", também para id inválido
   ou valor que não existe mais), com a OS resolvida ou fechada ou o valor já pago ("A OS-000123 ainda não foi
   concluída") e sem outra nota dele ("A OS-000123 já está na nota nº 1200" só cita nota do próprio técnico). Ligação
   com nota de outro técnico (não devia existir) conta como livre e é sobrescrita pelo envio, sem mostrar o número da
   nota do outro.
6. O tipo pelo conteúdo (`storage.sniff_document`, os primeiros 1024 bytes): PDF (`%PDF-`), XML (começa com `<` depois
   do BOM e dos espaços, sem ser HTML, SVG ou script) ou foto JPG, PNG ou WebP. Vazio: "O arquivo da nota está vazio";
   outro tipo: "Envie a nota em PDF, XML ou foto (JPG, PNG ou WebP)".
7. Até 10 MB: "Arquivo maior que 10 MB".

**Rotas da central** (Pagamentos: Visualizar para ver e baixar, Editar para conferir, desfazer e recusar; nenhum item
novo na matriz). A lista não segue a fila do analista: a nota é do técnico, não de uma OS (abrir a OS continua
obedecendo a visibilidade de cada um).
- `GET /technician-invoices?technician_id=&status=pending|checked|rejected&month=AAAA-MM&offset=` →
  `TechnicianInvoiceList = {items, summary, total_count}`. `month` é a competência.
  - `items`: `TechnicianInvoice` (`MyInvoice` + `technician: Ref` + `reviewed_by: Ref|null`), até 500 por vez, a partir
    de `offset` (inteiro ≥ 0, padrão 0; negativo ou acima de 2^63−1: 422).
  - Com `status=pending`, na ordem da fila: as mais antigas primeiro (pela data de envio, desempate por id). É o que a
    aba "A conferir" pede.
  - Sem `status`, ou com `checked` ou `rejected`: as mais novas primeiro.
  - `total_count` é o total do filtro (técnico, mês e situação), sem o offset: há outra página enquanto
    `offset + items.length < total_count`.
  - `summary = {pending, checked, rejected, pending_amount, checked_amount}` continua só com os filtros de técnico e mês
    (os contadores das abas).
  - Na web (Pagamentos › Notas fiscais), a aba "A conferir" pede `status=pending` e avisa quando `total_count` passa dos
    itens que vieram; as outras abas usam a lista sem `status` (as 500 mais novas). O CSV da aba junta as páginas pelo
    `offset`, uma depois da outra, até o `total_count`.
- `POST /technician-invoices/{id}/check` → `TechnicianInvoice`: aguardando vira conferida (`reviewed_at`,
  `reviewed_by`); já conferida fica como está; recusada, 422 "Nota recusada: o técnico envia outra".
- `POST /technician-invoices/{id}/uncheck` → volta a aguardar, sem `reviewed_*`; aguardando fica como está; recusada,
  422 (a mesma mensagem).
- `POST /technician-invoices/{id}/reject` `{reason}` (3 a 300 caracteres, sem os espaços das pontas) → recusada, com o
  motivo e `reviewed_*`, e as OS ficam livres. Só a que aguarda: conferida, 422 "Desfaça a conferência antes de
  recusar"; recusada, 422 "Esta nota já foi recusada". A recusa é final: o técnico apaga e envia outra (o número da
  recusada pode ser usado de novo). Na web, o "Avisar no WhatsApp" da recusada leva o motivo e termina em "Envie a nota
  corrigida pelo app, em Faturamento.".
- 404 "Nota fiscal não encontrada". A central nunca apaga nem edita a nota ou a ligação com as OS (ligação errada:
  recusa com o motivo) e não envia nota em nome do técnico.

**Arquivo.** `download_url` = `/api/v1/technician-invoices/{id}/download?token=` (rota pública com link assinado de
30 min: JWT `download` com `sub` "invoice:{id}" e `uid` de quem pediu), gerado só nas respostas de quem pode ver (o
técnico dono e quem tem Pagamentos). Token adulterado ou vencido: 401 "Link expirado"; de outra nota: 401 "Link
inválido"; nota apagada: 404 "Nota fiscal não encontrada"; arquivo sumido do disco: 404 "Arquivo não encontrado". A
foto abre na tela; PDF e XML baixam (`attachment`), sempre com `nosniff` e CSP `sandbox`, como os anexos da OS.

**Valores.** `PayoutLine.invoice = {id, number, status} | null` em `GET /payouts` e `GET /me/earnings` (só a nota do
próprio técnico do valor). Trocar o responsável da OS leva o valor não pago para o novo técnico sem a nota
(`invoice_id` volta a null; a nota fica com o técnico, sem aquela OS). A troca trava a OS e depois o valor de quem sai
(`FOR UPDATE`) e relê o valor do banco antes de passá-lo ao novo técnico: se o técnico que sai estiver enviando uma nota
com essa OS, a troca espera o envio terminar e a ligação sai do mesmo jeito; o envio que chega depois da troca recebe
422 "Uma das OS escolhidas não é sua". Ligação com nota de outro técnico nunca aparece (`GET /payouts`,
`GET /me/earnings`, candidatas) e não ocupa o valor. Remover o valor ou tirar o técnico da visita apaga a linha e a
ligação. Mudar o valor de um pagamento ligado continua permitido (a central vê a diferença). Pagar não depende da nota.
A situação de cada mês no Faturamento do app usa as notas do mesmo jeito (a ligação de cada valor com a nota do
próprio técnico e a recusa por competência): ver [Faturamento do app](#faturamento-do-app-2026-11-19).

**Privacidade (LGPD).** A nota traz CPF/CNPJ e endereço do técnico. Só o próprio técnico (as rotas `/me` sempre
filtram por ele) e quem tem Pagamentos veem; nada vai para o portal do cliente nem para outros técnicos. A nota
conferida fica guardada (documento fiscal: o técnico só apaga se a central desfizer a conferência); a que aguarda
conferência ou foi recusada, o técnico apaga, com o arquivo. Sem push, tempo real ou evento no histórico da OS: a
central vê a nota nova ao focar ou recarregar a tela, e o técnico vê a conferência ou a recusa ao abrir o
Faturamento ("Nota em conferência", "A pagar", "Nota recusada" com o motivo).

## Meu cadastro do técnico (2026-11-18)

**Por quê.** O técnico mantém o próprio cadastro no app (Perfil › Configurações; até 2026-11-19, Conta › Meu
cadastro, e `/meu-cadastro` continua abrindo as Configurações): foto, nome, celular (WhatsApp), e-mail de login,
endereço, cidade/UF, região que atende, onde recebe por chamado e o perfil técnico
([Perfil técnico](#perfil-técnico-2026-11-19)). Desde 25/11/2026 ([Cadastro V2](#cadastro-v2-2026-11-25)), também o
CPF, o RG, o nascimento, o telefone secundário, o endereço em partes, a mini biografia, os dados da empresa, o veículo,
a indisponibilidade e as **formas de recebimento** (chaves PIX e contas, uma preferencial, no lugar da chave PIX única),
nos mesmos grupos da ficha da central. A central é avisada na hora quando mudam as formas de recebimento, o e-mail, o
CNPJ, o nome ou o celular, e toda mudança, do app, da central, da aprovação da ficha ou do link do e-mail, fica no
histórico do cadastro. Motivo da senha e do histórico: uma conta invadida não pode desviar o pagamento. Código:
`services/my_profile.py`, `services/user_history.py`, `services/payout_methods.py`, `core/pix.py`, `core/payout.py`,
`api/routes/my_profile.py` e `models/user_change.py`.

**Quem muda o quê.**
- O técnico, pelo app: nome, celular, telefone secundário, RG, nascimento, mini biografia, veículo, indisponibilidade,
  cidade/UF, região, endereço (logradouro, número, complemento, bairro) e CEP sem senha; o CPF uma vez (enquanto está
  vazio); e-mail, dados da empresa e formas de recebimento (incluir, editar, tornar preferencial, excluir) com a senha
  atual; a foto; e o perfil técnico (ferramental, disponibilidade, transporte e CNH, aptidões e formação), sem senha e
  sem a trava da senha provisória.
- Só a central (Técnicos ou Usuários): grupo, cargo, acesso ao app, situação na operação, papel, serviços que faz,
  jornada, senha provisória e a correção do CPF. A central também muda os dados pessoais, o endereço e a empresa (sem
  senha), mas só vê o perfil técnico e o veículo (`PATCH /technicians/{id}` ignora esses campos). Os textos livres de
  ferramentas e de certificações continuam só na ficha da homologação (não viram lista).
- Formas de recebimento: só o técnico cadastra e muda. A central vê (Pagamentos em Visualizar) e só remove (Pagamentos
  em Editar); `PATCH /technicians/{id}` ignora esses campos.

**Rotas do técnico** (papel `technician`; gestão e cliente recebem 403). Nada entra na fila offline: tudo pede internet
(a senha não fica guardada e o aviso tem de sair na hora). `GET /auth/me` e `UserOut` não mudam.
- `GET /me/profile` → `MyProfile {id, name, email, phone, job_title, team: Ref|null, home_city, home_state,
  coverage_area, address_line, address_district, address_zip, avatar_url, pix: PixInfo|null, tool_ids, availability,
  transport, skills, education, tech_profile_updated}`, com `PixInfo = {key_type, key, holder_name, updated_at}` (os
  campos do perfil técnico: ver [Perfil técnico](#perfil-técnico-2026-11-19)). Desde 25/11/2026, `MyProfile` traz
  também `email_pending`, `email_verified_at`, `email_link_sent_at`, `mail_enabled`, `phone_secondary`, `cpf`,
  `rg_number`, `rg_issuer`, `rg_state`, `birth_date`, `address_number`, `address_complement`, `bio`,
  `company_document`, `company_name`, `company_trade_name`, `vehicle_model`, `vehicle_plate`, `payout_methods` e
  `unavailability`; `pix` fica só para o app de antes (a forma preferencial quando ela é PIX). Ver
  [Cadastro V2](#cadastro-v2-2026-11-25).
- As rotas do e-mail (`POST /me/profile/email/verification`, `DELETE /me/profile/email/pending`) e das formas de
  recebimento (`POST /me/profile/payout-methods`, `PUT …/{method_id}`, `POST …/{method_id}/preferred` e
  `POST …/{method_id}/remove`), todas respondendo o `MyProfile`: ver [Cadastro V2](#cadastro-v2-2026-11-25).
- `PATCH /me/profile` `MyProfileUpdate` (campo fora da lista: 422 "Campo não aceito"). Só o que vier no corpo muda:
  - `name`: 3 a 160 caracteres, espaços colapsados e NFC (null: "Informe seu nome completo"). Só letras (com acento),
    espaço, apóstrofo (' ’ ‘ ´ ʼ e o acento grave solto), hífen e ponto; recusa "www", "http" e endereço colado (duas
    letras, ponto e letra, como "site.com" e "wa.me"; iniciais como "J.R." passam): 422 "Use só letras no nome". O nome
    vai para os textos do grupo do cliente, o relatório e o portal. Vale só para o nome que vem no corpo: o app manda o
    nome só quando ele muda (e confere antes com a mesma regra), e os nomes antigos ficam como estão;
  - `phone`: 10 a 13 dígitos (aceita +55), volta "(11) 98888-7777" (null ou inválido: "Informe o celular com DDD");
  - `email`: em minúsculas, validado só quando vem (há logins de teste sem "@"; null: "Informe um e-mail válido");
  - `home_city`: 2 a 120, na grafia padrão da base (null: "Informe a cidade"); `home_state`: uma UF ("UF inválida");
  - `coverage_area` (até 1000), `address_line` (255, o logradouro) e `address_district` (120): vazio vira null;
  - `address_zip`: 8 dígitos, volta "00000-000" ("CEP com 8 dígitos"); vazio ou null tira o CEP;
  - desde 25/11/2026: `cpf`, `rg_number`, `rg_issuer`, `rg_state`, `birth_date`, `phone_secondary`, `address_number`,
    `address_complement`, `bio`, `company_document`, `company_name`, `company_trade_name`, `vehicle_model`,
    `vehicle_plate` e `unavailability` (regras e mensagens em [Cadastro V2](#cadastro-v2-2026-11-25));
  - `pix`: desde 25/11/2026, 422 "Atualize o app: a chave PIX agora fica em Configurações › Formas de recebimento" (a
    chave virou forma de recebimento, com rotas próprias; até 24/11/2026 era `{key_type, key, holder_name}`, e null
    tirava a chave);
  - `tool_ids`, `availability`, `transport`, `skills` e `education`: o perfil técnico, cada parte inteira e sem senha
    (ver [Perfil técnico](#perfil-técnico-2026-11-19));
  - `current_password` (até 256).
- Ordem do `PATCH`:
  1. Conta só o que muda de verdade (o mesmo celular ou a mesma cidade escritos de outro jeito não contam). Sem nada
     novo: 200, sem histórico e sem aviso. O CPF já gravado e diferente: 422 "O CPF já foi informado. Para corrigir,
     fale com a central pelo WhatsApp"; RG e empresa incompletos: 422 com a mensagem do grupo.
  2. E-mail novo (diferente do login e do pendente), desde 25/11/2026: envio de e-mail desligado, 422 "O envio de
     e-mail está desligado: para trocar o e-mail, fale com a central pelo WhatsApp"; endereço que não recebe
     mensagens, 422 "Este e-mail não recebe mensagens".
  3. E-mail ou dados da empresa mudando com `must_change_password` (a senha provisória da central: "Redefinir senha"
     em Técnicos, senha definida em Usuários ou ficha sem senha): 422 "Crie sua senha no app antes de mudar o e-mail,
     os dados da empresa ou as formas de recebimento". O app nem abre as Configurações nesse estado (pede a troca da
     senha antes). O resto do cadastro e o perfil técnico não passam por esta trava nem pelas duas seguintes.
  4. E-mail novo de domínio da empresa (`ENTRA_ALLOWED_DOMAINS`, o domínio exato): 422 "Use um e-mail que não seja da
     empresa". Não pede senha, porque é regra fixa. Quem já tem e-mail da empresa continua com ele, e a central pode
     definir esse e-mail em Técnicos.
  5. Senha atual (e-mail ou empresa mudando): sem `current_password`, 422 "Confirme com a sua senha atual para mudar o
     e-mail, os dados da empresa ou as formas de recebimento"; errada, 422 "Senha atual incorreta". A tentativa conta
     antes de conferir, no contador da troca de senha (5 em 15 min, somando as telas): passou disso, 429 "Muitas
     tentativas de confirmar a senha. Tente de novo em N minutos." com `Retry-After`, e o `POST /auth/change-password`
     também fica bloqueado.
  6. E-mail mudando, já com a senha certa: no máximo 10 conferências por hora por técnico (a 11ª: 429 "Muitas
     tentativas. Tente mais tarde." com `Retry-After`); e-mail de outro usuário ou de ficha pendente: 422 "E-mail já
     cadastrado". Sem a senha certa, ninguém descobre se um e-mail existe. CPF novo: no máximo 10 conferências por
     hora (429); de outro usuário, 409 `CPF_TAKEN` "Este CPF já está em outro cadastro".
  7. Grava com o histórico. Mudou a cidade ou a UF (não só a grafia): as coordenadas antigas de casa saem (vale também
     para o `PATCH /technicians/{id}` da central). Parte do perfil técnico que mudou: as colunas e o carimbo `{at, via:
     "app"}` dela. E-mail novo: fica em `email_pending` e o link de validação sai depois do commit.
  8. Depois do commit, o aviso `profile.changed`.
- Uma gravação por vez por técnico: antes do passo 1, o `PATCH` trava a linha do técnico (`SELECT … FOR UPDATE`, até o
  fim da transação) e relê o cadastro do banco. Outro `PATCH` do mesmo técnico que chega junto (a gravação seguinte do
  app quando a anterior passou dos 20 s, o técnico em dois aparelhos) espera e compara, carimba e monta o histórico
  sobre o que o primeiro gravou: um não apaga o carimbo nem o histórico do outro.
- Trocar o e-mail não encerra as sessões (a senha é a mesma). Desde 25/11/2026, o login só passa a ser o e-mail novo
  quando o técnico abre o link de validação (até lá, ele entra com o de antes); o e-mail do login com um pedido aberto
  cancela o pedido, sem senha.
- `POST /me/profile/photo` (multipart `file`; JPG, PNG ou WebP pelo conteúdo, até 2 MB) → `MyProfile`. O app manda a
  foto já recortada (quadrada) e reduzida (512 px). A anterior sai do disco quando nenhum outro usuário nem ficha de
  homologação usa.
- `DELETE /me/profile/photo` → `MyProfile`: tira a foto enviada e também a que veio do Field Control
  (`avatar_external_url`); sem foto, 200 sem histórico.

**Chave PIX** (`core/pix.py`; os mesmos formatos em `formatPixKey` de `constants.ts`). Desde 25/11/2026 são as regras
da chave de cada forma de recebimento PIX (`pix_key_type` e `pix_key`; erro na chave: 422 com `label` "Chave PIX";
vazia: "Informe a chave PIX"; o titular e as contas: ver [Cadastro V2](#cadastro-v2-2026-11-25)). No app (Configurações
› Formas de recebimento e a linha "Recebe no PIX" do Faturamento), a chave aparece mascarada por `maskPixKey` de
`constants.ts`, a mesma regra da coluna "Mascarada" com "•" no lugar de "*" ("CPF •••.456.789-••"). O extrato do
WhatsApp na web usa o mesmo texto mascarado (`payoutMethodText`) para todos os tipos de chave e para as contas.

| Tipo | Fica gravada | Mostra | Mascarada | Erro |
|---|---|---|---|---|
| `cpf` | 11 dígitos | 123.456.789-09 | `***.456.789-**` | "CPF inválido: confira os números" |
| `cnpj` | 14 caracteres em maiúsculas (aceita o alfanumérico) | 12.345.678/0001-95 | `12.345.678/****-**` | "CNPJ inválido: confira os números" |
| `email` | minúsculas, até 77 | como está | `t***@exemplo.com` | "E-mail inválido" |
| `phone` | "+55" e 11 dígitos (DDD sem zero e o número com o 9; 12 ou 13 dígitos começando com 55 perdem o 55) | +55 (11) 98888-7777 | `+55 (11) *****-7777` | "Celular inválido: use DDD e número, com o 9" |
| `random` | 8-4-4-4-12 em minúsculas (32 hexadecimais) | como está | `…4000` | "Chave aleatória inválida: copie a chave do app do seu banco" |

**Histórico do cadastro** (tabela `user_changes`): uma linha por gravação, `UserChange {id, created_at, via:
"app"|"central"|"ficha"|"link", actor: Ref|null, note: string|null, changes: [{field, from, to}]}` (`ficha`, `link`
e `note` desde 25/11/2026: a aprovação na Homologação, o técnico pelo link do e-mail e o motivo da situação na
operação), com o texto pronto para a tela:
- `name`, `email`, `phone`, `job_title`, `home_city`, `home_state`, `coverage_area`, `address_line` (o logradouro),
  `address_district`, `address_zip`: o valor como está;
- `team`: o nome do grupo; `is_active`: "Liberado" ou "Sem acesso" (até 24/11/2026, "Bloqueado": a migração trocou as
  linhas antigas); `role`: o rótulo do papel; `work_schedule`: "08:00–17:00, intervalo 12:00–13:00"; `services`: "12
  serviços";
- `pix`: a chave mascarada (`"CPF ***.456.789-**"`), null sem chave; `pix_holder`: o titular da conta (só nas linhas
  de antes de 25/11/2026; agora são `payout_methods` e `payout_preferred`);
- `avatar`: `to` "nova" na troca e null na remoção (`from` "anterior"); `password`: `to` "provisória" (Redefinir senha
  em Técnicos), "definida pela central" (Usuários), "criada no app" (o técnico trocou a provisória), "trocada no app"
  e, pelo link do e-mail, "criada pelo link do e-mail" ou "redefinida pelo link do e-mail";
- perfil técnico: `tools`, `availability`, `skills` e `education` com o que **saiu** em `from` e o que **entrou** em
  `to`, e `transport` de → para (ver [Perfil técnico](#perfil-técnico-2026-11-19));
- os campos do cadastro V2 (dados pessoais, empresa, veículo, e-mail pendente e validado, situação, formas de
  recebimento, indisponibilidade, `application`, `password_link`): ver [Cadastro V2](#cadastro-v2-2026-11-25).

E-mail e celular ficam em claro (a central desfaz uma troca indevida); chave PIX e conta, nunca. Gravam o histórico: o
`PATCH /me/profile`, o cancelamento da troca de e-mail, as rotas das formas de recebimento, a foto e o
`POST /auth/change-password` de técnico
(via app, autor o técnico); `PATCH /technicians/{id}`, `POST /technicians/{id}/reset-password`,
`POST /technicians/{id}/operational-status`, `POST /technicians/{id}/password-reset-link`, `POST`/`DELETE
/technicians/{id}/photo`, `DELETE /technicians/{id}/payout-methods/{method_id}` e o `PATCH /users/{id}` de técnico (via
central, com o autor); a aprovação da ficha (via ficha, autor: quem aprovou; a linha "Aprovado na homologação", e o
perfil técnico que vem da ficha entra sem linha própria); e o link do e-mail (via link: a senha nova e o e-mail
validado). A importação por planilha e a do Field Control não entram.

Na web (cadastro do técnico), a senha aparece como "Senha redefinida (provisória)", "Senha definida pela central",
"Senha criada no app" ou "Senha trocada no app" (e as duas pelo link do e-mail).

**Central.**
- `GET /technicians/{id}` (Técnicos, ver) → `TechnicianOut`; 404 "Técnico não encontrado" (também para quem não é
  técnico). Declarada depois das rotas fixas (`/regions`, `/nearby`, `/suggest`).
- `GET /technicians/{id}/changes?limit=50&before=&field=` (`limit` de 1 a 200; Técnicos, ver) → `UserChange[]`, do mais
  novo para o mais antigo (`created_at DESC, id DESC`). `field` (desde 25/11/2026; `^[a-z_]{1,40}$`, senão 422): só as
  linhas que mexeram nesse campo (a ficha usa `operational_status` para o histórico da situação).
  - Páginas: `before` = `"{created_at}|{id}"` da última linha recebida (o `created_at` como veio, ISO com fuso) traz
    as `limit` linhas seguintes, mais antigas, sem repetir nem pular (o id desempata as do mesmo instante). Sem
    `before`, ou vazio, as mais novas. Estragado (mais de 100 caracteres, separador errado, data sem fuso ou fora da
    faixa, id que não é UUID): 422 `{"detail": "Página do histórico inválida. Recarregue a ficha."}`. Desde 24/11/2026; a API
    de antes não tem o parâmetro: ignora e devolve as mais novas de novo.
  - Com Pagamentos (Visualizar ou Editar), como acima.
  - Com Técnicos e sem Pagamentos (`commercial.payouts` Sem acesso; `user_history.hide_payout`, até 24/11/2026
    `hide_pix`): o `from`/`to` de `pix`, `payout_methods` e `payout_preferred` vira `"***"` (null continua null) e os
    itens `pix_holder` das linhas antigas não vêm (a troca só do titular aparece como
    `{"field": "pix", "from": "***", "to": "***"}`). Na web, "Formas de recebimento alteradas", "Forma preferencial
    alterada" e, nas linhas antigas, "Chave PIX cadastrada", "Chave PIX alterada" ou "Chave PIX removida", sem valor e
    sem titular. A máscara vale em todas as páginas.
  - Na web (seção Histórico da ficha do técnico), páginas de 50: a vista começa com 10 linhas e cada "Ver mais" mostra mais 20,
    buscando a página seguinte quando as carregadas acabam, até a primeira linha (a troca antiga de PIX ou de e-mail
    continua ao alcance, mesmo com muitas linhas do salvar ao tocar). As páginas se juntam sem repetir linha, e o "Ver
    mais" some quando a página vem incompleta ou sem linha nova (com a API sem o `before`, nas 50 mais novas). Com a
    página seguinte em erro, o aviso com "Tentar de novo" fica no lugar do botão. O tempo real e o salvar da ficha
    releem as páginas já abertas.
- Formas de recebimento (desde 25/11/2026, no lugar da chave PIX única): `GET /technicians/{id}/payout-methods`
  (Pagamentos, ver) e `DELETE /technicians/{id}/payout-methods/{method_id}` (Pagamentos, editar), com o histórico via
  central e o aviso `["payout_methods"]`; `TechnicianOut.payout_methods_count` e `payout_changed_at`. Saíram
  `DELETE /technicians/{id}/pix` e `TechnicianOut.has_pix`/`pix_updated_at`. Ver [Cadastro V2](#cadastro-v2-2026-11-25).
- `GET /payouts?with_payout_methods=true` → `PayoutBoard = PayoutList + payout_methods: {technician_id:
  PayoutMethodSummary}` (a preferencial inteira e quantas formas): os técnicos das linhas e o do `technician_id`, só os
  que têm forma. Sem o parâmetro, `payout_methods: {}`. Até 24/11/2026 eram `with_pix` e `pix: {technician_id: PixInfo}`.
  `GET /me/earnings` não muda.
- Na web (Pagamentos), o extrato do WhatsApp (botão WhatsApp e "Copiar extrato") passa pelo endereço do wa.me e leva a
  linha "Forma de recebimento: {payoutMethodText}" ("PIX CPF •••.456.789-••", "Banco Exemplo ••••5678-9"), mascarada
  para todos os tipos de chave e para as contas, ou "Forma de recebimento: não cadastrada (cadastre no app, em Perfil ›
  Configurações › Formas de recebimento)". "Copiar PIX" copia a chave crua; "Copiar dados" copia a conta inteira com o
  titular.
- Na web, os textos que mandam o técnico cadastrar onde recebe citam o caminho do app, Perfil › Configurações › Formas
  de recebimento: o "Pedir no WhatsApp" de Pagamentos e da ficha do técnico ("Olá, {primeiro nome}! Cadastre onde quer
  receber no app Maxx Field, em Perfil › Configurações › Formas de recebimento, para receber pelos chamados.") e a linha
  do extrato.
- `POST /payouts/pay`: o `payout_set` do pagamento (`data.action: "paid"`) ganha `data.payout_method`, a forma
  preferencial mascarada daquele momento (`"PIX CPF ***.456.789-**"`, `"Banco Exemplo ****5678-9"`), quando o técnico
  tem forma; os eventos de antes de 25/11/2026 têm `data.pix`, e a web lê os dois.
- Rótulos dos erros de validação (`main.py`): `pix` "Chave PIX", `key_type` "Tipo da chave PIX", `holder_name`
  "Titular da conta", `home_city` "Cidade", `home_state` "UF", `coverage_area` "Região que atende",
  `address_district` "Bairro" e `address_zip` "CEP" (os do perfil técnico: ver
  [Perfil técnico](#perfil-técnico-2026-11-19); os do cadastro V2: ver [Cadastro V2](#cadastro-v2-2026-11-25)).

**Tempo real.** Depois do commit sai `{"type": "profile.changed", "user_id", "name", "actor_id", "actor_name",
"occurred_at", "data": {"fields": [...], "via": "app" | "central" | "ficha" | "link", "after_reset"?: {"by", "at"}}}`
(`audience.managers_only`; `ficha` e `link` desde 25/11/2026). Vai só para quem tem Técnicos ou Pagamentos; o técnico e
o cliente não recebem. `fields` usa os nomes crus do histórico (o titular das linhas antigas conta como "pix"). O nome
não começa com "technician." (a web mandaria o evento para o mapa).
- `after_reset` vai só na troca de e-mail (ou do pedido de troca), de forma de recebimento (`payout_methods`,
  `payout_preferred`, e o `pix` de antes) ou do CNPJ pelo app ou pelo link do e-mail, quando houve redefinição de senha
  pela central (linha do histórico via central com `password`) nas últimas 72 h: `by` é o nome de quem redefiniu
  ("Sistema" sem autor) e `at`, a hora (ISO). É só sinal: não bloqueia (quem redefiniu também soube a senha). O link
  de senha mandado pela central (`password_link`) não conta como redefinição.
- Na web, o sino avisa a troca pelo app das formas de recebimento, do e-mail (o pedido de troca), do CNPJ, do nome ou
  do celular (foto, endereço, senha, o resto do cadastro e o perfil técnico só atualizam as listas). A troca do destino
  do pagamento sai vermelha, com "Confirme com ele no grupo antes do próximo pagamento.", e "Ver" abre a ficha do
  técnico na seção do que mudou (Formas de recebimento só com Pagamentos). Com `after_reset`, o título termina em "logo
  depois de a senha ser redefinida por {by}" e o aviso fica vermelho, também na troca só de e-mail.
- `fields` traz também as partes do perfil técnico (`tools`, `availability`, `transport`, `skills`, `education`): ver
  [Perfil técnico](#perfil-técnico-2026-11-19).

**Aviso de privacidade.** `PRIVACY_VERSION` = "2026-11-25" (era "2026-11-20"; o `GET /public/onboarding/catalog`
devolve a versão nova e a ficha grava a do servidor no aceite). Na publicação, vale a data do dia, igual nos três
lugares.
- O texto (`PRIVACY_NOTICE`) e a versão (`PRIVACY_VERSION`) ficam em `frontend/src/lib/constants.ts` e
  `mobile/src/lib/constants.ts`, cópias idênticas; `frontend/src/lib/onboarding.ts` só reexporta. Mudar o texto pede
  mudar a versão nos dois lados (as duas cópias e `backend/app/schemas/onboarding.py`), no mesmo dia.
- Formato "AAAA-MM-DD"; uma segunda versão no mesmo dia ganha ".2" ("AAAA-MM-DD.N"). As versões se comparam como texto.
  Para mostrar, `PRIVACY_DATE` = os 10 primeiros caracteres em "DD/MM/AAAA" ("25/11/2026"; um ".2" não aparece).
- A ficha da web compara a versão do servidor com a do pacote ao abrir, na última etapa e no envio: se a do servidor
  for mais nova, a página está velha, mostra "O aviso de privacidade mudou" com **Recarregar** e não envia. Por isso,
  publique a web antes da API, ou junto: com a API na frente, nenhuma ficha envia até a web nova entrar.
- O aviso cita as notas fiscais (número, valor, datas e o arquivo, que pode trazer CPF ou CNPJ e endereço, guardadas
  pelo prazo da legislação fiscal); o Elo (atendimentos dos últimos 12 meses: quantidade, chegada no horário, retornos
  e visitas perdidas, visto em Meu elo, com revisão de uma ocorrência pela central); desde a "2026-11-20", o perfil
  técnico, informado na ficha ou no app (aptidões, formação, ferramental, meios de transporte e CNH, e os dias e turnos
  disponíveis), que ajuda a central a escolher quem convidar para cada OS e que o técnico atualiza no app, em
  Configurações, e os registros das ofertas de OS no app (quando o técnico vê a oferta, abre o escopo e aceita ou
  recusa: `viewed_at`, `scope_read_at`, `responded_at`); e, desde a "2026-11-25", 11 seções na ordem: Quem trata seus
  dados, Quais dados (CPF, RG com órgão emissor e UF, nascimento, telefone secundário, a validação de que o e-mail é
  dele, mini biografia, veículo com modelo e placa, os dados da empresa, as formas de recebimento, chaves PIX e contas
  bancárias com o nome e o CPF ou CNPJ do titular, e os períodos de indisponibilidade), Para quê (o pagamento na forma
  marcada como preferencial), **Situação na operação** (ativo, inativo ou bloqueado, com o motivo, quem e quando; só
  quem está ativo recebe OS; a situação sozinha não tira o acesso ao app), Com quem compartilhamos (o envio dos e-mails
  e a consulta de CEP, que leva só o CEP; a instituição financeira no pagamento), **E-mails** (só mensagens do
  cadastro, automáticas e sem resposta), Localização (GPS), Notas fiscais, Elo, Por quanto tempo (a ficha reprovada
  fica 180 dias contados da última análise e pode ser reaberta nesse prazo; o registro dos e-mails, 180 dias) e Seus
  direitos (o CPF, depois de informado, só a central corrige). O texto final pede a revisão do dono ou do jurídico antes
  de publicar.
- No app (Perfil › Aviso de privacidade), a tela mostra o mesmo texto, só para leitura, com "Atualizado em
  {PRIVACY_DATE}": não grava ciência nem pede aceite de novo. Na versão nova, o cartão de Hoje avisa "Agora ele inclui
  RG, veículo, empresa e formas de recebimento." (na "2026-11-20": "Agora ele fala do seu perfil técnico e dos registros
  das ofertas de OS.").

## Perfil técnico (2026-11-19)

**Por quê.** O técnico informa no app (Perfil › Configurações, grupo Perfil profissional; até 24/11/2026, Atendimento) o
que ajuda a central a escolher quem chamar: o ferramental que tem, os dias e turnos em que está disponível, o
transporte e a CNH, as aptidões e a formação. Só ele muda; a central vê na ficha do técnico em Técnicos (desde
25/11/2026, nas seções do grupo Perfil profissional da página `/tecnicos/{id}`; antes, na aba **Perfil técnico**),
filtra a base e mantém o catálogo de ferramentas. Código: `services/tech_profile.py` (regras, textos e o sinal da sugestão), `schemas/tech_profile.py` (os
itens e o catálogo), `schemas/my_profile.py` (as listas inteiras), `services/my_profile.py`, `services/user_history.py`,
`api/routes/catalog.py` (seção "ferramental dos técnicos"), `services/technicians.py`, `services/suggestions.py` e
`services/onboarding.py`.

**Dados** (migração `f5a7c9e1b3d6`, depois de `e4b6d8f0a2c3`).
- `users` ganha colunas, todas NOT NULL com default (a importação do Field Control e os INSERT em lote não passam por
  elas):

  | Coluna | Default | Conteúdo |
  |---|---|---|
  | `tool_ids` | `[]` | ids (texto) do catálogo, ordenados pelo texto; inclui os desativados que já estavam marcados (ficam guardados) |
  | `availability` | `[]` | turnos `"dia:turno"` (`"sat:afternoon"`), sem repetir, na ordem da grade |
  | `transport_modes` | `[]` | meios de transporte, na ordem da lista |
  | `has_driver_license` | `false` | CNH (só vale com a parte `transport` informada) |
  | `skills` | `[]` | `[{name, level, since}]`, já ordenadas |
  | `education` | `[]` | `[{id, course, level, institution, start, end}]`, já ordenadas |
  | `tech_profile_stamps` | `{}` | `{parte: {at, via}}`, só das partes já informadas |

- Tabela `tool_catalog` (modelo `TechnicianTool`, em `models/catalog.py`): `id`, `name` (até 80, único exato:
  `uq_tool_catalog_name`), `is_active` (padrão true), `created_at` e `updated_at`. Começa com 20 ferramentas de TI de
  campo (`DEFAULT_TOOLS`): Alicate de corte, Alicate de crimpar, Alicate de inserção (punch down), Caneta óptica (VFL),
  Escada, Etiquetadora, Ferro de solda, Furadeira, HD externo, Jogo de chaves Phillips e fenda, Kit de limpeza,
  Lanterna, Localizador de cabos, Máquina de fusão de fibra óptica, Multímetro, Notebook com cabo console,
  Parafusadeira, Pendrive de instalação, Testador de cabo de rede e Trena.
- `ticket_offers.scope_read_at` (ver [Ofertas de OS](#ofertas-de-os-2026-11-18)).
- Backfill: os técnicos com ficha aprovada recebem a disponibilidade, o transporte e as aptidões da ficha, via "ficha"
  (o mapa de "Aprovação da ficha", abaixo, copiado na migração; `tests/test_tech_profile.py` confere a cópia). Só
  preenche quem ainda tem `tech_profile_stamps` vazio: rodar de novo não muda nada. Disponibilidade ou aptidões da
  ficha que não são lista (um texto JSON, um objeto, null) viram nada, como na aprovação (a migração lê o JSONB da
  ficha como texto, `::text`, e decodifica), e os nomes saem limpos como no serviço. O downgrade apaga o perfil técnico
  e o catálogo. Depois de rodar em produção (20/11/2026), o arquivo da migração mudou só nessas duas coisas do backfill
  e nas docstrings, sem schema: um banco que já está em `f5a7c9e1b3d6` não roda a migração de novo.
- Sem índice novo: os filtros varrem só os técnicos (GIN em `tool_ids`/`availability` se a base passar de dezenas de
  milhares de técnicos). As colunas JSONB se gravam sempre com objetos novos (`user.skills = [...]`): mudar a lista
  no lugar não grava.

**Valores e limites** (`services/tech_profile.py`; os rótulos e os limites são os mesmos de `lib/constants.ts`).
- Dias (`Weekday`): `mon` a `sun`. Turnos (`DayPeriod`), em horas do fuso da operação (a hora do fim não entra):
  `morning` manhã 06h–12h, `afternoon` tarde 12h–18h, `evening` noite 18h–24h e `night` madrugada 00h–06h **do
  próprio dia** (`sat:night` é sábado das 00h às 06h). São 28 turnos (`ALL_SLOTS`), na ordem da grade: de segunda a
  domingo; manhã, tarde, noite, madrugada. Não é a jornada (o turno com GPS) nem o `work_schedule` da central.
- Meios (`TransportMode`): `car` Carro, `motorcycle` Moto, `bicycle` Bicicleta, `public_transport` Transporte público,
  `ride_app` Carro de aplicativo, `on_foot` A pé.
- Nível da aptidão (`SkillLevel`): os da ficha, `basico` Básico, `intermediario` Intermediário, `avancado` Avançado.
- Nível da formação (`EducationLevel`): `high_school` Ensino médio, `technical` Técnico, `undergraduate` Graduação,
  `postgraduate` Pós-graduação, `certification` Certificação, `free_course` Curso livre.
- Limites: 200 ferramentas (também o tamanho do catálogo), 28 turnos (cada um com até 16 caracteres), 6 meios, 30
  aptidões (nome de 2 a 80), 20 cursos (curso e instituição de 2 a 120), meses de "1950-01" até o mês atual (o servidor
  aceita até o atual + 1: folga de fuso entre o aparelho e Brasília).
- Textos (nome da aptidão, curso, instituição e nome da ferramenta) se gravam limpos (`clean`): saem os caracteres de
  controle (categoria Cc, como U+0000) e de formatação (Cf: espaço de largura zero, BOM, marcas de direção como
  U+202E), e tab, LF, VT, FF e CR viram espaço; depois, NFC e espaços colapsados. O tamanho conta depois de limpar:
  nome só de invisíveis recebe a mensagem de vazio do campo ("Informe o nome da aptidão", "Informe o curso"…), e um
  U+0000 no curso sai do texto (200). A comparação sem acento e sem maiúsculas (`fold`: aptidão e formação repetidas,
  nome repetido no catálogo) limpa do mesmo jeito: "Lin<U+200B>ux" repete "Linux". A aprovação da ficha e a cópia da
  migração limpam igual, e o app também (`cleanText` e `foldName` em `mobile/src/lib/techProfileForm.ts`).
- Textos curtos, iguais na API e nas telas: "sáb · tarde", "seg a sex · manhã e tarde; sáb · manhã" (`slots_text` e
  `slotsText`), "Carro, Moto · com CNH" e "Nenhum · sem CNH" (`transport_text`), "02/2022 a 12/2023" e "desde 02/2024
  (em andamento)" (`education_period_text`).

**`GET /me/profile`** (papel `technician`) → `MyProfile` com o perfil técnico:
- `tool_ids`: só as ferramentas **ativas** do catálogo, na ordem do nome;
- `availability`: na ordem da grade;
- `transport: {modes, driver_license} | null` (null: nunca informou);
- `skills: [{name, level, since}]`, com `since` "AAAA-MM-DD" (o dia, em Brasília, em que a aptidão entrou no perfil): o
  "desde" mais novo primeiro, depois o nome;
- `education: [{id, course, level, institution, start, end}]`, meses "AAAA-MM", `end` null em andamento: os em
  andamento primeiro, depois o fim e o início mais novos, depois o curso;
- `tech_profile_updated: {tools, availability, transport, skills, education}`, cada uma `{at, via: "app" | "ficha"} |
  null` (null: nunca informada).

```json
{
  "id": "…", "name": "Tecnico Alfa", "email": "tecnico.alfa@exemplo.com", "...": "...",
  "tool_ids": ["5b1e…", "9c40…"],
  "availability": ["mon:morning", "mon:afternoon", "sat:morning"],
  "transport": {"modes": ["car"], "driver_license": true},
  "skills": [{"name": "Windows 10/11", "level": "intermediario", "since": "2026-11-12"}],
  "education": [{"id": "1f0c…", "course": "Técnico em redes", "level": "technical",
                 "institution": "Escola Exemplo", "start": "2024-02", "end": null}],
  "tech_profile_updated": {
    "tools": {"at": "2026-11-19T14:02:11Z", "via": "app"},
    "availability": {"at": "2026-11-12T10:00:00Z", "via": "ficha"},
    "transport": {"at": "2026-11-12T10:00:00Z", "via": "ficha"},
    "skills": {"at": "2026-11-12T10:00:00Z", "via": "ficha"},
    "education": null
  }
}
```

**`PATCH /me/profile`** com `tool_ids`, `availability`, `transport`, `skills` ou `education` (`MyProfileUpdate`):
- Nenhuma parte pede `current_password`, e a senha provisória não trava (só e-mail, dados da empresa e formas de
  recebimento; até 24/11/2026, e-mail e PIX).
- Cada parte vem **inteira** e substitui a gravada: `[]` ou null limpa (menos `transport`). Só conta o que veio no
  corpo; o app manda uma parte por vez.
- A resposta é o `MyProfile` normalizado. Sem nada novo: 200, sem histórico, sem carimbo e sem aviso. A parte que muda
  de verdade ganha o carimbo `{at: agora, via: "app"}`.
- Uma gravação por vez por técnico (a trava da linha: ver "Ordem do `PATCH`" em
  [Meu cadastro do técnico](#meu-cadastro-do-técnico-2026-11-18)): duas partes gravadas juntas ficam as duas
  carimbadas (o transporte não volta null no `GET`), e o histórico de cada gravação sai do que a outra já gravou.

| Parte | Normaliza | Muda quando |
|---|---|---|
| `tool_ids` (ids de `GET /technician-tools`, até 200) | repetidos contam uma vez; id **desativado** é ignorado; os desativados já gravados ficam guardados (voltam se a central reativar) | o conjunto final (os enviados ativos mais os guardados desativados) é outro |
| `availability` (até 28) | sem repetir, na ordem da grade | o conjunto é outro; `[]` sem a parte informada não muda nada |
| `transport` (`{modes, driver_license}`, até 6 meios) | meios sem repetir, na ordem da lista | a parte nunca foi informada, ou (meios, CNH) mudou. `{modes: [], driver_license: false}` na 1ª vez é informação ("Nenhum · sem CNH"; no app, o "Nenhum" no fim dos meios) |
| `skills` (`[{name, level}]`, até 30) | nome limpo; o servidor põe o `since`: o de uma aptidão gravada com o mesmo nome (sem acento e sem maiúsculas) fica, e a nova ganha hoje (dia de Brasília) | o conjunto de (nome, nível) é outro: trocar só a grafia ("linux" → "Linux") grava, e o "desde" fica |
| `education` (`[{id?, course, level, institution, start, end?}]`, até 20) | textos limpos; `end` vazio = null; item com o `id` de um curso gravado mantém o id; sem `id` (ou com um desconhecido), reaproveita o id de um gravado igual (curso, nível, instituição, início e fim) que nenhum outro item citou, senão ganha um novo | o conjunto de (id, curso, nível, instituição, início, fim) é outro |

Reordenar não é mudança. As comparações são as mesmas do histórico do cadastro (`tech_profile.wanted` e
`user_history.snapshot` usam `tool_set`, `slot_set`, `transport_key`, `skill_set` e `education_set`): a rota só grava
quando o histórico tem mudança, e uma comparação diferente devolveria 200 sem gravar.

```json
{"tool_ids": ["5b1e…", "9c40…"]}
{"availability": ["mon:morning", "mon:afternoon", "sat:morning"]}
{"transport": {"modes": ["car", "motorcycle"], "driver_license": true}}
{"skills": [{"name": "Windows 10/11", "level": "avancado"}, {"name": "Fibra óptica", "level": "basico"}]}
{"education": [{"id": null, "course": "Técnico em redes", "level": "technical", "institution": "Escola Exemplo",
                "start": "2024-02", "end": null}]}
```

**Erros (422).** Os de validação vêm em `detail` como lista, com `msg` e `label`; a ferramenta que não existe vem como
`{"detail": "..."}`.

| Situação | Mensagem | `label` |
|---|---|---|
| id que não existe no catálogo | `{"detail": "Ferramenta não encontrada. Atualize a lista."}` | — |
| id que não é UUID | "Identificador inválido" | Ferramental |
| mais de 200 ferramentas, 28 turnos, 6 meios, 30 aptidões ou 20 cursos | "No máximo N itens" | Ferramental, Disponibilidade, Meios de transporte, Aptidões, Formação |
| turno fora da grade | "Turno desconhecido: sat:lunch" (o primeiro da lista) | Disponibilidade |
| turno com mais de 16 caracteres (recusado antes, sem o valor na resposta) | "No máximo 16 caracteres" | Disponibilidade |
| `transport: null` | "Informe os meios de transporte" | Transporte |
| meio fora da lista | "Escolha uma das opções: …" | Meios de transporte |
| `driver_license` ausente / null | "Campo obrigatório" / "Informe sim ou não" | CNH |
| nome da aptidão com menos de 2 caracteres, depois de limpo | "Informe o nome da aptidão" | Nome |
| nome da aptidão com mais de 80 | "No máximo 80 caracteres" | Nome |
| nível fora da lista | "Escolha uma das opções: basico, intermediario ou avancado" (na formação, os 6 códigos) | Nível |
| aptidão repetida (sem acento e sem maiúsculas) | "Aptidão repetida: Linux" (o nome do item que repete, limpo) | Aptidões |
| curso / instituição com menos de 2 | "Informe o curso" / "Informe a instituição" | Curso / Instituição |
| curso ou instituição com mais de 120 | "No máximo 120 caracteres" | Curso / Instituição |
| mês fora de AAAA-MM (mês de 01 a 12) | "Mês inválido: use AAAA-MM" | Início / Fim |
| mês antes de 1950-01 | "Confira o ano" | Início / Fim |
| mês depois do atual + 1 (Brasília) | "Use um mês até o atual" | Início / Fim |
| fim antes do início (início igual ao fim vale: curso de um mês) | "O fim não pode ser antes do início" | Formação |
| o mesmo `id` duas vezes, ou o mesmo curso, instituição (sem acento e sem maiúsculas), nível e início | "Formação repetida: Técnico em redes" | Formação |
| chave a mais num item (`since`, `added_at`…) ou no `transport` | "Campo não aceito" | — |

**Ferramental: o catálogo** (`api/routes/catalog.py`, seção "ferramental dos técnicos").

| Rota | Quem | Entrada | Resposta | Erros |
|---|---|---|---|---|
| `GET /technician-tools?active=` | a gestão e o técnico (`StaffUser`) | `active` (só a gestão: true as ativas, false as inativas; sem ele, todas) | 200 `TechnicianTool[] = [{id, name, is_active, technicians}]`, em ordem alfabética (sem acento e sem maiúsculas) | 401; 403 (cliente) |
| `POST /technician-tools` | Configurações em Editar (`setup.settings`) | `{name}` (limpo, 2 a 80) | 201 `TechnicianTool`, já ativa, com `technicians: 0` | 422 "Informe o nome da ferramenta" / "No máximo 80 caracteres" (`label` "Nome"); 409 "Já existe uma ferramenta com este nome"; 422 "O catálogo aceita até 200 ferramentas" (ativas e inativas); 403 `MODULE_FORBIDDEN` |
| `PATCH /technician-tools/{tool_id}` | Configurações em Editar | `{name?, is_active?}` (null é ignorado; chave a mais: "Campo não aceito") | 200 `TechnicianTool` | 404 "Ferramenta não encontrada"; 409 nome repetido (a própria não conta); 422 nome; 403 `MODULE_FORBIDDEN` |

- O técnico recebe só as ativas, com `technicians: null`, e o `active` é ignorado para ele. A gestão recebe em
  `technicians` quantos técnicos (papel técnico, ativos ou não) marcaram cada uma: a mesma regra do filtro `tool_id` de
  `GET /technicians`, cuja lista padrão mostra todas as situações (o número bate com o que o link abre).
- Cadastrar e renomear travam o catálogo até o fim da transação (`_lock_tool_catalog`, `pg_advisory_xact_lock`) e só
  então conferem o nome repetido sem acento e sem maiúsculas ("Multimetro" = "Multímetro") e, no cadastro, o limite de
  200: dois pedidos juntos com "Multímetro" e "multimetro" dão 201 e 409, e o catálogo com 199 recebe só mais uma. Só
  ativar ou desativar não trava. O índice único (`uq_tool_catalog_name`) fica de reserva para o nome exato, com a mesma
  mensagem.
- Sem excluir e sem ordem manual. Renomear muda para todos (o técnico guarda o id). Desativar não mexe nos técnicos: a
  ferramenta some do app, da ficha (`tool_ids`/`tools` só trazem as ativas) e do filtro da web (que lista só as
  ativas), e volta para quem tinha marcado quando reativada. O `tool_id` de uma desativada, mandado direto na API (ou
  num link `?ferramenta=` antigo), ainda acha quem a tem guardada.
- Sem evento em tempo real: outra aba da central vê a mudança na próxima busca (até 1 min), e o app busca o catálogo
  ao abrir o Ferramental e guarda na memória por 10 min (puxar a tela busca de novo).
- Ferramenta que sumiu do banco (a API não exclui; só apagando direto no banco) fica guardada nos técnicos como as
  desativadas, e o histórico do cadastro a mostra como "Ferramenta removida".
- Na web, Configurações › seção **Técnicos** › cartão **Ferramental**: a lista com Ferramenta, Técnicos ("{n}
  técnicos" abre `/tecnicos?ferramenta={id}`), Situação e Editar, a busca a partir de 13 ferramentas, "Nova ferramenta"
  e o diálogo com "Nome" e "Ativa". Com Configurações só em Visualizar, a lista fica sem os botões. Contra uma API sem
  estas rotas (404), o cartão mostra "O servidor ainda não tem o ferramental. Tente de novo mais tarde.".

**Central** (Técnicos, ver).
- `TechnicianOut`, na lista e no detalhe: `tool_ids` (só as ativas, na ordem do nome), `availability`, `transport`
  (null: nunca informou), `skills` (agora do perfil técnico, com o `since`), `education_count` e
  `tech_profile_updated_at` (a parte mudada por último; null: nada informado). `service_areas` e `application_id`
  continuam da ficha aprovada.
- Só no detalhe (`GET /technicians/{id}` e as respostas de um técnico: `PATCH`, foto, redefinição de senha e criação;
  null na lista): `tools: Ref[]` (as ativas, em ordem alfabética), `education` e `tech_profile_updated` (as cinco
  datas).
- `GET /technicians` filtra por `tool_id` (quem marcou a ferramenta; id inválido: 422 "Identificador inválido"), `day`
  (`mon` a `sun`) e `period` (`morning`, `afternoon`, `evening`, `night`), cada um opcional: os dois juntos, aquele
  turno daquele dia; só o dia, qualquer turno dele; só o turno, em qualquer dia. Quem nunca informou a disponibilidade
  não entra quando há `day` ou `period`. Valor fora da lista: 422 "Escolha uma das opções: …" (`label` "Dia" /
  "Turno"). Os filtros entram no `X-Total-Count`.
- `PATCH /technicians/{id}` não edita o perfil técnico (ignora esses campos, como qualquer campo desconhecido).
- Custo: +1 consulta (o catálogo, até 200 linhas) por chamada, e só quando algum técnico da página marcou ferramenta.
- Na web (Técnicos), a ficha abre em abas: **Cadastro**, **Perfil técnico**, **Elo** e **Histórico**. A aba Perfil
  técnico mostra cada parte com a data ("Informado pelo técnico em 19/11/2026", "Da ficha da homologação,
  12/11/2026" ou "Não informado"), a grade de 7 dias × 4 turnos ("{n} de 28 turnos"), o ferramental, o transporte com
  "Com CNH" ou "Sem CNH", as aptidões com o nível e "desde 11/2026", a formação com o período e as áreas da homologação
  com o link para a ficha. A lista ganha os filtros "Ferramenta", "Disponível no dia" e "Disponível no turno" (com dia
  ou turno, o aviso "Só quem informou a disponibilidade no app."; a ferramenta fica na URL, `?ferramenta={id}`) e, no
  CSV, as colunas `ferramental`, `disponibilidade`, `transporte`, `cnh`, `aptidoes` e `perfil_tecnico_atualizado_em`.
  Os nomes do ferramental vêm do catálogo (a lista só traz os ids): enquanto ele carrega, o Exportar fica desligado;
  com erro, avisa "Não deu para carregar o ferramental", busca de novo e não baixa.

**Histórico do cadastro** (`services/user_history.py`).
- `tools`, `availability`, `skills` e `education` (`DELTA_FIELDS`) gravam o que **saiu** em `from` e o que **entrou**
  em `to` (null: nada), e não o de → para:
  - `tools`: os nomes, em ordem alfabética, separados por ", ";
  - `availability`: os turnos em texto curto (`slots_text`);
  - `skills`: "Linux (Básico)", em ordem alfabética, separados por ", ";
  - `education`: "Técnico em redes · Escola Exemplo · Técnico · desde 02/2024 (em andamento)", pelo início, separados
    por "; ";
  - lista com mais de 10 itens: os 10 primeiros e " e mais N" (a disponibilidade já sai curta, sem esse corte).
- `transport` segue de → para: "Carro, Moto · com CNH"; null: não informado.
- Exemplos: `{"field": "tools", "from": "Furadeira", "to": "Escada, Multímetro"}`,
  `{"field": "availability", "from": "seg · madrugada", "to": "sáb · tarde e noite"}`,
  `{"field": "transport", "from": null, "to": "Carro, Moto · com CNH"}`,
  `{"field": "skills", "from": "Linux (Básico)", "to": "Linux (Intermediário)"}`.
- A aprovação da ficha não grava histórico. Na web: "Ferramental: incluiu Escada, Multímetro" e "Ferramental: tirou
  Furadeira" (uma linha cada); "Transporte: não informado → Carro, Moto · com CNH". Rótulos: Ferramental,
  Disponibilidade, Transporte, Aptidões e Formação (`USER_CHANGE_LABEL`).
- Cada envio do salvar ao tocar é uma linha (os toques de 0,6 s vão juntos), e o histórico cresce rápido: a central
  chega até a primeira linha pelo `before`, no "Ver mais" da aba Histórico (ver "Central" em
  [Meu cadastro do técnico](#meu-cadastro-do-técnico-2026-11-18)).

**Tempo real.** O `profile.changed` de sempre (só para quem tem Técnicos ou Pagamentos), com as partes em `data.fields`
(`"tools"`, `"availability"`, `"transport"`, `"skills"`, `"education"`) e `via: "app"`. **Sem aviso no sino** para
essas partes. Com um evento só de partes do perfil técnico, a web relê a base técnica (`["technicians"]`: a lista, a
ficha aberta e o histórico), as sugestões quando mudou a disponibilidade e as contagens do catálogo quando mudou o
ferramental; os outros eventos continuam relendo tudo o que depende do cadastro.

**Aprovação da ficha** (`services/onboarding.approve`, com `tech_profile.from_ficha`). O técnico criado já vem com o
perfil técnico da ficha, carimbado "ficha" com a hora em que a ficha chegou, sem histórico (o mesmo mapa da migração):

| Parte | Da ficha |
|---|---|
| Disponibilidade | a união dos códigos: `dias_uteis_manha`, `dias_uteis_tarde` e `dias_uteis_noite` → de segunda a sexta naquele turno; `sabado` e `domingo_feriado` → manhã, tarde e noite do dia; `plantao` → os 28 turnos. Código desconhecido é ignorado, e o feriado (sem equivalente) se perde |
| Transporte | com veículo, `carro` → `car` e `moto` → `motorcycle` (`outro` ou sem tipo: nenhum meio); a CNH da ficha. Só conta como informado com algum meio ou com CNH |
| Aptidões | as de nível válido, com o nome limpo (de 2 a 80), sem repetir o nome (fica a primeira), até 30; `since` = o dia (Brasília) em que a ficha chegou |

Parte vazia fica sem carimbo (não informada). O ferramental e a formação começam vazios: os textos livres de
ferramentas e de certificações da ficha não viram lista. A ficha pública (`cadastro-tecnico`) não muda.

**Sugestão de técnicos** (`services/suggestions.py`). Com horário na OS, a API calcula uma vez os turnos que a visita
toca (`visit_slots`: `[início, fim)` no fuso da operação, com o fim informado, a estimativa ou 60 min; fim igual ou
antes do início: o turno do início; até 7 dias). Para cada técnico com disponibilidade informada:
- todos os turnos da visita dentro dela: +2 pontos (`AVAILABILITY_INSIDE_POINTS`), sem motivo (não disputa espaço com
  "Livre no horário");
- algum fora: −6 (`AVAILABILITY_OUTSIDE_POINTS`, um peso bem menor que os −40 de "Ocupado no horário") e o motivo
  "Fora da disponibilidade (sáb · tarde)", com os turnos que faltam (sexta das 23h à 01h, com só "sex · noite"
  informado: "Fora da disponibilidade (sáb · madrugada)");
- sem disponibilidade informada (também quem desmarcou tudo) ou OS sem horário: neutro (0, sem motivo).

Nunca tira ninguém da lista; a vaga dos favoritos continua e o elo continua fora da conta. `TechnicianSuggestion` ganha
`availability: "inside" | "outside" | null` e `availability_gaps` (os turnos fora, na ordem da grade), em
`GET /technicians/suggest` e `GET /tickets/{id}/technician-suggestions`. Zero consulta a mais. Os pesos são um palpite
inicial, como os limites do elo. Na web, o chip âmbar "Fora da disponibilidade (…)", com o título "Pela disponibilidade
que o técnico informou no app", aparece nas sugestões e no diálogo de oferta.

**Publicação.** A migração roda antes de a API nova atender. A web e a API sobem juntas, a web segundos antes (a regra
do `PRIVACY_VERSION`; nesses segundos, a API velha ignora os filtros novos, e o cartão do Ferramental e o gráfico da
ficha mostram erro). O app sobe depois da API: `MyProfileUpdate` recusa campo desconhecido, e o app novo com a API velha
receberia 422 "Campo não aceito"; nas telas, ele trata o servidor antigo ("Indisponível no momento" / "O servidor
ainda não tem esta parte do cadastro. Tente de novo mais tarde."). A API nova com o app velho funciona. Publicado
noutro dia que não 19/11/2026, a versão do aviso vira a data do dia ("AAAA-MM-DD"), nos três lugares, no mesmo dia.
Subiu em 20/11/2026 (a versão do aviso é "2026-11-20"). As correções que vieram depois (24/11/2026) são só
código, sem migração nova: o `before` do histórico do cadastro, o `invoices` dos meses do Faturamento, o cursor "fora da faixa" do
`/me/history`, as travas do `PATCH /me/profile` e do catálogo, o 422 dos erros do banco da classe 22, os limites por
item e a limpeza dos invisíveis. A web e o app novos funcionam com a API de 20/11/2026 (sem o `before`, a ficha mostra
as 50 linhas mais novas do histórico; sem o `invoices`, o mês sem valores fica sem cartão e abre pelo "Outro mês"), e
a API nova funciona com a web e o app de antes (o campo novo é ignorado; o parâmetro novo é opcional).

**Privacidade (LGPD).** Só o próprio técnico e a gestão com Técnicos veem o perfil técnico (o aviso `profile.changed`
vai também a quem tem Pagamentos, só com os nomes das partes); o cliente, o portal e os outros técnicos nunca. O aviso
de privacidade cita o perfil técnico desde a versão "2026-11-20".

## Elo dos técnicos (2026-11-18)

**Por quê.** O técnico ganha um elo (na interface, "Elo" com a medalha: um hexágono com o emblema da faixa, a mesma
arte na web e no app, em `LEVEL_MEDAL_*` de `lib/constants.ts`) pela quantidade e pela qualidade dos
atendimentos: Bronze, Prata, Ouro e Diamante. É só reconhecimento: o elo não muda a pontuação nem a ordem das
sugestões. Código: `services/technician_levels.py`, `api/routes/technician_levels.py`,
`models/technician_level.py` e `schemas/technician_level.py`. Na API os valores ficam em inglês
(`LevelTier` = `bronze` | `silver` | `gold` | `diamond`).

**O que conta** (janela rolando de 365 dias até agora, "últimos 12 meses"):
- Atendimento (`services`): OS distintas resolvidas ou fechadas, concluídas na janela, com visita (chegada
  registrada ou OS migrada do Field Control), em que o técnico foi o responsável (`as_assignee`) ou outro técnico da
  visita (`as_helper`, sem contar duas vezes quem também é o responsável). As OS do Field Control entram.
- Atendimento medido (`measured`): os mesmos, só como responsável e só OS deste sistema (`legacy` nulo). A qualidade
  é medida nele: nas OS migradas a agenda sem hora virou 08:00 e o Field Control não trouxe reaberturas nem os
  motivos das improdutivas.
- Chegada no horário combinado: medidos com agenda e chegada (`arrivals`). Atraso (`late`) é chegar mais de 30 min
  depois do horário agendado (a regra do "Atrasada", `field.SCHEDULE_TOLERANCE`); `on_time` = `arrivals` - `late`.
  OS sem horário agendado não entram (atraso de despacho é da central). Não é o prazo de chegada do SLA.
- Retorno (`reworks`): reabertura (`status_changed` para `reopened`) de OS **deste sistema** (`legacy` nulo) resolvida
  ou fechada na janela, até 30 dias depois da conclusão reaberta (a última `status_changed` para `resolved` antes
  dela). Reabrir a cancelada não conta. A OS migrada do Field Control reaberta não conta, nem a concluída aqui depois da
  migração: ela não entra na base (`measured`).
- Visita perdida (`lost`): visita improdutiva **em OS deste sistema**, na janela, cujo motivo está **hoje** com
  responsabilidade `technician` (vale a classificação atual do catálogo, como no relatório de violações). `visits` =
  `measured` + `lost`, as duas pontas só com OS deste sistema.
- Atribuição dos eventos: o `data.technician_id` gravado no evento (daqui em diante); sem ele, o autor da conclusão
  (retorno) ou do registro (visita perdida), se for técnico; senão, o responsável atual da OS.
- Não contam: ofertas recusadas, cancelamentos, tempo na loja, formulários e assinatura (já travam a conclusão),
  violação de SLA, despesas, favoritos, "nova OS na mesma loja" (reincidência) e dados do Field Control na qualidade.

**Faixas** (`TIERS` no serviço, devolvido em `tiers`; as telas não repetem os números). Taxas só com 5 casos ou mais:
abaixo disso, "Ainda sem dados suficientes" e o critério conta como cumprido. A comparação é em inteiros
(`100*on_time >= meta*arrivals`, `100*reworks <= limite*measured`, `100*lost <= limite*visits`); a chegada no horário
aparece arredondada para baixo e as outras taxas para cima, e o número mostrado nunca contradiz o "cumprido".

| Faixa | Atendimentos | Medidos | Chegada no horário | Retorno | Visitas perdidas |
|---|---|---|---|---|---|
| Bronze | 0 | 0 | - | - | - |
| Prata | 15 | 0 | 80% ou mais | até 10% | até 8% |
| Ouro | 50 | 15 | 90% ou mais | até 5% | até 4% |
| Diamante | 120 | 30 | 95% ou mais | até 3% | até 2% |

Faixa calculada = a mais alta com todos os critérios cumpridos. **Carência** de 30 dias: sobe na hora; se a calculada
ficar abaixo da faixa em vigor, a faixa fica e começa o risco (`at_risk_since`); com 30 dias seguidos abaixo, desce
direto para a calculada (`tier_since` = agora); voltando a cumprir, o risco sai. No primeiro cálculo, vale a
calculada. Todo técnico começa no Bronze; quem tem só histórico do Field Control chega no máximo à Prata até ter
atendimentos medidos.

**Desconsiderar.** A central (Técnicos em Editar) pode desconsiderar uma ocorrência do técnico, com motivo: o atraso
vira chegada no horário; o retorno e a visita perdida deixam de contar. Fica registrado quem, quando e o motivo
(tabela `technician_level_waivers`, uma por ocorrência). O técnico não vê as desconsiderações nem as notas.

**Dados.** `technician_levels` (uma linha por técnico; sem linha, Bronze): `tier`, `computed_tier`, `tier_since`,
`at_risk_since`, `metrics` (JSONB com `window_start`, `window_end`, `services`, `as_assignee`, `as_helper`,
`measured`, `arrivals`, `late`, `reworks`, `lost`, `waived`) e `computed_at`. Caem junto com o usuário. Índice parcial
`ix_ticket_events_reopened` (a consulta dos retornos usa o mesmo predicado escrito por extenso). Sem backfill.

**Quando recalcula.** A rotina periódica (`app.main`, "Elos dos técnicos", a cada 10 min sob a trava) refaz todos
quando a conta mais antiga tem 6 h ou mais, ou quando falta algum técnico (inclusive inativos). A lista de Técnicos e
as sugestões calculam todos quando falta a conta de algum técnico, inclusive inativos (primeiro uso, técnico novo, ou só
a conta solta que o app gravou com `GET /me/level`). Um cálculo por vez (`pg_try_advisory_xact_lock`, sem esperar): quem
chega junto lê o que está guardado. `GET /me/level`, `GET /technicians/{id}/level`, desconsiderar e voltar a contar
recalculam o técnico na hora, mas só regravam a linha quando faixa, risco ou números mudam: o `computed_at` da resposta
é a hora do cálculo, e o da linha, o da última gravação. Mudar a responsabilidade de um motivo de improdutiva
(`PATCH /unproductive-reasons/{id}`) marca todos para a próxima rodada. Fora isso, a lista e as sugestões só leem a
conta guardada (até 6 h de atraso).

**Eventos.** A visita improdutiva (`unproductive_visit`) grava `data.technician_id` (o responsável da OS, também
quando a central registra) e a reabertura de OS resolvida ou fechada (`status_changed` para `reopened`) grava
`data.technician_id` do responsável no momento. Só no histórico: o tempo real não muda.

**Rotas.**
- `GET /me/level` (papel `technician`; gestão e cliente: 403) → `MyLevel {tier, since, at_risk: LevelRisk|null,
  computed_at, metrics: LevelMetrics, criteria (os da faixa em vigor; vazio no Bronze), next: {tier, criteria}|null
  (null no Diamante), tiers, rules, occurrences (as que contam, as mais recentes primeiro, até 30),
  occurrences_total}`. Só o do próprio técnico: sem outros técnicos, ranking, notas da central ou desconsiderações.
- `GET /technicians/{id}/level` (Técnicos, ver) → `TechnicianLevelDetail` = `MyLevel` + `technician: Ref`,
  `computed_tier`, `waived`, `technician_reasons` (motivos de improdutiva ativos com responsabilidade `technician`;
  0 = visitas perdidas não contam) e `occurrences` com as desconsideradas (até 200, cada uma com
  `waiver: {id, note|null, created_by: Ref|null, created_at}|null`; no retorno, o detalhe leva " · Motivo: {nota}", até
  200 caracteres). 404 "Técnico não encontrado" (também para quem não é técnico).
  - Na central, o `ticket` da ocorrência é `{id, code, title, hidden}`, com `hidden` false na OS visível (no app, em
    `/me/level`, continua `{id, code, title}`).
  - As ocorrências seguem a fila de quem pede. Com "Somente a própria fila", a de OS fora dela vem com
    `ticket: {id: null, code: null, title: "OS de outra fila", hidden: true}`, o detalhe sem " · Motivo: …" e
    `waiver.note` null (ficam `waiver.id`, `created_by` e `created_at`). `ref_id` não é mascarado (no atraso, é o id da
    OS).
  - Contagens, faixa, critérios, `waived` e `occurrences_total` continuam com todas.
- `POST /technicians/{id}/level/waivers` (Técnicos, editar) `{kind: "late"|"rework"|"unproductive", ref_id, note}` →
  201 `TechnicianLevelDetail`. `ref_id`: a OS no atraso; o evento do histórico no retorno e na visita perdida. `note`
  de 1 a 300 caracteres, sem os espaços das pontas (422 com `label` "Motivo"). Ocorrência que não é do técnico na
  janela: 422 "Ocorrência não encontrada nos últimos 12 meses"; OS de outra fila: 403 `QUEUE_FORBIDDEN` "Esta OS é de
  outra fila."; repetida: 409 "Esta ocorrência já foi desconsiderada" (`uq_technician_level_waivers_occurrence`).
- `DELETE /technicians/{id}/level/waivers/{waiver_id}` (Técnicos, editar) → 200 `TechnicianLevelDetail` (volta a
  contar); 404 "Ocorrência desconsiderada não encontrada"; OS da desconsideração em outra fila: 403 `QUEUE_FORBIDDEN`.
- `POST /technicians/levels/refresh` (Técnicos, editar) → `{technicians, bronze, silver, gold, diamond, at_risk}`.
- `TechnicianOut.level` (`GET /technicians` e as respostas de um técnico) e `TechnicianSuggestion.level`
  (`GET /technicians/suggest`, `GET /tickets/{id}/technician-suggestions`): `LevelSummary {tier, since, at_risk}`,
  sempre presente (sem conta ainda: `bronze`, `since` null). Nas sugestões, só o selo: a pontuação e a ordem não
  mudam. `TicketOfferOut` não traz o selo.
- Estatísticas e Histórico de atendimentos (`GET /me/stats`, `GET /me/history` e `GET /technicians/{id}/stats`): ver
  [Perfil do técnico: estatísticas e histórico](#perfil-do-técnico-estatísticas-e-histórico-2026-11-19).

**Formatos.**
- `LevelCriterion {key: "services"|"measured"|"on_time"|"rework"|"lost", label, met, enough_data, value, base,
  target, text, missing}`: `value` é a contagem ou os casos da taxa; `base`, a base da taxa (null nas contagens);
  `target`, o mínimo ou a meta/limite em %. Textos: "38 de 50" / "Faltam 12 atendimentos" ("Falta 1 atendimento");
  "10 de 15" / "Faltam 5 atendimentos medidos"; "92% (23 de 25) · meta 90% ou mais" / "Faltam {x} chegadas no
  horário seguidas"; "3% (1 em 40) · limite 5%" / "Com mais {y} atendimentos sem retorno, volta ao limite"; "6% (3
  em 50) · limite 4%" / "Com mais {y} atendimentos sem visita perdida, volta ao limite"; "Ainda sem dados suficientes
  (3 de 5 chegadas)".
- `LevelRisk {since, until, falls_to, failing, text}`: "Abaixo do critério desde 01/12: chegada no horário
  combinado. Se não voltar a cumprir até 31/12, passa para Prata." (datas no fuso da operação).
- `LevelMetrics {window_start, window_end, services, as_assignee, as_helper, measured, arrivals, on_time, late,
  reworks, lost, visits, on_time_pct, rework_pct, lost_pct}` (taxas null com menos de 5 casos).
- `LevelTierRule {tier, services, measured, on_time_pct, rework_pct, lost_pct, summary}` e `rules` ("Como
  funciona"), prontos para a tela.
- `LevelOccurrence {kind, ref_id, ticket: {id, code, title}, at, detail}`: "Chegou 52 min depois do horário
  combinado (10:00 de 12/11)", "Reaberta 6 dias depois da conclusão", "Visita improdutiva: {motivo}". Na central,
  `CentralLevelOccurrence` = o mesmo com `ticket: {id|null, code|null, title, hidden}` e `waiver`.

**Na central (web).** A ocorrência de OS de outra fila (`ticket.hidden`) aparece como "OS de outra fila", sem link e sem
Desconsiderar ou Voltar a contar; a desconsiderada mostra só quem e quando. O motivo de Desconsiderar digitado e não
enviado põe o ponto âmbar na aba Elo da ficha (para o leitor de tela, "motivo não enviado"). Fechar a ficha (X, Esc ou
clique fora) pergunta antes, como com o Cadastro alterado ("Há alterações não salvas."). O Salvar (que grava o
Cadastro e fecha) mostra a aba Elo e pergunta "Descartar o motivo não enviado?" ("O cadastro é salvo e a ocorrência
continua contando no elo."; sem mudança no Cadastro, só "A ocorrência continua contando no elo."): "Voltar" fica na aba
Elo, sem salvar; "Descartar" segue com o Salvar. O cadastro do técnico relê
`GET /technicians/{id}/level` em evento de OS só quando o técnico é o responsável (`assignee_id`) ou entrou na visita
(`data.added_ids`). Não relê em comentário, anexo, apontamento, decisão de pedido de peça, nem em `ticket.updated` só de
`forms`, `signature`, `expenses`, `part_requests`, `payouts`, `quotes`, `offers`, `repairs` ou `tags`. Fora isso, relê ao
voltar para a janela ou ao abrir o cadastro, quando a leitura tem mais de 1 min (cada leitura recalcula no servidor).
Os atendimentos por mês da ficha (`GET /technicians/{id}/stats`) são relidos junto com o elo. A medalha
(`LevelMedal`, a mesma arte do app) aparece no selo das listas e das sugestões, nos chips do filtro de Elo e no
cabeçalho da aba Elo da ficha.

**Responsabilidade `technician`.** Valor novo de `Responsibility` (rótulo "Técnico" em `/meta`), para motivos de
improdutiva e de violação. Nenhum motivo foi reclassificado: enquanto a gestão não marcar algum motivo de improdutiva
como "Técnico", visitas perdidas não pesam (o cadastro na central avisa). No app, o técnico continua sem ver a
responsabilidade ao escolher o motivo.

**Privacidade (LGPD).** É dado de desempenho de um terceiro: só a gestão com Técnicos e o próprio técnico veem;
cliente e portal nunca. O elo lê só 12 meses; as Estatísticas e o Histórico do técnico leem todas as OS concluídas
dele, sem gravar nada (seção seguinte). As linhas caem junto com o usuário ou a OS.

## Perfil do técnico: estatísticas e histórico (2026-11-19)

**Por quê.** A aba Perfil do app mostra o total de atendimentos desde sempre e a medalha do elo; as telas Estatísticas
e Histórico de atendimentos detalham. A central vê o gráfico "Atendimentos por mês" na aba Elo da ficha do técnico.
Código: `services/technician_levels.py` (`attended_clause`, `month_key`, `local_month`, `last_months`, `metrics_of` e
`stats`), `services/my_history.py`, `api/routes/technician_levels.py`, `schemas/technician_level.py` e
`schemas/my_history.py`. Só leitura: nada é gravado, não há evento e não há migração.

**Atendimento** (`attended_clause`): OS resolvida ou fechada, com a conclusão (`resolved_at`) e com visita (chegada
registrada ou OS migrada do Field Control), em que o técnico é **hoje** o responsável ou outro técnico da visita
(`schedule.works_on`, a mesma regra de quem vê a OS no app). É o atendimento do elo sem a janela de 12 meses. O total,
as Estatísticas e o Histórico usam o mesmo predicado, então a lista e o número batem. A busca "técnico que atuou" da
central continua com `tickets.acted_by_clause`, que também acha quem foi o responsável antes de uma troca (inclusive
pelo nome nas OS do Field Control): essas OS ficam fora daqui, porque não são atendimento dele e ele não as abre no
app.

**`GET /me/stats`** (papel `technician`; gestão e cliente: 403 "Sem permissão para esta ação") → `MyStats {computed_at,
lifetime, metrics, months}`:
- `lifetime {services, as_assignee, as_helper, legacy, first_month}`, desde sempre: `as_helper` = `services` −
  `as_assignee` (responsável e junto ao mesmo tempo conta como responsável); `legacy` = OS do Field Control;
  `first_month` = o mês ("AAAA-MM") da conclusão mais antiga, null sem atendimento.
- `metrics`: o `LevelMetrics` do elo (365 dias corridos, com as desconsiderações), a mesma conta de Meu elo. A tela
  usa `on_time_pct`, `on_time` e `arrivals` ("Chegada no horário").
- `months`: 12 meses de calendário no fuso da operação, do mais antigo ao atual (`current` true só no último), cada um
  `StatsMonth {month, current, services, as_assignee, as_helper, legacy, legacy_only, measured, arrivals, late,
  reworks, lost}`. Atendimentos, medidos e chegadas contam pelo mês da conclusão; `late`, pelo mês da chegada;
  `reworks`, pelo da reabertura; `lost`, pelo da visita improdutiva. Ocorrências desconsideradas pela central não
  contam. `legacy_only` = teve atendimento e todos vieram do Field Control: o mês não mede chegada, retorno nem visita
  perdida.
- A soma das barras pode ser menor que `metrics`: o elo conta 365 dias corridos, com a ponta do 13º mês, e o atraso
  conta pelo mês da chegada. A série não é congelada: muda com reabertura, "Corrigir horários", desconsideração e
  reclassificação de motivo. Só contam conclusões até agora (relógio errado no futuro fica de fora até a hora chegar).

```json
{
  "computed_at": "2026-11-19T13:00:00Z",
  "lifetime": {"services": 1284, "as_assignee": 1250, "as_helper": 34, "legacy": 1190, "first_month": "2019-03"},
  "metrics": {"window_start": "…", "window_end": "…", "services": 143, "...": "..."},
  "months": [
    {"month": "2025-12", "current": false, "services": 14, "as_assignee": 14, "as_helper": 0, "legacy": 14,
     "legacy_only": true, "measured": 0, "arrivals": 0, "late": 0, "reworks": 0, "lost": 0},
    {"month": "2026-11", "current": true, "services": 6, "as_assignee": 6, "as_helper": 0, "legacy": 0,
     "legacy_only": false, "measured": 6, "arrivals": 5, "late": 1, "reworks": 0, "lost": 0}
  ]
}
```

**`GET /technicians/{id}/stats`** (Técnicos, ver; sem a tela: 403 `MODULE_FORBIDDEN`; técnico: 403 "Sem permissão
para esta ação") → `TechnicianStats` = `MyStats` + `technician: Ref`. 404 "Técnico não encontrado" (também para quem
não é técnico). Só contagens, sem OS nenhuma: a fila de quem pede não muda nada, como nas contagens do elo. Na web, o
gráfico "Atendimentos por mês" da aba Elo ("143 nos últimos 12 meses · 1.284 no total"), com as séries "Maxx Field" e
"Field Control" (a segunda só quando algum mês tem atendimento do Field Control), o mês atual tracejado e a tabela "Ver
em tabela"; a resposta fica guardada por 60 s e é relida junto com o elo do técnico. O "143 nos últimos 12 meses" é o
`metrics.services` (365 dias corridos), o mesmo número da linha "Últimos 12 meses" do Elo, logo acima; a soma das barras
pode ser menor. Sem atendimento nas duas contas, "Sem atendimentos nos últimos 12 meses."; com atendimento só na ponta
do 13º mês, o gráfico sai zerado.

**`GET /me/history?limit=&cursor=`** (papel `technician`; gestão e cliente: 403) → `MyHistoryPage {items, next_cursor,
total, months}`:
- `limit` de 1 a 50 (padrão 30; fora: 422 de validação). `cursor`: o `next_cursor` da página anterior (até 200
  caracteres), opaco (base64url sem "=" de `"{resolved_at ISO com fuso}|{id}"`); null no fim.
- Ordem `resolved_at DESC, id DESC`, com paginação por chave: OS concluída enquanto o técnico rola não repete nem pula
  itens nas páginas seguintes.
- `HistoryItem {id, code, service, location_code, location_name, city, state, resolved_at, month, role, legacy}`, o
  recorte de campo: `service` = o nome do tipo de serviço ou, sem tipo, o título da OS; `location_*`, `city` e `state` =
  os da loja; `month` = o mês da conclusão no fuso da operação (as seções da lista); `role` = `assignee` (responsável)
  ou `helper` (junto); `legacy` = OS do Field Control. Nunca vêm cliente, endereço, contato, valores, etiquetas, SLA,
  analista, solicitante nem descrição.
- `total`: só na primeira página (sem `cursor`), null nas outras; é o `lifetime.services` de `/me/stats` (as duas
  diferem só numa conclusão no futuro, que a lista mostra e o total das Estatísticas ainda não conta). `months`:
  `[{month, count}]` dos meses que aparecem na página, do mais novo para o mais antigo, cada um com o total do mês
  inteiro (mesmo quando o mês continua na próxima página).
- Cursor estragado (base64, separador, data sem fuso ou fora da faixa, id): 422 `{"detail": "Página do histórico
  inválida. Puxe a lista para recarregar."}`. Fora da faixa é a data que não cabe em UTC (o ano 1 com +14:00, o
  9999-12-31 com -14:00): o servidor passa a data do cursor para UTC antes de consultar, e ela não chega ao banco. Não
  há limite de ano: o `next_cursor` sai da conclusão gravada, mesmo antiga.

**Custo.**
- `/me/stats`: as consultas do elo (`collect()`) só para o técnico (responsável, junto, atrasos, reaberturas e as
  conclusões delas, improdutivas e desconsiderações) mais 1 consulta agrupada por mês. Não chama `refresh_one`: sem
  trava, sem gravar a conta e sem commit.
- `/me/history`: no máximo 3 idas por página (a página com `limit + 1`, o `count` só na primeira e a contagem dos meses
  da página).
- Sem índice novo: rápido na base de hoje (cerca de 15 mil OS). Se um técnico passar de uns 20 mil atendimentos, vale um
  índice parcial `(assignee_id, resolved_at DESC)` nas concluídas.
- O app guarda as duas (kv `my_stats` e a primeira página em `my_history`, com a hora e o técnico) e busca fora da
  rodada de sincronização: ver `docs/MOBILE_SYNC.md`. Servidor sem estas rotas (404): o app mostra "O servidor ainda
  não tem as estatísticas. Tente de novo mais tarde." (ou "… o histórico …"). A OS do Histórico que não está no
  aparelho abre pela tela da OS, que a busca na central; enquanto a tela está aberta, a limpeza do fim do pull não a
  apaga, mesmo fechada há mais de 30 dias (`docs/MOBILE_SYNC.md` §2).

**Privacidade (LGPD).** São dados do próprio técnico: só ele e a gestão com Técnicos veem; o cliente e o portal nunca. O
histórico traz só o recorte de campo, e a central vê só contagens.

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
| `{"detail": "Esta OS é de outra fila.", "code": "QUEUE_FORBIDDEN"}` | OS fora da fila de quem pede (qualquer rota da OS, as ações por orçamento ou custo e as desconsiderações do elo) |
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
- Elo dos técnicos: `GET /technicians/{id}/level` e as respostas de desconsiderar e de voltar a contar mascaram a
  ocorrência de OS de outra fila (`ticket: {id: null, code: null, title: "OS de outra fila", hidden: true}`, sem a nota
  da reabertura e com `waiver.note` null). `POST /technicians/{id}/level/waivers` e
  `DELETE /technicians/{id}/level/waivers/{waiver_id}` em OS de outra fila: 403 `QUEUE_FORBIDDEN`. As contagens do elo
  continuam globais (agregado).
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
  tem Homologação; `technician.location` e `technician.shift`, para quem tem o Mapa ao vivo; `profile.changed`, para
  quem tem Técnicos ou Pagamentos (basta uma das duas).
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
| `commercial.payouts` | V: `GET /payouts`, `GET /tickets/{id}/offers`, `GET /technician-invoices`. E: `PUT`/`DELETE /tickets/{id}/payouts/{tech}`, `POST /payouts/pay`, `/payouts/unpay`, `POST /tickets/{id}/offers`, `POST /tickets/{id}/offers/{offer_id}/cancel`, `DELETE /technicians/{id}/pix`, `POST /technician-invoices/{id}/check`, `/uncheck`, `/reject` |
| `base.customers` | V: `GET /customers/{id}`, `GET /assets`, `/assets/{id}`. E: `POST /customers`, `PATCH /customers/{id}`, `POST`/`PATCH /assets` |
| `base.locations` | E: `POST /customers/{id}/locations`, `PATCH /locations/{id}`, `POST /locations/import` |
| `base.technicians` | V: `GET /technicians`, `/technicians/favorites`, `/technicians/{id}`, `/technicians/{id}/changes`, `/technicians/{id}/level`, `/technicians/{id}/stats`. E: `POST /technicians`, `PATCH /technicians/{id}`, `POST /technicians/{id}/reset-password`, `POST`/`DELETE /technicians/{id}/photo`, `POST /technicians/import`, `POST /technicians/regions/refresh`, `PUT`/`DELETE /technicians/favorites/{id}`, `POST /technicians/{id}/level/waivers`, `DELETE /technicians/{id}/level/waivers/{waiver_id}`, `POST /technicians/levels/refresh` |
| `base.technicians` \| `base.onboarding` | V: `GET /technicians/regions` |
| `base.technicians` \| `base.locations` | V: `GET /technicians/nearby` |
| `base.onboarding` | V: `GET /onboarding/invites`, `/onboarding/applications`, `/applications/pending-count`, `/applications/{id}`. E: `POST`/`DELETE /onboarding/invites`, `POST .../approve`, `.../reject`; `DELETE /onboarding/applications/{id}` (E e só admin e supervisor) |
| `analysis.dashboard` | V: `GET /dashboard/summary` |
| `analysis.dashboard` \| `analysis.reports` | V: `GET /reports/sla-violations`, `GET /reports/daily` |
| `analysis.reports` | V: `GET /reports/monthly` |
| `setup.forms` | V: `GET /form-templates/catalog`, `/form-templates/{id}`, `/form-templates/{id}/usage`. E: `POST /form-templates`, `PUT /form-templates/{id}` |
| `setup.messages` | V: `GET /message-templates`. E: `PUT /message-templates`, `POST /message-templates/reset` |
| `setup.service_types` | E: `POST /service-types`, `PATCH /service-types/{id}`, `POST /service-types/{id}/apply-observed` |
| `setup.users` | V: `GET /access/profiles`. E: `POST /users`, `PATCH /users/{id}` (admin e supervisor), `POST`/`PATCH /teams` |
| `setup.settings` | E: `PUT /settings/company`, `/settings/expenses`, `/settings/field`, `/ticket-tag-rules`, `POST`/`PATCH /categories`, `POST`/`PATCH /violation-reasons`, `POST /technician-tools`, `PATCH /technician-tools/{id}` |

Sem tela (toda a gestão): as leituras que a Nova OS, o editor, a OS, os filtros, a Minha fila e o Início usam
(`/customers`, `/customers/{id}/locations`, `/locations`, `/locations/{id}`, `/intake/context`,
`/service-types`, `/categories`, `/sla-policies`, `/violation-reasons`, `/unproductive-reasons`,
`/ticket-tags`, `/ticket-tag-rules`, `/form-templates`, `/users`, `/users/assignable`, `/users/{id}`,
`/teams`, `/technicians/suggest`, `/technicians/favorites/city`, `/tickets/{id}/technician-suggestions`,
`/calendar/conflicts`, `/projects`, `/queues`, `/settings/company`, `/settings/expenses`, `/settings/field`,
`/portal/inbox-count`, `/access/catalog`, `/technician-tools`) e o núcleo da OS. `GET /technician-tools` também
responde ao técnico (só as ferramentas ativas). `PUT /sla-policies` continua só do administrador e os motivos de visita
improdutiva continuam com toda a gestão.

Só do técnico (o papel; fora da matriz, gestão e cliente recebem 403): as rotas `/me/*` de sempre (ofertas, cadastro
e foto, notas fiscais, elo) e, desde 2026-11-19, `GET /me/stats`, `GET /me/history` e `GET /me/earnings/months`. O
inventário completo está em `backend/tests/test_access_routes.py` (rota nova sem classificação faz o teste falhar).

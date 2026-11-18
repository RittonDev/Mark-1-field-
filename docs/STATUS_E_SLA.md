# Status da OS e SLA

Fonte da verdade: `backend/app/services/workflow.py` (estados, transições, matriz de prioridade)
e `backend/app/services/sla.py` (prazos e pausa). O frontend espelha em `frontend/src/lib/constants.ts`
e `frontend/src/lib/workflow.ts`; o app mobile deve ler de `GET /api/v1/meta`.

## Ciclo de vida

Modelo inspirado em ServiceNow / Jira Service Management / ITIL v4, com os estados de campo do GLPI Field Service.

Caminho feliz de uma OS de campo:

```
new → triage → assigned → scheduled → en_route → in_progress → resolved → closed
```

Desvios: pendências (`on_hold_customer`, `on_hold_vendor`, com SLA pausado), cancelamento
(`cancelled`), recusa da solução (`resolved → reopened`, que volta ao fluxo) e a central reabrindo
uma OS fechada ou cancelada (`closed`/`cancelled → reopened`). A tabela abaixo é a lista completa.

| De | Para |
|---|---|
| `new` | `triage`, `assigned`, `on_hold_customer`, `cancelled` |
| `triage` | `assigned`, `on_hold_customer`, `cancelled` |
| `assigned` | `scheduled`, `en_route`, `in_progress`, `on_hold_customer`, `on_hold_vendor`, `cancelled` |
| `scheduled` | `en_route`, `in_progress`, `assigned` (desmarcar), `on_hold_customer`, `cancelled` |
| `en_route` | `in_progress`, `scheduled` (reagendar), `on_hold_customer` |
| `in_progress` | `on_hold_customer`, `on_hold_vendor`, `scheduled` (nova visita), `resolved` |
| `on_hold_customer` | `assigned`, `scheduled`, `in_progress`, `resolved`, `cancelled` |
| `on_hold_vendor` | `scheduled`, `in_progress`, `resolved`, `cancelled` |
| `resolved` | `closed`, `reopened` |
| `reopened` | `assigned`, `scheduled`, `en_route`, `in_progress`, `on_hold_*`, `resolved` |
| `closed`, `cancelled` | `reopened` (só a central, com motivo, a qualquer momento) |

## Pré-condições

- `assigned`, `scheduled`, `en_route`, `in_progress` exigem responsável. Se um **analista ou técnico**
  muda para um desses status uma OS sem responsável, ele a assume automaticamente.
- `scheduled` exige `scheduled_start`.
- `resolved` exige `resolution_notes` (a solução aplicada).
- `cancelled` e `reopened` exigem `note` (motivo).

## Regras automáticas

- Atribuir analista numa OS `new`/`triage`/`reopened` muda para `assigned`.
- Remover o analista de uma OS em campo (`assigned`…`in_progress`) volta para `new`.
- Trocar o analista de uma OS `en_route`/`in_progress` volta para `assigned`.
- Comentário do solicitante numa OS `on_hold_customer` volta para `assigned` (como no ServiceNow).
- OS `resolved` há mais de `AUTO_CLOSE_RESOLVED_DAYS` (padrão 3) fecha sozinha (aceite tácito).
- Ao atribuir, se a OS não tem grupo, herda o grupo do analista. A categoria pode definir o grupo padrão.
- Oferta de OS (`services/offers.py`): o técnico que aceita a oferta entra pela mesma atribuição da central
  (`POST /tickets/{id}/assign`), então as regras acima valem iguais: `new`/`triage`/`reopened` → `assigned`, a agenda
  que a OS já tinha fica (não vira `scheduled` sozinha, como na tela) e em espera continua em espera. O aceite conta
  como 1ª resposta (o técnico é da equipe). Definir o técnico na mão e cancelar, resolver ou fechar a OS fecham as
  ofertas pendentes; o status e o SLA não mudam por causa delas.
- Reabrir limpa `resolved_at`, `closed_at`, `cancelled_at` e `resolution_sla_met_at` (o prazo de solução
  encerrado pelo Field Control era do atendimento que terminou) e soma 1 em `reopen_count`. Limpa também a
  assinatura do responsável (`signed_at`, `signer_name`, `signer_role`, `signature_attachment_id`): com a
  assinatura exigida, a nova conclusão pede outra. O anexo e o evento da assinatura antiga ficam no
  histórico, fora do relatório do cliente, e não podem ser excluídos. O prazo de SLA
  continua o original (se já venceu, a OS aparece estourada) e o relatório do cliente continua no ar,
  mostrando a OS como reaberta até ela ser concluída de novo. Ao resolver de novo, a solução anterior vem preenchida para ajustar.

## Permissões de transição

| Papel | Pode mudar status de |
|---|---|
| admin, supervisor, analista | qualquer OS, inclusive reabrir fechada ou cancelada |
| técnico de campo | só as OS em que é o responsável, e só sair, iniciar e concluir (`en_route`, `in_progress`, `resolved`) |
| cliente (portal) | pelo portal: abrir e cancelar enquanto `new`/`triage` (as rotas internas não atendem o cliente) |

## Prioridade (matriz ITIL)

| Impacto \ Urgência | Alta | Média | Baixa |
|---|---|---|---|
| **Alto** | P1 Crítica | P2 Alta | P3 Média |
| **Médio** | P2 Alta | P3 Média | P4 Baixa |
| **Baixo** | P3 Média | P4 Baixa | P4 Baixa |

Analistas, técnicos e supervisores podem sobrescrever a prioridade; o solicitante não.

## SLA

Metas padrão (editáveis em Configurações → SLA, tabela `sla_policies`):

| Prioridade | 1ª resposta | Solução |
|---|---|---|
| P1 Crítica | 30 min | 4 h |
| P2 Alta | 1 h | 8 h |
| P3 Média | 4 h | 24 h |
| P4 Baixa | 8 h | 72 h |

- **Relógio:** 24x7, em minutos corridos, a partir da abertura.
- **1ª resposta:** primeira ação de alguém da equipe: tirar a OS de `new`/`triage` ou comentar publicamente.
- **Pausa:** em `on_hold_customer` e `on_hold_vendor`. Ao retomar, os prazos ainda abertos são
  empurrados pelo tempo pausado (`sla_paused_seconds` acumula o total).
- **Mudança de prioridade** recalcula os prazos a partir da abertura.
- **`sla_status`:** `ok`, `at_risk` (≥ 75% do prazo consumido, `SLA_AT_RISK_RATIO`), `breached`,
  `paused`, `met` (resolvida dentro do prazo).
- **Fim do relógio de solução:** a conclusão (`resolved_at`, com a OS resolvida ou fechada) ou, antes
  dela, `resolution_sla_met_at`, o que veio primeiro (`sla.resolution_end`; em SQL,
  `sla.resolution_end_col()`). Com o fim antes do prazo é `met`; depois, `breached`, congelado: a
  contagem não anda mais. A pausa depois do fim não empurra o prazo de solução.

### Prazo de solução do Field Control (OS migradas)

No Field Control o prazo de solução fecha quando a visita termina, mesmo improdutiva, e a OS guarda o
veredito ("cumprido no prazo" ou "cumprido fora do prazo", em `legacy.deadline.solution_status`). A OS
que chegou aberta com esse veredito tem o fim do prazo em `resolution_sla_met_at`: a última visita
encerrada. Assim ela não aparece com "SLA violado" e a contagem crescendo para sempre, e não entra
como violada quando for concluída aqui.

- A migração `b9e4c1a7d5f2` preencheu as OS migradas com o veredito que a importação não fechou: a
  última visita improdutiva (ou a conclusão feita aqui, se veio antes). Em 17/11 eram 53 OS abertas,
  39 no prazo e 14 fora, iguais ao FC.
- A importação preenche o campo nas OS que chegam abertas com o veredito. Nas concluídas o fim já é a
  conclusão.
- Nas OS daqui a improdutiva não fecha o prazo de solução (decisão em aberto: seguir o FC também
  nas OS novas).

### Evoluções previstas

- Calendário de horário comercial e feriados (o cálculo hoje é 24x7).
- SLA por contrato/cliente (hoje é por prioridade).
- Escalonamento automático (notificar supervisor em `at_risk`/`breached`).

## Em campo agora (regra única)

`services/field.py`: em campo agora é a OS `en_route` ou `in_progress` há até 12 h
(`FIELD_STUCK_AFTER`). "Desde quando" (`field_since`) é a última ida para deslocamento ou atendimento no
histórico; sem esse evento (OS migrada), o início do atendimento, a chegada ou a última mudança.

- Mais de 12 h em campo é dado parado (esqueceram de concluir ou de voltar a OS): não conta como em
  campo e vira alerta. Em SQL: `in_field_now_clause(now)` e `field_stuck_clause(now)`; numa OS ou
  linha de consulta: `field_stuck(t, since, now)`.
- Atividades do dia (hoje): a OS parada sai da lista e conta em `summary.stuck_in_field`.
- Minha fila e Filas da equipe: a OS parada vai para "precisa de atenção", com o motivo `field_stuck`
  ("Em campo há 13 h: conclua ou corrija"), e não conta em `in_field`. A Início (`in_field_now`) e a coluna
  "Em campo" da carga por técnico do Dashboard seguem a mesma regra.

## Técnico sem acesso

Técnico inativo no cadastro não entra no app: a OS dele fica parada até alguém liberar o acesso
(Técnicos) ou trocar o técnico. Os "inativos" do Field Control estão só sem licença e continuam na
rede, por isso o aviso é âmbar ("sem acesso · liberar"), não erro.

## Importação do Field Control (situação e agenda)

- "Agendado" só com data e técnico. Data sem colaborador (ou com um colaborador que não veio no export)
  fica "Novo" com a data, e a fila mostra "Sem técnico".
- A visita reportada (improdutiva) entra sem agenda, como a improdutiva daqui: a OS volta para
  reagendar sem virar "Atrasada". A data que saiu fica no evento da visita (`previous_schedule`).
- O export do Field Control (colaboradores e as atividades) não traz telefone de técnico; só os
  usuários do escritório têm. O telefone entra pela planilha de Técnicos (`POST /technicians/import`).

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
- Reabrir limpa `resolved_at`, `closed_at` e `cancelled_at` e soma 1 em `reopen_count`. O prazo de SLA
  continua o original (se já venceu, a OS aparece estourada) e o relatório do cliente fica suspenso até
  a OS ser concluída de novo. Ao resolver de novo, a solução anterior vem preenchida para ajustar.

## Permissões de transição

| Papel | Pode mudar status de |
|---|---|
| admin, supervisor, analista | qualquer OS, inclusive reabrir fechada ou cancelada |
| técnico de campo | só as OS em que é o responsável, e só sair, iniciar e concluir (`en_route`, `in_progress`, `resolved`) |
| solicitante | só as próprias: cancelar enquanto `new`/`triage`; fechar ou reabrir quando `resolved` (depois de fechada, só a central reabre) |

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

### Evoluções previstas

- Calendário de horário comercial e feriados (o cálculo hoje é 24x7).
- SLA por contrato/cliente (hoje é por prioridade).
- Escalonamento automático (notificar supervisor em `at_risk`/`breached`).

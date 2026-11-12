# Sincronização com os apps iOS e Android

A API já está pronta para o app do técnico funcionar **offline-first** e em **tempo real**.
Os apps ainda não foram construídos. Este documento é o contrato que eles devem seguir.

## Visão geral

```
 App (iOS/Android)                                   API FastAPI                 Web (Next.js)
 ─────────────────                                   ───────────                 ─────────────
 banco local (SQLite) ◄── GET /sync/pull?since ───── delta por updated_at
 fila de operações ───── POST /sync/push ──────────► aplica (idempotente) ──┐
                                                                            ├─► Redis Pub/Sub ──► WebSocket ──► web e apps online
 WebSocket /ws ◄──────────────── evento ticket.* ───────────────────────────┘
 push (FCM/APNs) ◄────────────── OS atribuída / novo comentário (app fechado)
```

## 1. Login e aparelho

1. `POST /auth/login` → guarde `access_token` (60 min) e `refresh_token` (30 dias) no Keychain/Keystore.
2. `POST /auth/refresh` quando receber 401.
3. `POST /devices {platform: "ios"|"android", token: <FCM token>, app_version}` após o login e
   sempre que o token de push mudar. `DELETE /devices/{token}` no logout.
4. `GET /meta` (público) traz status, rótulos, cores e transições para montar a interface.

## 2. Download (pull)

```
GET /sync/pull                 # primeira vez: OS abertas + alteradas nos últimos 7 dias
GET /sync/pull?since=<server_time da resposta anterior>
```

Resposta: `{server_time, has_more, tickets[], comments[], worklogs[], revoked_ticket_ids[]}`.

- Faça **upsert** por `id` (pode vir repetido; é seguro).
- Apague do aparelho os ids de `revoked_ticket_ids` (OS reatribuída a outro técnico).
- Se `has_more = true`, chame de novo com o novo `server_time` até vir `false`.
- O técnico de campo recebe as OS atribuídas a ele, as do grupo dele e a fila sem grupo. Analistas e supervisores recebem todas (como na web).

## 3. Envio (push) de operações feitas offline

Cada ação do técnico vira uma operação na fila local, com um `client_op_id` único (UUID gerado no aparelho):

```json
POST /sync/push
{
  "operations": [
    {"client_op_id": "8f1c…", "type": "transition", "ticket_id": "…",
     "payload": {"to_status": "en_route", "latitude": -23.56, "longitude": -46.65},
     "client_timestamp": "2026-11-11T13:02:00-03:00"},
    {"client_op_id": "a93e…", "type": "comment", "ticket_id": "…",
     "payload": {"body": "Cheguei no local", "is_internal": false}},
    {"client_op_id": "c021…", "type": "worklog", "ticket_id": "…",
     "payload": {"description": "Troca do fusor", "started_at": "…", "ended_at": "…"}}
  ]
}
```

Tipos e payloads: `transition` = `TicketTransition`, `comment` = `CommentCreate`,
`worklog` = `WorklogCreate`, `update` = `TicketUpdate` (ver `docs/API.md`).

Resultado por operação:

| status | significado | o que o app faz |
|---|---|---|
| `applied` | gravada | remove da fila, atualiza a OS com `ticket` |
| `duplicate` | já tinha sido recebida (reenvio) | remove da fila |
| `rejected` | regra de negócio/validação (`error`) | remove da fila e mostra o erro ao técnico |
| `conflict` | `expected_version` desatualizada | descarta ou pergunta ao técnico; atualiza com `ticket` |

- Cada operação roda isolada (SAVEPOINT): uma rejeitada não impede as outras.
- **Reenvie o lote inteiro** se a conexão cair no meio; a idempotência garante que nada duplica.
- Envie `expected_version` só quando o técnico editou dados vendo uma versão específica.
  Para mudanças de status do próprio técnico, omitir costuma ser o desejado (última ação vale).
- Fotos/assinaturas: `POST /tickets/{id}/attachments` (multipart, `kind=photo|signature`)
  quando houver conexão, fora do lote.

## 4. Tempo real

Com o app aberto e online, mantenha `ws(s)://<host>/api/v1/ws?token=<access_token>`:

- mande `{"type":"ping"}` a cada ~25 s;
- ao receber `ticket.*`, faça um `pull` com o último `since` (o evento não carrega a OS inteira);
- código de fechamento **4401** = token inválido/expirado → `refresh` e reconecte;
- reconecte com backoff exponencial ao perder a conexão.

## 5. Notificações push

`app/services/push.py` decide quem recebe (hoje: OS atribuída ao técnico e novo comentário na OS dele).
O provedor real **ainda não está ligado**: `LogPushProvider` só escreve no log. Para produção,
implemente `PushProvider` com Firebase Cloud Messaging (atende Android e iOS) e configure a credencial
por variável de ambiente.

## Stack sugerida para os apps

React Native + Expo (TypeScript) reaproveita tipos e lógica do frontend Next.js (`src/lib/types.ts`,
`constants.ts`, `workflow.ts`), com SQLite local (expo-sqlite), fila de operações persistida,
`expo-location` para check-in e `expo-notifications` + FCM para push.

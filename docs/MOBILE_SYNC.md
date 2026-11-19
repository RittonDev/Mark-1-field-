# Sincronização com os apps iOS e Android

A API já está pronta para o app do técnico funcionar **offline-first** e em **tempo real**.
Este documento é o contrato que o app do técnico (`mobile/`, Expo; ver [mobile/README.md](../mobile/README.md)) segue.

## Visão geral

```
 App (iOS/Android)                                   API FastAPI                 Web (Next.js)
 ─────────────────                                   ───────────                 ─────────────
 banco local (SQLite) ◄── GET /sync/pull?since ───── delta por updated_at
 fila de operações ───── POST /sync/push ──────────► aplica (idempotente) ──┐
                                                                            ├─► Redis Pub/Sub ──► WebSocket ──► web e apps online
 WebSocket /ws ◄──────────────── evento ticket.* ───────────────────────────┘
 push (FCM/APNs) ◄────────────── OS nova, oferta, visita, peça (app fechado; ainda não ligado, §5)
 lembretes locais ◄───────────── agendados no próprio aparelho: 1 dia, 1h40 e 10 min antes da visita
```

## 1. Login e aparelho

1. `POST /auth/login` → guarde `access_token` (60 min) e `refresh_token` (30 dias) no Keychain/Keystore.
2. `POST /auth/refresh` quando receber 401.
3. `POST /devices {platform: "ios"|"android", token: <FCM token>, app_version}` após o login e
   sempre que o token de push mudar. Responde `200 {"push": "live"|"simulated"}`: com `simulated` (o push
   ainda não chega ao aparelho) o app transforma as novidades do pull em notificação do sistema; com `live`
   ele não repete o aviso do push (§5). `DELETE /devices/{token}` no logout.
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
- O técnico de campo recebe só as OS em que é o responsável ou outro técnico da visita (auxiliar): grupo e fila não
  bastam (`services/tickets.py::visibility_clause` → `schedule.works_on`). Analistas e supervisores recebem as que veem
  na web (a visibilidade de filas do perfil de acesso).
- Elo do técnico (`GET /me/level`, docs/API.md "Elo dos técnicos"): na mesma rodada, a cada 30 min e no "puxar para
  atualizar", só com o app na tela (a rodada em segundo plano não busca), e quando o técnico abre (se o guardado tem
  mais de 2 min) ou puxa a tela "Meu elo". O app guarda a resposta no kv do aparelho com a hora (offline, mostra a
  última com a data). Só leitura: fora da fila de operações. Servidor antigo sem a rota (404) só adia a próxima
  tentativa em 30 min.

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
- Nota fiscal do técnico (`POST /me/invoices`, aba Ganhos): só online, fora do lote e da fila de fotos (não é de
  uma OS). Sem rede, o app avisa e o formulário fica preenchido; a `client_upload_id` repetida nas novas tentativas
  evita nota duplicada quando a resposta se perde (docs/API.md, "Notas fiscais dos técnicos").

## 4. Tempo real

Com o app aberto e online, mantenha `ws(s)://<host>/api/v1/ws?token=<access_token>`:

- mande `{"type":"ping"}` a cada ~25 s;
- ao receber `ticket.*`, faça um `pull` com o último `since` (o evento não carrega a OS inteira);
- o `ticket.offer` (oferta de OS com preço, só para os técnicos dela, sem `version`) pede também
  `GET /me/offers` na mesma rodada (docs/API.md, "Ofertas de OS"). Quem aceita primeiro fica com a OS: a lista
  não espera o upload das fotos. A rodada busca logo depois do primeiro envio da fila, entre uma foto e outra
  (se chegou outro aviso ou já passou 1 min), depois do pull e quando o pull falha por erro do servidor (não de
  rede nem de sessão). Numa busca antes do pull, a oferta cancelada com `cancel_reason = "assigned"` cuja OS
  ainda não está no aparelho com o técnico (responsável ou na visita) fica como estava, sem aviso, e a busca
  depois do pull decide (a OS pode ser justamente dele);
- código de fechamento **4401** = token inválido/expirado → `refresh` e reconecte;
- reconecte com backoff exponencial ao perder a conexão.

## 5. Notificações

**Push da central.** `app/services/push.py` (`_push_targets`) decide quem recebe e o texto: OS nova para o
técnico (e "saiu da sua lista" para o anterior), entrar ou sair da visita, OS cancelada, visita agendada ou
remarcada, oferta de OS (só para os técnicos dela) e a decisão do pedido de peça. Quem fez a ação não recebe, e
acompanhamento não vira aviso (o app não tem conversa: a central fala pelo grupo de WhatsApp). O `data` é
`{ticket_id, type}`. O provedor real **ainda não está ligado**: `LogPushProvider` só escreve no log e
`delivers(platform)` é falso, então o `POST /devices` responde `simulated`. Para produção, implemente
`PushProvider` com Firebase Cloud Messaging (`delivers` verdadeiro nas plataformas que ele atende), configure a
credencial por variável de ambiente e mande a mensagem no canal `default` do Android.

**Avisos do próprio app.** Enquanto o push não chega, o app compara a OS guardada com a do pull (só no delta,
nunca no download completo) e a lista de ofertas com a anterior, e avisa: com o app na tela, toast; fora dela
(rodada em segundo plano: jornada aberta ou tarefa periódica do sistema), notificação do sistema. Sem a permissão de
notificações, o aviso fica guardado no aparelho e vira toast quando o app volta à tela (até 20, por 6 h). **Não
repetir**: com `push: live` o app não apresenta a notificação dele (o push já avisou), e o push que chega com o app na
tela não aparece (o toast do pull já avisa).

**Onde isso chega hoje.** Fora da tela, o aviso depende de uma rodada em segundo plano, e o Expo Go não roda nenhuma:
**no Expo Go, OS nova e oferta só aparecem com o app aberto**. Num app instalado (development build), a tarefa
periódica avisa a cada 15 min ou mais (WorkManager no Android; no iOS, raramente) e a jornada aberta, a cada ~3 min. O
aviso na hora, com o app fechado, precisa do push real (FCM), ainda desligado. Os lembretes da visita são locais e
funcionam (também no Expo Go), mas só depois que o app sincronizou a OS.

**Fim de sessão na rodada em segundo plano.** Se a sessão termina durante a rodada (401 do `/auth/refresh`), ou já
estava encerrada com limpeza pendente, a rodada conclui a limpeza do fim de sessão (`sessionEnd.ts`: notificações,
jornada e, com o técnico desativado ou sem acesso ao app, os dados do aparelho) antes de terminar e desliga a tarefa
(se apagar os dados falhar, ela fica ligada e a rodada seguinte tenta de novo). O fim fica gravado no armazenamento
seguro antes de os tokens saírem: se o sistema matar o app no meio, a rodada seguinte ou a abertura conclui.

**Lembretes da visita.** Sempre locais, agendados no aparelho a partir das OS guardadas: 1 dia (24 h), 1h40 e
10 min antes do `scheduled_start`, para o responsável e os auxiliares, só na visita ainda não iniciada
(atribuída, agendada, reaberta ou pausada pela central com visita marcada). Refeitos a cada pull e a cada ação
(o deslocamento cancela, também offline); até 48, nos próximos 7 dias. Lembrete novo só é agendado com 1 min de
antecedência ou mais; o que já está agendado não é cancelado no último minuto nem até 15 min depois da hora (o
Android sem alarme exato dispara com atraso), enquanto a visita não começa. A bandeja também é limpa: o de 1 dia sai
na hora do de 1h40, o de 1h40 na do de 10 min e todos no início da visita. O servidor não agenda nada.

## Stack do app

React Native + Expo (TypeScript) reaproveita tipos e lógica do frontend Next.js (`src/lib/types.ts`,
`constants.ts`, `workflow.ts`), com SQLite local (expo-sqlite), fila de operações persistida,
`expo-location` para check-in e `expo-notifications` para os lembretes e avisos locais (o FCM entra quando o push for
ligado).

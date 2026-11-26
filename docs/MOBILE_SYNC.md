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
 leituras guardadas (kv) ◄────── elo, estatísticas, histórico, faturamento e ofertas: só leitura, fora da fila (§2)
 cadastro (só na memória) ◄────► /me/profile e as rotas dele, CEP e catálogos: só online, fora da fila (§1)
```

## 1. Login e aparelho

1. `POST /auth/login` → guarde `access_token` (60 min) e `refresh_token` (30 dias) no Keychain/Keystore.
2. `POST /auth/refresh` quando receber 401.
3. `POST /devices {platform: "ios"|"android", token: <FCM token>, app_version}` após o login e
   sempre que o token de push mudar. Responde `200 {"push": "live"|"simulated"}`: com `simulated` (o push
   ainda não chega ao aparelho) o app transforma as novidades do pull em notificação do sistema; com `live`
   ele não repete o aviso do push (§5). `DELETE /devices/{token}` no logout.
4. `GET /meta` (público) traz status, rótulos, cores e transições para montar a interface, e `mail_enabled` (o envio
   de e-mail ligado no servidor; o app lê o mesmo em `MyProfile.mail_enabled`).

**Esqueci minha senha** (sem login; docs/API.md, "Cadastro V2 (2026-11-25)"): `POST /auth/forgot-password {email}`
responde 202 com o mesmo texto, exista ou não o cadastro. O link (2 h, uso único) só vai ao técnico com acesso ao app e
e-mail de login validado e abre a página web `/definir-senha`; a senha nova encerra as sessões abertas, e a chamada
seguinte do app recebe 401 "Sessão encerrada. Entre novamente.", como na senha redefinida pela central. 429 (pedidos
demais do mesmo IP) traz o texto do servidor; 503 `MAIL_DISABLED` (servidor sem envio de e-mail) e 404 (API de antes,
sem a rota): o app manda pedir à central pelo WhatsApp. Só online, fora do lote e da fila. O e-mail digitado no login
chega à tela pela memória (`forgotHandoff`, em `lib/forgotPassword.ts`), nunca pelo endereço da rota (na versão web,
iria para a URL).

Aviso de privacidade: não há rota de ciência. A versão que o técnico abriu (`PRIVACY_VERSION`) fica só no aparelho, no
Keychain/Keystore e por técnico; com versão nova, Hoje mostra o cartão "Aviso de privacidade atualizado" até ele abrir
o aviso (vale offline e sobrevive ao Sair).

**Cadastro (Configurações).** `GET /me/profile`, `PATCH /me/profile` (só o que mudou; e-mail e dados da empresa com
`current_password`), `POST`/`DELETE /me/profile/photo`, as formas de recebimento e o link de validação do e-mail
(abaixo) (docs/API.md, "Meu cadastro do técnico" e "Cadastro V2 (2026-11-25)"): só online, fora do lote e da fila.
Toda rota do cadastro devolve o `MyProfile` inteiro, que passa a ser o cadastro das telas (`writeProfile`). Nada vai
para o SQLite nem para o kv: o cadastro fica na memória do app (`lib/profile.ts`) e sai no Sair e na troca de técnico
(nome, e-mail e celular vão também para o usuário da sessão). CPF, RG, nascimento, endereço, dados da empresa,
veículo, chaves PIX, contas e o documento do titular existem só nessa memória, nunca no SQLite, no kv nem no
SecureStore. É lido ao entrar, ao abrir cada tela de Configurações, ao puxar a aba Faturamento e, quando falta ou
passou de 6 h (o link da foto vale 12 h), ao voltar à tela inicial e ao abrir o Faturamento. As gravações (salvar,
enviar a foto e removê-la, as formas de recebimento e o link do e-mail) saem uma por vez: a seguinte espera a resposta
da anterior e não sai se a sessão mudou na espera. Uma leitura durante a qual uma gravação saiu, voltou ou ficou no ar
não é publicada: fica o que a gravação devolveu. O servidor também grava uma por vez por técnico (o
`PATCH /me/profile`, as rotas do e-mail e as das formas de recebimento travam a linha dele até o fim da transação): a
gravação seguinte que o app solta quando a anterior passou dos 20 s sem resposta, ou a de outro aparelho, espera a
anterior terminar e não apaga o carimbo nem o histórico dela.

- **Formas de recebimento** (Configurações › Formas de recebimento): `POST /me/profile/payout-methods` (incluir; a
  primeira é a preferencial, e `preferred: true` passa a preferência para a nova), `PUT …/{method_id}` (manda tudo; o
  tipo não muda), `POST …/{method_id}/preferred` e `POST …/{method_id}/remove` (excluir é `POST` porque leva a senha no
  corpo, e o `api.delete` do app não leva corpo; `lib/payoutMethods.ts`). Todas levam `current_password` e devolvem o
  `MyProfile`. Uma ação por pedido: a lista nunca vai no `PATCH`, que assim não reenvia chaves e contas a cada mudança
  nem traz de volta a que a central excluiu. Sempre há uma preferencial com a lista não vazia: excluir a preferencial
  passa a preferência para a mais nova das que ficam. A forma que a central excluiu com a tela aberta volta 404
  `PAYOUT_METHOD_NOT_FOUND`, e o app relê o cadastro.
- **E-mail de login**: o e-mail novo no `PATCH` (com a senha) não troca o login. Ele fica em `email_pending` até o
  técnico abrir o link que chega nele (página web `/validar-email`); só então vira o login, sem derrubar as sessões, e
  a leitura seguinte do cadastro leva o novo para o usuário da sessão e para o e-mail do login (`mc_last_email`).
  `POST /me/profile/email/verification` manda (de novo) o link para o pendente ou, sem ele, para o login ainda não
  validado (409 já validado, 422 endereço que não recebe mensagens, 503 `MAIL_DISABLED`, 429 depois de 3 na hora);
  `DELETE /me/profile/email/pending` cancela a troca, e o link dela deixa de valer. `email_verified_at`,
  `email_pending` e `email_link_sent_at` dão o estado que Contato mostra. Com `mail_enabled` falso, o app não pede
  troca nem link (o servidor recusaria, com 422 e 503) e não mostra o estado da validação; a troca já pedida só pode
  ser cancelada.
- **CEP** (Endereço): `GET /public/cep/{8 números}`, logado (o limite do servidor é por pessoa), devolve `CepAddress`.
  O endereço achado e o 404 `CEP_NOT_FOUND` ficam na memória (`lib/cep.ts`) até a troca de sessão. Sem rede, 503
  `CEP_UNAVAILABLE`, 429, 8 s sem resposta ou a API de antes (404 sem código), a busca fica indisponível (nada
  guardado: o mesmo CEP busca de novo) e o técnico preenche à mão. A busca nunca trava o Salvar.

**Perfil técnico** (Configurações › Perfil profissional; docs/API.md, "Perfil técnico"): `PATCH /me/profile` com uma
parte inteira por vez (`tool_ids`, `availability`, `transport`, `skills` ou `education`), sem senha. A lista enviada
substitui a anterior; o servidor normaliza e ordena, limpa os textos (sem caracteres de controle nem invisíveis, como
espaço de largura zero e marcas de direção; o app confere do mesmo jeito, com `cleanText` e `foldName`), põe o "desde"
das aptidões e o `id` das formações e devolve o cadastro como ficou, que a tela passa a mostrar. Como o cadastro: só
online, fora da fila, nada no SQLite nem no kv. O ferramental vem de `GET /technician-tools` (o técnico recebe só as
ferramentas ativas, em ordem alfabética) e as sugestões de aptidão, de `skill_suggestions` em
`GET /public/onboarding/catalog`. Os dois catálogos ficam só na memória (`lib/technicalProfile.ts`): valem 10 min
(puxar a tela relê na hora) e somem na troca de sessão.

- **Salvar ao tocar** (os turnos de Dias e horários, os meios e a CNH do Transporte e o Ferramental; `lib/autoSave.ts`):
  o toque muda a tela na hora e reinicia uma espera de 0,6 s; ao fim dela sai um `PATCH` só, com o valor final (os
  toques de perto viram uma linha no histórico da central). Uma gravação por vez: o que mudar durante o envio vai num
  segundo envio quando o primeiro volta, se ainda for diferente do gravado. Sem rede, o app avisa e não muda nada; se o
  envio falhar, a tela volta ao que está gravado e avisa. Sair da tela com o envio agendado manda na hora; o Sair ou
  outro técnico descarta o que estava pendente. No Transporte nunca informado, qualquer toque grava, mesmo voltando a
  tudo desmarcado antes do envio ("Nenhum · sem CNH"); o "Nenhum", no fim dos meios, grava sem meio e mantém a CNH.
- **Aptidões, Formação e Indisponibilidade** gravam a lista inteira (incluir e mudar pela folha, excluir pela
  lixeira). O corpo é montado na hora em que a gravação sai da fila (`saveProfileWith`), com o cadastro que a anterior
  devolveu: duas exclusões seguidas não devolvem o item apagado, e mudar um item que a anterior tirou mostra "Esta
  aptidão foi excluída." (ou "Esta formação foi excluída.", "Este período não existe mais. Puxe a tela para
  atualizar.") sem enviar nada. Enquanto uma gravação está no ar, as outras ações da lista ficam desligadas, também
  depois de sair e voltar à tela (o estado fica em `lib/technicalProfile.ts` e zera na troca de sessão); as Formas de
  recebimento usam a mesma trava, com as rotas próprias delas.
- **Indisponibilidade** (Dias e horários; `unavailability`): os períodos de/até em que o técnico não atende, sem
  motivo. O `PATCH` leva a lista inteira dos que não terminaram, o gravado com o `id` e o novo sem; o servidor tira os
  que acabaram, mantém o `id` gravado, dá `id` aos novos e devolve só os que não terminaram, pelo início. O app confere
  antes com o dia do aparelho (início a partir de hoje, até 365 dias à frente, sem dia em comum com outro período, até
  10 períodos); o servidor confere de novo com o dia de Brasília e aceita o início com um dia de folga.
- **Veículo** (Transporte; `vehicle_model` e `vehicle_plate`): campos próprios, fora do `transport` (o app de antes
  grava o `transport` inteiro e não pode apagar o veículo); vão juntos, sem senha, pela folha do veículo.
- **Ferramenta desativada pela central**: o servidor ignora a marcação (200) e o app relê o catálogo (ela some). Id que
  não existe no catálogo: 422 "Ferramenta não encontrada. Atualize a lista." (o app também relê).
- **A API sobe antes do app.** A API antiga não tem essas partes: o `GET /me/profile` vem sem elas, e o app mostra
  "Indisponível no momento" nas telas do Perfil profissional sem mandar o `PATCH` (que ela recusaria com 422 "campo
  não aceito": `MyProfileUpdate` não aceita chave a mais). O cadastro V2 (25/11/2026) segue a mesma regra: sem os campos
  novos no `GET` (`hasCadastroV2`: `cpf`, `address_number`, `email_pending`, `mail_enabled`, `payout_methods` e
  `unavailability`), Dados pessoais, Endereço, Contato, Mini biografia, Dados empresariais e Formas de recebimento
  mostram "Indisponível no momento" sem gravar nada, Dias e horários fica só com os turnos e o Transporte, sem o
  veículo. A API nova com o app antigo funciona: o `GET` ainda manda `pix` (a preferencial, quando é PIX); gravar `pix`
  recebe 422 "Atualize o app: a chave PIX agora fica em Configurações › Formas de recebimento"; o e-mail novo fica
  pendente até o link; e o `address_line` sem `address_number` vira o logradouro e limpa o número e o complemento.

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
- No fim de cada pull, o app apaga as OS fechadas ou canceladas há mais de 30 dias (`pruneOld`, com o cache de anexos e
  o que mais for delas). Ficam as que têm algo na fila e as abertas na tela agora (`holdTicket`, chamado pela tela da
  OS): a OS antiga que o técnico abriu pelo Histórico, pelo Meu elo ou pelo mês do Faturamento veio da central e não
  some com ele lendo. A retenção fica só na memória: fechada a tela, ou reiniciado o app, a OS sai no pull seguinte.

### Leituras guardadas (fora do pull)

Só leitura e fora da fila de operações: cada uma fica no kv do aparelho (a tabela de chave e valor do SQLite) com a hora
em que chegou, e a tela abre offline com o guardado e a data ("dados de…", "valores de…"). `my_level`, `my_stats`,
`my_history` e `earnings:months` levam também o id do técnico (o de um nunca aparece para outro); nada é gravado se o
técnico da sessão mudou durante a busca, e o kv inteiro sai na troca de técnico. Servidor sem a rota (404): a tela
mostra uma mensagem própria.

- **Elo** (`GET /me/level`, docs/API.md "Elo dos técnicos"; kv `my_level`): na mesma rodada, a cada 30 min e no "puxar
  para atualizar", só com o app na tela (a rodada em segundo plano não busca); quando o técnico abre (se o guardado tem
  mais de 2 min) ou puxa a tela "Meu elo"; e na aba Perfil, uma vez por foco, enquanto nada está guardado. Servidor
  antigo sem a rota (404) só adia a próxima tentativa em 30 min.
- **Estatísticas** (`GET /me/stats`, docs/API.md "Perfil do técnico: estatísticas e histórico"; kv `my_stats`): fora da
  rodada. A tela Estatísticas busca ao abrir e ao voltar a ela (se o guardado tem 2 min ou mais) e ao puxar; a aba
  Perfil, no foco (se o guardado tem mais de 10 min) e ao puxar. Pedidos ao mesmo tempo dividem a mesma busca.
- **Histórico de atendimentos** (`GET /me/history?limit=30`, as páginas seguintes com o `cursor` da anterior; mesma
  seção do docs/API.md; kv `my_history`, só a primeira página): fora da rodada. A tela busca a primeira página ao abrir
  (se a guardada tem 2 min ou mais) e ao puxar, e as outras ao rolar; sem rede no fim da lista, segue quando a conexão
  volta. A OS tocada que não está no aparelho abre pela tela da OS, que sincroniza e, se ainda faltar, busca a OS na
  central (`GET /tickets/{id}`) e grava no aparelho; com a tela aberta, a limpeza do fim do pull não a apaga (acima).
- **Faturamento** (docs/API.md "Valor por chamado" e "Faturamento do app"): os meses,
  `GET /me/earnings/months?months=12` (os totais e a situação de cada mês; kv `earnings:months`), e o mês,
  `GET /me/earnings?month=AAAA-MM` (kv `earnings:AAAA-MM`), com as notas do mês, `GET /me/invoices?month=AAAA-MM` (kv
  `invoices:AAAA-MM`). Busca ao abrir a aba, ao voltar a ela e ao abrir o mês (a busca de até 30 s atrás vale), ao
  puxar, quando uma nota entra ou sai neste aparelho e, depois de uma rodada do sync, se a última busca tem 2 min ou
  mais (pagar marca a OS como alterada e a rodada traz). Um pedido dos meses por vez. O "ocultar valores" esconde só a
  tela: os valores guardados continuam no kv. O mês abre pelo cartão (o mês sem valores só tem cartão com nota da
  competência, `invoices` maior que 0, desde 24/11/2026; sem o campo, vale 0) ou pelo
  "Outro mês", que abre qualquer mês de 2000-01 ao atual e só aparece com os meses guardados. A nota enviada noutra
  competência leva o app ao mês dela.
- **Ofertas** (`GET /me/offers`, buscada como diz o §4; kv `field_offers`): junto da lista, por oferta, se o aviso já
  saiu (`seen`), se o técnico abriu o escopo (`scope`, que libera o aceite) e quando abriu pela primeira vez
  (`scope_at`, no relógio do servidor, `serverNow`), que vai no aceite (§3). A oferta que sai da lista leva as marcas
  dela junto.

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
- Nota fiscal do técnico (`POST /me/invoices`, no mês da aba Faturamento): só online, fora do lote e da fila de fotos
  (não é de uma OS). Sem rede, o app avisa e o formulário fica preenchido; a `client_upload_id` repetida nas novas
  tentativas evita nota duplicada quando a resposta se perde (docs/API.md, "Notas fiscais dos técnicos").
- Resposta à oferta (`POST /me/offers/{id}/accept` e `/decline`, docs/API.md "Ofertas de OS"): só online, fora do
  lote (quem aceita primeiro leva, e o servidor diz na hora se a OS ainda está livre). O aceite leva o corpo opcional
  `{"scope_read_at": "…"}`, a hora guardada em `field_offers.scope_at` (§2); a oferta cujo escopo foi aberto numa
  versão antiga do app vai sem corpo. O servidor prende a hora entre a criação da oferta e o aceite, ignora valor
  inválido e só grava na passagem para aceita; a central vê "Aceitou às 14:50 · escopo lido às 14:45". A API antiga
  ignora o corpo.
- Cadastro, perfil técnico, formas de recebimento, link do e-mail, busca de CEP e "Esqueci minha senha" (§1): só online,
  fora do lote e da fila.

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
notificações, o aviso fica guardado no aparelho e vira toast quando o app volta à tela (até 20, por 6 h); o que a rodada
apura depois do fim da sessão (Sair, sessão encerrada pelo servidor, outro técnico) não é guardado, porque a limpeza
do fim de sessão já esvaziou a fila. O texto que fica (notificação e aviso guardado) leva a data, nunca "amanhã":
"Visita sáb 21/11 às 08:00 · …" e, na oferta, "responder até sáb 21/11 09:00"; o dia relativo fica só no toast na
hora. **Não repetir**: com `push: live` o app não apresenta a notificação dele (o push já avisou), e o push que chega
com o app na tela não aparece (o toast do pull já avisa).

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

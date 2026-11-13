# Maxx Field — app do técnico de campo (React Native + Expo)

App de campo dos técnicos do MaxxChamados (marca **Maxx Field**): lista as OS do dia e a agenda, muda status com check-in
por GPS, registra acompanhamentos, horas e fotos, e **funciona sem internet**. Tudo o que o técnico
faz entra numa fila no aparelho e é enviado quando a conexão volta, seguindo o contrato de
[docs/MOBILE_SYNC.md](../docs/MOBILE_SYNC.md).

**O app é só para técnicos de campo** (papel `technician`), no Android e no iOS. Analistas e gestores
(analista, supervisor, administrador) fazem a gestão das OS pelo navegador; solicitantes usam o portal web.
O login envia `channel: "mobile"` e a API recusa os outros papéis com 403.

| | |
|---|---|
| Expo SDK | 58 (React Native 0.88, React 19.3) |
| Navegação | expo-router (rotas em `src/app/`) |
| Banco local | expo-sqlite |
| Tokens | expo-secure-store (Keychain / Keystore) |
| Recursos do aparelho | expo-location (check-in e rastreamento), expo-task-manager (segundo plano), expo-battery, expo-image-picker (fotos), expo-notifications (registro do aparelho), NetInfo |
| Visual | tokens da web (claro e grafite no escuro, sem azul-marinho) em `src/theme/theme.ts`, Manrope 400–700 (`@expo-google-fonts/manrope` 0.4.3 via expo-font), ícones de traço próprios em react-native-svg, degradê só em detalhes |
| Movimento | react-native-reanimated 4.7.1 + react-native-worklets 0.13.0, expo-haptics; respeita "Reduzir movimento" |

## Rodar no celular com o Expo Go

O celular e o computador precisam estar **na mesma rede Wi-Fi**. O app descobre a API sozinho:
usa o mesmo IP que o Expo Go usou para baixar o app, na porta 8000.

1. Suba a API e crie os dados de exemplo, na raiz de `maxx-chamados`:

   ```bash
   docker compose up -d
   ```

   ```bash
   docker compose exec api python -m app.seed
   ```

2. Descubra o IP do computador na rede (no Windows, `ipconfig` → "Endereço IPv4", por exemplo `192.168.0.10`).
   Libere no firewall do Windows as portas **8000** (API) e **8081** (Metro) para redes privadas, se o
   celular não conseguir abrir `http://<IP>:8000/docs` no navegador.

3. Instale o **Expo Go** no celular (Play Store / App Store), atualizado para o SDK 58.

4. Inicie o servidor de desenvolvimento. Com Node 22 instalado na máquina:

   ```bash
   npm install
   ```

   ```bash
   npx expo start --lan
   ```

   Sem Node na máquina, dá para rodar o Metro num container. Como o Docker Desktop daqui não monta o
   drive D:, o código entra por `docker cp` (troque o IP pelo seu; depois de editar o código, copie de novo):

   ```bash
   docker create --name mc-expo -it -p 8081:8081 -e REACT_NATIVE_PACKAGER_HOSTNAME=192.168.0.10 -w /app node:22-alpine sh -c "npm ci && npx expo start --lan"
   ```

   ```bash
   docker cp . mc-expo:/app
   ```

   ```bash
   docker start -ai mc-expo
   ```

5. No celular, leia o QR code com o Expo Go (Android) ou com a câmera (iOS), ou digite
   `exp://<IP>:8081` no Expo Go.

6. Entre com um técnico de campo do seed: `carlos@`, `rafael@` ou `juliana@exemplo.com.br`, senha
   `SEED_PASSWORD` do `.env` da raiz. Analistas e gestores do seed (`bruno@`, `supervisor@`, `admin@`)
   não entram no app: veem "O app é exclusivo para técnicos de campo…" e usam a web em http://localhost:3001.

Se a API estiver em outro endereço, toque em **Alterar** na tela de login e informe, por exemplo,
`192.168.0.10:8000`. Para fixar o endereço no bundle, copie `.env.example` para `.env` e preencha
`EXPO_PUBLIC_API_URL`.

## Pré-visualização no navegador (só desenvolvimento)

Para acompanhar a evolução sem celular, o mesmo `expo start` serve o app em **http://localhost:8081**
(ou `npm run web`). No Android e no iOS nada muda: as alternativas web ficam em arquivos `.web.ts(x)`
ou atrás de `Platform.OS === "web"`.

| No aparelho | Na pré-visualização web |
|---|---|
| Tokens no Keychain/Keystore (`secureStorage.ts`) | `localStorage` (`secureStorage.web.ts`) |
| SQLite nativo, transação exclusiva | SQLite do próprio SDK em WebAssembly (OPFS), transação comum; `metro.config.js` registra o `.wasm` |
| Fotos copiadas para a pasta do app, upload nativo | Foto guardada como data URL, upload por `fetch` + `FormData` (`photoFiles.web.ts`, `fileUpload.web.ts`) |
| Seletor nativo de data/hora | `<input type="datetime-local">` (`DateTimeField.web.tsx`) |
| GPS do expo-location, app de mapas | `navigator.geolocation`, Google Maps numa nova aba |
| Confirmações com `Alert` | `window.confirm` (o `Alert` do react-native-web não faz nada) |
| Registro do aparelho para push | não existe (aparece como indisponível na tela Conta) |

Requisitos:

- **Use `http://localhost:8081`**, não o IP da rede: o banco web (OPFS) e `crypto.randomUUID` só funcionam
  em contexto seguro, e `http://<IP>` não é.
- A API precisa liberar a origem no CORS: `CORS_ORIGINS=http://localhost:3001,http://localhost:8081`
  no `.env` da raiz. Sem isso, o login falha com "Não foi possível falar com…".
- O endereço padrão da API na web é o mesmo host da página, porta 8000 (dá para trocar em **Alterar**).

## O que o app faz

- **O técnico é terceiro: só o básico.** A OS mostra cliente, local (nome e endereço da loja), data e
  hora da visita e o escopo (título, tipo de serviço, descrição e recado da central), mais o fluxo de campo
  (deslocamento, chegada, atendimento, conclusão), formulários, fotos, assinatura, horas, peças e o
  relatório para o cliente. Contato da loja, prioridade, SLA, projeto, analista, solicitante, classificação
  interna da OS e reincidência não aparecem (e o servidor nem manda); sem "Ligar". As migrações 5 e 6 do
  banco local tiram do aparelho o que tinha vindo antes (notas da central, horas de colegas, prazos,
  contato da loja) sem apagar as OS, e refazem o sync.
- **Login** com `/auth/login` no canal `mobile`; tokens no Keychain/Keystore; renovação automática por
  `/auth/refresh` ao receber 401. Se o refresh for recusado por expiração, volta ao login sem apagar a
  fila (o mesmo técnico entra de novo e o que estava pendente é enviado). Se **outro** usuário entrar no
  aparelho, os dados locais são apagados.
- **Só técnicos**: o 403 do login aparece na tela. Ao abrir o app, uma sessão salva de quem não é técnico
  (por exemplo, de antes desta regra) é encerrada e o banco local apagado. Se o papel mudar no servidor
  (técnico promovido a analista), o refresh responde 401 com o motivo: o app encerra a sessão, apaga os
  dados locais, **inclusive operações ainda não enviadas**, e mostra o texto no login.
- **Primeiro acesso**: técnicos criados pelo analista ou importados recebem senha provisória
  (`must_change_password`); o app exige a troca (`POST /auth/change-password`) antes de liberar o resto e
  confere de novo em `/auth/me` a cada abertura. A troca encerra as outras sessões do usuário, então o app
  grava os tokens novos devolvidos pela API. Quem se cadastra pela homologação já entra com a própria senha.
- **Sessão encerrada pelo servidor** (senha redefinida pelo analista, usuário desativado): a API, o refresh e
  o WebSocket (4401) respondem "Sessão encerrada. Entre novamente."; o app volta ao login com esse texto e
  para o rastreamento. A fila local fica guardada para quando o mesmo técnico entrar de novo.
- **Só as OS atribuídas ao técnico**: o cliente abre a OS, o analista escolhe o técnico, e o técnico vê só
  as OS em que é o responsável (sem fila de grupo e sem "assumir"). Tela inicial com "Bom dia, {nome}",
  a data, o cartão da jornada e três abas na barra inferior (pílula animada na aba ativa):
  - **Hoje**: resumo "Hoje: X OS · Y em atendimento" (e chegadas atrasadas, em vermelho) e linha do tempo
    (horário, cliente, endereço, status) com as em campo, agendadas para hoje (ou atrasadas) e as sem agenda,
    **por urgência**: chegada atrasada primeiro, depois chegada em risco, depois em campo, horário,
    prioridade e prazo de SLA.
  - **Agenda**: calendário com visão de **mês** (grade com marcadores por dia; tocar no dia lista as OS)
    e de **semana** (dia a dia, com horário das visitas). Tocar na OS abre o detalhe.
  - **Concluídas**: resolvidas/fechadas nos últimos 7 dias.
  - Cada cartão mostra status, horário da visita (até que horas; em atendimento, o tempo correndo), o relógio
    de campo ("Chegar até 14:35 · faltam 52 min" ou "Na loja 1h 20min · restam 2h 40min") e quantas ações
    aguardam envio.
- **Jornada e rastreamento** (cartão no topo da tela inicial): termo de ciência (LGPD) aceito uma vez,
  **Iniciar/Encerrar jornada**, indicador "Rastreamento ativo" e a última posição enviada. Detalhes abaixo.
- **Aparência**: modo claro/escuro segue o sistema; dá para fixar em Conta → Aparência.
- **Detalhe da OS**: cartão de cabeçalho (código, status, cliente, endereço), stepper Deslocamento →
  Chegada → Atendimento → Concluir e barra fixa no rodapé com o próximo passo; as demais ações de
  `allowed_transitions` (e a visita improdutiva) ficam em "Mais ações", com os mesmos diálogos da web (agendar com
  início/fim, resolver com solução obrigatória, cancelar/reabrir com motivo). Em "Iniciar deslocamento" e
  "Iniciar atendimento" o check-in por GPS vem marcado (funciona sem internet). Atalhos no cabeçalho:
  **Ligar** para o contato da loja (`tel:`), **Rota** no Google Maps ou no Waze (deep link; sem o app, o
  link web do serviço) e **Copiar** o endereço. Local com endereço, contato, ligação e **Abrir no mapa**;
  descrição; prazos de SLA. Não há bloco de equipamento: a operação não controla ativos, e o app não lê
  `ticket.asset`.
- **Promessa de campo** (detalhes abaixo): prazo de chegada, 4h na loja e pedidos de peça.
- **OS de projeto**: selo "Projeto PRJ-0001 · nome" no cartão e no detalhe (somente leitura).
- **Observação da visita** (`visit_note`): o recado do analista aparece em destaque logo abaixo do cabeçalho
  da OS.
- **Equipe da visita** (`helpers`): cartão com o responsável e quem vai junto. Quem vai junto recebe a OS em
  Hoje/Agenda/Concluídas com o selo "Você vai junto" e manda fotos, mas não vê os botões de
  status, formulários, assinatura, visita improdutiva nem "Pedir peça" (a API devolve `allowed_transitions: []`).
  O evento `ticket.helpers_changed` avisa "Você vai na visita da OS-…"; quem sai da visita tem a OS conferida
  em `GET /tickets/{id}` e, sem acesso, ela sai do aparelho (o `revoked_ticket_ids` do pull não cobre esse caso;
  há também uma conferência a cada 10 min).
- **Sem acompanhamentos no app**: a central fala com os técnicos pelo grupo de WhatsApp. A observação
  opcional nas mudanças de status continua. (Os comentários seguem na web, para o portal do solicitante.)
- **Visita improdutiva** (foi ao local e não atendeu): ação em vermelho na OS atribuída, agendada, em
  deslocamento ou em atendimento → motivo (cadastro guardado no aparelho), observação e GPS. Vai pela fila
  (`unproductive`), funciona offline: a OS volta para "Atribuído" sem agenda, o relógio do atendimento para,
  e ela sai de Hoje e do calendário para a seção "Aguardando reagendamento pela central".
- **Custos extras** (Detalhes da OS): lista com tipo, valor, situação (Lançado / Aprovado / Reembolsado /
  Recusado) e total. **Somente leitura**: a gestão lança e altera; o técnico só acompanha o reembolso.
- **Apontamento de horas** (atalhos de 15 min a 2 h) e
  **fotos** da câmera ou da galeria. As fotos são copiadas para a pasta do app e enviadas por
  `POST /tickets/{id}/attachments` com `kind=photo` quando houver conexão.
- **Indicador de conexão** no topo: offline, servidor inacessível, sincronizando, online com tempo real,
  e o número de itens pendentes. Tocar abre a tela **Conta**, com a fila de envio (dá para descartar uma
  operação), os avisos de operações recusadas, "Sincronizar agora", "Baixar tudo" e o estado do push.

## Promessa de campo (chegada, 4h na loja, peças) e horário

Regras de [src/lib/field.ts](src/lib/field.ts), espelhando `backend/app/services/field.py`:

- **Chegada**: enquanto a OS está atribuída, agendada ou em deslocamento, cartão e cabeçalho mostram
  "Chegar até 14:35 · faltam 52 min" (`arrival_due_at`), em âmbar quando faltam até 60 min (ou o servidor
  diz `at_risk`) e em vermelho quando passou. Depois do check-in: "Chegou 13:42 · no prazo/com atraso".
- **4h na loja**: o check-in (primeira entrada em "Em atendimento") marca `arrived_at`; o anel no cabeçalho
  vai de `arrived_at` a `onsite_due_at` com o tempo restante. Faltando 30 min, vibra uma vez e mostra
  "Faltam 30 min do tempo do chamado: avise o analista no grupo"; ao estourar, fica vermelho. Também agenda
  duas **notificações locais** (expo-notifications, funcionam offline e no Expo Go): no aviso e no estouro
  ([src/lib/onsiteAlerts.ts](src/lib/onsiteAlerts.ts)). Check-in offline prevê o limite com as regras locais;
  o servidor confirma no próximo sync.
- **Horário é da central**: o técnico nunca mexe no horário. Na OS ele só tem "Iniciar deslocamento",
  "Iniciar atendimento" (check-in) e "Concluir"; agendar, reagendar, pausar e cancelar ficam com a central
  (o servidor recusa com 403). A aba **Tempo** mostra o tempo de atendimento, que corre sozinho do início
  à conclusão, com início e conclusão; não há apontamento de horas pelo técnico. A autorização do cliente
  antes da visita foi retirada: nada trava o deslocamento.
- **Pedir peça**: folha com descrição, quantidade, unidade, observação e até 4 fotos da câmera. Vai pela fila
  (`part_request`, funciona offline): as fotos sobem antes como anexo comum e a operação sai depois, com os
  `attachment_ids` e um `client_id` (reenviar não duplica). A lista mostra Aguardando orçamento / Orçamento
  enviado / Aprovada: pode instalar / Recusada; quando o cliente aprova, o app celebra com o check desenhado
  e vibração.
- **Avisos**: o evento `ticket.part_request_decided` do WebSocket dispara o sync; o pull compara a OS e
  avisa uma vez (peça aprovada com o check, peça recusada).
- Regras da empresa: `GET /settings/field` (prazos e aviso), baixadas a cada 30 min e guardadas no aparelho.
  Sem elas (nunca abriu online) valem as da promessa (4h de chegada nas capitais, 4h na loja, aviso 30 min
  antes). Os prazos de cada OS vêm calculados pelo servidor, então isso só afeta a previsão offline e o aviso
  local.

## Formulários (checklists) e assinatura

- O analista decide se a OS tem formulário e se ele é obrigatório. No detalhe da OS, o cartão
  **Formulários e assinatura** lista cada formulário com status e progresso (itens obrigatórios cumpridos).
- **Preenchimento** (`/formulario/<OS>/<form>`): texto, número, Sim/Não em botões grandes, opções, data,
  "Confirmo" e fotos por campo (câmera/galeria, com a contagem contra o mínimo e o máximo).
- **Uma pergunta por tela** (padrão, como o passo a passo do Field Control): "Pergunta 3 de 12", um traço
  por pergunta (respondida, pendente, em branco), **Anterior**/**Próxima** e a seção como título. Pergunta
  obrigatória sem resposta segura o "Próxima" com o aviso e a opção **Responder depois**; número inválido
  ("12a") não passa. No fim, a **Revisão** lista as respostas (tocar abre a pergunta) e **Concluir** valida;
  com item faltando, leva direto à primeira pergunta pendente. Ao reabrir, retoma de onde parou. "Ver todas as
  perguntas numa tela" volta à lista completa (com **Salvar**/**Concluir**); a escolha fica guardada.
- **Salva sozinho**: a cada troca de pergunta, ao sair da tela e com o app indo para segundo plano. Tudo vai
  pela fila de sync (`form_answers`), então funciona offline; a fila guarda só o rascunho mais recente de
  cada formulário (a conclusão nunca é descartada). **Concluir** valida antes, com as mesmas regras e textos
  do servidor ("Falta preencher: …").
- Se o servidor recusar uma conclusão por falta de item (ele não grava nada nesse caso), o app reenvia as
  mesmas respostas sem concluir, para não perder o que o técnico preencheu, e mostra o motivo no formulário.
- **Fotos de campo** vão para `POST /tickets/{id}/forms/{form}/photos` (fila offline como as outras fotos);
  uma foto sai pelo "×" da miniatura ou com toque longo (a já enviada, só online). A lista de anexos fica
  guardada no aparelho para contar as fotos de cada campo offline.
- **Assinatura** (`/assinatura/<OS>`): o responsável assina com o dedo (canvas próprio com
  `react-native-svg`, enviado como PNG via `react-native-view-shot`) e informa nome e cargo. Só fica
  disponível com os formulários obrigatórios concluídos; depois dela os formulários ficam travados. Pode ser
  refeita até a OS ser concluída. Funciona offline: a fila é enviada em ordem (fotos → respostas →
  assinatura → "Resolver").
- **Concluir a OS** ("Resolver"/"Fechar") fica desabilitado, com o motivo na tela, até cumprir os
  formulários obrigatórios e, se pedida, a assinatura (o servidor também bloqueia).
- **Relatório para o cliente**: com a OS concluída, o técnico responsável vê o cartão **Relatório para o
  cliente** no topo da OS: **WhatsApp** (o técnico escolhe a conversa com o cliente; o app não tem
  os contatos), **Compartilhar** (outros apps; sem folha de compartilhamento, copia), **Copiar link** e **Ver
  como o cliente vê**. O link vem na OS (`report_link`); OS antiga sem link pede `POST /tickets/{id}/report-link`.

## Rastreamento da jornada

- **Termo LGPD** (`/termo-rastreamento`): abre sozinho no primeiro acesso (dá para adiar; sem aceite não se
  inicia jornada) e antes da primeira jornada. Explica a finalidade (acompanhar o deslocamento até o
  cliente), quando (só durante a jornada que o técnico inicia e encerra), o que é coletado (posição,
  precisão, velocidade, direção, bateria, GPS falso) e a retenção (**90 dias**). O aceite vai para
  `POST /tracking/consent` e na mesma tela o app pede a permissão de localização do sistema ("Permitir o
  tempo todo"/"Sempre"). A data do aceite aparece em Conta.
- **GPS nas mudanças de status**: deslocamento, atendimento e resolução levam latitude/longitude (mapa de
  histórico do gestor).
- **Jornada**: `POST /tracking/shift/start` / `POST /tracking/shift/end` (com a posição do momento).
  Ao abrir o app, `GET /tracking/shift` retoma a coleta de uma jornada aberta (app fechado, aparelho
  reiniciado). Encerrar sem rede para a coleta na hora e envia o encerramento na próxima sincronização.
  Sair do app encerra a jornada.
- **Coleta**: ~30 s normalmente e ~15 s quando há OS sua **Em deslocamento** (o ritmo muda sozinho, até
  offline). Cada ponto leva bateria (`expo-battery`) e `is_mock` (`mocked` do Android).
- **Fila**: tabela `pings` no SQLite; envio em lotes de até 500 em `POST /tracking/pings`, a cada ~20 s e
  em toda sincronização. Sem rede, os pontos acumulam e sobem depois. Fora da jornada nada é gravado.
- **Segundo plano**: `expo-task-manager` + `Location.startLocationUpdatesAsync`, com foreground service e
  notificação fixa no Android e permissão "Sempre" + `UIBackgroundModes: location` no iOS (já configurado
  no `app.json` via plugin do expo-location). **Isso exige build de desenvolvimento ou de produção.** No
  Expo Go (e na pré-visualização web) o app cai para o primeiro plano e avisa: "só funciona com o app aberto".
  Para gerar o build: `npx expo run:android` / `npx expo run:ios` ou `eas build --profile development`.

## Como a sincronização funciona

```
ação do técnico ──► outbox (SQLite) ──► POST /sync/push ──► applied/duplicate: sai da fila
      │                                      │               rejected/conflict: sai da fila + aviso
      ▼                                      ▼
 OS efetiva = OS do servidor + operações pendentes (rebase)  ◄── GET /sync/pull?since= (até has_more=false)
                                                                  revoked_ticket_ids: apaga do aparelho
WebSocket /api/v1/ws?token= ── evento ticket.* ──► nova rodada de sync
            ping 25 s · 4401 → refresh e reconecta · backoff exponencial até 30 s
```

- O banco guarda duas versões de cada OS: a última do servidor (`server_json`) e a efetiva (`json`), que
  é a do servidor com as operações pendentes reaplicadas em ordem ([src/lib/ops.ts](src/lib/ops.ts)).
  Um pull no meio do caminho não desfaz o que foi feito offline, e uma operação recusada some no próximo rebase.
- Cada operação tem `client_op_id` UUID. Se a conexão cair no meio, o lote inteiro é reenviado; o
  servidor responde `duplicate` para o que já tinha recebido.
- Mudanças de status vão **sem** `expected_version` (a última ação do técnico vale, como recomenda o contrato).
- Acompanhamentos e horas aparecem na hora como rascunho local ("Aguardando envio" → "Enviado") e são
  trocados pelo registro oficial no pull seguinte.
- Rodadas de sync nunca correm em paralelo. Gatilhos: abertura/login, rede voltando, app voltando ao
  primeiro plano, cada ação, cada evento do WebSocket, puxar a lista para baixo e um intervalo de 90 s.
- Todas as escritas no SQLite passam por uma fila de transações exclusivas em JS.
- OS fechadas/canceladas há mais de 30 dias e sem pendências saem do aparelho.

## Estrutura

```
src/
  app/                 rotas (expo-router)
    _layout.tsx        sessão, tema, Stack com rotas protegidas, tarefa de rastreamento, toasts
    login.tsx          login + servidor da API
    trocar-senha.tsx   primeiro acesso (senha provisória)
    index.tsx          tela inicial: jornada + Hoje / Agenda (calendário) / Concluídas
    ticket/[id].tsx    detalhe, ações e abas
    termo-rastreamento.tsx  termo de ciência do rastreamento (LGPD)
    conta.tsx          sincronização, fila, avisos, rastreamento, aparência, sair
  components/          UI (marca, cartões, calendário, jornada, diálogo de transição, abas da OS)
    Text.tsx           Text do app: aplica a Manrope no peso do estilo (use este, não o do react-native)
    motion.tsx         entrada em cascata, transição de layout, PressableScale (0,97 com mola), Pulse
    Skeleton.tsx FieldStepper.tsx SuccessHost.tsx TabBar.tsx ActionSheet.tsx Icon.tsx RouteMapPattern.tsx
  theme/theme.ts       paleta Maxx Field, claro/escuro, preferência do técnico
  theme/fonts.ts       Manrope (pesos 400–700) e o mapeamento de fontWeight para a família
  lib/
    tracking.ts trackingTask.ts  jornada, coleta, fila de pontos e tarefa de segundo plano
    account.ts         /auth/me e troca de senha
    types.ts constants.ts workflow.ts   copiados de frontend/src/lib (manter iguais)
    syncTypes.ts       contrato de /sync/pull e /sync/push
    api.ts session.ts  HTTP com refresh + tokens no SecureStore
    db.ts              schema SQLite e consultas
    ops.ts             aplicação otimista e rebase; allowed_transitions igual ao backend
    field.ts           promessa de campo: relógios de chegada e de loja, rótulos de peças
    onsiteAlerts.ts    notificações locais do tempo na loja
    sync.ts            motor de sync, fila, fotos, gatilhos
    realtime.ts        WebSocket
    sla.ts             porta de backend/app/services/sla.py::compute_sla_status
    device.ts          POST/DELETE /devices
```

`types.ts`, `constants.ts` e `workflow.ts` são cópias exatas dos arquivos da web. Ao mudar regras de
status ou tipos no backend, atualize os três lugares (backend, `frontend/src/lib`, `mobile/src/lib`).

## Verificações

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npx expo export --platform android
```

Sem Node na máquina, rode tudo num container (o drive D: não monta no Docker Desktop daqui):

```bash
docker create --name mc-mobile-check -w /app node:22-alpine sh -c "npm ci && npx tsc --noEmit && npx expo lint && npx expo export --platform android"
```

```bash
docker cp . mc-mobile-check:/app
```

```bash
docker start -a mc-mobile-check
```

## Limitações conhecidas

- **Push**: o Expo Go não fornece token de push do próprio app (no Android o `expo-notifications` nem
  permite desde o SDK 53). O registro em `POST /devices` só acontece num development build
  (`npx expo run:android` ou `eas build --profile development`). No iOS o token é APNs; para o FCM do
  backend atender iOS será preciso o SDK do Firebase no app ou um provedor APNs no backend.
- **HTTP sem TLS**: o Expo Go aceita `http://` na rede local. Builds de produção devem apontar para
  `https://`/`wss://` (Android bloqueia texto puro por padrão e o iOS exige ATS).
- Sem sincronização em segundo plano: a fila é enviada com o app aberto.
- Rótulos e transições vêm das constantes copiadas da web, não de `GET /meta`; as ações exibidas vêm de
  `allowed_transitions` do servidor (recalculadas no aparelho só depois de uma ação offline).
- Sem assinatura do cliente, edição dos dados da OS (`update`) ou abertura de OS pelo app.

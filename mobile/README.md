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
| Visual | tema Maxx Field claro/escuro (`src/theme/theme.ts`), expo-linear-gradient para o degradê da marca |

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
  as OS em que é o responsável (sem fila de grupo e sem "assumir"). Tela inicial com três abas:
  - **Hoje**: em campo, agendadas para hoje (ou atrasadas) e as sem agenda; em campo primeiro,
    depois por horário, prioridade e prazo de SLA.
  - **Agenda**: calendário com visão de **mês** (grade com marcadores por dia; tocar no dia lista as OS)
    e de **semana** (dia a dia, com horário das visitas). Tocar na OS abre o detalhe.
  - **Concluídas**: resolvidas/fechadas nos últimos 7 dias.
  - Cada cartão mostra status, prioridade, selo de SLA (recalculado no aparelho, então continua certo
    offline), duração estimada e quantas ações aguardam envio.
- **Jornada e rastreamento** (cartão no topo da tela inicial): termo de ciência (LGPD) aceito uma vez,
  **Iniciar/Encerrar jornada**, indicador "Rastreamento ativo" e a última posição enviada. Detalhes abaixo.
- **Aparência**: modo claro/escuro segue o sistema; dá para fixar em Conta → Aparência.
- **Detalhe da OS**: só os botões de `allowed_transitions`, com os mesmos diálogos da web (agendar com
  início/fim, resolver com solução obrigatória, cancelar/reabrir com motivo). Em "Iniciar deslocamento" e
  "Iniciar atendimento" o check-in por GPS vem marcado (funciona sem internet). Local com endereço,
  contato, ligação e **Abrir no mapa**; equipamento; descrição; prazos de SLA.
- **Acompanhamentos** (públicos ou nota interna), **apontamento de horas** (atalhos de 15 min a 2 h) e
  **fotos** da câmera ou da galeria. As fotos são copiadas para a pasta do app e enviadas por
  `POST /tickets/{id}/attachments` com `kind=photo` quando houver conexão.
- **Indicador de conexão** no topo: offline, servidor inacessível, sincronizando, online com tempo real,
  e o número de itens pendentes. Tocar abre a tela **Conta**, com a fila de envio (dá para descartar uma
  operação), os avisos de operações recusadas, "Sincronizar agora", "Baixar tudo" e o estado do push.

## Formulários (checklists) e assinatura

- O analista decide se a OS tem formulário e se ele é obrigatório. No detalhe da OS, o cartão
  **Formulários e assinatura** lista cada formulário com status e progresso (itens obrigatórios cumpridos).
- **Preenchimento** (`/formulario/<OS>/<form>`): texto, número, Sim/Não em botões grandes, opções, data,
  "Confirmo" e fotos por campo (câmera/galeria, com a contagem contra o mínimo e o máximo). **Salvar**
  envia as respostas; **Concluir** valida antes, com as mesmas regras e textos do servidor ("Falta
  preencher: …"). Tudo vai pela fila de sync (`form_answers`), então funciona offline.
- Se o servidor recusar uma conclusão por falta de item (ele não grava nada nesse caso), o app reenvia as
  mesmas respostas sem concluir, para não perder o que o técnico preencheu, e mostra o motivo no formulário.
- **Fotos de campo** vão para `POST /tickets/{id}/forms/{form}/photos` (fila offline como as outras fotos);
  uma foto já enviada sai com toque longo (online). A lista de anexos fica guardada no aparelho para
  contar as fotos de cada campo offline.
- **Assinatura** (`/assinatura/<OS>`): o responsável assina com o dedo (canvas próprio com
  `react-native-svg`, enviado como PNG via `react-native-view-shot`) e informa nome e cargo. Só fica
  disponível com os formulários obrigatórios concluídos; depois dela os formulários ficam travados. Pode ser
  refeita até a OS ser concluída. Funciona offline: a fila é enviada em ordem (fotos → respostas →
  assinatura → "Resolver").
- **Concluir a OS** ("Resolver"/"Fechar") fica desabilitado, com o motivo na tela, até cumprir os
  formulários obrigatórios e, se pedida, a assinatura (o servidor também bloqueia).

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
  theme/theme.ts       paleta Maxx Field, claro/escuro, preferência do técnico
  lib/
    tracking.ts trackingTask.ts  jornada, coleta, fila de pontos e tarefa de segundo plano
    account.ts         /auth/me e troca de senha
    types.ts constants.ts workflow.ts   copiados de frontend/src/lib (manter iguais)
    syncTypes.ts       contrato de /sync/pull e /sync/push
    api.ts session.ts  HTTP com refresh + tokens no SecureStore
    db.ts              schema SQLite e consultas
    ops.ts             aplicação otimista e rebase; allowed_transitions igual ao backend
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

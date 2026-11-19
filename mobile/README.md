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
| Recursos do aparelho | expo-location (check-in e rastreamento), expo-task-manager e expo-background-task (segundo plano), expo-battery, expo-image-picker (fotos), expo-notifications (lembretes da visita, avisos e registro do aparelho), NetInfo |
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
| Arquivo da nota fiscal pelo seletor do sistema (`File.pickFileAsync`), copiado para o cache | `<input type="file">` e `blob:` (`invoiceFile.web.ts`) |
| Seletor nativo de data/hora | `<input type="datetime-local">` (`DateTimeField.web.tsx`) |
| GPS do expo-location, app de mapas | `navigator.geolocation`, Google Maps numa nova aba |
| Confirmações com `Alert` | `window.confirm` (o `Alert` do react-native-web não faz nada) |
| Registro do aparelho para push | não existe (aparece como indisponível na tela Conta) |
| Notificações (lembretes da visita, avisos) e sincronização em segundo plano | não existem (`backgroundSync.web.ts`; a Conta mostra "Indisponível nesta versão do app"); os avisos ficam nos toasts |

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
  dados locais, **inclusive operações ainda não enviadas**, e mostra o texto no login. Vale também com o app fora da
  tela: a rodada em segundo plano apaga os dados ali mesmo (ver "Sessão encerrada pelo servidor").
- **Primeiro acesso**: técnicos criados pelo analista ou importados recebem senha provisória
  (`must_change_password`); o app exige a troca (`POST /auth/change-password`) antes de liberar o resto e
  confere de novo em `/auth/me` a cada abertura. A troca encerra as outras sessões do usuário, então o app
  grava os tokens novos devolvidos pela API. Quem se cadastra pela homologação já entra com a própria senha.
- **Sessão encerrada pelo servidor** (senha redefinida pelo analista): a API, o refresh e
  o WebSocket (4401) respondem "Sessão encerrada. Entre novamente."; o app volta ao login com esse texto e
  para o rastreamento. A fila local fica guardada para quando o mesmo técnico entrar de novo.
  - Vale também com o app fora da tela (tarefa periódica ou jornada): a limpeza (sync, notificações da bandeja e
    agendadas, jornada e tarefa em segundo plano) roda ali mesmo, em `sessionEnd.ts`.
  - O fim fica gravado no Keychain/Keystore (`mc_session_end`) antes de os tokens saírem: se o sistema matar o app no
    meio, a próxima rodada sem tela ou a abertura seguinte conclui, e o login mostra o motivo uma vez.
- **Técnico desativado pela central**: o refresh responde "Seu acesso está desativado. Fale com a central da
  Maxx."; o app sai, para o rastreamento e apaga do aparelho as OS, os dados de clientes, as fotos e a fila
  (LGPD), também com o app fechado (na rodada em segundo plano). Se apagar falhar, a tarefa periódica continua ligada
  e tenta de novo, e a abertura seguinte também tenta. Quem já tinha saído antes tem os dados apagados ao entrar com a
  senha certa (o login dá o mesmo motivo).
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
  `POST /tickets/{id}/attachments` com `kind=photo` quando houver conexão. Na galeria do iPhone a foto vem
  convertida para JPEG (o servidor não aceita HEIC como foto); foto em formato que a central não abre fica de
  fora, com aviso. OS fechada ou cancelada não recebe foto do técnico (a aba Fotos diz que só a central anexa).
- **Indicador de conexão** no topo: offline, servidor inacessível, sincronizando, online com tempo real,
  e o número de itens pendentes. Tocar abre a tela **Conta**, com a fila de envio (dá para descartar a
  operação que o servidor falhou em processar 3 vezes; falta de rede e falha do envio inteiro não contam), os
  avisos de operações recusadas, "Sincronizar agora", "Baixar tudo", as notificações (lembretes das visitas e
  permissão) e o estado do push.
- **Ofertas de OS com preço** (detalhes abaixo): a central manda uma OS sem técnico com o valor; o técnico
  aceita pelo valor ou recusa, e quem aceitar primeiro fica com ela.
- **Meu cadastro** (detalhes abaixo): o técnico mantém a foto, os dados de contato, o endereço e a chave PIX em
  que recebe pelos chamados; e-mail e chave PIX pedem a senha atual, e a central é avisada na hora.
- **Aviso de privacidade** (detalhes abaixo): o texto da LGPD da homologação, só para leitura.
- **Notas fiscais (aba Ganhos)** (detalhes abaixo): o técnico envia a nota do mês (PDF, XML ou foto), marca as OS
  que ela cobre e acompanha a conferência da central; a nota é opcional e nunca trava o pagamento.
- **Meu elo** (detalhes abaixo): o brasão do técnico (Bronze, Prata, Ouro ou Diamante) pelos atendimentos dos
  últimos 12 meses, com o que falta para a próxima faixa e o que pesou; só o dele, sem ranking.

## Ofertas de OS com preço

A central manda uma OS ainda sem técnico, com o valor, para alguns técnicos (contrato em
[docs/API.md](../docs/API.md), "Ofertas de OS"). **Não existe contraproposta nem chat**: a conversa com a central
é pelo grupo de WhatsApp. Código: [src/lib/offers.ts](src/lib/offers.ts) (dados, regras e avisos),
`refreshOffers`/`acceptOffer`/`declineOffer` em [src/lib/sync.ts](src/lib/sync.ts), a seção
[src/components/Offers.tsx](src/components/Offers.tsx) e a tela `src/app/oferta/[id].tsx`.

- **Lista**: `GET /me/offers` na rodada de sincronização, guardada no aparelho (kv `field_offers`) para abrir sem
  rede. Quem aceita primeiro fica com a OS, então a lista não espera o upload das fotos (minutos em rede lenta): a
  rodada busca logo depois do primeiro envio da fila, entre uma foto e outra, depois do download e também quando o
  download falha por erro do servidor (falta de rede ou sessão encerrada param a rodada). Cada ponto só busca
  quando vale: o evento `ticket.offer` do tempo real (só para os técnicos da oferta), o app voltando à tela (o
  técnico costuma vir do recado no grupo), a rede e o tempo real voltando, o "puxar para atualizar" (uma busca
  por rodada) e, sem eles, uma conferência por minuto.
- **Busca antes do download**: a OS em que a central pôs o próprio técnico (como responsável ou na visita) pode
  ainda não estar no aparelho. A oferta que fechou assim (`cancel_reason = "assigned"`) e cuja OS não está no
  aparelho com ele fica como estava, sem aviso, e pede a busca depois do download, que decide: sem aviso se ele
  está na OS (o download já avisou "Nova OS para você" ou "Você vai na visita da OS-…"), "OS-… já tem técnico"
  se não. Esse pedido não dispara outra busca antes do download (nada de uma busca por foto).
- **Hoje** ganha no topo **Ofertas para você**: um cartão por oferta pendente e no prazo, com o valor em
  destaque, o serviço, bairro · cidade/UF, a janela da visita (ou "Data a combinar"), "Responder até 15:30" e o
  selo **Nova** enquanto o técnico não abriu. O prazo é contado pelo relógio do servidor (`serverNow`): a oferta
  vencida sai da lista sozinha.
- **Avisos**: oferta nova → "Nova oferta de OS" com valor, serviço, bairro e o prazo ("responder até 15:30");
  tocar abre a oferta, nunca a OS, que ainda não é dele. Com o app fora da tela, vira notificação do sistema
  quando a sincronização roda em segundo plano, o que exige um app instalado (seção Notificações; no Expo Go, só com o
  app aberto), e sai da bandeja quando a oferta fecha. A que fecha sem resposta → "Outro técnico aceitou a OS-…", "A
  central cancelou a oferta da OS-…" (só com o app na tela). Não há push real: com o app fechado, o técnico fica sabendo
  pelo texto que a central cola no grupo.
- **Tela da oferta** (`/oferta/<id>`): abrir chama `GET /me/offers/{id}`, que grava a leitura no servidor.
  Mostra nº e título, tipo de serviço, bairro · cidade/UF, janela da visita, o recado da central, os
  formulários (nome e se é obrigatório) e o cartão **Escopo** recolhido: abrir o escopo marca **Escopo lido**
  (guardado por oferta). Rodapé fixo: **Aceitar por R$ X** (liberado com a leitura gravada e o escopo lido) e
  **Recusar** (motivo: Agenda cheia, Muito longe, Valor não compensa, Outro motivo).
- **Aceitar** (confirmação "Aceitar esta OS por R$ X? Ela vai para a sua agenda.") → `POST /me/offers/{id}/accept`;
  a OS volta já atribuída e entra no aparelho com a própria resposta (sem o aviso duplicado "Nova OS para
  você"), e a tela da oferta vira a da OS. O valor aparece em Detalhes e em Ganhos (`my_payout`).
- **Saiu da tela durante o envio**: a tela só navega se ainda estiver à frente (`useNavigation().isFocused()`).
  Fora dela, fica só o aviso: "OS aceita" (tocar abre a OS) ou "Oferta recusada", sem mexer na tela em que o
  técnico está.
- **Aceite sem resposta** (rede caiu, tempo esgotado no app ou 504 do proxy): o servidor pode ter gravado. O
  aviso é neutro, "Não deu para confirmar o aceite. Conferindo…", e o app busca as ofertas e sincroniza na hora:
  a tela mostra como a oferta ficou (aceita, com "Abrir a OS" e a OS baixada, ou ainda pendente para tentar de
  novo).
- **Recusas do servidor** (409/422 com `code`: outro técnico aceitou, prazo, cancelada, OS indisponível, já
  respondida, oferta não aberta): a tela mostra o texto do servidor, sem "Tentar de novo", e atualiza a lista.
- **Sem conexão**: os botões ficam desabilitados ("Sem conexão. Conecte para responder a oferta."). Oferta
  vencida ou fechada: sem botões, com a situação ("O prazo para responder acabou", "Outro técnico aceitou esta
  OS", "A central cancelou esta oferta"); a aceita leva à OS e, quando a central troca a oferta (novo valor) ou
  manda a OS de novo, **Ver a oferta nova · R$ X** leva à nova. A lista do servidor não traz a oferta trocada:
  se ela some com a tela aberta, a tela segue com a última resposta do servidor e abre a oferta de novo para
  mostrar como ela ficou.
- **LGPD**: só o recorte do convite fica no aparelho (sem cliente, loja, endereço ou contato); as que fecharam
  vêm mínimas do servidor; tudo sai com o resto dos dados na troca de técnico e quando o acesso é retirado.

## Promessa de campo (chegada, 4h na loja, peças) e horário

Regras de [src/lib/field.ts](src/lib/field.ts), espelhando `backend/app/services/field.py`:

- **Chegada**: enquanto a OS está atribuída, agendada ou em deslocamento, cartão e cabeçalho mostram
  "Chegar até 14:35 · faltam 52 min" (`arrival_due_at`), em âmbar quando faltam até 60 min (ou o servidor
  diz `at_risk`) e em vermelho quando passou. Depois do check-in: "Chegou 13:42 · no prazo/com atraso".
- **4h na loja**: o check-in (primeira entrada em "Em atendimento") marca `arrived_at`; o anel no cabeçalho
  vai de `arrived_at` a `onsite_due_at` com o tempo restante. Faltando 30 min, vibra uma vez e mostra
  "Faltam 30 min do tempo do chamado: avise o analista no grupo"; ao estourar, fica vermelho. Também agenda
  duas **notificações locais** (expo-notifications, funcionam offline e no Expo Go): no aviso e no estouro
  ([src/lib/onsiteAlerts.ts](src/lib/onsiteAlerts.ts)), com a regra dos lembretes da visita: um alerta novo só com 1 min
  de antecedência, e o já agendado fica até 15 min depois da hora. Check-in offline prevê o limite com as regras locais;
  o servidor confirma no próximo sync. O relógio só anda em "Em atendimento": na pausa da central (aguardando
  peça ou cliente) o anel, a linha e os alertas somem, e na retomada o servidor refaz o limite com o que sobrou.
  Visita improdutiva esperando a central reagendar não mostra prazo de chegada (nem no cartão).
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

- Os formulários **entram sozinhos** pelo tipo de OS e pela categoria (a ligação fica no modelo, na central;
  a categoria-mãe vale para as subcategorias), e o analista ainda põe, tira e decide se cada um é obrigatório.
  O app não faz nada de diferente: eles chegam no sync, como o resto da OS. Antes da visita, trocar o tipo ou a
  categoria pode tirar um formulário que ninguém começou; ao abrir, a tela diz que ele pode ter sido removido
  da OS pela central. No detalhe da OS, o cartão **Formulários e assinatura** lista cada formulário com status e
  progresso (itens obrigatórios cumpridos).
- **Resposta automática**: a pergunta ligada a um dado da OS que o técnico já vê (loja, código da loja, cliente,
  endereço, cidade, nº da OS, técnico, tipo de OS ou data da visita) já vem preenchida (`prefill` do formulário,
  calculado pelo servidor até a conclusão). O app trata `{...prefill, ...answers}` como a resposta do servidor
  (`serverAnswers` em `lib/forms.ts`): o rascunho começa dela, ela conta para o progresso e para o que falta, e
  abrir o formulário não conta como alteração. O técnico corrige se precisar; ao salvar, todas as respostas vão
  (a preenchida vira resposta). Na conclusão o servidor grava o valor do momento, e trocar o técnico ou remarcar
  depois não muda nada. A data da visita é a do atendimento em curso (na volta ao local, o dia da volta); com a OS
  pausada ou reaberta depois de uma chegada, a data não vem preenchida.
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
  como o cliente vê**. O link vem na OS (`report_link`); se o aparelho ainda não o recebeu (a conclusão acabou
  de subir), pede `POST /tickets/{id}/report-link`. Link desativado pela central não volta pelo app: o servidor
  recusa e o cartão mostra o motivo, sem "Tentar de novo".

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
  A tarefa é definida na entrada do app (`index.ts`, o `main` do package.json), não só nas rotas: quando o
  Android acorda o app fechado com novas posições, ele roda sem tela e as rotas não carregam. Depois das tarefas, o
  `index.ts` carrega também o `sessionEnd.ts`: sem tela, é ele que conclui o fim de sessão (limpeza e, se for o caso,
  apagar os dados).
  Para gerar o build: `npx expo run:android` / `npx expo run:ios` ou `eas build --profile development`.

## Notificações

Tudo passa por [src/lib/notifications.ts](src/lib/notifications.ts) (handler, canais do Android, permissão,
toque e agendamento); o plano dos lembretes fica em [src/lib/visitReminders.ts](src/lib/visitReminders.ts) e a
sincronização fora da tela em [src/lib/backgroundSync.ts](src/lib/backgroundSync.ts).

**No Expo Go, OS nova e oferta só aparecem com o app aberto.** Com o app fora da tela, o aviso depende de uma rodada
de sincronização em segundo plano, e o Expo Go não roda nenhuma (nem a tarefa periódica nem a jornada em segundo
plano). Num app instalado (development build), a tarefa periódica avisa a cada 15 min ou mais e a jornada aberta, a
cada ~3 min. O aviso na hora, com o app fechado, precisa do push real (FCM), ainda desligado (ver Limitações). Os
lembretes da visita são locais e funcionam também no Expo Go, mas só depois que o app sincronizou a OS.

- **Lembretes da visita**: três notificações locais por OS, **1 dia (24 h), 1h40 e 10 min antes** do início da
  visita, para o responsável e para os outros técnicos da visita: "Sex 20/11 às 08:00 · OS-000123" (o de 1 dia leva a
  data da visita, e não "Amanhã", porque fica na bandeja), "Em 1h40 · OS-000123 às 08:00" e "Em 10 min · OS-000123 às
  08:00", com a loja e o endereço no texto (sem os dois, o título da OS); tocar abre a OS. Só a visita ainda não
  iniciada tem lembrete (atribuída, agendada, reaberta ou pausada pela central com visita marcada): deslocamento
  (também offline), atendimento, conclusão, cancelamento, improdutiva sem visita nova e saída da lista cancelam, e o
  lembrete já na bandeja sai.
- **Nunca em cima da hora**: lembrete novo só é agendado entre 1 min e 7 dias à frente. OS marcada para daqui a
  30 min ganha só o de 10 min; atribuída ontem às 18:00 para hoje às 08:00, os de 1h40 e 10 min. O que já está
  agendado não é cancelado no último minuto nem até 15 min depois da hora (o Android sem alarme exato dispara com
  atraso), enquanto a visita não começa; "Liberar" (alarme exato) não refaz o que vence em menos de 1 min. A hora vem
  do relógio do servidor (corrige o celular adiantado ou atrasado). No máximo 48 lembretes, os mais próximos (o iOS
  guarda 64 agendamentos por app; sobra lugar para os alertas da loja e o da jornada).
- **Sempre em dia**: o aparelho refaz os agendamentos com as OS guardadas (com o que ainda está na fila) ao fim
  de cada sincronização, a cada ação do técnico, ao abrir o app e quando ele volta à tela. Reagendar troca o
  lembrete; o horário que já passou fica de fora. A bandeja também é limpa: o lembrete de 1 dia sai na hora do de
  1h40, o de 1h40 na do de 10 min e todos no início da visita. São locais: funcionam offline, com o app fechado e no
  Expo Go, para as OS que já estão no aparelho (a OS atribuída com o app fechado só ganha lembrete depois da
  sincronização; no Expo Go, ao abrir o app).
- **Novidades com o app fora da tela**: o que a sincronização já avisa com toast (OS nova, "Você vai na visita
  da…", agendada ou reagendada, cancelada, saiu da lista, peça aprovada ou recusada, oferta nova) vira notificação
  do sistema, por exemplo "Nova OS para você: OS-000123" · "Visita sex 20/11 às 08:00 · LJ001 · Loja Exemplo" (o toast
  na hora continua "Visita amanhã às 08:00 · …"). Até duas do mesmo tipo saem uma a uma; mais que isso, um resumo que
  abre Hoje. A notificação de uma OS é trocada pela seguinte (a cancelada tira a de OS nova da bandeja), e a de uma
  oferta sai da bandeja quando ela fecha. Com o app na tela, ficam só os toasts.
  - Peça recusada: um aviso por OS, "OS-000123: peça recusada" ou "OS-000123: 2 peças recusadas", com o corpo "Fonte
    ATX e Memória 8 GB: o cliente não aprovou o orçamento. Não instale; fale com a central no grupo." Com mais de 3
    peças: "A, B, C e mais N".
  - Sem a permissão de notificações, o que a rodada fora da tela apura fica guardado no aparelho (kv
    `deferred_notices`, até 20 avisos, por 6 h) e vira toast quando o app volta à tela. Com mais de 3, aparecem "Mais N
    avisos · Veja em Hoje." e os 2 mais importantes. O aviso de OS que saiu do aparelho e o de oferta que fechou são
    descartados.
- **Sincronização em segundo plano** (só num app instalado): na jornada, a localização mantém o app vivo e sai uma
  rodada a cada ~3 min; fora dela, a tarefa periódica do sistema (`expo-background-task`, 15 min ou mais:
  WorkManager no Android; no iOS o sistema decide e roda pouco). Com o app fechado à força pelo técnico, nada roda. A
  Conta mostra a situação em **Sincronização > Em segundo plano**; no Expo Go, "Só com o app aberto": OS nova e oferta
  só aparecem com o app aberto (o aviso na hora com o app fora da tela depende do push real).
- **Fim de sessão na rodada**: se a sessão termina durante a rodada em segundo plano (401 do `/auth/refresh`), ou já
  estava encerrada com limpeza pendente, a rodada conclui a limpeza do fim de sessão (`sessionEnd.ts`) antes de
  terminar e desliga a tarefa (se apagar os dados do técnico desativado falhar, ela fica ligada para tentar de novo).
- **Conta > Notificações**: a chave **Lembretes das visitas** (ligada; desliga os três de uma vez), o próximo
  lembrete, a permissão do celular (**Permitir notificações** ou **Abrir configurações**) e, no Android 12 ou mais
  novo sem o alarme exato, **Horário exato · Pode atrasar alguns minutos** com **Liberar** (`SCHEDULE_EXACT_ALARM`
  no `app.json`). No Android cada tipo tem canal próprio, que dá para silenciar no sistema: Ordens de serviço,
  Lembretes das visitas, Tempo na loja e Jornada.
- **Permissão**: um pedido automático só, uma vez por técnico, depois do termo de localização (nunca junto com o
  pedido de localização); depois, só pelos botões da Conta.
- **Push da central**: ainda não ligado. O `POST /devices` responde `{"push": "simulated"}` e o próprio app avisa;
  quando a central responder `live`, o app para de repetir o aviso (kv `push_live`). O cartão **Aparelho** mostra
  o estado ("Ainda não ligado na central"; no Expo Go, "Indisponível nesta versão do app").
- **Saiu da conta**: nada agendado, a bandeja limpa (loja e endereço aparecem na tela bloqueada) e os avisos guardados
  somem. As chaves `visit_reminders`, `notifications_asked`, `push_live` e `deferred_notices` (cada aviso leva o id do
  técnico) ficam no kv e somem na troca de técnico.

## Meu cadastro

**Conta › Meu cadastro** ([src/app/meu-cadastro.tsx](src/app/meu-cadastro.tsx)), aberto também pelo cartão de
PIX em Ganhos. Contrato em [docs/API.md](../docs/API.md), "Meu cadastro do técnico".

- **O que o técnico muda**: foto, nome, celular (WhatsApp), e-mail de login, endereço (CEP, rua e número, bairro),
  cidade/UF, região que atende e a chave PIX (tipo, chave e titular). Grupo, cargo, acesso ao app, serviços e
  jornada ficam com a central; CPF, CNPJ/MEI, nascimento, ferramentas, veículo e CNH continuam na ficha da
  homologação.
- **Um formulário só**: "Salvar alterações" (desativado sem mudança) manda em `PATCH /me/profile` só o que mudou.
  O app confere antes, com as regras e as mensagens do servidor (nome, celular com DDD, e-mail quando muda,
  cidade, UF, CEP com 8 números e a chave por tipo, em [src/lib/pix.ts](src/lib/pix.ts)); o servidor confere de
  novo. Sair com alteração não salva pergunta "Descartar as alterações?".
  - O nome, quando muda, segue a regra do servidor: só letras (com acento), espaço, apóstrofo, hífen e ponto, sem
    "www", "http" nem endereço colado ("site.com"). A mensagem é "Use só letras no nome.". Os nomes antigos ficam como
    estão.
- **E-mail e chave PIX pedem a senha atual** (folha "Confirme com sua senha"): cadastrar a chave, trocar tipo,
  chave ou titular e remover. Senha errada e o bloqueio depois de 5 erros em 15 min (o mesmo contador de
  "Trocar senha") aparecem na folha. A central é avisada na hora quando mudam PIX, e-mail, nome ou celular, e toda
  mudança fica no histórico do cadastro.
  - Com a senha provisória, o servidor recusa e-mail e PIX ("Crie sua senha no app antes de mudar o e-mail ou a chave
    PIX"); o app já esconde a tela nesse estado (só "Trocar senha" abre).
  - E-mail da empresa é recusado com "Use um e-mail que não seja da empresa".
  - A troca de e-mail tem limite de 10 por hora (429 "Muitas tentativas. Tente mais tarde.").
- **Aviso de privacidade**: o cartão Pagamento tem o link **Aviso de privacidade** (seção abaixo).
- **Chave PIX**: chips CPF, CNPJ, E-mail, Celular e Chave aleatória; a chave tem o teclado e a máscara do tipo
  ("Colar" na chave aleatória); trocar o tipo limpa a chave; o titular começa com o nome. "Remover chave PIX" só
  vale ao salvar (dá para desfazer). Celular do PIX: DDD sem zero e o número com o 9, como no servidor.
- **Trocar o e-mail** não tira ninguém do app (a senha é a mesma): o login passa a ser o novo, já preenchido na
  tela de login (`session.updateUser` grava também o `mc_last_email`).
- **Foto**: câmera (a frontal) ou galeria pelo `photoCapture` (alvo `avatar`), com recorte quadrado na hora; o app
  reduz para 512 px em JPEG (compressão 0,85) com o `expo-image-manipulator` e envia em `POST /me/profile/photo`.
  "Remover foto" tira também a que veio do Field Control; no lugar ficam as iniciais. No Android, a foto tirada
  antes de o sistema fechar o app com a câmera aberta é enviada quando o Meu cadastro abre de novo (até 30 min).
- **Onde a foto aparece**: no Meu cadastro, no 1º cartão da Conta e no topo da tela inicial
  ([src/components/Avatar.tsx](src/components/Avatar.tsx)). Sem foto, sem o cadastro carregado ou com o link
  vencido (12 h), aparecem as iniciais.
- **Ganhos**: no topo, "Recebimento por PIX" com o tipo e a chave (abre o Meu cadastro) ou "Sem chave PIX
  cadastrada" com **Cadastrar chave PIX**. Só aparece com o cadastro carregado; puxar a tela para baixo relê o
  cadastro junto.
- **Sem internet**: abrir, salvar e trocar a foto pedem internet. Nada entra na fila offline: a senha não fica
  guardada e o aviso à central tem de sair na hora. Sem rede e sem o cadastro na memória, a tela diz "Sem
  internet"; com ele na memória, mostra os dados e avisa que não dá para salvar.
- **O que fica no aparelho**: nome, e-mail e celular no usuário da sessão (`mc_user`, SecureStore). Endereço e
  chave PIX ficam só na memória ([src/lib/profile.ts](src/lib/profile.ts)), nunca no SQLite, e somem ao sair da
  conta. O cadastro é lido ao entrar (sem aviso se falhar), ao abrir o Meu cadastro, ao puxar Ganhos para baixo e,
  na tela inicial, na Conta e em Ganhos, quando falta ou passou de 6 h (o link da foto vale 12 h).
- O `expo-image-manipulator` é nativo e já vem no Expo Go; um development build feito antes dele precisa ser
  refeito.

## Notas fiscais (aba Ganhos)

Contrato em [docs/API.md](../docs/API.md), "Notas fiscais dos técnicos". Código: [src/lib/invoices.ts](src/lib/invoices.ts)
(API, cópia no aparelho e versão), [src/lib/invoiceFile.ts](src/lib/invoiceFile.ts) (escolha do arquivo),
[src/components/InvoicesCard.tsx](src/components/InvoicesCard.tsx) e a tela `src/app/nota-fiscal.tsx`.

- **Cartão "Notas fiscais de <mês>"** em Ganhos, logo abaixo do resumo do mês (também com os valores carregando ou
  com erro): uma linha por nota com o número, o valor, a situação (Aguardando conferência, Conferida, Recusada), "Emitida
  em 05/11/2026 · 3 OS" (e "conferida em …") e, na recusada, o motivo da central. A lista do mês fica no aparelho (kv
  `invoices:AAAA-MM`; sem rede, "Sem internet · notas de …") e é relida ao voltar para a tela, ao trocar de mês, ao
  puxar para atualizar e quando uma nota entra ou sai. Tocar na nota: **Abrir arquivo** (link assinado de 30 min no
  navegador; a lista é relida antes se tiver mais de 20 min) e **Apagar nota** (só a que a central ainda não conferiu).
- **Enviar nota fiscal** (`/nota-fiscal?mes=AAAA-MM`): arquivo (**Escolher PDF ou XML** pelo seletor do sistema,
  `File.pickFileAsync` do expo-file-system, ou **Tirar foto**/**Da galeria** pelo `photoCapture`, alvo `invoice`),
  número, data de emissão, valor (aceita "1.234,56", "1234.56" ou "R$ 900"; com OS marcadas, mostra a soma e **Usar a
  soma**), competência (mês com setas, até o atual) e as OS da competência (as concluídas no mês e sem nota vêm marcadas;
  as que já estão em outra nota ficam bloqueadas; as de meses anteriores ainda a receber aparecem desmarcadas) e uma
  observação. O app confere antes com as regras do servidor; sair com algo preenchido pergunta "Descartar a nota?".
- **Arquivo**: PDF, XML, JPG, PNG ou WebP, até 10 MB (o servidor confere pelo conteúdo). O escolhido é copiado para
  `cache/notas-fiscais/<uuid>/` (o `content://` do Android vira arquivo que o envio nativo lê) e sobe com o nome do
  aparelho sem acentos ou "nota-AAAA-MM-DD"; a cópia sai ao trocar o arquivo, ao fechar a tela e, se o sistema fechou
  o app no meio, na próxima abertura da tela. O original do técnico nunca é apagado. Foto com qualidade 0,8 (o texto
  precisa ser lido); no Android, a foto tirada antes de o sistema fechar o app volta quando a tela abre de novo.
- **Só online**: a nota não entra na fila offline. Sem rede, o rodapé mostra "Sem internet. A nota só é enviada com
  conexão…" e o formulário continua preenchido. Cada abertura da tela gera um `client_upload_id` repetido em todas as
  tentativas: a resposta perdida, mandada de novo, devolve a mesma nota (200) em vez de criar outra.
- **Lista de OS em erro**: "Enviar nota" busca a lista de novo antes de enviar.
  - Se vier, as OS do mês voltam marcadas, a tela rola até elas ("Confira as OS desta nota") e a nota não sai: o
    técnico confere e toca de novo.
  - Se não vier, pergunta "Enviar a nota sem OS?" / "A lista de OS não carregou.", com **Enviar sem OS**; sem rede,
    mostra o aviso de sem internet.
  - A lista em erro também é buscada de novo quando a conexão volta (NetInfo).
- **Aviso de privacidade**: o link fica no fim da tela (seção abaixo).
- **Depois de enviar ou apagar**: Ganhos relê as notas e os valores, e cada OS coberta mostra "NF 1234" na linha.
  A recusa é final: o técnico apaga a recusada e envia outra. A conversa sobre a nota continua no grupo de WhatsApp.

## Meu elo

O elo do técnico (Bronze, Prata, Ouro ou Diamante) sai dos atendimentos dos últimos 12 meses: quantos (como
responsável ou junto, também os do Field Control) e como (chegada no horário combinado, OS reaberta em até 30 dias,
visita perdida por motivo do técnico). Regras, faixas e textos vêm prontos do servidor em `GET /me/level`
([docs/API.md](../docs/API.md), "Elo dos técnicos"): o app não repete números. Código:
[src/lib/level.ts](src/lib/level.ts) (guardado, leitura nas telas e comemoração), `refreshLevel`/`refreshLevelNow` em
[src/lib/sync.ts](src/lib/sync.ts), o brasão em [src/components/LevelBadge.tsx](src/components/LevelBadge.tsx) e a
tela `src/app/elo.tsx`.

- **Onde aparece**: o chip com o brasão no topo do Hoje, ao lado da foto (some sem elo guardado; ponto âmbar em
  risco; o leitor de tela diz "Elo Ouro. Abre Meu elo"), a linha "Elo" no cartão do técnico na Conta ("Ouro" ou "Ouro
  · em risco"; antes da primeira busca, "Ver meu elo") e a tela **Meu elo**: o brasão, "Elo Ouro", desde quando e a
  hora da atualização; em risco, a caixa "Elo Ouro em risco" com o texto do servidor; o que falta para a próxima faixa
  ("Para chegar ao Diamante", com barra nos atendimentos) e, em risco ou no Diamante, o que a faixa atual pede ("Para
  continuar no Ouro"); os números dos últimos 12 meses; o que pesou (as 30 mais recentes; tocar abre a OS se ela está
  no aparelho) e "Como funciona" (as quatro faixas e as regras, com o link **Aviso de privacidade** no fim). Dúvida
  sobre o elo é com a central, no grupo de WhatsApp.
- **Dados**: a rodada do sync busca `GET /me/level` a cada 30 min e no "puxar para atualizar", só com o app na tela
  (fora dela não gasta bateria e dados com isso), e a tela Meu elo busca ao abrir (se o guardado tem mais de 2 min) e
  ao puxar para baixo. Fica no kv `my_level` com a hora e o técnico; offline (ou com erro), a tela mostra o último
  guardado com "Sem internet · dados de 18/11 às 10:00". Só leitura, fora da fila de operações; sai do aparelho na
  troca de técnico. As telas do elo releem a cada busca, o resto do app só quando o elo mudou.
- **Subiu de faixa**: "Você chegou ao Ouro!" com "Veja em Meu elo o que conta para o próximo." (no Diamante, "É o elo
  mais alto."), dentro do app. A primeira carga não comemora; a subida que chega com o app saindo da tela espera ele
  voltar; não há push.
- **O que o técnico não vê**: outros técnicos, ranking, notas da central nem o que ela desconsiderou.

## Aviso de privacidade

Tela `/privacidade` ([src/app/privacidade.tsx](src/app/privacidade.tsx)), só de leitura.

- **Texto**: `PRIVACY_NOTICE` de [src/lib/constants.ts](src/lib/constants.ts), o mesmo da ficha da homologação (cópia
  idêntica da web), com "Atualizado em" pela data de `PRIVACY_VERSION`. Cita os dados do cadastro e a chave PIX, o
  pagamento por PIX, a localização na jornada, as notas fiscais e o Elo.
- **Onde abre**: na Conta (linha abaixo do Termo de uso da localização), no cartão Pagamento do Meu cadastro, no fim
  da tela Enviar nota fiscal e no fim do "Como funciona" do Meu elo.
- **Não grava ciência**: o aceite continua sendo o da ficha da homologação; a tela é só para consulta.

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
  primeiro plano, cada ação, cada evento do WebSocket, puxar a lista para baixo e um intervalo de 90 s; com o
  app fora da tela, a jornada e a tarefa periódica do sistema (seção Notificações).
- Todas as escritas no SQLite passam por uma fila de transações exclusivas em JS.
- OS fechadas/canceladas há mais de 30 dias e sem pendências saem do aparelho.

## Estrutura

```
index.ts               entrada: expo-router + tarefas de segundo plano (rastreamento e sincronização, definidas antes das rotas, para o relançamento sem tela do Android)
src/
  app/                 rotas (expo-router)
    _layout.tsx        sessão, tema, Stack com rotas protegidas, toasts
    login.tsx          login + servidor da API
    trocar-senha.tsx   primeiro acesso (senha provisória)
    index.tsx          tela inicial: jornada + Hoje / Agenda (calendário) / Concluídas
    ticket/[id].tsx    detalhe, ações e abas
    oferta/[id].tsx    oferta de OS com preço: escopo, "Aceitar por R$ X" ou "Recusar"
    termo-rastreamento.tsx  termo de ciência do rastreamento (LGPD)
    conta.tsx          técnico (foto, Meu cadastro, elo, senha), sincronização, fila, avisos, rastreamento, notificações, aparência, sair
    meu-cadastro.tsx   Meu cadastro: foto, dados, endereço e chave PIX (e-mail e PIX com a senha atual)
    elo.tsx            Meu elo: brasão, risco, o que falta para a próxima faixa, números, o que pesou e "Como funciona"
    nota-fiscal.tsx    Enviar nota fiscal: arquivo, número, emissão, valor, competência e as OS que a nota cobre
  components/          UI (marca, cartões, calendário, jornada, diálogo de transição, abas da OS)
    Text.tsx           Text do app: aplica a Manrope no peso do estilo (use este, não o do react-native)
    motion.tsx         entrada em cascata, transição de layout, PressableScale (0,97 com mola), Pulse
    Skeleton.tsx FieldStepper.tsx SuccessHost.tsx TabBar.tsx ActionSheet.tsx Icon.tsx RouteMapPattern.tsx
    NotificationsCard.tsx  Conta > Notificações (lembretes, permissão, alarme exato) e "Em segundo plano"
    Avatar.tsx         foto do técnico ou as iniciais (topo da tela inicial, Conta, Meu cadastro)
    PixCard.tsx        Ganhos > Recebimento por PIX (atalho para o Meu cadastro)
    InvoicesCard.tsx   Ganhos > Notas fiscais do mês (situação, motivo da recusa, abrir arquivo, apagar, enviar)
    LevelBadge.tsx     brasão do elo (escudo com as marcas da faixa), selo e o chip do topo de Hoje
  theme/theme.ts       paleta Maxx Field, claro/escuro, preferência do técnico
  theme/fonts.ts       Manrope (pesos 400–700) e o mapeamento de fontWeight para a família
  lib/
    tracking.ts trackingTask.ts  jornada, coleta, fila de pontos e tarefa de segundo plano
    account.ts         /auth/me e troca de senha
    profile.ts         Meu cadastro só na memória (GET/PATCH /me/profile) e a foto reduzida no aparelho (expo-image-manipulator)
    pix.ts masks.ts    chave PIX por tipo (regras e mensagens de backend/app/core/pix.py) e máscaras de CPF, CNPJ, CEP e celular
    types.ts constants.ts workflow.ts   copiados de frontend/src/lib (manter iguais)
    syncTypes.ts       contrato de /sync/pull e /sync/push
    api.ts session.ts  HTTP com refresh + tokens no SecureStore
    db.ts              schema SQLite e consultas
    ops.ts             aplicação otimista e rebase; user_can_transition e allowed_transitions iguais ao backend
    field.ts           promessa de campo: relógios de chegada e de loja, rótulos de peças
    notifications.ts   notificações: handler, canais, permissão, toque, alertas locais e novidades fora da tela
    visitReminders.ts  lembretes da visita (1 dia, 1h40 e 10 min antes): plano e textos, sem import nativo
    onsiteAlerts.ts    notificações locais do tempo na loja
    backgroundSync.ts  sincronização fora da tela (jornada e tarefa periódica); .web.ts sem efeito
    sync.ts            motor de sync, fila, fotos, gatilhos
    offers.ts          ofertas de OS: lista guardada, prazo pelo relógio do servidor, "Escopo lido" e avisos
    invoices.ts        notas fiscais: /me/invoices (lista guardada por competência, envio, exclusão, abrir arquivo) e a versão que relê Ganhos
    invoiceFile.ts     arquivo da nota: seletor do sistema ou foto, cópia no cache; .web.ts com <input type="file">
    level.ts           Meu elo: o elo guardado (kv my_level), leitura nas telas, comemoração da subida e datas
    realtime.ts        WebSocket
    sla.ts             porta de backend/app/services/sla.py::compute_sla_status
    device.ts          POST/DELETE /devices (o servidor diz se o push chega: live ou simulated)
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
  backend atender iOS será preciso o SDK do Firebase no app ou um provedor APNs no backend. Para ligar:
  Firebase (`google-services.json`), plugin do expo-notifications com `defaultChannel: "default"`, provedor
  FCM no backend com `delivers()` verdadeiro e mensagem no canal `default` com `data` `{ticket_id, type}`.
- **`SCHEDULE_EXACT_ALARM`** e **expo-background-task** são nativos: valem a partir de um development build
  novo (o Expo Go já traz os módulos, mas não roda a tarefa periódica).
- **HTTP sem TLS**: o Expo Go aceita `http://` na rede local. Builds de produção devem apontar para
  `https://`/`wss://` (Android bloqueia texto puro por padrão e o iOS exige ATS).
- **Segundo plano limitado**: só na jornada (build instalado) e na tarefa periódica do sistema (15 min ou mais;
  no iOS, rara). Com o app fechado pelo técnico, ou no iPhone fora da jornada, OS nova e oferta só aparecem
  quando o app abre (avisar na hora exige o push real). Um lembrete de uma OS mudada enquanto o aparelho não
  sincronizou ainda sai com o horário antigo.
- Rótulos e transições vêm das constantes copiadas da web, não de `GET /meta`; as ações exibidas vêm de
  `allowed_transitions` do servidor (recalculadas no aparelho só depois de uma ação offline).
- Sem assinatura do cliente, edição dos dados da OS (`update`) ou abertura de OS pelo app.

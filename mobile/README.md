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
| Registro do aparelho para push | não existe (aparece como indisponível na Sincronização e em Configurações › Notificações) |
| Notificações (lembretes da visita, avisos) e sincronização em segundo plano | não existem (`backgroundSync.web.ts`; a Sincronização mostra "Indisponível nesta versão do app"); os avisos ficam nos toasts |

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
  as OS em que é o responsável ou vai junto (sem fila de grupo e sem "assumir"). Tela inicial com quatro abas na barra
  inferior (pílula animada na aba ativa) e, no topo, o chip do elo e a foto, que abre o Perfil (os dois saem na aba
  Perfil); Hoje abre com "Bom dia, {nome}", a data e o cartão da jornada (o voltar do Android, noutra aba, volta
  para Hoje):
  - **Hoje**: resumo "Hoje: X OS · Y em atendimento" (e chegadas atrasadas, em vermelho) e linha do tempo
    (horário, cliente, endereço, status) com as em campo, agendadas para hoje (ou atrasadas) e as sem agenda,
    **por urgência**: chegada atrasada primeiro, depois chegada em risco, depois em campo, horário,
    prioridade e prazo de SLA.
  - **Agenda**: calendário com visão de **mês** (grade com marcadores por dia; tocar no dia lista as OS)
    e de **semana** (dia a dia, com horário das visitas). Tocar na OS abre o detalhe.
  - **Faturamento**: o que o técnico recebe por OS, mês a mês, com o olho que oculta os valores (seção Faturamento).
  - **Perfil**: o total de atendimentos e a patente (a medalha do elo), Configurações, Histórico de atendimentos,
    Estatísticas, Meu elo, Sincronização, os avisos legais e Sair (seção Perfil). As OS concluídas ficam no Histórico
    de atendimentos, que vem da central: a aba "Concluídas", com os últimos 7 dias do aparelho, saiu.
  - Cada cartão mostra status, horário da visita (até que horas; em atendimento, o tempo correndo), o relógio
    de campo ("Chegar até 14:35 · faltam 52 min" ou "Na loja 1h 20min · restam 2h 40min") e quantas ações
    aguardam envio.
- **Jornada e rastreamento** (cartão no topo da tela inicial): termo de ciência (LGPD) aceito uma vez,
  **Iniciar/Encerrar jornada**, indicador "Rastreamento ativo" e a última posição enviada. Detalhes abaixo.
- **Aparência**: modo claro/escuro segue o sistema; dá para fixar em Perfil › Configurações › Aparência (Sistema,
  Claro ou Escuro).
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
  Hoje e na Agenda com o selo "Você vai junto" e manda fotos, mas não vê os botões de
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
  e o número de itens pendentes. Tocar abre a tela **Sincronização** (seção abaixo), com a fila de envio (dá para
  descartar a operação que o servidor falhou em processar 3 vezes; falta de rede e falha do envio inteiro não contam),
  os avisos de operações recusadas, "Sincronizar agora", "Baixar tudo de novo", as notificações (lembretes das visitas
  e permissão) e o estado do push.
- **Ofertas de OS com preço** (detalhes abaixo): a central manda uma OS sem técnico com o valor; o técnico
  aceita pelo valor ou recusa, e quem aceitar primeiro fica com ela.
- **Configurações** (detalhes abaixo; Perfil › Configurações): o técnico mantém a foto, o nome, o contato, o
  endereço e a chave PIX em que recebe pelos chamados (e-mail e chave PIX pedem a senha atual) e o **perfil técnico**
  que a central vê na ficha e usa para escolher quem convidar: disponibilidade, transporte e CNH, aptidões, formação e
  ferramental. A central é avisada na hora quando mudam PIX, e-mail, nome ou celular.
- **Aviso de privacidade** (detalhes abaixo): o texto da LGPD da homologação, só para leitura, com um cartão em Hoje
  quando o texto muda.
- **Faturamento** (detalhes abaixo): o total pago e o que falta receber, a chave PIX e um cartão por mês com a situação
  (sem nota, nota em conferência, a pagar, pago…); o mês abre pelo cartão ou pelo **Outro mês**, com as OS, os
  reembolsos e as notas fiscais.
- **Notas fiscais (aba Faturamento › mês)** (detalhes abaixo): o técnico envia a nota do mês (PDF, XML ou foto), marca
  as OS que ela cobre e acompanha a conferência da central; a nota é opcional e nunca trava o pagamento.
- **Patente e Meu elo** (detalhes abaixo): o elo do técnico (Bronze, Prata, Ouro ou Diamante) pelos atendimentos dos
  últimos 12 meses, desenhado como uma medalha, com o que falta para a próxima faixa e o que pesou; só o dele, sem
  ranking. **Estatísticas** e **Histórico de atendimentos** (detalhes abaixo) mostram os números de cada mês e as OS
  concluídas, também só dele.

## Ofertas de OS com preço

A central manda uma OS ainda sem técnico, com o valor, para alguns técnicos (contrato em
[docs/API.md](../docs/API.md), "Ofertas de OS"). **Não existe contraproposta nem chat**: a conversa com a central
é pelo grupo de WhatsApp. Código: [src/lib/offers.ts](src/lib/offers.ts) (dados, regras e avisos),
`refreshOffers`/`acceptOffer`/`declineOffer` em [src/lib/sync.ts](src/lib/sync.ts), a seção de Hoje e os blocos da tela
em [src/components/Offers.tsx](src/components/Offers.tsx), o topo em
[src/components/offer/OfferHero.tsx](src/components/offer/OfferHero.tsx) e a tela `src/app/oferta/[id].tsx`.

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
- **Avisos**: oferta nova → "Nova oferta de OS" com valor, serviço, bairro e o prazo. O toast na hora diz o prazo
  relativo ("responder até 15:30", "responder até amanhã 09:00"); a notificação e o aviso guardado sem a permissão, que
  ficam até a oferta fechar, levam a data ("responder até sáb 21/11 09:00"). Tocar abre a oferta, nunca a OS, que
  ainda não é dele. Com o app fora da tela, vira notificação do sistema quando a sincronização roda em segundo plano, o
  que exige um app instalado (seção Notificações; no Expo Go, só com o app aberto), e sai da bandeja quando a oferta
  fecha. A que fecha sem resposta → "Outro técnico aceitou a OS-…", "A central cancelou a oferta da OS-…" (só com o app
  na tela). Não há push real: com o app fechado, o técnico fica sabendo pelo texto que a central cola no grupo.
- **Tela da oferta** (`/oferta/<id>`): abrir chama `GET /me/offers/{id}`, que grava a leitura no servidor. Sem o
  cabeçalho nativo: o voltar redondo ([src/components/RoundBackButton.tsx](src/components/RoundBackButton.tsx)) fica
  fixo por cima em todos os estados (carregando, não encontrada, sem conexão, a oferta), e o voltar do Android e o gesto
  do iOS continuam; aberta por uma notificação, sem tela anterior, ele leva a Hoje. Com o leitor de tela ligado, o foco
  vai para esse voltar quando a tela termina de entrar. De cima para baixo:
  - o desenho de mapa da área com o chip "bairro · cidade/UF" (ilustração: nunca o endereço nem o pino);
  - o nº da OS grande com o selo **Aguardando resposta** ao lado (ou embaixo, quando os dois não cabem na linha), o
    título, **Você recebe** com o valor e a linha com a duração estimada (cronômetro), a data por extenso
    ("Amanhã, 20 de novembro") e a hora, ou "Data a combinar"; depois, "Responder até 15:30 · faltam 25min" (a
    ampulheta continua sendo o prazo);
  - o recado da central;
  - **Área do atendimento**: bairro e cidade, "O endereço completo aparece depois do aceite." e o botão de mapa, que
    busca "bairro, cidade - UF" no app de mapas;
  - **Serviços** com "0/1 lido": o cartão do serviço (o tipo, ou o título) começa recolhido; abrir mostra o escopo e
    marca **Escopo lido** ("1/1 lido"), guardado por oferta com a hora em que ele abriu pela primeira vez (relógio do
    servidor);
  - os formulários da OS (nome e se é obrigatório);
  - "Dúvida no escopo? Fale com a central no WhatsApp": abre o WhatsApp com o começo da mensagem ("Dúvida na oferta
    OS-000123 · Troca de PDV · Centro · Cidade Exemplo/SP: "), sem o valor; o técnico escolhe o grupo;
  - no rodapé fixo, os botões empilhados: **Aceitar por R$ X** (liberado com a leitura gravada e o escopo lido; o
    motivo da trava aparece em cima) e **Recusar**, em texto (motivo: Agenda cheia, Muito longe, Valor não compensa,
    Outro motivo).
- **Aceitar** (confirmação "Aceitar esta OS por R$ X? Ela vai para a sua agenda.") → `POST /me/offers/{id}/accept`
  com `{scope_read_at}`, a hora em que ele abriu o escopo (a central vê "Aceitou às 14:50 · escopo lido às 14:45"; a
  oferta cujo escopo foi aberto numa versão antiga do app vai sem a hora). A OS volta já atribuída e entra no aparelho
  com a própria resposta (sem o aviso duplicado "Nova OS para você"), e a tela da oferta vira a da OS. O valor aparece
  em Detalhes ("Valor desta OS") e no Faturamento (`my_payout`).
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
  concluída, o dia da conclusão; pausada ou reaberta depois de uma chegada, a data não vem preenchida. A conclusão
  grava só a data que a pergunta mostrava: sem ela, a pergunta obrigatória é digitada.
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
  tempo todo"/"Sempre"). A data do aceite aparece em Perfil › Sincronização (cartão Rastreamento da jornada, onde
  também se retira o aceite); no Perfil, a linha Termo de uso da localização diz "Aceito" ou "Não aceito".
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
    descartados. O que a rodada apura depois do fim da sessão (Sair, sessão encerrada pelo servidor, outro técnico) não
    é guardado: a limpeza do fim de sessão já esvaziou a fila (`deferNews` confere a sessão na mesma fila de gravação).
  - O texto que fica na bandeja e na fila leva a data, nunca "amanhã": "Visita sex 20/11 às 08:00 · …" e, na oferta,
    "responder até sáb 21/11 09:00". O dia relativo fica só no toast na hora.
- **Sincronização em segundo plano** (só num app instalado): na jornada, a localização mantém o app vivo e sai uma
  rodada a cada ~3 min; fora dela, a tarefa periódica do sistema (`expo-background-task`, 15 min ou mais:
  WorkManager no Android; no iOS o sistema decide e roda pouco). Com o app fechado à força pelo técnico, nada roda. A
  tela Sincronização mostra a situação na linha **Em segundo plano**; no Expo Go, "Só com o app aberto": OS nova e
  oferta só aparecem com o app aberto (o aviso na hora com o app fora da tela depende do push real).
- **Fim de sessão na rodada**: se a sessão termina durante a rodada em segundo plano (401 do `/auth/refresh`), ou já
  estava encerrada com limpeza pendente, a rodada conclui a limpeza do fim de sessão (`sessionEnd.ts`) antes de
  terminar e desliga a tarefa (se apagar os dados do técnico desativado falhar, ela fica ligada para tentar de novo).
- **Configurações › Notificações** (cartão "Neste celular"; o mesmo cartão, "Notificações", fica na Sincronização):
  a chave **Lembretes das visitas** (ligada; desliga os três de uma vez), o próximo lembrete, a permissão do celular
  (**Permitir notificações** ou **Abrir configurações**) e, no Android 12 ou mais novo sem o alarme exato, **Horário
  exato · Pode atrasar alguns minutos** com **Liberar** (`SCHEDULE_EXACT_ALARM` no `app.json`). No Android cada tipo
  tem canal próprio, que dá para silenciar no sistema: Ordens de serviço, Lembretes das visitas, Tempo na loja e
  Jornada.
- **Permissão**: um pedido automático só, uma vez por técnico, depois do termo de localização (nunca junto com o
  pedido de localização); depois, só pelos botões do cartão Notificações.
- **Push da central**: ainda não ligado. O `POST /devices` responde `{"push": "simulated"}` e o próprio app avisa;
  quando a central responder `live`, o app para de repetir o aviso (kv `push_live`). A linha **Push da central**
  (cartão Aparelho da Sincronização e "Avisos da central" em Configurações › Notificações) mostra o estado ("Ainda não
  ligado na central"; no Expo Go, "Indisponível nesta versão do app").
- **Saiu da conta**: nada agendado, a bandeja limpa (loja e endereço aparecem na tela bloqueada) e os avisos guardados
  somem (a rodada que termina depois não guarda outros). As chaves `visit_reminders`, `notifications_asked`,
  `push_live` e `deferred_notices` (cada aviso leva o id do técnico) ficam no kv e somem na troca de técnico.

## Faturamento

Aba **Faturamento** (ícone de recibo; substitui Ganhos): o técnico é parceiro e recebe por OS. Contrato em
[docs/API.md](../docs/API.md), "Valor por chamado" e "Faturamento do app". Código:
[src/lib/earnings.ts](src/lib/earnings.ts) (dados e cópia no aparelho), [src/lib/hideValues.ts](src/lib/hideValues.ts)
(o olho), `src/components/billing/` (`BillingView` é a aba; `OtherMonth`, o Outro mês; `MonthEarnings`, o mês) e a
tela `src/app/faturamento/[mes].tsx`.

- **Topo**: **Total pago** (com "Último pagamento em 18/11") e **A receber** (com "+ R$ 90,00 previsto" das OS em
  andamento e "Inclui R$ 30,00 de meses anteriores"); embaixo, só com reembolso, "Reembolsos · R$ 45,00 a receber ·
  R$ 120,00 pagos". Lado a lado; empilhados com a fonte grande ou em tela estreita.
- **Recebe no PIX**: o tipo e a chave mascarada ("CPF •••.456.789-••"); sem chave, **Cadastrar chave PIX** e "Sem
  chave PIX cadastrada". Tocar abre Configurações › Chave PIX. Só aparece com o cadastro na memória (a chave nunca fica
  no aparelho), e o leitor de tela fala só o tipo.
- **Por mês**: um cartão por mês de conclusão das OS, o mais novo primeiro, com o ícone e o selo da situação (ao lado
  do valor, ou embaixo dele quando os dois não cabem na linha), o valor total, uma linha curta
  ("3 OS sem nota · R$ 300,00", "Nota nº 1234 recusada · ver motivo") e, no rodapé, "Novembro de 2026 · 12 OS". O mês
  sem valor só aparece com nota daquela competência que não foi recusada (`invoices`): "Sem valores", R$ 0,00 e
  "1 nota fiscal" (ou "N notas fiscais"); é por ele que o técnico abre, apaga ou acompanha a nota que cobre OS de meses
  anteriores. A API publicada em 20/11/2026 não manda o `invoices` (ausente vale 0: o mês sem valor fica de fora). A
  situação vem calculada do servidor: Em andamento, Sem nota, Nota em conferência, Nota recusada, A pagar, Pago em
  parte, Pago sem nota e Pago (as cores da central, só no ícone e no selo; a linha da nota recusada em vermelho). A
  nota nunca trava o pagamento: "Sem nota" é só informativo.
- **Outro mês** ([src/components/billing/OtherMonth.tsx](src/components/billing/OtherMonth.tsx)): a linha depois dos
  cartões (ou sob "Nenhum valor ainda") abre a folha com ‹ Novembro de 2026 ›, de janeiro de 2000 (`FIRST_MONTH`, o
  primeiro que o servidor aceita) até o mês atual, e **Abrir novembro de 2026**; o mês abre quando a folha termina de
  sair. Serve para qualquer mês, também os sem cartão (sem valores ou fora dos 12 meses). Só aparece com os meses
  guardados: sem nada guardado, a aba mostra o esqueleto ou o aviso (sem internet, erro ou API sem a rota dos meses).
- **O mês** (tocar no cartão ou abrir pelo Outro mês; `/faturamento/AAAA-MM`): o título é o mês por extenso, com o olho
  no cabeçalho. No topo, a situação e o que o técnico pode fazer ("3 OS sem nota fiscal (R$ 300,00). A central paga com
  ou sem nota; se quiser, envie a nota abaixo."), neutro, e só a nota recusada ganha cor, com o motivo; o mês sem
  valores ou fora dos 12 meses abre sem essa caixa. Depois, "Chamados de novembro" (A receber, Já pago, Previsto e os
  reembolsos), as notas fiscais do mês (seção abaixo) e as OS com o valor de cada uma ("NF 1234" na coberta por uma
  nota). Tocar numa OS abre a OS: na hora, se está no aparelho; senão, com internet, a tela da OS busca na central.
  Mês fora do formato: "Mês inválido".
- **Ocultar valores** (o olho, à direita do título da aba e no cabeçalho do mês): "R$ •••••" no lugar dos valores, e
  o leitor de tela diz "valor oculto". É do aparelho (Keychain/Keystore, `mc_hide_values`, como o tema): fica no Sair e
  na troca de técnico, e enquanto não leu conta como oculto. Esconde só a tela (os valores guardados continuam no
  aparelho) e não vale na OS ("Valor desta OS") nem na oferta.
- **Vazio**: "Nenhum valor ainda" / "O valor de cada OS aparece aqui quando a central coloca você nela.", com o
  **Outro mês** embaixo. Os valores por OS existem desde 13/11/2026: com meses anteriores na janela, o rodapé diz
  "Valores registrados no app desde 13/11/2026.".
- **Dados**: `GET /me/earnings/months?months=12` (os totais e os 12 meses, com a situação e as notas de cada
  competência) e, no mês, `GET /me/earnings?month=AAAA-MM`. Ficam no aparelho para abrir sem rede (kv
  `earnings:months`, com a hora e o técnico, e `earnings:AAAA-MM`); só leitura, nada entra na fila. Busca ao abrir a
  aba, ao voltar a ela e ao abrir o mês (a busca de até 30 s atrás vale), no "puxar para atualizar" (que relê também o
  cadastro, pela chave PIX), em "Tentar de novo", quando uma nota entra ou sai neste aparelho e, depois de uma
  sincronização, se a última busca tem 2 min ou mais (pagar marca a OS como alterada e a rodada traz).
- **Sem internet ou erro**: com valores guardados, tudo aparece com "Sem internet · valores de …" ou "Não deu para
  atualizar · valores de …"; sem nada guardado, "Sem internet" / "O faturamento aparece quando a conexão voltar." ou a
  mensagem do servidor com **Tentar de novo**. Com a API antiga (sem a rota dos meses): "Não foi possível carregar o
  faturamento.", sem cartões e sem o **Outro mês** (com meses guardados antes, os guardados e o Outro mês continuam).

## Notas fiscais (aba Faturamento › mês)

Contrato em [docs/API.md](../docs/API.md), "Notas fiscais dos técnicos". Código: [src/lib/invoices.ts](src/lib/invoices.ts)
(API, cópia no aparelho e versão), [src/lib/invoiceFile.ts](src/lib/invoiceFile.ts) (escolha do arquivo),
[src/components/InvoicesCard.tsx](src/components/InvoicesCard.tsx) e a tela `src/app/nota-fiscal.tsx`.

- **Cartão "Notas fiscais de <mês>"** no mês do Faturamento, logo abaixo de "Chamados de <mês>" (também com os valores
  carregando ou com erro): uma linha por nota com o número, o valor ("R$ •••••" com os valores ocultos), a situação
  (Aguardando conferência, Conferida, Recusada), "Emitida em 05/11/2026 · 3 OS" (e "conferida em …") e, na recusada, o
  motivo da central. A lista do mês fica no aparelho (kv `invoices:AAAA-MM`; sem rede, "Sem internet · notas de …") e é
  relida ao abrir e ao voltar para a tela, ao puxar para atualizar e quando uma nota entra ou sai. Tocar na nota:
  **Abrir arquivo** (link assinado de 30 min no navegador; a lista é relida antes se tiver mais de 20 min) e **Apagar
  nota** (só a que a central ainda não conferiu).
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
- **Depois de enviar ou apagar**: o mês relê as notas e os valores, a aba relê a situação dos meses, e cada OS coberta
  mostra "NF 1234" na linha. Enviada na competência do mês de onde a tela abriu, a tela volta para ele. Enviada noutra
  competência, o aviso diz qual ("Nota nº 1234 · R$ 1.000,00 · competência de dezembro de 2026") e a tela vai para o
  mês dela no Faturamento (`router.replace`: o voltar leva ao mês de onde veio), onde a nota aparece para abrir ou
  apagar; sem valores, esse mês passa a ter cartão na aba pela nota (`invoices`). A recusa é final: o técnico apaga a
  recusada e envia outra. A conversa sobre a nota continua no grupo de WhatsApp.

## Perfil

A aba **Perfil** ([src/components/ProfileView.tsx](src/components/ProfileView.tsx)): quem é o técnico, os números dele
e o resto da conta. Só os números do próprio técnico.

- **No topo**: a foto (64), o nome e "Técnico parceiro · {grupo}" (sem grupo, "Técnico parceiro"). Embaixo, o cartão de
  duas metades ([src/components/HeroPair.tsx](src/components/HeroPair.tsx)), cada uma um botão: à esquerda, o **Total de
  atendimentos** desde sempre ("1.284", de `GET /me/stats`), que abre Estatísticas; à direita, a patente: a medalha (64)
  com o nome da faixa embaixo, em maiúsculas ("OURO"), e o ponto âmbar em risco, que abre Meu elo.
- **Sem nada guardado**: esqueleto enquanto a busca pode correr; sem internet ou com a busca falhada, "—" no total e a
  medalha cinza com "SEM ELO" (todo técnico tem faixa no servidor: "SEM ELO" só aparece sem o elo no aparelho).
- **Lista** ([src/components/MenuRow.tsx](src/components/MenuRow.tsx), `MenuGroup` e `MenuRow`): Configurações,
  Histórico de atendimentos, Estatísticas, Meu elo ("Ouro", ou "Em risco" em âmbar), Sincronização, Aviso de
  privacidade, Termo de uso da localização ("Aceito" ou "Não aceito") e **Sair**, em vermelho. Embaixo, "Versão x.y.z".
  A linha Sincronização (a mesma de Configurações, [src/lib/syncSummary.ts](src/lib/syncSummary.ts)) mostra "1 ação
  recusada" ou "N ações recusadas" em vermelho, a pílula neutra com os itens para enviar, "Sem internet" ou "Tudo
  enviado".
- **Sair** ([src/lib/logout.ts](src/lib/logout.ts), antes na Conta): "Sair da conta?"; com itens para enviar e
  internet, **Enviar e sair** (se ainda sobrar, "Ainda há itens para enviar") ou **Sair mesmo assim**. Enquanto sai, a
  linha mostra o indicador e o texto embaixo diz o que acontece ("Enviando os itens antes de sair…", "Encerrando a
  jornada e saindo…", "Saindo…"). Os itens não enviados ficam no aparelho para o mesmo técnico; se outro técnico
  entrar, são apagados.
- **Dados**: no foco da aba e quando a internet volta, o total é buscado se nada está guardado ou se o guardado passou
  de 10 min, e o elo, se nada está guardado (depois, a rodada do sync cuida dele). "Puxar para atualizar" busca os dois
  (as estatísticas e a rodada manual, que traz o elo), com teto de 25 s.

## Patente (a medalha do elo)

O elo do técnico aparece como uma medalha, a patente ([src/components/LevelBadge.tsx](src/components/LevelBadge.tsx),
`LevelMedal`). Na tela, sempre "Elo" e o nome da faixa ("Ouro"); "patente" é só o nome no código.

- **Desenho** (nosso, viewBox 48×48): hexágono de ponta para cima, com aro, face e o emblema que cresce com a faixa:
  **Bronze**, 1 divisa; **Prata**, 2; **Ouro**, 3; **Diamante**, a pedra lapidada. Sem elo, um traço numa medalha cinza
  apagada. A forma e o emblema diferenciam a faixa sem depender da cor, e o nome vai sempre escrito junto: a medalha é
  decorativa para o leitor de tela, que diz "Elo Ouro".
- **Detalhe pelo tamanho**: abaixo de 28 pt (`LEVEL_MEDAL_FLAT_BELOW`), lisa (aro cheio, face e emblema); de 28 para
  cima, com o relevo do metal (degradê no aro e na face, brilho e sombra no aro, a linha da face e as facetas da pedra).
  `LEVEL_MEDAL_GRADIENT = false` troca os degradês por cores chapadas e mantém o resto. Sem brilho animado nem reflexo:
  na comemoração, a medalha só entra como o check (cresce de leve; com "Reduzir movimento", aparece parada).
- **Onde aparece** (`LEVEL_MEDAL_SIZE`): o chip do topo da tela inicial (18, nas abas Hoje, Agenda e Faturamento), a
  metade direita do cartão do Perfil (64), a tela Meu elo (96), as faixas do "Como funciona" (24) e a comemoração da
  subida de faixa (72). No Perfil e no Meu elo, o nome da faixa vai embaixo, em maiúsculas.
- **Paths e cores**: `LEVEL_MEDAL_*` em [src/lib/constants.ts](src/lib/constants.ts), cópia da web: a central desenha a
  mesma medalha. As cores são por faixa e por tema (claro e escuro), com contraste medido contra os fundos do app.

## Configurações

**Perfil › Configurações** ([src/app/configuracoes/index.tsx](src/app/configuracoes/index.tsx)): o cadastro do técnico
em quatro grupos, cada linha com o resumo à direita (o rótulo fica com a largura dele, até metade da linha, quebrando
entre palavras, e o resumo fica com o resto, cortado com "…"; com a fonte do aparelho acima de 1,3×, o resumo desce
para baixo do rótulo; [src/components/MenuRow.tsx](src/components/MenuRow.tsx), o mesmo da lista do Perfil). Contratos
em [docs/API.md](../docs/API.md), "Meu cadastro do técnico" e "Perfil técnico". O antigo Meu cadastro foi dividido
nas telas abaixo; `/meu-cadastro` só redireciona para `/configuracoes` (links antigos).

- **Perfil**: Foto do perfil (a foto à direita; enviando ou removendo, o andamento), Dados pessoais (o nome), Contato
  ("(11) 98888-7777", ou "Sem celular" em âmbar), Endereço ("Cidade Exemplo/SP" ou "Não informado") e Senha (abre
  "Trocar senha").
- **Pagamento**: Chave PIX ("CPF •••.456.789-••"; sem chave, "Não cadastrada" em âmbar). O leitor de tela fala só o
  tipo.
- **Atendimento** (o perfil técnico): Disponibilidade (`availabilitySummary` em `lib/constants.ts`: os dias com os
  mesmos turnos, seguidos ou não, como "Seg a sex · manhã e tarde", "Seg, qua e sex · manhã" e
  "Seg a qua e sex · manhã"; os 28 turnos, "Todos os dias · todos os turnos"; dias com turnos diferentes,
  "6 dias · turnos variados"; nada, "Não informada"), Transporte ("Carro, Moto · com CNH", "Nenhum · sem CNH" ou
  "Não informado"), Aptidões, Formação e Ferramental ("3 aptidões", "1 formação", "Nenhuma"). Com a API antiga,
  "Indisponível".
- **App**: Aparência (folha com Sistema, "Acompanha o modo do celular", Claro e Escuro), Notificações ("Ligadas",
  "Desligadas", "Bloqueadas" em âmbar ou "Indisponíveis") e Sincronização (o mesmo resumo do Perfil).
- A tela abre sempre, até sem internet: lendo, os resumos são esqueletos; sem rede, "Sem internet: para mudar o
  cadastro, conecte o aparelho."; com erro, "Não foi possível carregar seu cadastro." com **Tentar de novo**. Puxar para
  atualizar relê o cadastro e o resumo das notificações.
- Grupo, cargo, acesso ao app, serviços e jornada ficam com a central; CPF, CNPJ/MEI e nascimento continuam na ficha da
  homologação.

### Cadastro: foto, dados pessoais, contato, endereço e chave PIX

Dados pessoais, Contato, Endereço e Chave PIX ([src/lib/useProfileForm.ts](src/lib/useProfileForm.ts), a moldura
`ProfileFormScreen` e as regras puras de [src/lib/profileForm.ts](src/lib/profileForm.ts)): cada tela salva só a sua
parte em `PATCH /me/profile`, pelo **Salvar** do rodapé fixo. O app confere antes, com as regras e as mensagens do
servidor (que confere de novo); os erros aparecem depois do primeiro "Salvar", e o primeiro vai também para o rodapé.
Sair com alteração não salva pergunta "Descartar as alterações?". Salvou: avisa e volta.

- **Dados pessoais**: o nome completo. Quando muda, segue a regra do servidor: só letras (com acento), espaço,
  apóstrofo, hífen e ponto, sem "www", "http" nem endereço colado ("site.com"); a mensagem é "Use só letras no nome.".
  Os nomes antigos ficam como estão.
- **Contato**: o celular (WhatsApp), sempre com DDD, e o e-mail de login, conferido só quando muda. Trocar o e-mail
  pede a senha e não tira ninguém do app (a senha é a mesma): o login passa a ser o novo, já preenchido na tela de login
  (`session.updateUser` grava também o `mc_last_email`), e o aviso diz "Use o novo e-mail para entrar no app.". E-mail
  da empresa é recusado ("Use um e-mail que não seja da empresa"), e a troca de e-mail tem limite de 10 por hora (429
  "Muitas tentativas. Tente mais tarde.").
- **Endereço**: CEP (8 números), endereço, bairro, cidade e UF (obrigatórias só aqui) e a região que atende.
- **Chave PIX**: fichas CPF, CNPJ, E-mail, Celular e Chave aleatória; a chave tem o teclado e a máscara do tipo
  ("Colar" na chave aleatória) e, embaixo, a data da última troca; trocar o tipo limpa a chave; o titular começa com o
  nome. "Remover chave PIX" só vale ao salvar (dá para desfazer). Celular do PIX: DDD sem zero e o número com o 9, como
  no servidor. No fim, o link **Aviso de privacidade**.
- **Senha atual** (folha "Confirme com sua senha"): mudar o e-mail e cadastrar, trocar ou remover a chave PIX (conta
  invadida não desvia o pagamento). A senha não fica guardada. Senha errada e o bloqueio depois de 5 erros em 15 min (o
  mesmo contador de "Trocar senha") aparecem na folha. Com a senha provisória, o app só abre "Trocar senha" (o servidor
  também recusa e-mail e PIX: "Crie sua senha no app antes de mudar o e-mail ou a chave PIX").
- **A central** é avisada na hora quando mudam PIX, e-mail, nome ou celular; toda mudança, também a do perfil técnico,
  fica no histórico do cadastro, que a central vê na ficha do técnico.
- **Foto do perfil** (`/configuracoes/foto`, [src/lib/avatarFlow.ts](src/lib/avatarFlow.ts)): **Tirar foto** (câmera
  frontal), **Escolher da galeria** ou **Remover foto** (com confirmação), um toque cada. O `photoCapture` (alvo
  `avatar`) recorta quadrado na hora; o app reduz para 512 px em JPEG (compressão 0,85) com o `expo-image-manipulator` e
  envia em `POST /me/profile/photo`. "Remover foto" tira também a que veio do Field Control; no lugar ficam as
  iniciais. O andamento (enviando ou removendo) é o mesmo na tela e na linha de Configurações, e o envio continua se a
  tela sair. No Android, a foto tirada antes de o sistema fechar o app com a câmera aberta é enviada quando
  Configurações ou a Foto do perfil abrem (até 30 min).
- **Onde a foto aparece**: no topo da tela inicial, no Perfil, em Configurações e na Foto do perfil
  ([src/components/Avatar.tsx](src/components/Avatar.tsx)). Sem foto, sem o cadastro carregado ou com o link vencido
  (12 h), aparecem as iniciais.
- O `expo-image-manipulator` é nativo e já vem no Expo Go; um development build feito antes dele precisa ser refeito.

### Perfil técnico: disponibilidade, transporte, aptidões, formação e ferramental

O que a central vê na aba **Perfil técnico** da ficha do técnico e usa para escolher quem convidar (a disponibilidade é
um sinal pequeno na sugestão de técnicos). Não pede senha. Cada parte vai inteira em `PATCH /me/profile`, e o servidor
devolve a parte como gravou: turnos e meios na ordem, o "desde" de cada aptidão, o id de cada formação e as listas na
ordem dele. A ficha aprovada na homologação já entra com a disponibilidade, o veículo, a CNH e as aptidões. As telas
não têm texto de explicação no topo: só os vazios, os limites e os avisos de rede. Código: `src/app/configuracoes/`,
[src/lib/technicalProfile.ts](src/lib/technicalProfile.ts) (o estado das telas e os catálogos),
[src/lib/autoSave.ts](src/lib/autoSave.ts) e as regras puras de
[src/lib/techProfileForm.ts](src/lib/techProfileForm.ts).

- **Disponibilidade**: os 7 dias, cada um num cartão que abre os 4 turnos (Manhã 06h–12h, Tarde 12h–18h, Noite 18h–24h
  e Madrugada 00h–06h) em fichas de duas colunas (uma por linha com a fonte do aparelho acima de 1,2×, para
  "Madrugada" não quebrar); todos começam fechados e mais de um pode ficar aberto. Não é a jornada. Num dia útil com
  turno, quando outro dia útil está diferente, aparece **Copiar para os dias úteis** (pergunta antes só quando muda um
  dia útil que já tinha turnos).
- **Transporte**: os meios (Carro, Moto, Bicicleta, Transporte público, Carro de aplicativo, A pé), **Nenhum** no fim
  dos meios e **Tenho CNH**, que vão juntos. "Nenhum" fica marcado quando o transporte foi informado sem meio; tocar
  nele grava sem meio e mantém a CNH ("Nenhum · sem CNH" ou "Nenhum · com CNH"), tocar num meio o desmarca, e tocar
  nele já marcado não faz nada. Nunca informado (`TRANSPORT_UNSET`), a tela começa sem nada marcado, nada é enviado
  antes do primeiro toque, e qualquer toque grava, mesmo voltando a tudo desmarcado antes do envio.
- **Ferramental**: o catálogo que a central mantém (Configurações › Técnicos, na central), em ordem alfabética, com
  caixa de marcar; com mais de 15 ferramentas, aparece a busca. Ferramenta desativada pela central some da lista e do
  cadastro (fica guardada no servidor e volta se for reativada).
- **Salvar ao tocar** (essas três): sem botão. O toque muda a tela na hora, e os toques de perto vão juntos num envio
  só, 0,6 s depois do último (uma linha no histórico da central), com "Salvando…" e "Salvo" no cabeçalho (o TalkBack
  fala; o VoiceOver não). Um envio por vez: o que mudar durante o envio vai logo depois, com o valor final. Sem rede,
  vibra, avisa "Sem internet" e não muda nada; se o envio falhar, a tela volta ao que está gravado e mostra o erro. Sair
  da tela com o envio agendado manda na hora (o pedido continua com a tela fechada); o Sair ou outro técnico descarta o
  pendente em silêncio.
- **Aptidões**: até 30, a mais nova primeiro, com o nível e o "desde" ("Avançado · desde 11/2026", o mês em que entrou
  no perfil; quem guarda é o servidor). **Adicionar aptidão** abre a folha com o nome (texto livre ou uma das sugestões
  da ficha da homologação: até 12, sem as que ele já tem) e o nível (Básico, Intermediário ou Avançado). Tocar numa
  aptidão muda só o nível, que mantém o "desde" (para trocar o nome, exclui e inclui de novo); a lixeira exclui, com
  confirmação.
- **Formação**: até 20, as em andamento primeiro e depois as mais recentes, com o curso, o nível (Ensino médio, Técnico,
  Graduação, Pós-graduação, Certificação ou Curso livre), a instituição e o período ("02/2022 a 12/2023", "desde 02/2024
  (em andamento)"). **Adicionar formação** e o lápis abrem a folha; o início e o fim saem de uma folha de meses (de
  01/1950 ao mês atual; o fim não vem antes do início), e **Em andamento** limpa o fim. A lixeira exclui, com
  confirmação.
- **Aptidões e Formação**: uma gravação por vez; enquanto uma está no ar, incluir, editar e excluir ficam desligados (o
  item que sai mostra o indicador), também depois de sair e voltar à tela: o estado fica no módulo
  (`trackListWrite`/`useListWrite` em `technicalProfile.ts`) e zera na troca de sessão. A lista enviada é montada na
  hora em que a gravação sai da fila (`saveProfileWith` em `profile.ts`), com a que a gravação anterior devolveu: duas
  exclusões seguidas não devolvem o item apagado. Mudar um item que a anterior já tirou mostra "Esta aptidão foi
  excluída." (ou "Esta formação foi excluída.") na folha, sem enviar nada. A folha mostra o erro do servidor no fim, não
  fecha enquanto salva e pergunta antes de descartar o que foi digitado; sem rede, avisa e fica preenchida. No limite,
  "Limite de 30 aptidões. Exclua uma para incluir outra." (e o mesmo com 20 formações).
- **Textos** (nome da aptidão, curso e instituição): conferidos como o servidor grava (`cleanText` e `foldName`): saem
  os caracteres de controle e os invisíveis (espaço de largura zero, BOM, marcas de direção), tab, LF, VT, FF e CR
  viram espaço, e os espaços se juntam. Nome só de invisíveis conta como vazio, e "Lin<U+200B>ux" repete "Linux".
- **Catálogos**: o ferramental de `GET /technician-tools` (o técnico recebe só as ativas) e as sugestões de aptidão de
  `GET /public/onboarding/catalog`, só na memória: valem 10 min (abrir a tela depois disso relê), puxar a tela relê na
  hora, e a troca de sessão apaga.
- **Servidor antigo** (o cadastro vem sem o perfil técnico): as cinco telas mostram "Indisponível no momento" / "O
  servidor ainda não tem esta parte do cadastro. Tente de novo mais tarde." e as linhas de Configurações,
  "Indisponível". Com o perfil técnico, mas sem a rota do ferramental (404): "O servidor ainda não tem o ferramental.
  Tente de novo mais tarde.".

### Sem internet e o que fica no aparelho

- **Tudo pede internet**: ler o cadastro do servidor, salvar, marcar e trocar a foto. Nada entra na fila offline: a
  senha não fica guardada e o aviso à central tem de sair na hora. Sem rede e sem o cadastro na memória, as telas dizem
  "Sem internet" / "Conecte o aparelho para abrir e salvar seu cadastro."; com ele na memória, mostram os dados com "Sem
  internet: conecte o aparelho para salvar.". Se a releitura falhar por erro do servidor: "Não foi possível atualizar
  agora. Os dados podem estar desatualizados.".
- **No aparelho**: nome, e-mail e celular no usuário da sessão (`mc_user`, SecureStore). Endereço, chave PIX, o perfil
  técnico e os catálogos ficam só na memória ([src/lib/profile.ts](src/lib/profile.ts) e
  [src/lib/technicalProfile.ts](src/lib/technicalProfile.ts)), nunca no SQLite, no kv ou no SecureStore, e somem ao
  sair da conta. O cadastro é lido ao entrar (sem aviso se falhar), ao abrir cada tela de Configurações, ao puxar o
  Faturamento e, na tela inicial e no Faturamento, quando falta ou passou de 6 h (o link da foto vale 12 h).
- **Gravações em fila** ([src/lib/profile.ts](src/lib/profile.ts)): salvar, enviar a foto e removê-la saem uma por vez
  (a seguinte espera a anterior responder, e não sai se a sessão mudou na espera), e uma leitura durante a qual uma
  gravação saiu, voltou ou ficou no ar não desfaz a tela (fica o que a gravação devolveu). O servidor também grava uma
  por vez por técnico: a gravação seguinte que a fila solta quando a anterior passou dos 20 s sem resposta (ou a de
  outro aparelho) espera a anterior terminar no servidor e não apaga o que ela gravou.

## Histórico de atendimentos

Tela `src/app/historico.tsx` (Perfil › Histórico de atendimentos): as OS concluídas em que o técnico atuou, como
responsável ou junto, também as do sistema antigo (Field Control), das mais recentes para as mais antigas. Contrato em
[docs/API.md](../docs/API.md), "Perfil do técnico: estatísticas e histórico". Substitui a aba "Concluídas", que só
mostrava os últimos 7 dias guardados no aparelho.

- **Lista**: no topo, o total ("1.284 atendimentos", o mesmo do Perfil) e "como responsável ou junto"; depois, seções
  por mês da conclusão ("Novembro de 2026", com o total do mês), com o cabeçalho preso no alto ao rolar (o mês e o ano
  ficam sempre inteiros: com a fonte grande, o total desce para a linha de baixo). Cada OS mostra o código, a data, o
  serviço e "0123 · Loja Exemplo · Cidade Exemplo/SP", com os selos **Junto** e **Sistema antigo** quando é o caso. Só
  o recorte de campo: nada de cliente, endereço, contato ou valores.
- **Tocar** abre a OS: na hora, se está no aparelho; senão, com internet, a tela da OS busca na central; sem internet,
  "Sem internet" / "Esta OS não está no aparelho. Ela abre quando a conexão voltar.". Dois toques rápidos não abrem
  duas vezes. Enquanto a tela da OS está aberta, ela fica no aparelho (`holdTicket` em `db.ts`): a limpeza do fim do
  pull, que apaga as fechadas há mais de 30 dias, não tira a OS antiga que o técnico está lendo (vale também para as do
  Meu elo e do mês do Faturamento). Fechada a tela, ou reiniciado o app, ela sai no pull seguinte.
- **Páginas** ([src/lib/history.ts](src/lib/history.ts)): `GET /me/history?limit=30` e, ao chegar perto do fim da
  lista, as seguintes pelo `cursor` da anterior, juntas sem repetir
  ([src/lib/historySections.ts](src/lib/historySections.ts), puro, com sonda). No rodapé: "Carregando mais…", "Não deu
  para carregar mais." com **Tentar de novo**, "Conecte-se à internet para ver os mais antigos." (a busca segue sozinha
  quando a conexão volta) ou "Fim do histórico".
- **Guardado**: só a primeira página, no kv `my_history`, com a hora e o técnico. Ao abrir, a tela mostra a guardada e
  busca de novo se nada está guardado ou se a guardada tem 2 min ou mais; puxar para atualizar busca na hora (uma página
  pedida antes não entra na lista nova). Sem internet: "Sem internet · mostrando os N mais recentes, de 19/11 às 10:00"
  (ou "dados de …", quando a lista já está toda); com erro, "Não deu para atualizar · dados de …". Sem nada guardado:
  "Sem internet" / "O histórico aparece quando a conexão voltar." ou o erro com **Tentar de novo**. Vazio: "Nenhum
  atendimento ainda". Servidor sem a rota (404): "O servidor ainda não tem o histórico. Tente de novo mais tarde.".

## Estatísticas

Tela `src/app/estatisticas.tsx` (Perfil › Estatísticas, o total do cartão do Perfil e "Ver mês a mês em Estatísticas"
do Meu elo). Contrato em [docs/API.md](../docs/API.md), "Perfil do técnico: estatísticas e histórico". Só os números
do próprio técnico: sem meta, sem comparação e sem cor de status. As regras são as do elo.

- **Topo**: **Total de atendimentos** desde sempre ("desde mar/2019", o primeiro mês) e **Chegada no horário** dos
  últimos 12 meses (a mesma conta do Meu elo; sem dados suficientes, "—"). Embaixo, "Atualizado em 19/11 às 10:00".
- **Últimos 12 meses** ("dez/25 a nov/26"): quatro gráficos de colunas, um por cartão
  ([src/components/MonthBars.tsx](src/components/MonthBars.tsx)): **Atendimentos** (como responsável ou junto, pelo
  mês da conclusão), **Chegadas fora do horário** (pelo mês da chegada, só nas OS com horário combinado), **Retornos**
  (OS concluída e reaberta, pelo mês da reabertura) e **Visitas perdidas** (visita improdutiva por motivo do técnico,
  pelo mês da visita). O mês atual conta até hoje. Meses só do sistema antigo ganham uma faixa cinza "Sistema antigo":
  contam nos atendimentos e ficam sem barra nos outros três (sem medição), com a legenda acima dos gráficos.
- **Ler um mês**: tocar numa coluna mostra o número dela na linha de leitura acima do gráfico, em até duas linhas (a
  altura das duas fica reservada: o gráfico não pula ao tocar); sem mês escolhido, o total dos 12 meses. O leitor de
  tela trata o gráfico como ajustável (deslizar para cima ou para baixo passa os meses). O gráfico não tem texto dentro
  do SVG: os rótulos são o `Text` do app (Manrope e fonte ampliada). O eixo mostra todos os meses quando cabem; senão,
  um sim e um não (ou mais espaçados), contando do atual, que sempre aparece, cada nome inteiro, sem "…". As contas
  ficam em [src/lib/monthBars.ts](src/lib/monthBars.ts) (`axisLabelBoxes` para o eixo), puro, com sonda.
- **Ver mês a mês**: os 12 meses em texto, do atual para o mais antigo (o equivalente completo dos gráficos), com "X
  como responsável, Y junto". No fim, "Os números seguem as regras do elo.", o link **Como funciona o elo** e "Dúvida?
  Fale com a central no grupo.".
- **Dados** ([src/lib/stats.ts](src/lib/stats.ts)): `GET /me/stats`, guardado no kv `my_stats` com a hora e o técnico
  (o Perfil lê o mesmo). A tela busca ao abrir e ao voltar a ela, se nada está guardado ou o guardado tem 2 min ou mais,
  e ao puxar para atualizar; pedidos ao mesmo tempo dividem a mesma busca. Só leitura, fora da rodada do sync e da fila.
- **Sem internet ou erro**: com o guardado, os números aparecem com "Sem internet · dados de …" ou "Não deu para
  atualizar · dados de …"; sem nada guardado, "Sem internet: as estatísticas aparecem quando a conexão voltar." (ou o
  erro) com **Tentar de novo**. Servidor sem a rota (404): "O servidor ainda não tem as estatísticas. Tente de novo mais
  tarde.".

## Meu elo

O elo do técnico (Bronze, Prata, Ouro ou Diamante) sai dos atendimentos dos últimos 12 meses: quantos (como
responsável ou junto, também os do Field Control) e como (chegada no horário combinado, OS reaberta em até 30 dias,
visita perdida por motivo do técnico). Regras, faixas e textos vêm prontos do servidor em `GET /me/level`
([docs/API.md](../docs/API.md), "Elo dos técnicos"): o app não repete números. Código:
[src/lib/level.ts](src/lib/level.ts) (guardado, leitura nas telas e comemoração), `refreshLevel`/`refreshLevelNow` em
[src/lib/sync.ts](src/lib/sync.ts), a medalha em [src/components/LevelBadge.tsx](src/components/LevelBadge.tsx) (seção
Patente) e a tela `src/app/elo.tsx`.

- **Onde aparece**: o chip com a medalha no topo da tela inicial, ao lado da foto (nas abas Hoje, Agenda e
  Faturamento; some sem elo guardado; ponto âmbar em risco; o leitor de tela diz "Elo Ouro. Abre Meu elo"); a metade
  direita do cartão do Perfil (a medalha com o nome em maiúsculas, ou "SEM ELO"); a linha **Meu elo** do Perfil
  ("Ouro", ou "Em risco" em âmbar); e a tela **Meu elo**: a medalha grande com o nome da faixa em maiúsculas ("OURO"; o
  leitor de tela diz "Elo Ouro"), desde quando e a hora da atualização; em risco, a caixa "Elo Ouro em risco" com o
  texto do servidor; o que falta para a próxima faixa ("Para chegar ao Diamante", com barra nos atendimentos) e, em
  risco ou no Diamante, o que a faixa atual pede ("Para continuar no Ouro"); os números dos últimos 12 meses, com
  **Ver mês a mês em Estatísticas**; o que pesou (as 30 mais recentes; tocar abre a OS: na hora, se está no aparelho;
  senão, com internet, a tela da OS busca na central; sem internet, avisa) e "Como funciona" (as quatro faixas com a
  medalha e as regras, com o link **Aviso de privacidade** no fim). Dúvida sobre o elo é com a central, no grupo de
  WhatsApp.
- **Dados**: a rodada do sync busca `GET /me/level` a cada 30 min e no "puxar para atualizar", só com o app na tela
  (fora dela não gasta bateria e dados com isso); a tela Meu elo busca ao abrir (se o guardado tem mais de 2 min) e ao
  puxar para baixo; e a aba Perfil busca uma vez por foco enquanto nada está guardado. Fica no kv `my_level` com a hora
  e o técnico; offline (ou com erro), a tela mostra o último guardado com "Sem internet · dados de 18/11 às 10:00". Só
  leitura, fora da fila de operações; sai do aparelho na troca de técnico. As telas do elo releem a cada busca, o resto
  do app só quando o elo mudou.
- **Subiu de faixa**: a comemoração mostra a medalha da faixa nova no lugar do check, com "Você chegou ao Ouro!" e "Veja
  em Meu elo o que conta para o próximo." (no Diamante, "É o elo mais alto."), dentro do app. A primeira carga não
  comemora; a subida que chega com o app saindo da tela espera ele voltar; não há push.
- **O que o técnico não vê**: outros técnicos, ranking, notas da central nem o que ela desconsiderou.

## Sincronização (antiga Conta)

Tela `src/app/conta.tsx`: a rota continua `/conta`, e o título é "Sincronização". Abre pela linha Sincronização do
Perfil e de Configurações, pela faixa de conexão do topo, pela linha de pendências da OS e pela faixa vermelha de ações
recusadas de Hoje (`openSync`, em [src/lib/navigation.ts](src/lib/navigation.ts)). `?secao=pendencias`, `avisos` ou
`rastreamento` abre a tela já rolada até o cartão (a OS abre as pendências; a faixa de Hoje, os avisos), e o cartão fica
no topo até o técnico mexer na tela.

- **Sincronização**: conexão, atualização automática (o tempo real), última sincronização, ações e fotos para enviar,
  **Em segundo plano**, o último erro, **Sincronizar agora** e **Baixar tudo de novo**.
- **Itens para enviar**: a fila; a ação que o servidor falhou em processar 3 vezes pode ser descartada (falta de rede e
  falha do envio inteiro não contam).
- **Ações que a central não aceitou**: o motivo, **Abrir OS** e **OK**.
- **Rastreamento da jornada**: o Termo de uso da localização, com a data do aceite, a situação, a última posição, as
  posições aguardando envio e **Retirar aceite**.
- **Notificações** (o mesmo cartão de Configurações › Notificações) e **Aparelho** (Push da central, o servidor da API
  quando dá para trocar e a versão do app).
- Saíram daqui o cartão Técnico (foto, nome, elo, Meu cadastro e senha), a Aparência, o Sair e a linha Aviso de
  privacidade: a identidade e o Sair estão no Perfil; o cadastro, a senha e a Aparência, em Configurações.

## Aviso de privacidade

Tela `/privacidade` ([src/app/privacidade.tsx](src/app/privacidade.tsx)), só de leitura.

- **Texto**: `PRIVACY_NOTICE` de [src/lib/constants.ts](src/lib/constants.ts), o mesmo da ficha da homologação (cópia
  idêntica da web), com "Atualizado em 19/11/2026" (`PRIVACY_DATE`: a data de `PRIVACY_VERSION`, sem o ".2" de uma
  segunda versão no mesmo dia). Cita os dados do cadastro e a chave PIX, o perfil técnico (aptidões, formação,
  ferramental, meios de transporte e CNH, dias e turnos disponíveis, informado na ficha ou no app, que ajuda a central a
  escolher quem convidar), o pagamento por PIX, a localização na jornada, as notas fiscais e o Elo; em "Seus direitos",
  que o técnico aprovado atualiza o perfil técnico em Configurações.
- **Onde abre**: no Perfil (linha Aviso de privacidade), no fim de Configurações › Chave PIX, no fim da tela Enviar nota
  fiscal, no fim do "Como funciona" do Meu elo e no cartão de Hoje.
- **Cartão em Hoje** ([src/components/PrivacyUpdateCard.tsx](src/components/PrivacyUpdateCard.tsx)): quando o texto
  muda (`PRIVACY_VERSION` diferente da versão que este técnico abriu), a aba Hoje mostra, depois da jornada e das
  ofertas, "Aviso de privacidade atualizado" · "Agora ele fala do seu perfil técnico e dos registros das ofertas de OS."
  com **Ler aviso**. É discreto e não bloqueia nada. Abrir o aviso por qualquer
  caminho grava a versão como vista quando a tela termina de entrar (evento `transitionEnd` da pilha; sem ele, como na
  web, 600 ms depois de abrir): o cartão some com Hoje já coberto, sem mexer na tela durante a transição.
- **Versão vista** ([src/lib/privacySeen.ts](src/lib/privacySeen.ts)): só no aparelho, por técnico, no
  Keychain/Keystore (`mc_privacy_seen_<id do técnico>`, como a preferência de tema). Vale offline e sobrevive ao
  Sair e à troca de técnico. O cartão só lê a memória desse módulo, carregado com o `_layout.tsx`. A abertura do
  app com técnico salvo (a splash) e o login esperam a leitura no máximo 300 ms: o cartão já entra no primeiro
  quadro de Hoje. Se ela demorar mais, Hoje abre sem esperar e o cartão entra depois, com um fade curto; se falhar,
  o cartão não aparece e Hoje tenta ler de novo quando monta.
- **Não grava ciência no servidor**: o aceite continua sendo o da ficha da homologação.

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
  app fora da tela, a jornada e a tarefa periódica do sistema, só num app instalado (seção Notificações).
- Todas as escritas no SQLite passam por uma fila de transações exclusivas em JS.
- OS fechadas/canceladas há mais de 30 dias e sem pendências saem do aparelho no fim do pull (as concluídas continuam no
  Histórico de atendimentos, que vem da central), menos a que está aberta na tela (`holdTicket`, só na memória).
- Fora do pull e da fila: o elo, as Estatísticas, o Histórico e o Faturamento são só leitura, guardados no kv com a hora
  ([docs/MOBILE_SYNC.md](../docs/MOBILE_SYNC.md) §2); o cadastro e o perfil técnico são só online e ficam na memória
  (§1); a resposta à oferta e a nota fiscal são só online (§3).

## Estrutura

```
index.ts               entrada: expo-router + tarefas de segundo plano (rastreamento e sincronização, definidas antes das rotas, para o relançamento sem tela do Android) e, depois delas, o fim de sessão (sessionEnd.ts)
src/
  app/                 rotas (expo-router)
    _layout.tsx        sessão, tema e "ocultar valores" (a splash espera os dois), Stack com rotas protegidas, toasts
    login.tsx          login + servidor da API
    trocar-senha.tsx   primeiro acesso (senha provisória) e Configurações › Senha
    index.tsx          tela inicial: jornada + Hoje / Agenda (calendário) / Faturamento / Perfil
    ticket/[id].tsx    detalhe, ações e abas
    oferta/[id].tsx    oferta de OS com preço (sem o cabeçalho nativo: voltar redondo): mapa da área, valor, duração e data, "Serviços 1/1 lido", WhatsApp, "Aceitar por R$ X" ou "Recusar"
    faturamento/[mes].tsx  um mês do Faturamento: a situação, os valores, as notas fiscais e as OS
    historico.tsx      Histórico de atendimentos: as OS concluídas por mês, com rolagem infinita (/me/history)
    estatisticas.tsx   Estatísticas: o total, a chegada no horário e os quatro gráficos de 12 meses (/me/stats)
    elo.tsx            Meu elo: a medalha, risco, o que falta para a próxima faixa, números, o que pesou e "Como funciona"
    conta.tsx          Sincronização (a rota continua /conta): sincronização, fila, avisos recusados, rastreamento, notificações e aparelho (?secao=)
    configuracoes/     Configurações: index.tsx (o menu em 4 grupos); o cadastro (foto, dados-pessoais, contato, endereco, pix); o perfil técnico (disponibilidade, transporte, aptidoes, formacao, ferramental); notificacoes
    meu-cadastro.tsx   só redireciona para /configuracoes (links antigos)
    termo-rastreamento.tsx  termo de ciência do rastreamento (LGPD)
    privacidade.tsx    Aviso de privacidade (LGPD), só leitura; abrir grava a versão vista pelo técnico
    nota-fiscal.tsx    Enviar nota fiscal: arquivo, número, emissão, valor, competência e as OS que a nota cobre
  components/          UI (marca, cartões, calendário, jornada, diálogo de transição, abas da OS)
    Text.tsx           Text do app: aplica a Manrope no peso do estilo (use este, não o do react-native)
    motion.tsx         entrada em cascata, transição de layout, PressableScale (0,97 com mola), Pulse
    Skeleton.tsx FieldStepper.tsx SuccessHost.tsx TabBar.tsx ActionSheet.tsx Icon.tsx RouteMapPattern.tsx
    ProfileView.tsx    aba Perfil: identidade, o cartão com o total e a patente, a lista e a versão
    HeroPair.tsx       cartão de duas metades do Perfil e das Estatísticas
    MenuRow.tsx        linhas e grupos das listas do Perfil e de Configurações (resumo à direita, pílula, Sair em vermelho)
    MonthBars.tsx      gráfico de colunas de 12 meses das Estatísticas (as contas em lib/monthBars.ts)
    NotificationsCard.tsx  cartão Notificações (lembretes, permissão, alarme exato), a linha Push da central, o resumo da linha de Configurações e "Em segundo plano"
    Avatar.tsx         foto do técnico ou as iniciais (topo da tela inicial, Perfil, Configurações)
    PrivacyUpdateCard.tsx  Hoje > "Aviso de privacidade atualizado" (lê a versão vista de lib/privacySeen.ts)
    InvoicesCard.tsx   Faturamento > mês > Notas fiscais (situação, motivo da recusa, abrir arquivo, apagar, enviar)
    LevelBadge.tsx     a patente (medalha do elo), o selo e o chip do topo de Hoje
    Offers.tsx         "Ofertas para você" em Hoje e os blocos da tela da oferta (duração e data, área, serviços)
    offer/OfferHero.tsx  topo da oferta: o desenho de mapa da área com o chip bairro · cidade
    RoundBackButton.tsx  voltar redondo das telas sem o cabeçalho nativo (a oferta)
    billing/           aba Faturamento: BillingView (a aba), BillingTotals, PixRow, BillingMonthCard, StateIcon, SituationBox, OtherMonth ("Outro mês"), MonthEarnings (o mês) e HideValuesButton (o olho)
    settings/          peças de Configurações: ChoiceChips, CheckCard, Checkbox, DayCard, SkillSheet, EducationSheet, MonthField, FormSheet, FixedFooter, OfflineNotice, ProfileGate, ProfileFormScreen, PasswordSheet e SavingStatus
  theme/theme.ts       paleta Maxx Field, claro/escuro, preferência do técnico (viz1 e vizGrid: os gráficos)
  theme/fonts.ts       Manrope (pesos 400–700) e o mapeamento de fontWeight para a família
  lib/
    tracking.ts trackingTask.ts  jornada, coleta, fila de pontos e tarefa de segundo plano
    account.ts         /auth/me e troca de senha
    profile.ts         o cadastro só na memória (GET/PATCH /me/profile, com o perfil técnico), as gravações em fila e a foto reduzida no aparelho (expo-image-manipulator)
    profileForm.ts useProfileForm.ts  telas do cadastro em Configurações: as regras e os resumos (puro, com sonda) e o estado do formulário
    avatarFlow.ts      Foto do perfil: tirar, escolher, remover, o andamento e a recuperação no Android
    technicalProfile.ts  perfil técnico: o estado das telas de Atendimento, a trava das listas (Aptidões e Formação) e os catálogos na memória (ferramental e sugestões de aptidão)
    techProfileForm.ts  regras do perfil técnico e o redutor do salvar ao tocar (puro, com sonda)
    autoSave.ts        salvar ao tocar de Disponibilidade, Transporte e Ferramental (0,6 s, um envio por vez)
    logout.ts          o Sair do Perfil: confirmação, "Enviar e sair" e o andamento
    navigation.ts      openSync (a Sincronização com ?secao=) e openTicketAnywhere (a OS do aparelho ou da central)
    syncSummary.ts     o resumo da linha Sincronização (Perfil e Configurações)
    net.ts             sem rede ou erro do servidor, na hora de salvar
    stats.ts           Estatísticas: /me/stats guardado (kv my_stats) e a busca
    history.ts historySections.ts  Histórico: /me/history (primeira página no kv my_history) e as seções por mês (puro, com sonda)
    monthBars.ts       contas do gráfico das Estatísticas (puro, com sonda)
    earnings.ts        Faturamento: os meses (kv earnings:months), o mês (kv earnings:AAAA-MM) e o primeiro mês aceito (FIRST_MONTH, 2000-01)
    hideValues.ts      "ocultar valores" do Faturamento, por aparelho (SecureStore mc_hide_values)
    privacySeen.ts     versão do aviso de privacidade vista por técnico (Keychain/Keystore), lida na abertura e no login
    pix.ts masks.ts    chave PIX por tipo (regras e mensagens de backend/app/core/pix.py) e máscaras de CPF, CNPJ, CEP e celular
    types.ts constants.ts workflow.ts   copiados de frontend/src/lib (manter iguais)
    syncTypes.ts       contrato de /sync/pull e /sync/push
    api.ts session.ts  HTTP com refresh + tokens e o fim de sessão pendente no SecureStore
    sessionEnd.ts      fim de sessão (Sair, expirada, acesso desativado ou retirado): limpeza com ou sem tela; carregado pelo index.ts
    db.ts              schema SQLite e consultas; a limpeza do fim do pull (pruneOld) e a OS segura na tela (holdTicket)
    ops.ts             aplicação otimista e rebase; user_can_transition e allowed_transitions iguais ao backend
    field.ts           promessa de campo: relógios de chegada e de loja, rótulos de peças
    notifications.ts   notificações: handler, canais, permissão, toque, alertas locais, novidades fora da tela e os avisos guardados sem permissão
    visitReminders.ts  lembretes da visita (1 dia, 1h40 e 10 min antes): plano e textos, sem import nativo
    onsiteAlerts.ts    notificações locais do tempo na loja
    backgroundSync.ts  sincronização fora da tela (jornada e tarefa periódica); .web.ts sem efeito
    sync.ts            motor de sync, fila, fotos, gatilhos
    offers.ts          ofertas de OS: lista guardada, prazo pelo relógio do servidor, "Escopo lido" (com a hora que vai no aceite) e avisos
    invoices.ts        notas fiscais: /me/invoices (lista guardada por competência, envio, exclusão, abrir arquivo) e a versão que relê o Faturamento
    invoiceFile.ts     arquivo da nota: seletor do sistema ou foto, cópia no cache; .web.ts com <input type="file">
    level.ts           Meu elo: o elo guardado (kv my_level), leitura nas telas, comemoração da subida (com a medalha) e datas
    realtime.ts        WebSocket
    sla.ts             porta de backend/app/services/sla.py::compute_sla_status
    device.ts          POST/DELETE /devices (o servidor diz se o push chega: live ou simulated)
tests/                 sondas das regras puras (node:test); resolve-ts.mjs registra o gancho que resolve "./masks" para "./masks.ts"
```

`types.ts`, `constants.ts` e `workflow.ts` são cópias exatas dos arquivos da web. Ao mudar regras de
status ou tipos no backend, atualize os três lugares (backend, `frontend/src/lib`, `mobile/src/lib`).
Saíram nesta versão: `components/EarningsView.tsx` (virou `components/billing/`), `components/PixCard.tsx` (virou
`billing/PixRow.tsx`) e o formulário de `app/meu-cadastro.tsx` (virou `app/configuracoes/`).

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

As **sondas** (`tests/*.test.mjs`) testam as regras puras com o `node:test` (Node 22.6 ou mais, que tira os tipos do
TypeScript): a chave PIX, as telas do cadastro, o perfil técnico e o salvar ao tocar, o gráfico das Estatísticas (com
as caixas do eixo), as seções do Histórico e as datas e a área da oferta. O módulo testado não importa React nem React
Native (só `import type`), e o gancho `tests/resolve-ts.mjs` resolve os imports relativos sem extensão (`./masks` →
`./masks.ts`). Duas fogem disso: `ticket-hold.test.mjs` roda o `db.ts` de verdade (a OS segura na tela e o
`pruneOld`) sobre o `node:sqlite` (Node 22.13 ou mais), com dublês de `expo-sqlite`, `react-native`, `./changes` e
`./ops` registrados nela mesma; e `billing-offer.test.mjs` lê o código das telas do Faturamento e da oferta (que
importam o React Native) e confere as regras que não podem voltar (o mês com nota, o Outro mês, a nota noutra
competência, o selo que desce e o foco do leitor de tela no voltar):

```bash
node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
```

`types.ts`, `constants.ts` e `workflow.ts` iguais aos da web (sem saída; a sonda `frontend/tests/mirror.test.mjs`
confere o mesmo):

```bash
for f in types constants workflow; do cmp ../frontend/src/lib/$f.ts src/lib/$f.ts; done
```

Sem Node na máquina, rode tudo num container (o drive D: não monta no Docker Desktop daqui):

```bash
docker create --name mc-mobile-check -w /app node:22-alpine sh -c "npm ci && npx tsc --noEmit && npx expo lint && npx expo export --platform android && node --experimental-strip-types --import ./tests/resolve-ts.mjs --test 'tests/*.test.mjs'"
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
- **No Expo Go, OS nova e oferta só aparecem com o app aberto**: ele não roda a tarefa periódica nem a jornada em
  segundo plano, e o push real está desligado. Os lembretes da visita (locais) funcionam, mas só para as OS que o app
  já sincronizou: a OS atribuída com o app fechado só ganha lembrete quando o técnico abre o app.
- **Segundo plano limitado** (app instalado): só na jornada (~3 min) e na tarefa periódica do sistema (15 min ou
  mais; no iOS, rara). Com o app fechado à força pelo técnico, ou no iPhone fora da jornada, OS nova e oferta só
  aparecem quando o app abre. Avisar na hora exige o push real (FCM, ver Push acima), ainda desligado. Um lembrete de
  uma OS mudada enquanto o aparelho não sincronizou ainda sai com o horário antigo.
- **A API sobe antes do app.** A API desta entrega está publicada desde 20/11/2026. O perfil técnico, o ferramental,
  as Estatísticas, o Histórico e os meses do Faturamento precisam dela. Com uma API anterior, o app novo mostra
  "Indisponível no momento" nas telas de Atendimento (e "Indisponível" nas linhas de Configurações), as mensagens de
  servidor antigo nas Estatísticas e no Histórico, "—" no total do Perfil e "Não foi possível carregar o faturamento."
  na aba Faturamento. Ali, o mês (`GET /me/earnings?month=`, que a API anterior tem) abre pelo **Outro mês** (ou por um
  cartão) só com os meses guardados de uma busca anterior que deu certo; sem nada guardado, a aba fica sem cartões e
  sem o Outro mês, e o mês e o "Enviar nota fiscal" ficam fora de alcance. A API publicada em 20/11/2026 não manda o
  `invoices` dos meses: com ela, o mês sem valores e com nota fica sem cartão e abre pelo Outro mês. A API nova com o
  app antigo funciona.
- Rótulos e transições vêm das constantes copiadas da web, não de `GET /meta`; as ações exibidas vêm de
  `allowed_transitions` do servidor (recalculadas no aparelho só depois de uma ação offline).
- Sem assinatura do cliente, edição dos dados da OS (`update`) ou abertura de OS pelo app.

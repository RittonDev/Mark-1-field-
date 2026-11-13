# Maxx Field (MaxxChamados)

Gestão de chamados / ordens de serviço de T.I. com atendimento em campo: manutenção de impressoras,
computadores, redes, CFTV e telefonia. Referências de produto: **Field Control** (a ferramenta que a
operação usa hoje) e o **GLPI** (Field Service, ITIL). Em caso de dúvida, seguir o Field Control.

A ferramenta tem **dois acessos**, e o backend aplica essa separação no login (`channel`):

| Acesso | Quem | Para quê |
|---|---|---|
| **Navegador** (`frontend/`) | Analistas, supervisores e administradores. O solicitante também, no portal dele. | Toda a gestão das OS: ver, abrir, editar, atribuir, mudar status, SLA, dashboard e cadastros |
| **Celular** (`mobile/`, Android e iOS) | **Técnicos de campo**, e só eles | Atender as OS dele: agenda, deslocamento, check-in GPS, fotos, apontamentos, offline |

O técnico que tenta entrar pelo navegador (ou o analista pelo app) recebe a orientação de qual acesso usar.
Os dois canais ficam sincronizados em tempo real.

**Dinâmica do técnico:** o cliente abre a OS; o analista coloca o técnico nela (na própria OS ou pelo
calendário). Só então ela aparece para ele: o técnico vê **apenas as OS atribuídas a ele**, na agenda do
app, com as informações do cliente, o escopo e onde subir as evidências. Não existe "fila" nem "assumir"
para o técnico.

**Acesso:** analistas e gestores entram no navegador com a **conta Microsoft da empresa** (Entra ID,
domínio `@maxxgroup.com.br`); técnicos entram no app com o e-mail e a senha que cadastraram na
**homologação**. A gestão redefine senha, troca e-mail, nome e foto dos técnicos em **Técnicos**.

| Camada | Stack |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, TanStack Query |
| Backend | Python 3.12, FastAPI, SQLAlchemy 2 (async), Pydantic 2, Alembic |
| Banco | PostgreSQL 16 |
| Tempo real | WebSocket + Redis Pub/Sub |

## Funcionalidades

- **OS com ciclo de vida padrão de mercado** (ITIL / ServiceNow / Jira SM + estados de campo):
  Novo, Em triagem, Atribuído, Agendado, Em deslocamento, Em atendimento, Aguardando cliente,
  Aguardando fornecedor/peça, Resolvido, Fechado, Cancelado, Reaberto. Ver [docs/STATUS_E_SLA.md](docs/STATUS_E_SLA.md).
- **Atribuição a analista ou técnico** (com a carga atual de cada um), "Assumir OS" (só analista e gestor; vai para a fila de quem assumiu), grupos técnicos e roteamento por categoria.
- **SLA** de 1ª resposta e de solução por prioridade (matriz impacto × urgência), pausado nas pendências, com alertas "em risco" e "violado".
- **Detalhe da OS:** acompanhamentos públicos e notas internas, histórico/auditoria, apontamento de horas, anexos e fotos, check-in por GPS.
- **Anexos da OS pela web:** o analista arrasta fotos e arquivos do computador (ou escolhe vários de uma vez), com uma descrição opcional para o lote; põe ou edita a **descrição de cada foto** (legenda que aparece no relatório do cliente e no PDF); e **exclui** anexos (só a gestão, com registro no histórico; a assinatura do responsável não sai). Vale também em OS concluída. O técnico edita a legenda só das fotos que ele mesmo enviou.
- **Quadro kanban** com arrastar e soltar, que só aceita transições válidas.
- **Dashboard:** backlog, SLA, conformidade em 30 dias, tempo médio de solução, carga por analista.
- **Locais como filiais** (como no Field Control): cada local tem código e CNPJ próprio, tela própria com busca e paginação, e histórico resumido (OS abertas, total, última OS). A OS aceita um **endereço do atendimento** separado do endereço do local.
- **Tipos de serviço com duração estimada × real** (o "Tipo de OS" do Field Control, inclusive por cliente). A real é medida pelo tempo em atendimento; a tela compara as duas e o catálogo sugere corrigir a estimativa pela mediana do que aconteceu (a estimativa aprende). Agendar só com o início usa a duração estimada.
- **Atividades do dia** (tela própria, como no Field Control): as visitas do dia agrupadas por técnico, com agendado × início real × término na mesma linha, atraso, check-in com GPS, estimada × real, situações (agendada, atrasada, em deslocamento, em atendimento, pendente, reagendada, concluída) e atualização em tempo real.
- **Motivo da violação de SLA** (como no Field Control): um motivo por relógio (resposta e solução), escolhido de um cadastro com a responsabilidade (interna, cliente, terceiro). É pedido ao resolver uma OS que furou o prazo, pode ser justificado depois (até com a OS fechada) e vira estatística no dashboard, com a lista das pendentes de justificativa.
- **Calendário** das OS por técnico (mês, semana e dia por técnico), com filtros de técnico, grupo, cliente, local e cidade. **Conflito de horário:** a API recusa (409) agendar ou atribuir uma OS a um técnico que já tem outra no mesmo horário; quem agenda vê as OS em choque (inclusive como aviso antes de salvar) e pode confirmar mesmo assim. O calendário marca em vermelho os conflitos que existirem.
- **Mapa ao vivo e rastreamento** (padrão Field Control): o app envia a posição do técnico **só durante a jornada** que ele inicia e encerra, e só depois do aceite do termo (LGPD). O mapa mostra cada técnico com o estado (em atendimento, em deslocamento, disponível, sem sinal, fora da jornada), bateria, velocidade, GPS simulado, a OS em campo com a linha até o destino e o trajeto do dia com os pontos de check-in. Fora da jornada a posição não aparece. Histórico apagado após `TRACKING_RETENTION_DAYS` (90).
- **Mapa: loja do cliente e casa do técnico.** Além do filtro de técnico, o mapa tem o filtro **Loja do cliente**: a loja aparece no mapa e a lista passa a ordenar os técnicos do mais perto para o mais longe (pela posição de agora, se recente; senão, pela casa), com "agora 12 km · casa 18 km" em cada um. Ao escolher um técnico, o mapa mostra a casa dele e as linhas até a loja, e o painel traz **Agora → loja**, **Casa → loja** e **Agora → casa**, cada um em linha reta, pelas ruas (estimativa) e em tempo de carro. Sem endereço de casa no cadastro, usa a cidade de casa ou a base (onde mais atende), marcado como aproximado; loja sem coordenada usa o centro da cidade. Só a gestão vê (`GET /tracking/distances`).
- **Homologação de técnicos:** o analista gera um link (uso único ou reutilizável, com validade) e envia por WhatsApp ou e-mail. O técnico preenche no celular a ficha (dados pessoais, foto, áreas de atuação, skills, região, disponibilidade, veículo) e cria o próprio acesso, aceitando o aviso de privacidade. A ficha chega em **Homologação** (com aviso em tempo real); aprovada, ele entra na base técnica e já acessa o app.
- **Fichas completas:** cliente (todos os contatos com nome e tipo, endereço da matriz, logo, etiquetas, avaliação, primeiro e último atendimento, lojas e OS recentes), loja (endereço, todos os contatos, quem já atendeu e quantas vezes, OS recentes) e técnico (endereço, jornada, serviços que faz e região de atuação), com o que veio do Field Control. As buscas aceitam palavras em qualquer ordem e as cidades ficam com uma grafia só.
- **Técnicos por estado e cidade e "mais próximos de uma loja":** filtro por UF e cidade pela região de atuação (calculada pelo histórico de atendimentos, ou pelo endereço). A busca por proximidade aceita a loja, a cidade ou as coordenadas / link do Google Maps e ordena pela distância real (lojas que ele já atendeu, endereço ou posição ao vivo), com os motivos e atalhos de WhatsApp e ligação. Coordenadas falsas do Field Control (como o "centro do Brasil") são descartadas e a loja usa o centro da cidade.
- **Base técnica (Técnicos):** cadastro direto com senha provisória, edição de e-mail, nome, telefone, grupo e foto, desativação, **redefinição de senha** (encerra as sessões abertas) e **importação da base por planilha** CSV/XLSX, com prévia linha a linha e arquivo com as senhas provisórias.
- **Importação de locais** por planilha CSV/XLSX (CSV do Excel brasileiro com `;` e acentos): cliente por CNPJ ou nome (criado se não existir), local por código, CNPJ ou nome (atualiza o que existe), coordenadas com vírgula, prévia antes de gravar.
- **Formulários (checklists) na OS:** a gestão monta modelos (texto, sim/não, escolha, número, data, confirmação e **fotos com mínimo/máximo**, ex.: "foto do rack antes / depois") e decide, em cada OS, anexar e se é obrigatório. O técnico preenche no app (também offline); a OS só é concluída, e a **assinatura do responsável no local** só é colhida, com os obrigatórios concluídos. Depois da assinatura, o técnico não altera mais o formulário.
- **Custos extras na OS** (material, km rodado com valor do km configurável, pedágio, estacionamento...): só analistas e gestores lançam e alteram; o técnico só vê; o cliente nunca vê. Tela de reembolso por técnico e mês, com "marcar como reembolsado" e CSV.
- **Visita improdutiva:** o técnico foi e não atendeu; escolhe o motivo (catálogo com responsabilidade cliente/interna/terceiro) e a OS volta para reagendar, contada nos relatórios.
- **Orçamentos:** montados na OS com itens de um catálogo de preços, cada item como produto, serviço ou despesa (com a medida: un, m, rolo, h). O link para o cliente fica sempre disponível na OS para copiar ou mandar por WhatsApp e e-mail (e dá para gerar um novo, que invalida o anterior). O cliente vê uma página no padrão de mercado: dados da empresa, número da OS e do orçamento, cliente e endereço, itens, resumo por produtos, serviços e despesas, desconto e total. Ele aprova com **assinatura desenhada, nome e matrícula (opcional)**, deixa um comentário para a empresa, ou recusa com o motivo, e baixa em PDF. A gestão recebe na hora. Os dados da empresa ficam em Configurações. Na tela **Orçamentos**, cada linha tem **Ver** e **Editar** (enquanto o cliente não respondeu): a visualização mostra OS, cliente, criação e validade, a situação em destaque (quem aprovou, com a assinatura; o motivo da recusa; desde quando espera), os itens por tipo, os totais e as condições, e dali dá para editar, enviar ao cliente ou pegar o link, sem abrir a OS.
- **Projetos:** OS marcadas como de projeto, com valor fechado, condições, equipe e responsável; a tela do projeto mostra andamento, custos, orçamentos aprovados e margem.
- **Assistência externa** (no lugar de Ativos): impressoras retiradas do cliente para conserto em terceiros, com cada etapa (retirado, recebido, enviado, orçamento da assistência, em reparo, pronto, de volta, entregue), fotos, protocolo, previsão de retorno e alerta de atraso.
- **Relatórios:** fechamento diário (o dia fecha à meia-noite; o painel abre no dia anterior) com chamados que entraram, resolvidos, cancelados, improdutivos, que ficaram agendados e o cliente destaque; e o mensal com a série por dia, rankings e CSV.
- **Sugestão de técnicos por localização:** na OS, os 5 técnicos mais indicados (mora na cidade, atende a região, distância agora pelo rastreamento, livre no horário, skill, carga), com o motivo de cada sugestão e atribuição em um clique.
- **Comunicação pelo WhatsApp:** botão na OS monta a mensagem (cliente, endereço com mapa, agenda, técnico, escopo, formulário obrigatório) para o grupo dos técnicos.
- **Textos do WhatsApp (macros):** cada OS tem a seção de textos com um botão por aviso (deslocamento, chegada, atraso, agendamento, fechamento, visita improdutiva) que copia a mensagem já preenchida com os dados da OS: técnico, loja, cidade, endereço, contato, horário agendado e **chegada prevista** (pela última posição do técnico na jornada, senão pelo horário agendado). Dá para ajustar antes de copiar ou abrir direto no WhatsApp. A gestão edita os modelos e cria novos em **Textos do WhatsApp**, com as variáveis entre chaves (`{tecnico}`, `{local}`, `{chegada_prevista}`...). Também em Atividades do dia, pelo ícone ao lado da OS.
- **Coluna "Editar" em todas as listas:** em Chamados e em Atividades do dia, a última coluna fica presa à direita (aparece mesmo com a tabela rolando para o lado) com o botão de editar a OS ali mesmo; na Minha fila o mesmo botão fica no canto direito de cada OS. Em Atividades do dia, ao lado dele, o atalho dos textos do WhatsApp.
- **Prazos de campo (4h + 4h):** como a Maxx Field promete ao cliente: o técnico chega em até 4h nas capitais (prazo do interior configurável) e cada chamado inclui até 4h de técnico na loja, contadas da chegada. A OS mostra "chegar até 14:35 · faltam 52 min" e, depois do check-in, a barra do tempo na loja com aviso perto do fim. Aparece em Chamados, Minha fila, Atividades do dia e na OS; chegada atrasada ou em risco e tempo estourado viram alerta na fila. Regras em Configurações → Regras do atendimento em campo.
- **Horário é da central:** o técnico nunca mexe no horário. No app ele só sai, inicia o atendimento e conclui; o tempo dele corre sozinho do início à conclusão. Agendar, reagendar, pausar e apontar horas é só com analistas e gestores. (A autorização do cliente antes da visita foi retirada: a central combina a visita e o técnico não espera registro nenhum.) Quando o técnico esquece de iniciar ou concluir, o analista corrige os horários reais pela web ("Corrigir horários", com motivo no histórico).
- **Atividades do dia pela hora:** as OS aparecem pela hora de atuação, a manhã primeiro; quem começa mais cedo fica em cima.
- **Pedido de peça pelo técnico:** em campo, o técnico pede a peça pelo app (com foto, inclusive offline). O analista recebe na hora, monta o orçamento a partir do pedido com um clique e manda o link; quando o cliente aprova, o técnico é avisado de que pode instalar.
- **Reincidência e OS duplicada:** a OS mostra quantas outras OS a loja teve em 30 dias (com o histórico), e a abertura de uma nova avisa se já existe OS aberta na mesma loja, para não mandar dois técnicos para o mesmo problema.
- **Analista responsável e "Assumir OS":** cada OS tem o analista que a acompanha até o fim, separado de quem executa (o técnico). Só analistas e gestores assumem: **Assumir OS** (na lista de Chamados e na OS) leva a OS para a fila de quem assumiu, mesmo que estivesse com um colega, e o técnico continua o mesmo. Quem abre a OS assume por padrão; na abertura dá para deixar "Sem analista" (alguém assume depois) ou mandar para a fila de outro analista. "Atender eu mesmo (remoto)" é outra coisa: o analista vira o executor de uma OS sem técnico. Tudo fica no histórico.
- **Abertura da OS (Nova OS):** três passos numa tela só, só com o essencial. **Onde:** a busca da loja preenche o cliente e o endereço (com opção de atender em outro endereço) e avisa das OS abertas na mesma loja. Ao lado aparece o contexto: etiquetas do cliente (Contrato, Faturamento Filial...), avaliação, OS no total, em aberto e agendadas nos próximos 7 dias; da loja, contato, OS na loja e nos últimos 30 dias, última visita (quando e com quem) e o prazo de chegada (capital ou interior). **O quê:** o tipo de serviço traz a duração e sugere o título; categoria, tipo, urgência e prioridade, com os prazos de 1ª resposta e solução calculados na hora. **Quando e quem:** data (atalhos Hoje e Amanhã), hora e fim previsto; os **técnicos sugeridos para a loja** (distância, visitas a esta loja, OS no dia, livre ou ocupado no horário, skill) com um clique para **Responsável** ou **Junto**; os **outros técnicos da visita** e o projeto. Autorização do cliente e anexos ficam na tela da OS. Ctrl+Enter abre a OS de qualquer campo.
- **Outros técnicos da visita:** além do responsável, a OS pode levar até 6 técnicos. Eles veem a OS no app, recebem push, registram fotos, acompanhamentos e horas; iniciar, concluir e colher a assinatura ficam com o responsável. A visita aparece também no dia deles (Atividades do dia, marcada "vai junto"), na coluna deles do Calendário, como "+1" em Chamados e na Minha fila, e no relatório do cliente e no PDF ("com Fulano"). A agenda deles conta na checagem de conflito e nas sugestões; nos textos do WhatsApp, a variável {equipe} traz todos os nomes. A gestão inclui ou tira pela OS (cartão "Outros técnicos da visita").
- **Confirmações no padrão do sistema:** excluir anexo, remover custo ou formulário, cancelar orçamento, trocar ou desativar link e voltar os textos ao padrão pedem confirmação numa janela do próprio sistema (não a do navegador), dizendo o que acontece.
- **Minha fila:** tela inicial do analista com as OS dele organizadas pelo que pede ação: em campo agora, precisa de atenção (SLA violado ou em risco, sem técnico, técnico inativo que não entra mais no app, atrasada para começar, improdutiva para reagendar, justificativa de SLA pendente), agenda de hoje em linha do tempo, aguardando, sem agenda, próximos dias e concluídas hoje. Ao lado, as **filas da equipe** com abertas e alertas de cada analista; dá para abrir a fila de um colega.
- **Fila dos colegas:** em Chamados, o filtro "Fila de" mostra as OS de um analista (ou as sem analista), com quantas estão abertas, e o ícone de mão ao lado do analista puxa a OS para a sua fila.
- **Relatório para o cliente:** quando a OS é concluída, ela ganha um link público com o resumo do atendimento (solução, problema relatado, local, técnico, horários, linha do tempo, checklist com as fotos de antes e depois, evidências e assinatura). O cliente abre no navegador (inclusive no celular) e baixa o **PDF de verdade** (A4, com as fotos e a assinatura), gerado na hora; a OS também tem o botão "Baixar PDF". O link sai no texto de fechamento do WhatsApp, mostra quantas vezes o cliente abriu e pode ser trocado ou desativado.
- **Busca rápida (Ctrl+K):** acha OS pelo número ou título, clientes e telas de qualquer lugar.
- **Identidade visual:** base neutra (cinza no claro, grafite no escuro) com o azul e o degradê da marca como acento, tipografia Manrope, menu claro com destaque que desliza entre os itens, tela de login com o mapa de rotas animado, esqueletos de carregamento e transições curtas. Tudo respeita o "reduzir movimento" do sistema.
- **Login Microsoft (Entra ID)** para analistas e gestores, com locatário e domínio da empresa; pode tornar obrigatório (sem senha local) para a gestão.
- **Cadastros:** clientes (CPF/CNPJ validado, inclusive alfanumérico), locais (com coordenadas), ativos (impressora, desktop, switch, câmera, DVR/NVR…), usuários, grupos, categorias e SLA.
- **Tempo real:** toda mudança aparece na hora para quem pode ver a OS (web e apps).
- **Pronto para mobile:** sync offline idempotente, revogação de OS reatribuídas, registro de aparelhos para push. Ver [docs/MOBILE_SYNC.md](docs/MOBILE_SYNC.md).
- **Papéis:** administrador, supervisor, analista (gestão completa na web), técnico de campo (app) e solicitante.

## Rodar localmente (Docker)

Pré-requisito: Docker Desktop.

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

```bash
docker compose exec api python -m app.seed
```

- Web: http://localhost:3001
- API e documentação interativa: http://localhost:8000/docs
- PostgreSQL: `localhost:5433` (usuário/senha `chamados`)

O seed cria grupos, categorias (Impressoras, Computadores, Redes, CFTV, Telefonia, Software), clientes,
locais, ativos e 11 OS em vários status. Usuários de exemplo, todos com a senha de `SEED_PASSWORD`
no `.env`:

| Papel | E-mail |
|---|---|
| Administrador | `admin@exemplo.com.br` |
| Supervisor | `supervisor@exemplo.com.br` |
| Analista (web) | `bruno@exemplo.com.br` |
| Técnicos de campo (app) | `carlos@`, `rafael@`, `juliana@exemplo.com.br` |
| Solicitante | `solicitante@exemplo.com.br` |

As portas foram escolhidas para não colidir com o ambiente local do MaxxField (3000, 5432, 8080).

## Testes e qualidade

```bash
docker compose run --rm api sh -c "ruff format --check . && ruff check . && pytest -q"
```

```bash
docker compose run --rm api sh -c "alembic upgrade head && alembic check"
```

O frontend roda `npm run typecheck`, `npm run lint` e `npm run build` (o build da imagem `web` executa o último).

> Neste Docker Desktop, pastas do drive D: não podem ser montadas em containers. Por isso o código entra
> na imagem pelo build. Depois de alterar o backend, rode `docker compose build api` antes de testar.

## Banco de dados e migrations

As migrations ficam em `backend/alembic/versions` e a API aplica todas ao subir (`alembic upgrade head`).
Para criar uma nova depois de mudar um modelo:

```bash
docker compose run --name mig api alembic revision --autogenerate -m "descricao"
```

```bash
docker cp mig:/app/alembic/versions/. backend/alembic/versions && docker rm mig
```

Revise o arquivo gerado antes de commitar. Para apontar para outro PostgreSQL, troque `DATABASE_URL`
(formato `postgresql+asyncpg://usuario:senha@host:5432/banco`).

## Pré-visualização ao vivo (web e app)

Para ver as mudanças aparecerem enquanto o código é editado, deixe rodando num terminal:

```bash
powershell -ExecutionPolicy Bypass -File scripts/dev-preview.ps1
```

| O quê | Onde |
|---|---|
| Web (analistas e gestores) | http://localhost:3001: recarrega sozinho a cada alteração em `frontend/` |
| App dos técnicos no celular | **Expo Go** (Play Store ou App Store) → ler o QR code ou digitar `exp://<IP da máquina>:8081`. O celular precisa estar no mesmo Wi-Fi |
| App dos técnicos no navegador | http://localhost:8081 (sem celular) |

- O script troca o web de produção da porta 3001 por um servidor de desenvolvimento (`mc-web-dev`) e sobe o Expo (`mc-expo`).
- A cada 2 s ele copia para dentro dos containers os arquivos alterados, porque o Docker daqui não monta pastas do drive D:.
- Mudou `package.json`? O script reinstala as dependências e reinicia o container.
- A API continua vindo do `docker compose` (porta 8000).
- `-Stop` desliga a pré-visualização e volta o web de produção.

Se o celular não abrir o app: o Windows bloqueia conexões vindas de outros aparelhos quando o Wi-Fi está marcado como **rede pública**. Em *Configurações → Rede e Internet → Wi-Fi → (sua rede)*, marque **Rede privada**, ou libere o Docker Desktop no firewall.

## Sincronização com o GitHub

Repositório: https://github.com/RittonDev/Mark-1-field- (branch `main`, **público**).

Para manter a pasta sincronizada continuamente (commit e push automáticos de cada alteração, mais
pull do que chegar no GitHub), deixe rodando num terminal:

```bash
powershell -ExecutionPolicy Bypass -File scripts/sync-github.ps1
```

- Verifica a cada 20 s (`-IntervalSeconds 10` para mudar) e só commita quando as alterações ficam
  estáveis por um ciclo, para não pegar um arquivo no meio do salvamento.
- Recusa enviar `.env`, chaves (`.pem`, `.key`…) e arquivos acima de 50 MB. Como o repositório é
  público, segredos ficam só no `.env`, que está no `.gitignore`.
- Para no primeiro conflito com o GitHub, sem forçar nada: resolva com `git status` e rode de novo.
- `-Once` faz uma única rodada (útil para testar).

## Documentação

- [docs/API.md](docs/API.md): contrato da API e eventos WebSocket
- [docs/STATUS_E_SLA.md](docs/STATUS_E_SLA.md): fluxo de status, permissões, prioridade e SLA
- [docs/MOBILE_SYNC.md](docs/MOBILE_SYNC.md): como os apps iOS/Android sincronizam
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): camadas, decisões e modelo de dados

## Login Microsoft (Entra ID)

1. Em **entra.microsoft.com** › Identidade › Aplicativos › Registros de aplicativo › **Novo registro**:
   nome "Maxx Field", contas **somente deste diretório organizacional**, URI de redirecionamento
   **Web** = `ENTRA_REDIRECT_URI` (em desenvolvimento: `http://localhost:8000/api/v1/auth/microsoft/callback`).
2. Em **Certificados e segredos**, crie um segredo do cliente e copie o **valor**.
3. No `.env`: `ENTRA_TENANT_ID` (ID do diretório), `ENTRA_CLIENT_ID` (ID do aplicativo),
   `ENTRA_CLIENT_SECRET` (o valor) e `WEB_URL`. Reinicie a API: o botão **Entrar com Microsoft** aparece no login.
4. Cadastre em **Usuários** os analistas e gestores com o e-mail corporativo (só quem está cadastrado
   entra; o primeiro login vincula a conta Microsoft). Para criar automaticamente no primeiro login, use
   `ENTRA_AUTO_PROVISION_ROLE=analyst`.
5. Quando todos estiverem entrando pela Microsoft, ligue `ENTRA_ENFORCE_FOR_STAFF=true`: a gestão do
   domínio deixa de entrar com senha local. Mantenha uma conta admin fora do domínio para emergência.

A validação confere assinatura, emissor, audiência, **locatário (`tid`)**, nonce, PKCE e o domínio do e-mail.
O site recebe só um código de uso único (60 s) e troca pelos tokens, que nunca passam pela URL.

## Segurança

- **Login com limite de tentativas:** 5 senhas erradas no mesmo e-mail em 15 minutos bloqueiam aquele
  login por 15 minutos (HTTP 429, com o tempo de espera), mesmo com a senha certa; acertar antes zera a
  contagem. E-mails que não existem contam igual e respondem no mesmo tempo, para não revelar quem tem conta.
  Por IP o limite é 100 em 15 minutos (só segura ataque em massa). A contagem fica no Redis.
- **Em produção, atrás de proxy:** configure `FORWARDED_ALLOW_IPS` com o IP do proxy (Nginx, Caddy...), para a
  API enxergar o IP real de cada pessoa; sem isso, todos chegam com o IP do proxy.
- **Anexos:** foto abre na tela; SVG e demais arquivos baixam. Todo download sai com `nosniff` e CSP
  `sandbox`, então nem um HTML disfarçado de imagem roda código.
- **Cabeçalhos:** a API e o site mandam `X-Content-Type-Options`, `X-Frame-Options` (não abrem dentro de outro
  site) e `Referrer-Policy`; o site libera só a localização (check-in), nunca câmera ou microfone.
- **Logs sem tokens:** o WebSocket e os links de anexo levam o token na URL; o log da API grava `token=***`.

## Simular o rastreamento (desenvolvimento)

```bash
docker compose exec api python -m app.devtools.simulate_tracking --minutos 20
```

Abre a jornada dos técnicos do seed e envia posições pelo mesmo caminho do app: quem está "em
deslocamento" anda até o cliente, quem está "em atendimento" fica parado. Não roda em produção.

## Ainda não feito

- Rastreamento em segundo plano no app (exige build de desenvolvimento do Expo, não o Expo Go).
- Envio real de push: `LogPushProvider` só registra no log; falta ligar o Firebase Cloud Messaging.
- SLA em horário comercial e feriados (hoje 24x7), SLA por contrato e escalonamento automático.
- "Esqueci minha senha" por e-mail (hoje a gestão redefine a senha do técnico).
- Mapa base contratado para produção (`NEXT_PUBLIC_MAP_TILES_URL`; o padrão OpenStreetMap é para uso moderado).
- Armazenamento de anexos em S3/R2 (hoje em disco, no volume `media`).
- Abertura de OS por e-mail/WhatsApp, base de conhecimento, pesquisa de satisfação e relatórios exportáveis.

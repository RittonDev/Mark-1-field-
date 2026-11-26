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
**homologação**. A gestão cuida do cadastro e do acesso de cada técnico na ficha dele, em **Técnicos** (troca o e-mail,
manda o link para criar uma senha nova ou gera a senha provisória), e o técnico mantém o próprio cadastro no app
(**Configurações**) e, com o e-mail validado, recupera a senha pelo **Esqueci minha senha** (link por e-mail).

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
- **Dashboard:** backlog, SLA, conformidade em 30 dias, tempo médio de solução, carga por analista.
- **Locais como filiais** (como no Field Control): cada local tem código e CNPJ próprio, tela própria com busca e paginação, e histórico resumido (OS abertas, total, última OS). A OS aceita um **endereço do atendimento** separado do endereço do local.
- **Tipos de serviço com duração estimada × real** (o "Tipo de OS" do Field Control, inclusive por cliente). A real é medida pelo tempo em atendimento; a tela compara as duas e o catálogo sugere corrigir a estimativa pela mediana do que aconteceu (a estimativa aprende). Agendar só com o início usa a duração estimada.
- **Atividades do dia** (tela própria, como no Field Control): as visitas do dia agrupadas por técnico, com agendado × início real × término na mesma linha, atraso, check-in com GPS, estimada × real, situações (agendada, atrasada, em deslocamento, em atendimento, pendente, reagendada, concluída) e atualização em tempo real.
- **Motivo da violação de SLA** (como no Field Control): um motivo por relógio (resposta e solução), escolhido de um cadastro com a responsabilidade (interna, cliente, terceiro). É pedido ao resolver uma OS que furou o prazo, pode ser justificado depois (até com a OS fechada) e vira estatística no dashboard, com a lista das pendentes de justificativa.
- **Calendário** das OS por técnico (mês, semana e dia por técnico), com filtros de técnico, grupo, cliente, local e cidade. **Conflito de horário:** a API recusa (409) agendar ou atribuir uma OS a um técnico que já tem outra no mesmo horário; quem agenda vê as OS em choque (inclusive como aviso antes de salvar) e pode confirmar mesmo assim. O calendário marca em vermelho os conflitos que existirem.
- **Mapa ao vivo e rastreamento** (padrão Field Control): o app envia a posição do técnico **só durante a jornada** que ele inicia e encerra, e só depois do aceite do termo (LGPD). O mapa mostra cada técnico com o estado (em atendimento, em deslocamento, disponível, sem sinal, fora da jornada), bateria, velocidade, GPS simulado, a OS em campo com a linha até o destino e o trajeto do dia com os pontos de check-in. Fora da jornada a posição não aparece. Histórico apagado após `TRACKING_RETENTION_DAYS` (90).
- **Mapa: loja do cliente e casa do técnico.** Além do filtro de técnico, o mapa tem o filtro **Loja do cliente**: a loja aparece no mapa e a lista passa a ordenar os técnicos do mais perto para o mais longe (pela posição de agora, se recente; senão, pela casa), com "agora 12 km · casa 18 km" em cada um. Ao escolher um técnico, o mapa mostra a casa dele e as linhas até a loja, e o painel traz **Agora → loja**, **Casa → loja** e **Agora → casa**, cada um em linha reta, pelas ruas (estimativa) e em tempo de carro. Sem endereço de casa no cadastro, usa a cidade de casa ou a base (onde mais atende), marcado como aproximado; loja sem coordenada usa o centro da cidade. Só a gestão vê (`GET /tracking/distances`).
- **Homologação de técnicos:** o analista gera um link (uso único ou reutilizável, com validade) e envia por WhatsApp ou e-mail. O técnico preenche no celular a ficha em 5 etapas (seus dados, com CPF, RG, nascimento, telefone secundário e a foto por "Tirar foto" ou "Escolher da galeria"; o endereço em partes com a busca de CEP; a atuação, com áreas, aptidões em cartões, mini biografia e empresa; disponibilidade, transporte e veículo, com modelo e placa; acesso e privacidade) e cria o próprio acesso (com um e-mail que não seja da empresa), aceitando o aviso de privacidade; ao enviar, recebe por e-mail o link para validar o endereço. No app, o técnico relê o aviso no Perfil (Aviso de privacidade). A ficha chega em **Homologação** (com aviso em tempo real), com o e-mail validado ou pendente ("Reenviar validação") e as análises (quem aprovou, reprovou ou reabriu, e o motivo). **Aprovar é um passo só**: o técnico entra na base com tudo o que a ficha coletou (dados pessoais, endereço, empresa, veículo, áreas, a validação do e-mail, e a disponibilidade, o transporte e as aptidões no perfil técnico; o texto livre de ferramentas e certificações fica só na ficha) e recebe o e-mail de boas-vindas (sem senha na ficha, com o link para criar a dele; sem envio de e-mail, a central gera a senha provisória). A ficha reprovada pode ser **reaberta para análise**, com motivo, e é excluída 180 dias depois da última análise.
- **E-mails do cadastro do técnico:** só transacionais, de um remetente que não recebe resposta (a conversa continua pelo WhatsApp): a validação do e-mail (ao enviar a ficha, ao trocar o e-mail no app e quando a central troca o e-mail), as boas-vindas na aprovação (como entrar, o link do app, os primeiros passos e o Elo, sem números) e o link para criar uma senha nova ("Esqueci minha senha" no app, ou "Redefinir senha" na central; vale 2 horas e encerra os acessos abertos). Os links abrem as páginas **Validar e-mail** e **Definir nova senha** da web. Fila no banco, com novas tentativas e o registro do que saiu (a central vê os últimos na ficha do técnico). Sem SMTP configurado (`SMTP_HOST` e `MAIL_FROM`), o envio fica desligado: tudo funciona, os e-mails aparecem como "Não enviado" e a central segue com o WhatsApp e a senha provisória. Ver [docs/API.md](docs/API.md#cadastro-v2-2026-11-25).
- **Busca de CEP nos 6 formulários de endereço** (ficha pública, ficha do técnico, Clientes, Locais, Configurações › Empresa e o Endereço no app): a API consulta o ViaCEP (com a BrasilAPI de reserva) e guarda o resultado; a tela preenche logradouro, bairro, cidade e UF só nos campos livres, e o que a pessoa digitou fica, com "CEP de … · Usar este endereço" quando difere. Sem o serviço, os campos ficam livres e nada trava.
- **Fichas completas:** cliente (todos os contatos com nome e tipo, endereço da matriz, logo, etiquetas, avaliação, primeiro e último atendimento, lojas e OS recentes), loja (endereço, todos os contatos, quem já atendeu e quantas vezes, OS recentes) e técnico (endereço, jornada, serviços que faz e região de atuação), com o que veio do Field Control. As buscas aceitam palavras em qualquer ordem e as cidades ficam com uma grafia só.
- **Técnicos por estado e cidade e "mais próximos de uma loja":** filtro por UF e cidade pela região de atuação (calculada pelo histórico de atendimentos, ou pelo endereço). A busca por proximidade aceita a loja, a cidade ou as coordenadas / link do Google Maps e ordena pela distância real (lojas que ele já atendeu, endereço ou posição ao vivo), com os motivos e atalhos de WhatsApp e ligação. Coordenadas falsas do Field Control (como o "centro do Brasil") são descartadas e a loja usa o centro da cidade.
- **Técnicos favoritos por cidade (aba "Favoritos por cidade" em Técnicos):** em cada cidade, até 3 favoritos automáticos (quem mais atendeu nas lojas da cidade nos últimos 12 meses, com no mínimo 2 OS) e os que a central fixa à mão (com nota) ou tira da lista; "Desfazer" em todas as ações e exportação em CSV. Na OS, os favoritos da cidade da loja ganham estrela e prioridade nos técnicos sugeridos e vêm primeiro no Colaborador; os que vieram do Field Control sem acesso ao app aparecem marcados, com o atalho **Liberar acesso** (o link de senha por e-mail ou a senha provisória para mandar pelo WhatsApp). Inativo e Bloqueado ficam fora dos automáticos (o fixado pela central continua, com o selo).
- **Elo dos técnicos (a medalha):** cada técnico tem um elo, Bronze, Prata, Ouro ou Diamante, pela quantidade e pela qualidade dos atendimentos dos últimos 12 meses: atendimentos (como responsável ou junto, também os do Field Control), chegada no horário combinado, OS reaberta em até 30 dias e visita perdida por motivo do técnico (a central marca quais motivos de improdutiva são do técnico). Taxas só a partir de 5 casos, sobe na hora e só desce depois de 30 dias abaixo do critério. A central vê o elo na lista de Técnicos (coluna, filtro e ordenação), na ficha do técnico (o que falta para a próxima faixa e o que pesou, com **Desconsiderar** e motivo) e nas sugestões; o técnico vê o dele no app ("Meu elo"), sem ranking. O elo não muda a ordem das sugestões. No app, o elo aparece como a patente do técnico: uma medalha (Bronze, Prata, Ouro ou Diamante, com o emblema que cresce com a faixa e o nome sempre escrito junto, "OURO") no Perfil, no Meu elo e no chip do topo da tela inicial, e a subida de faixa comemora com a medalha. O Perfil mostra o total de atendimentos desde sempre e leva às **Estatísticas** (atendimentos, chegadas fora do horário, retornos e visitas perdidas mês a mês, 12 meses) e ao **Histórico de atendimentos** (todas as OS concluídas em que ele atuou, por mês, só com o recorte de campo). A central vê a mesma medalha nas listas e o gráfico "Atendimentos por mês" na seção Elo da ficha do técnico. Ver [docs/API.md](docs/API.md#elo-dos-técnicos-2026-11-18) e [estatísticas e histórico](docs/API.md#perfil-do-técnico-estatísticas-e-histórico-2026-11-19).
- **Base técnica (Técnicos):** cadastro direto com senha provisória, **importação da base por planilha** CSV/XLSX (com prévia linha a linha e arquivo com as senhas provisórias) e a lista com os filtros no endereço da página (busca, UF e cidade, grupo, acesso ao app, ferramenta, dia e turno, elo e ordem: recarregar e voltar não perdem nada), os selos "Inativo", "Bloqueado" e "Indisponível até …", o chip "Sem forma de recebimento" e o CSV. Cada técnico tem a **ficha em página própria** (`/tecnicos/{id}`; o nome e a linha são links: Ctrl/⌘+clique e o botão do meio abrem outra aba), com o menu nos mesmos grupos do app (**Dados pessoais e cadastrais**, **Dados financeiros e empresariais** e **Perfil profissional**) mais o grupo **Gestão** (Situação, Equipe e jornada, Favoritos, Elo e Histórico). Cada seção tem o próprio Salvar, e sair com alteração não salva pergunta antes. Em **Credenciais** ficam o acesso ao app (liberar ou cortar), o e-mail de login validado ou pendente ("Reenviar validação"), o **Redefinir senha** (o link por e-mail, que vale 2 horas, ou a senha provisória, que encerra as sessões abertas) e os últimos e-mails enviados. Na ficha, a central muda o nome, a foto, o contato (trocar o e-mail troca o login na hora e manda a validação para o novo), o grupo e a jornada, e também o CPF, o RG, o nascimento, o endereço e a empresa; o perfil profissional, o veículo e as formas de recebimento só o técnico muda (destas, a central só remove).
- **Situação do técnico na operação (Ativo, Inativo, Bloqueado):** só a central vê e muda (Técnicos em Editar), sempre com o motivo, quem e quando, no histórico. É separada do **acesso ao app** (Liberado ou Sem acesso): Inativo e Bloqueado continuam entrando no app (histórico, faturamento e notas), a não ser que a central corte o acesso junto (o Bloquear já sugere); reativar não devolve o acesso. Só quem está Ativo e com acesso recebe OS: sai das sugestões e das ofertas (as em aberto fecham), aparece travado no Colaborador, com o motivo, e a OS que ele já tem continua com ele. O técnico nunca vê a situação.
- **Importação de locais** por planilha CSV/XLSX (CSV do Excel brasileiro com `;` e acentos): cliente por CNPJ ou nome (criado se não existir), local por código, CNPJ ou nome (atualiza o que existe), coordenadas com vírgula, prévia antes de gravar.
- **Formulários (checklists) na OS:** a gestão monta modelos (texto, sim/não, escolha, número, data, confirmação e **fotos com mínimo/máximo**, como "foto do rack antes / depois"). Os formulários **entram sozinhos** pelo tipo de OS e pela categoria (ligar à categoria de cima vale para as subcategorias), como obrigatórios ou opcionais pelo padrão do modelo, e a pergunta pode vir **respondida pela OS** ("Preencher com": loja, código da loja, cliente, endereço, cidade, nº da OS, técnico, tipo de OS ou data da visita). Na Nova OS, os ligados já vêm marcados: o que o analista desmarca fica de fora (e não volta sozinho), e os ligados que a tela não conhecia entram sozinhos; ele também põe outros e decide se cada um é obrigatório. Antes da visita, trocar o tipo ou a categoria acerta os formulários (sai só o que entrou sozinho e ninguém começou), e salvar o modelo com "Levar também às OS que ainda não começaram" leva a mudança a elas. O técnico preenche no app (também offline); a OS só é concluída, e a **assinatura do responsável no local** só é colhida, com os obrigatórios concluídos. Depois da assinatura, o técnico não altera mais o formulário.
- **Custos extras na OS** (material, km rodado com valor do km configurável, pedágio, estacionamento...): só analistas e gestores lançam e alteram; o técnico só vê; o cliente nunca vê. Tela de reembolso por técnico e mês, com "marcar como reembolsado" e CSV.
- **Visita improdutiva:** o técnico foi e não atendeu; escolhe o motivo (catálogo com responsabilidade cliente/interna/terceiro) e a OS volta para reagendar, contada nos relatórios.
- **Orçamentos:** montados na OS com itens de um catálogo de preços, cada item como produto, serviço ou despesa (com a medida: un, m, rolo, h). O link para o cliente fica sempre disponível na OS para copiar ou mandar por WhatsApp e e-mail (e dá para gerar um novo, que invalida o anterior). O cliente vê uma página no padrão de mercado: dados da empresa, número da OS e do orçamento, cliente e endereço, itens, resumo por produtos, serviços e despesas, desconto e total. Ele aprova com **assinatura desenhada, nome e matrícula (opcional)**, deixa um comentário para a empresa, ou recusa com o motivo, e baixa em PDF. A gestão recebe na hora. Os dados da empresa ficam em Configurações. Na tela **Orçamentos**, cada linha tem **Ver** e **Editar** (enquanto o cliente não respondeu): a visualização mostra OS, cliente, criação e validade, a situação em destaque (quem aprovou, com a assinatura; o motivo da recusa; desde quando espera), os itens por tipo, os totais e as condições, e dali dá para editar, enviar ao cliente ou pegar o link, sem abrir a OS. A fila **Para cobrar** junta o que pede contato com o cliente (não abriu, sem resposta há 48 h, vence hoje ou amanhã, em revisão parada, venceu há até 7 dias); o **Cobrar** abre o lembrete pronto para o WhatsApp e fica no histórico da OS. O link conta quantas vezes o cliente abriu (a equipe e a prévia "Ver como o cliente" não contam). O orçamento novo nasce com o nome da loja, o catálogo vem ordenado pelo uso e o editor oferece o **último preço aprovado do cliente** para o item. Aprovados de OS cancelada não entram nos totais, e o código antigo do Field Control aparece no orçamento e entra na busca.
- **Projetos:** OS marcadas como de projeto, com valor fechado, condições, equipe e responsável; a tela do projeto mostra andamento, custos, orçamentos aprovados e margem.
- **Assistência externa** (no lugar de Ativos): impressoras retiradas do cliente para conserto em terceiros, com cada etapa (retirado, recebido, enviado, orçamento da assistência, em reparo, pronto, de volta, entregue), fotos, protocolo, previsão de retorno e alerta de atraso.
- **Relatórios:** fechamento diário (o dia fecha à meia-noite; o painel abre no dia anterior) com chamados que entraram, resolvidos, cancelados, improdutivos, que ficaram agendados e o cliente destaque; e o mensal com a série por dia, rankings e CSV.
- **Sugestão de técnicos por localização:** na OS, os 5 técnicos mais indicados (mora na cidade, atende a região, distância agora pelo rastreamento, livre no horário, área de atuação, carga), com o motivo de cada sugestão e atribuição em um clique. Só entram técnicos com acesso ao app, Ativos na operação e sem período de indisponibilidade nos dias da visita. A disponibilidade que o técnico informou no app é um sinal pequeno: com a visita dentro dela, poucos pontos a mais; fora dela, poucos pontos a menos e o aviso "Fora da disponibilidade (sáb · tarde)". Sem disponibilidade informada (ou OS sem horário), nada muda, e ninguém sai da lista por isso.
- **Comunicação pelo WhatsApp:** botão na OS monta a mensagem (cliente, endereço com mapa, agenda, técnico, escopo, formulário obrigatório) para o grupo dos técnicos.
- **Textos do WhatsApp (macros):** cada OS tem a seção de textos com um botão por aviso (deslocamento, chegada, atraso, agendamento, fechamento, visita improdutiva) que copia a mensagem já preenchida com os dados da OS: técnico, loja, cidade, endereço, contato, horário agendado e **chegada prevista** (pela última posição do técnico na jornada, senão pelo horário agendado). Dá para ajustar antes de copiar ou abrir direto no WhatsApp. A gestão edita os modelos e cria novos em **Textos do WhatsApp**, com as variáveis entre chaves (`{tecnico}`, `{local}`, `{chegada_prevista}`...). Também em Atividades do dia, pelo ícone ao lado da OS.
- **Coluna "Editar" em todas as listas:** em Chamados e em Atividades do dia, a última coluna fica presa à direita (aparece mesmo com a tabela rolando para o lado) com o botão de editar a OS ali mesmo; na Minha fila o mesmo botão fica no canto direito de cada OS. Em Atividades do dia, ao lado dele, o atalho dos textos do WhatsApp.
- **Prazos de campo (4h + 4h):** como a Maxx Field promete ao cliente: o técnico chega em até 4h nas capitais (prazo do interior configurável) e cada chamado inclui até 4h de técnico na loja, contadas da chegada. A OS mostra "chegar até 14:35 · faltam 52 min" e, depois do check-in, a barra do tempo na loja com aviso perto do fim. Aparece em Chamados, Minha fila, Atividades do dia e na OS; chegada atrasada ou em risco e tempo estourado viram alerta na fila. Regras em Configurações → Regras do atendimento em campo.
- **Horário é da central:** o técnico nunca mexe no horário. No app ele só sai, inicia o atendimento e conclui; o tempo dele corre sozinho do início à conclusão. Agendar, reagendar, pausar e apontar horas é só com analistas e gestores. (A autorização do cliente antes da visita foi retirada: a central combina a visita e o técnico não espera registro nenhum.) Quando o técnico esquece de iniciar ou concluir, o analista corrige os horários reais pela web ("Corrigir horários", com motivo no histórico).
- **Atividades do dia no formato do Field Control:** um cartão por OS (nº e cliente com a situação; tipo de serviço, loja e endereço; a descrição; etiquetas, técnico e o horário realizado ou agendado), pela hora de atuação, a manhã primeiro.
- **OS no formato "Editar atividade":** a OS abre (na página ou por cima das listas) com as abas Geral, Prazos, Localização, Vínculos, Orçamentos, Peças e custos, Formulários, Anexos, Acompanhamentos e Histórico, e tudo é editável pela central a qualquer momento, inclusive com a OS fechada (cliente, loja, agenda, técnico, início e conclusão, descrição da conclusão, etiquetas). A central também reabre uma OS fechada ou cancelada, com motivo, e ela volta ao fluxo. Na aba Geral aparecem os 5 técnicos mais indicados para a loja.
- **Portal do cliente ("Solicitações"):** o usuário do cliente (ligado à empresa) abre a solicitação direto, sem mandar mensagem: escolhe a loja, diz o que aconteceu e a urgência, e acompanha a visita, o técnico e o relatório final. Vê todas as solicitações da empresa e nada interno. Instala como app no Windows pelo Edge/Chrome ("Instalar no computador").
- **Solicitações na central:** menu com contador do que chegou pelo portal. A central puxa para a fila, abre a OS e escolhe o técnico.
- **Convite ao técnico pelo WhatsApp:** nos técnicos mais indicados, "Convidar" abre o WhatsApp com o resumo da OS (serviço, bairro e cidade, data e valor); "Copiar convite para o grupo" serve para o grupo de técnicos. Quem topar entra como responsável.
- **Oferta de OS com preço:** na OS sem técnico, a central (com Pagamentos em Editar) manda a OS com o valor para 1 a 10 técnicos (com acesso ao app, Ativos e disponíveis no dia da visita), com prazo opcional e recado; quem aceita primeiro no app fica com a OS e com aquele valor, sem contraproposta e sem chat (a dúvida vai pelo WhatsApp). No app, a oferta mostra só o recorte do convite (serviço e escopo, bairro e cidade, duração estimada, data por extenso e hora, e o valor; cliente, loja e endereço só depois do aceite), o botão que abre a área no mapa, "Serviços 1/1 lido" (abrir o escopo libera o "Aceitar por R$ X") e o link "Dúvida no escopo? Fale com a central no WhatsApp". A central vê na OS "Aceitou às 14:50 · escopo lido às 14:45".
- **Valor por chamado:** os técnicos são parceiros e recebem por OS. Valor padrão no tipo de serviço, ajuste na OS (aba Geral, ao lado do colaborador), fechamento em "Pagamentos" (a pagar, previsto, pago, extrato para o WhatsApp, com a forma de recebimento preferencial de cada técnico e as notas fiscais dele) e a aba **Faturamento** no app do técnico: no topo, o total pago e o que falta receber (com o previsto das OS em andamento), o olho para ocultar os valores (vale para o aparelho) e onde ele recebe ("Recebe no PIX" ou "Recebe na conta", mascarado, ou "Cadastrar chave ou conta", que abrem Configurações › Formas de recebimento); embaixo, um cartão por mês de conclusão (12 meses) com o valor total, quantas OS e a situação calculada no servidor (Em andamento, Sem nota, Nota em conferência, Nota recusada, A pagar, Pago em parte, Pago sem nota, Pago). Tocar no mês abre as OS, os reembolsos e as notas fiscais daquele mês. O mês sem valores só ganha cartão quando tem nota daquela competência (uma nota pode cobrir OS de meses anteriores), e o **Outro mês** abre qualquer mês, de janeiro de 2000 ao atual, também os sem cartão. A nota nunca trava o pagamento ("Sem nota" é só informativo). Os valores por OS existem desde 13/11/2026: os meses de antes ficam vazios.
- **Formas de recebimento do técnico:** várias chaves PIX e contas bancárias (até 10), com **uma preferencial**, para onde a central paga. Só o técnico cadastra e muda, no app (Configurações › Formas de recebimento), sempre com a senha atual (com a senha provisória, fica fechado até ele criar a dele). A central vê só com Pagamentos: em **Pagamentos**, a preferencial de cada técnico (a chave ou a conta inteira, com "Copiar PIX" ou "Copiar dados"), o selo "Nova" por 7 dias quando o destino do pagamento muda, o aviso de titular diferente do técnico e da empresa dele e o "Pedir no WhatsApp" de quem não tem nenhuma; na ficha do técnico, a lista inteira, com **Remover** (Pagamentos em Editar). A troca pelo app vira aviso em vermelho na central ("Confirme com ele no grupo antes do próximo pagamento."). O extrato do WhatsApp e o registro do pagamento levam a forma mascarada. A chave PIX que cada técnico tinha virou a primeira forma, preferencial.
- **App do técnico:** quatro abas, **Hoje**, **Agenda**, **Faturamento** e **Perfil** (as OS concluídas saíram da barra e estão no Histórico de atendimentos). O Perfil traz a foto, o nome, o total de atendimentos e a medalha do elo, e leva a Configurações, Histórico de atendimentos, Estatísticas, Meu elo, Sincronização (sincronizar agora, itens para enviar, ações recusadas pela central, rastreamento da jornada, notificações e aparelho), Aviso de privacidade, Termo de uso da localização e Sair. Ver [mobile/README.md](mobile/README.md).
- **Configurações (app do técnico):** nos mesmos grupos e com os mesmos nomes da ficha na central. **Dados pessoais e cadastrais**: a foto; os dados pessoais (nome; o CPF, informado uma vez, com "Confira o CPF" antes de gravar, e depois só a central corrige; o RG com órgão emissor e UF; o nascimento, de 18 a 90 anos); o endereço em partes, com a busca de CEP, a cidade/UF e a região que atende; o contato (celular, telefone secundário e o e-mail de login: o e-mail novo fica pendente até o técnico abrir o link de validação, e só então vira o login; "Enviar link", "Reenviar link" e "Cancelar troca"); a senha (com "Esqueci a senha atual"); e a mini biografia (até 500 caracteres). **Dados financeiros e empresariais**: os dados da empresa (CNPJ, razão social e nome fantasia) e as **formas de recebimento**. **Perfil profissional**, sem senha: dias e horários (7 dias × 4 turnos: manhã 06h–12h, tarde 12h–18h, noite 18h–24h e madrugada 00h–06h, e os **períodos de indisponibilidade**, de/até, sem motivo, até 10 e até 365 dias à frente: no período, ele sai das sugestões e das ofertas), transporte (carro, moto, bicicleta, transporte público, carro de aplicativo, a pé, ou **Nenhum**), CNH e o veículo (modelo e placa), formação (curso, nível, instituição, início e fim), aptidões com nível e "desde" e ferramental, marcado numa lista que a central mantém em **Configurações › Técnicos** (incluir, renomear e desativar, sem nome repetido nem com outro acento ou maiúscula, também quando duas pessoas cadastram juntas; começa com 20 ferramentas de TI de campo). E-mail, dados da empresa e formas de recebimento pedem a senha atual (com a senha provisória, ficam fechados até ele criar a dele). Turnos, transporte e ferramental salvam ao tocar; tudo pede internet. A central vê tudo na ficha do técnico em Técnicos, com a data de cada parte do perfil profissional ("Informado pelo técnico em …" ou "Da ficha da homologação, …"), filtra a lista por ferramenta e por dia e turno disponível e leva tudo no CSV (o Exportar espera o catálogo do ferramental carregar); o perfil profissional, o veículo e as formas de recebimento só o técnico muda. A central é avisada na hora quando o técnico muda pelo app as formas de recebimento, o e-mail, o CNPJ, o nome ou o celular (o resto só atualiza as telas, sem aviso no sino), e toda mudança, do app, da central, da aprovação da ficha ou do link do e-mail, fica no **histórico do cadastro** ("Ferramental: incluiu Escada, Multímetro"; "Motivo: …" na situação; o "Ver mais" busca as páginas mais antigas, até a primeira mudança). No grupo App ficam Aparência, Notificações e Sincronização.
- **Notas fiscais do técnico:** envio opcional pelo app, na aba Faturamento, dentro do mês (PDF, XML ou foto, com as OS que a nota cobre; enviada noutra competência, o app vai para o mês dela, onde a nota aparece), e conferência na aba **Notas fiscais** de Pagamentos (conferida, ou recusada com o motivo, que o "Avisar no WhatsApp" leva ao técnico com "Envie a nota corrigida pelo app, em Faturamento."). A nota nunca trava o pagamento.
- **Pedido de peça pelo técnico:** em campo, o técnico pede a peça pelo app (com foto, inclusive offline). O analista recebe na hora, monta o orçamento a partir do pedido com um clique e manda o link; quando o cliente aprova, o técnico é avisado de que pode instalar.
- **Reincidência e OS duplicada:** a OS mostra quantas outras OS a loja teve em 30 dias (com o histórico), e a abertura de uma nova avisa se já existe OS aberta na mesma loja, para não mandar dois técnicos para o mesmo problema.
- **Analista responsável e "Assumir OS":** cada OS tem o analista que a acompanha até o fim, separado de quem executa (o técnico). Só analistas e gestores assumem: **Assumir OS** (na lista de Chamados e na OS) leva a OS para a fila de quem assumiu, mesmo que estivesse com um colega, e o técnico continua o mesmo. Quem abre a OS assume por padrão; na abertura dá para deixar "Sem analista" (alguém assume depois) ou mandar para a fila de outro analista. "Atender eu mesmo (remoto)" é outra coisa: o analista vira o executor de uma OS sem técnico. Tudo fica no histórico.
- **Abertura da OS (Nova OS), na ordem do Field Control:** Cliente → Localização (só as lojas do cliente escolhido: sem cliente o campo fica travado, e a busca nunca mostra lojas de outro cliente) → Tipo de OS → Escopo → Data e hora do agendamento → Colaborador → Etiquetas (já vêm com as da regra: "Pendente Envio PGTO" + "Ticket Avulso", ou "Projeto" na OS de projeto) → Criar (Ctrl+Enter). Os passos ficam em duas colunas quando a tela é larga, e a lateral mostra os **5 técnicos sugeridos** (com "Responsável", "Junto" e o "Convidar" pelo WhatsApp) e o histórico do cliente e da loja. Sem textos de exemplo nem explicações nos campos. O resto (título automático, duração, analista, projeto, prioridade, categoria, recado para o técnico, endereço, outros técnicos, pedido do cliente e formulários) fica em "Mais detalhes", também em duas colunas. Continua o colar da mensagem do WhatsApp/e-mail, o aviso de OS aberta na mesma loja e o rascunho. Depois de criar: "Copiar texto: Atividade confirmada". A edição e a visualização da OS (aba Geral) seguem a mesma ordem.
- **Lista de Chamados como a lista de atividades do Field Control:** colunas Identificador (o número), Etiquetas, Data do agendamento, Cliente, Localização e Editar; filtros Situação, Cliente, Identificador, Localização, Criação e "Mais filtros" (técnico que atuou, analista, tipo de OS, etiquetas, prioridade, projeto, período do agendamento); Exportar (CSV do filtro ou das selecionadas), Colunas (escolher e lembrar), Atualizar; seleção com etiquetas em lote; 25/50/100 por página. **OS antigas:** o filtro "técnico que atuou" acha a OS pelo responsável atual, por quem foi junto e por quem já foi o responsável antes de uma troca, inclusive no histórico importado do Field Control.
- **Textos para o grupo (WhatsApp) com um clique:** "Atividade confirmada", "Técnico em deslocamento", "Técnico chegou", "Atraso na chegada", "Atividade encerrada" (com o link do relatório) e "Visita improdutiva"; o que combina com o momento da OS vem primeiro ("Agora"). No painel da OS, na lista, em Atividades do dia e na Minha fila, e no aviso em tempo real quando o técnico muda o status. Frase sem o dado (sem técnico, sem previsão) sai do texto padrão; link do relatório desativado pela gestão não é recriado pelo texto.
- **Etiquetas automáticas (Configurações):** etiquetas de toda OS nova, da OS de projeto, ao lançar custo extra ("Custo Extra") e as que saem ao marcar o técnico como pago ("Pendente Envio PGTO"). Editar uma OS não apaga etiqueta que entrou por regra ou em lote enquanto o editor estava aberto.
- **Início (gestão):** tela de abertura de admin e supervisor, com fundo animado bem apagado ("galáxia neural" em canvas; pausa no botão "Animação", com a aba oculta, com painel aberto e após 3 min parado, e fica estático com "reduzir movimento"). No topo, o número de **OS que pedem ação agora** (cada OS conta uma vez) com fichas por motivo; depois a busca inteligente e 5 sinais vitais: **Hoje** (visitas concluídas, em campo, sem início e a seguir; amanhã), **Fila em aberto** (idade, mediana e saldo de 30 dias), **Atendimento ao cliente** (chegada no horário, prazo de solução com meta de 90%, loja que chamou de novo, improdutivas) **Orçamentos** (aguardando assinatura, sem link, vencendo, para cobrar, vencidos em 90 dias, rascunhos, aprovados no mês e a taxa de aprovação) e **Financeiro** (a pagar aos técnicos e custos). Os **pontos de atenção** se dividem em "Agora" e "Rotina" (abertas nos últimos 30 dias) e o resíduo antigo fica na "Fila antiga"; na lateral, sugestões, tendência de 8 semanas, clientes e equipe de campo. Todo número com base pequena mostra a base ("56 de 68") e cada "Ver todas (N)" abre a lista com exatamente N OS.
- **Mia, a busca com IA (Início e Ctrl+K):** o botão do topo ("Diga à Mia o que procura"), o Ctrl+K e a caixa da Início são a Mia. Ela entende frases em português ("atrasadas em santos", "16976", "técnico joão novembro", "agendadas amanhã", "pendente pgto semana passada", CNPJ; começar com "Mia," ou "Mia:" também vale, e "mia.com.br" ou "MIA.01" continuam sendo o que se procura) e responde mostrando o que entendeu ("Entendi: SLA estourado · Santos · 12 OS"), o que procurou como texto e, quando o texto que sobrou zera a busca, a opção "Buscar sem …". Traz OS, clientes, lojas, técnicos, telas e ações, e "Ver as N OS na lista". Sem internet, a Mia avisa ("Sem internet: a Mia busca quando a conexão voltar.") e busca quando a conexão voltar; o Enter não fica esperando. A interpretação é por regras, no próprio servidor, sem serviço externo de IA: a Mia não conversa nem responde perguntas abertas, só transforma o pedido em filtros.
- **Outros técnicos da visita:** além do responsável, a OS pode levar até 6 técnicos. Eles veem a OS no app, recebem push, registram fotos, acompanhamentos e horas; iniciar, concluir e colher a assinatura ficam com o responsável. A visita aparece também no dia deles (Atividades do dia, marcada "vai junto"), na coluna deles do Calendário, como "+1" em Chamados e na Minha fila, e no relatório do cliente e no PDF ("com Fulano"). A agenda deles conta na checagem de conflito e nas sugestões; nos textos do WhatsApp, a variável {equipe} traz todos os nomes. A gestão inclui ou tira pela OS (cartão "Outros técnicos da visita").
- **Confirmações no padrão do sistema:** excluir anexo, remover custo ou formulário, cancelar orçamento, trocar ou desativar link e voltar os textos ao padrão pedem confirmação numa janela do próprio sistema (não a do navegador), dizendo o que acontece.
- **Minha fila:** tela inicial do analista com as OS dele organizadas pelo que pede ação: precisa de atenção (SLA violado ou em risco, sem técnico, técnico sem acesso ao app, com "Liberar acesso" para quem edita Técnicos, atrasada há mais de 30 min, parada em campo há mais de 12 h, improdutiva para reagendar, justificativa de SLA pendente), em campo agora, agenda de hoje em linha do tempo, aguardando, sem agenda, próximos dias e concluídas hoje. Os números do topo contam as OS de que ele é o responsável, sem limite, e batem com a linha dele nas **filas da equipe** (ao lado, com abertas e alertas de cada analista e a soma da equipe); as que ele só executa aparecem à parte ("+N que você executa"). Dá para abrir a fila de um colega.
- **Fila dos colegas:** em Chamados, o filtro "Fila de" mostra as OS de um analista (ou as sem analista), com quantas estão abertas, e o ícone de mão ao lado do analista puxa a OS para a sua fila.
- **Relatório para o cliente (toda OS):** como no Field Control, toda OS nasce com um link público de relatório. Antes de concluir, ele mostra o andamento (agendada, técnico a caminho, em atendimento); concluída, o resumo do atendimento (solução, problema relatado, local, técnico, horários, linha do tempo, checklist com as fotos de antes e depois, evidências e assinatura). O cliente abre no navegador (inclusive no celular) e baixa o **PDF de verdade** (A4, com as fotos e a assinatura), gerado na hora. Na OS, o botão **Link do relatório da atividade** compartilha por e-mail ou WhatsApp, copia o link, abre o relatório e baixa o PDF. O link sai no texto de fechamento do WhatsApp, mostra quantas vezes o cliente abriu e pode ser trocado ou desativado.
- **OS no painel lateral:** como no Field Control, clicar numa OS nas listas (Chamados, Minha fila, Calendário, Mapa, Atividades do dia, Solicitações, Pagamentos, fichas de cliente e de loja, Custos, Orçamentos e Projetos) abre a OS num painel à direita, sem tirar a lista da tela. Esc ou um clique fora fecha; Ctrl+clique abre a página da OS em outra aba, e o painel tem "Abrir em página". A OS aberta fica na URL (`?os=<id>`): o Voltar do navegador (e o gesto do celular) fecha o painel e fica na lista, recarregar mantém a OS aberta e o link pode ir para um colega. O painel não fecha sozinho quando a lista atrás muda (OS que muda de seção ou de dia), e ao fechar a lista busca de novo o que pode ter mudado. Teclado: o Tab fica dentro do painel, o Esc fecha só a camada de cima (menu, diálogo, foto) e, ao fechar, o foco volta para onde estava.
- **Mia em qualquer tela (Ctrl+K):** a mesma busca da Início, por cima da tela aberta.
- **Identidade visual:** base neutra (cinza no claro, grafite no escuro) com o azul e o degradê da marca como acento, tipografia Manrope, menu lateral em cinza médio com destaque que desliza entre os itens, títulos e subtítulos em negrito com o traço azul-ciano da logo (título da página, de cartão e de bloco), cinzas de texto com contraste AA (4,5:1 ou mais) até na letra pequena, botão principal e cabeçalho da OS com contraste AA também no escuro, tela de login com o mapa de rotas animado, esqueletos de carregamento e transições curtas. Cor forte só onde há problema (atraso, SLA, erro). Brilhos e o degradê fino da marca só na Mia (a busca com IA); o resto segue sem cara de IA. Tudo respeita o "reduzir movimento" do sistema.
- **Login Microsoft (Entra ID)** para analistas e gestores, com locatário e domínio da empresa; pode tornar obrigatório (sem senha local) para a gestão.
- **Cadastros:** clientes (CPF/CNPJ validado, inclusive alfanumérico), locais (com coordenadas), ativos (impressora, desktop, switch, câmera, DVR/NVR…), usuários, grupos, categorias e SLA.
- **Tempo real:** toda mudança aparece na hora para quem pode ver a OS (web e apps).
- **Pronto para mobile:** sync offline idempotente, revogação de OS reatribuídas, registro de aparelhos para push. Ver [docs/MOBILE_SYNC.md](docs/MOBILE_SYNC.md).
- **Lembretes e avisos no celular do técnico:** o app lembra cada visita **1 dia, 1h40 e 10 min antes** do horário agendado (responsável e quem vai junto). Os lembretes são locais: funcionam sem internet e com o app fechado, mas só depois que o app sincronizou a OS, e saem sozinhos quando a OS é reagendada, cancelada ou o técnico já saiu para o local. Com o app na tela, OS nova, oferta, reagendamento, cancelamento e decisão de peça aparecem na hora. Com o app fora da tela: **no Expo Go, OS nova e oferta só aparecem com o app aberto**; num app instalado (development build), viram notificação do celular pela tarefa periódica (a cada 15 min ou mais) e, com a jornada aberta, a cada ~3 min. O aviso na hora, com o app fechado, precisa do push real (FCM), ainda desligado. Tocar abre a OS ou a oferta. O técnico desliga os lembretes em Perfil › Configurações › Notificações (ou em Perfil › Sincronização). A central (web) não muda.
- **Papéis:** administrador, supervisor, analista (gestão completa na web), técnico de campo (app) e solicitante.

### Papéis, perfis de acesso e filas

O papel continua decidindo o canal (web ou app), quem cadastra quem e as regras duras (o SLA é só do
administrador). Por cima dele, supervisores e analistas têm um **perfil de acesso** (Configuração >
Usuários > Perfis de acesso): para cada tela do menu (Operação, Comercial, Base, Análise e Configuração)
o nível Sem acesso, Visualizar ou Editar, e a **visibilidade de filas** ("Todas as filas da equipe" ou
"Somente a própria fila", com ou sem as OS sem analista). Cada pessoa pode ter ajustes por tela por cima
do perfil. O administrador tem acesso total sempre; técnico e cliente ficam fora da matriz. Os perfis
padrão (Supervisor e Analista) reproduzem o acesso de antes, e a migração coloca cada supervisor e
analista no perfil do papel. A regra vale na API: tela fora do perfil responde 403 `MODULE_FORBIDDEN` e
OS de outra fila, 403 `QUEUE_FORBIDDEN`, e "Somente a própria fila" vale em listas, buscas, contadores,
Início, agenda, mapa, comercial, relatórios, exportação e tempo real. Detalhes em
[docs/API.md](docs/API.md#acesso-perfis-por-tela-e-visibilidade-de-filas).

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

Os e-mails do cadastro dos técnicos (validação, boas-vindas e nova senha) ficam desligados enquanto `SMTP_HOST` e
`MAIL_FROM` estiverem vazios no `.env`: tudo funciona, os e-mails aparecem como "Não enviado" e o "Esqueci minha senha"
manda falar com a central. Para ver os e-mails no desenvolvimento, aponte o `SMTP_HOST` para um capturador local com
`SMTP_SECURITY=none` (recusado em produção). As variáveis estão no `.env.example` e em
[docs/API.md](docs/API.md#cadastro-v2-2026-11-25).

## Testes e qualidade

```bash
docker compose run --rm api sh -c "ruff format --check . && ruff check . && pytest -q"
```

```bash
docker compose run --rm api sh -c "alembic upgrade head && alembic check"
```

O frontend roda `npm run typecheck`, `npm run lint` e `npm run build` (o build da imagem `web` executa o último) e as
sondas puras `node --experimental-strip-types --test "tests/*.test.mjs"` (Node 22.6 ou mais, na pasta `frontend`).
Entre elas, `tests/mirror.test.mjs` confere que `src/lib/types.ts`, `constants.ts` e `workflow.ts` são iguais, byte a
byte, às cópias do app em `mobile/src/lib` (sem a pasta `mobile` ao lado, ela é pulada: rode o `cmp`). As
verificações do app estão em [mobile/README.md](mobile/README.md).

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
- **Erros do banco sem dados pessoais:** o erro do banco vai para o log com o SQL sem os valores (`hide_parameters`), e
  valor que o banco recusa (texto maior que a coluna, caractere nulo) responde 422 "Algum valor está fora do tamanho ou
  do formato aceito. Confira os campos." em qualquer rota, em vez de 500.
- **Texto livre sem invisíveis:** os nomes de aptidão, curso, instituição e ferramenta se gravam sem caracteres de
  controle nem invisíveis (espaço de largura zero, marcas de direção como U+202E), que fariam dois nomes iguais
  parecerem diferentes ou embaralhariam a ficha e o CSV; no app, a conferência é a mesma.
- **Conta invadida não desvia pagamento:** e-mail, dados da empresa e formas de recebimento do técnico pedem a senha
  atual no app (5 erros em 15 minutos bloqueiam, somando a troca de senha) e ficam fechados com a senha provisória; a
  central é avisada na hora e, se a troca vem até 72 h depois de a central redefinir a senha, o aviso diz quem
  redefiniu. O e-mail novo só vira o login depois de validado pelo link.
- **Links por e-mail:** validar o e-mail e criar uma senha nova usam links de uso único. O banco guarda só o hash
  (SHA-256) e o token vai no fragmento da URL (`#token=`), que não chega a servidor nem a log. A validação vale 72 h e
  a senha nova 2 h (a primeira senha, pela boas-vindas, 72 h). O "Esqueci minha senha" responde igual exista ou não o
  e-mail e só manda o link ao técnico com acesso e o e-mail validado; os pedidos e as aberturas de link têm limite por
  IP e por e-mail. Trocar a senha, gerar a provisória ou cortar o acesso invalida os links de senha.
- **E-mails sem resposta e sem dados no log:** o remetente não recebe resposta (sem Reply-To, com `Auto-Submitted`), o
  log leva só o id e o modelo do e-mail, as credenciais do SMTP ficam só no `.env` e, em produção, a API não sobe com
  `SMTP_SECURITY=none`. O CEP buscado também não fica no log (nem nas URLs do ViaCEP e da BrasilAPI).

## Simular o rastreamento (desenvolvimento)

```bash
docker compose exec api python -m app.devtools.simulate_tracking --minutos 20
```

Abre a jornada dos técnicos do seed e envia posições pelo mesmo caminho do app: quem está "em
deslocamento" anda até o cliente, quem está "em atendimento" fica parado. Não roda em produção.

## Ainda não feito

- Rastreamento em segundo plano no app (exige build de desenvolvimento do Expo, não o Expo Go).
- Envio real de push: `LogPushProvider` só registra no log; falta ligar o Firebase Cloud Messaging (e gerar o app instalado). Até lá, no Expo Go, OS nova e oferta só aparecem com o app aberto.
- SLA em horário comercial e feriados (hoje 24x7), SLA por contrato e escalonamento automático.
- Envio de e-mail ligado em produção: falta o provedor SMTP e o remetente que não recebe resposta (com SPF e DKIM do
  domínio). Até lá, o envio fica desligado: o "Esqueci minha senha" manda falar com a central, e a central usa o
  WhatsApp e a senha provisória.
- Cadastro do técnico, Entrega 2: documentos e certificações (com validade), currículo, avaliações, anexos internos,
  catálogos de áreas de atuação e de aptidões, a central editando o perfil profissional e os filtros novos da lista.
  Entrega 3: Elo por pontos e Desempenho (as seções aparecem na ficha quando cada entrega subir).
- Mapa base contratado para produção (`NEXT_PUBLIC_MAP_TILES_URL`; o padrão OpenStreetMap é para uso moderado).
- Armazenamento de anexos em S3/R2 (hoje em disco, no volume `media`).
- Abertura de OS por e-mail/WhatsApp, base de conhecimento, pesquisa de satisfação e relatórios exportáveis.
- Ferramental exigido por tipo de serviço (a sugestão de técnicos ainda não olha o ferramental).
- Aviso ao técnico de nota fiscal conferida, recusada ou paga (hoje ele vê ao abrir o Faturamento).

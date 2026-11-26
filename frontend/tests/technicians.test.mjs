// Ficha do técnico e lista de Técnicos (lib/technicians.ts, com os períodos e o e-mail de lib/constants.ts): o link e a
// seção da ficha, o menu com os 4 grupos, os filtros da lista na URL, a ordem pela situação e os rótulos. Dados fictícios.
// Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CADASTRO_DELIVERY,
  isSendableEmail,
  periodShort,
  TECH_SECTION_GROUPS,
  unavailableBetween,
  unavailableOn,
} from "../src/lib/constants.ts";
import {
  EMAIL_STATUS_LABEL,
  EMAIL_TEMPLATE_LABEL,
  emailStatusLabel,
  FICHA_DEFAULT,
  GESTAO_GROUP,
  listCityOf,
  listQueryFrom,
  listQueryPatch,
  OPERATIONAL_STATUS_COLOR,
  operationalRank,
  REVIEW_ACTION_LABEL,
  sectionFromParam,
  technicianHref,
} from "../src/lib/technicians.ts";

const ID = "3f2c8a1e-5b7d-4c9a-8e6f-1a2b3c4d5e6f";
const unique = (list) => new Set(list).size === list.length;

/** Os 4 grupos do menu da ficha, como a central monta: os 3 do cadastro e a Gestão. */
const GROUPS = [...TECH_SECTION_GROUPS, GESTAO_GROUP];
/** As seções no menu da entrega no ar (com Pagamentos e Técnicos Editar). */
const AVAILABLE = GROUPS.flatMap((g) => g.sections.filter((s) => s.delivery <= CADASTRO_DELIVERY).map((s) => s.key));

describe("link e seção da ficha", () => {
  it("technicianHref: a ficha; com seção que não é a padrão, ?secao=", () => {
    assert.equal(technicianHref("abc"), "/tecnicos/abc");
    assert.equal(technicianHref("abc", "recebimento"), "/tecnicos/abc?secao=recebimento");
    assert.equal(technicianHref("abc", "historico"), "/tecnicos/abc?secao=historico");
    assert.equal(technicianHref("abc", FICHA_DEFAULT), "/tecnicos/abc");
    assert.equal(technicianHref("abc", null), "/tecnicos/abc");
    assert.equal(technicianHref(ID, "contato"), `/tecnicos/${ID}?secao=contato`);
  });

  it("a padrão é Dados pessoais", () => {
    assert.equal(FICHA_DEFAULT, "dados-pessoais");
  });

  it("sectionFromParam: a do menu vale; sem, desconhecida ou fora da entrega, a padrão", () => {
    assert.equal(sectionFromParam("contato", AVAILABLE), "contato");
    assert.equal(sectionFromParam("situacao", AVAILABLE), "situacao");
    assert.equal(sectionFromParam(null, AVAILABLE), FICHA_DEFAULT);
    assert.equal(sectionFromParam("", AVAILABLE), FICHA_DEFAULT);
    assert.equal(sectionFromParam("xyz", AVAILABLE), FICHA_DEFAULT);
    // Entrega 2 no ar: as seções dela valem; Desempenho é da 3.
    for (const key of ["documentos", "curriculo", "areas-de-atuacao", "avaliacoes", "anexos"]) {
      assert.equal(sectionFromParam(key, AVAILABLE), key);
    }
    assert.equal(sectionFromParam("desempenho", AVAILABLE), FICHA_DEFAULT);
    // Sem Pagamentos, a tela tira Formas de recebimento do menu.
    assert.equal(sectionFromParam("recebimento", AVAILABLE.filter((key) => key !== "recebimento")), FICHA_DEFAULT);
  });
});

describe("menu da ficha (os 4 grupos)", () => {
  it("grupos e seções na ordem, com os rótulos", () => {
    const menu = GROUPS.map((g) => [g.label, g.sections.map((s) => `${s.key}:${s.label}:${s.delivery}`)]);
    assert.deepEqual(menu, [
      [
        "Dados pessoais e cadastrais",
        [
          "foto:Foto do perfil:1",
          "dados-pessoais:Dados pessoais:1",
          "endereco:Endereço:1",
          "contato:Contato:1",
          "credenciais:Credenciais:1",
          "documentos:Documentos:2",
          "mini-biografia:Mini biografia:1",
        ],
      ],
      ["Dados financeiros e empresariais", ["dados-empresariais:Dados empresariais:1", "recebimento:Formas de recebimento:1"]],
      [
        "Perfil profissional",
        [
          "dias-e-horarios:Dias e horários:1",
          "transporte:Transporte:1",
          "curriculo:Currículo:2",
          "formacao:Formação:1",
          "areas-de-atuacao:Áreas de atuação:2",
          "aptidoes:Aptidões:1",
          "ferramental:Ferramental:1",
        ],
      ],
      [
        "Gestão",
        [
          "situacao:Situação:1",
          "equipe:Equipe e jornada:1",
          "favoritos:Favoritos:1",
          "avaliacoes:Avaliações:2",
          "desempenho:Desempenho:3",
          "elo:Elo:1",
          "anexos:Anexos internos:2",
          "historico:Histórico:1",
        ],
      ],
    ]);
    assert.equal(GESTAO_GROUP.key, "gestao");
  });

  it("chaves e rótulos não se repetem nos 4 grupos", () => {
    const sections = GROUPS.flatMap((g) => g.sections);
    assert.ok(unique(sections.map((s) => s.key)));
    assert.ok(unique(sections.map((s) => s.label)));
    assert.ok(unique(GROUPS.map((g) => g.label)));
  });

  it("na Entrega 2, o menu esconde só Desempenho (da Entrega 3): 23 seções com Pagamentos e Técnicos Editar", () => {
    assert.equal(CADASTRO_DELIVERY, 2);
    const hidden = GROUPS.flatMap((g) => g.sections)
      .filter((s) => s.delivery > CADASTRO_DELIVERY)
      .map((s) => s.key);
    assert.deepEqual(hidden, ["desempenho"]);
    assert.ok(AVAILABLE.includes(FICHA_DEFAULT));
    assert.equal(AVAILABLE.length, 23);
  });
});

describe("filtros da lista na URL", () => {
  const URL_TEXT = "acesso=sem-acesso&dia=sab&turno=manha&incompleto=recebimento&elo=ouro&ordem=ultima-os";

  it("listQueryFrom: grafias da URL para o estado", () => {
    const q = listQueryFrom(new URLSearchParams(URL_TEXT));
    assert.deepEqual(
      { acesso: q.acesso, dia: q.dia, turno: q.turno, incompleto: q.incompleto, elo: q.elo, ordem: q.ordem },
      { acesso: "false", dia: "sat", turno: "morning", incompleto: "payout", elo: "gold", ordem: "visit" },
    );
    assert.deepEqual({ q: q.q, uf: q.uf, cidade: q.cidade, grupo: q.grupo, ferramenta: q.ferramenta }, {
      q: "",
      uf: "",
      cidade: "",
      grupo: "",
      ferramenta: "",
    });
  });

  it("listQueryPatch volta às mesmas grafias; o vazio sai da URL", () => {
    const patch = listQueryPatch(listQueryFrom(new URLSearchParams(URL_TEXT)));
    assert.deepEqual(patch, {
      q: null,
      uf: null,
      cidade: null,
      grupo: null,
      acesso: "sem-acesso",
      ferramenta: null,
      dia: "sab",
      turno: "manha",
      incompleto: "recebimento",
      elo: "ouro",
      ordem: "ultima-os",
    });
  });

  it("ida e volta com todos os filtros", () => {
    const text = `q=Tecnico%20Alfa&uf=SP&cidade=Cidade%20Exemplo&grupo=${ID}&acesso=liberado&ferramenta=${ID}&dia=dom&turno=madrugada&incompleto=celular&elo=em-risco&ordem=elo`;
    const q = listQueryFrom(new URLSearchParams(text));
    assert.deepEqual(q, {
      q: "Tecnico Alfa",
      uf: "SP",
      cidade: "Cidade Exemplo",
      grupo: ID,
      acesso: "true",
      ferramenta: ID,
      dia: "sun",
      turno: "night",
      incompleto: "phone",
      elo: "at_risk",
      ordem: "level",
    });
    const back = Object.fromEntries(Object.entries(listQueryPatch(q)).filter(([, value]) => value !== null));
    assert.deepEqual(back, Object.fromEntries(new URLSearchParams(text)));
  });

  it("cada grafia de cada filtro vai e volta", () => {
    const values = {
      acesso: ["liberado", "sem-acesso"],
      dia: ["seg", "ter", "qua", "qui", "sex", "sab", "dom"],
      turno: ["manha", "tarde", "noite", "madrugada"],
      incompleto: ["celular", "regiao", "servicos", "gps", "recebimento"],
      elo: ["bronze", "prata", "ouro", "diamante", "em-risco"],
      ordem: ["ultima-os", "elo"],
    };
    for (const [param, list] of Object.entries(values)) {
      const states = list.map((value) => listQueryFrom(new URLSearchParams({ [param]: value }))[param]);
      assert.ok(states.every(Boolean) && unique(states), `${param}: ${states.join(", ")}`);
      for (const value of list) {
        assert.equal(listQueryPatch(listQueryFrom(new URLSearchParams({ [param]: value })))[param], value, `${param}=${value}`);
      }
    }
  });

  it("valor desconhecido vira vazio; sem ordem, por nome", () => {
    const q = listQueryFrom(
      new URLSearchParams("acesso=todos&dia=sabado&turno=x&incompleto=pix&elo=gold&ordem=nome&uf=Sao%20Paulo&grupo=abc&ferramenta=1"),
    );
    assert.deepEqual(
      [q.acesso, q.dia, q.turno, q.incompleto, q.elo, q.uf, q.grupo, q.ferramenta],
      ["", "", "", "", "", "", "", ""],
    );
    assert.equal(q.ordem, "name");
    assert.equal(listQueryFrom(new URLSearchParams()).ordem, "name");
    assert.equal(listQueryPatch(listQueryFrom(new URLSearchParams())).ordem, null);
  });

  it("aceita maiúsculas e espaços nas grafias; UF em maiúsculas", () => {
    const q = listQueryFrom(new URLSearchParams("dia=SAB&turno=%20Manha%20&uf=sp"));
    assert.equal(q.dia, "sat");
    assert.equal(q.turno, "morning");
    assert.equal(q.uf, "SP");
  });

  it("listCityOf: a cidade da lista só com a UF; a busca dos Favoritos chega com o -UF", () => {
    assert.equal(listCityOf("Cidade Exemplo-SP", "SP"), "Cidade Exemplo");
    assert.equal(listCityOf("Cidade Exemplo-sp", "SP"), "Cidade Exemplo");
    assert.equal(listCityOf("São Paulo-SP", "SP"), "São Paulo");
    assert.equal(listCityOf("Cidade Exemplo", "SP"), "Cidade Exemplo");
    assert.equal(listCityOf("Cidade Exemplo-RJ", "SP"), "Cidade Exemplo-RJ");
    assert.equal(listCityOf("Cidade Exemplo-SP", ""), "");
    assert.equal(listCityOf("", "SP"), "");
    // O link "Favorito em" da ficha (favoritesHref) chega na lista como a cidade.
    const q = listQueryFrom(new URLSearchParams("aba=favoritos&uf=SP&cidade=Cidade%20Exemplo-SP"));
    assert.equal(listCityOf(q.cidade, q.uf), "Cidade Exemplo");
  });
});

describe("indisponibilidade e e-mail (de lib/constants.ts)", () => {
  const periods = [{ id: ID, start: "2026-11-20", end: "2026-11-30" }];

  it("unavailableOn é inclusivo nas pontas", () => {
    assert.equal(unavailableOn(periods, "2026-11-20"), periods[0]);
    assert.equal(unavailableOn(periods, "2026-11-30"), periods[0]);
    assert.equal(unavailableOn(periods, "2026-12-01"), null);
    assert.equal(unavailableOn(undefined, "2026-11-25"), null);
  });

  it("unavailableBetween: os dias da visita, do início ao fim (a oferta que a API recusaria)", () => {
    const away = [{ id: ID, start: "2026-12-01", end: "2026-12-05" }];
    // OS de 30/11 às 22h com 240 min: termina 01/12 às 2h e toca o período que começa no 2º dia.
    assert.equal(unavailableOn(away, "2026-11-30"), null);
    assert.equal(unavailableBetween(away, "2026-11-30", "2026-12-01"), away[0]);
    // Visita de vários dias com o período só no meio.
    assert.equal(unavailableBetween([{ id: ID, start: "2026-12-01", end: "2026-12-01" }], "2026-11-30", "2026-12-02")?.start, "2026-12-01");
    // Termina na véspera do período: livre.
    assert.equal(unavailableBetween(away, "2026-11-29", "2026-11-30"), null);
    // Já começou (o mesmo período da lista): pega.
    assert.equal(unavailableBetween(periods, "2026-11-25", "2026-11-25"), periods[0]);
  });

  it("periodShort: já começou ou ainda vai começar", () => {
    assert.equal(periodShort(periods[0], "2026-11-25"), "até 30/11");
    assert.equal(periodShort(periods[0], "2026-11-10"), "de 20/11 a 30/11");
  });

  it("isSendableEmail: importados e logins de teste não recebem", () => {
    assert.equal(isSendableEmail("fc-12@importado.invalid"), false);
    assert.equal(isSendableEmail("tecnico"), false);
    assert.equal(isSendableEmail("alfa@exemplo.com"), true);
  });
});

describe("situação na operação", () => {
  it("operationalRank: Ativo com acesso, Ativo sem acesso, Inativo, Bloqueado", () => {
    const rows = [
      { name: "Bloqueado sem acesso", operational_status: "blocked", is_active: false },
      { name: "Inativo com acesso", operational_status: "inactive", is_active: true },
      { name: "Ativo sem acesso", operational_status: "active", is_active: false },
      { name: "Bloqueado com acesso", operational_status: "blocked", is_active: true },
      { name: "Ativo com acesso", operational_status: "active", is_active: true },
      { name: "Inativo sem acesso", operational_status: "inactive", is_active: false },
    ];
    assert.deepEqual(
      rows.map((t) => operationalRank(t)),
      [3, 2, 1, 3, 0, 2],
    );
    const sorted = [...rows].sort((a, b) => operationalRank(a) - operationalRank(b) || a.name.localeCompare(b.name));
    assert.deepEqual(
      sorted.map((t) => t.name),
      [
        "Ativo com acesso",
        "Ativo sem acesso",
        "Inativo com acesso",
        "Inativo sem acesso",
        "Bloqueado com acesso",
        "Bloqueado sem acesso",
      ],
    );
  });

  it("API antiga (sem a situação): conta como Ativo", () => {
    assert.equal(operationalRank({ is_active: true }), 0);
    assert.equal(operationalRank({ is_active: false }), 1);
  });

  it("cor só fora de Ativo: âmbar e vermelho", () => {
    assert.deepEqual(OPERATIONAL_STATUS_COLOR, { inactive: "#d97706", blocked: "#dc2626" });
  });
});

describe("rótulos", () => {
  it("cobrem todas as chaves", () => {
    assert.deepEqual(EMAIL_TEMPLATE_LABEL, {
      verify_email: "Validação de e-mail",
      welcome: "Boas-vindas",
      password_reset: "Redefinição de senha",
    });
    assert.deepEqual(EMAIL_STATUS_LABEL, { pending: "Na fila", sent: "Enviado", failed: "Falhou", expired: "Não enviado" });
    assert.deepEqual(REVIEW_ACTION_LABEL, {
      approved: "Aprovada",
      rejected: "Reprovada",
      reopened: "Reaberta",
      expired: "Expirada sem análise",
    });
    for (const labels of [EMAIL_TEMPLATE_LABEL, REVIEW_ACTION_LABEL]) assert.ok(unique(Object.values(labels)));
  });

  it("emailStatusLabel: com o envio desligado, o que está na fila é Não enviado", () => {
    assert.equal(emailStatusLabel("pending", false), "Não enviado");
    assert.equal(emailStatusLabel("pending", true), "Na fila");
    assert.equal(emailStatusLabel("pending", undefined), "Na fila");
    assert.equal(emailStatusLabel("sent", false), "Enviado");
    assert.equal(emailStatusLabel("failed", true), "Falhou");
    assert.equal(emailStatusLabel("expired", true), "Não enviado");
  });
});

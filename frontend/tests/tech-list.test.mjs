// Lista de Técnicos (lib/techListFilter.ts): a região de atuação, a cidade sem acento e sem maiúsculas, a
// disponibilidade e a regra das contagens — cada opção de cada filtro conta exatamente as linhas que a lista mostra ao
// escolhê-la. Também os favoritos por técnico e as colunas novas da planilha. 8 técnicos fictícios.
// Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAY_PERIOD_ORDER, LEVEL_TIER_ORDER, OPERATIONAL_STATUS, WEEKDAY_ORDER } from "../src/lib/constants.ts";
import { listQueryFrom } from "../src/lib/technicians.ts";
import {
  availableIn,
  certificationCsvText,
  cityKey,
  cityOptionKey,
  favoriteCitiesMap,
  GAPS,
  LIST_PERIODS,
  LIST_STATUSES,
  LIST_TIERS,
  LIST_WEEKDAYS,
  listFacets,
  matchesList,
  namesText,
  regionOf,
  sameCity,
  statusOf,
  TECH_CSV_HEADER,
} from "../src/lib/techListFilter.ts";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ALFA, BETA, CHARLIE, DELTA, ECHO, FOXTROT, GOLF, HOTEL] = [1, 2, 3, 4, 5, 6, 7, 8].map(uuid);
const [REDES, CFTV, SEM_USO] = [11, 12, 13].map(uuid);
const [LINUX, CABEAMENTO] = [21, 22].map(uuid);
const [MULTIMETRO, ESCADA] = [31, 32].map(uuid);
const [CAMPO, PROJETOS] = [41, 42].map(uuid);

/** Um técnico da lista (GET /technicians) com o cadastro completo; `over` troca o que o caso pede. */
function tech(id, name, over = {}) {
  return {
    id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@exemplo.com`,
    phone: "(11) 90000-0000",
    is_active: true,
    operational_status: "active",
    operational_reason: null,
    base_city: null,
    base_state: null,
    home_city: null,
    home_state: null,
    services: ["Instalação"],
    location_consent_at: "2026-11-01T12:00:00Z",
    payout_methods_count: 1,
    team: null,
    availability: [],
    area_ids: [],
    skills: [],
    tool_ids: [],
    certification_due: null,
    ...over,
  };
}

const skill = (skill_id, name, level = "basico") => ({ skill_id, name, level, since: "2026-01-10" });
const due = (title, expires_on, count = 1) => ({ document_id: uuid(90), title, expires_on, count });

const LIST = [
  // A base pelo histórico vale mais que a casa.
  tech(ALFA, "Tecnico Alfa", {
    base_city: "São Paulo",
    base_state: "SP",
    home_city: "Cidade Exemplo",
    home_state: "SP",
    area_ids: [REDES],
    skills: [skill(LINUX, "Linux")],
    tool_ids: [MULTIMETRO],
    team: { id: CAMPO, name: "Campo" },
    availability: ["mon:morning", "tue:afternoon"],
    certification_due: due("NR10", "2026-11-20", 2),
    level: { tier: "gold", at_risk: false },
  }),
  // Sem base: a casa, em maiúsculas e sem acento, com a UF minúscula.
  tech(BETA, "Tecnico Beta", {
    home_city: "SAO PAULO",
    home_state: "sp",
    operational_status: "inactive",
    operational_reason: "Pediu pausa",
    is_active: false,
    phone: null,
    services: [],
    area_ids: [REDES, CFTV],
    skills: [skill(LINUX, "Linux", "avancado"), skill(CABEAMENTO, "Cabeamento estruturado")],
    team: { id: PROJETOS, name: "Projetos" },
    availability: ["mon:evening"],
    level: { tier: "silver", at_risk: true },
  }),
  tech(CHARLIE, "Tecnico Charlie", {
    base_city: "Água Branca",
    base_state: "AL",
    tool_ids: [MULTIMETRO, ESCADA],
    location_consent_at: null,
    payout_methods_count: 0,
    certification_due: due("NR35", "2026-12-10"),
    level: { tier: "bronze", at_risk: false },
  }),
  // A API de antes não manda o vencimento: fica fora do filtro.
  (() => {
    const t = tech(DELTA, "Tecnico Delta", {
      base_city: "Belém",
      base_state: "PA",
      operational_status: "blocked",
      operational_reason: "Documento pendente",
      area_ids: [CFTV],
      skills: [skill(CABEAMENTO, "Cabeamento estruturado", "intermediario")],
      tool_ids: [ESCADA],
      team: { id: CAMPO, name: "Campo" },
      availability: ["sat:night", "sun:morning"],
      level: { tier: "diamond", at_risk: false },
    });
    delete t.certification_due;
    return t;
  })(),
  // Sem região nenhuma e sem acesso ao app.
  tech(ECHO, "Tecnico Echo", { is_active: false, services: [], availability: null }),
  // A mesma cidade em outra UF.
  tech(FOXTROT, "Tecnico Foxtrot", {
    base_city: "Cidade Exemplo",
    base_state: "RJ",
    area_ids: [REDES],
    availability: ["mon:morning"],
    certification_due: due("NR10", "2026-12-01"),
  }),
  tech(GOLF, "Tecnico Golf", { base_city: "Cidade Exemplo", base_state: "SP", tool_ids: [MULTIMETRO] }),
  // A base em branco não conta: vale a casa (com espaços a mais).
  tech(HOTEL, "Tecnico Hotel", {
    base_city: "  ",
    home_city: " Cidade   Exemplo ",
    home_state: "SP",
    team: { id: PROJETOS, name: "Projetos" },
    availability: ["mon:morning", "mon:afternoon"],
    level: { tier: "gold", at_risk: true },
  }),
];

/** Os favoritos efetivos (GET /technicians/favorites, a consulta da aba Favoritos). */
const FAVORITES_OUT = {
  cities: [
    { state: "SP", city: "Cidade Exemplo", key: "cidade exemplo", favorites: [{ id: GOLF }, { id: ALFA }] },
    { state: "RJ", city: "Cidade Exemplo", key: "cidade exemplo", favorites: [{ id: ALFA }, { id: FOXTROT }] },
    { state: "AL", city: "Água Branca", key: "agua branca", favorites: [{ id: CHARLIE }] },
    { state: "PA", city: "Belém", key: "belem", favorites: [] },
  ],
};
const CTX = { favorites: favoriteCitiesMap(FAVORITES_OUT) };
const EMPTY = listQueryFrom(new URLSearchParams());
const q = (patch = {}) => ({ ...EMPTY, ...patch });
const rows = (query, ctx = CTX) => LIST.filter((t) => matchesList(t, query, ctx)).map((t) => t.name);
const count = (query, ctx = CTX) => rows(query, ctx).length;

describe("região de atuação e cidade", () => {
  it("regionOf: a base vence a casa; sem base, a casa; sem nenhuma, null", () => {
    const byId = (id) => LIST.find((t) => t.id === id);
    assert.deepEqual(regionOf(byId(ALFA)), { city: "São Paulo", state: "SP" });
    assert.deepEqual(regionOf(byId(BETA)), { city: "SAO PAULO", state: "SP" });
    assert.deepEqual(regionOf(byId(HOTEL)), { city: "Cidade Exemplo", state: "SP" });
    assert.equal(regionOf(byId(ECHO)), null);
    assert.deepEqual(regionOf({ base_city: null, base_state: null, home_city: "Cidade Exemplo", home_state: null }), {
      city: "Cidade Exemplo",
      state: null,
    });
  });

  it("cidade sem acento, sem maiúsculas e sem espaços a mais", () => {
    assert.equal(cityKey("São Paulo"), cityKey("SAO PAULO"));
    assert.equal(cityKey("  Água   Branca "), "agua branca");
    assert.equal(cityKey(null), "");
    assert.ok(sameCity({ city: "SAO PAULO", state: "SP" }, { city: "São Paulo", state: "SP" }));
    assert.ok(sameCity({ city: "São Paulo", state: "SP" }, { city: "sao paulo", state: null }), "sem UF, qualquer UF");
    assert.ok(!sameCity({ city: "Cidade Exemplo", state: "RJ" }, { city: "Cidade Exemplo", state: "SP" }));
    assert.ok(!sameCity(null, { city: "Cidade Exemplo", state: null }));
    assert.equal(cityOptionKey({ city: "São Paulo", state: "SP" }), cityOptionKey({ city: "SAO  PAULO", state: "SP" }));
  });

  it("filtrar pela cidade acha São Paulo escrito de outro jeito; sem UF, a cidade em qualquer UF", () => {
    assert.deepEqual(rows(q({ cidade: { city: "sao paulo", state: "SP" } })), ["Tecnico Alfa", "Tecnico Beta"]);
    assert.deepEqual(rows(q({ cidade: { city: "Cidade Exemplo", state: null } })), [
      "Tecnico Foxtrot",
      "Tecnico Golf",
      "Tecnico Hotel",
    ]);
    assert.deepEqual(rows(q({ cidade: { city: "Cidade Exemplo", state: "RJ" } })), ["Tecnico Foxtrot"]);
    // A casa de quem tem base não conta (Alfa mora em Cidade Exemplo, mas a base é São Paulo).
    assert.ok(!rows(q({ cidade: { city: "Cidade Exemplo", state: "SP" } })).includes("Tecnico Alfa"));
  });

  it("as cidades em ordem alfabética sem acento e depois a UF, com a grafia mais comum", () => {
    const { cities } = listFacets(LIST, EMPTY, CTX);
    assert.deepEqual(
      cities.map((c) => `${c.label}:${c.count}`),
      ["Água Branca-AL:1", "Belém-PA:1", "Cidade Exemplo-RJ:1", "Cidade Exemplo-SP:2", "São Paulo-SP:2"],
    );
    assert.ok(cities.findIndex((c) => c.label === "Água Branca-AL") < cities.findIndex((c) => c.label === "Belém-PA"));
  });

  it("com a UF escolhida, só as cidades dela", () => {
    const { cities } = listFacets(LIST, q({ uf: "SP" }), CTX);
    assert.deepEqual(
      cities.map((c) => c.label),
      ["Cidade Exemplo-SP", "São Paulo-SP"],
    );
  });
});

describe("disponibilidade, situação e cadastro", () => {
  it("availableIn: dia e turno, só o dia, só o turno; sem disponibilidade, fora", () => {
    const slots = ["mon:morning", "tue:afternoon"];
    assert.equal(availableIn(slots, "mon", "morning"), true);
    assert.equal(availableIn(slots, "mon", "afternoon"), false);
    assert.equal(availableIn(slots, "tue", ""), true);
    assert.equal(availableIn(slots, "wed", ""), false);
    assert.equal(availableIn(slots, "", "afternoon"), true);
    assert.equal(availableIn(slots, "", "night"), false);
    // Sem filtro, todos; com filtro, quem não informou fica de fora.
    assert.equal(availableIn(slots, "", ""), true);
    assert.equal(availableIn(null, "", ""), true);
    assert.equal(availableIn([], "mon", ""), false);
    assert.equal(availableIn(null, "", "morning"), false);
    assert.equal(availableIn(undefined, "mon", "morning"), false);
  });

  it("statusOf: sem a situação (API de antes), Ativo", () => {
    assert.equal(statusOf({}), "active");
    assert.equal(statusOf({ operational_status: "blocked" }), "blocked");
  });

  it("as listas locais batem com lib/constants.ts", () => {
    assert.deepEqual([...LIST_WEEKDAYS], [...WEEKDAY_ORDER]);
    assert.deepEqual([...LIST_PERIODS], [...DAY_PERIOD_ORDER]);
    assert.deepEqual([...LIST_TIERS], [...LEVEL_TIER_ORDER]);
    assert.deepEqual([...LIST_STATUSES], Object.keys(OPERATIONAL_STATUS));
  });

  it("cadastro incompleto: os 5 filtros rápidos", () => {
    assert.deepEqual(
      GAPS.map((g) => g.key),
      ["phone", "region", "services", "gps", "payout"],
    );
    const names = (key) => rows(q({ incompleto: key }));
    assert.deepEqual(names("phone"), ["Tecnico Beta"]);
    assert.deepEqual(names("region"), ["Tecnico Echo"]);
    assert.deepEqual(names("services"), ["Tecnico Beta", "Tecnico Echo"]);
    assert.deepEqual(names("gps"), ["Tecnico Charlie"]);
    assert.deepEqual(names("payout"), ["Tecnico Charlie"]);
  });
});

describe("filtros novos", () => {
  it("situação, acesso, área, aptidão e ferramenta", () => {
    assert.deepEqual(rows(q({ situacao: "inactive" })), ["Tecnico Beta"]);
    assert.deepEqual(rows(q({ situacao: "blocked" })), ["Tecnico Delta"]);
    assert.deepEqual(rows(q({ acesso: "false" })), ["Tecnico Beta", "Tecnico Echo"]);
    assert.deepEqual(rows(q({ area: CFTV })), ["Tecnico Beta", "Tecnico Delta"]);
    assert.deepEqual(rows(q({ aptidao: LINUX })), ["Tecnico Alfa", "Tecnico Beta"]);
    assert.deepEqual(rows(q({ ferramenta: ESCADA })), ["Tecnico Charlie", "Tecnico Delta"]);
    assert.deepEqual(rows(q({ area: SEM_USO })), []);
  });

  it("combinados com E", () => {
    assert.deepEqual(rows(q({ area: REDES, situacao: "active" })), ["Tecnico Alfa", "Tecnico Foxtrot"]);
    assert.deepEqual(rows(q({ area: REDES, situacao: "active", uf: "SP" })), ["Tecnico Alfa"]);
    assert.deepEqual(rows(q({ dia: "mon", turno: "morning", grupo: PROJETOS })), ["Tecnico Hotel"]);
  });

  it("favoritos: em alguma cidade; sem a consulta dos favoritos, ninguém", () => {
    assert.deepEqual(rows(q({ favorito: true })), ["Tecnico Alfa", "Tecnico Charlie", "Tecnico Foxtrot", "Tecnico Golf"]);
    assert.deepEqual(rows(q({ favorito: true }), { favorites: null }), []);
    assert.equal(listFacets(LIST, EMPTY, { favorites: null }).favorito, 0);
    // Sem o filtro, a consulta dos favoritos não muda a lista.
    assert.equal(count(EMPTY, { favorites: null }), LIST.length);
  });

  it("certificação vencendo: só quem tem certification_due (ausente ou null, fora)", () => {
    assert.deepEqual(rows(q({ certificacao: "vencendo" })), ["Tecnico Alfa", "Tecnico Charlie", "Tecnico Foxtrot"]);
    assert.equal(listFacets(LIST, EMPTY, CTX).certificacao, 3);
  });

  it("skip: o filtro da opção que se quer contar não conta", () => {
    const beta = LIST.find((t) => t.id === BETA);
    const query = q({ situacao: "active", area: CFTV });
    assert.equal(matchesList(beta, query, CTX), false);
    assert.equal(matchesList(beta, query, CTX, "situacao"), true);
    assert.equal(matchesList(beta, q({ situacao: "active", acesso: "true" }), CTX, "situacao"), false);
    assert.equal(matchesList(beta, q({ situacao: "active", acesso: "true" }), CTX, ["situacao", "acesso"]), true);
  });
});

describe("contagem igual ao filtro", () => {
  /** A lista com a UF trocada, como a tela faz: a cidade de outra UF sai. */
  const withUf = (query, uf) => ({ ...query, uf, cidade: query.cidade?.state && query.cidade.state !== uf ? null : query.cidade });
  const STATES = [...new Set(LIST.map((t) => regionOf(t)?.state).filter(Boolean))];

  /** Cada filtro: as opções que a tela oferece, a contagem que ela mostra e a consulta ao escolher a opção. */
  const DIMENSIONS = [
    ["cidade", (f) => f.cities, (f, c) => c.count, (query, c) => ({ ...query, cidade: { city: c.city, state: c.state } })],
    ["uf", () => STATES, (f, s) => f.uf[s] ?? 0, withUf],
    ["situacao", () => LIST_STATUSES, (f, s) => f.situacao[s], (query, s) => ({ ...query, situacao: s })],
    ["acesso", () => ["true", "false"], (f, a) => f.acesso[a], (query, a) => ({ ...query, acesso: a })],
    ["area", () => [REDES, CFTV, SEM_USO], (f, id) => f.area[id] ?? 0, (query, id) => ({ ...query, area: id })],
    ["aptidao", () => [LINUX, CABEAMENTO], (f, id) => f.aptidao[id] ?? 0, (query, id) => ({ ...query, aptidao: id })],
    ["ferramenta", () => [MULTIMETRO, ESCADA], (f, id) => f.ferramenta[id] ?? 0, (query, id) => ({ ...query, ferramenta: id })],
    ["grupo", () => [CAMPO, PROJETOS], (f, id) => f.grupo[id] ?? 0, (query, id) => ({ ...query, grupo: id })],
    ["dia", () => LIST_WEEKDAYS, (f, d) => f.dia[d], (query, d) => ({ ...query, dia: d })],
    ["turno", () => LIST_PERIODS, (f, p) => f.turno[p], (query, p) => ({ ...query, turno: p })],
    ["favorito", () => [true], (f) => f.favorito, (query) => ({ ...query, favorito: true })],
    ["certificacao", () => ["vencendo"], (f) => f.certificacao, (query) => ({ ...query, certificacao: "vencendo" })],
    ["incompleto", () => GAPS.map((g) => g.key), (f, k) => f.incompleto[k], (query, k) => ({ ...query, incompleto: k })],
    ["elo", () => [...LIST_TIERS, "at_risk"], (f, e) => f.elo?.[e] ?? 0, (query, e) => ({ ...query, elo: e })],
  ];

  const BASES = [
    ["sem filtro", EMPTY],
    ["Ativo", q({ situacao: "active" })],
    ["SP", q({ uf: "SP" })],
    ["Cidade Exemplo em qualquer UF", q({ cidade: { city: "Cidade Exemplo", state: null } })],
    ["Cidade Exemplo-SP com acesso", q({ cidade: { city: "Cidade Exemplo", state: "SP" }, acesso: "true" })],
    ["Redes e favoritos", q({ area: REDES, favorito: true })],
    ["segunda", q({ dia: "mon" })],
    ["manhã", q({ turno: "morning" })],
    ["segunda de manhã", q({ dia: "mon", turno: "morning" })],
    ["certificação e ouro", q({ certificacao: "vencendo", elo: "gold" })],
    ["sem celular e inativo", q({ incompleto: "phone", situacao: "inactive" })],
  ];

  for (const [name, base] of BASES) {
    it(`cada opção conta as linhas ao escolhê-la (${name})`, () => {
      const facets = listFacets(LIST, base, CTX);
      for (const [dim, options, shown, choose] of DIMENSIONS) {
        for (const option of options(facets)) {
          const label = `${dim}=${typeof option === "object" ? option.label : option}`;
          assert.equal(shown(facets, option), count(choose(base, option)), label);
        }
      }
    });
  }

  it("nenhuma cidade fica de fora das opções (as com alguém)", () => {
    for (const [, base] of BASES) {
      const facets = listFacets(LIST, base, CTX);
      // Quem passa por todos os filtros menos a cidade e tem região está em alguma opção.
      const withRegion = LIST.filter((t) => regionOf(t) && matchesList(t, base, CTX, "cidade")).length;
      assert.equal(
        facets.cities.reduce((sum, c) => sum + c.count, 0),
        withRegion,
      );
      assert.ok(facets.cities.every((c) => c.count > 0));
    }
  });

  it("o elo: null quando a API ainda não manda", () => {
    const old = LIST.map(({ level, ...rest }) => rest);
    assert.equal(listFacets(old, EMPTY, CTX).elo, null);
    assert.deepEqual(listFacets(LIST, EMPTY, CTX).elo, { bronze: 1, silver: 1, gold: 2, diamond: 1, at_risk: 2 });
  });
});

describe("favoritos e planilha", () => {
  it("favoriteCitiesMap: Cidade-UF em ordem alfabética por técnico; sem a consulta, null", () => {
    const map = favoriteCitiesMap(FAVORITES_OUT);
    assert.deepEqual(map.get(ALFA), ["Cidade Exemplo-RJ", "Cidade Exemplo-SP"]);
    assert.deepEqual(map.get(CHARLIE), ["Água Branca-AL"]);
    assert.equal(map.has(BETA), false);
    assert.equal(favoriteCitiesMap(null), null);
    assert.equal(favoriteCitiesMap(undefined), null);
  });

  it("o cabeçalho da planilha, sem CPF, RG, nascimento nem dados de recebimento", () => {
    assert.equal(
      TECH_CSV_HEADER.join(";"),
      "nome;email;celular;grupo;cidade;uf;regiao_atuacao;situacao;situacao_motivo;acesso_app;email_validado;" +
        "forma_recebimento;ultimo_acesso;ultima_os;os_abertas;elo;elo_em_risco;ferramental;disponibilidade;transporte;cnh;" +
        "aptidoes;areas_atuacao;favorito_em;certificacao_vencendo;avaliacao_media;avaliacoes;perfil_tecnico_atualizado_em",
    );
    assert.equal(new Set(TECH_CSV_HEADER).size, TECH_CSV_HEADER.length);
    for (const word of ["cpf", "rg", "nascimento", "pix", "chave", "banco", "conta"]) {
      assert.ok(!TECH_CSV_HEADER.some((column) => column.split("_").includes(word)), word);
    }
  });

  it("namesText: os nomes do catálogo em ordem alfabética com '; '; o que não está nele sai", () => {
    const names = new Map([
      [REDES, "Redes e cabeamento"],
      [CFTV, "CFTV"],
      [SEM_USO, "Automação"],
    ]);
    assert.equal(namesText([REDES, CFTV, uuid(99)], names), "CFTV; Redes e cabeamento");
    assert.equal(namesText([SEM_USO, REDES], names), "Automação; Redes e cabeamento");
    assert.equal(namesText([], names), "");
    assert.equal(namesText(undefined, names), "");
  });

  it("certificationCsvText: vencida ou vence em dd/mm/aaaa; sem, vazio", () => {
    const today = "2026-11-26";
    assert.equal(certificationCsvText({ title: "NR10", expires_on: "2026-11-25" }, today), "NR10 vencida em 25/11/2026");
    assert.equal(certificationCsvText({ title: "NR10", expires_on: "2026-11-26" }, today), "NR10 vence em 26/11/2026");
    assert.equal(certificationCsvText({ title: "NR35", expires_on: "2026-12-26" }, today), "NR35 vence em 26/12/2026");
    assert.equal(certificationCsvText(null, today), "");
    assert.equal(certificationCsvText(undefined, today), "");
  });
});

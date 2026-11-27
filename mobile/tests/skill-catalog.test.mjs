// Sonda das aptidões do catálogo e do que o app faz com a gestão (Entrega 2): a busca e o que a folha "Adicionar
// aptidão" oferece, os corpos do PATCH pelo id (servidor com o catálogo) e pelo nome (servidor de antes), o carimbo da
// central, o menu e as telas (pelas fontes: carimbo nas 6 telas, Áreas de atuação, tempo real e o cartão do aviso),
// hasCadastroE2 (as duas ordens da publicação) e a releitura do cadastro quando a central muda algo
// (profileChangedElsewhere, com lib/profile.ts de verdade sobre os stubs de tests/stubs). Dados fictícios.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { describe, it } from "node:test";
import { CADASTRO_DELIVERY, ME_PROFILE_EVENT, TECH_PROFILE_LIMITS, TECH_SECTION_GROUPS } from "../src/lib/constants.ts";
import {
  availableSkills,
  centralStampText,
  searchCatalog,
  SKILL_MSG,
  skillItemIn,
  skillKey,
  skillsAdd,
  skillsBody,
  skillsWith,
  skillsWithout,
} from "../src/lib/techProfileForm.ts";
import { api as stubApi, server } from "./stubs/api.mjs";

const ID = {
  printers: "00000000-0000-4000-8000-000000000001",
  fiber: "00000000-0000-4000-8000-000000000002",
  routers: "00000000-0000-4000-8000-000000000003",
  networks: "00000000-0000-4000-8000-000000000004",
  linux: "00000000-0000-4000-8000-000000000005",
};

const CATALOG = [
  { id: ID.printers, name: "Impressoras HP", is_active: true, technicians: null, applications: null, in_use: null },
  { id: ID.fiber, name: "Fibra óptica (fusão)", is_active: true, technicians: null, applications: null, in_use: null },
  { id: ID.routers, name: "Roteadores e firewall", is_active: true, technicians: null, applications: null, in_use: null },
  { id: ID.networks, name: "Redes e cabeamento", is_active: true, technicians: null, applications: null, in_use: null },
];
const names = (items) => items.map((item) => item.name);

/** As aptidões do técnico como o servidor da gestão manda (com o id) e como o servidor de antes mandava (só o nome). */
const MINE_E2 = [
  { skill_id: ID.printers, name: "Impressoras HP", level: "avancado", since: "2025-03-01" },
  { skill_id: ID.linux, name: "Linux", level: "intermediario", since: "2025-02-01" },
];
const MINE_E1 = MINE_E2.map(({ name, level, since }) => ({ name, level, since }));

describe("searchCatalog", () => {
  it("cada palavra em alguma parte do nome, sem acento e maiúsculas", () => {
    assert.deepEqual(names(searchCatalog(CATALOG, "impressora hp")), ["Impressoras HP"]);
    assert.deepEqual(names(searchCatalog(CATALOG, "IMPRESSÓRA")), ["Impressoras HP"]);
    assert.deepEqual(names(searchCatalog(CATALOG, "fusao")), ["Fibra óptica (fusão)"]);
    assert.deepEqual(names(searchCatalog(CATALOG, "  óptica   FUSÃO ")), ["Fibra óptica (fusão)"]);
    assert.deepEqual(searchCatalog(CATALOG, "furadeira"), []);
  });

  it("ordem: começa com a 1ª palavra, palavra que começa com ela, o resto; depois o nome", () => {
    assert.deepEqual(names(searchCatalog(CATALOG, "re")), ["Redes e cabeamento", "Impressoras HP", "Roteadores e firewall"]);
    assert.deepEqual(names(searchCatalog(CATALOG, "fire")), ["Roteadores e firewall"]);
    const items = [{ name: "Cabeamento de redes" }, { name: "Redes sem fio" }, { name: "Gerência de redes" }, { name: "Torres" }];
    assert.deepEqual(names(searchCatalog(items, "rede")), ["Redes sem fio", "Cabeamento de redes", "Gerência de redes"]);
  });

  it("busca vazia: todos, em ordem alfabética (sem diferença de acento e maiúsculas)", () => {
    assert.deepEqual(names(searchCatalog(CATALOG, "")), ["Fibra óptica (fusão)", "Impressoras HP", "Redes e cabeamento", "Roteadores e firewall"]);
    assert.equal(searchCatalog(CATALOG, "   ").length, 4);
    assert.deepEqual(names(searchCatalog([{ name: "Ótica" }, { name: "abc" }, { name: "Elétrica" }], "")), ["abc", "Elétrica", "Ótica"]);
  });
});

describe("availableSkills", () => {
  it("tira a desativada e as que o técnico já tem pelo id", () => {
    const catalog = [...CATALOG, { id: "x-off", name: "Desativada", is_active: false }];
    assert.deepEqual(names(availableSkills(catalog, MINE_E2)), ["Fibra óptica (fusão)", "Roteadores e firewall", "Redes e cabeamento"]);
  });

  it("na aptidão dele sem id (formato de antes), pelo nome sem acento e maiúsculas", () => {
    assert.deepEqual(names(availableSkills(CATALOG, [{ name: "  IMPRESSORAS  hp " }])), [
      "Fibra óptica (fusão)",
      "Roteadores e firewall",
      "Redes e cabeamento",
    ]);
    // Com o id, o nome não conta (o catálogo não repete nome).
    assert.equal(availableSkills(CATALOG, [{ skill_id: "outro-id", name: "Impressoras HP" }]).length, 4);
  });
});

describe("skillKey e skillItemIn", () => {
  it("skillKey: o id do catálogo; sem ele, o nome sem acento e maiúsculas", () => {
    assert.equal(skillKey(MINE_E2[0]), `id:${ID.printers}`);
    assert.equal(skillKey({ name: "Impressoras  HP" }), "nome:impressoras hp");
    assert.equal(skillKey({ skill_id: null, name: "Impressóras HP" }), "nome:impressoras hp");
  });

  it("skillItemIn: byId → {skill_id, level}; sem byId, ou sem id → {name, level} com o nome limpo; nunca o since", () => {
    assert.deepEqual(skillItemIn(MINE_E2[0], true), { skill_id: ID.printers, level: "avancado" });
    assert.deepEqual(skillItemIn(MINE_E2[0], false), { name: "Impressoras HP", level: "avancado" });
    assert.deepEqual(skillItemIn({ name: " Redes ​ de dados ", level: "basico" }, true), { name: "Redes de dados", level: "basico" });
  });
});

describe("corpos do PATCH", () => {
  it("skillsAdd com o catálogo: as escolhidas no fim, pelo id, também as antigas; a que ele já tem não repete", () => {
    const picked = [CATALOG[1], CATALOG[0], CATALOG[3]];
    assert.deepEqual(skillsAdd(MINE_E2, picked, "basico", true), [
      { skill_id: ID.printers, level: "avancado" },
      { skill_id: ID.linux, level: "intermediario" },
      { skill_id: ID.fiber, level: "basico" },
      { skill_id: ID.networks, level: "basico" },
    ]);
  });

  it("skillsAdd sem o catálogo no servidor (byId falso): tudo pelo nome", () => {
    assert.deepEqual(skillsAdd(MINE_E1, [CATALOG[1]], "avancado", false), [
      { name: "Impressoras HP", level: "avancado" },
      { name: "Linux", level: "intermediario" },
      { name: "Fibra óptica (fusão)", level: "avancado" },
    ]);
    // A dele sem id e a escolhida com o mesmo nome: uma só.
    assert.deepEqual(skillsAdd(MINE_E1, [CATALOG[0]], "basico", false), [
      { name: "Impressoras HP", level: "avancado" },
      { name: "Linux", level: "intermediario" },
    ]);
  });

  it("skillsBody não repete a chave (fica a primeira)", () => {
    const list = [
      { skill_id: ID.linux, name: "Linux", level: "basico" },
      { skill_id: ID.linux, name: "Linux", level: "avancado" },
      { name: "Redes", level: "basico" },
      { name: " REDES ", level: "avancado" },
    ];
    assert.deepEqual(skillsBody(list, true), [
      { skill_id: ID.linux, level: "basico" },
      { name: "Redes", level: "basico" },
    ]);
    assert.deepEqual(skillsBody(list, false), [
      { name: "Linux", level: "basico" },
      { name: "Redes", level: "basico" },
    ]);
  });

  it("skillsWith muda só o nível e mantém o id; a chave que sumiu devolve null", () => {
    assert.deepEqual(skillsWith(MINE_E2, `id:${ID.linux}`, "avancado", true), [
      { skill_id: ID.printers, level: "avancado" },
      { skill_id: ID.linux, level: "avancado" },
    ]);
    assert.equal(skillsWith(MINE_E2, `id:${ID.fiber}`, "avancado", true), null);
    assert.equal(SKILL_MSG.gone, "Esta aptidão foi excluída.");
  });

  it("skillsWith e skillsWithout pelo nome (servidor de antes) e a chave pelo nome com o servidor já com o id", () => {
    assert.deepEqual(skillsWith(MINE_E1, "nome:linux", "basico", false), [
      { name: "Impressoras HP", level: "avancado" },
      { name: "Linux", level: "basico" },
    ]);
    assert.deepEqual(skillsWithout(MINE_E1, "nome:impressoras hp", false), [{ name: "Linux", level: "intermediario" }]);
    // A tela abriu com o servidor de antes e a gravação saiu com o novo: a chave pelo nome ainda acha a aptidão.
    assert.deepEqual(skillsWith(MINE_E2, "nome:linux", "basico", true), [
      { skill_id: ID.printers, level: "avancado" },
      { skill_id: ID.linux, level: "basico" },
    ]);
  });

  it("skillsWithout pela chave; a que já saiu não muda nada", () => {
    assert.deepEqual(skillsWithout(MINE_E2, `id:${ID.printers}`, true), [{ skill_id: ID.linux, level: "intermediario" }]);
    assert.deepEqual(skillsWithout(MINE_E2, `id:${ID.fiber}`, true), skillsBody(MINE_E2, true));
  });

  it("duas exclusões em fila: cada corpo sai do que a anterior gravou (o servidor mantém o since pelo id)", () => {
    const apply = (stored, body) =>
      body.map((item) => {
        const old = stored.find((skill) => skill.skill_id === item.skill_id);
        return { ...old, level: item.level };
      });
    let stored = MINE_E2;
    for (const key of [`id:${ID.printers}`, `id:${ID.linux}`]) stored = apply(stored, skillsWithout(stored, key, true));
    assert.deepEqual(stored, []);
  });

  it("os textos da folha", () => {
    assert.equal(SKILL_MSG.pick, "Escolha ao menos uma aptidão.");
    assert.equal(SKILL_MSG.level, "Escolha o nível.");
    assert.equal(TECH_PROFILE_LIMITS.skills, 30);
    assert.equal(TECH_PROFILE_LIMITS.areas, 20);
  });
});

describe("centralStampText", () => {
  it("via central: o dia no fuso do aparelho", () => {
    const at = "2026-11-20T15:00:00Z";
    const day = new Date(at);
    const pad = (n) => String(n).padStart(2, "0");
    const expected = `Atualizado pela central em ${pad(day.getDate())}/${pad(day.getMonth() + 1)}/${day.getFullYear()}`;
    assert.equal(centralStampText({ at, via: "central" }), expected);
    if (day.getDate() === 20) assert.equal(expected, "Atualizado pela central em 20/11/2026");
  });

  it("via app, ficha, null, ausente ou data inválida: nada", () => {
    assert.equal(centralStampText({ at: "2026-11-20T15:00:00Z", via: "app" }), null);
    assert.equal(centralStampText({ at: "2026-11-20T15:00:00Z", via: "ficha" }), null);
    assert.equal(centralStampText(null), null);
    assert.equal(centralStampText(undefined), null);
    assert.equal(centralStampText({ at: "ontem", via: "central" }), null);
  });
});

describe("o menu das Configurações (CADASTRO_DELIVERY 2)", () => {
  it("as telas novas da gestão estão no menu e no _layout", () => {
    const menu = readFileSync(new URL("../src/app/configuracoes/index.tsx", import.meta.url), "utf8");
    const layout = readFileSync(new URL("../src/app/_layout.tsx", import.meta.url), "utf8");
    const sections = TECH_SECTION_GROUPS.flatMap((group) => group.sections).filter((section) => section.delivery <= CADASTRO_DELIVERY);
    for (const key of ["documentos", "curriculo", "areas-de-atuacao"]) assert.ok(sections.some((section) => section.key === key), key);
    for (const href of ["/configuracoes/documentos", "/configuracoes/curriculo", "/configuracoes/areas"]) assert.ok(menu.includes(`"${href}"`), href);
    for (const route of ["documentos", "documento", "curriculo", "areas"]) {
      assert.ok(layout.includes(`name="configuracoes/${route}"`), route);
    }
    assert.ok(layout.includes('title: "Áreas de atuação"'));
  });

  it("nada de Skills nem Ex.: nas telas mexidas", () => {
    const files = [
      "../src/app/configuracoes/index.tsx",
      "../src/app/configuracoes/areas.tsx",
      "../src/app/configuracoes/aptidoes.tsx",
      "../src/app/configuracoes/disponibilidade.tsx",
      "../src/app/configuracoes/transporte.tsx",
      "../src/app/configuracoes/formacao.tsx",
      "../src/app/configuracoes/ferramental.tsx",
      "../src/components/settings/SkillCatalogSheet.tsx",
      "../src/components/settings/SkillSheet.tsx",
      "../src/components/settings/CentralStamp.tsx",
      "../src/components/PrivacyUpdateCard.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.ok(!/["“>][^"”<]*\bSkills?\b/.test(source), file);
      assert.ok(!source.includes("Ex.:"), file);
    }
  });
});

describe("as telas da gestão no app (pelas fontes)", () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

  it("o carimbo da central nas 6 telas do perfil profissional, cada uma com a sua parte", () => {
    const parts = {
      disponibilidade: "availability",
      transporte: "transport",
      formacao: "education",
      areas: "areas",
      aptidoes: "skills",
      ferramental: "tools",
    };
    for (const [screen, part] of Object.entries(parts)) {
      const source = read(`../src/app/configuracoes/${screen}.tsx`);
      assert.match(source, new RegExp(`<CentralStamp stamp=\\{[\\w.]*tech_profile_updated\\.${part}\\} />`), screen);
    }
  });

  it("Áreas de atuação: só com a gestão no servidor; o catálogo da central e o PATCH com area_ids", () => {
    const source = read("../src/app/configuracoes/areas.tsx");
    assert.ok(source.includes("useTechProfileScreen(hasCadastroE2)"));
    assert.ok(source.includes("useAreaCatalog()"));
    assert.ok(source.includes("body: (ids) => ({ area_ids: ids })"));
    assert.ok(!source.includes("service_area"));
  });

  it("área ou ferramenta marcada pela central que a lista da memória não tem: relê o catálogo (uma vez)", () => {
    for (const [screen, reload] of [
      ["areas", "reloadAreaCatalog"],
      ["ferramental", "reloadToolCatalog"],
    ]) {
      const source = read(`../src/app/configuracoes/${screen}.tsx`);
      assert.match(source, /const missing = \w+ \? saved\.filter\(/, screen);
      assert.match(source, new RegExp(`useEffect\\(\\(\\) => \\{\\s*if \\(missing\\) void ${reload}\\(\\);\\s*\\}, \\[missing\\]\\);`), screen);
    }
  });

  it("o menu: Documentos, Currículo e Áreas de atuação \"Indisponível\" com o servidor de antes (fromE2)", () => {
    const menu = read("../src/app/configuracoes/index.tsx");
    for (const key of ["documentos", "areas-de-atuacao"]) {
      assert.match(menu, new RegExp(`case "${key}":(?:\\s*//[^\\n]*)*\\s*return fromE2\\(`), key);
    }
    assert.ok(menu.includes("summary={fromE2(resumeRow)}"));
    assert.ok(menu.includes('documentos: { icon: "idCard"'));
    assert.ok(menu.includes('curriculo: { icon: "fileText"'));
    assert.ok(menu.includes('"areas-de-atuacao": { icon: "grid"'));
  });

  it("Aptidões: a folha do catálogo; o texto livre e as sugestões da ficha saíram", () => {
    const screen = read("../src/app/configuracoes/aptidoes.tsx");
    const sheet = read("../src/components/settings/SkillSheet.tsx");
    const lib = read("../src/lib/technicalProfile.ts");
    assert.ok(screen.includes("<SkillCatalogSheet"));
    assert.ok(screen.includes("useSkillCatalog()"));
    assert.ok(!sheet.includes("suggestion") && !sheet.includes("<Input"));
    assert.ok(lib.includes('"/technician-skills"') && lib.includes('"/technician-areas"'));
    assert.ok(!lib.includes("/public/onboarding/catalog"));
  });

  it("tempo real: o app repassa me.profile_changed e o sync só relê o cadastro, antes da regra das OS", () => {
    const realtime = read("../src/lib/realtime.ts");
    const sync = read("../src/lib/sync.ts");
    assert.ok(realtime.includes("event.type === ME_PROFILE_EVENT"));
    assert.match(sync, /if \(event\.type === ME_PROFILE_EVENT\) \{\s*profileChangedElsewhere\(\);\s*return;\s*\}/);
    assert.ok(sync.indexOf("profileChangedElsewhere();") < sync.indexOf("wsDebounce = setTimeout"));
  });

  it("o cartão do aviso de privacidade no Hoje (contrato §9)", () => {
    assert.ok(read("../src/components/PrivacyUpdateCard.tsx").includes("Agora ele inclui documentos, currículo e avaliações."));
  });
});

// --------------------------------------------------------------------------- lib/profile.ts com os stubs

register("./stubs/hooks.mjs", import.meta.url);
globalThis.__DEV__ = false;
const { session } = await import("../src/lib/session.ts");
const { getProfile, hasCadastroE2, hasCadastroV2, loadProfile, profileChangedElsewhere } = await import("../src/lib/profile.ts");

/** O cadastro do servidor da Entrega 1 (cadastro V2 e perfil técnico, sem a gestão). */
const PROFILE_E1 = {
  id: "u1",
  name: "Tecnico Alfa",
  email: "tecnico.alfa@exemplo.com",
  phone: "(11) 98888-7777",
  cpf: "12345678909",
  address_number: "100",
  email_pending: null,
  email_verified_at: "2026-11-26T12:05:00Z",
  email_link_sent_at: null,
  mail_enabled: true,
  payout_methods: [],
  unavailability: [],
  tool_ids: [],
  availability: [],
  transport: null,
  skills: MINE_E1,
  education: [],
  tech_profile_updated: { tools: null, availability: null, transport: null, skills: null, education: null },
};
/** O mesmo cadastro com a gestão (Entrega 2): aptidões com o id, áreas e documentos. */
const PROFILE_E2 = {
  ...PROFILE_E1,
  skills: MINE_E2,
  area_ids: [],
  documents: [],
  tech_profile_updated: { ...PROFILE_E1.tech_profile_updated, areas: null },
};

const userOf = (id) => ({ id, name: "Tecnico Alfa", email: "tecnico.alfa@exemplo.com", phone: "(11) 98888-7777", role: "technician" });
const tokensOf = (n, user) => ({ access_token: `acesso-${n}`, refresh_token: `renova-${n}`, token_type: "bearer", user });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Conta as leituras de GET /me/profile (o stub lê `server.profile` a cada GET). */
function countReads() {
  let value = server.profile;
  const counter = { reads: 0 };
  Object.defineProperty(server, "profile", {
    configurable: true,
    get() {
      counter.reads += 1;
      return value;
    },
    set(next) {
      value = next;
    },
  });
  return counter;
}

describe("hasCadastroE2: as duas ordens da publicação", () => {
  it("app novo com a API de antes: falso (Documentos, Currículo e Áreas \"Indisponível\"; Aptidões pelo nome)", () => {
    assert.equal(hasCadastroV2(PROFILE_E1), true);
    assert.equal(hasCadastroE2(PROFILE_E1), false);
    assert.equal(hasCadastroE2({ ...PROFILE_E1, documents: [] }), false);
    assert.equal(hasCadastroE2({ ...PROFILE_E1, area_ids: [] }), false);
    // As aptidões do servidor de antes vêm sem id: as chaves e o corpo vão pelo nome.
    const byId = hasCadastroE2(PROFILE_E1);
    assert.deepEqual(PROFILE_E1.skills.map(skillKey), ["nome:impressoras hp", "nome:linux"]);
    assert.deepEqual(skillsWithout(PROFILE_E1.skills, "nome:linux", byId), [{ name: "Impressoras HP", level: "avancado" }]);
  });

  it("app novo com a API nova: verdadeiro, e as aptidões vão pelo id", () => {
    assert.equal(hasCadastroE2(PROFILE_E2), true);
    const byId = hasCadastroE2(PROFILE_E2);
    assert.deepEqual(skillsWithout(PROFILE_E2.skills, `id:${ID.linux}`, byId), [{ skill_id: ID.printers, level: "avancado" }]);
  });

  it("sem o cadastro V2 ou sem o perfil técnico: falso", () => {
    assert.equal(hasCadastroE2(null), false);
    assert.equal(hasCadastroE2(undefined), false);
    const { cpf, ...withoutV2 } = PROFILE_E2;
    assert.equal(cpf, "12345678909");
    assert.equal(hasCadastroE2(withoutV2), false);
    assert.equal(hasCadastroE2({ ...PROFILE_E2, tech_profile_updated: null }), false);
  });
});

describe("profileChangedElsewhere (tempo real me.profile_changed)", () => {
  it("o evento é o do contrato", () => {
    assert.equal(ME_PROFILE_EVENT, "me.profile_changed");
  });

  it("com o cadastro na memória: avisos seguidos viram uma leitura, 0,4 s depois do último", async () => {
    await session.signIn(tokensOf(1, userOf("u1")));
    server.profile = PROFILE_E2;
    await loadProfile();
    assert.equal(getProfile().skills.length, 2);
    const counter = countReads();
    server.profile = { ...PROFILE_E2, area_ids: [ID.networks], tech_profile_updated: { ...PROFILE_E2.tech_profile_updated, areas: { at: "2026-11-26T15:00:00Z", via: "central" } } };
    profileChangedElsewhere();
    await sleep(200);
    profileChangedElsewhere();
    profileChangedElsewhere();
    await sleep(250);
    assert.equal(counter.reads, 0);
    await sleep(300);
    assert.equal(counter.reads, 1);
    assert.deepEqual(getProfile().area_ids, [ID.networks]);
    assert.equal(centralStampText(getProfile().tech_profile_updated.areas)?.startsWith("Atualizado pela central em "), true);
    await session.signOut();
  });

  it("sem o cadastro na memória (saiu da conta): nada", async () => {
    assert.equal(getProfile(), null);
    const counter = countReads();
    profileChangedElsewhere();
    await sleep(500);
    assert.equal(counter.reads, 0);
    assert.equal(getProfile(), null);
  });

  it("saiu da conta antes da releitura: nada sai", async () => {
    await session.signIn(tokensOf(2, userOf("u1")));
    server.profile = PROFILE_E2;
    await loadProfile();
    const counter = countReads();
    profileChangedElsewhere();
    await session.signOut();
    await sleep(500);
    assert.equal(counter.reads, 0);
    assert.equal(getProfile(), null);
  });

  it("uma leitura que já estava no ar quando o aviso chegou pode ser de antes da mudança: espera ela e lê de novo", async () => {
    await session.signIn(tokensOf(3, userOf("u1")));
    server.profile = PROFILE_E2;
    await loadProfile();
    const plainGet = stubApi.get;
    let reads = 0;
    // O servidor responde com o que tinha quando o pedido chegou, 0,6 s depois.
    stubApi.get = async (path) => {
      if (path !== "/me/profile") return plainGet(path);
      reads += 1;
      const answer = structuredClone(server.profile);
      await sleep(600);
      return answer;
    };
    try {
      const early = loadProfile();
      server.profile = { ...PROFILE_E2, area_ids: [ID.fiber] };
      profileChangedElsewhere();
      await early;
      assert.deepEqual(getProfile().area_ids, []);
      await sleep(900);
      assert.equal(reads, 2);
      assert.deepEqual(getProfile().area_ids, [ID.fiber]);
    } finally {
      stubApi.get = plainGet;
      await session.signOut();
    }
  });
});

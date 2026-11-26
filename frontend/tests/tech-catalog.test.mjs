// Os catálogos de Configurações › Técnicos (lib/techCatalog.ts): os textos e as rotas de cada um, os limites iguais a
// CATALOG_LIMITS de lib/constants.ts, o nome como o servidor grava e compara (core/text.clean e fold), quando dá para
// excluir (só o que nunca foi usado), a linha de uso e as dicas do diálogo, e o link da contagem para a lista de
// Técnicos. Dados fictícios. Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOG_LIMITS } from "../src/lib/constants.ts";
import {
  activeHint,
  CATALOG_NAME,
  canDeleteCatalogItem,
  catalogListHref,
  catalogNameKey,
  catalogNameLength,
  catalogUsageText,
  cleanCatalogName,
  renameHint,
  sameCatalogName,
  TECH_CATALOG_ORDER,
  TECH_CATALOGS,
} from "../src/lib/techCatalog.ts";

const ID = "3f2c8a1e-5b7d-4c9a-8e6f-1a2b3c4d5e6f";
const item = (over = {}) => ({ id: ID, name: "Redes e cabeamento", is_active: true, technicians: 0, applications: 0, in_use: false, ...over });

describe("TECH_CATALOGS", () => {
  it("a tabela do desenho, catálogo por catálogo", () => {
    const rows = TECH_CATALOG_ORDER.map((kind) => {
      const c = TECH_CATALOGS[kind];
      return [kind, c.title, c.column, c.newLabel, c.editTitle, c.search, c.empty, c.noMatch, c.duplicate, c.noun, c.path, c.queryKey, c.listParam];
    });
    assert.deepEqual(rows, [
      [
        "areas",
        "Áreas de atuação",
        "Área",
        "Nova área",
        "Editar área",
        "Buscar área",
        "Nenhuma área cadastrada",
        "Nenhuma área com este nome.",
        "Já existe uma área com este nome.",
        "Área",
        "/technician-areas",
        "technician-areas",
        "area",
      ],
      [
        "skills",
        "Aptidões",
        "Aptidão",
        "Nova aptidão",
        "Editar aptidão",
        "Buscar aptidão",
        "Nenhuma aptidão cadastrada",
        "Nenhuma aptidão com este nome.",
        "Já existe uma aptidão com este nome.",
        "Aptidão",
        "/technician-skills",
        "technician-skills",
        "aptidao",
      ],
      [
        "tools",
        "Ferramental",
        "Ferramenta",
        "Nova ferramenta",
        "Editar ferramenta",
        "Buscar ferramenta",
        "Nenhuma ferramenta cadastrada",
        "Nenhuma ferramenta com este nome.",
        "Já existe uma ferramenta com este nome.",
        "Ferramenta",
        "/technician-tools",
        "technician-tools",
        "ferramenta",
      ],
    ]);
  });

  it("os três, nesta ordem, e nenhum outro", () => {
    assert.deepEqual(TECH_CATALOG_ORDER, ["areas", "skills", "tools"]);
    assert.deepEqual(Object.keys(TECH_CATALOGS).sort(), ["areas", "skills", "tools"]);
  });

  it("os limites são os de CATALOG_LIMITS (= services/technician_catalogs.py)", () => {
    for (const kind of TECH_CATALOG_ORDER) assert.equal(TECH_CATALOGS[kind].max, CATALOG_LIMITS[kind], kind);
    assert.equal(CATALOG_NAME.max, CATALOG_LIMITS.name);
    assert.equal(CATALOG_NAME.min, 2);
  });

  it('sem "Skills" nem "Ex.:" nos textos da tela', () => {
    for (const kind of TECH_CATALOG_ORDER) {
      const { path, queryKey, listParam, max, ...texts } = TECH_CATALOGS[kind];
      assert.ok(path && queryKey && listParam && max);
      for (const text of Object.values(texts)) {
        assert.doesNotMatch(text, /skill/i, text);
        assert.doesNotMatch(text, /Ex\.:/, text);
      }
    }
  });
});

describe("o nome", () => {
  it("cleanCatalogName: pontas, espaços repetidos, quebras e invisíveis, NFC", () => {
    assert.equal(cleanCatalogName("  Fibra óptica "), "Fibra óptica");
    assert.equal(cleanCatalogName("Fibra\t\n  óptica"), "Fibra óptica");
    assert.equal(cleanCatalogName("Fibra​ óptica\u0000"), "Fibra óptica");
    // "ó" escrito como "o" + acento combinante vira uma letra só.
    assert.equal(cleanCatalogName("Fibra óptica"), "Fibra óptica");
    assert.equal(cleanCatalogName("Fibra óptica").length, "Fibra óptica".length);
  });

  it('sameCatalogName("Multímetro", " multimetro "): o mesmo para o catálogo (409 no servidor)', () => {
    assert.equal(sameCatalogName("Multímetro", " multimetro "), true);
    assert.equal(sameCatalogName("Redes  e cabeamento", "REDES E CABEAMENTO"), true);
    assert.equal(sameCatalogName("Multímetro", "Multímetros"), false);
    assert.equal(catalogNameKey(" Multímetro "), "multimetro");
  });

  it("catalogNameLength conta caracteres (um emoji é um só), depois de limpo", () => {
    assert.equal(catalogNameLength("  ab  "), 2);
    assert.equal(catalogNameLength("🔧"), 1);
    assert.equal(catalogNameLength("x".repeat(81)), 81);
  });
});

describe("excluir e uso", () => {
  it("canDeleteCatalogItem: só com in_use === false (null para o técnico; ausente na API de antes)", () => {
    assert.equal(canDeleteCatalogItem(item({ in_use: false })), true);
    assert.equal(canDeleteCatalogItem(item({ in_use: true })), false);
    assert.equal(canDeleteCatalogItem(item({ in_use: null })), false);
    assert.equal(canDeleteCatalogItem({ id: ID, name: "Escada", is_active: true, technicians: 0 }), false);
    // Já usado e hoje com ninguém: desativa, não exclui.
    assert.equal(canDeleteCatalogItem(item({ technicians: 0, applications: 0, in_use: true })), false);
  });

  it("catalogUsageText: técnicos e fichas, só técnicos, só fichas, já usada e nunca usada", () => {
    assert.equal(catalogUsageText(item({ technicians: 3, applications: 1, in_use: true })), "Em uso: 3 técnicos e 1 ficha.");
    assert.equal(catalogUsageText(item({ technicians: 1, applications: 0, in_use: true })), "Em uso: 1 técnico.");
    assert.equal(catalogUsageText(item({ technicians: 0, applications: 2, in_use: true })), "Em uso: 2 fichas.");
    assert.equal(catalogUsageText(item({ technicians: 0, applications: 0, in_use: true })), "Já foi usada: desative para tirar das escolhas.");
    assert.equal(catalogUsageText(item({ technicians: 0, applications: 0, in_use: false })), null);
    // API de antes (ferramental sem `applications` nem `in_use`).
    assert.equal(catalogUsageText({ technicians: 2 }), "Em uso: 2 técnicos.");
    assert.equal(catalogUsageText({ technicians: 0 }), null);
    assert.equal(catalogUsageText(item({ technicians: 1006, applications: 0, in_use: true })), "Em uso: 1.006 técnicos.");
  });

  it("renameHint com 0, 1 e 3", () => {
    assert.equal(renameHint(0), null);
    assert.equal(renameHint(null), null);
    assert.equal(renameHint(1), "Muda também para 1 técnico.");
    assert.equal(renameHint(3), "Muda também para 3 técnicos.");
  });

  it("activeHint com 0, 1 e 3: desativar, reativar e sem mudança", () => {
    assert.equal(activeHint(true, false, 0), null);
    assert.equal(activeHint(true, false, 1), "Sai das escolhas e fica guardada em 1 técnico.");
    assert.equal(activeHint(true, false, 3), "Sai das escolhas e fica guardada em 3 técnicos.");
    assert.equal(activeHint(false, true, 0), null);
    assert.equal(activeHint(false, true, 1), "Volta para 1 técnico.");
    assert.equal(activeHint(false, true, 3), "Volta para 3 técnicos.");
    assert.equal(activeHint(true, true, 3), null);
    assert.equal(activeHint(false, false, 3), null);
  });
});

describe("a contagem de técnicos vira o link da lista filtrada", () => {
  it("do item ativo com alguém: /tecnicos?{area|aptidao|ferramenta}={id}", () => {
    assert.equal(catalogListHref("areas", item({ technicians: 3 })), `/tecnicos?area=${ID}`);
    assert.equal(catalogListHref("skills", item({ technicians: 1 })), `/tecnicos?aptidao=${ID}`);
    assert.equal(catalogListHref("tools", item({ technicians: 2 })), `/tecnicos?ferramenta=${ID}`);
  });

  it("sem ninguém, desativado ou contagem null (técnico): sem link", () => {
    assert.equal(catalogListHref("areas", item({ technicians: 0 })), null);
    assert.equal(catalogListHref("areas", item({ technicians: 3, is_active: false })), null);
    assert.equal(catalogListHref("areas", item({ technicians: null })), null);
  });
});

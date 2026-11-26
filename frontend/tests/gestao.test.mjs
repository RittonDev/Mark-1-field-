// Gestão dos técnicos (Entrega 2) em lib/constants.ts (a mesma cópia do app): a validade das certificações (os casos
// do contrato, iguais aos do pytest), o tipo do arquivo, a média das avaliações, os rótulos e os limites dos catálogos,
// dos documentos e das avaliações, e o evento de tempo real do técnico. Dados fictícios.
// Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as C from "../src/lib/constants.ts";

const TODAY = "2026-11-26";
const unique = (list) => new Set(list).size === list.length;

/** O inteiro de uma constante de um módulo Python: `NOME = 80`, `NOME: int = 80` ou `OUTRO, NOME = 2, 80`. */
function pythonInt(text, name) {
  for (const m of text.matchAll(/^([A-Z_][A-Z0-9_]*(?:\s*,\s*[A-Z_][A-Z0-9_]*)*)\s*(?::[^=\n]*)?=\s*([^\n#]+)/gm)) {
    const names = m[1].split(",").map((part) => part.trim());
    const values = m[2].split(",").map((part) => part.trim());
    const i = names.indexOf(name);
    if (i >= 0 && names.length === values.length && /^\d+$/.test(values[i])) return Number(values[i]);
  }
  return undefined;
}

describe("validade da certificação (os casos do pytest, hoje 2026-11-26)", () => {
  const cases = [
    ["2026-11-25", "expired", -1, "Vencida em 25/11/2026"],
    ["2026-11-26", "soon", 0, "Vence hoje"],
    ["2026-11-27", "soon", 1, "Vence amanhã"],
    ["2026-12-26", "soon", 30, "Vence em 30 dias"],
    ["2026-12-27", "ok", 31, "Válida até 27/12/2026"],
  ];
  for (const [expiresOn, state, days, text] of cases) {
    it(`${expiresOn}: ${state}, ${days}, "${text}"`, () => {
      assert.deepEqual(C.documentDue(expiresOn, TODAY), { state, days });
      assert.equal(C.documentDueText(expiresOn, TODAY), text);
    });
  }

  it("sem validade, data que não existe ou fora do formato: null", () => {
    for (const value of [null, undefined, "", "2026-02-30", "2026-13-01", "26/11/2026", "2026-11-26T00:00:00Z"]) {
      assert.equal(C.documentDue(value, TODAY), null, String(value));
      assert.equal(C.documentDueText(value, TODAY), null, String(value));
    }
    assert.equal(C.documentDue("2026-11-26", ""), null);
    assert.equal(C.documentDueText("2026-11-26", "2026-02-30"), null);
  });

  it("o aviso vale até DOCUMENT_WARN_DAYS dias, inclusive", () => {
    assert.equal(C.DOCUMENT_WARN_DAYS, 30);
    assert.equal(C.documentDue("2026-12-26", TODAY)?.days, C.DOCUMENT_WARN_DAYS);
    assert.equal(C.documentDue("2026-12-26", TODAY)?.state, "soon");
    assert.equal(C.documentDue("2026-12-27", TODAY)?.state, "ok");
  });

  it("conta os dias pelo calendário: virada de mês e de ano, 29 de fevereiro", () => {
    assert.deepEqual(C.documentDue("2027-01-01", "2026-12-31"), { state: "soon", days: 1 });
    assert.deepEqual(C.documentDue("2028-03-01", "2028-02-28"), { state: "soon", days: 2 });
    assert.equal(C.documentDue("2027-02-29", TODAY), null);
    assert.deepEqual(C.documentDue("2025-11-26", TODAY), { state: "expired", days: -365 });
    assert.equal(C.documentDueText("2025-11-26", TODAY), "Vencida em 26/11/2025");
    assert.equal(C.documentDueText("2036-11-26", TODAY), "Válida até 26/11/2036");
  });
});

describe("documentos", () => {
  it("DOCUMENT_KIND: os 4 tipos, com rótulos únicos", () => {
    assert.deepEqual(C.DOCUMENT_KIND, {
      certification: "Certificação",
      personal: "Documento pessoal",
      resume: "Currículo",
      internal: "Anexo interno",
    });
    assert.ok(unique(Object.values(C.DOCUMENT_KIND)));
  });

  it("DOCUMENT_TITLE_SUGGESTIONS: certificação e documento pessoal, dentro do tamanho do título", () => {
    assert.deepEqual(C.DOCUMENT_TITLE_SUGGESTIONS, {
      certification: ["NR10", "NR35", "NR33", "NR12"],
      personal: ["RG", "CNH", "CPF", "Comprovante de residência"],
    });
    for (const list of Object.values(C.DOCUMENT_TITLE_SUGGESTIONS)) {
      assert.ok(unique(list));
      for (const title of list) {
        assert.ok(title.length >= C.DOCUMENT_LIMITS.titleMin && title.length <= C.DOCUMENT_LIMITS.titleMax, title);
      }
    }
  });

  it("DOCUMENT_LIMITS igual ao servidor (título de 81 caracteres passa do limite)", () => {
    assert.deepEqual(C.DOCUMENT_LIMITS, {
      maxMb: 10,
      titleMin: 2,
      titleMax: 80,
      perTechnician: 30,
      internal: 30,
      perFicha: 10,
      versions: 3,
    });
    assert.ok("a".repeat(81).length > C.DOCUMENT_LIMITS.titleMax);
  });

  it("DOCUMENT_ACCEPT: PDF, JPG, PNG e WebP; GIF, HEIC, XML e HTML ficam de fora", () => {
    const accepted = C.DOCUMENT_ACCEPT.split(",");
    assert.deepEqual(accepted, ["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    const refused = ["image/gif", "image/heic", "image/heif", "text/xml", "application/xml", "text/html", "image/svg+xml"];
    for (const type of refused) assert.ok(!accepted.includes(type), type);
  });

  it("documentFileKind: PDF ou Foto", () => {
    assert.equal(C.documentFileKind("application/pdf"), "PDF");
    for (const type of ["image/jpeg", "image/png", "image/webp"]) assert.equal(C.documentFileKind(type), "Foto", type);
  });
});

describe("avaliações", () => {
  it("ratingText: uma casa e vírgula (a média já vem arredondada do servidor)", () => {
    // [4, 5, 4, 4]: 4,25 vira 4,3 no servidor (ROUND_HALF_UP); [4]: 4.
    assert.equal(C.ratingText(4.3), "4,3");
    assert.equal(C.ratingText(4), "4,0");
    assert.equal(C.ratingText(4.6), "4,6");
    assert.equal(C.ratingText(5), "5,0");
    assert.equal(C.ratingText(1), "1,0");
  });

  it("RATING_LIMITS e RATING_SOURCE", () => {
    assert.deepEqual(C.RATING_LIMITS, { comment: 1000, rater: 120 });
    assert.deepEqual(C.RATING_SOURCE, { central: "Registrada pela central", client: "Enviada pelo cliente" });
  });
});

describe("catálogos e tempo real", () => {
  it("CATALOG_LIMITS; o Ferramental bate com o perfil técnico", () => {
    assert.deepEqual(C.CATALOG_LIMITS, { tools: 200, areas: 100, skills: 300, name: 80 });
    assert.equal(C.CATALOG_LIMITS.tools, C.TECH_PROFILE_LIMITS.tools);
    assert.equal(C.CATALOG_LIMITS.name, C.TECH_PROFILE_LIMITS.toolName);
    assert.equal(C.CATALOG_LIMITS.name, C.TECH_PROFILE_LIMITS.skillName);
    assert.equal(C.TECH_PROFILE_LIMITS.areas, 20);
    assert.ok(C.TECH_PROFILE_LIMITS.areas <= C.CATALOG_LIMITS.areas);
  });

  it("ME_PROFILE_EVENT: o evento do técnico", () => {
    assert.equal(C.ME_PROFILE_EVENT, "me.profile_changed");
  });

  it("textos: Aptidões (nunca Skills) e sem \"Ex.:\"", () => {
    const texts = [
      ...Object.values(C.DOCUMENT_KIND),
      ...Object.values(C.DOCUMENT_TITLE_SUGGESTIONS).flat(),
      ...Object.values(C.RATING_SOURCE),
      C.TECH_PROFILE_PART.areas,
    ];
    for (const text of texts) assert.ok(!/skill|Ex\.:/i.test(text), text);
  });

  it("pythonInt (a leitura do backend abaixo) entende as três formas", () => {
    const text = 'NAME_MIN, NAME_MAX = 2, 80\nMAX_AREAS = 20\nLIMIT: int = 5  # comentário\nNAME_TOO_LONG = f"No máximo {NAME_MAX}"\n';
    assert.equal(pythonInt(text, "NAME_MIN"), 2);
    assert.equal(pythonInt(text, "NAME_MAX"), 80);
    assert.equal(pythonInt(text, "MAX_AREAS"), 20);
    assert.equal(pythonInt(text, "LIMIT"), 5);
    assert.equal(pythonInt(text, "MAX_ITEMS"), undefined);
  });

  const catalogs = new URL("../../backend/app/services/technician_catalogs.py", import.meta.url);
  it(
    "CATALOG_LIMITS e TECH_PROFILE_LIMITS.areas iguais a services/technician_catalogs.py",
    { skip: !existsSync(catalogs) && "backend/app/services/technician_catalogs.py ausente" },
    () => {
      const text = readFileSync(catalogs, "utf8");
      const items = /^MAX_ITEMS[^=\n]*=\s*\{([^}]*)\}/m.exec(text);
      assert.ok(items, "MAX_ITEMS não encontrado em backend/app/services/technician_catalogs.py");
      const limits = Object.fromEntries([...items[1].matchAll(/"(\w+)":\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
      const { tools, areas, skills } = C.CATALOG_LIMITS;
      assert.deepEqual(limits, { tool: tools, area: areas, skill: skills });
      assert.equal(pythonInt(text, "NAME_MAX"), C.CATALOG_LIMITS.name);
      assert.equal(pythonInt(text, "MAX_AREAS"), C.TECH_PROFILE_LIMITS.areas);
    },
  );
});

// Sonda das seções do Histórico de atendimentos (src/lib/historySections.ts): as páginas juntas sem repetir, o total
// de cada mês e as seções na ordem da lista. O módulo é puro e sem import, para rodar direto no Node. Dados fictícios.
// Sem dependência nova: node:test. Na pasta mobile:
// node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { historySections, mergeCounts, mergeItems } from "../src/lib/historySections.ts";

const item = (id, month) => ({ id, month, code: `OS-${id}` });

describe("mergeItems", () => {
  it("junta a página nova sem repetir as OS que já estavam, na ordem em que chegaram", () => {
    const first = [item("000125", "2026-11"), item("000124", "2026-11")];
    const next = [item("000124", "2026-11"), item("000123", "2026-10"), item("000122", "2026-10"), item("000123", "2026-10")];
    const merged = mergeItems(first, next);
    assert.deepEqual(
      merged.map((entry) => entry.id),
      ["000125", "000124", "000123", "000122"],
    );
    assert.equal(merged[1], first[1], "a que já estava fica como estava");
  });

  it("sem nada novo, devolve a mesma lista", () => {
    const first = [item("000125", "2026-11")];
    assert.equal(mergeItems(first, [item("000125", "2026-11")]), first);
    assert.equal(mergeItems(first, []), first);
  });
});

describe("mergeCounts", () => {
  it("o total da página mais nova vale; os meses novos entram no fim", () => {
    const current = [
      { month: "2026-11", count: 6 },
      { month: "2026-10", count: 10 },
    ];
    const next = [
      { month: "2026-10", count: 11 },
      { month: "2026-09", count: 4 },
    ];
    assert.deepEqual(mergeCounts(current, next), [
      { month: "2026-11", count: 6 },
      { month: "2026-10", count: 11 },
      { month: "2026-09", count: 4 },
    ]);
    assert.deepEqual(mergeCounts([], next), next);
    assert.deepEqual(mergeCounts(current, []), current);
  });
});

describe("historySections", () => {
  it("agrupa em sequência, pelo mês da conclusão, na ordem da lista", () => {
    const items = [item("6", "2026-11"), item("5", "2026-11"), item("4", "2026-10"), item("3", "2026-09"), item("2", "2026-09")];
    const sections = historySections(items, [
      { month: "2026-11", count: 6 },
      { month: "2026-10", count: 10 },
      { month: "2026-09", count: 2 },
    ]);
    assert.deepEqual(
      sections.map((section) => [section.month, section.count, section.data.map((entry) => entry.id)]),
      [
        ["2026-11", 6, ["6", "5"]],
        ["2026-10", 10, ["4"]],
        ["2026-09", 2, ["3", "2"]],
      ],
    );
  });

  it("usa o total do mês, ou o número de OS já carregadas quando o total é menor ou não veio", () => {
    const items = [item("3", "2026-11"), item("2", "2026-11"), item("1", "2026-10")];
    const sections = historySections(items, [{ month: "2026-11", count: 1 }]);
    assert.deepEqual(
      sections.map((section) => [section.month, section.count]),
      [
        ["2026-11", 2],
        ["2026-10", 1],
      ],
    );
  });

  it("lista vazia, nenhuma seção", () => {
    assert.deepEqual(historySections([], [{ month: "2026-11", count: 3 }]), []);
  });
});

describe("módulo puro", () => {
  it("historySections.ts não importa nada (roda direto no Node)", () => {
    const source = readFileSync(new URL("../src/lib/historySections.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\brequire\(/);
  });
});

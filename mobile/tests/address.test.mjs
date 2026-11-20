// Sonda da busca da área da oferta no app de mapas (lib/address.ts, só com import type): bairro e cidade, nunca o
// endereço. Dados fictícios.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { areaQuery } from "../src/lib/address.ts";

describe("areaQuery: o que o botão do mapa da oferta busca", () => {
  it("bairro, cidade e UF", () => {
    assert.equal(areaQuery({ district: "Centro", city: "Cidade Exemplo", state: "SP" }), "Centro, Cidade Exemplo - SP");
  });

  it("sem bairro, só a cidade com a UF", () => {
    assert.equal(areaQuery({ district: null, city: "Cidade Exemplo", state: "SP" }), "Cidade Exemplo - SP");
    assert.equal(areaQuery({ city: "Cidade Exemplo", state: "SP" }), "Cidade Exemplo - SP");
  });

  it("sem UF, bairro e cidade", () => {
    assert.equal(areaQuery({ district: "Centro", city: "Cidade Exemplo", state: null }), "Centro, Cidade Exemplo");
  });

  it("sem cidade não há busca (a tela não mostra o botão)", () => {
    assert.equal(areaQuery({ district: "Centro", city: null, state: "SP" }), null);
    assert.equal(areaQuery({ district: "Centro", city: "   ", state: "SP" }), null);
    assert.equal(areaQuery({}), null);
  });

  it("espaços em volta saem; campo só com espaços conta como vazio", () => {
    assert.equal(areaQuery({ district: "  Centro ", city: " Cidade Exemplo ", state: " SP " }), "Centro, Cidade Exemplo - SP");
    assert.equal(areaQuery({ district: "  ", city: "Cidade Exemplo", state: "" }), "Cidade Exemplo");
  });
});

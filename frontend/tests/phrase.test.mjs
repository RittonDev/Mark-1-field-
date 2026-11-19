// Frase da busca da central (a Mia), sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_NAME, dropWords, normalizeText, stripAgentName } from "../src/components/home/phrase.ts";

describe("stripAgentName", () => {
  it("tira o nome da agente do começo da frase, com pontuação depois ou saudação antes", () => {
    assert.equal(stripAgentName("Mia, atrasadas em campinas"), "atrasadas em campinas");
    assert.equal(stripAgentName("oi mia sem técnico"), "sem técnico");
    assert.equal(stripAgentName("Olá, Mia! agendadas amanhã"), "agendadas amanhã");
    assert.equal(stripAgentName("MIA: 16976"), "16976");
    assert.equal(stripAgentName("e aí Mia, pendente pgto"), "pendente pgto");
  });

  it("aceita a pontuação colada no texto; o ponto, só com espaço depois", () => {
    assert.equal(stripAgentName("Mia,16976"), "16976");
    assert.equal(stripAgentName("Mia,atrasadas"), "atrasadas");
    assert.equal(stripAgentName("Mia , atrasadas"), "atrasadas");
    assert.equal(stripAgentName("ei, mia: sem técnico"), "sem técnico");
    assert.equal(stripAgentName("Mia. atrasadas"), "atrasadas");
    assert.equal(stripAgentName("Mia... atrasadas"), "atrasadas");
    assert.equal(stripAgentName("oi mia. agendadas"), "agendadas");
    assert.equal(stripAgentName("mia!"), "");
  });

  it("deixa a frase igual quando o nome é parte do que se procura", () => {
    for (const text of [
      "mia",
      "mia atrasadas",
      "Miami",
      "Miami, loja 41",
      "técnico mia",
      "oi miami",
      "mia.com.br",
      "mia.silva@exemplo.com",
      "MIA.01",
      "Mia.01 centro",
      "oi mia.com.br",
    ]) {
      assert.equal(stripAgentName(text), text);
    }
  });

  it("usa o nome da agente", () => {
    assert.equal(AGENT_NAME, "Mia");
  });
});

describe("dropWords", () => {
  it("tira as palavras sem acento, sem maiúscula e sem a pontuação colada", () => {
    assert.equal(dropWords("quantas OS atrasadas em campinas?", "quantas"), "OS atrasadas em campinas?");
    assert.equal(dropWords("Quantas estão sem técnico", "Quantas estão"), "sem técnico");
    assert.equal(dropWords("IMPRESSAO atrasadas", "impressão"), "atrasadas");
    assert.equal(dropWords("“quantas?” atrasadas", "quantas"), "atrasadas");
  });

  it("devolve a frase igual quando não há o que tirar", () => {
    assert.equal(dropWords("atrasadas campinas", "xyz"), "atrasadas campinas");
    assert.equal(dropWords("atrasadas  campinas", "xyz"), "atrasadas  campinas");
  });
});

describe("normalizeText", () => {
  it("tira acento, maiúscula e os espaços das pontas", () => {
    assert.equal(normalizeText("  Técnico "), "tecnico");
    assert.equal(normalizeText("Ação São João"), "acao sao joao");
  });
});

// Frase da busca da central (o Maxx Agent), sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_NAME, dropWords, normalizeText, stripAgentName } from "../src/components/home/phrase.ts";

describe("stripAgentName", () => {
  it("tira o nome do agente do começo da frase, com pontuação depois ou saudação antes", () => {
    assert.equal(stripAgentName("Maxx Agent, atrasadas em campinas"), "atrasadas em campinas");
    assert.equal(stripAgentName("oi maxx agent sem técnico"), "sem técnico");
    assert.equal(stripAgentName("Olá, Maxx Agent! agendadas amanhã"), "agendadas amanhã");
    assert.equal(stripAgentName("MAXX AGENT: 16976"), "16976");
    assert.equal(stripAgentName("e aí Maxx Agent, pendente pgto"), "pendente pgto");
  });

  it("aceita a pontuação colada no texto e espaço a mais no nome; o ponto, só com espaço depois", () => {
    assert.equal(stripAgentName("Maxx Agent,16976"), "16976");
    assert.equal(stripAgentName("Maxx Agent,atrasadas"), "atrasadas");
    assert.equal(stripAgentName("Maxx Agent , atrasadas"), "atrasadas");
    assert.equal(stripAgentName("Maxx  Agent, atrasadas"), "atrasadas");
    assert.equal(stripAgentName("ei, maxx agent: sem técnico"), "sem técnico");
    assert.equal(stripAgentName("Maxx Agent. atrasadas"), "atrasadas");
    assert.equal(stripAgentName("Maxx Agent... atrasadas"), "atrasadas");
    assert.equal(stripAgentName("oi maxx agent. agendadas"), "agendadas");
    assert.equal(stripAgentName("maxx agent!"), "");
  });

  it("deixa a frase igual quando o nome é parte do que se procura", () => {
    for (const text of [
      "maxx agent",
      "maxx agent atrasadas",
      "Maxx Agentes",
      "Maxx Agentes, loja 41",
      "técnico maxx agent",
      "oi maxx agentes",
      "maxx agent.com.br",
      "Maxx Agent.01 centro",
      "oi maxx agent.com.br",
      "Maxx, loja 41",
      "Maxx Group",
    ]) {
      assert.equal(stripAgentName(text), text);
    }
  });

  it("usa o nome do agente", () => {
    assert.equal(AGENT_NAME, "Maxx Agent");
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

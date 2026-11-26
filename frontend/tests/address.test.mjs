// CEP sobre os formulários da central em linha (lib/address.ts): Clientes e Locais ("line": rua, número e complemento num
// campo) e Configurações › Empresa ("company": o endereço inteiro). O modo em partes (cepFill de constants.ts) é testado em
// cadastro.test.mjs. Endereço público de exemplo (o CEP da Praça da Sé) e cidade fictícia.
// Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADDRESS_SLOTS,
  cepDigits,
  cepFromLine,
  cepLineFill,
  companyLineFill,
  companyLineFromCep,
  companyLineWithCep,
  NO_ADDRESS,
} from "../src/lib/address.ts";

/** CEP de logradouro (com acento, para a comparação sem acento) e CEP geral da cidade. */
const SE = { cep: "01001-000", street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP" };
const GENERAL = { cep: "13000-000", street: null, district: null, city: "Cidade Exemplo", state: "SP" };
const NONE = new Set();
const EVERY = new Set(ADDRESS_SLOTS);

describe("cepDigits", () => {
  it("só os números, até 8", () => {
    assert.equal(cepDigits("01001-0009"), "01001000");
    assert.equal(cepDigits(" 01.001-000 "), "01001000");
    assert.equal(cepDigits("0100"), "0100");
    assert.equal(cepDigits(""), "");
  });
});

describe("cepLineFill (Clientes e Locais)", () => {
  it("tudo vazio: a linha recebe o logradouro e os 3 campos o resto, sem conflito", () => {
    const { next, filled, differs } = cepLineFill(NO_ADDRESS, NO_ADDRESS, NONE, SE);
    assert.deepEqual(next, { street: "Praça da Sé, ", district: "Sé", city: "São Paulo", state: "SP" });
    assert.deepEqual(filled, ["street", "district", "city", "state"]);
    assert.equal(differs, false);
  });

  it("a linha que já começa pelo logradouro fica (com o número), sem conflito", () => {
    const current = { ...NO_ADDRESS, street: "Praça da Sé, 100" };
    const { next, filled, differs } = cepLineFill(current, NO_ADDRESS, NONE, SE);
    assert.equal(next.street, "Praça da Sé, 100");
    assert.ok(!filled.includes("street"));
    assert.equal(differs, false);
    // Sem acento, em maiúsculas e sem vírgula também vale.
    assert.equal(cepLineFill({ ...NO_ADDRESS, street: "PRACA DA SE 100" }, NO_ADDRESS, NONE, SE).differs, false);
  });

  it("a linha digitada com outro logradouro fica e marca o conflito", () => {
    const current = { ...NO_ADDRESS, street: "Rua Exemplo, 10" };
    const { next, filled, differs } = cepLineFill(current, NO_ADDRESS, NONE, SE);
    assert.equal(next.street, "Rua Exemplo, 10");
    assert.deepEqual(filled, ["district", "city", "state"]);
    assert.equal(differs, true);
  });

  it("um logradouro que só começa igual não conta como o mesmo", () => {
    const rua7 = { ...SE, street: "Rua 7" };
    assert.equal(cepLineFill({ ...NO_ADDRESS, street: "Rua 70, 12" }, NO_ADDRESS, NONE, rua7).differs, true);
    assert.equal(cepLineFill({ ...NO_ADDRESS, street: "Rua 7, 12" }, NO_ADDRESS, NONE, rua7).differs, false);
  });

  it("Usar este endereço (todos livres): a linha volta para o logradouro e os campos são trocados", () => {
    const current = { street: "Rua Exemplo, 10", district: "Centro", city: "Cidade Exemplo", state: "RJ" };
    const { next, differs } = cepLineFill(current, NO_ADDRESS, EVERY, SE);
    assert.deepEqual(next, { street: "Praça da Sé, ", district: "Sé", city: "São Paulo", state: "SP" });
    assert.equal(differs, false);
  });

  it("o que está igual ao aberto (o gravado) é trocado", () => {
    const opened = { street: "Rua Exemplo, 10", district: "Centro", city: "Cidade Exemplo", state: "RJ" };
    const { next, differs } = cepLineFill(opened, opened, NONE, SE);
    assert.deepEqual(next, { street: "Praça da Sé, ", district: "Sé", city: "São Paulo", state: "SP" });
    assert.equal(differs, false);
  });

  it("o campo da busca anterior (auto) conta como livre", () => {
    const current = { street: "Rua Exemplo, ", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "RJ" };
    const { next, differs } = cepLineFill(current, NO_ADDRESS, new Set(["street", "district"]), SE);
    assert.equal(next.street, "Praça da Sé, ");
    assert.equal(next.district, "Sé");
    // Cidade e UF digitadas ficam: diferem do CEP.
    assert.equal(next.city, "Cidade Exemplo");
    assert.equal(differs, true);
  });

  it("bairro, cidade e UF digitados iguais ao CEP (sem acento, maiúsculas, espaços) não são conflito", () => {
    const current = { street: "", district: " se ", city: "SAO  PAULO", state: "sp" };
    const { next, filled, differs } = cepLineFill(current, NO_ADDRESS, NONE, SE);
    assert.deepEqual(filled, ["street"]);
    assert.equal(next.city, "SAO  PAULO");
    assert.equal(differs, false);
  });

  it("CEP geral (sem logradouro): não mexe na linha nem no bairro", () => {
    const current = { street: "Rua Exemplo, 10", district: "Centro", city: "", state: "" };
    const { next, filled, differs } = cepLineFill(current, NO_ADDRESS, NONE, GENERAL);
    assert.deepEqual(next, { street: "Rua Exemplo, 10", district: "Centro", city: "Cidade Exemplo", state: "SP" });
    assert.deepEqual(filled, ["city", "state"]);
    assert.equal(differs, false);
  });

  it("não muda o objeto recebido", () => {
    const current = { ...NO_ADDRESS };
    cepLineFill(current, NO_ADDRESS, NONE, SE);
    assert.deepEqual(current, NO_ADDRESS);
  });
});

describe("companyLineFromCep (Configurações › Empresa)", () => {
  it("logradouro - bairro - cidade - UF, CEP; cursor no fim do logradouro", () => {
    assert.deepEqual(companyLineFromCep(SE), { text: "Praça da Sé - Sé - São Paulo - SP, 01001-000", caret: 11 });
  });

  it("CEP geral: só a cidade, cursor no começo", () => {
    assert.deepEqual(companyLineFromCep(GENERAL), { text: "Cidade Exemplo - SP, 13000-000", caret: 0 });
  });

  it("CEP só com números vira 00000-000", () => {
    assert.equal(companyLineFromCep({ ...SE, cep: "01001000" }).text, "Praça da Sé - Sé - São Paulo - SP, 01001-000");
  });
});

describe("cepFromLine", () => {
  it("acha o CEP com e sem hífen", () => {
    assert.equal(cepFromLine("Praça da Sé, 100 - Sé - São Paulo - SP, 01001-000"), "01001-000");
    assert.equal(cepFromLine("Praça da Sé, 100 - São Paulo - SP 01001000"), "01001-000");
  });

  it("sem CEP: vazio", () => {
    assert.equal(cepFromLine("Rua Exemplo, 10 - Centro - Cidade Exemplo - SP"), "");
    assert.equal(cepFromLine(""), "");
  });

  it("o último CEP da linha; número maior (telefone) não conta", () => {
    assert.equal(cepFromLine("01001-000 e 13000-000"), "13000-000");
    assert.equal(cepFromLine("Rua Exemplo, 10 - tel. 11999990000"), "");
    assert.equal(cepFromLine("Rua Exemplo, 10 - 123456789"), "");
  });
});

describe("companyLineFill", () => {
  it("linha vazia recebe o endereço do CEP", () => {
    assert.deepEqual(companyLineFill("  ", SE), {
      next: { line: "Praça da Sé - Sé - São Paulo - SP, 01001-000", caret: 11 },
      differs: false,
    });
  });

  it("com o logradouro: fica, com o CEP acrescentado no fim", () => {
    const { next, differs } = companyLineFill("Praça da Sé, 100 - Sé - São Paulo - SP", SE);
    assert.equal(next?.line, "Praça da Sé, 100 - Sé - São Paulo - SP, 01001-000");
    assert.equal(differs, false);
  });

  it("com o logradouro e outro CEP: o CEP da linha é trocado", () => {
    const { next } = companyLineFill("PRACA DA SE, 100 - São Paulo - SP, 01001-001", SE);
    assert.equal(next?.line, "PRACA DA SE, 100 - São Paulo - SP, 01001-000");
  });

  it("com o logradouro e o mesmo CEP (até sem hífen): nada muda", () => {
    assert.deepEqual(companyLineFill("Praça da Sé, 100 - São Paulo - SP, 01001-000", SE), { next: null, differs: false });
    assert.deepEqual(companyLineFill("Praça da Sé, 100 - São Paulo - SP 01001000", SE), { next: null, differs: false });
  });

  it("sem o logradouro: fica e marca o conflito", () => {
    assert.deepEqual(companyLineFill("Rua Exemplo, 10 - Centro - Cidade Exemplo - SP", SE), { next: null, differs: true });
  });

  it("CEP geral: confere pela cidade", () => {
    assert.equal(companyLineFill("Rua Exemplo, 10 - Centro - Cidade Exemplo - SP", GENERAL).differs, false);
    assert.equal(companyLineFill("Rua Exemplo, 10 - Centro - Outra Cidade - SP", GENERAL).differs, true);
  });
});

describe("companyLineWithCep (o CEP digitado vai para a linha ao salvar, com a busca ou sem ela)", () => {
  it("sem CEP na linha: acrescenta no fim, sem separador repetido", () => {
    assert.equal(companyLineWithCep("Rua Exemplo, 10 - Cidade Exemplo - SP", "13000-000"), "Rua Exemplo, 10 - Cidade Exemplo - SP, 13000-000");
    assert.equal(companyLineWithCep("Rua Exemplo, 10 - ", "13000000"), "Rua Exemplo, 10, 13000-000");
  });

  it("com outro CEP: troca o último; com o mesmo (até sem hífen), a linha fica como está", () => {
    assert.equal(companyLineWithCep("Rua Exemplo, 10 - SP, 13000-001", "13000-000"), "Rua Exemplo, 10 - SP, 13000-000");
    assert.equal(companyLineWithCep("Rua Exemplo, 10 - SP 13000000", "13000-000"), "Rua Exemplo, 10 - SP 13000000");
  });

  it("linha vazia: só o CEP", () => {
    assert.equal(companyLineWithCep("", "13000-000"), "13000-000");
  });
});

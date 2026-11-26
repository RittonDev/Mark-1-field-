// CEP sobre os formulários da central em linha (lib/address.ts): Clientes e Locais ("line": rua, número e complemento num
// campo; a linha gravada não é trocada sozinha) e Configurações › Empresa ("company": o endereço inteiro, com o campo CEP
// acompanhando a linha). Também a linha gravada sem a vírgula do fim e o número do endereço. O modo em partes (cepFill de
// constants.ts) é testado em cadastro.test.mjs. Endereço público de exemplo (o CEP da Praça da Sé) e cidade fictícia.
// Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADDRESS_SLOTS,
  cepDigits,
  cepFromLine,
  cepIncomplete,
  cepLineFill,
  companyCepAfterEdit,
  companyLineFill,
  companyLineFromCep,
  companyLineToSave,
  companyLineWithCep,
  NO_ADDRESS,
  normalizeAddressNumber,
  tidyLine,
} from "../src/lib/address.ts";

/** CEP de logradouro (com acento, para a comparação sem acento) e CEP geral da cidade. */
const SE = { cep: "01001-000", street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP" };
const GENERAL = { cep: "13000-000", street: null, district: null, city: "Cidade Exemplo", state: "SP" };
/** Loja de exemplo com o logradouro escrito por extenso no CEP. */
const AVENIDA = { cep: "13000-100", street: "Avenida Exemplo", district: "Centro Exemplo", city: "Cidade Exemplo", state: "SP" };
const NONE = new Set();
const EVERY = new Set(ADDRESS_SLOTS);

/**
 * As buscas em sequência como o CepField faz: guarda o que cada uma pôs e passa, na seguinte, os campos que ainda têm
 * esse valor como `auto` e `stale`. `edit` muda a tela entre uma busca e outra (a pessoa digitando).
 */
function lookups(start, opened, steps) {
  let current = { ...start };
  const applied = {};
  let last = null;
  for (const step of steps) {
    if (step.edit) {
      current = { ...current, ...step.edit };
      continue;
    }
    const auto = new Set(ADDRESS_SLOTS.filter((key) => applied[key] !== undefined && applied[key] !== "" && current[key] === applied[key]));
    last = cepLineFill(current, opened, auto, step.cep, auto);
    for (const key of last.filled) applied[key] = last.next[key];
    current = last.next;
  }
  return { ...last, next: current };
}

describe("cepDigits", () => {
  it("só os números, até 8", () => {
    assert.equal(cepDigits("01001-0009"), "01001000");
    assert.equal(cepDigits(" 01.001-000 "), "01001000");
    assert.equal(cepDigits("0100"), "0100");
    assert.equal(cepDigits(""), "");
  });

  it("cepIncomplete: de 1 a 7 números (vazio e completo não)", () => {
    assert.equal(cepIncomplete("01001-00"), true);
    assert.equal(cepIncomplete("0"), true);
    assert.equal(cepIncomplete(""), false);
    assert.equal(cepIncomplete("01001-000"), false);
    assert.equal(cepIncomplete("01001000"), false);
  });
});

describe("tidyLine (Clientes e Locais gravam a linha sem separador sobrando no fim)", () => {
  it("o \"{logradouro}, \" do CEP salvo sem o número perde a vírgula", () => {
    assert.equal(tidyLine("Praça da Sé, "), "Praça da Sé");
    assert.equal(tidyLine("Praça da Sé,"), "Praça da Sé");
  });

  it("hífen, ponto e vírgula e espaços do fim (e do começo) saem; o meio fica", () => {
    assert.equal(tidyLine("  Rua Exemplo, 10 - "), "Rua Exemplo, 10");
    assert.equal(tidyLine("Rua Exemplo, 10;"), "Rua Exemplo, 10");
    assert.equal(tidyLine("Rua Exemplo, 10 - Loja 2"), "Rua Exemplo, 10 - Loja 2");
    assert.equal(tidyLine("Rua Exemplo, S/N"), "Rua Exemplo, S/N");
  });

  it("só separadores: vazio", () => {
    assert.equal(tidyLine(" , - "), "");
    assert.equal(tidyLine(""), "");
  });

  it("a busca no mapa monta sem a vírgula dobrada", () => {
    const query = [tidyLine("Praça da Sé, "), "Sé", "São Paulo", "SP", "01001-000"].filter(Boolean).join(", ");
    assert.equal(query, "Praça da Sé, Sé, São Paulo, SP, 01001-000");
  });
});

describe("normalizeAddressNumber (= personal.normalize_address_number)", () => {
  it("em maiúsculas", () => {
    assert.equal(normalizeAddressNumber("100a"), "100A");
    assert.equal(normalizeAddressNumber(" 12  b "), "12 B");
  });

  it("\"SN\" e \"S / N\" viram \"S/N\"", () => {
    assert.equal(normalizeAddressNumber("s/n"), "S/N");
    assert.equal(normalizeAddressNumber("sn"), "S/N");
    assert.equal(normalizeAddressNumber("S / N"), "S/N");
    assert.equal(normalizeAddressNumber("SNA"), "SNA");
  });

  it("vazio fica vazio", () => {
    assert.equal(normalizeAddressNumber("  "), "");
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

  it("a linha gravada (igual à aberta) com outro logradouro fica, com bairro, cidade e UF gravados, e marca o conflito", () => {
    const opened = { street: "Rua Exemplo, 10", district: "Centro", city: "Cidade Exemplo", state: "RJ" };
    const { next, filled, differs } = cepLineFill(opened, opened, NONE, SE);
    assert.deepEqual(next, opened);
    assert.deepEqual(filled, []);
    assert.equal(differs, true);
  });

  it("loja gravada com abreviação (\"AV\", \"R.\"): o número e o complemento ficam; conflito", () => {
    const opened = { street: "AV EXEMPLO, 1500 - LOJA 12", district: "Centro", city: "Cidade Exemplo", state: "SP" };
    const loja = cepLineFill(opened, opened, NONE, AVENIDA);
    assert.equal(loja.next.street, "AV EXEMPLO, 1500 - LOJA 12");
    // O bairro gravado não troca com a linha em conflito (a rua de antes com o bairro do CEP).
    assert.equal(loja.next.district, "Centro");
    assert.deepEqual(loja.filled, []);
    assert.equal(loja.differs, true);

    const sala = { street: "R. Exemplo, 123 - Sala 4", district: "", city: "", state: "" };
    const { next, filled, differs } = cepLineFill(sala, sala, NONE, { ...AVENIDA, street: "Rua Exemplo" });
    assert.equal(next.street, "R. Exemplo, 123 - Sala 4");
    // Os vazios recebem o valor mesmo com a linha em conflito.
    assert.deepEqual(filled, ["district", "city", "state"]);
    assert.equal(differs, true);
  });

  it("linha gravada que já começa pelo logradouro: fica; bairro, cidade e UF gravados seguem o CEP", () => {
    const opened = { street: "Praça da Sé, 100 - Loja 2", district: "Centro", city: "São Paulo", state: "SP" };
    const { next, filled, differs } = cepLineFill(opened, opened, NONE, SE);
    assert.deepEqual(next, { ...opened, district: "Sé" });
    assert.deepEqual(filled, ["district"]);
    assert.equal(differs, false);
  });

  it("CEP errado e depois o certo, num cadastro gravado: a linha com o número e a loja fica", () => {
    const opened = { street: "Praça da Sé, 100 - Loja 2", district: "Sé", city: "São Paulo", state: "SP" };
    const wrong = { cep: "13000-200", street: "Rua Errada", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "SP" };
    const first = cepLineFill(opened, opened, NONE, wrong);
    assert.deepEqual(first.next, opened);
    assert.equal(first.differs, true);
    const { next, differs } = lookups(opened, opened, [{ cep: wrong }, { cep: SE }]);
    assert.deepEqual(next, opened);
    assert.equal(differs, false);
  });

  it("CEP certo e depois outro, num cadastro novo: a linha da busca anterior (sem número) troca", () => {
    const other = { cep: "13000-300", street: "Rua Exemplo", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "SP" };
    const { next, differs } = lookups(NO_ADDRESS, NO_ADDRESS, [{ cep: SE }, { cep: other }]);
    assert.deepEqual(next, { street: "Rua Exemplo, ", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "SP" });
    assert.equal(differs, false);
  });

  it("com o número digitado depois da busca, outro CEP não troca a linha: conflito", () => {
    const other = { cep: "13000-300", street: "Rua Exemplo", district: "Bairro Exemplo", city: "Cidade Exemplo", state: "SP" };
    const { next, differs } = lookups(NO_ADDRESS, NO_ADDRESS, [{ cep: SE }, { edit: { street: "Praça da Sé, 100" } }, { cep: other }]);
    assert.equal(next.street, "Praça da Sé, 100");
    // Bairro, cidade e UF ainda eram da busca anterior: seguem o CEP novo.
    assert.equal(next.district, "Bairro Exemplo");
    assert.equal(next.city, "Cidade Exemplo");
    assert.equal(differs, true);
  });

  it("CEP geral depois de CEP específico: a linha e o bairro da busca anterior saem; o digitado fica", () => {
    const fresh = lookups(NO_ADDRESS, NO_ADDRESS, [{ cep: SE }, { cep: GENERAL }]);
    assert.deepEqual(fresh.next, { street: "", district: "", city: "Cidade Exemplo", state: "SP" });
    assert.deepEqual(fresh.filled, ["street", "district", "city"]);
    assert.equal(fresh.differs, false);

    const typed = lookups(NO_ADDRESS, NO_ADDRESS, [{ cep: SE }, { edit: { street: "Praça da Sé, 100" } }, { cep: GENERAL }]);
    assert.deepEqual(typed.next, { street: "Praça da Sé, 100", district: "", city: "Cidade Exemplo", state: "SP" });
    assert.deepEqual(typed.filled, ["district", "city"]);
  });

  it("\"Usar este endereço\" (todos em auto) com CEP geral: só o stale esvazia, nunca o auto", () => {
    const current = { street: "Rua Exemplo, 10", district: "Centro", city: "Outra Cidade", state: "RJ" };
    const used = cepLineFill(current, NO_ADDRESS, EVERY, GENERAL);
    assert.deepEqual(used.next, { street: "Rua Exemplo, 10", district: "Centro", city: "Cidade Exemplo", state: "SP" });
    const stale = cepLineFill(current, NO_ADDRESS, EVERY, GENERAL, new Set(["district"]));
    assert.deepEqual(stale.next, { street: "Rua Exemplo, 10", district: "", city: "Cidade Exemplo", state: "SP" });
    assert.deepEqual(stale.filled, ["district", "city", "state"]);
  });

  it("o gravado (igual ao aberto) não é stale: o CEP geral não o esvazia", () => {
    const opened = { street: "Rua Exemplo, 10", district: "Centro", city: "Cidade Exemplo", state: "SP" };
    const { next, filled } = cepLineFill(opened, opened, NONE, GENERAL, NONE);
    assert.deepEqual(next, opened);
    assert.deepEqual(filled, []);
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

describe("Configurações › Empresa: o campo CEP acompanha o CEP escrito na linha", () => {
  const BEFORE = "Praça da Sé, 100 - São Paulo - SP, 01001-000";

  it("CEP corrigido na linha: o campo fica com ele e o salvar não o desfaz", () => {
    const after = "Praça da Sé, 100 - São Paulo - SP, 01310-100";
    const cep = companyCepAfterEdit(BEFORE, after, "01001-000");
    assert.equal(cep, "01310-100");
    assert.equal(companyLineToSave(after, cep, 300), after);
  });

  it("CEP apagado da linha: o campo fica vazio e o CEP não volta ao salvar", () => {
    const after = "Praça da Sé, 100 - São Paulo - SP";
    const cep = companyCepAfterEdit(BEFORE, after, "01001-000");
    assert.equal(cep, "");
    assert.equal(companyLineToSave(after, cep, 300), after);
  });

  it("outra parte da linha mexida: o campo fica como está (o CEP digitado só nele vai para a linha ao salvar)", () => {
    const after = "Praça da Sé, 120 - São Paulo - SP, 01001-000";
    assert.equal(companyCepAfterEdit(BEFORE, after, "01001-000"), "01001-000");
    const typed = companyCepAfterEdit("Rua Exemplo, 10", "Rua Exemplo, 12", "13000-000");
    assert.equal(typed, "13000-000");
    assert.equal(companyLineToSave("Rua Exemplo, 12", typed, 300), "Rua Exemplo, 12, 13000-000");
  });

  it("CEP incompleto no campo não entra na linha; passando do limite, a linha fica", () => {
    assert.equal(companyLineToSave("Rua Exemplo, 10", "01001-00", 300), "Rua Exemplo, 10");
    assert.equal(cepIncomplete("01001-00"), true);
    assert.equal(companyLineToSave("Rua Exemplo, 10", "13000-000", 20), "Rua Exemplo, 10");
  });
});

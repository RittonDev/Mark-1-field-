// Ficha do técnico e Mapa na central (lib/technicians.ts, com o splitIssuer e o sameStreet de lib/constants.ts): a API
// de antes (seções só leitura), o número do endereço, o CEP sobre o endereço da ficha, o RG com "SSP/SP" e a situação
// (o title do selo e quem não recebe OS). Dados fictícios.
// Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameStreet, splitIssuer } from "../src/lib/constants.ts";
import {
  addressAfterCep,
  addressNumberText,
  isLegacyDetail,
  isOutOfActive,
  operationalTitle,
  rgIssuerFields,
} from "../src/lib/technicians.ts";

describe("API de antes do cadastro V2 (isLegacyDetail)", () => {
  it("sem a chave address_number: a API antiga (Endereço e os campos novos só leitura)", () => {
    assert.equal(isLegacyDetail({}), true);
    assert.equal(isLegacyDetail({ name: "Tecnico Alfa", address_line: "Rua Exemplo, 123 - Apto 4" }), true);
  });

  it("com a chave, mesmo null ou vazia: a API nova", () => {
    assert.equal(isLegacyDetail({ address_number: null }), false);
    assert.equal(isLegacyDetail({ address_number: "" }), false);
    assert.equal(isLegacyDetail({ address_number: "123" }), false);
  });
});

describe("número do endereço (= personal.address_number)", () => {
  it("maiúsculas e espaços juntos", () => {
    assert.equal(addressNumberText("100a"), "100A");
    assert.equal(addressNumberText("  12   b "), "12 B");
    assert.equal(addressNumberText("123"), "123");
  });

  it('"SN", "s/n" e "S / N" viram "S/N"', () => {
    for (const text of ["SN", "sn", "s/n", "S/N", "S / N", "s /n", " s/ n "]) assert.equal(addressNumberText(text), "S/N", text);
  });

  it("o que não é só o sem número fica como está (em maiúsculas)", () => {
    assert.equal(addressNumberText("SNA"), "SNA");
    assert.equal(addressNumberText("s/n 2"), "S/N 2");
    assert.equal(addressNumberText("km 12"), "KM 12");
  });

  it("vazio fica vazio (o corpo manda null)", () => {
    assert.equal(addressNumberText(""), "");
    assert.equal(addressNumberText("   "), "");
  });
});

describe("CEP sobre o endereço da ficha (addressAfterCep com sameStreet)", () => {
  /** O gravado (base) e a tela; `next` é o que o cepFill devolveu. */
  const base = {
    street: "Rua Exemplo",
    number: "123",
    complement: "Apto 4",
    district: "Centro Exemplo",
    city: "Cidade Exemplo",
    state: "SP",
  };
  const place = { district: "Centro Exemplo", city: "Cidade Exemplo", state: "SP" };
  const apply = (value, street) => addressAfterCep(value, base, { ...place, street }, !sameStreet(street, value.street));

  it("a mesma rua escrita de outro jeito (maiúsculas, acento, espaços): número e complemento ficam", () => {
    for (const street of ["RUA EXEMPLO", "Rua Exêmplo", "  Rua   Exemplo "]) {
      const changes = apply(base, street);
      assert.equal(changes.street, street);
      assert.equal("number" in changes, false, street);
      assert.equal("complement" in changes, false, street);
    }
  });

  it("outra rua: o número e o complemento gravados saem; o digitado agora fica", () => {
    assert.deepEqual(apply(base, "Avenida Exemplo"), { ...place, street: "Avenida Exemplo", number: "", complement: "" });
    const typed = { ...base, number: "45", complement: "Casa 2" };
    assert.deepEqual(apply(typed, "Avenida Exemplo"), { ...place, street: "Avenida Exemplo" });
  });

  it("logradouro abreviado é outra rua (o CEP corrigiu \"R. Exemplo\")", () => {
    const changes = apply({ ...base, street: "R. Exemplo" }, "Rua Exemplo");
    assert.equal(changes.number, "");
    assert.equal(changes.complement, "");
  });

  it("CEP geral depois de um específico (a rua da busca anterior se esvazia): os gravados saem", () => {
    const changes = apply({ ...base, street: "Praça Exemplo" }, "");
    assert.equal(changes.street, "");
    assert.equal(changes.number, "");
    assert.equal(changes.complement, "");
  });
});

describe('RG com o órgão "SSP/SP" (rgIssuerFields com splitIssuer)', () => {
  const save = (issuer, state) => rgIssuerFields(splitIssuer(issuer), state);

  it("a UF do fim do órgão vai para a UF vazia", () => {
    assert.deepEqual(save("SSP/SP", ""), { rg_issuer: "SSP", rg_state: "SP" });
    assert.deepEqual(save("ssp-sp", ""), { rg_issuer: "SSP", rg_state: "SP" });
    assert.deepEqual(save(" SSP / SP ", ""), { rg_issuer: "SSP", rg_state: "SP" });
    assert.deepEqual(save("DETRAN-RJ", ""), { rg_issuer: "DETRAN", rg_state: "RJ" });
  });

  it("com outra UF no campo, vale a do campo e o sufixo sai", () => {
    assert.deepEqual(save("SSP/SP", "RJ"), { rg_issuer: "SSP", rg_state: "RJ" });
  });

  it('sufixo que não é UF vira espaço ("SSP XX"), sem UF', () => {
    assert.deepEqual(save("SSP/XX", ""), { rg_issuer: "SSP XX", rg_state: null });
  });

  it("sem barra, como antes; vazio vira null", () => {
    assert.deepEqual(save("SSP", "SP"), { rg_issuer: "SSP", rg_state: "SP" });
    assert.deepEqual(save("", ""), { rg_issuer: null, rg_state: null });
    assert.deepEqual(save("", "SP"), { rg_issuer: null, rg_state: "SP" });
  });
});

describe("situação na operação: selo e quem recebe OS", () => {
  it("o title do selo é o motivo; sem motivo, \"Não recebe OS\"", () => {
    assert.equal(operationalTitle("Motivo de exemplo"), "Motivo de exemplo");
    assert.equal(operationalTitle("  Motivo de exemplo "), "Motivo de exemplo");
    assert.equal(operationalTitle(null), "Não recebe OS");
    assert.equal(operationalTitle(undefined), "Não recebe OS");
    assert.equal(operationalTitle("   "), "Não recebe OS");
  });

  it("Inativo e Bloqueado não recebem OS; sem a situação (API antiga), Ativo", () => {
    assert.equal(isOutOfActive({}), false);
    assert.equal(isOutOfActive({ operational_status: "active" }), false);
    assert.equal(isOutOfActive({ operational_status: "inactive" }), true);
    assert.equal(isOutOfActive({ operational_status: "blocked" }), true);
  });

  it("na ordem por loja do Mapa, quem não recebe OS vai para o fim, mesmo mais perto", () => {
    const list = [
      { name: "Tecnico Bloqueado", km: 1, operational_status: "blocked" },
      { name: "Tecnico Alfa", km: 8 },
      { name: "Tecnico Inativo", km: 2, operational_status: "inactive" },
      { name: "Tecnico Beta", km: 3, operational_status: "active" },
    ];
    const order = [...list]
      .sort((a, b) => Number(isOutOfActive(a)) - Number(isOutOfActive(b)) || a.km - b.km)
      .map((t) => t.name);
    assert.deepEqual(order, ["Tecnico Beta", "Tecnico Alfa", "Tecnico Bloqueado", "Tecnico Inativo"]);
  });
});

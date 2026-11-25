// Sonda de lib/masks.ts (documentos e contas do cadastro) e das regras de RG, órgão emissor e placa, que ficam em
// lib/constants.ts (iguais na central e no app). Dados fictícios. Sem dependência nova: node:test.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { URL } from "node:url";
import {
  formatPlate,
  isValidPlate,
  isValidRg,
  normalizeIssuer,
  normalizePlate,
  normalizeRg,
  PAYOUT_LIMITS,
  PROFILE_LIMITS,
} from "../src/lib/constants.ts";
import * as masks from "../src/lib/masks.ts";

const {
  isValidCnpj,
  isValidCpf,
  isValidDocument,
  maskAccountDigit,
  maskAccountNumber,
  maskBranch,
  maskCnpj,
  maskCpf,
  maskDocument,
  splitAccount,
} = masks;

describe("RG e órgão emissor (constants)", () => {
  it("o número fica com a pontuação, o X em maiúscula", () => {
    assert.equal(normalizeRg("12.345.678-x"), "12.345.678-X");
    assert.equal(isValidRg("12.345.678-x"), true);
  });

  it("RG com a sigla do estado vale; curto ou com menos de 4 números não", () => {
    assert.equal(isValidRg("MG-12.345.678"), true);
    assert.equal(isValidRg("123"), false);
    assert.equal(isValidRg("1234"), false);
    assert.equal(isValidRg("12345"), true);
    assert.equal(isValidRg("AB-12"), false);
  });

  it("até 20 caracteres", () => {
    assert.equal(normalizeRg("1".repeat(25)).length, PROFILE_LIMITS.rgNumber);
  });

  it("órgão emissor: letras sem acento, maiúsculas, espaços juntados, até 20", () => {
    assert.equal(normalizeIssuer("ssp"), "SSP");
    assert.equal(normalizeIssuer("detrán"), "DETRAN");
    assert.equal(normalizeIssuer("pc  mg"), "PC MG");
    assert.equal(normalizeIssuer("SSP1"), "SSP");
    assert.equal(normalizeIssuer("A".repeat(30)).length, PROFILE_LIMITS.rgIssuer);
  });
});

describe("placa (constants)", () => {
  it("antiga: sem hífen na gravação, com hífen na leitura", () => {
    assert.equal(normalizePlate("abc-1234"), "ABC1234");
    assert.equal(formatPlate(normalizePlate("abc-1234")), "ABC-1234");
    assert.equal(isValidPlate("abc-1234"), true);
  });

  it("Mercosul: igual na gravação e na leitura", () => {
    assert.equal(normalizePlate("abc1d23"), "ABC1D23");
    assert.equal(formatPlate("ABC1D23"), "ABC1D23");
    assert.equal(isValidPlate("ABC1D23"), true);
  });

  it("fora dos dois formatos não vale; mais de 7 caracteres são cortados", () => {
    assert.equal(isValidPlate("AB12345"), false);
    assert.equal(isValidPlate("ABC12"), false);
    assert.equal(normalizePlate("ABC1D234"), "ABC1D23");
  });
});

describe("CPF e CNPJ", () => {
  it("CNPJ numérico", () => {
    assert.equal(maskCnpj("12345678000195"), "12.345.678/0001-95");
    assert.equal(isValidCnpj("12.345.678/0001-95"), true);
    assert.equal(isValidCnpj("12345678000100"), false);
  });

  it("CNPJ alfanumérico (o exemplo da Receita)", () => {
    assert.equal(maskCnpj("12abc34501de35"), "12.ABC.345/01DE-35");
    assert.equal(isValidCnpj("12ABC34501DE35"), true);
  });

  it("CPF", () => {
    assert.equal(maskCpf("12345678909"), "123.456.789-09");
    assert.equal(isValidCpf("123.456.789-09"), true);
    assert.equal(isValidCpf("123.456.789-00"), false);
  });
});

describe("conta bancária", () => {
  it("agência: até 4 números", () => {
    assert.equal(maskBranch("12a345"), "1234");
    assert.equal(maskBranch("0001"), "0001");
    assert.equal(maskBranch(""), "");
  });

  it("conta: só números, até 20", () => {
    assert.equal(maskAccountNumber("12.345-6"), "123456");
    assert.equal(maskAccountNumber("9".repeat(25)).length, PAYOUT_LIMITS.accountNumber);
  });

  it("dígito: o último número ou X digitado", () => {
    assert.equal(maskAccountDigit("x"), "X");
    assert.equal(maskAccountDigit("12"), "2");
    assert.equal(maskAccountDigit("a"), "");
    assert.equal(maskAccountDigit(""), "");
  });

  it("conta colada com o dígito é separada", () => {
    assert.deepEqual(splitAccount("12.345-x"), { number: "12345", digit: "X" });
    assert.deepEqual(splitAccount("0012345 - 6"), { number: "0012345", digit: "6" });
    assert.deepEqual(splitAccount("12-345-6"), { number: "12345", digit: "6" });
  });

  it("sem hífen, sem número ou com dígito que não vale: null", () => {
    assert.equal(splitAccount("12345"), null);
    assert.equal(splitAccount("12345-"), null);
    assert.equal(splitAccount("-5"), null);
    assert.equal(splitAccount("12345-67"), null);
    assert.equal(splitAccount("12345-a"), null);
  });
});

describe("CPF ou CNPJ do titular", () => {
  it("até 11 números: a máscara do CPF", () => {
    assert.equal(maskDocument("12345678909"), "123.456.789-09");
    assert.equal(maskDocument("123.456.789-09"), "123.456.789-09");
    assert.equal(maskDocument("1234"), "123.4");
  });

  it("mais de 11 caracteres ou com letra: a máscara do CNPJ", () => {
    assert.equal(maskDocument("12345678000195"), "12.345.678/0001-95");
    assert.equal(maskDocument("123456789012"), "12.345.678/9012");
    assert.equal(maskDocument("12abc34501de35"), "12.ABC.345/01DE-35");
  });

  it("vale CPF de 11 ou CNPJ de 14 (inclusive o alfanumérico)", () => {
    assert.equal(isValidDocument("123.456.789-09"), true);
    assert.equal(isValidDocument("12.345.678/0001-95"), true);
    assert.equal(isValidDocument("12.ABC.345/01DE-35"), true);
  });

  it("dígito errado, tamanho errado ou vazio não vale", () => {
    assert.equal(isValidDocument("123.456.789-00"), false);
    assert.equal(isValidDocument("12345678000100"), false);
    assert.equal(isValidDocument("1234567890"), false);
    assert.equal(isValidDocument("1234567890A"), false);
    assert.equal(isValidDocument(""), false);
  });
});

describe("masks.ts", () => {
  it("puro: só importa ./constants (entra nas sondas e no app)", () => {
    const source = readFileSync(new URL("../src/lib/masks.ts", import.meta.url), "utf8");
    const values = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)].map((m) => m[1]);
    assert.deepEqual(values, ["./constants"]);
  });

  it("RG, órgão emissor e placa ficam só em constants", () => {
    for (const name of ["maskRg", "isValidRg", "maskIssuer", "maskPlate", "isValidPlate"]) {
      assert.equal(name in masks, false, name);
    }
  });
});

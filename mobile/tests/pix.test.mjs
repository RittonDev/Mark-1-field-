// Sonda de lib/pix.ts (chave PIX das Configurações). Prova também o gancho das sondas: pix.ts importa "./masks" sem
// extensão, e só carrega com tests/resolve-ts.mjs. Dados fictícios. Sem dependência nova: node:test.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskPixInput, parsePixKey, PIX_INVALID, pixInputValue, pixKeyInputProps } from "../src/lib/pix.ts";

describe("parsePixKey: a chave como o servidor grava", () => {
  it("CPF com ou sem pontuação; dígito errado e repetido não passam", () => {
    assert.deepEqual(parsePixKey("cpf", "123.456.789-09"), { key: "12345678909" });
    assert.deepEqual(parsePixKey("cpf", " 12345678909 "), { key: "12345678909" });
    assert.deepEqual(parsePixKey("cpf", "123.456.789-00"), { error: PIX_INVALID.cpf });
    assert.deepEqual(parsePixKey("cpf", "111.111.111-11"), { error: PIX_INVALID.cpf });
  });

  it("CNPJ com todos os caracteres iguais não passa", () => {
    assert.deepEqual(parsePixKey("cnpj", "00.000.000/0000-00"), { error: PIX_INVALID.cnpj });
  });

  it("e-mail em minúsculas, sem espaços em volta", () => {
    assert.deepEqual(parsePixKey("email", " Tecnico.Alfa@Exemplo.com "), { key: "tecnico.alfa@exemplo.com" });
    assert.deepEqual(parsePixKey("email", "tecnico.alfa@exemplo"), { error: PIX_INVALID.email });
  });

  it("celular com DDD e o 9, com ou sem +55; fixo não passa", () => {
    assert.deepEqual(parsePixKey("phone", "(11) 98888-7777"), { key: "+5511988887777" });
    assert.deepEqual(parsePixKey("phone", "+55 11 98888-7777"), { key: "+5511988887777" });
    assert.deepEqual(parsePixKey("phone", "(11) 8888-7777"), { error: PIX_INVALID.phone });
  });

  it("chave aleatória colada com ou sem hífens vira 8-4-4-4-12 em minúsculas", () => {
    const formatted = { key: "a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6" };
    assert.deepEqual(parsePixKey("random", "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6"), formatted);
    assert.deepEqual(parsePixKey("random", " a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6 "), formatted);
    assert.deepEqual(parsePixKey("random", "a1b2c3d4"), { error: PIX_INVALID.random });
  });
});

describe("campo da chave", () => {
  it("máscara do tipo (vem de ./masks, pelo gancho)", () => {
    assert.equal(maskPixInput("cpf", "12345678909"), "123.456.789-09");
    assert.equal(maskPixInput("phone", "+5511988887777"), "(11) 98888-7777");
    assert.equal(maskPixInput("email", " tecnico alfa@exemplo.com "), "tecnicoalfa@exemplo.com");
  });

  it("chave gravada no jeito de editar", () => {
    assert.equal(pixInputValue("phone", "+5511988887777"), "(11) 98888-7777");
    assert.equal(pixInputValue("cpf", "12345678909"), "123.456.789-09");
    assert.equal(pixInputValue("email", "tecnico.alfa@exemplo.com"), "tecnico.alfa@exemplo.com");
  });

  it("teclado por tipo", () => {
    assert.equal(pixKeyInputProps("cpf").keyboardType, "number-pad");
    assert.equal(pixKeyInputProps("phone").keyboardType, "phone-pad");
    assert.equal(pixKeyInputProps("email").maxLength, 77);
  });
});

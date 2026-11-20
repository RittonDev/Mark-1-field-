// Sonda dos textos de data e duração da oferta (lib/format.ts, sem imports): a data por extenso, a duração para o
// leitor de tela e a hora da visita. As datas são montadas no fuso de quem roda (new Date(ano, mês, dia, hora)), como
// o app, que mostra tudo no fuso do aparelho: o resultado não depende do fuso da máquina.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLongDate, formatMinutesLong, visitTimeText } from "../src/lib/format.ts";

/** Quinta-feira, 19/11/2026, ao meio-dia. */
const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const at = (year, month, day, hour = 9, minute = 0) => new Date(year, month - 1, day, hour, minute);
const iso = (...args) => at(...args).toISOString();

describe("formatLongDate: a data da visita por extenso", () => {
  it("hoje, amanhã e ontem pelo dia do calendário, não por 24 h", () => {
    assert.equal(formatLongDate(at(2026, 11, 19, 23, 59), NOW), "Hoje, 19 de novembro");
    assert.equal(formatLongDate(at(2026, 11, 20, 0, 5), NOW), "Amanhã, 20 de novembro");
    assert.equal(formatLongDate(at(2026, 11, 18, 8), NOW), "Ontem, 18 de novembro");
  });

  it("outro dia: o dia da semana com a inicial maiúscula; dia 1 é 1º", () => {
    assert.equal(formatLongDate(at(2026, 11, 27), NOW), "Sexta-feira, 27 de novembro");
    assert.equal(formatLongDate(at(2026, 12, 1), NOW), "Terça-feira, 1º de dezembro");
    assert.equal(formatLongDate(at(2026, 11, 21), NOW), "Sábado, 21 de novembro");
  });

  it("outro ano leva o ano", () => {
    assert.equal(formatLongDate(at(2027, 1, 1), NOW), "Sexta-feira, 1º de janeiro de 2027");
    assert.equal(formatLongDate(at(2025, 11, 19), NOW), "Quarta-feira, 19 de novembro de 2025");
  });

  it("aceita o texto ISO que vem da API", () => {
    assert.equal(formatLongDate(iso(2026, 11, 20, 14), NOW), "Amanhã, 20 de novembro");
  });
});

describe("formatMinutesLong: a duração para o leitor de tela", () => {
  it("horas, minutos e dias por extenso, no singular e no plural", () => {
    assert.equal(formatMinutesLong(180), "3 horas");
    assert.equal(formatMinutesLong(60), "1 hora");
    assert.equal(formatMinutesLong(90), "1 hora e 30 minutos");
    assert.equal(formatMinutesLong(61), "1 hora e 1 minuto");
    assert.equal(formatMinutesLong(45), "45 minutos");
    assert.equal(formatMinutesLong(1), "1 minuto");
    assert.equal(formatMinutesLong(1560), "1 dia e 2 horas");
    assert.equal(formatMinutesLong(2880), "2 dias");
  });
});

describe("visitTimeText: a hora da visita na oferta", () => {
  it("sem fim: só o início", () => {
    assert.equal(visitTimeText(iso(2026, 11, 20, 9), null, 90), "09:00");
    assert.equal(visitTimeText(iso(2026, 11, 20, 9), undefined), "09:00");
  });

  it("fim = início + duração estimada (±1 min): só o início, a duração já aparece ao lado", () => {
    assert.equal(visitTimeText(iso(2026, 11, 20, 9), iso(2026, 11, 20, 10, 30), 90), "09:00");
    assert.equal(visitTimeText(iso(2026, 11, 20, 9), iso(2026, 11, 20, 10, 31), 90), "09:00");
  });

  it("janela maior que a duração: início e fim", () => {
    assert.equal(visitTimeText(iso(2026, 11, 20, 9), iso(2026, 11, 20, 18), 90), "09:00 às 18:00");
    assert.equal(visitTimeText(iso(2026, 11, 20, 9), iso(2026, 11, 20, 18), null), "09:00 às 18:00");
    assert.equal(visitTimeText(iso(2026, 11, 20, 13, 5), iso(2026, 11, 20, 17, 45)), "13:05 às 17:45");
  });

  it("fim em outro dia ou antes do início: só o início", () => {
    assert.equal(visitTimeText(iso(2026, 11, 20, 22), iso(2026, 11, 21, 2), 60), "22:00");
    assert.equal(visitTimeText(iso(2026, 11, 20, 9), iso(2026, 11, 20, 8), 60), "09:00");
  });
});

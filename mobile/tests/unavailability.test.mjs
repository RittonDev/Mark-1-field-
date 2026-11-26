// Sonda de lib/unavailability.ts (Configurações › Dias e horários): a folha do período de indisponibilidade, o corpo
// do PATCH /me/profile e o resumo da linha de Configurações. Hoje = "2026-11-25". Dados fictícios. Sem dependência nova:
// node:test.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { availabilitySummary, periodShort, UNAVAILABILITY_LIMITS } from "../src/lib/constants.ts";
import * as lib from "../src/lib/unavailability.ts";

const {
  addDaysIso,
  currentPeriod,
  localDay,
  PERIOD_FIELDS,
  PERIOD_MSG,
  periodBounds,
  periodProblem,
  periodSpoken,
  periodText,
  scheduleSummary,
  unavailabilityWith,
  unavailabilityWithout,
} = lib;

const TODAY = "2026-11-25";
const STARTED = { id: "p1", start: "2026-11-20", end: "2026-11-30" };
const HOLIDAYS = { id: "p2", start: "2026-12-20", end: "2027-01-05" };
const SLOTS = ["mon:morning", "mon:afternoon", "tue:morning", "tue:afternoon"];

describe("o módulo é puro", () => {
  it("só importa ./constants (a sonda roda sem React nem React Native)", () => {
    const source = readFileSync(new URL("../src/lib/unavailability.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => ({ type: Boolean(m[1]), from: m[2] }));
    assert.deepEqual(
      imports.filter((i) => !i.type).map((i) => i.from),
      ["./constants"],
    );
    assert.ok(imports.every((i) => i.from.startsWith("./")));
  });
});

describe("datas", () => {
  it("addDaysIso na virada do mês, do ano e no ano bissexto", () => {
    assert.equal(addDaysIso("2026-11-30", 1), "2026-12-01");
    assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
    assert.equal(addDaysIso("2028-02-28", 1), "2028-02-29");
    assert.equal(addDaysIso("2026-03-01", -1), "2026-02-28");
    assert.equal(addDaysIso(TODAY, UNAVAILABILITY_LIMITS.horizonDays), "2027-11-25");
  });

  it("localDay é o dia do aparelho", () => {
    assert.equal(localDay(new Date(2026, 10, 25, 23, 59)), "2026-11-25");
    assert.equal(localDay(new Date(2027, 0, 1, 0, 0)), "2027-01-01");
  });

  it("limites do seletor: de hoje (ou do início gravado que já passou) a 365 dias", () => {
    assert.deepEqual(periodBounds(TODAY, null), { min: TODAY, max: "2027-11-25" });
    assert.deepEqual(periodBounds(TODAY, STARTED), { min: "2026-11-20", max: "2027-11-25" });
    assert.deepEqual(periodBounds(TODAY, HOLIDAYS), { min: TODAY, max: "2027-11-25" });
  });
});

describe("erros da folha", () => {
  it("a ordem da tela e os textos (os do servidor, com ponto)", () => {
    assert.deepEqual(PERIOD_FIELDS, ["start", "end"]);
    assert.equal(PERIOD_MSG.order, "O fim não pode ser antes do início.");
    assert.equal(PERIOD_MSG.past, "O início não pode ser antes de hoje.");
    assert.equal(PERIOD_MSG.horizon, "Até 365 dias a partir de hoje.");
    assert.equal(PERIOD_MSG.overlap, "Já há um período nessas datas.");
    assert.equal(PERIOD_MSG.limit, "Limite de 10 períodos. Exclua um para incluir outro.");
    for (const message of Object.values(PERIOD_MSG)) assert.ok(message.endsWith("."), message);
  });

  it("sem datas", () => {
    assert.deepEqual(periodProblem({ start: null, end: null }, [], TODAY, null), { start: PERIOD_MSG.start, end: PERIOD_MSG.end });
    assert.deepEqual(periodProblem({ start: "2026-12-01", end: null }, [], TODAY, null), { end: PERIOD_MSG.end });
  });

  it("fim antes do início; um dia só (início = fim) vale", () => {
    assert.deepEqual(periodProblem({ start: "2026-12-10", end: "2026-12-01" }, [], TODAY, null), { end: PERIOD_MSG.order });
    assert.deepEqual(periodProblem({ start: "2026-12-10", end: "2026-12-10" }, [], TODAY, null), {});
    assert.deepEqual(periodProblem({ start: TODAY, end: TODAY }, [], TODAY, null), {});
  });

  it("início antes de hoje: o novo não vale; o gravado que já começou, editado sem mudar o início, vale", () => {
    assert.deepEqual(periodProblem({ start: "2026-11-24", end: "2026-11-30" }, [], TODAY, null), { start: PERIOD_MSG.past });
    assert.deepEqual(periodProblem({ start: "2026-11-20", end: "2026-12-02" }, [], TODAY, STARTED), {});
    assert.deepEqual(periodProblem({ start: "2026-11-21", end: "2026-12-02" }, [], TODAY, STARTED), { start: PERIOD_MSG.past });
  });

  it("até 365 dias a partir de hoje", () => {
    assert.deepEqual(periodProblem({ start: "2027-11-20", end: "2027-11-26" }, [], TODAY, null), { end: PERIOD_MSG.horizon });
    assert.deepEqual(periodProblem({ start: "2027-11-20", end: "2027-11-25" }, [], TODAY, null), {});
    assert.deepEqual(periodProblem({ start: "2027-11-26", end: "2027-11-26" }, [], TODAY, null), {
      start: PERIOD_MSG.horizon,
      end: PERIOD_MSG.horizon,
    });
  });

  it("nenhum dia em comum com outro período (os dois dias inclusive)", () => {
    assert.deepEqual(periodProblem({ start: "2027-01-05", end: "2027-01-10" }, [HOLIDAYS], TODAY, null), { end: PERIOD_MSG.overlap });
    assert.deepEqual(periodProblem({ start: "2026-12-01", end: "2027-02-01" }, [HOLIDAYS], TODAY, null), { end: PERIOD_MSG.overlap });
    assert.deepEqual(periodProblem({ start: "2027-01-06", end: "2027-01-10" }, [HOLIDAYS], TODAY, null), {});
    assert.deepEqual(periodProblem({ start: "2026-12-01", end: "2026-12-19" }, [HOLIDAYS], TODAY, null), {});
    // Editando, o próprio período não conta (a tela passa os outros).
    assert.deepEqual(periodProblem({ start: "2026-12-21", end: "2027-01-05" }, [], TODAY, HOLIDAYS), {});
  });
});

describe("textos", () => {
  it("periodText: um dia e intervalo", () => {
    assert.equal(periodText({ start: "2026-12-20", end: "2026-12-20" }), "20/12/2026");
    assert.equal(periodText(HOLIDAYS), "20/12/2026 a 05/01/2027");
  });

  it("periodShort (constants): os casos do contrato", () => {
    assert.equal(periodShort({ start: "2026-11-20", end: "2026-11-30" }, TODAY), "até 30/11");
    assert.equal(periodShort({ start: "2026-12-10", end: "2026-12-20" }, TODAY), "de 10/12 a 20/12");
    assert.equal(periodShort({ start: "2026-12-10", end: "2026-12-10" }, TODAY), "em 10/12");
    assert.equal(periodShort(HOLIDAYS, TODAY), "de 20/12 a 05/01/2027");
  });

  it("o período de hoje (os dois dias inclusive)", () => {
    assert.equal(currentPeriod([STARTED, HOLIDAYS], TODAY), STARTED);
    assert.equal(currentPeriod([STARTED, HOLIDAYS], "2026-11-30"), STARTED);
    assert.equal(currentPeriod([STARTED, HOLIDAYS], "2026-12-01"), null);
    assert.equal(currentPeriod([STARTED, HOLIDAYS], "2027-01-05"), HOLIDAYS);
    assert.equal(currentPeriod(undefined, TODAY), null);
  });

  it("o leitor de tela", () => {
    assert.equal(periodSpoken(STARTED, TODAY), "De 20/11/2026 a 30/11/2026, agora");
    assert.equal(periodSpoken({ id: "p3", start: "2026-12-10", end: "2026-12-10" }, TODAY), "Dia 10/12/2026");
  });

  it("a linha de Configurações: no período, até quando; senão os turnos; nada, \"Não informados\"", () => {
    assert.equal(scheduleSummary(SLOTS, [{ id: "p4", start: "2026-11-20", end: "2026-12-05" }], TODAY), "Indisponível até 05/12");
    assert.equal(scheduleSummary(SLOTS, [{ id: "p5", start: "2026-11-01", end: "2027-01-05" }], TODAY), "Indisponível até 05/01/2027");
    assert.equal(scheduleSummary(SLOTS, [HOLIDAYS], TODAY), availabilitySummary(SLOTS));
    assert.equal(scheduleSummary(SLOTS, undefined, TODAY), availabilitySummary(SLOTS));
    assert.equal(scheduleSummary([], [HOLIDAYS], TODAY), "Não informados");
    assert.equal(scheduleSummary([], [], TODAY), "Não informados");
    // Sem turno, mas no período: o período.
    assert.equal(scheduleSummary([], [STARTED], TODAY), "Indisponível até 30/11");
  });
});

describe("corpo do PATCH", () => {
  it("incluir: entra sem id, na ordem do início", () => {
    assert.deepEqual(unavailabilityWith([HOLIDAYS], { start: "2026-12-01", end: "2026-12-03" }), [
      { start: "2026-12-01", end: "2026-12-03" },
      { id: "p2", start: "2026-12-20", end: "2027-01-05" },
    ]);
    assert.deepEqual(unavailabilityWith([], { id: null, start: "2026-12-01", end: "2026-12-03" }), [{ start: "2026-12-01", end: "2026-12-03" }]);
  });

  it("editar: no lugar, com o mesmo id, e a lista volta a ficar pelo início", () => {
    assert.deepEqual(unavailabilityWith([STARTED, HOLIDAYS], { id: "p1", start: "2026-11-20", end: "2027-02-10" }), [
      { id: "p1", start: "2026-11-20", end: "2027-02-10" },
      { id: "p2", start: "2026-12-20", end: "2027-01-05" },
    ]);
    assert.deepEqual(unavailabilityWith([STARTED, HOLIDAYS], { id: "p2", start: "2026-11-01", end: "2026-11-02" }).map((p) => p.id), [
      "p2",
      "p1",
    ]);
  });

  it("editar um período que já saiu da lista: null", () => {
    assert.equal(unavailabilityWith([HOLIDAYS], { id: "p1", start: "2026-12-01", end: "2026-12-02" }), null);
  });

  it("excluir: os outros ficam com o id", () => {
    assert.deepEqual(unavailabilityWithout([STARTED, HOLIDAYS], "p1"), [{ id: "p2", start: "2026-12-20", end: "2027-01-05" }]);
    assert.deepEqual(unavailabilityWithout([STARTED], "p1"), []);
  });
});

// O servidor (backend/app/services/unavailability.py) tem as mesmas mensagens, sem o ponto. Na pasta mobile sozinha
// (contêiner do app), o backend não está: pula.
const SERVER = fileURLToPath(new URL("../../backend/app/services/unavailability.py", import.meta.url));

describe("mesmas mensagens do servidor", () => {
  it("fim, início, 365 dias e sobreposição", { skip: !existsSync(SERVER) && "backend fora desta pasta" }, () => {
    const source = readFileSync(SERVER, "utf8");
    for (const key of ["order", "past", "horizon", "overlap"]) {
      assert.ok(source.includes(`"${PERIOD_MSG[key].slice(0, -1)}"`), `${key}: ${PERIOD_MSG[key]}`);
    }
  });
});

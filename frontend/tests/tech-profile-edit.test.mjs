// O perfil profissional editado pela central (lib/techProfileEdit.ts): a API de antes da Gestão, a grade dos turnos,
// os períodos de indisponibilidade e a formação com as mesmas regras e mensagens do app (conferidas no texto de
// mobile/src/lib quando a pasta existe), o mês digitado à mão e os corpos do PATCH já ordenados. As cópias locais da
// grade e dos limites batem com lib/constants.ts. Dados fictícios. Sem dependência nova: node:test com o type
// stripping do Node 22. Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ALL_SLOTS, TECH_PROFILE_LIMITS, TRANSPORT_MODE_ORDER, UNAVAILABILITY_LIMITS } from "../src/lib/constants.ts";
import {
  addDaysIso,
  allSlots,
  cleanText,
  EDUCATION_MSG,
  educationBody,
  educationEditProblem,
  educationProblem,
  isPreGestao,
  MONTH_MSG,
  monthProblem,
  PERIOD_MSG,
  periodBounds,
  periodProblem,
  PROFILE_EDIT_LIMITS,
  skillsBody,
  sortedIds,
  thisMonth,
  toggleSlot,
  transportBody,
  unavailabilityBody,
} from "../src/lib/techProfileEdit.ts";

const TODAY = "2026-11-26";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const APP_UNAVAILABILITY = new URL("../../mobile/src/lib/unavailability.ts", import.meta.url);
const APP_PROFILE_FORM = new URL("../../mobile/src/lib/techProfileForm.ts", import.meta.url);

describe("a API de antes da Gestão (isPreGestao)", () => {
  it("sem area_ids: a de antes; com area_ids (até vazio): a da Gestão", () => {
    assert.equal(isPreGestao({}), true);
    assert.equal(isPreGestao({ area_ids: undefined }), true);
    assert.equal(isPreGestao({ area_ids: [] }), false);
    assert.equal(isPreGestao({ area_ids: [A] }), false);
    // null não é "ausente": a API nova nunca manda, mas não trava a ficha.
    assert.equal(isPreGestao({ area_ids: null }), false);
  });
});

describe("as cópias locais (= lib/constants.ts)", () => {
  it("a grade de 28 turnos na mesma ordem de ALL_SLOTS", () => {
    assert.deepEqual(allSlots(), ALL_SLOTS);
    assert.equal(allSlots().length, 28);
  });

  it("os limites: formação, aptidões, áreas, cursos, períodos e horizonte", () => {
    assert.equal(PROFILE_EDIT_LIMITS.textMin, TECH_PROFILE_LIMITS.textMin);
    assert.equal(PROFILE_EDIT_LIMITS.course, TECH_PROFILE_LIMITS.course);
    assert.equal(PROFILE_EDIT_LIMITS.institution, TECH_PROFILE_LIMITS.institution);
    assert.equal(PROFILE_EDIT_LIMITS.education, TECH_PROFILE_LIMITS.education);
    assert.equal(PROFILE_EDIT_LIMITS.skills, TECH_PROFILE_LIMITS.skills);
    assert.equal(PROFILE_EDIT_LIMITS.areas, TECH_PROFILE_LIMITS.areas);
    assert.equal(PROFILE_EDIT_LIMITS.firstMonth, TECH_PROFILE_LIMITS.firstMonth);
    assert.equal(PROFILE_EDIT_LIMITS.periods, UNAVAILABILITY_LIMITS.periods);
    assert.equal(PROFILE_EDIT_LIMITS.horizonDays, UNAVAILABILITY_LIMITS.horizonDays);
  });

  it("os meios de transporte na ordem de TRANSPORT_MODE_ORDER", () => {
    assert.deepEqual(transportBody([...TRANSPORT_MODE_ORDER].reverse(), true).modes, TRANSPORT_MODE_ORDER);
  });
});

describe("dias e horários", () => {
  it("toggleSlot marca e desmarca, sempre na ordem da grade, sem repetidos nem códigos desconhecidos", () => {
    assert.deepEqual(toggleSlot([], "sat:night"), ["sat:night"]);
    assert.deepEqual(toggleSlot(["sat:night"], "mon:morning"), ["mon:morning", "sat:night"]);
    assert.deepEqual(toggleSlot(["mon:morning", "sat:night"], "mon:morning"), ["sat:night"]);
    assert.deepEqual(toggleSlot(["sun:evening", "mon:night", "mon:morning"], "tue:afternoon"), [
      "mon:morning",
      "mon:night",
      "tue:afternoon",
      "sun:evening",
    ]);
    assert.deepEqual(toggleSlot(["mon:morning", "mon:morning", "xyz"], "fri:evening"), ["mon:morning", "fri:evening"]);
  });

  it("PERIOD_MSG: os textos do app, com o horizonte e o limite de UNAVAILABILITY_LIMITS", () => {
    assert.equal(PERIOD_MSG.start, "Informe o início.");
    assert.equal(PERIOD_MSG.end, "Informe o fim.");
    assert.equal(PERIOD_MSG.order, "O fim não pode ser antes do início.");
    assert.equal(PERIOD_MSG.past, "O início não pode ser antes de hoje.");
    assert.equal(PERIOD_MSG.horizon, `Até ${UNAVAILABILITY_LIMITS.horizonDays} dias a partir de hoje.`);
    assert.equal(PERIOD_MSG.overlap, "Já há um período nessas datas.");
    assert.equal(PERIOD_MSG.limit, `Limite de ${UNAVAILABILITY_LIMITS.periods} períodos. Exclua um para incluir outro.`);
  });

  it(
    "os textos fixos de PERIOD_MSG aparecem em mobile/src/lib/unavailability.ts",
    { skip: !existsSync(APP_UNAVAILABILITY) && "pasta mobile ausente" },
    () => {
      const app = readFileSync(APP_UNAVAILABILITY, "utf8");
      for (const key of ["start", "end", "order", "past", "overlap"]) assert.ok(app.includes(`"${PERIOD_MSG[key]}"`), key);
      assert.ok(app.includes("dias a partir de hoje.`"));
      assert.ok(app.includes("períodos. Exclua um para incluir outro.`"));
    },
  );

  it("periodBounds: de hoje a hoje + 365", () => {
    assert.deepEqual(periodBounds(TODAY), { min: TODAY, max: "2027-11-26" });
    assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
    assert.equal(addDaysIso("2028-02-28", 1), "2028-02-29");
  });

  it("periodProblem com hoje fixo: vazio, passado, além de 365 dias, fim antes do início e sobreposição", () => {
    const others = [{ start: "2026-12-20", end: "2027-01-05" }];
    assert.deepEqual(periodProblem({ start: null, end: null }, [], TODAY), { start: PERIOD_MSG.start, end: PERIOD_MSG.end });
    assert.deepEqual(periodProblem({ start: "2026-11-25", end: "2026-11-30" }, [], TODAY), { start: PERIOD_MSG.past });
    assert.deepEqual(periodProblem({ start: "2027-11-27", end: "2027-11-28" }, [], TODAY), {
      start: PERIOD_MSG.horizon,
      end: PERIOD_MSG.horizon,
    });
    assert.deepEqual(periodProblem({ start: "2026-12-10", end: "2027-11-27" }, [], TODAY), { end: PERIOD_MSG.horizon });
    assert.deepEqual(periodProblem({ start: "2026-12-10", end: "2026-12-09" }, [], TODAY), { end: PERIOD_MSG.order });
    // Os dois dias contam: encostar no período de outro também sobrepõe.
    assert.deepEqual(periodProblem({ start: "2027-01-05", end: "2027-01-10" }, others, TODAY), { end: PERIOD_MSG.overlap });
    assert.deepEqual(periodProblem({ start: "2026-12-01", end: "2026-12-20" }, others, TODAY), { end: PERIOD_MSG.overlap });
    // Hoje e um dia só valem.
    assert.deepEqual(periodProblem({ start: TODAY, end: TODAY }, others, TODAY), {});
    assert.deepEqual(periodProblem({ start: "2027-01-06", end: "2027-11-26" }, others, TODAY), {});
    // O início passado só vale no período editado (o gravado que já começou).
    assert.deepEqual(periodProblem({ start: "2026-11-20", end: "2026-11-30" }, [], TODAY, { start: "2026-11-20" }), {});
  });

  it("unavailabilityBody: pelo início (e o fim), o gravado com o id e o novo sem", () => {
    assert.deepEqual(
      unavailabilityBody([
        { start: "2027-01-10", end: "2027-01-12", key: "novo-0" },
        { id: A, start: "2026-12-20", end: "2027-01-05", key: A },
        { start: "2026-12-20", end: "2026-12-21" },
      ]),
      [
        { start: "2026-12-20", end: "2026-12-21" },
        { id: A, start: "2026-12-20", end: "2027-01-05" },
        { start: "2027-01-10", end: "2027-01-12" },
      ],
    );
    assert.deepEqual(unavailabilityBody([]), []);
  });
});

describe("transporte", () => {
  it("transportBody: os meios na ordem da tela, sem repetir nem desconhecidos, e a CNH", () => {
    assert.deepEqual(transportBody(["on_foot", "car", "car", "xyz"], false), { modes: ["car", "on_foot"], driver_license: false });
    assert.deepEqual(transportBody([], true), { modes: [], driver_license: true });
  });

  it("cleanText: como o servidor grava (core/text.clean)", () => {
    assert.equal(cleanText("  Modelo   Exemplo\n"), "Modelo Exemplo");
    assert.equal(cleanText("Modelo​ Exemplo"), "Modelo Exemplo");
  });
});

describe("formação", () => {
  const draft = (over = {}) => ({
    course: "Técnico em Eletrônica",
    level: "technical",
    institution: "Escola Exemplo",
    start: "2020-02",
    end: "2021-12",
    ongoing: false,
    ...over,
  });

  it("EDUCATION_MSG: os textos do app", () => {
    assert.deepEqual(
      { ...EDUCATION_MSG },
      {
        course: "Informe o curso.",
        level: "Escolha o nível.",
        institution: "Informe a instituição.",
        start: "Informe o início.",
        end: "Informe o fim ou marque Em andamento.",
        endBeforeStart: "O fim não pode ser antes do início.",
      },
    );
  });

  it(
    "os textos de EDUCATION_MSG aparecem em mobile/src/lib/techProfileForm.ts",
    { skip: !existsSync(APP_PROFILE_FORM) && "pasta mobile ausente" },
    () => {
      const app = readFileSync(APP_PROFILE_FORM, "utf8");
      for (const [key, text] of Object.entries(EDUCATION_MSG)) assert.ok(app.includes(`"${text}"`), key);
    },
  );

  it("educationProblem: o curso completo passa; cada falta com a mensagem do app", () => {
    assert.deepEqual(educationProblem(draft()), {});
    assert.deepEqual(educationProblem(draft({ end: null, ongoing: true })), {});
    // Início igual ao fim vale.
    assert.deepEqual(educationProblem(draft({ start: "2021-12", end: "2021-12" })), {});
    assert.deepEqual(educationProblem(draft({ course: " a ", level: null, institution: "", start: null, end: null })), {
      course: EDUCATION_MSG.course,
      level: EDUCATION_MSG.level,
      institution: EDUCATION_MSG.institution,
      start: EDUCATION_MSG.start,
      end: EDUCATION_MSG.end,
    });
    assert.deepEqual(educationProblem(draft({ start: "2022-03", end: "2021-12" })), { end: EDUCATION_MSG.endBeforeStart });
  });

  it("o mês digitado à mão: formato, de 1950-01 ao mês de hoje", () => {
    assert.equal(thisMonth(TODAY), "2026-11");
    assert.equal(monthProblem("", TODAY), null);
    assert.equal(monthProblem(null, TODAY), null);
    assert.equal(monthProblem("2026-11", TODAY), null);
    assert.equal(monthProblem("1950-01", TODAY), null);
    assert.equal(monthProblem("1949-12", TODAY), MONTH_MSG.tooOld);
    assert.equal(monthProblem("2026-12", TODAY), MONTH_MSG.tooNew);
    assert.equal(monthProblem("2026-13", TODAY), MONTH_MSG.invalid);
    assert.equal(monthProblem("11/2026", TODAY), MONTH_MSG.invalid);
    assert.equal(MONTH_MSG.invalid, "Mês inválido: use AAAA-MM.");
  });

  it("educationEditProblem: as regras do app e, sem erro delas, o mês", () => {
    assert.deepEqual(educationEditProblem(draft(), TODAY), {});
    assert.deepEqual(educationEditProblem(draft({ start: "1900-01" }), TODAY), { start: MONTH_MSG.tooOld });
    assert.deepEqual(educationEditProblem(draft({ end: "2027-01" }), TODAY), { end: MONTH_MSG.tooNew });
    // Em andamento: o fim não conta.
    assert.deepEqual(educationEditProblem(draft({ end: "abc", ongoing: true }), TODAY), {});
    assert.deepEqual(educationEditProblem(draft({ start: null }), TODAY), { start: EDUCATION_MSG.start });
  });

  it("educationBody: a lista inteira na ordem da tela, textos limpos, o gravado com id e em andamento sem fim", () => {
    assert.deepEqual(
      educationBody([
        { ...draft({ course: "  Técnico   em Eletrônica " }), id: A },
        { ...draft({ ongoing: true, end: "2024-01", institution: " Escola Exemplo\n" }), id: null },
      ]),
      [
        { id: A, course: "Técnico em Eletrônica", level: "technical", institution: "Escola Exemplo", start: "2020-02", end: "2021-12" },
        { course: "Técnico em Eletrônica", level: "technical", institution: "Escola Exemplo", start: "2020-02", end: null },
      ],
    );
  });
});

describe("áreas, aptidões e ferramental", () => {
  it("sortedIds: sem repetir e em ordem (a mesma lista em outra ordem não é mudança)", () => {
    assert.deepEqual(sortedIds([C, A, B, A]), [A, B, C]);
    assert.deepEqual(sortedIds([]), []);
    assert.deepEqual(sortedIds([B, A]), sortedIds([A, B]));
  });

  it("skillsBody: {skill_id, level} sem repetir o id, pelo id (sem nome nem desde)", () => {
    assert.deepEqual(
      skillsBody([
        { skill_id: C, name: "Redes", level: "avancado", since: "2026-01-10" },
        { skill_id: A, name: "Linux", level: "basico", since: null },
        { skill_id: C, name: "Redes", level: "basico", since: null },
        { skill_id: B, name: "CFTV", level: "intermediario", since: "2025-05-02" },
      ]),
      [
        { skill_id: A, level: "basico" },
        { skill_id: B, level: "intermediario" },
        { skill_id: C, level: "avancado" },
      ],
    );
    assert.deepEqual(skillsBody([]), []);
  });
});

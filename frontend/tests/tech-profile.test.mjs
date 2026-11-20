// Perfil técnico de lib/constants.ts (a mesma cópia do app): os textos iguais aos do servidor
// (services/tech_profile.py, os mesmos casos do pytest), os resumos das Configurações, a chave PIX mascarada e a data
// do aviso de privacidade. Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ALL_SLOTS,
  availabilitySummary,
  DAY_PERIOD,
  DAY_PERIOD_ORDER,
  dayPeriodsText,
  EDUCATION_LEVEL,
  EDUCATION_LEVEL_ORDER,
  educationPeriodText,
  maskPixKey,
  monthText,
  periodsPhrase,
  PRIVACY_DATE,
  PRIVACY_NOTICE,
  PRIVACY_VERSION,
  SKILL_LEVEL,
  SKILL_LEVEL_ORDER,
  sinceText,
  slotPeriods,
  slotsText,
  sortSlots,
  TECH_PROFILE_LIMITS,
  TECH_PROFILE_PART,
  TRANSPORT_MODE,
  TRANSPORT_MODE_ORDER,
  transportText,
  USER_CHANGE_LABEL,
  WEEKDAY,
  WEEKDAY_ORDER,
  WORKDAYS,
} from "../src/lib/constants.ts";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PERIODS = ["morning", "afternoon", "evening", "night"];
/** Os 28 turnos montados aqui, sem usar ALL_SLOTS. */
const EVERY_SLOT = DAYS.flatMap((day) => PERIODS.map((period) => `${day}:${period}`));
/** Segunda a sexta, manhã e tarde. */
const WEEK_DAYTIME = DAYS.slice(0, 5).flatMap((day) => [`${day}:morning`, `${day}:afternoon`]);

const unique = (list) => new Set(list).size === list.length;

describe("slotsText (os casos do pytest de services/tech_profile.slots_text)", () => {
  const cases = [
    [["sat:afternoon"], "sáb · tarde"],
    [["sat:evening", "sat:afternoon"], "sáb · tarde e noite"],
    [["fri:evening", "sat:night"], "sex · noite; sáb · madrugada"],
    [[...WEEK_DAYTIME, "sat:morning"], "seg a sex · manhã e tarde; sáb · manhã", "seg a sex de manhã e à tarde e sat:morning"],
    [["sat:morning", "sun:morning"], "sáb e dom · manhã"],
    [EVERY_SLOT, "seg a dom · manhã, tarde, noite e madrugada", "os 28"],
    [["mon:morning", "wed:morning"], "seg · manhã; qua · manhã"],
    [[], ""],
    [["xyz", "sat:afternoon", "sat:afternoon"], "sáb · tarde"],
  ];
  for (const [slots, text, name] of cases) {
    it(`${name ?? JSON.stringify(slots)} → "${text}"`, () => {
      assert.equal(slotsText(slots), text);
    });
  }

  it("não depende da ordem de entrada", () => {
    assert.equal(slotsText([...EVERY_SLOT].reverse()), "seg a dom · manhã, tarde, noite e madrugada");
    assert.equal(slotsText(["sat:morning", "fri:morning", "fri:afternoon"]), "sex · manhã e tarde; sáb · manhã");
  });
});

describe("turnos da grade", () => {
  it("ALL_SLOTS tem os 28, de mon:morning a sun:night, na ordem da grade", () => {
    assert.equal(ALL_SLOTS.length, 28);
    assert.equal(ALL_SLOTS[0], "mon:morning");
    assert.equal(ALL_SLOTS.at(-1), "sun:night");
    assert.deepEqual(ALL_SLOTS, EVERY_SLOT);
  });

  it("sortSlots tira repetido e código desconhecido e põe na ordem da grade", () => {
    assert.deepEqual(sortSlots(["sun:night", "mon:morning", "xyz", "mon:morning", "sat:afternoon", "sat:noon"]), [
      "mon:morning",
      "sat:afternoon",
      "sun:night",
    ]);
    assert.deepEqual(sortSlots([...EVERY_SLOT].reverse()), EVERY_SLOT);
    assert.deepEqual(sortSlots([]), []);
  });

  it("slotPeriods dá os turnos de um dia, na ordem (a madrugada por último)", () => {
    const slots = ["sat:night", "sat:morning", "sun:morning"];
    assert.deepEqual(slotPeriods(slots, "sat"), ["morning", "night"]);
    assert.deepEqual(slotPeriods(slots, "sun"), ["morning"]);
    assert.deepEqual(slotPeriods(slots, "mon"), []);
  });

  it("periodsPhrase junta os turnos em minúsculas, na ordem", () => {
    assert.equal(periodsPhrase([]), "");
    assert.equal(periodsPhrase(["afternoon"]), "tarde");
    assert.equal(periodsPhrase(["afternoon", "morning"]), "manhã e tarde");
    assert.equal(periodsPhrase(["night", "evening", "afternoon", "morning"]), "manhã, tarde, noite e madrugada");
  });

  it("dayPeriodsText dá a linha do cartão do dia", () => {
    assert.equal(dayPeriodsText(["night", "morning"]), "Manhã · Madrugada");
    assert.equal(dayPeriodsText(["afternoon"]), "Tarde");
    assert.equal(dayPeriodsText([]), "");
  });

  it("os turnos cobrem o dia todo, sem se sobrepor, e as horas batem com from/to", () => {
    const pad = (h) => String(h).padStart(2, "0");
    const byStart = [...DAY_PERIOD_ORDER].sort((a, b) => DAY_PERIOD[a].from - DAY_PERIOD[b].from);
    assert.deepEqual(byStart, ["night", "morning", "afternoon", "evening"]);
    let hour = 0;
    for (const period of byStart) {
      const { from, to, hours } = DAY_PERIOD[period];
      assert.equal(from, hour, period);
      assert.equal(hours, `${pad(from)}h–${pad(to)}h`, period);
      hour = to;
    }
    assert.equal(hour, 24);
  });
});

describe("availabilitySummary (linha Disponibilidade das Configurações)", () => {
  it("resume em uma linha", () => {
    assert.equal(availabilitySummary([]), "Não informada");
    assert.equal(availabilitySummary(["xyz"]), "Não informada");
    assert.equal(availabilitySummary(WEEK_DAYTIME), "Seg a sex · manhã e tarde");
    assert.equal(availabilitySummary(EVERY_SLOT), "Todos os dias · todos os turnos");
    assert.equal(availabilitySummary(["sun:evening", "sat:evening"]), "Sáb e dom · noite");
    assert.equal(
      availabilitySummary([...DAYS.slice(0, 5).map((day) => `${day}:morning`), "sat:afternoon"]),
      "6 dias · turnos variados",
    );
  });

  it("dias não seguidos com os mesmos turnos: os dias juntados e os turnos", () => {
    const allPeriods = (day) => PERIODS.map((period) => `${day}:${period}`);
    const cases = [
      [["mon:morning", "wed:morning", "fri:morning"], "Seg, qua e sex · manhã"],
      [["sat:evening", "mon:evening"], "Seg e sáb · noite"],
      [["mon:morning", "tue:morning", "wed:morning", "fri:morning"], "Seg a qua e sex · manhã"],
      [["mon:morning", "tue:morning", "thu:morning"], "Seg, ter e qui · manhã"],
      [["sun:morning", "sat:morning", "mon:morning"], "Seg, sáb e dom · manhã"],
      [["wed:afternoon", "mon:morning", "mon:afternoon", "wed:morning"], "Seg e qua · manhã e tarde"],
      [[...allPeriods("tue"), ...allPeriods("thu")], "Ter e qui · manhã, tarde, noite e madrugada"],
      [["mon:night", "tue:night", "wed:night", "fri:night", "sat:night", "sun:night"], "Seg a qua e sex a dom · madrugada"],
    ];
    for (const [slots, text] of cases) {
      assert.equal(availabilitySummary(slots), text, JSON.stringify(slots));
      assert.equal(availabilitySummary([...slots].reverse()), text, `${JSON.stringify(slots)} ao contrário`);
    }
  });

  it("dias seguidos continuam como antes; turnos diferentes entre os dias: turnos variados", () => {
    assert.equal(availabilitySummary(["sat:afternoon"]), "Sáb · tarde");
    assert.equal(availabilitySummary(DAYS.map((day) => `${day}:morning`)), "Seg a dom · manhã");
    assert.equal(availabilitySummary(["mon:morning", "wed:afternoon"]), "2 dias · turnos variados");
    assert.equal(availabilitySummary(["mon:morning", "wed:morning", "fri:morning", "fri:afternoon"]), "3 dias · turnos variados");
    assert.equal(availabilitySummary(["mon:morning", "mon:afternoon", "wed:morning", "xyz"]), "2 dias · turnos variados");
  });
});

describe("transportText", () => {
  it("rótulos na ordem dos meios e a CNH; null sem a parte informada", () => {
    assert.equal(transportText({ modes: ["motorcycle", "car"], driver_license: true }), "Carro, Moto · com CNH");
    assert.equal(transportText({ modes: [], driver_license: false }), "Nenhum · sem CNH");
    assert.equal(transportText(null), null);
    assert.equal(transportText(undefined), null);
  });
});

describe("meses da formação e das aptidões", () => {
  it("monthText aceita AAAA-MM e AAAA-MM-DD", () => {
    assert.equal(monthText("2026-11"), "11/2026");
    assert.equal(monthText("2026-11-19"), "11/2026");
    assert.equal(monthText("x"), "x");
  });

  it("educationPeriodText igual ao servidor", () => {
    assert.equal(educationPeriodText("2022-02", "2023-12"), "02/2022 a 12/2023");
    assert.equal(educationPeriodText("2024-02", null), "desde 02/2024 (em andamento)");
    assert.equal(educationPeriodText("2024-02", undefined), "desde 02/2024 (em andamento)");
  });

  it("sinceText dá o desde da aptidão", () => {
    assert.equal(sinceText("2026-11-19"), "desde 11/2026");
  });
});

describe("maskPixKey", () => {
  it("mostra só o bastante para reconhecer a chave", () => {
    assert.equal(maskPixKey("cpf", "12345678909"), "•••.456.789-••");
    assert.equal(maskPixKey("cnpj", "12345678000195"), "12.345.678/••••-••");
    assert.equal(maskPixKey("email", "tecnico.alfa@exemplo.com"), "t•••@exemplo.com");
    assert.equal(maskPixKey("phone", "+5511988887777"), "+55 (11) •••••-7777");
    assert.equal(maskPixKey("phone", "11988887777"), "+55 (11) •••••-7777");
    assert.equal(maskPixKey("random", "0f3c2e1d-7a6b-4c5d-9e8f-1a2b3c4da1b2"), "…a1b2");
  });

  it("chave fora do formato gravado: só o fim", () => {
    assert.equal(maskPixKey("cpf", "123456789"), "…6789");
    assert.equal(maskPixKey("phone", "1188887777"), "…7777");
  });
});

describe("aviso de privacidade", () => {
  it("PRIVACY_DATE é a data da versão, sem o sufixo do mesmo dia", () => {
    assert.match(PRIVACY_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    assert.equal(PRIVACY_DATE, PRIVACY_VERSION.slice(0, 10).split("-").reverse().join("/"));
    assert.match(PRIVACY_DATE, /^\d{2}\/\d{2}\/\d{4}$/);
    assert.ok(!PRIVACY_DATE.includes("."));
  });

  it("o aviso cita o perfil técnico", () => {
    const body = (title) => PRIVACY_NOTICE.find((item) => item.title === title)?.body ?? "";
    assert.ok(unique(PRIVACY_NOTICE.map((item) => item.title)));
    for (const word of ["perfil técnico", "aptidões", "formação", "ferramental", "transporte", "CNH", "turnos"]) {
      assert.ok(body("Quais dados").includes(word), word);
    }
    assert.ok(body("Para quê").includes("perfil técnico"));
    assert.ok(body("Seus direitos").includes("Configurações"));
  });
});

describe("rótulos e limites", () => {
  it("o histórico do cadastro tem as 5 partes do perfil técnico, com os mesmos nomes", () => {
    assert.deepEqual(TECH_PROFILE_PART, {
      tools: "Ferramental",
      availability: "Disponibilidade",
      transport: "Transporte",
      skills: "Aptidões",
      education: "Formação",
    });
    for (const [part, label] of Object.entries(TECH_PROFILE_PART)) assert.equal(USER_CHANGE_LABEL[part], label, part);
    assert.ok(unique(Object.values(USER_CHANGE_LABEL)));
  });

  it("TECH_PROFILE_LIMITS igual ao servidor", () => {
    assert.equal(TECH_PROFILE_LIMITS.tools, 200);
    assert.equal(TECH_PROFILE_LIMITS.slots, 28);
    assert.equal(TECH_PROFILE_LIMITS.modes, 6);
    assert.equal(TECH_PROFILE_LIMITS.skills, 30);
    assert.equal(TECH_PROFILE_LIMITS.education, 20);
    assert.equal(TECH_PROFILE_LIMITS.textMin, 2);
    assert.equal(TECH_PROFILE_LIMITS.firstMonth, "1950-01");
    assert.equal(TECH_PROFILE_LIMITS.slots, ALL_SLOTS.length);
    assert.equal(TECH_PROFILE_LIMITS.modes, TRANSPORT_MODE_ORDER.length);
  });

  it("cada ordem tem as chaves do seu rótulo, e os rótulos não se repetem", () => {
    const pairs = [
      [WEEKDAY_ORDER, WEEKDAY],
      [DAY_PERIOD_ORDER, DAY_PERIOD],
      [TRANSPORT_MODE_ORDER, TRANSPORT_MODE],
      [SKILL_LEVEL_ORDER, SKILL_LEVEL],
      [EDUCATION_LEVEL_ORDER, EDUCATION_LEVEL],
    ];
    for (const [order, labels] of pairs) {
      assert.deepEqual(order, Object.keys(labels));
      const texts = order.map((key) => (typeof labels[key] === "string" ? labels[key] : labels[key].label));
      assert.ok(unique(texts), texts.join(", "));
    }
    assert.deepEqual(WEEKDAY_ORDER, DAYS);
    assert.deepEqual(DAY_PERIOD_ORDER, PERIODS);
    assert.ok(unique(WEEKDAY_ORDER.map((day) => WEEKDAY[day].short)));
    assert.deepEqual(WORKDAYS, DAYS.slice(0, 5));
  });

  it("SKILL_LEVEL_ORDER usa os códigos da ficha da homologação", () => {
    assert.deepEqual(SKILL_LEVEL_ORDER, ["basico", "intermediario", "avancado"]);
    assert.deepEqual(Object.values(SKILL_LEVEL), ["Básico", "Intermediário", "Avançado"]);
  });

  const onboarding = new URL("../../backend/app/schemas/onboarding.py", import.meta.url);
  it("SKILL_LEVEL igual a SKILL_LEVELS da ficha no backend", { skip: !existsSync(onboarding) && "pasta backend ausente" }, () => {
    const block = /^SKILL_LEVELS[^=\n]*=\s*\{([^}]*)\}/m.exec(readFileSync(onboarding, "utf8"));
    assert.ok(block, "SKILL_LEVELS não encontrado em backend/app/schemas/onboarding.py");
    const entries = [...block[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(Object.fromEntries(entries), SKILL_LEVEL);
    assert.deepEqual(entries.map(([key]) => key), SKILL_LEVEL_ORDER);
  });
});

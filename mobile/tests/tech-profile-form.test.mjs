// Sonda de lib/techProfileForm.ts: as regras das telas do perfil técnico (Configurações › Atendimento) e o redutor do
// salvar ao tocar. Dados fictícios. Sem dependência nova: node:test.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AUTO_SAVE_START,
  autoSaveStep,
  canCopyToWorkdays,
  cleanText,
  copyToWorkdays,
  daySpoken,
  EDUCATION_MSG,
  educationBody,
  educationChanged,
  educationDraftOf,
  educationEntry,
  educationProblem,
  educationSpoken,
  educationWith,
  educationWithout,
  filterTools,
  foldName,
  markNone,
  monthGrid,
  noneMarked,
  sameSavedTransport,
  sameSet,
  sameSlots,
  sameTransport,
  SKILL_MSG,
  skillKey,
  skillLine,
  skillsBody,
  skillSpoken,
  skillsWith,
  skillsWithout,
  sortTools,
  thisMonth,
  toggleId,
  toggleMode,
  toggleSlot,
  TRANSPORT_UNSET,
  transportBody,
} from "../src/lib/techProfileForm.ts";

const WORKWEEK_MORNING_AFTERNOON = ["mon", "tue", "wed", "thu", "fri"].flatMap((day) => [`${day}:morning`, `${day}:afternoon`]);

describe("o módulo é puro", () => {
  it("só importa ./constants e tipos (a sonda roda sem React nem React Native)", () => {
    const source = readFileSync(new URL("../src/lib/techProfileForm.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => ({ type: Boolean(m[1]), from: m[2] }));
    assert.deepEqual(
      imports.filter((i) => !i.type).map((i) => i.from),
      ["./constants"],
    );
    assert.ok(imports.every((i) => i.from.startsWith("./")));
  });
});

describe("nomes", () => {
  it("foldName compara sem acento, maiúsculas e espaços repetidos (como o servidor)", () => {
    assert.equal(foldName("  Impressóras   HP "), "impressoras hp");
    assert.equal(foldName("Câmeras Hikvision"), foldName("CAMERAS hikvision"));
  });

  it("cleanText junta os espaços e grava em NFC", () => {
    assert.equal(cleanText("  Redes \n de   dados "), "Redes de dados");
    assert.equal(cleanText("Curso\tde\r\nredes"), "Curso de redes");
    assert.equal(cleanText("Técnico"), "Técnico");
  });

  it("cleanText e foldName tiram os caracteres de controle e de formatação; tab, LF, VT, FF e CR viram espaço", () => {
    assert.equal(cleanText("Lin\u200Bux"), "Linux");
    assert.equal(cleanText("\u202ERedes\u202C"), "Redes");
    assert.equal(cleanText("Curso\u0000Exemplo"), "CursoExemplo");
    assert.equal(cleanText("\uFEFFRedes\tde\r\ndados\u000B\u000C"), "Redes de dados");
    assert.equal(cleanText("A\u0007\u007F\u009FB"), "AB");
    assert.equal(cleanText("\u200B\u2060\u00AD"), "");
    assert.equal(foldName("LIN\u200BUX"), "linux");
    assert.equal(foldName("\u2066Impressóras\u2069\nHP"), "impressoras hp");
  });
});

// As aptidões do catálogo (id, folha "Adicionar aptidão", busca, carimbo): tests/skill-catalog.test.mjs. Aqui, o formato
// pelo nome (o servidor de antes da gestão) e o que vale para os dois.
describe("aptidões", () => {
  it("skillsBody pelo nome (servidor de antes da gestão): nome limpo, sem invisíveis, e nível; nunca o `since`", () => {
    const body = skillsBody(
      [
        { name: " Redes  de dados ", level: "basico", since: "2026-11-19" },
        { name: "‮Lin​ux", level: "avancado", since: "2025-01-10" },
      ],
      false,
    );
    assert.deepEqual(body, [
      { name: "Redes de dados", level: "basico" },
      { name: "Linux", level: "avancado" },
    ]);
    assert.ok(body.every((item) => !("since" in item) && !("added_at" in item)));
  });

  it("skillsBody pelo catálogo: só o id e o nível (o nome é do catálogo)", () => {
    const id = "00000000-0000-4000-8000-000000000009";
    assert.deepEqual(skillsBody([{ skill_id: id, name: "Linux", level: "avancado", since: "2025-01-10" }], true), [
      { skill_id: id, level: "avancado" },
    ]);
  });

  const SKILLS = [
    { name: "Impressoras HP", level: "avancado", since: "2025-03-01" },
    { name: "Linux", level: "intermediario", since: "2025-02-01" },
    { name: "Redes", level: "basico", since: "2025-01-10" },
  ];

  it("skillsWithout pela chave do nome (sem acento e maiúsculas), sem o `since`; a que já saiu não muda nada", () => {
    assert.equal(skillKey({ name: "impressoras  HP" }), "nome:impressoras hp");
    assert.deepEqual(skillsWithout(SKILLS, skillKey({ name: "impressoras  hp" }), false), [
      { name: "Linux", level: "intermediario" },
      { name: "Redes", level: "basico" },
    ]);
    assert.deepEqual(skillsWithout(SKILLS, skillKey({ name: "Fibra óptica" }), false), skillsBody(SKILLS, false));
  });

  it("skillsWith muda só o nível, com o nome gravado; null se a editada já saiu", () => {
    assert.deepEqual(skillsWith(SKILLS, skillKey({ name: "LINUX" }), "avancado", false), [
      { name: "Impressoras HP", level: "avancado" },
      { name: "Linux", level: "avancado" },
      { name: "Redes", level: "basico" },
    ]);
    assert.equal(skillsWith(SKILLS.slice(0, 1), skillKey({ name: "Linux" }), "avancado", false), null);
    assert.equal(SKILL_MSG.gone, "Esta aptidão foi excluída.");
  });

  it("o texto livre saiu: nada de skillProblem, suggestionsFor nem das mensagens do nome", async () => {
    const lib = await import("../src/lib/techProfileForm.ts");
    assert.equal(lib.skillProblem, undefined);
    assert.equal(lib.suggestionsFor, undefined);
    assert.deepEqual(Object.keys(SKILL_MSG).sort(), ["gone", "level", "pick"]);
  });

  it("a linha e o que o leitor de tela fala", () => {
    const skill = { name: "Impressoras HP", level: "avancado", since: "2026-11-19" };
    assert.equal(skillLine(skill), "Avançado · desde 11/2026");
    assert.equal(skillSpoken(skill), "Impressoras HP, Avançado, desde novembro de 2026");
  });
});

describe("formação", () => {
  const base = { course: "Técnico em redes", level: "technical", institution: "Escola Exemplo", start: "2022-02", end: "2023-12", ongoing: false };

  it("educationProblem: válido, início igual ao fim e em andamento sem fim", () => {
    assert.deepEqual(educationProblem(base), {});
    assert.deepEqual(educationProblem({ ...base, end: "2022-02" }), {});
    assert.deepEqual(educationProblem({ ...base, end: null, ongoing: true }), {});
  });

  it("educationProblem: fim antes do início; sem fim e sem Em andamento", () => {
    assert.deepEqual(educationProblem({ ...base, end: "2021-12" }), { end: "O fim não pode ser antes do início." });
    assert.deepEqual(educationProblem({ ...base, end: null }), { end: "Informe o fim ou marque Em andamento." });
  });

  it("educationProblem: os campos obrigatórios, na ordem da tela", () => {
    const empty = educationDraftOf(null);
    assert.deepEqual(Object.keys(educationProblem(empty)), ["course", "level", "institution", "start", "end"]);
    assert.deepEqual(educationProblem({ ...base, course: " T ", institution: "" }), {
      course: EDUCATION_MSG.course,
      institution: EDUCATION_MSG.institution,
    });
    assert.deepEqual(educationProblem({ ...base, start: null }), { start: "Informe o início." });
  });

  it("educationEntry e educationBody: a nova vai sem id, a editada com o mesmo id; em andamento vai sem fim", () => {
    const fresh = educationEntry({ ...base, course: "  Técnico  em redes " });
    assert.deepEqual(educationBody([fresh]), [
      { course: "Técnico em redes", level: "technical", institution: "Escola Exemplo", start: "2022-02", end: "2023-12" },
    ]);
    const edited = educationEntry({ ...base, ongoing: true }, "00000000-0000-4000-8000-000000000123");
    assert.deepEqual(educationBody([edited]), [
      {
        id: "00000000-0000-4000-8000-000000000123",
        course: "Técnico em redes",
        level: "technical",
        institution: "Escola Exemplo",
        start: "2022-02",
        end: null,
      },
    ]);
    assert.equal(educationEntry({ ...base, level: null }), null);
  });

  const COURSES = [
    { id: "e-1", course: "Curso Alfa", level: "technical", institution: "Escola Exemplo", start: "2019-02", end: "2020-12" },
    { id: "e-2", course: "Curso Beta", level: "certification", institution: "Escola Exemplo", start: "2021-03", end: null },
  ];

  it("educationWithout e educationWith: pelo id; a nova vai no fim e sem id; null se a editada já saiu", () => {
    assert.deepEqual(
      educationWithout(COURSES, "e-1").map((item) => item.id),
      ["e-2"],
    );
    const fresh = { course: "Curso Gama", level: "free_course", institution: "Escola Exemplo", start: "2022-01", end: "2022-02" };
    assert.deepEqual(educationWith(COURSES, fresh).at(-1), fresh);
    const edited = { ...COURSES[0], course: "Curso Alfa Dois" };
    assert.deepEqual(
      educationWith(COURSES, edited).map((item) => `${item.id}:${item.course}`),
      ["e-1:Curso Alfa Dois", "e-2:Curso Beta"],
    );
    assert.equal(educationWith(COURSES.slice(1), edited), null);
    assert.equal(EDUCATION_MSG.gone, "Esta formação foi excluída.");
  });

  it("educationProblem: curso e instituição só de caracteres de controle contam como vazios", () => {
    assert.deepEqual(educationProblem({ ...base, course: "\u0001\u0002\u0003", institution: "\u0000\u0000" }), {
      course: EDUCATION_MSG.course,
      institution: EDUCATION_MSG.institution,
    });
  });

  it("educationChanged: o fim não conta com Em andamento marcado", () => {
    const item = { id: "x", course: "Técnico em redes", level: "technical", institution: "Escola Exemplo", start: "2024-02", end: null };
    const draft = educationDraftOf(item);
    assert.equal(draft.ongoing, true);
    assert.equal(educationChanged(draft, draft), false);
    assert.equal(educationChanged({ ...draft, end: "2024-05" }, draft), false);
    assert.equal(educationChanged({ ...draft, ongoing: false, end: "2024-05" }, draft), true);
    assert.equal(educationChanged({ ...draft, course: " Técnico em  redes" }, draft), false);
  });

  it("o que o leitor de tela fala do curso", () => {
    const item = { id: "x", course: "Técnico em redes", level: "technical", institution: "Escola Exemplo", start: "2022-02", end: "2023-12" };
    assert.equal(educationSpoken(item), "Técnico em redes, Técnico, Escola Exemplo, de fevereiro de 2022 a dezembro de 2023");
    assert.equal(
      educationSpoken({ ...item, start: "2024-02", end: null }),
      "Técnico em redes, Técnico, Escola Exemplo, desde fevereiro de 2024, em andamento",
    );
  });
});

describe("listas: o corpo montado quando a gravação sai da fila (saveProfileWith)", () => {
  const SKILLS = [
    { name: "Impressoras HP", level: "avancado", since: "2025-03-01" },
    { name: "Linux", level: "intermediario", since: "2025-02-01" },
    { name: "Redes", level: "basico", since: "2025-01-10" },
  ];
  /** O servidor (services/tech_profile): grava a lista enviada; quem já estava mantém o "desde", a nova ganha o dia. */
  const apply = (stored, body) =>
    body.map((item) => ({ ...item, since: stored.find((old) => foldName(old.name) === foldName(item.name))?.since ?? "2026-11-20" }));

  const PRINTERS = skillKey({ name: "Impressoras HP" });
  const LINUX = skillKey({ name: "Linux" });

  it("duas exclusões em fila terminam sem as duas: cada corpo sai do que a anterior gravou", () => {
    let stored = SKILLS;
    for (const build of [(list) => skillsWithout(list, PRINTERS, false), (list) => skillsWithout(list, LINUX, false)]) {
      stored = apply(stored, build(stored));
    }
    assert.deepEqual(stored, [{ name: "Redes", level: "basico", since: "2025-01-10" }]);

    // O defeito corrigido: com os dois corpos montados da mesma lista, a 2ª exclusão devolvia a 1ª, com o "desde" do dia.
    let early = SKILLS;
    for (const body of [skillsWithout(SKILLS, PRINTERS, false), skillsWithout(SKILLS, LINUX, false)]) early = apply(early, body);
    assert.deepEqual(
      early.map((item) => `${item.name}@${item.since}`),
      ["Impressoras HP@2026-11-20", "Redes@2025-01-10"],
    );
  });

  it("mudar o nível de uma aptidão que a gravação anterior excluiu não monta corpo (a folha mostra o erro)", () => {
    const afterRemoval = apply(SKILLS, skillsWithout(SKILLS, LINUX, false));
    assert.equal(skillsWith(afterRemoval, LINUX, "avancado", false), null);
  });
});

describe("disponibilidade", () => {
  it("toggleSlot marca e desmarca, na ordem da grade e sem repetir", () => {
    assert.deepEqual(toggleSlot(["sat:afternoon"], "mon:night"), ["mon:night", "sat:afternoon"]);
    assert.deepEqual(toggleSlot(["mon:night", "sat:afternoon"], "mon:night"), ["sat:afternoon"]);
    assert.deepEqual(toggleSlot(["sat:afternoon", "sat:afternoon", "xyz"], "mon:morning"), ["mon:morning", "sat:afternoon"]);
    assert.deepEqual(toggleSlot([], "sun:evening"), ["sun:evening"]);
  });

  it("sameSlots ignora a ordem e os repetidos", () => {
    assert.equal(sameSlots(["sat:afternoon", "mon:morning"], ["mon:morning", "sat:afternoon", "mon:morning"]), true);
    assert.equal(sameSlots(["mon:morning"], ["mon:afternoon"]), false);
  });

  it("copyToWorkdays: de segunda, com a terça vazia, não pergunta; sábado e domingo não mudam", () => {
    const slots = ["mon:morning", "mon:afternoon", "sat:evening", "sun:night"];
    const { next, overwrites } = copyToWorkdays(slots, "mon");
    assert.equal(overwrites, false);
    assert.deepEqual(next, [...WORKWEEK_MORNING_AFTERNOON, "sat:evening", "sun:night"]);
  });

  it("copyToWorkdays: com a quarta diferente, pergunta; com a quarta igual, não", () => {
    assert.equal(copyToWorkdays(["mon:morning", "wed:night"], "mon").overwrites, true);
    assert.equal(copyToWorkdays(["mon:morning", "wed:morning"], "mon").overwrites, false);
    const { next } = copyToWorkdays(["mon:morning", "wed:night", "sat:morning"], "mon");
    assert.deepEqual(next, ["mon:morning", "tue:morning", "wed:morning", "thu:morning", "fri:morning", "sat:morning"]);
  });

  it("canCopyToWorkdays: só num dia útil com turno e outro dia útil diferente", () => {
    assert.equal(canCopyToWorkdays(["mon:morning"], "mon"), true);
    assert.equal(canCopyToWorkdays(WORKWEEK_MORNING_AFTERNOON, "wed"), false);
    assert.equal(canCopyToWorkdays(["tue:morning"], "mon"), false);
    assert.equal(canCopyToWorkdays(["sat:morning"], "sat"), false);
  });

  it("o cabeçalho do dia para o leitor de tela", () => {
    assert.equal(daySpoken("mon", ["morning", "afternoon"]), "Segunda-feira, manhã e tarde");
    assert.equal(daySpoken("sun", []), "Domingo, sem turnos");
  });
});

describe("transporte e ferramental", () => {
  it("toggleMode, transportBody (na ordem da lista) e sameTransport", () => {
    const start = TRANSPORT_UNSET;
    const withMoto = toggleMode(start, "motorcycle");
    const both = toggleMode(withMoto, "car");
    assert.deepEqual(both.modes, ["motorcycle", "car"]);
    assert.deepEqual(transportBody(both), { modes: ["car", "motorcycle"], driver_license: false });
    assert.equal(sameTransport(both, { modes: ["car", "motorcycle"], driver_license: false }), true);
    assert.equal(sameTransport(both, { modes: ["car", "motorcycle"], driver_license: true }), false);
    assert.deepEqual(toggleMode(both, "car").modes, ["motorcycle"]);
    assert.deepEqual(TRANSPORT_UNSET, { modes: [], driver_license: false });
  });

  it("TRANSPORT_UNSET (nunca informado) vale pela identidade: sameSavedTransport", () => {
    const informed = { modes: [], driver_license: false };
    assert.ok(Object.isFrozen(TRANSPORT_UNSET));
    assert.equal(sameSavedTransport(TRANSPORT_UNSET, TRANSPORT_UNSET), true);
    assert.equal(sameSavedTransport(informed, TRANSPORT_UNSET), false);
    assert.equal(sameSavedTransport(TRANSPORT_UNSET, informed), false);
    assert.equal(sameSavedTransport(informed, { modes: [], driver_license: false }), true);
    assert.equal(
      sameSavedTransport({ modes: ["car", "motorcycle"], driver_license: true }, { modes: ["motorcycle", "car"], driver_license: true }),
      true,
    );
    // Marcar e desmarcar devolve um valor novo, nunca o nunca informado.
    assert.notEqual(toggleMode(toggleMode(TRANSPORT_UNSET, "car"), "car"), TRANSPORT_UNSET);
  });

  it("Nenhum: marcado com o transporte informado sem meio; tocar tira os meios e mantém a CNH; um meio o desmarca", () => {
    assert.equal(noneMarked(TRANSPORT_UNSET), false);
    assert.equal(noneMarked({ modes: [], driver_license: false }), true);
    assert.equal(noneMarked({ modes: [], driver_license: true }), true);
    assert.equal(noneMarked({ modes: ["on_foot"], driver_license: false }), false);
    assert.deepEqual(markNone({ modes: ["car", "motorcycle"], driver_license: true }), { modes: [], driver_license: true });
    const first = markNone(TRANSPORT_UNSET);
    assert.notEqual(first, TRANSPORT_UNSET);
    assert.equal(noneMarked(first), true);
    assert.equal(noneMarked(toggleMode(first, "car")), false);
  });

  it("toggleId e sameSet", () => {
    assert.deepEqual(toggleId(["a"], "b"), ["a", "b"]);
    assert.deepEqual(toggleId(["a", "b"], "a"), ["b"]);
    assert.equal(sameSet(["a", "b"], ["b", "a", "a"]), true);
    assert.equal(sameSet(["a"], ["a", "b"]), false);
  });

  it("sortTools em ordem alfabética sem diferença de acento e maiúsculas; filterTools em qualquer parte do nome", () => {
    const tools = [
      { id: "1", name: "Multímetro" },
      { id: "2", name: "alicate de crimpar" },
      { id: "3", name: "Etiquetadora" },
      { id: "4", name: "Cabo console" },
    ];
    assert.deepEqual(
      sortTools(tools).map((tool) => tool.name),
      ["alicate de crimpar", "Cabo console", "Etiquetadora", "Multímetro"],
    );
    assert.deepEqual(
      filterTools(tools, "  METRO ").map((tool) => tool.id),
      ["1"],
    );
    assert.equal(filterTools(tools, "").length, 4);
    assert.deepEqual(filterTools(tools, "furadeira"), []);
  });
});

describe("folha do mês", () => {
  it("monthGrid(2026, 1950-01, 2026-11): dezembro desligado, o escolhido marcado", () => {
    const cells = monthGrid(2026, "1950-01", "2026-11", "2026-02");
    assert.equal(cells.length, 12);
    assert.deepEqual(
      cells.map((cell) => cell.label),
      ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
    );
    assert.equal(cells[11].disabled, true);
    assert.equal(cells[10].disabled, false);
    assert.equal(cells[1].selected, true);
    assert.equal(cells[1].spoken, "fevereiro de 2026");
    assert.equal(cells.filter((cell) => cell.selected).length, 1);
  });

  it("monthGrid(1949): todos fora; o mínimo do fim é o início", () => {
    assert.ok(monthGrid(1949, "1950-01", "2026-11", null).every((cell) => cell.disabled));
    const end = monthGrid(2022, "2022-02", "2026-11", null);
    assert.equal(end[0].disabled, true);
    assert.equal(end[1].disabled, false);
  });

  it("thisMonth no fuso do aparelho", () => {
    assert.equal(thisMonth(new Date(2026, 10, 19, 23, 59)), "2026-11");
    assert.equal(thisMonth(new Date(2027, 0, 1, 0, 0)), "2027-01");
  });
});

describe("salvar ao tocar (autoSaveStep)", () => {
  const step = (state, event) => autoSaveStep(state, event, sameSet);

  it("toque → espera → envio → gravado igual → parado, com o Salvo por 2 s", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a"] });
    assert.deepEqual(r.effect, { kind: "schedule" });
    assert.equal(r.state.status, "saving");
    r = step(r.state, { type: "due", saved: [] });
    assert.deepEqual(r.effect, { kind: "send", value: ["a"], epoch: 0 });
    assert.equal(r.state.phase, "sending");
    r = step(r.state, { type: "done", epoch: 0, saved: ["a"] });
    assert.deepEqual(r.effect, { kind: "saved" });
    assert.equal(r.state.desired, null);
    assert.equal(r.state.phase, "idle");
    assert.equal(r.state.status, "saved");
    r = step(r.state, { type: "settled" });
    assert.equal(r.state.status, "idle");
  });

  it("toques de perto vão num envio só, com o último valor", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a"] });
    r = step(r.state, { type: "change", value: ["a", "b"] });
    assert.deepEqual(r.effect, { kind: "schedule" });
    r = step(r.state, { type: "change", value: ["a", "b", "c"] });
    r = step(r.state, { type: "due", saved: [] });
    assert.deepEqual(r.effect, { kind: "send", value: ["a", "b", "c"], epoch: 0 });
  });

  it("marcou e desmarcou antes de enviar: nada sai", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a", "x"] });
    r = step(r.state, { type: "change", value: ["a"] });
    r = step(r.state, { type: "due", saved: ["a"] });
    assert.equal(r.effect, null);
    assert.equal(r.state.desired, null);
    assert.equal(r.state.status, "idle");
  });

  it("toque durante o envio → segundo envio na hora, com o valor final", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a"] });
    r = step(r.state, { type: "due", saved: [] });
    r = step(r.state, { type: "change", value: ["a", "b"] });
    assert.equal(r.effect, null);
    assert.equal(r.state.again, true);
    r = step(r.state, { type: "change", value: ["a", "b", "c"] });
    r = step(r.state, { type: "done", epoch: 0, saved: ["a"] });
    assert.deepEqual(r.effect, { kind: "send", value: ["a", "b", "c"], epoch: 0 });
    assert.deepEqual(r.state.desired, ["a", "b", "c"]);
    r = step(r.state, { type: "done", epoch: 0, saved: ["a", "b", "c"] });
    assert.deepEqual(r.effect, { kind: "saved" });
    assert.equal(r.state.desired, null);
  });

  it("mexeu durante o envio e voltou ao que foi enviado: não manda de novo", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a"] });
    r = step(r.state, { type: "due", saved: [] });
    r = step(r.state, { type: "change", value: ["a", "b"] });
    r = step(r.state, { type: "change", value: ["a"] });
    r = step(r.state, { type: "done", epoch: 0, saved: ["a"] });
    assert.deepEqual(r.effect, { kind: "saved" });
    assert.equal(r.state.phase, "idle");
  });

  it("o servidor ignorou um item (ferramenta desativada): a tela volta a seguir o que ele gravou", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a", "desativada"] });
    r = step(r.state, { type: "due", saved: ["a"] });
    r = step(r.state, { type: "done", epoch: 0, saved: ["a"] });
    assert.equal(r.state.desired, null);
    assert.equal(r.state.phase, "idle");
  });

  it("falha → volta ao que está gravado, sem o Salvo", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a"] });
    r = step(r.state, { type: "due", saved: [] });
    r = step(r.state, { type: "change", value: ["a", "b"] });
    r = step(r.state, { type: "failed", epoch: 0 });
    assert.equal(r.effect, null);
    assert.equal(r.state.desired, null);
    assert.equal(r.state.phase, "idle");
    assert.equal(r.state.status, "idle");
    assert.equal(r.state.again, false);
  });

  it("sessão trocada → descarta o pendente, e a resposta de antes não conta", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: ["a"] });
    r = step(r.state, { type: "reset" });
    assert.deepEqual(r.effect, { kind: "cancel" });
    assert.equal(r.state.desired, null);
    assert.equal(r.state.epoch, 1);
    assert.equal(step(r.state, { type: "due", saved: [] }).effect, null);

    let s = step(AUTO_SAVE_START, { type: "change", value: ["a"] });
    s = step(s.state, { type: "due", saved: [] });
    s = step(s.state, { type: "reset" });
    const late = step(s.state, { type: "done", epoch: 0, saved: ["a"] });
    assert.equal(late.effect, null);
    assert.equal(late.state, s.state);
    assert.equal(step(s.state, { type: "failed", epoch: 0 }).state, s.state);
  });
});

describe("salvar ao tocar do Transporte (sameSavedTransport)", () => {
  const step = (state, event) => autoSaveStep(state, event, sameSavedTransport);
  const NONE = { modes: [], driver_license: false };

  it("nunca informado: marcar e desmarcar um meio antes do envio grava Nenhum · sem CNH", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: toggleMode(TRANSPORT_UNSET, "car") });
    r = step(r.state, { type: "change", value: toggleMode(r.state.desired, "car") });
    r = step(r.state, { type: "due", saved: TRANSPORT_UNSET });
    assert.deepEqual(r.effect, { kind: "send", value: NONE, epoch: 0 });
    r = step(r.state, { type: "done", epoch: 0, saved: { modes: [], driver_license: false } });
    assert.deepEqual(r.effect, { kind: "saved" });
    assert.equal(r.state.desired, null);
  });

  it("nunca informado: tocar em Nenhum envia sem meio e sem CNH", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: markNone(TRANSPORT_UNSET) });
    r = step(r.state, { type: "due", saved: TRANSPORT_UNSET });
    assert.deepEqual(r.effect, { kind: "send", value: NONE, epoch: 0 });
  });

  it("já informado sem meio e sem CNH: marcar e desmarcar não envia", () => {
    let r = step(AUTO_SAVE_START, { type: "change", value: toggleMode(NONE, "car") });
    r = step(r.state, { type: "change", value: toggleMode(r.state.desired, "car") });
    r = step(r.state, { type: "due", saved: { modes: [], driver_license: false } });
    assert.equal(r.effect, null);
    assert.equal(r.state.status, "idle");
  });
});

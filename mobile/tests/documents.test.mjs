// Sonda de lib/documentRules.ts: as regras de Configurações › Documentos e › Currículo (contrato da Entrega 2, §6.3, §9 e
// §11): o tipo, o nome e o tamanho do arquivo, o formulário (título, validade só na certificação, arquivo), os campos do
// envio, da troca do arquivo e do PATCH, a ordem dos blocos e os resumos das linhas do menu. E, pelas fontes, o alvo
// "document" da câmera e as telas novas. Dados fictícios. Sem dependência nova: node:test.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DOCUMENT_ACCEPT, DOCUMENT_LIMITS, documentFileKind } from "../src/lib/constants.ts";
import {
  DOCUMENT_FIELDS,
  DOCUMENT_GROUP_TEXT,
  DOCUMENT_GROUPS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MSG,
  DOCUMENT_PICKER_TYPES,
  DOCUMENT_SEND_TEXT,
  DOCUMENT_WEB_ACCEPT,
  documentChanged,
  documentDraftOf,
  documentFields,
  documentFileLine,
  documentFileType,
  documentGroupOf,
  documentGroupParam,
  documentPatch,
  documentProblem,
  documentsFull,
  DOCUMENTS_LIMIT_TEXT,
  documentSpoken,
  documentsRowSummary,
  documentUploadName,
  editableDocument,
  EXPIRES_MIN,
  expiresMax,
  expiresOk,
  FILE_PROBLEM_TEXT,
  fileSizeProblem,
  firstDocumentProblem,
  groupOfParam,
  knownDocuments,
  replaceFields,
  resumeFields,
  resumeRowSummary,
  splitDocuments,
} from "../src/lib/documentRules.ts";

const TODAY = "2026-11-26";
const MB = 1024 * 1024;
/** 26/11/2026 ao meio-dia, no fuso de quem roda a sonda (o nome do arquivo usa o dia do aparelho). */
const DAY = new Date(2026, 10, 26, 12);
const UPLOAD_ID = "00000000-0000-4000-8000-0000000000aa";

let seq = 0;
/** Um documento como vem em MyProfile.documents (fictício). */
function doc(overrides = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kind: "certification",
    title: "NR10 Exemplo",
    expires_on: null,
    file_name: "nr10-exemplo.pdf",
    content_type: "application/pdf",
    size: 120_000,
    uploaded_at: "2026-11-20T15:00:00Z",
    via: "app",
    ...overrides,
  };
}

const titles = (list) => list.map((item) => item.title);

describe("o módulo é puro", () => {
  it("só importa ./constants, ./techProfileForm e tipos (a sonda roda sem React nem React Native)", () => {
    const source = readFileSync(new URL("../src/lib/documentRules.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => ({ type: Boolean(m[1]), from: m[2] }));
    assert.deepEqual(
      imports.filter((i) => !i.type).map((i) => i.from),
      ["./constants", "./techProfileForm"],
    );
    assert.ok(imports.every((i) => i.from.startsWith("./")));
  });
});

describe("o arquivo", () => {
  it("documentFileType: pela extensão; sem ela, pelo tipo que o sistema informa", () => {
    assert.deepEqual(documentFileType("RG.PDF", ""), { kind: "pdf", mime: "application/pdf", ext: "pdf" });
    assert.deepEqual(documentFileType("scan", "application/pdf"), { kind: "pdf", mime: "application/pdf", ext: "pdf" });
    assert.deepEqual(documentFileType("foto.jpeg", null), { kind: "image", mime: "image/jpeg", ext: "jpg" });
    assert.deepEqual(documentFileType("1000123", "image/jpg"), { kind: "image", mime: "image/jpeg", ext: "jpg" });
    assert.deepEqual(documentFileType("x.webp", undefined), { kind: "image", mime: "image/webp", ext: "webp" });
    assert.deepEqual(documentFileType("cnh.png", "image/png; charset=binary"), { kind: "image", mime: "image/png", ext: "png" });
  });

  it("documentFileType: GIF, HEIC, XML, HTML e o tipo genérico ficam fora (contrato §11)", () => {
    assert.equal(documentFileType("anim.gif", "image/gif"), null);
    assert.equal(documentFileType("foto.heic", "image/heic"), null);
    assert.equal(documentFileType("1000124", "image/heic"), null);
    assert.equal(documentFileType("nota.xml", "application/xml"), null);
    assert.equal(documentFileType("pagina.html", "text/html"), null);
    assert.equal(documentFileType("doc", "application/octet-stream"), null);
    assert.equal(documentFileType("x.constructor", null), null);
    assert.equal(documentFileType("", null), null);
  });

  it("os tipos do seletor são os do contrato (DOCUMENT_ACCEPT) e a web aceita também as extensões", () => {
    assert.deepEqual([...DOCUMENT_PICKER_TYPES], ["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    assert.equal(DOCUMENT_PICKER_TYPES.join(","), DOCUMENT_ACCEPT);
    for (const item of [".pdf", ".jpg", ".jpeg", ".png", ".webp", "application/pdf", "image/webp"]) {
      assert.ok(DOCUMENT_WEB_ACCEPT.split(",").includes(item), item);
    }
    assert.ok(!DOCUMENT_WEB_ACCEPT.includes("gif") && !DOCUMENT_WEB_ACCEPT.includes("heic"));
  });

  it("documentUploadName: o nome do aparelho sem acento nem símbolo, ou o nome-base com o dia", () => {
    assert.equal(documentUploadName("Currículo Técnico (1).pdf", "pdf", "curriculo", DAY), "Curriculo_Tecnico_1.pdf");
    assert.equal(documentUploadName(null, "jpg", "documento", DAY), "documento-2026-11-26.jpg");
    assert.equal(documentUploadName("....pdf", "pdf", "documento", DAY), "documento-2026-11-26.pdf");
    assert.equal(documentUploadName("foto.jpeg", "jpg", "documento", DAY), "foto.jpg");
    assert.equal(documentUploadName(`${"a".repeat(200)}.pdf`, "pdf", "documento", DAY), `${"a".repeat(80)}.pdf`);
    assert.equal(documentUploadName("NR10 Exemplo - 2026.PDF", "pdf", "documento", DAY), "NR10_Exemplo_-_2026.pdf");
  });

  it("fileSizeProblem: 10 MB exatos passam, um byte a mais não; vazio é leitura; sem tamanho, vale a cópia", () => {
    assert.equal(DOCUMENT_MAX_BYTES, DOCUMENT_LIMITS.maxMb * MB);
    assert.equal(DOCUMENT_MAX_BYTES, 10 * MB);
    assert.equal(fileSizeProblem(10 * MB), null);
    assert.equal(fileSizeProblem(10 * MB + 1), "size");
    assert.equal(fileSizeProblem(1), null);
    assert.equal(fileSizeProblem(0), "read");
    assert.equal(fileSizeProblem(null), null);
    assert.equal(fileSizeProblem(undefined), null);
  });

  it("os textos dos arquivos que não servem são os do contrato §9", () => {
    assert.equal(FILE_PROBLEM_TEXT.type, "Use PDF ou foto (JPG, PNG ou WebP).");
    assert.equal(FILE_PROBLEM_TEXT.size, "Arquivo maior que 10 MB.");
    assert.ok(FILE_PROBLEM_TEXT.read.endsWith("."));
  });
});

describe("o formulário", () => {
  it("documentProblem: título, validade (só na certificação) e arquivo, com os textos do contrato §9", () => {
    assert.deepEqual(documentProblem("personal", { title: "", expiresOn: null }, false, TODAY), {
      title: "Informe o título.",
      file: "Escolha o arquivo.",
    });
    assert.deepEqual(documentProblem("personal", { title: "  R  ", expiresOn: null }, true, TODAY), { title: DOCUMENT_MSG.title });
    assert.deepEqual(documentProblem("personal", { title: "RG", expiresOn: null }, true, TODAY), {});
    assert.deepEqual(documentProblem("certification", { title: "NR10 Exemplo", expiresOn: null }, true, TODAY), {});
    // A validade que sobrou num documento pessoal não conta (ela nem vai no envio).
    assert.deepEqual(documentProblem("personal", { title: "RG", expiresOn: "1990-01-01" }, true, TODAY), {});
  });

  it("documentProblem: título de 80 caracteres passa, de 81 não (contrato §11)", () => {
    assert.deepEqual(documentProblem("personal", { title: "a".repeat(80), expiresOn: null }, true, TODAY), {});
    assert.deepEqual(documentProblem("personal", { title: "a".repeat(81), expiresOn: null }, true, TODAY), {
      title: DOCUMENT_MSG.titleMax,
    });
    assert.equal(DOCUMENT_MSG.titleMax, "No máximo 80 caracteres.");
  });

  it("validade: de 2000-01-01 a hoje + 20 anos, e só data que existe", () => {
    assert.equal(EXPIRES_MIN, "2000-01-01");
    assert.equal(expiresMax(TODAY), "2046-11-26");
    // 29/02 num ano que não é bissexto vira 28/02.
    assert.equal(expiresMax("2080-02-29"), "2100-02-28");
    assert.equal(expiresOk("2000-01-01", TODAY), true);
    assert.equal(expiresOk("2046-11-26", TODAY), true);
    assert.equal(expiresOk("2025-11-25", TODAY), true);
    for (const bad of ["1999-12-31", "2046-11-27", "2026-02-30", "26/11/2026", ""]) {
      assert.equal(expiresOk(bad, TODAY), false, bad);
      assert.deepEqual(documentProblem("certification", { title: "NR10", expiresOn: bad }, true, TODAY), { expiresOn: "Confira a validade." }, bad);
    }
  });

  it("firstDocumentProblem: o primeiro na ordem da tela (título, validade, arquivo)", () => {
    assert.deepEqual([...DOCUMENT_FIELDS], ["title", "expiresOn", "file"]);
    assert.equal(firstDocumentProblem({ file: "Escolha o arquivo.", expiresOn: "Confira a validade." }), "Confira a validade.");
    assert.equal(firstDocumentProblem(documentProblem("certification", { title: "", expiresOn: "1990-01-01" }, false, TODAY)), "Informe o título.");
    assert.equal(firstDocumentProblem({}), null);
  });

  it("documentDraftOf: vazio ao incluir; o gravado ao editar", () => {
    assert.deepEqual(documentDraftOf(null), { title: "", expiresOn: null });
    assert.deepEqual(documentDraftOf(doc({ title: "NR35", expires_on: "2027-03-01" })), { title: "NR35", expiresOn: "2027-03-01" });
  });
});

describe("os campos do envio", () => {
  it("documentFields: o tipo do grupo, o título limpo e a validade só na certificação preenchida", () => {
    assert.deepEqual(documentFields("certification", { title: "  NR10   Exemplo ", expiresOn: "2027-01-10" }, UPLOAD_ID), {
      kind: "certification",
      title: "NR10 Exemplo",
      client_upload_id: UPLOAD_ID,
      expires_on: "2027-01-10",
    });
    assert.deepEqual(documentFields("certification", { title: "NR35", expiresOn: null }, UPLOAD_ID), {
      kind: "certification",
      title: "NR35",
      client_upload_id: UPLOAD_ID,
    });
    assert.deepEqual(documentFields("personal", { title: "RG", expiresOn: "2030-01-01" }, UPLOAD_ID), {
      kind: "personal",
      title: "RG",
      client_upload_id: UPLOAD_ID,
    });
  });

  it("resumeFields: o currículo sobe com o título \"Currículo\"", () => {
    assert.deepEqual(resumeFields(UPLOAD_ID), { kind: "resume", title: "Currículo", client_upload_id: UPLOAD_ID });
  });

  it("documentPatch: só o que mudou; a validade só na certificação, null tira", () => {
    const cert = doc({ title: "NR10 Exemplo", expires_on: "2027-01-10" });
    assert.deepEqual(documentPatch("certification", { title: "NR10 Exemplo", expiresOn: "2027-01-10" }, cert), {});
    assert.deepEqual(documentPatch("certification", { title: " NR10  Exemplo ", expiresOn: "2027-01-10" }, cert), {});
    assert.deepEqual(documentPatch("certification", { title: "NR10 Reciclagem", expiresOn: "2027-01-10" }, cert), { title: "NR10 Reciclagem" });
    assert.deepEqual(documentPatch("certification", { title: "NR10 Exemplo", expiresOn: "2028-01-10" }, cert), { expires_on: "2028-01-10" });
    assert.deepEqual(documentPatch("certification", { title: "NR10 Exemplo", expiresOn: null }, cert), { expires_on: null });
    const rg = doc({ kind: "personal", title: "RG", expires_on: null });
    assert.deepEqual(documentPatch("personal", { title: "RG", expiresOn: "2030-01-01" }, rg), {});
    assert.deepEqual(documentPatch("personal", { title: "RG frente", expiresOn: null }, rg), { title: "RG frente" });
  });

  it("documentChanged: arquivo novo conta; sem nada mudado, não", () => {
    const cert = doc({ title: "NR10 Exemplo", expires_on: null });
    assert.equal(documentChanged("certification", { title: "NR10 Exemplo", expiresOn: null }, cert, false), false);
    assert.equal(documentChanged("certification", { title: "NR10 Exemplo", expiresOn: null }, cert, true), true);
    assert.equal(documentChanged("certification", { title: "NR10 Exemplo", expiresOn: "2027-01-10" }, cert, false), true);
  });

  it("replaceFields: o client_upload_id e só o que mudou junto (\"\" tira a validade)", () => {
    const cert = doc({ title: "NR10 Exemplo", expires_on: "2027-01-10" });
    assert.deepEqual(replaceFields("certification", { title: "NR10 Exemplo", expiresOn: "2027-01-10" }, cert, UPLOAD_ID), {
      client_upload_id: UPLOAD_ID,
    });
    assert.deepEqual(replaceFields("certification", { title: "NR10 Reciclagem", expiresOn: "2028-01-10" }, cert, UPLOAD_ID), {
      client_upload_id: UPLOAD_ID,
      title: "NR10 Reciclagem",
      expires_on: "2028-01-10",
    });
    assert.deepEqual(replaceFields("certification", { title: "NR10 Exemplo", expiresOn: null }, cert, UPLOAD_ID), {
      client_upload_id: UPLOAD_ID,
      expires_on: "",
    });
  });
});

describe("as listas", () => {
  it("splitDocuments: certificações pela validade (sem validade por último), pessoais pelo título e o currículo à parte", () => {
    const list = [
      doc({ kind: "personal", title: "RG" }),
      doc({ title: "NR35 Exemplo", expires_on: null }),
      doc({ kind: "resume", title: "Currículo", uploaded_at: "2026-11-01T12:00:00Z" }),
      doc({ title: "NR33 Exemplo", expires_on: "2027-05-01" }),
      doc({ kind: "personal", title: "Água e luz (comprovante)" }),
      doc({ title: "NR10 Exemplo", expires_on: "2026-11-20" }),
      doc({ kind: "personal", title: "cnh" }),
      doc({ kind: "internal", title: "Contrato" }),
    ];
    const split = splitDocuments(list);
    assert.deepEqual(titles(split.certifications), ["NR10 Exemplo", "NR33 Exemplo", "NR35 Exemplo"]);
    assert.deepEqual(titles(split.personal), ["Água e luz (comprovante)", "cnh", "RG"]);
    assert.equal(split.resume?.title, "Currículo");
    assert.deepEqual(splitDocuments(null), { certifications: [], personal: [], resume: null });
  });

  it("knownDocuments: o tipo que o app não conhece (o anexo interno, um tipo novo) não aparece", () => {
    const list = [doc(), doc({ kind: "internal" }), doc({ kind: "outro" }), null];
    assert.equal(knownDocuments(list).length, 1);
    assert.deepEqual(knownDocuments(undefined), []);
  });

  it("documentsFull: 30 entre certificações e documentos pessoais; o currículo não conta", () => {
    const many = (n, kind) => Array.from({ length: n }, () => doc({ kind }));
    assert.equal(documentsFull([...many(15, "certification"), ...many(15, "personal")]), true);
    assert.equal(documentsFull([...many(29, "personal"), doc({ kind: "resume" })]), false);
    assert.equal(DOCUMENT_LIMITS.perTechnician, 30);
    assert.equal(DOCUMENTS_LIMIT_TEXT, "Limite de 30 documentos e certificações. Exclua um para incluir outro.");
  });

  it("editableDocument: o documento pelo id; o currículo e o id que não está ficam de fora", () => {
    const rg = doc({ kind: "personal", title: "RG" });
    const resume = doc({ kind: "resume", title: "Currículo" });
    assert.equal(editableDocument([rg, resume], rg.id), rg);
    assert.equal(editableDocument([rg, resume], resume.id), null);
    assert.equal(editableDocument([rg], "outro-id"), null);
    assert.equal(editableDocument([rg], null), null);
  });

  it("documentFileLine: \"{PDF|Foto} · enviado em …\", e \"enviado pela central em …\" (documentFileKind)", () => {
    assert.equal(documentFileKind("application/pdf"), "PDF");
    assert.equal(documentFileLine(doc({ content_type: "application/pdf", uploaded_at: "2026-11-20T15:00:00Z", via: "app" })), "PDF · enviado em 20/11/2026");
    assert.equal(
      documentFileLine(doc({ content_type: "image/jpeg", uploaded_at: "2026-11-20T15:00:00Z", via: "central" })),
      "Foto · enviado pela central em 20/11/2026",
    );
    assert.equal(documentFileLine(doc({ content_type: "image/webp", uploaded_at: "2026-11-20T15:00:00Z", via: "ficha" })), "Foto · enviado em 20/11/2026");
  });

  it("documentSpoken: o título, a validade e o arquivo, para o leitor de tela", () => {
    assert.equal(documentSpoken(doc({ title: "NR10 Exemplo", expires_on: "2026-12-08" }), TODAY), "NR10 Exemplo, Vence em 12 dias, PDF, enviado em 20/11/2026");
    assert.equal(documentSpoken(doc({ kind: "personal", title: "RG", content_type: "image/png" }), TODAY), "RG, Foto, enviado em 20/11/2026");
  });
});

describe("os resumos do menu", () => {
  it("documentsRowSummary: nenhum, a quantidade e o currículo fora da conta", () => {
    assert.deepEqual(documentsRowSummary([], TODAY), { value: "Nenhum", tone: "muted" });
    assert.deepEqual(documentsRowSummary(null, TODAY), { value: "Nenhum", tone: "muted" });
    assert.deepEqual(documentsRowSummary([doc({ kind: "resume" })], TODAY), { value: "Nenhum", tone: "muted" });
    assert.deepEqual(documentsRowSummary([doc({ kind: "personal" }), doc({ kind: "resume" })], TODAY), { value: "1 documento", tone: "muted" });
    assert.deepEqual(
      documentsRowSummary([doc({ kind: "personal" }), doc({ expires_on: null }), doc({ expires_on: "2027-12-01" })], TODAY),
      { value: "3 documentos", tone: "muted" },
    );
  });

  it("documentsRowSummary: vencida primeiro (âmbar), depois a que vence primeiro em até 30 dias", () => {
    assert.deepEqual(
      documentsRowSummary([doc({ expires_on: "2026-11-25" }), doc({ expires_on: "2026-12-01" }), doc({ kind: "personal" })], TODAY),
      { value: "1 vencida", tone: "warning" },
    );
    assert.deepEqual(documentsRowSummary([doc({ expires_on: "2026-11-25" }), doc({ expires_on: "2020-01-01" })], TODAY), {
      value: "2 vencidas",
      tone: "warning",
    });
    assert.deepEqual(documentsRowSummary([doc({ expires_on: "2026-12-26" }), doc({ expires_on: "2026-12-08" }), doc()], TODAY), {
      value: "Vence em 12 dias",
      tone: "warning",
    });
    assert.deepEqual(documentsRowSummary([doc({ expires_on: TODAY })], TODAY), { value: "Vence hoje", tone: "warning" });
    assert.deepEqual(documentsRowSummary([doc({ expires_on: "2026-11-27" })], TODAY), { value: "Vence amanhã", tone: "warning" });
    // 31 dias: válida, conta como documento.
    assert.deepEqual(documentsRowSummary([doc({ expires_on: "2026-12-27" })], TODAY), { value: "1 documento", tone: "muted" });
  });

  it("resumeRowSummary: \"Enviado\" / \"Não enviado\", e o andamento do envio e da exclusão", () => {
    const resume = doc({ kind: "resume", title: "Currículo" });
    assert.equal(resumeRowSummary(null), "Não enviado");
    assert.equal(resumeRowSummary(undefined), "Não enviado");
    assert.equal(resumeRowSummary(resume), "Enviado");
    assert.equal(resumeRowSummary([doc(), resume]), "Enviado");
    assert.equal(resumeRowSummary([doc()]), "Não enviado");
    assert.equal(resumeRowSummary(null, "upload"), "Enviando…");
    assert.equal(resumeRowSummary(resume, "remove"), "Excluindo…");
  });
});

describe("os blocos e os textos das telas", () => {
  it("os blocos \"Certificações\" e \"Documentos pessoais\" (contrato §9), nesta ordem", () => {
    assert.deepEqual([...DOCUMENT_GROUPS], ["certification", "personal"]);
    assert.equal(DOCUMENT_GROUP_TEXT.certification.block, "Certificações");
    assert.equal(DOCUMENT_GROUP_TEXT.personal.block, "Documentos pessoais");
    assert.equal(DOCUMENT_GROUP_TEXT.certification.add, "Adicionar certificação");
    assert.equal(DOCUMENT_GROUP_TEXT.personal.add, "Adicionar documento");
  });

  it("?grupo= do formulário: ida e volta; o resto não vale", () => {
    for (const group of DOCUMENT_GROUPS) assert.equal(groupOfParam(documentGroupParam(group)), group);
    assert.equal(documentGroupParam("certification"), "certificacao");
    assert.equal(documentGroupParam("personal"), "pessoal");
    for (const bad of [undefined, null, "", "curriculo", "Pessoal", ["pessoal"]]) assert.equal(groupOfParam(bad), null);
    assert.equal(documentGroupOf(doc({ kind: "certification" })), "certification");
    assert.equal(documentGroupOf(doc({ kind: "personal" })), "personal");
  });

  it("sem rede e demora: com ponto, sem prometer a fila", () => {
    for (const text of Object.values(DOCUMENT_SEND_TEXT)) assert.ok(text.endsWith("."), text);
    assert.ok(DOCUMENT_SEND_TEXT.offlineFile.startsWith("Sem internet."));
  });
});

describe("as fontes do app", () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

  it("a câmera ganha o alvo \"document\" (documento ou currículo), sem OS, e os alvos de antes continuam", () => {
    const source = read("../src/components/ticket/photoCapture.ts");
    assert.ok(source.includes('| { kind: "document"; slot: "document" | "resume"; ticketId?: undefined };'));
    for (const kind of ['{ kind: "loose"; ticketId: string }', '{ kind: "avatar" }', '{ kind: "invoice"; ticketId?: undefined }']) {
      assert.ok(source.includes(kind), kind);
    }
    assert.ok(source.includes('"fotografar o currículo"') && source.includes('"fotografar o documento"'));
  });

  it("pickedFile.ts e pickedFile.web.ts têm as mesmas funções", () => {
    const names = (file) => [...read(file).matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(names("../src/lib/pickedFile.ts"), ["discardFile", "fileFromPhoto", "pickFile", "sweepFiles"]);
    assert.deepEqual(names("../src/lib/pickedFile.web.ts"), names("../src/lib/pickedFile.ts"));
  });

  it("nada de documento na fila offline: as rotas saem pela fila das gravações do cadastro", () => {
    const source = read("../src/lib/documents.ts");
    assert.ok(source.includes('const BASE = "/me/profile/documents";'));
    assert.ok(!/\bfrom "\.\/(sync|db|ops|changes)"/.test(source));
    assert.equal((source.match(/writeProfile\(/g) ?? []).length, 4);
    assert.ok(source.includes("/link`"));
  });

  it("as telas: só com a gestão no servidor, sem Skills nem Ex.: e sem nada da central", () => {
    for (const screen of ["documentos", "documento", "curriculo"]) {
      const source = read(`../src/app/configuracoes/${screen}.tsx`);
      assert.ok(source.includes("useTechProfileScreen(hasCadastroE2)"), screen);
      assert.ok(source.includes("<CadastroUnavailable"), screen);
      assert.ok(!/\bSkills?\b/.test(source) && !source.includes("Ex.:"), screen);
      assert.ok(!/internal|avalia|anexo interno/i.test(source), screen);
    }
    assert.ok(!read("../src/components/settings/FileField.tsx").includes("Ex.:"));
  });
});

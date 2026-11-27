// Documentos do técnico na central (lib/documents.ts): a conferência do arquivo, do título e da validade antes do
// envio (os casos do contrato), as cópias dos limites iguais às de lib/constants.ts, o "editar só o que mudou", a ordem
// da lista, o limite de 30, o "enviado por", a linha da certificação vencendo na lista de Técnicos e o link de um
// arquivo pela lista relida. Dados fictícios. Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCUMENT_ACCEPT, DOCUMENT_KIND, DOCUMENT_LIMITS, DOCUMENT_WARN_DAYS } from "../src/lib/constants.ts";
import {
  certificationDueRowText,
  certificationDueState,
  cleanDocumentTitle,
  DOCUMENT_CREATE_TITLE,
  DOCUMENT_LIMIT_TEXT,
  DOCUMENT_MSG,
  DOCUMENT_REFRESH_MS,
  DOCUMENT_REMOVED,
  DOCUMENT_SENT,
  documentExpiryProblem,
  documentFileProblem,
  documentPatch,
  documentSentText,
  documentsAtLimit,
  documentsOfKind,
  documentTitleProblem,
  EXPIRY_FIRST_DAY,
  expiryLastDay,
  FILE_LINK_FRESH_MS,
  findFileUrl,
  hasExpiry,
  hasTitle,
  newUploadId,
  sortDocuments,
  withDocument,
  withoutDocument,
} from "../src/lib/documents.ts";

const TODAY = "2026-11-26";
const MB = 1024 * 1024;
const ANA = { id: "3f2c8a1e-5b7d-4c9a-8e6f-1a2b3c4d5e6f", name: "Analista Exemplo" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function file(over = {}) {
  const id = over.id ?? uuid();
  return {
    id,
    file_name: "documento.pdf",
    content_type: "application/pdf",
    size: 1200,
    uploaded_at: "2026-11-20T13:00:00Z",
    uploaded_by: null,
    via: "app",
    url: `/technician-documents/${id}/download?token=exemplo`,
    ...over,
  };
}

function doc(over = {}) {
  const id = over.id ?? uuid();
  return {
    id,
    kind: "certification",
    title: "NR10 Exemplo",
    expires_on: null,
    file: file({ id }),
    previous: [],
    created_at: "2026-11-20T13:00:00Z",
    updated_at: "2026-11-20T13:00:00Z",
    ...over,
  };
}

describe("o arquivo antes do envio (documentFileProblem)", () => {
  it("10 MB exatos passa; +1 byte: Arquivo maior que 10 MB.", () => {
    assert.equal(documentFileProblem({ name: "nr10.pdf", size: 10 * MB, type: "application/pdf" }), null);
    assert.equal(documentFileProblem({ name: "nr10.pdf", size: 10 * MB + 1, type: "application/pdf" }), "Arquivo maior que 10 MB.");
  });

  it("GIF, HEIC, XML e HTML: Use PDF ou foto (JPG, PNG ou WebP).", () => {
    const type = "Use PDF ou foto (JPG, PNG ou WebP).";
    assert.equal(documentFileProblem({ name: "foto.gif", size: 100, type: "image/gif" }), type);
    assert.equal(documentFileProblem({ name: "foto.heic", size: 100, type: "image/heic" }), type);
    // O Windows não reconhece o HEIC: sem tipo, vale a extensão.
    assert.equal(documentFileProblem({ name: "foto.heic", size: 100, type: "" }), type);
    assert.equal(documentFileProblem({ name: "nota.xml", size: 100, type: "text/xml" }), type);
    assert.equal(documentFileProblem({ name: "pagina.html", size: 100, type: "text/html" }), type);
    // O tipo do navegador manda: a extensão de PDF não salva um GIF.
    assert.equal(documentFileProblem({ name: "falso.pdf", size: 100, type: "image/gif" }), type);
  });

  it("PDF, JPG, PNG e WebP passam; tipo vazio (ou genérico) com .pdf passa pela extensão", () => {
    for (const [name, type] of [
      ["a.pdf", "application/pdf"],
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.png", "image/png"],
      ["a.webp", "image/webp"],
      ["a.pdf", ""],
      ["A.PDF", ""],
      ["a.JPG", "application/octet-stream"],
    ]) {
      assert.equal(documentFileProblem({ name, size: 100, type }), null, `${name} ${type}`);
    }
  });

  it("sem arquivo: Escolha o arquivo.; vazio: O arquivo está vazio.", () => {
    assert.equal(documentFileProblem(null), "Escolha o arquivo.");
    assert.equal(documentFileProblem(undefined), "Escolha o arquivo.");
    assert.equal(documentFileProblem({ name: "a.pdf", size: 0, type: "application/pdf" }), "O arquivo está vazio.");
  });

  it("os erros da tela são os do contrato (com ponto)", () => {
    assert.equal(DOCUMENT_MSG.file, "Escolha o arquivo.");
    assert.equal(DOCUMENT_MSG.size, "Arquivo maior que 10 MB.");
    assert.equal(DOCUMENT_MSG.type, "Use PDF ou foto (JPG, PNG ou WebP).");
    assert.equal(DOCUMENT_MSG.title, "Informe o título.");
    assert.equal(DOCUMENT_MSG.expiry, "Confira a validade.");
  });
});

describe("as cópias dos limites (= lib/constants.ts)", () => {
  it("10 MB, título de 2 a 80, os tipos aceitos", () => {
    assert.equal(DOCUMENT_LIMITS.maxMb, 10);
    assert.equal(documentFileProblem({ name: "a.pdf", size: DOCUMENT_LIMITS.maxMb * MB, type: "application/pdf" }), null);
    assert.equal(documentTitleProblem("x".repeat(DOCUMENT_LIMITS.titleMin)), null);
    assert.equal(documentTitleProblem("x".repeat(DOCUMENT_LIMITS.titleMin - 1)), DOCUMENT_MSG.title);
    assert.equal(documentTitleProblem("x".repeat(DOCUMENT_LIMITS.titleMax)), null);
    assert.equal(documentTitleProblem("x".repeat(DOCUMENT_LIMITS.titleMax + 1)), DOCUMENT_MSG.titleLong);
    for (const type of DOCUMENT_ACCEPT.split(",")) {
      assert.equal(documentFileProblem({ name: "arquivo", size: 1, type }), null, type);
    }
  });

  it("30 documentos e certificações e 30 anexos internos", () => {
    assert.equal(DOCUMENT_LIMITS.perTechnician, 30);
    assert.equal(DOCUMENT_LIMITS.internal, 30);
    assert.equal(DOCUMENT_LIMIT_TEXT.documents, "Limite de 30 documentos e certificações. Exclua um para enviar outro.");
    assert.equal(DOCUMENT_LIMIT_TEXT.internal, "Limite de 30 anexos internos. Exclua um para enviar outro.");
  });

  it("o link vale 30 min: a lista relê a cada 20 e o abrir pede de novo depois de 25", () => {
    assert.equal(DOCUMENT_REFRESH_MS, 20 * 60_000);
    assert.equal(FILE_LINK_FRESH_MS, 25 * 60_000);
    assert.ok(DOCUMENT_REFRESH_MS < FILE_LINK_FRESH_MS && FILE_LINK_FRESH_MS < 30 * 60_000);
  });

  it("os textos de cada tipo", () => {
    assert.deepEqual(Object.keys(DOCUMENT_KIND).sort(), Object.keys(DOCUMENT_SENT).sort());
    assert.deepEqual(DOCUMENT_CREATE_TITLE, {
      certification: "Enviar certificação",
      personal: "Enviar documento pessoal",
      resume: "Enviar currículo",
      internal: "Enviar anexo",
    });
    assert.deepEqual(DOCUMENT_SENT, {
      certification: "Certificação enviada",
      personal: "Documento enviado",
      resume: "Currículo enviado",
      internal: "Anexo enviado",
    });
    assert.deepEqual(DOCUMENT_REMOVED, {
      certification: "Certificação excluída",
      personal: "Documento excluído",
      resume: "Currículo excluído",
      internal: "Anexo excluído",
    });
  });

  it("validade só na certificação; título em todos menos o currículo", () => {
    assert.deepEqual(
      ["certification", "personal", "resume", "internal"].filter(hasExpiry),
      ["certification"],
    );
    assert.deepEqual(
      ["certification", "personal", "resume", "internal"].filter(hasTitle),
      ["certification", "personal", "internal"],
    );
  });
});

describe("título e validade", () => {
  it("o título como o servidor grava: pontas, espaços e invisíveis", () => {
    assert.equal(cleanDocumentTitle("  NR10   Exemplo\n"), "NR10 Exemplo");
    assert.equal(cleanDocumentTitle("NR10​"), "NR10");
    assert.equal(documentTitleProblem("   "), "Informe o título.");
    assert.equal(documentTitleProblem(" a "), "Informe o título.");
    assert.equal(documentTitleProblem("RG"), null);
    // 81 caracteres: recusa (o caso do contrato).
    assert.equal(documentTitleProblem("x".repeat(81)), "O título tem no máximo 80 caracteres.");
  });

  it("validade: opcional; de 2000-01-01 a hoje + 20 anos; dia que existe", () => {
    assert.equal(EXPIRY_FIRST_DAY, "2000-01-01");
    assert.equal(expiryLastDay(TODAY), "2046-11-26");
    assert.equal(expiryLastDay("2028-02-29"), "2048-02-29");
    assert.equal(expiryLastDay("2024-02-29"), "2044-02-29");
    assert.equal(expiryLastDay("2027-02-28"), "2047-02-28");
    // 29/02 num ano que vira um não bissexto (2100): 28/02.
    assert.equal(expiryLastDay("2080-02-29"), "2100-02-28");
    assert.equal(documentExpiryProblem("", TODAY), null);
    assert.equal(documentExpiryProblem("2000-01-01", TODAY), null);
    assert.equal(documentExpiryProblem("1999-12-31", TODAY), "Confira a validade.");
    assert.equal(documentExpiryProblem("2046-11-26", TODAY), null);
    assert.equal(documentExpiryProblem("2046-11-27", TODAY), "Confira a validade.");
    assert.equal(documentExpiryProblem("2026-02-30", TODAY), "Confira a validade.");
    assert.equal(documentExpiryProblem("26/11/2027", TODAY), "Confira a validade.");
    // Vencida também vale (a central registra a certificação que já venceu).
    assert.equal(documentExpiryProblem("2026-11-25", TODAY), null);
  });

  it("documentPatch: só o que mudou; a validade só na certificação, vazio tira", () => {
    const cert = doc({ title: "NR10", expires_on: "2027-11-25" });
    assert.deepEqual(documentPatch(cert, { title: " NR10 ", expiresOn: "2027-11-25" }), {});
    assert.deepEqual(documentPatch(cert, { title: "NR10 Exemplo", expiresOn: "2027-11-25" }), { title: "NR10 Exemplo" });
    assert.deepEqual(documentPatch(cert, { title: "NR10", expiresOn: "2028-01-10" }), { expires_on: "2028-01-10" });
    assert.deepEqual(documentPatch(cert, { title: "NR10", expiresOn: "" }), { expires_on: null });
    const personal = doc({ kind: "personal", title: "RG", expires_on: null });
    assert.deepEqual(documentPatch(personal, { title: "RG", expiresOn: "2030-01-01" }), {});
    assert.deepEqual(documentPatch(personal, { title: "RG frente e verso", expiresOn: "" }), { title: "RG frente e verso" });
    const resume = doc({ kind: "resume", title: "Currículo" });
    assert.deepEqual(documentPatch(resume, { title: "Outro", expiresOn: "" }), {});
  });

  it("newUploadId: um UUID v4 novo a cada arquivo", () => {
    const a = newUploadId();
    const b = newUploadId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, b);
  });
});

describe("a lista", () => {
  it("a ordem do servidor: certificação (validade mais próxima, sem validade por último), pessoal, currículo, interno", () => {
    const list = [
      doc({ id: uuid(), kind: "internal", title: "Contrato" }),
      doc({ id: uuid(), kind: "resume", title: "Currículo" }),
      doc({ id: uuid(), kind: "personal", title: "RG" }),
      doc({ id: uuid(), kind: "personal", title: "CNH" }),
      doc({ id: uuid(), kind: "certification", title: "NR35", expires_on: null }),
      doc({ id: uuid(), kind: "certification", title: "NR10", expires_on: "2027-03-01" }),
      doc({ id: uuid(), kind: "certification", title: "NR33", expires_on: "2026-12-01" }),
      doc({ id: uuid(), kind: "personal", title: "Água e luz" }),
    ];
    assert.deepEqual(
      sortDocuments(list).map((d) => `${d.kind}:${d.title}`),
      [
        "certification:NR33",
        "certification:NR10",
        "certification:NR35",
        "personal:Água e luz",
        "personal:CNH",
        "personal:RG",
        "resume:Currículo",
        "internal:Contrato",
      ],
    );
    assert.deepEqual(
      documentsOfKind(list, "personal").map((d) => d.title),
      ["Água e luz", "CNH", "RG"],
    );
    assert.deepEqual(documentsOfKind(undefined, "resume"), []);
  });

  it("withDocument troca pelo id (ou inclui) e reordena; withoutDocument tira", () => {
    const a = doc({ title: "NR10", expires_on: "2027-01-01" });
    const b = doc({ title: "NR35", expires_on: "2026-12-01" });
    const list = sortDocuments([a, b]);
    assert.deepEqual(list.map((d) => d.title), ["NR35", "NR10"]);
    const changed = { ...a, expires_on: "2026-11-30" };
    assert.deepEqual(withDocument(list, changed).map((d) => `${d.title} ${d.expires_on}`), ["NR10 2026-11-30", "NR35 2026-12-01"]);
    const c = doc({ kind: "personal", title: "RG" });
    assert.equal(withDocument(list, c).length, 3);
    assert.deepEqual(withDocument(undefined, c), [c]);
    assert.deepEqual(withoutDocument(list, a.id).map((d) => d.title), ["NR35"]);
    assert.deepEqual(withoutDocument(null, a.id), []);
  });

  it("o limite: 30 entre certificações e pessoais; 30 internos à parte; currículo nunca", () => {
    const many = (kind, n) => Array.from({ length: n }, (_, i) => doc({ kind, title: `${kind} ${i}` }));
    const mixed = [...many("certification", 20), ...many("personal", 9)];
    assert.equal(documentsAtLimit(mixed, "certification"), false);
    assert.equal(documentsAtLimit([...mixed, doc({ kind: "personal" })], "personal"), true);
    assert.equal(documentsAtLimit([...mixed, doc({ kind: "personal" })], "certification"), true);
    // Internos e currículo não contam nos 30 dos documentos.
    assert.equal(documentsAtLimit([...mixed, ...many("internal", 30), doc({ kind: "resume" })], "certification"), false);
    assert.equal(documentsAtLimit(many("internal", 29), "internal"), false);
    assert.equal(documentsAtLimit(many("internal", 30), "internal"), true);
    assert.equal(documentsAtLimit(many("resume", 1), "resume"), false);
  });

  it("findFileUrl: o link do arquivo atual ou de uma versão anterior, na lista relida; null se saiu", () => {
    const old = file({ id: uuid(), file_name: "nr10-antigo.pdf" });
    const current = doc({ previous: [old] });
    const other = doc({ kind: "personal", title: "RG" });
    const list = [current, other];
    assert.equal(findFileUrl(list, current.id), current.file.url);
    assert.equal(findFileUrl(list, current.file.id), current.file.url);
    assert.equal(findFileUrl(list, old.id), old.url);
    assert.equal(findFileUrl(list, other.file.id), other.file.url);
    assert.equal(findFileUrl(list, uuid()), null);
    assert.equal(findFileUrl(undefined, old.id), null);
  });

  it("quem mandou: o técnico no app, a central (com o nome) ou a ficha da homologação", () => {
    assert.equal(documentSentText({ via: "app", uploaded_by: null }, "25/11/2026"), "Enviado pelo técnico em 25/11/2026");
    assert.equal(documentSentText({ via: "central", uploaded_by: ANA }, "25/11/2026"), "Enviado por Analista Exemplo em 25/11/2026");
    assert.equal(documentSentText({ via: "ficha", uploaded_by: null }, "25/11/2026"), "Da ficha da homologação, 25/11/2026");
  });
});

describe("a certificação vencendo na linha da lista de Técnicos", () => {
  const due = (expires_on, count = 1) => ({ document_id: uuid(), title: "NR10", expires_on, count });

  it("os textos do contrato: venceu, vence hoje, amanhã, em n dias; com mais de uma, (+n−1)", () => {
    assert.equal(certificationDueRowText(due("2026-11-25"), TODAY), "NR10 venceu");
    assert.equal(certificationDueRowText(due("2026-11-25", 3), TODAY), "NR10 venceu (+2)");
    assert.equal(certificationDueRowText(due("2026-11-26"), TODAY), "NR10 vence hoje");
    assert.equal(certificationDueRowText(due("2026-11-27"), TODAY), "NR10 vence amanhã");
    assert.equal(certificationDueRowText(due("2026-12-06"), TODAY), "NR10 vence em 10 dias");
    assert.equal(certificationDueRowText(due("2026-12-26", 2), TODAY), "NR10 vence em 30 dias (+1)");
  });

  it("sem certificação vencendo (ou data que não existe): null", () => {
    assert.equal(certificationDueRowText(null, TODAY), null);
    assert.equal(certificationDueRowText(undefined, TODAY), null);
    assert.equal(certificationDueRowText(due("2026-02-30"), TODAY), null);
  });

  it("o tom do selo: vencida (vermelho) ou vencendo (âmbar), na mesma conta de documentDue", () => {
    assert.equal(certificationDueState(due("2026-11-25"), TODAY), "expired");
    assert.equal(certificationDueState(due("2026-11-26"), TODAY), "soon");
    assert.equal(certificationDueState(due("2026-12-26"), TODAY), "soon");
    assert.equal(certificationDueState(null, TODAY), null);
    assert.equal(DOCUMENT_WARN_DAYS, 30);
  });
});

// Sonda de lib/forgotPassword.ts ("Esqueci minha senha": o e-mail digitado, o que o pedido deu e a entrega do login para
// a tela). Dados fictícios.
// Na pasta mobile: node --experimental-strip-types --import ./tests/resolve-ts.mjs --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { URL } from "node:url";
import { FORGOT_MSG, forgotHandoff, forgotOutcome, forgotProblem, forgotSentText } from "../src/lib/forgotPassword.ts";

it("lib/forgotPassword.ts é puro: além dos tipos, só ./constants", () => {
  const source = readFileSync(new URL("../src/lib/forgotPassword.ts", import.meta.url), "utf8");
  const values = [...source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(values, ["./constants"]);
});

describe("forgotProblem: o e-mail antes de enviar", () => {
  it("vazio ou sem @: informe um e-mail válido", () => {
    assert.equal(forgotProblem(""), "Informe um e-mail válido.");
    assert.equal(forgotProblem("   "), FORGOT_MSG.email);
    assert.equal(forgotProblem("tecnico"), FORGOT_MSG.email);
    assert.equal(forgotProblem("tecnico@exemplo"), FORGOT_MSG.email);
  });

  it("e-mail completo passa, com espaços em volta", () => {
    assert.equal(forgotProblem("tecnico.alfa@exemplo.com"), null);
    assert.equal(forgotProblem("  Tecnico.Alfa@Exemplo.com "), null);
  });
});

describe("forgotOutcome: o que o pedido deu", () => {
  it("2xx (a mesma resposta exista ou não o e-mail): enviado", () => {
    assert.equal(forgotOutcome(null), "sent");
    assert.equal(forgotOutcome(202), "sent");
    assert.equal(forgotOutcome(200), "sent");
  });

  it("404 é a API de antes, sem a rota: o caminho pela central", () => {
    assert.equal(forgotOutcome(404), "legacy");
  });

  it("503 com MAIL_DISABLED: envio de e-mail desligado; 503 sem o código é erro", () => {
    assert.equal(forgotOutcome(503, "MAIL_DISABLED"), "disabled");
    assert.equal(forgotOutcome(503), "error");
    assert.equal(forgotOutcome(503, null), "error");
  });

  it("sem conexão e o resto", () => {
    assert.equal(forgotOutcome(0), "offline");
    assert.equal(forgotOutcome(429), "error");
    assert.equal(forgotOutcome(500), "error");
    assert.equal(forgotOutcome(422), "error");
  });
});

describe("textos", () => {
  it("enviado: a mesma frase exista ou não o cadastro, com a validade do link", () => {
    assert.equal(
      forgotSentText("tecnico.alfa@exemplo.com"),
      "Se tecnico.alfa@exemplo.com estiver cadastrado e validado, você recebe um link para criar uma senha nova. O link vale por 2 horas.",
    );
    assert.equal(FORGOT_MSG.sentTitle, "Confira seu e-mail");
    assert.equal(FORGOT_MSG.spam, "Não chegou? Veja o spam ou peça ajuda à central no WhatsApp.");
  });

  it("os avisos de quando não dá para pedir o link", () => {
    assert.equal(
      FORGOT_MSG.legacy,
      "Peça à central (analista ou supervisor), no grupo de WhatsApp, para redefinir sua senha. Você recebe uma senha provisória e cria uma nova ao entrar.",
    );
    assert.equal(FORGOT_MSG.disabled, "O envio de e-mail está desligado. Peça à central pelo WhatsApp para redefinir sua senha.");
    assert.equal(FORGOT_MSG.offline, "Sem internet. Conecte-se aos dados móveis ou a um Wi-Fi.");
  });
});

describe("forgotHandoff: o login entrega o e-mail pela memória", () => {
  it("take devolve uma vez e esvazia", () => {
    forgotHandoff.set({ email: "tecnico.alfa@exemplo.com", server: "192.0.2.10:8000" });
    assert.deepEqual(forgotHandoff.take(), { email: "tecnico.alfa@exemplo.com", server: "192.0.2.10:8000" });
    assert.deepEqual(forgotHandoff.take(), { email: "" });
  });

  it("sem nada entregue, e-mail vazio", () => {
    assert.deepEqual(forgotHandoff.take(), { email: "" });
  });

  it("guarda uma cópia: mudar o objeto depois não muda o que a tela recebe", () => {
    const value = { email: "tecnico.alfa@exemplo.com" };
    forgotHandoff.set(value);
    value.email = "outro@exemplo.com";
    assert.deepEqual(forgotHandoff.take(), { email: "tecnico.alfa@exemplo.com" });
  });
});

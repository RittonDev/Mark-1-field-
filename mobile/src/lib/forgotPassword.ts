// "Esqueci minha senha" (tela sem login e o "Esqueci a senha atual" do Trocar senha): o e-mail digitado, o que o pedido
// deu e o que o login entrega à tela. O link vai por e-mail e abre a página web "Definir nova senha"; o servidor responde
// igual exista ou não o e-mail e só envia para técnico com acesso e e-mail validado. Puro (só ./constants, sem nada
// nativo): entra nas sondas de mobile/tests.

import { PASSWORD_RESET_HOURS } from "./constants";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const FORGOT_MSG = {
  email: "Informe um e-mail válido.",
  offline: "Sem internet. Conecte-se aos dados móveis ou a um Wi-Fi.",
  /** A API de antes (sem a rota): o caminho de sempre, pela central. */
  legacy:
    "Peça à central (analista ou supervisor), no grupo de WhatsApp, para redefinir sua senha. Você recebe uma senha provisória e cria uma nova ao entrar.",
  /** 503 MAIL_DISABLED: o servidor está sem o envio de e-mail. */
  disabled: "O envio de e-mail está desligado. Peça à central pelo WhatsApp para redefinir sua senha.",
  sentTitle: "Confira seu e-mail",
  spam: "Não chegou? Veja o spam ou peça ajuda à central no WhatsApp.",
} as const;

/** O texto de "Confira seu e-mail": a mesma resposta exista ou não o cadastro. */
export function forgotSentText(email: string): string {
  return `Se ${email} estiver cadastrado e validado, você recebe um link para criar uma senha nova. O link vale por ${PASSWORD_RESET_HOURS} horas.`;
}

/** O e-mail digitado antes de enviar; null quando serve. */
export function forgotProblem(email: string): string | null {
  return EMAIL.test(email.trim()) ? null : FORGOT_MSG.email;
}

/**
 * O que o pedido deu: `status` null ou 2xx, enviado (a mesma resposta exista ou não o e-mail); 404, a API de antes, sem a
 * rota ("legacy"); 503 com o código MAIL_DISABLED, envio de e-mail desligado; 0, sem conexão; o resto (429, 5xx), erro
 * com a mensagem do servidor.
 */
export type ForgotOutcome = "sent" | "legacy" | "disabled" | "offline" | "error";

export function forgotOutcome(status: number | null, code: string | null = null): ForgotOutcome {
  if (status === null || (status >= 200 && status < 300)) return "sent";
  if (status === 0) return "offline";
  if (status === 404) return "legacy";
  if (status === 503 && code === "MAIL_DISABLED") return "disabled";
  return "error";
}

export interface ForgotHandoff {
  email: string;
  /** O servidor digitado no login (só no desenvolvimento). */
  server?: string;
}

let handoff: ForgotHandoff | null = null;

/**
 * O login entrega à tela o e-mail digitado (e, no desenvolvimento, o servidor) pela memória, nunca pela rota: na versão
 * web, o parâmetro iria para o endereço da página. `take` devolve uma vez e esvazia.
 */
export const forgotHandoff = {
  set(value: ForgotHandoff): void {
    handoff = { ...value };
  },
  take(): ForgotHandoff {
    const value = handoff ?? { email: "" };
    handoff = null;
    return value;
  },
};

// Primeiro acesso e dados da conta do técnico.

import { api } from "./api";
import { getKv, setKv } from "./db";
import { session } from "./session";
import type { TokenResponse, User } from "./types";

// `?? false` / `?? null`: o usuário guardado no aparelho antes desta versão pode não ter os campos.
export const mustChangePassword = (user: User | null) => Boolean(user?.must_change_password ?? false);

export const locationConsentAt = (user: User | null) => user?.location_consent_at ?? null;

// ───────────────────── termo de localização: quando oferecer sozinho ─────────────────────

/** Dia em que o termo abriu sozinho; "revoked" depois que o técnico retirou o aceite. */
const CONSENT_PROMPT_KEY = "consent_prompt_day";
const CONSENT_REVOKED = "revoked";

const localDay = (date: Date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

/**
 * Sem aceite, o termo abre sozinho no máximo uma vez por dia (dá para adiar). Quem retirou o aceite
 * não recebe o termo de novo sem pedir: ele volta só ao tocar em "Iniciar jornada" ou pela Conta.
 */
export async function consentPromptDue(now: Date = new Date()): Promise<boolean> {
  const last = await getKv(CONSENT_PROMPT_KEY).catch(() => null);
  return last !== localDay(now) && last !== CONSENT_REVOKED;
}

/** Registra que o termo foi oferecido hoje (chave que nenhuma tela mostra: escrita silenciosa). */
export async function markConsentPrompted(now: Date = new Date()): Promise<void> {
  await setKv(CONSENT_PROMPT_KEY, localDay(now), undefined, { notify: false }).catch(() => undefined);
}

/**
 * Retira o aceite do termo (LGPD: a qualquer momento, sem custo). O servidor encerra a jornada aberta e
 * apaga o aceite; o usuário guardado no aparelho é atualizado na hora, mesmo que a releitura falhe.
 * Quem chama para a coleta local (stopTracking) depois do sucesso.
 */
export async function revokeLocationConsent(): Promise<void> {
  await api.delete("/tracking/consent");
  await setKv(CONSENT_PROMPT_KEY, CONSENT_REVOKED, undefined, { notify: false }).catch(() => undefined);
  const user = session.get().user;
  if (user) await session.updateUser({ ...user, location_consent_at: null });
  await refreshMe().catch(() => undefined);
}

/** Recarrega o usuário logado (GET /auth/me) e guarda na sessão. */
export async function refreshMe(): Promise<User> {
  const user = await api.get<User>("/auth/me");
  await session.updateUser(user);
  return user;
}

/**
 * Troca de senha (obrigatória no primeiro acesso de técnicos criados pelo analista ou importados).
 * Trocar a senha encerra todas as outras sessões do usuário (sessions_revoked_at): os tokens
 * antigos deixam de valer. A API devolve um TokenResponse novo, que é gravado antes de qualquer
 * outra chamada; senão a próxima requisição tomaria 401.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<User> {
  const data = await api.post<TokenResponse | undefined>("/auth/change-password", {
    current_password: currentPassword,
    new_password: newPassword,
  });
  if (data?.access_token && data.refresh_token) {
    await session.setTokens(data);
    return data.user;
  }
  // Versão antiga da API (204 sem corpo): o token atual ainda vale.
  return refreshMe();
}

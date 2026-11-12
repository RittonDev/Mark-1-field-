// Primeiro acesso e dados da conta do técnico.

import { api } from "./api";
import { session } from "./session";
import type { TokenResponse, User } from "./types";

// `?? false` / `?? null`: o usuário guardado no aparelho antes desta versão pode não ter os campos.
export const mustChangePassword = (user: User | null) => Boolean(user?.must_change_password ?? false);

export const locationConsentAt = (user: User | null) => user?.location_consent_at ?? null;

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

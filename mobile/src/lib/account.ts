// Primeiro acesso e dados da conta do técnico.

import { api } from "./api";
import { session } from "./session";
import type { User } from "./types";

/** Campos novos do UserOut (primeiro acesso e termo de rastreamento); opcionais até o tipo da web trazê-los. */
type UserExtras = { must_change_password?: boolean; location_consent_at?: string | null };

export const mustChangePassword = (user: User | null) => Boolean(user && (user as User & UserExtras).must_change_password);

export const locationConsentAt = (user: User | null) => (user ? ((user as User & UserExtras).location_consent_at ?? null) : null);

/** Recarrega o usuário logado (GET /auth/me) e guarda na sessão. */
export async function refreshMe(): Promise<User> {
  const user = await api.get<User>("/auth/me");
  await session.updateUser(user);
  return user;
}

/** Troca de senha (obrigatória no primeiro acesso dos técnicos importados). */
export async function changePassword(currentPassword: string, newPassword: string) {
  await api.post("/auth/change-password", { current_password: currentPassword, new_password: newPassword });
  return refreshMe();
}

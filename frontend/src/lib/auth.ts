"use client";

import { useCallback, useSyncExternalStore } from "react";
import { api, API_URL } from "./api";
import { type SessionEndReason, sessionStore } from "./session";
import type { TokenResponse } from "./types";

/**
 * Encerra a sessão também no servidor: o refresh token deixa de valer (num computador compartilhado,
 * ninguém reaproveita a sessão copiando o token). Não espera a resposta: quem sai não fica preso à
 * rede, e `keepalive` deixa o pedido terminar mesmo se a aba fechar logo depois. Se falhar, o token
 * vence sozinho.
 */
function endServerSession(refreshToken: string) {
  try {
    void fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Navegador sem fetch com keepalive: a sessão termina quando o token vencer.
  }
}

const noopSubscribe = () => () => {};

/** true depois da hidratação (no servidor e no 1º render do cliente é false). */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function useSession() {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.getServerSnapshot);
}

export function useAuth() {
  const session = useSession();
  const isClient = useIsClient();

  const login = useCallback(async (email: string, password: string) => {
    // O backend recusa (403) quem não usa o navegador: técnico de campo entra pelo app.
    const data = await api.post<TokenResponse>("/auth/login", { email, password, channel: "web" });
    sessionStore.fromTokenResponse(data);
    return data.user;
  }, []);

  /** Sai (`reason` "channel": técnico que abriu a central no navegador; o login orienta a usar o app). */
  const logout = useCallback((reason: SessionEndReason = "logout") => {
    const refreshToken = sessionStore.get()?.refreshToken;
    sessionStore.set(null, reason);
    if (refreshToken) endServerSession(refreshToken);
  }, []);

  return {
    ready: isClient,
    session,
    user: session?.user ?? null,
    login,
    logout,
  };
}

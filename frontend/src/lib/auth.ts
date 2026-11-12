"use client";

import { useCallback, useSyncExternalStore } from "react";
import { api } from "./api";
import { sessionStore } from "./session";
import type { TokenResponse } from "./types";

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

  const logout = useCallback(() => {
    sessionStore.set(null);
  }, []);

  return {
    ready: isClient,
    session,
    user: session?.user ?? null,
    login,
    logout,
  };
}

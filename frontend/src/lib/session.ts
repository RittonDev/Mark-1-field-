// Sessão (tokens + usuário) guardada no localStorage e exposta como store externo,
// para ser lida com useSyncExternalStore sem setState em efeitos.

import type { TokenResponse, User } from "./types";

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: User;
}

/**
 * Por que a sessão desta aba terminou: venceu (a API recusou a renovação), a pessoa saiu ou o perfil
 * não usa o navegador (técnico de campo entra pelo app).
 */
export type SessionEndReason = "expired" | "logout" | "channel";

const END_REASONS: SessionEndReason[] = ["expired", "logout", "channel"];

const STORAGE_KEY = "maxxchamados.session";
// Por aba (sessionStorage): a tela de login explica "sua sessão terminou" só a quem teve a sessão vencida.
const END_KEY = "mf:fim";
const listeners = new Set<() => void>();
let cached: Session | null | undefined;

function readStorage(): Session | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

export const sessionStore = {
  get(): Session | null {
    if (typeof window === "undefined") return null;
    if (cached === undefined) cached = readStorage();
    return cached;
  },
  /** Grava a sessão (null encerra). `reason` diz por que terminou, para a tela de login explicar. */
  set(session: Session | null, reason?: SessionEndReason) {
    cached = session;
    try {
      if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Sem storage (aba privada): a sessão vive só em memória.
    }
    try {
      if (session) window.sessionStorage.removeItem(END_KEY);
      else if (reason) window.sessionStorage.setItem(END_KEY, reason);
    } catch {
      // Sem storage: o login só não explica o motivo.
    }
    emit();
  },
  /** Motivo do último encerramento nesta aba (some quando alguém entra de novo). */
  endReason(): SessionEndReason | null {
    try {
      const value = window.sessionStorage.getItem(END_KEY);
      return END_REASONS.find((reason) => reason === value) ?? null;
    } catch {
      return null;
    }
  },
  fromTokenResponse(data: TokenResponse) {
    sessionStore.set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: data.user,
    });
  },
  updateUser(user: User) {
    const current = sessionStore.get();
    if (current) sessionStore.set({ ...current, user });
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        cached = readStorage();
        listener();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  },
  getServerSnapshot(): Session | null {
    return null;
  },
};

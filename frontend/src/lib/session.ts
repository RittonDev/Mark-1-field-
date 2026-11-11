// Sessão (tokens + usuário) guardada no localStorage e exposta como store externo,
// para ser lida com useSyncExternalStore sem setState em efeitos.

import type { TokenResponse, User } from "./types";

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: User;
}

const STORAGE_KEY = "maxxchamados.session";
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
  set(session: Session | null) {
    cached = session;
    try {
      if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Sem storage (aba privada): a sessão vive só em memória.
    }
    emit();
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

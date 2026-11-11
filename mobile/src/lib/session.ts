// Sessão (tokens + usuário + servidor) guardada no Keychain/Keystore via expo-secure-store
// e exposta como store externo para useSyncExternalStore.

import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { defaultApiUrl, normalizeApiUrl } from "./config";
import type { TokenResponse, User } from "./types";

export type SessionStatus = "loading" | "signedOut" | "signedIn";

export interface SessionState {
  status: SessionStatus;
  apiUrl: string;
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  /** true quando o refresh token foi recusado (30 dias sem uso ou usuário desativado). */
  expired: boolean;
  /** Último e-mail usado, para preencher o login. */
  lastEmail: string | null;
}

const KEYS = {
  access: "mc_access_token",
  refresh: "mc_refresh_token",
  user: "mc_user",
  apiUrl: "mc_api_url",
  lastEmail: "mc_last_email",
} as const;

let state: SessionState = {
  status: "loading",
  apiUrl: defaultApiUrl(),
  accessToken: null,
  refreshToken: null,
  user: null,
  expired: false,
  lastEmail: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

async function write(key: string, value: string | null) {
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value);
}

function parseUser(raw: string | null): User | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export const session = {
  get: (): SessionState => state,

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  async load() {
    const [access, refresh, user, apiUrl, lastEmail] = await Promise.all([
      SecureStore.getItemAsync(KEYS.access),
      SecureStore.getItemAsync(KEYS.refresh),
      SecureStore.getItemAsync(KEYS.user),
      SecureStore.getItemAsync(KEYS.apiUrl),
      SecureStore.getItemAsync(KEYS.lastEmail),
    ]);
    const parsed = parseUser(user);
    update({
      status: access && refresh && parsed ? "signedIn" : "signedOut",
      accessToken: access,
      refreshToken: refresh,
      user: parsed,
      apiUrl: apiUrl ?? defaultApiUrl(),
      lastEmail,
    });
  },

  async signIn(data: TokenResponse) {
    await Promise.all([
      write(KEYS.access, data.access_token),
      write(KEYS.refresh, data.refresh_token),
      write(KEYS.user, JSON.stringify(data.user)),
      write(KEYS.lastEmail, data.user.email),
    ]);
    update({
      status: "signedIn",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: data.user,
      expired: false,
      lastEmail: data.user.email,
    });
  },

  /** Novo par de tokens vindo de /auth/refresh. */
  async setTokens(data: TokenResponse) {
    await Promise.all([
      write(KEYS.access, data.access_token),
      write(KEYS.refresh, data.refresh_token),
      write(KEYS.user, JSON.stringify(data.user)),
    ]);
    update({ accessToken: data.access_token, refreshToken: data.refresh_token, user: data.user });
  },

  async setApiUrl(value: string) {
    const apiUrl = normalizeApiUrl(value);
    await write(KEYS.apiUrl, apiUrl);
    update({ apiUrl });
  },

  /**
   * Encerra a sessão. Os dados locais e a fila de operações ficam no aparelho:
   * se o mesmo técnico entrar de novo, o que estava pendente é enviado.
   */
  async signOut(expired = false) {
    await Promise.all([write(KEYS.access, null), write(KEYS.refresh, null), write(KEYS.user, null)]);
    update({ status: "signedOut", accessToken: null, refreshToken: null, user: null, expired });
  },
};

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.get, session.get);
}

// Sessão (tokens + usuário + servidor) guardada no Keychain/Keystore via expo-secure-store
// e exposta como store externo para useSyncExternalStore.

import { secureStorage } from "./secureStorage";
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
  /** Motivo do encerramento para mostrar no login (ex.: papel sem acesso ao app). */
  notice: string | null;
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
  notice: null,
  lastEmail: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

async function write(key: string, value: string | null) {
  if (value === null) await secureStorage.removeItem(key);
  else await secureStorage.setItem(key, value);
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

  /**
   * Lê a sessão salva. Se `allowUser` recusar o usuário salvo, a sessão não é aberta
   * (status continua "loading") e a função devolve false para quem chamou encerrá-la.
   */
  async load(allowUser: (user: User) => boolean = () => true): Promise<boolean> {
    const [access, refresh, user, apiUrl, lastEmail] = await Promise.all([
      secureStorage.getItem(KEYS.access),
      secureStorage.getItem(KEYS.refresh),
      secureStorage.getItem(KEYS.user),
      secureStorage.getItem(KEYS.apiUrl),
      secureStorage.getItem(KEYS.lastEmail),
    ]);
    const parsed = parseUser(user);
    const hasSession = Boolean(access && refresh && parsed);
    if (hasSession && parsed && !allowUser(parsed)) {
      update({ apiUrl: apiUrl ?? defaultApiUrl(), lastEmail, accessToken: access, refreshToken: refresh, user: parsed });
      return false;
    }
    update({
      status: hasSession ? "signedIn" : "signedOut",
      accessToken: access,
      refreshToken: refresh,
      user: parsed,
      apiUrl: apiUrl ?? defaultApiUrl(),
      lastEmail,
    });
    return true;
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
      notice: null,
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

  /** Usuário atualizado (ex.: depois da troca de senha ou do aceite do termo de rastreamento). */
  async updateUser(user: User) {
    await write(KEYS.user, JSON.stringify(user));
    update({ user });
  },

  async setApiUrl(value: string) {
    const apiUrl = normalizeApiUrl(value);
    await write(KEYS.apiUrl, apiUrl);
    update({ apiUrl });
  },

  /**
   * Encerra a sessão. Os dados locais e a fila de operações ficam no aparelho:
   * se o mesmo técnico entrar de novo, o que estava pendente é enviado.
   * `notice` aparece na tela de login.
   */
  async signOut(expired = false, notice: string | null = null) {
    await Promise.all([write(KEYS.access, null), write(KEYS.refresh, null), write(KEYS.user, null)]);
    update({ status: "signedOut", accessToken: null, refreshToken: null, user: null, expired, notice });
  },
};

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.get, session.get);
}

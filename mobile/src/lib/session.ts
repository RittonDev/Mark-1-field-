// Sessão (tokens + usuário + servidor) guardada no Keychain/Keystore via expo-secure-store
// e exposta como store externo para useSyncExternalStore.

import { secureStorage } from "./secureStorage";
import { useSyncExternalStore } from "react";
import { ACCESS_DISABLED_MESSAGE, MOBILE_DENIED_MESSAGE } from "./access";
import { defaultApiUrl, normalizeApiUrl } from "./config";
import type { TokenResponse, User } from "./types";

export type SessionStatus = "loading" | "signedOut" | "signedIn";

/**
 * Fim de sessão que o aparelho ainda precisa concluir (sessionEnd.ts). É gravado antes de os tokens saírem: vale mesmo
 * se o app morrer no meio da limpeza, inclusive na rodada sem tela, e a abertura seguinte conclui e mostra o motivo.
 */
export interface SessionEnding {
  /** Apagar do aparelho as OS, os dados de clientes, as fotos e a fila (técnico desativado ou sem acesso ao app: LGPD). */
  wipe: boolean;
  /** Motivo para o login. */
  notice: string | null;
  /** Encerrada pelo servidor: sem motivo, o login diz que a sessão expirou. */
  expired: boolean;
}

/**
 * O técnico só vê e muda o endereço do servidor em desenvolvimento (Expo Go na rede local) ou num build
 * sem servidor configurado. No app publicado, ninguém consegue orientá-lo a mandar e-mail e senha para
 * outro servidor.
 */
export const canEditServer = __DEV__ || !process.env.EXPO_PUBLIC_API_URL;

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
  ending: "mc_session_end",
} as const;

/** Motivos de saída que apagam os dados do aparelho (LGPD): técnico desativado pela central ou sem acesso ao app. */
const WIPE_NOTICES: readonly string[] = [ACCESS_DISABLED_MESSAGE, MOBILE_DENIED_MESSAGE];

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

const clearTokens = () => Promise.all([write(KEYS.access, null), write(KEYS.refresh, null), write(KEYS.user, null)]);

/** Fim de sessão pendente na memória (undefined: ainda não lido do armazenamento). */
let ending: SessionEnding | null | undefined;

function parseEnding(raw: string | null): SessionEnding | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { wipe, notice, expired } = value as Record<string, unknown>;
    return { wipe: wipe === true, notice: typeof notice === "string" ? notice : null, expired: expired === true };
  } catch {
    return null;
  }
}

/**
 * Guarda o fim pendente na memória e no armazenamento. A gravação que falha não impede a saída: a limpeza com o app
 * aberto lê a memória. Não lança erro.
 */
async function keepEnding(value: SessionEnding | null) {
  ending = value;
  try {
    await write(KEYS.ending, value ? JSON.stringify(value) : null);
  } catch (error) {
    console.warn("Não foi possível guardar o fim da sessão", error);
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
   * Com um fim de sessão gravado, a sessão não reabre e o login mostra o motivo (sessionEnd.ts conclui a limpeza).
   */
  async load(allowUser: (user: User) => boolean = () => true): Promise<boolean> {
    const [access, refresh, user, apiUrl, lastEmail, pending] = await Promise.all([
      secureStorage.getItem(KEYS.access),
      secureStorage.getItem(KEYS.refresh),
      secureStorage.getItem(KEYS.user),
      secureStorage.getItem(KEYS.apiUrl),
      secureStorage.getItem(KEYS.lastEmail),
      secureStorage.getItem(KEYS.ending),
    ]);
    ending = parseEnding(pending);
    if (ending) {
      // O servidor encerrou a sessão e o app morreu antes de apagar os tokens: termina de apagar.
      if (access || refresh || user) await clearTokens();
      update({
        status: "signedOut",
        accessToken: null,
        refreshToken: null,
        user: null,
        apiUrl: apiUrl ?? defaultApiUrl(),
        lastEmail,
        expired: ending.expired,
        notice: ending.notice,
      });
      return true;
    }
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
    // Entrou de novo: o fim da sessão anterior não vale mais (o login espera a limpeza dele terminar).
    await keepEnding(null);
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

  /**
   * Novo par de tokens vindo de /auth/refresh (e da troca de senha). O usuário vem como está no servidor: o e-mail novo
   * validado pelo link (fora do app, sem derrubar a sessão) chega por aqui e vira também o último login, para o login
   * não vir com o endereço antigo se a sessão acabar antes de o app abrir de novo.
   */
  async setTokens(data: TokenResponse) {
    const emailChanged = data.user.email !== state.lastEmail;
    await Promise.all([
      write(KEYS.access, data.access_token),
      write(KEYS.refresh, data.refresh_token),
      write(KEYS.user, JSON.stringify(data.user)),
      emailChanged ? write(KEYS.lastEmail, data.user.email) : null,
    ]);
    update({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: data.user,
      ...(emailChanged ? { lastEmail: data.user.email } : {}),
    });
  },

  /**
   * Usuário atualizado (ex.: depois da troca de senha, do aceite do termo de rastreamento ou do cadastro, que traz o
   * login de agora). O e-mail vai junto para o último login: depois de validar o e-mail novo, o login já vem com ele.
   */
  async updateUser(user: User) {
    await Promise.all([write(KEYS.user, JSON.stringify(user)), write(KEYS.lastEmail, user.email)]);
    update({ user, lastEmail: user.email });
  },

  async setApiUrl(value: string) {
    const apiUrl = normalizeApiUrl(value);
    await write(KEYS.apiUrl, apiUrl);
    update({ apiUrl });
  },

  /**
   * Encerra a sessão. Sem `wipe`, os dados locais e a fila de operações ficam no aparelho: se o mesmo técnico entrar
   * de novo, o que estava pendente é enviado. `notice` aparece na tela de login. `wipe` (apagar os dados do aparelho)
   * vem ligado com o motivo de técnico desativado ou sem acesso ao app.
   * Encerrada pelo servidor (`expired`), com motivo ou com `wipe`, o fim fica gravado antes de os tokens saírem: a
   * limpeza (sessionEnd.ts) e o motivo no login valem mesmo se o app morrer no meio.
   */
  async signOut(expired = false, notice: string | null = null, wipe = notice !== null && WIPE_NOTICES.includes(notice)) {
    if (expired || notice || wipe) await keepEnding({ wipe, notice, expired });
    await clearTokens();
    update({ status: "signedOut", accessToken: null, refreshToken: null, user: null, expired, notice });
  },

  /** Fim de sessão gravado e ainda não concluído (sessionEnd.ts), ou null. */
  async pendingEnd(): Promise<SessionEnding | null> {
    if (ending !== undefined) return ending;
    const stored = parseEnding(await secureStorage.getItem(KEYS.ending));
    // Gravado enquanto lia: vale o mais novo.
    if (ending === undefined) ending = stored;
    return ending;
  },

  /** Grava o fim pendente (null: concluído). Não lança erro. */
  setPendingEnd: (value: SessionEnding | null): Promise<void> => keepEnding(value),
};

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.get, session.get);
}

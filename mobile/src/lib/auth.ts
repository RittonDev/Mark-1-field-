import { canUseMobile, MOBILE_CHANNEL, MOBILE_DENIED_MESSAGE } from "./access";
import { request, setAccessRevokedHandler } from "./api";
import { notifyDataChanged } from "./changes";
import { getKv, setKv } from "./db";
import { registerDevice, unregisterDevice, type DeviceRegistration } from "./device";
import { session } from "./session";
import { startSync, stopSync, wipeLocalData } from "./sync";
import { resumeTracking, stopTracking } from "./tracking";
import type { TokenResponse } from "./types";

const OWNER_KEY = "owner_user_id";

let lastRegistration: DeviceRegistration | null = null;
export const getDeviceRegistration = () => lastRegistration;

/**
 * O usuário não pode usar o app (não é técnico de campo, ou deixou de ser):
 * encerra a sessão, apaga o banco local e as fotos pendentes e volta ao login com o motivo.
 */
async function revokeAccess(message: string) {
  stopSync();
  await stopTracking({ endOnServer: false });
  lastRegistration = null;
  await wipeLocalData();
  await session.signOut(false, message);
}

// 401 do /auth/refresh com a mensagem de canal (papel mudou no servidor).
setAccessRevokedHandler(revokeAccess);

/** Abertura do app: lê a sessão salva e barra quem não é técnico (ex.: login antigo de analista). */
export async function restoreSession() {
  const allowed = await session.load((user) => canUseMobile(user.role));
  if (!allowed) await revokeAccess(MOBILE_DENIED_MESSAGE);
}

/** Depois do login (ou ao abrir o app já logado): sync, tempo real e registro do aparelho. */
export async function startSession() {
  startSync();
  // Jornada em andamento (app reaberto ou aparelho reiniciado): retoma a coleta.
  void resumeTracking().catch((error: unknown) => console.warn("Falha ao retomar a jornada", error));
  lastRegistration = await registerDevice();
  notifyDataChanged();
}

/**
 * Login pelo canal "mobile": o servidor responde 403 para quem não é técnico de campo,
 * e o `detail` vira a mensagem da tela de login.
 */
export async function login(email: string, password: string, apiUrl: string) {
  await session.setApiUrl(apiUrl);
  const data = await request<TokenResponse>("/auth/login", {
    method: "POST",
    body: { email: email.trim(), password, channel: MOBILE_CHANNEL },
    auth: false,
  });
  // Defesa extra caso a API não aplique o canal (versão antiga do backend).
  if (!canUseMobile(data.user.role)) throw new Error(MOBILE_DENIED_MESSAGE);
  // Outro técnico no mesmo aparelho: os dados locais (e a fila) eram do anterior.
  const owner = await getKv(OWNER_KEY);
  if (owner && owner !== data.user.id) await wipeLocalData();
  await setKv(OWNER_KEY, data.user.id);
  await session.signIn(data);
}

export async function logout() {
  // Sair encerra a jornada: nada é coletado depois do logout.
  await stopTracking({ endOnServer: true });
  await unregisterDevice();
  stopSync();
  lastRegistration = null;
  await session.signOut();
}

import { canUseMobile, MOBILE_CHANNEL, MOBILE_DENIED_MESSAGE } from "./access";
import { mustChangePassword, refreshMe } from "./account";
import { request, setAccessRevokedHandler } from "./api";
import { notifyDataChanged } from "./changes";
import { getKv, setKv } from "./db";
import { registerDevice, unregisterDevice, type DeviceRegistration } from "./device";
import { session } from "./session";
import { startSync, stopSync, wipeLocalData } from "./sync";
import { hasConsent, resumeTracking, stopTracking } from "./tracking";
import type { TokenResponse } from "./types";

const OWNER_KEY = "owner_user_id";
/** No logout com sinal ruim, quanto esperar o fim da jornada e o descadastro do push antes de sair. */
const LOGOUT_TRACKING_WAIT_MS = 8_000;
const LOGOUT_DEVICE_WAIT_MS = 5_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let lastRegistration: DeviceRegistration | null = null;
let pushRequested = false;
export const getDeviceRegistration = () => lastRegistration;

/**
 * O usuário não pode usar o app (não é técnico de campo, ou deixou de ser):
 * encerra a sessão, apaga o banco local e as fotos pendentes e volta ao login com o motivo.
 */
async function revokeAccess(message: string) {
  stopSync();
  await stopTracking({ endOnServer: false });
  lastRegistration = null;
  pushRequested = false;
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
  // Confere o usuário no servidor: se o analista redefiniu a senha (must_change_password),
  // o layout leva para "Crie sua senha" e nada mais começa. Offline, segue com o usuário salvo.
  try {
    const me = await refreshMe();
    if (mustChangePassword(me)) return;
  } catch {
    // sem rede
  }
  startSync();
  // Jornada em andamento (app reaberto ou aparelho reiniciado): retoma a coleta.
  void resumeTracking().catch((error: unknown) => console.warn("Falha ao retomar a jornada", error));
  // Sem o termo de localização aceito, o push espera o termo ser visto (tela inicial): o celular não
  // pede as permissões de localização e de notificações ao mesmo tempo no primeiro acesso.
  if (hasConsent()) await ensurePushRegistration();
}

/** Registro do aparelho para push (pede a permissão de notificações). Uma vez por sessão. */
export async function ensurePushRegistration() {
  if (pushRequested || session.get().status !== "signedIn") return;
  pushRequested = true;
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
  // Sair encerra a jornada: nada é coletado depois do logout. Com sinal ruim, não espera mais que
  // alguns segundos: o fim da jornada que não chegou ao servidor fica guardado e vai no próximo login,
  // e a coleta para sozinha quando a sessão é encerrada (layout e handleLocations).
  await Promise.race([stopTracking({ endOnServer: true }), delay(LOGOUT_TRACKING_WAIT_MS)]);
  // Sem rede, o servidor reatribui o token de push no próximo login neste aparelho.
  await Promise.race([unregisterDevice(), delay(LOGOUT_DEVICE_WAIT_MS)]);
  stopSync();
  lastRegistration = null;
  pushRequested = false;
  await session.signOut();
}

import { ACCESS_DISABLED_MESSAGE, canUseMobile, MOBILE_CHANNEL, MOBILE_DENIED_MESSAGE } from "./access";
import { mustChangePassword, refreshMe } from "./account";
import { ApiError, request } from "./api";
import { registerBackgroundSync } from "./backgroundSync";
import { notifyDataChanged } from "./changes";
import { getKv, setKv } from "./db";
import { deviceRegistration, registerDevice, unregisterDevice } from "./device";
import { askNotificationPermission, ensureNotificationsReady, syncLocalAlerts } from "./notifications";
import { loadProfile } from "./profile";
import { session } from "./session";
import { applyPendingEnd, finishSessionEnd, forgetDisabledAccess, revokeAccess, sessionEndSettled } from "./sessionEnd";
import { startSync, wipeLocalData } from "./sync";
import { hasConsent, resumeTracking, stopTracking } from "./tracking";
import type { TokenResponse } from "./types";

// O fim de sessão (Sair, sessão expirada, acesso desativado ou retirado: notificações, tarefa em segundo plano e, se
// for o caso, os dados do aparelho) fica em sessionEnd.ts, que também roda com o app sem tela.

const OWNER_KEY = "owner_user_id";
/** No logout com sinal ruim, quanto esperar o fim da jornada e o descadastro do push antes de sair. */
const LOGOUT_TRACKING_WAIT_MS = 8_000;
const LOGOUT_DEVICE_WAIT_MS = 5_000;
/** No login, quanto esperar a limpeza da sessão anterior (ex.: a jornada ainda encerrando com sinal ruim). */
const LOGIN_CLEANUP_WAIT_MS = 10_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Técnico cujo aparelho já foi registrado para o push nesta sessão (zera a cada login). */
let pushRequestedFor: string | null = null;

/** Estado do registro do push (vale também o reenvio que deu certo depois, na sincronização). */
export const getDeviceRegistration = () => deviceRegistration();

/**
 * Abertura do app: lê a sessão salva, barra quem não é técnico (ex.: login antigo de analista) e conclui o fim de
 * sessão que ficou gravado (servidor encerrou a sessão com o app sem tela, ou o app morreu no meio da limpeza): apaga
 * os dados do técnico desativado, e o login mostra o motivo.
 */
export async function restoreSession() {
  const allowed = await session.load((user) => canUseMobile(user.role));
  if (!allowed) await revokeAccess(MOBILE_DENIED_MESSAGE);
  await applyPendingEnd();
}

/** Depois do login (ou ao abrir o app já logado): sync, tempo real e registro do aparelho. */
export async function startSession() {
  // Handler, canais e toque nas notificações, inclusive o toque que abriu o app (abre a OS ou a oferta).
  void ensureNotificationsReady({ launch: true });
  // Confere o usuário no servidor: se o analista redefiniu a senha (must_change_password),
  // o layout leva para "Crie sua senha" e nada mais começa. Offline, segue com o usuário salvo.
  try {
    const me = await refreshMe();
    if (mustChangePassword(me)) return;
  } catch {
    // sem rede
  }
  // Meu cadastro (foto do topo, chave PIX em Ganhos): fica só na memória. Sem rede, fica para depois, sem aviso.
  void loadProfile().catch(() => undefined);
  startSync();
  // Sincronização com o app fora da tela (tarefa periódica do sistema; não existe no Expo Go).
  void registerBackgroundSync();
  // Jornada em andamento (app reaberto ou aparelho reiniciado): retoma a coleta.
  void resumeTracking().catch((error: unknown) => console.warn("Falha ao retomar a jornada", error));
  // Sem o termo de localização aceito, o push espera o termo ser visto (tela inicial): o celular não
  // pede as permissões de localização e de notificações ao mesmo tempo no primeiro acesso.
  if (hasConsent()) await ensurePushRegistration();
}

/**
 * Notificações do aparelho, uma vez por sessão: o único pedido automático da permissão (no máximo uma vez por
 * técnico, também no Expo Go), os lembretes e alertas locais já com a permissão e o registro para o push.
 */
export async function ensurePushRegistration() {
  const { status, user } = session.get();
  if (status !== "signedIn" || !user || pushRequestedFor === user.id) return;
  pushRequestedFor = user.id;
  await askNotificationPermission({ auto: true });
  await syncLocalAlerts();
  await registerDevice();
  // A Conta mostra o estado do registro: redesenha quando ele termina.
  notifyDataChanged();
}

/** Notificações liberadas depois (Conta, configurações do celular): registra o aparelho para o push já. */
export async function refreshPushRegistration() {
  if (session.get().status !== "signedIn") return;
  await registerDevice();
  notifyDataChanged();
}

/**
 * Login pelo canal "mobile": o servidor responde 403 para quem não é técnico de campo,
 * e o `detail` vira a mensagem da tela de login.
 */
export async function login(email: string, password: string, apiUrl: string) {
  // A limpeza da sessão anterior (dados do técnico desativado, tarefa em segundo plano) termina antes de outra começar.
  await Promise.race([sessionEndSettled(), delay(LOGIN_CLEANUP_WAIT_MS)]);
  await session.setApiUrl(apiUrl);
  let data: TokenResponse;
  try {
    data = await request<TokenResponse>("/auth/login", {
      method: "POST",
      body: { email: email.trim(), password, channel: MOBILE_CHANNEL },
      auth: false,
    });
  } catch (error) {
    // Senha certa de conta desativada, de quem é dono dos dados do aparelho (saiu antes de a central
    // desativar): apaga as OS e os dados de clientes guardados (LGPD) antes de mostrar o motivo.
    const lastEmail = session.get().lastEmail;
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      error.detail === ACCESS_DISABLED_MESSAGE &&
      lastEmail &&
      lastEmail.trim().toLowerCase() === email.trim().toLowerCase()
    ) {
      await forgetDisabledAccess();
    }
    throw error;
  }
  // Defesa extra caso a API não aplique o canal (versão antiga do backend).
  if (!canUseMobile(data.user.role)) throw new Error(MOBILE_DENIED_MESSAGE);
  // Outro técnico no mesmo aparelho: os dados locais (e a fila) eram do anterior.
  const owner = await getKv(OWNER_KEY);
  if (owner && owner !== data.user.id) await wipeLocalData();
  await setKv(OWNER_KEY, data.user.id);
  // Sessão nova: o aparelho é registrado de novo para o push, mesmo sem reabrir o app.
  pushRequestedFor = null;
  await session.signIn(data);
}

export async function logout() {
  // Sair encerra a jornada: nada é coletado depois do logout. Com sinal ruim, não espera mais que
  // alguns segundos: o fim da jornada que não chegou ao servidor fica guardado e vai no próximo login,
  // e a coleta para sozinha quando a sessão é encerrada (layout e handleLocations).
  await Promise.race([stopTracking({ endOnServer: true }), delay(LOGOUT_TRACKING_WAIT_MS)]);
  // Sem rede, o servidor reatribui o token de push no próximo login neste aparelho.
  await Promise.race([unregisterDevice(), delay(LOGOUT_DEVICE_WAIT_MS)]);
  await session.signOut();
  // A mesma limpeza de qualquer fim de sessão: sync, notificações, jornada e tarefa em segundo plano.
  await finishSessionEnd();
}

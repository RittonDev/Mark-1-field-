// Registro do aparelho para push (POST /devices). O backend ainda só registra em log
// (LogPushProvider) e responde `push: "simulated"`: o app avisa sozinho as novidades da sincronização
// (notifications.ts). Quando o FCM for ligado, este token é o que ele vai usar, a resposta passa a ser
// "live" e o app para de repetir o aviso (kv push_live).
//
// No Expo Go não existe token de push do próprio app (no Android o expo-notifications
// lança erro desde o SDK 53), então o registro só acontece num development build.
// Aqui não se pede permissão: o pedido é um só, em auth.ts (ensurePushRegistration) e na Conta.
// Sem rede na abertura do app, o token fica guardado e vai na próxima sincronização.

import Constants from "expo-constants";
import * as Device from "expo-device";
import { isRunningInExpoGo } from "expo";
import { Platform } from "react-native";
import { api, ApiError } from "./api";
import { APP_VERSION } from "./config";
import { getKv, setKv } from "./db";
import { ensureNotificationsReady } from "./notifications";
import type { DeviceRegistered } from "./syncTypes";

export type PushMode = DeviceRegistered["push"];

/**
 * - registered: token no servidor (`push`: "live" quando a central entrega mesmo o push a este aparelho);
 * - unsupported: Expo Go, emulador ou web (sem token de push do app);
 * - blocked: notificações bloqueadas e o celular não deixa pedir de novo;
 * - undetermined: notificações ainda não liberadas (dá para pedir);
 * - error: falha ao pegar o token ou ao registrar.
 */
export type DeviceRegistration =
  | { state: "registered"; token: string; push: PushMode }
  | { state: "unsupported" | "blocked" | "undetermined" | "error" };

const TOKEN_KEY = "push_token";
/** Token que ainda não chegou ao servidor (sem rede na hora): reenviado depois de cada sync. */
const UNSENT_KEY = "push_token_unsent";
/** "1": o servidor entrega push a este aparelho; as novidades não viram notificação local repetida. */
const PUSH_LIVE_KEY = "push_live";

let listenerInstalled = false;
let current: DeviceRegistration | null = null;

/** Último estado do registro, inclusive depois de um reenvio que deu certo. */
export const deviceRegistration = () => current;

/** O push da central já avisa este aparelho (o POST /devices respondeu "live"). */
export async function pushLive(): Promise<boolean> {
  return (await getKv(PUSH_LIVE_KEY).catch(() => null)) === "1";
}

async function post(token: string): Promise<PushMode> {
  let response: DeviceRegistered | undefined;
  try {
    response = await api.post<DeviceRegistered | undefined>("/devices", {
      platform: Platform.OS === "ios" ? "ios" : "android",
      token,
      app_version: Constants.expoConfig?.version ?? APP_VERSION,
    });
  } catch (error) {
    if (error instanceof ApiError && error.retryable) await setKv(UNSENT_KEY, token);
    throw error;
  }
  // Servidor antigo (204 sem corpo): o push não está ligado.
  const push: PushMode = response?.push === "live" ? "live" : "simulated";
  await setKv(TOKEN_KEY, token);
  await setKv(UNSENT_KEY, null);
  await setKv(PUSH_LIVE_KEY, push === "live" ? "1" : null);
  current = { state: "registered", token, push };
  return push;
}

export async function registerDevice(): Promise<DeviceRegistration> {
  current = await register();
  return current;
}

async function register(): Promise<DeviceRegistration> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return { state: "unsupported" };
  if (isRunningInExpoGo() || !Device.isDevice) return { state: "unsupported" };
  try {
    const Notifications = await ensureNotificationsReady();
    if (!Notifications) return { state: "unsupported" };
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return { state: permission.canAskAgain ? "undetermined" : "blocked" };
    // Token nativo: FCM no Android, APNs no iOS.
    const token = await Notifications.getDevicePushTokenAsync();
    const value = String(token.data);
    // O ouvinte vem antes do envio: um token trocado pelo sistema chega ao servidor mesmo se este envio falhar.
    if (!listenerInstalled) {
      listenerInstalled = true;
      Notifications.addPushTokenListener((next) => {
        post(String(next.data)).catch((error: unknown) => console.warn("Falha ao atualizar o token de push", error));
      });
    }
    const push = await post(value);
    return { state: "registered", token: value, push };
  } catch (error) {
    console.warn("Falha ao registrar o aparelho para notificações", error);
    return { state: "error" };
  }
}

/** Reenvia o token que ficou sem rede na abertura do app (chamado depois de cada sync que deu certo). */
export async function flushDeviceRegistration(): Promise<void> {
  const token = await getKv(UNSENT_KEY);
  if (!token) return;
  try {
    await post(token);
  } catch (error) {
    // Recusa definitiva (ex.: token inválido): não adianta repetir a cada sync.
    if (!(error instanceof ApiError) || !error.retryable) await setKv(UNSENT_KEY, null);
  }
}

/** DELETE /devices/{token} no logout (enquanto o access token ainda vale). */
export async function unregisterDevice(): Promise<void> {
  current = null;
  await setKv(UNSENT_KEY, null);
  // Já não recebe o push da central: o próximo técnico neste aparelho é avisado pelo próprio app.
  await setKv(PUSH_LIVE_KEY, null);
  const token = await getKv(TOKEN_KEY);
  if (!token) return;
  try {
    await api.delete(`/devices/${encodeURIComponent(token)}`);
  } catch {
    // sem rede: o servidor reatribui o token ao próximo login neste aparelho
  }
  await setKv(TOKEN_KEY, null);
}

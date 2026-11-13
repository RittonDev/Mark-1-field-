// Registro do aparelho para push (POST /devices). O backend ainda só registra em log
// (LogPushProvider); quando o FCM for ligado, este token é o que ele vai usar.
//
// No Expo Go não existe token de push do próprio app (no Android o expo-notifications
// lança erro desde o SDK 53), então o registro só acontece num development build.
// Sem rede na abertura do app, o token fica guardado e vai na próxima sincronização.

import Constants from "expo-constants";
import * as Device from "expo-device";
import { isRunningInExpoGo } from "expo";
import { Platform } from "react-native";
import { api, ApiError } from "./api";
import { APP_VERSION } from "./config";
import { getKv, setKv } from "./db";

export type DeviceRegistration =
  | { state: "registered"; token: string }
  | { state: "unsupported" | "denied" | "error"; message: string };

const TOKEN_KEY = "push_token";
/** Token que ainda não chegou ao servidor (sem rede na hora): reenviado depois de cada sync. */
const UNSENT_KEY = "push_token_unsent";

const UNSUPPORTED = "Notificações ainda não disponíveis nesta versão do app.";

let listenerInstalled = false;
let current: DeviceRegistration | null = null;

/** Último estado do registro, inclusive depois de um reenvio que deu certo. */
export const deviceRegistration = () => current;

async function post(token: string) {
  try {
    await api.post("/devices", {
      platform: Platform.OS === "ios" ? "ios" : "android",
      token,
      app_version: Constants.expoConfig?.version ?? APP_VERSION,
    });
  } catch (error) {
    if (error instanceof ApiError && error.retryable) await setKv(UNSENT_KEY, token);
    throw error;
  }
  await setKv(TOKEN_KEY, token);
  await setKv(UNSENT_KEY, null);
  current = { state: "registered", token };
}

export async function registerDevice(): Promise<DeviceRegistration> {
  current = await register();
  return current;
}

async function register(): Promise<DeviceRegistration> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return { state: "unsupported", message: UNSUPPORTED };
  if (isRunningInExpoGo()) return { state: "unsupported", message: UNSUPPORTED };
  if (!Device.isDevice) {
    return { state: "unsupported", message: "Emuladores não recebem notificações." };
  }
  try {
    // Import tardio: no Expo Go o módulo só emite avisos e não é usado.
    const Notifications = await import("expo-notifications");
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Ordens de serviço",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) {
      return { state: "denied", message: "Notificações bloqueadas: libere nas configurações do celular." };
    }
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
    await post(value);
    return { state: "registered", token: value };
  } catch (error) {
    console.warn("Falha ao registrar o aparelho para notificações", error);
    return { state: "error", message: "Não foi possível ativar as notificações agora." };
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
  const token = await getKv(TOKEN_KEY);
  if (!token) return;
  try {
    await api.delete(`/devices/${encodeURIComponent(token)}`);
  } catch {
    // sem rede: o servidor reatribui o token ao próximo login neste aparelho
  }
  await setKv(TOKEN_KEY, null);
}

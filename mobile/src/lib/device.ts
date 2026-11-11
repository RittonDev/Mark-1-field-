// Registro do aparelho para push (POST /devices). O backend ainda só registra em log
// (LogPushProvider); quando o FCM for ligado, este token é o que ele vai usar.
//
// No Expo Go não existe token de push do próprio app (no Android o expo-notifications
// lança erro desde o SDK 53), então o registro só acontece num development build.

import Constants from "expo-constants";
import * as Device from "expo-device";
import { isRunningInExpoGo } from "expo";
import { Platform } from "react-native";
import { api, errorMessage } from "./api";
import { APP_VERSION } from "./config";
import { getKv, setKv } from "./db";

export type DeviceRegistration =
  | { state: "registered"; token: string }
  | { state: "unsupported" | "denied" | "error"; message: string };

const TOKEN_KEY = "push_token";

let listenerInstalled = false;

async function post(token: string) {
  await api.post("/devices", {
    platform: Platform.OS === "ios" ? "ios" : "android",
    token,
    app_version: Constants.expoConfig?.version ?? APP_VERSION,
  });
  await setKv(TOKEN_KEY, token);
}

export async function registerDevice(): Promise<DeviceRegistration> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return { state: "unsupported", message: "Push só existe no app instalado (iOS/Android)." };
  }
  if (isRunningInExpoGo()) {
    return {
      state: "unsupported",
      message: "Push indisponível no Expo Go. Gere um development build para registrar o aparelho.",
    };
  }
  if (!Device.isDevice) {
    return { state: "unsupported", message: "Emuladores não recebem push." };
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
      return { state: "denied", message: "Permissão de notificações negada." };
    }
    // Token nativo: FCM no Android, APNs no iOS.
    const token = await Notifications.getDevicePushTokenAsync();
    const value = String(token.data);
    await post(value);
    if (!listenerInstalled) {
      listenerInstalled = true;
      Notifications.addPushTokenListener((next) => {
        post(String(next.data)).catch((error: unknown) => console.warn("Falha ao atualizar o token de push", error));
      });
    }
    return { state: "registered", token: value };
  } catch (error) {
    return { state: "error", message: errorMessage(error) };
  }
}

/** DELETE /devices/{token} no logout (enquanto o access token ainda vale). */
export async function unregisterDevice(): Promise<void> {
  const token = await getKv(TOKEN_KEY);
  if (!token) return;
  try {
    await api.delete(`/devices/${encodeURIComponent(token)}`);
  } catch {
    // sem rede: o servidor reatribui o token ao próximo login neste aparelho
  }
  await setKv(TOKEN_KEY, null);
}

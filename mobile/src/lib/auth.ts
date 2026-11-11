import { request } from "./api";
import { notifyDataChanged } from "./changes";
import { getKv, resetLocalData, setKv } from "./db";
import { registerDevice, unregisterDevice, type DeviceRegistration } from "./device";
import { session } from "./session";
import { startSync, stopSync } from "./sync";
import type { TokenResponse } from "./types";

const OWNER_KEY = "owner_user_id";

let lastRegistration: DeviceRegistration | null = null;
export const getDeviceRegistration = () => lastRegistration;

/** Depois do login (ou ao abrir o app já logado): sync, tempo real e registro do aparelho. */
export async function startSession() {
  startSync();
  lastRegistration = await registerDevice();
  notifyDataChanged();
}

export async function login(email: string, password: string, apiUrl: string) {
  await session.setApiUrl(apiUrl);
  const data = await request<TokenResponse>("/auth/login", {
    method: "POST",
    body: { email: email.trim(), password },
    auth: false,
  });
  if (data.user.role === "requester") {
    throw new Error("Este app é da equipe técnica. Solicitantes usam o portal web.");
  }
  // Outro técnico no mesmo aparelho: os dados locais (e a fila) eram do anterior.
  const owner = await getKv(OWNER_KEY);
  if (owner && owner !== data.user.id) await resetLocalData();
  await setKv(OWNER_KEY, data.user.id);
  await session.signIn(data);
}

export async function logout() {
  await unregisterDevice();
  stopSync();
  lastRegistration = null;
  await session.signOut();
}

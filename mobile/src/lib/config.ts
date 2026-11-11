import Constants from "expo-constants";

/**
 * Endereço padrão da API, em ordem:
 * 1. `EXPO_PUBLIC_API_URL` (arquivo mobile/.env ou variável no `expo start`);
 * 2. o IP da máquina que roda o `expo start` (o mesmo que o Expo Go usou para baixar o bundle), porta 8000;
 * 3. o host do emulador Android.
 * O técnico ainda pode trocar o servidor na tela de login.
 */
export function defaultApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return normalizeApiUrl(fromEnv);
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host) return `http://${host}:8000/api/v1`;
  return "http://10.0.2.2:8000/api/v1";
}

/** Aceita "192.168.0.10:8000", "http://host:8000" ou a URL completa com /api/v1. */
export function normalizeApiUrl(value: string): string {
  let url = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (!/\/api\/v\d+$/.test(url)) url = `${url}/api/v1`;
  return url;
}

export function wsUrlFor(apiUrl: string): string {
  return `${apiUrl.replace(/^http/i, "ws")}/ws`;
}

/** Origem (sem /api/v1), para montar URLs relativas como `download_url`. */
export function apiOrigin(apiUrl: string): string {
  const match = /^(https?:\/\/[^/]+)/i.exec(apiUrl);
  return match ? match[1] : apiUrl;
}

export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";

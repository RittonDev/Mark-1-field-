import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * Endereço padrão da API, em ordem:
 * 1. `EXPO_PUBLIC_API_URL` (arquivo mobile/.env ou variável no build);
 * 2. pré-visualização web: a mesma máquina que serve a página, porta 8000;
 * 3. só em desenvolvimento: o IP da máquina que roda o `expo start` (o mesmo que o Expo Go usou
 *    para baixar o bundle), porta 8000, ou o host do emulador Android.
 * No app publicado sem a variável, fica vazio: o técnico informa o servidor na tela de login.
 */
export function defaultApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return normalizeApiUrl(fromEnv);
  if (Platform.OS === "web" && typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:8000/api/v1`;
  }
  if (!__DEV__) return "";
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host) return `http://${host}:8000/api/v1`;
  return "http://10.0.2.2:8000/api/v1";
}

/** Rede local ou máquina de desenvolvimento: IP, localhost, nome sem domínio, .local ou .lan. */
function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
    name.startsWith("[") ||
    name === "localhost" ||
    !name.includes(".") ||
    name.endsWith(".local") ||
    name.endsWith(".lan")
  );
}

/**
 * Aceita "192.168.0.10:8000", "api.empresa.com.br", "http://host:8000" ou a URL completa com /api/v1.
 * Sem o esquema, usa https (senha, tokens e fotos não trafegam abertos no Wi-Fi da loja), menos
 * na rede local, onde o servidor de desenvolvimento não tem certificado.
 */
export function normalizeApiUrl(value: string): string {
  let url = value.trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    const host = url.split("/")[0].replace(/:\d+$/, "");
    url = `${isLocalHost(host) ? "http" : "https"}://${url}`;
  }
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

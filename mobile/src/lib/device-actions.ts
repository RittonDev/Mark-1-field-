// Recursos do aparelho usados nas telas: GPS para check-in, links de mapa e o WhatsApp do relatório.

import * as Clipboard from "expo-clipboard";
import * as Location from "expo-location";
import { Linking, Platform } from "react-native";
import { mapTarget } from "./address";
import type { LocationRef } from "./types";

export { addressOf } from "./address";

export interface Position {
  latitude: number;
  longitude: number;
}

const GPS_TIMEOUT_MS = 12_000;

/**
 * Posição atual para o check-in. Funciona offline (GPS não depende de rede).
 * Sem permissão ou sem sinal, devolve null e a ação segue sem coordenadas.
 */
export async function currentPosition(): Promise<Position | null> {
  if (Platform.OS === "web") {
    const position = await browserPosition();
    return position ? { latitude: position.latitude, longitude: position.longitude } : null;
  }
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_TIMEOUT_MS)),
    ]);
    const position = fix ?? (await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }));
    if (!position) return null;
    return { latitude: position.coords.latitude, longitude: position.coords.longitude };
  } catch {
    return null;
  }
}

/** Pré-visualização web: geolocalização do navegador (pede permissão na primeira vez). */
function browserPosition(timeout = GPS_TIMEOUT_MS): Promise<(Position & { accuracy: number | null }) | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 5 * 60_000 },
    );
  });
}

/** Posição para registrar uma ação da OS: pronta, sem permissão ou sem sinal de GPS. */
export type PositionFix =
  | { status: "ok"; latitude: number; longitude: number; accuracy: number | null }
  | { status: "denied" }
  | { status: "unavailable" };

const QUICK_TIMEOUT_MS = 6_000;

function fixOf(position: Location.LocationObject): PositionFix {
  const { latitude, longitude, accuracy } = position.coords;
  return { status: "ok", latitude, longitude, accuracy: accuracy ?? null };
}

/** Última posição conhecida (sem esperar o GPS). */
async function lastKnown(maxAge: number, requiredAccuracy?: number): Promise<PositionFix | null> {
  const position = await Location.getLastKnownPositionAsync({ maxAge, requiredAccuracy }).catch(() => null);
  return position ? fixOf(position) : null;
}

/**
 * Posição rápida para saída, chegada, conclusão, visita improdutiva e assinatura: usa a última
 * posição recente (até 2 min, ±150 m) na hora; senão pede uma leitura equilibrada por até 6 s; no fim
 * aceita a última de até 10 min. Dentro de loja ou subsolo não prende o técnico esperando o GPS.
 * Só pede a permissão quando o técnico ainda não decidiu (quem negou recebe o atalho "Permitir").
 * A coleta da jornada continua com `currentPosition`.
 */
export async function quickPosition(): Promise<PositionFix> {
  if (Platform.OS === "web") {
    const position = await browserPosition(QUICK_TIMEOUT_MS);
    return position ? { status: "ok", ...position } : { status: "unavailable" };
  }
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted && permission.status === Location.PermissionStatus.UNDETERMINED) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (!permission.granted) return { status: "denied" };
    const recent = await lastKnown(120_000, 150);
    if (recent) return recent;
    const current = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then(fixOf, () => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), QUICK_TIMEOUT_MS)),
    ]);
    return current ?? (await lastKnown(10 * 60_000)) ?? { status: "unavailable" };
  } catch {
    // GPS desligado ou serviço indisponível: a última posição conhecida ainda serve.
    return (await lastKnown(10 * 60_000)) ?? { status: "unavailable" };
  }
}

/**
 * "Permitir" a localização: pede de novo quando o sistema ainda deixa; senão abre as configurações
 * do app. Devolve true se a permissão ficou concedida.
 */
export async function requestLocationPermission(): Promise<boolean> {
  if (Platform.OS === "web") return true;
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.granted) return true;
    if (current.canAskAgain) return (await Location.requestForegroundPermissionsAsync()).granted;
  } catch {
    // segue para as configurações
  }
  await Linking.openSettings().catch(() => undefined);
  return false;
}

/**
 * Abre o app de mapas no destino do atendimento: `service_address` da OS quando houver,
 * senão as coordenadas da filial, senão o endereço cadastrado (regra em address.ts).
 */
export async function openInMaps(location: LocationRef | null, serviceAddress: string | null | undefined) {
  const target = mapTarget(location, serviceAddress);
  if (!target) return;
  const label = encodeURIComponent(target.label);
  const query =
    target.kind === "coords" ? `${target.latitude},${target.longitude}` : encodeURIComponent(target.query);
  const native =
    Platform.OS === "ios"
      ? `maps:0,0?q=${target.kind === "coords" ? `${label}@${query}` : query}`
      : target.kind === "coords"
        ? `geo:${query}?q=${query}(${label})`
        : `geo:0,0?q=${query}`;
  const web = `https://www.google.com/maps/search/?api=1&query=${query}`;
  // No navegador não há app de mapas: abre o Google Maps numa nova aba.
  if (Platform.OS === "web") {
    await Linking.openURL(web);
    return;
  }
  try {
    await Linking.openURL(native);
  } catch {
    await Linking.openURL(web);
  }
}

export type NavApp = "google" | "waze";

/** Links de rota (deep link do app; sem o app instalado, o link web do mesmo serviço). */
export function navigationLinks(app: NavApp, location: LocationRef | null, serviceAddress: string | null | undefined) {
  const target = mapTarget(location, serviceAddress);
  if (!target) return null;
  const coords = target.kind === "coords" ? `${target.latitude},${target.longitude}` : null;
  const query = coords ?? encodeURIComponent(target.kind === "address" ? target.query : "");
  if (app === "waze") {
    const params = coords ? `ll=${coords}&navigate=yes` : `q=${query}&navigate=yes`;
    return { native: `waze://?${params}`, web: `https://waze.com/ul?${params}` };
  }
  const web = `https://www.google.com/maps/dir/?api=1&destination=${query}&travelmode=driving`;
  const native = Platform.OS === "ios" ? `comgooglemaps://?daddr=${query}&directionsmode=driving` : `google.navigation:q=${query}`;
  return { native, web };
}

/** Abre a rota no Google Maps ou no Waze. */
export async function navigateWith(app: NavApp, location: LocationRef | null, serviceAddress: string | null | undefined) {
  const links = navigationLinks(app, location, serviceAddress);
  if (!links) return;
  if (Platform.OS === "web") {
    await Linking.openURL(links.web);
    return;
  }
  try {
    await Linking.openURL(links.native);
  } catch {
    await Linking.openURL(links.web);
  }
}

/** Copia um texto (endereço do atendimento) para colar no WhatsApp ou em outro app. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

/** Abre o WhatsApp com a mensagem pronta; o técnico escolhe a conversa (o app não tem os contatos). */
export function openWhatsApp(text: string) {
  return Linking.openURL(`https://wa.me/?text=${encodeURIComponent(text)}`);
}

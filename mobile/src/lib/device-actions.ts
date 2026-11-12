// Recursos do aparelho usados nas telas: GPS para check-in e links para mapa/telefone.

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
  try {
    await Linking.openURL(native);
  } catch {
    await Linking.openURL(web);
  }
}

export function callPhone(phone: string) {
  return Linking.openURL(`tel:${phone.replace(/[^\d+]/g, "")}`);
}

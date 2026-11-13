// Distância entre o ponto de GPS do técnico e a loja: a prova de presença, como "a 161 m do local"
// no histórico do Field Control. Linha reta (não é rota), suficiente para dizer se ele estava lá.

/** Acima disso o ponto do início ou da conclusão fica marcado como longe da loja. */
export const FAR_FROM_STORE_M = 1000;

/** Metros entre dois pontos [latitude, longitude] (fórmula de haversine). */
export function distance(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** "160 m" ou "3,4 km". */
export function km(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

/** Ponto de GPS gravado no evento (status, visita improdutiva, assinatura), ou null. */
export function eventPoint(data: Record<string, unknown> | null | undefined): [number, number] | null {
  const lat = data?.latitude;
  const lng = data?.longitude;
  return typeof lat === "number" && typeof lng === "number" ? [lat, lng] : null;
}

/**
 * Metros do ponto do evento até a loja: a distância que a API gravou na hora (com a loja de então)
 * ou, nos eventos antigos, a conta com a loja de agora. Null sem ponto ou sem loja no mapa.
 */
export function storeDistance(data: Record<string, unknown> | null | undefined, store: [number, number] | null): number | null {
  if (typeof data?.distance_m === "number") return data.distance_m;
  const point = eventPoint(data);
  return point && store ? distance(store, point) : null;
}

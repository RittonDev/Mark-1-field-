// Estados do técnico no mapa ao vivo (espelha LiveState em backend/app/schemas/tracking.py).

import type { LiveState } from "./types";

export const LIVE_STATE: Record<LiveState, { label: string; color: string; hint: string }> = {
  in_progress: { label: "Em atendimento", color: "#d97706", hint: "No cliente, com OS em atendimento" },
  en_route: { label: "Em deslocamento", color: "#2447ff", hint: "A caminho do cliente" },
  available: { label: "Disponível", color: "#059669", hint: "Em jornada, sem OS em campo" },
  no_signal: { label: "Sem sinal", color: "#dc2626", hint: "Em jornada, sem posição há mais de 5 min" },
  offline: { label: "Fora da jornada", color: "#98a2b3", hint: "Jornada não iniciada ou encerrada" },
};

export const LIVE_STATE_ORDER: LiveState[] = ["in_progress", "en_route", "available", "no_signal", "offline"];

/** Velocidade em km/h (o app envia m/s). */
export function formatSpeed(mps: number | null | undefined): string | null {
  if (mps == null) return null;
  return `${Math.round(mps * 3.6)} km/h`;
}

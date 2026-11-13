// Estados do técnico no mapa ao vivo (espelha LiveState em backend/app/schemas/tracking.py).

import { formatMinutes } from "./format";
import type { ActivityState, LivePosition, LiveState, LiveTechnician } from "./types";

/**
 * Cores dos estados (pino, bolinha e avatar). Todas passam de 4,5:1 com as iniciais em branco; o texto
 * do estado fica em cinza de leitura (só "Sem sinal" é problema e vai em vermelho).
 */
export const LIVE_STATE: Record<LiveState, { label: string; color: string; hint: string }> = {
  in_progress: { label: "Em atendimento", color: "#b45309", hint: "No cliente, com OS em atendimento" },
  en_route: { label: "Em deslocamento", color: "#2447ff", hint: "A caminho do cliente" },
  available: { label: "Disponível", color: "#047857", hint: "Em jornada, sem OS em campo" },
  no_signal: { label: "Sem sinal", color: "#dc2626", hint: "Em jornada, sem posição há mais de 5 min" },
  offline: { label: "Fora da jornada", color: "#6b7280", hint: "Jornada não iniciada ou encerrada" },
};

export const LIVE_STATE_ORDER: LiveState[] = ["in_progress", "en_route", "available", "no_signal", "offline"];

// Tolerância entre o relógio do celular e o início da jornada (a mesma CLOCK_TOLERANCE da API).
const SHIFT_CLOCK_TOLERANCE_MS = 2 * 60_000;
// Sem posição nova há mais que isto, o ponto já não é "agora" (o mesmo limite do "Sem sinal" da API).
export const STALE_AFTER_MS = 5 * 60_000;

const time = (value: string) => new Date(value).getTime();

/**
 * O horário é da jornada aberta? Um ponto de antes do início é da jornada anterior (muitas vezes a casa
 * do técnico) e não aparece: fora da jornada a posição não existe para a central (LGPD).
 */
export function inCurrentShift(at: string | null | undefined, tech: LiveTechnician | null | undefined): boolean {
  if (!at || !tech?.on_shift || !tech.shift_started_at) return false;
  return time(at) >= time(tech.shift_started_at) - SHIFT_CLOCK_TOLERANCE_MS;
}

/** Última posição da jornada aberta (ou nenhuma). */
export function shiftPosition(tech: LiveTechnician): LivePosition | null {
  const pos = tech.last_position;
  return pos && inCurrentShift(pos.recorded_at, tech) ? pos : null;
}

/** Ponto antigo: sem posição nova há mais de 5 min (o técnico pode já estar em outro lugar). */
export function isStale(recordedAt: string | null | undefined, now: number): boolean {
  return !recordedAt || now - time(recordedAt) > STALE_AFTER_MS;
}

/** Velocidade em km/h (o app envia m/s). */
export function formatSpeed(mps: number | null | undefined): string | null {
  if (mps == null) return null;
  return `${Math.round(mps * 3.6)} km/h`;
}

/** "agora" / "há 3min" — tolera alguns segundos de diferença entre o relógio do celular e o do navegador. */
export function formatAgo(value: string | null | undefined, now: number): string {
  if (!value) return "—";
  const minutes = (now - new Date(value).getTime()) / 60_000;
  return minutes < 1 ? "agora" : `há ${formatMinutes(minutes)}`;
}

/** "3,2 km" (uma casa decimal abaixo de 10 km). */
export function formatKm(value: number): string {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: value < 10 ? 1 : 0 })} km`;
}

/**
 * Tempo de carro estimado a partir da distância em linha reta: pelas ruas é ~1,3x, com trânsito de cidade
 * até 20 km e estrada depois (os mesmos fatores de map_distances na API).
 */
export function estimateDrive(straightKm: number): { roadKm: number; minutes: number } {
  const roadKm = straightKm * 1.3;
  const speed = roadKm <= 20 ? 25 : roadKm <= 100 ? 50 : 70;
  return { roadKm, minutes: Math.max(1, Math.round((roadKm / speed) * 60)) };
}

// Mesmos limites de geo.valid_coords na API: dentro do Brasil, sem 0,0 e sem o "centro do Brasil" (ponto padrão).
const BRAZIL = { latMin: -34, latMax: 6, lonMin: -74.5, lonMax: -28 };
const BRAZIL_CENTER = { lat: -14.235, lon: -51.9253, tolerance: 0.001 };

/** Coordenada que serve para o mapa (o ponto padrão de cadastro não vira pino). */
export function isValidCoords(latitude: number | null | undefined, longitude: number | null | undefined): boolean {
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  if (
    Math.abs(latitude - BRAZIL_CENTER.lat) < BRAZIL_CENTER.tolerance &&
    Math.abs(longitude - BRAZIL_CENTER.lon) < BRAZIL_CENTER.tolerance
  ) {
    return false;
  }
  return latitude >= BRAZIL.latMin && latitude <= BRAZIL.latMax && longitude >= BRAZIL.lonMin && longitude <= BRAZIL.lonMax;
}

/** Distância em linha reta (km), pela fórmula de haversine. */
export function kmBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Acima disso entre dois pontos seguidos é salto do GPS (rede/Wi-Fi), não deslocamento.
const MAX_TRAIL_KMH = 150;

/** Resumo do trajeto do dia: km percorridos (sem os saltos do GPS) e o primeiro e o último horário. */
export function trailSummary(
  points: { latitude: number; longitude: number; recorded_at: string }[],
): { km: number; start: string; end: string } | null {
  if (points.length === 0) return null;
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const step = kmBetween(points[i - 1], points[i]);
    const hours = (time(points[i].recorded_at) - time(points[i - 1].recorded_at)) / 3_600_000;
    if (hours > 0 && step / hours <= MAX_TRAIL_KMH) km += step;
  }
  return { km, start: points[0].recorded_at, end: points[points.length - 1].recorded_at };
}

/**
 * OS do dia no mapa: o rótulo do estado (o mesmo de Atividades do dia) e o tom do pino. A cor só aparece
 * em quem está em campo (marca) e no atraso (vermelho); o resto fica neutro.
 */
export const DAY_STATE: Record<ActivityState, { label: string; tone: "neutral" | "brand" | "danger" }> = {
  late: { label: "Atrasada", tone: "danger" },
  scheduled: { label: "Agendada", tone: "neutral" },
  en_route: { label: "Em deslocamento", tone: "brand" },
  in_progress: { label: "Em atendimento", tone: "brand" },
  on_hold: { label: "Pendente", tone: "neutral" },
  rescheduled: { label: "Reagendada", tone: "neutral" },
  done: { label: "Concluída", tone: "neutral" },
  pending: { label: "Na fila", tone: "neutral" },
};

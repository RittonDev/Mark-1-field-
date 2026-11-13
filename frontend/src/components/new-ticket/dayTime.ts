// Datas curtas para listas e prazos: "Hoje 14:00", "Amanhã 08:00", "qua 19/11 08:00".
// Sempre no fuso da operação (São Paulo), como os campos de data e hora e o resto da central: um
// analista em outro fuso vê a mesma hora que digitou.

import { dayKey, OPERATION_TZ } from "@/lib/format";

const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, weekday: "short" });
const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, day: "2-digit", month: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, hour: "2-digit", minute: "2-digit" });

const DAY_MS = 86_400_000;

/** Dias de calendário entre duas datas "2026-11-13" (pode ser negativo). */
function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS);
}

/** Dia em relação a hoje: "Hoje", "Amanhã", "Ontem" ou "qua 19/11" (com o ano quando não é o atual). */
export function dayLabel(iso: string, now: number, lower = false): string {
  const at = new Date(iso);
  const key = dayKey(at);
  const today = dayKey(now);
  if (!key || !today) return "—";
  const diff = daysBetween(today, key);
  const near = diff === 0 ? "Hoje" : diff === 1 ? "Amanhã" : diff === -1 ? "Ontem" : null;
  if (near) return lower ? near.toLowerCase() : near;
  const label = `${weekdayFmt.format(at).replace(".", "")} ${dayMonthFmt.format(at)}`;
  return key.slice(0, 4) === today.slice(0, 4) ? label : `${label}/${key.slice(2, 4)}`;
}

/** "Hoje 14:00", "Amanhã 08:00", "qua 19/11 08:00" (com `lower`, "hoje 14:00" para o meio da frase). */
export function dayTimeLabel(iso: string, now: number, lower = false): string {
  const label = dayLabel(iso, now, lower);
  return label === "—" ? label : `${label} ${timeFmt.format(new Date(iso))}`;
}

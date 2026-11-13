// Datas curtas para listas e prazos: "Hoje 14:00", "Amanhã 08:00", "qua 19/11 08:00".

const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
const dayMonthFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Dia em relação a hoje: "Hoje", "Amanhã", "Ontem" ou "qua 19/11" (com o ano quando não é o atual). */
export function dayLabel(iso: string, now: number, lower = false): string {
  const at = new Date(iso);
  const diff = Math.round((startOfDay(at.getTime()) - startOfDay(now)) / DAY_MS);
  const near = diff === 0 ? "Hoje" : diff === 1 ? "Amanhã" : diff === -1 ? "Ontem" : null;
  if (near) return lower ? near.toLowerCase() : near;
  const label = `${weekdayFmt.format(at).replace(".", "")} ${dayMonthFmt.format(at)}`;
  return at.getFullYear() === new Date(now).getFullYear() ? label : `${label}/${String(at.getFullYear()).slice(2)}`;
}

/** "Hoje 14:00", "Amanhã 08:00", "qua 19/11 08:00" (com `lower`, "hoje 14:00" para o meio da frase). */
export function dayTimeLabel(iso: string, now: number, lower = false): string {
  return `${dayLabel(iso, now, lower)} ${timeFmt.format(new Date(iso))}`;
}

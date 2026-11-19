// Adaptado de frontend/src/lib/format.ts (sem os helpers de <input type="datetime-local">).

const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const shortFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return dateTimeFmt.format(new Date(value));
}

export function formatShort(value: string | null | undefined): string {
  if (!value) return "—";
  return shortFmt.format(new Date(value));
}

export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return timeFmt.format(typeof value === "string" ? new Date(value) : value);
}

/** "qua., 12/11" */
export function formatDay(value: Date): string {
  return dayFmt.format(value);
}

/** "12/11" (dia e mês, sem depender da pontuação do Intl de cada aparelho). */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return dateFmt.format(typeof value === "string" ? new Date(value) : value);
}

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "sex 20/11": dia da semana e data, sem a pontuação do Intl ("sex., 20/11"), no fuso do aparelho. */
export function formatWeekdayDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${WEEKDAYS[date.getDay()]} ${formatDate(date)}`;
}

/** Mesmo dia do calendário (no fuso do aparelho). */
export function isSameDay(a: string | Date, b: string | Date): boolean {
  return startOfDay(new Date(a)).getTime() === startOfDay(new Date(b)).getTime();
}

/** "2h 15min", "3d 4h", "45min". */
export function formatMinutes(totalMinutes: number | null | undefined): string {
  if (totalMinutes === null || totalMinutes === undefined || Number.isNaN(totalMinutes)) return "—";
  const minutes = Math.round(Math.abs(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins ? `${hours}h ${mins}min` : `${hours}h`;
  return `${mins}min`;
}

/** "3 horas", "1 hora e 30 minutos", "45 minutos", "1 dia e 2 horas": formatMinutes por extenso, para o leitor de tela. */
export function formatMinutesLong(totalMinutes: number): string {
  const minutes = Math.round(Math.abs(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (days > 0) return hours ? `${count(days, "dia", "dias")} e ${count(hours, "hora", "horas")}` : count(days, "dia", "dias");
  if (hours > 0) return mins ? `${count(hours, "hora", "horas")} e ${count(mins, "minuto", "minutos")}` : count(hours, "hora", "horas");
  return count(mins, "minuto", "minutos");
}

const WEEKDAYS_LONG = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const MONTHS_LONG = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
const DAY_MS = 86_400_000;

/**
 * Data da visita por extenso, no fuso do aparelho (como o resto das datas da OS): "Hoje, 19 de novembro", "Amanhã, 20
 * de novembro", "Ontem, 18 de novembro", "Sexta-feira, 27 de novembro", "Terça-feira, 1º de dezembro" e, em outro ano,
 * "Sexta-feira, 1º de janeiro de 2027". `now`: agora pelo relógio do servidor, como o prazo da oferta.
 */
export function formatLongDate(value: string | Date, now: number = Date.now()): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const today = startOfDay(new Date(now));
  // Arredondado: o dia de 23 ou 25 h do horário de verão não muda a conta.
  const offset = Math.round((startOfDay(date).getTime() - today.getTime()) / DAY_MS);
  const weekday = WEEKDAYS_LONG[date.getDay()];
  const head = offset === 0 ? "Hoje" : offset === 1 ? "Amanhã" : offset === -1 ? "Ontem" : weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const day = date.getDate() === 1 ? "1º" : String(date.getDate());
  const year = date.getFullYear() === today.getFullYear() ? "" : ` de ${date.getFullYear()}`;
  return `${head}, ${day} de ${MONTHS_LONG[date.getMonth()]}${year}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** "09:00" no fuso do aparelho (sem o Intl: igual em qualquer aparelho). */
const clockTime = (date: Date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

/**
 * Hora da visita na oferta: só o início ("09:00") quando não há fim, o fim é em outro dia, não vem depois do início ou é
 * o início mais a duração estimada (±1 min, a duração já aparece ao lado); senão a janela, "09:00 às 18:00".
 */
export function visitTimeText(start: string, end: string | null | undefined, estimatedMinutes?: number | null): string {
  const from = new Date(start);
  const time = clockTime(from);
  if (!end) return time;
  const to = new Date(end);
  const minutes = (to.getTime() - from.getTime()) / 60_000;
  if (minutes <= 0 || !isSameDay(from, to)) return time;
  if (estimatedMinutes && estimatedMinutes > 0 && Math.abs(minutes - estimatedMinutes) <= 1) return time;
  return `${time} às ${clockTime(to)}`;
}

/** Tempo relativo até/desde uma data, ex.: "em 2h 10min" / "há 35min". */
export function formatRelative(value: string | null | undefined, now: number): string {
  if (!value) return "—";
  const diffMin = (new Date(value).getTime() - now) / 60000;
  const text = formatMinutes(diffMin);
  return diffMin >= 0 ? `em ${text}` : `há ${text}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** CPF (000.000.000-00) ou CNPJ, inclusive alfanumérico (00.000.000/0000-00). A API guarda sem pontuação. */
export function formatDocument(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length === 14) {
    return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`;
  }
  if (value.length === 11) {
    return `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}`;
  }
  return value;
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

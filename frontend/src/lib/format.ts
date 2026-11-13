/**
 * Fuso da operação (o mesmo de settings.TIMEZONE na API). Datas e horas aparecem e são digitadas sempre
 * no horário de São Paulo, como nas telas do dia, do mapa e da fila, mesmo num computador em outro fuso
 * (um analista em Manaus, uma máquina virtual em UTC).
 */
export const OPERATION_TZ = "America/Sao_Paulo";

const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: OPERATION_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: OPERATION_TZ,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const shortYearFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: OPERATION_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
// "2026-11-13": o dia no fuso da operação (en-CA já sai em ano-mês-dia).
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: OPERATION_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const inputFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATION_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const offsetFmt = new Intl.DateTimeFormat("en-US", { timeZone: OPERATION_TZ, timeZoneName: "longOffset" });

/** Data válida ou null: um valor malformado vira "—" em vez de derrubar a lista inteira. */
function toDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | null | undefined): string {
  const d = value ? toDate(value) : null;
  return d ? dateTimeFmt.format(d) : "—";
}

/** Data sem hora ("2026-11-19", ex.: validade) é dia do calendário: sai como está, sem passar por fuso
 *  (lida como meia-noite UTC, no Brasil viraria 21h do dia anterior e a tela mostraria 18/11). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return `${day[3]}/${day[2]}/${day[1]}`;
  const d = toDate(value);
  return d ? dateFmt.format(d) : "—";
}

/** "19/11, 14:05"; de outro ano, com o ano ("19/11/25, 14:05"): OS antigas não parecem recentes. */
export function formatShort(value: string | null | undefined): string {
  const d = value ? toDate(value) : null;
  if (!d) return "—";
  const sameYear = dayKeyFmt.format(d).slice(0, 4) === dayKeyFmt.format(new Date()).slice(0, 4);
  return (sameYear ? shortFmt : shortYearFmt).format(d);
}

/** Hoje no fuso da operação ("2026-11-13"). */
export function todayISO(): string {
  return dayKeyFmt.format(new Date());
}

/** Dia ("2026-11-13") de um horário no fuso da operação; vazio se a data for inválida. */
export function dayKey(value: string | number | Date): string {
  const d = toDate(value);
  return d ? dayKeyFmt.format(d) : "";
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

/** Tempo relativo até/desde uma data, ex.: "em 2h 10min" / "há 35min" / "agora". */
export function formatRelative(value: string | null | undefined, now: number): string {
  const d = value ? toDate(value) : null;
  if (!d) return "—";
  const diffMin = (d.getTime() - now) / 60000;
  if (Math.abs(diffMin) < 1) return "agora";
  const text = formatMinutes(diffMin);
  return diffMin >= 0 ? `em ${text}` : `há ${text}`;
}

const decimal1 = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** "820 B", "1,5 KB", "12,3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${decimal1(bytes / 1024)} KB`;
  return `${decimal1(bytes / (1024 * 1024))} MB`;
}

/** Deslocamento do fuso da operação naquele instante, em minutos (ex.: -180). */
function operationOffsetMinutes(at: Date): number {
  const name = offsetFmt.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = /([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!match) return 0; // "GMT" puro: UTC
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** Converte ISO (UTC) para o valor de <input type="datetime-local"> no horário da operação. */
export function toLocalInput(value: string | null | undefined): string {
  const d = value ? toDate(value) : null;
  if (!d) return "";
  const parts = inputFmt.formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Converte o valor de <input type="datetime-local"> (horário da operação) para ISO em UTC. */
export function fromLocalInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value ?? "");
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  // A hora digitada lida como UTC; depois desconta o fuso de São Paulo naquele instante (duas passadas
  // cobrem as datas antigas, do tempo do horário de verão).
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(wall)) return null;
  let utc = wall - operationOffsetMinutes(new Date(wall)) * 60_000;
  const offset = operationOffsetMinutes(new Date(utc));
  utc = wall - offset * 60_000;
  return new Date(utc).toISOString();
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
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

const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: OPERATION_TZ, hour: "2-digit", minute: "2-digit" });

/** Hora no fuso da operação, ex.: "14:05". */
export function formatTime(value: string | null | undefined): string {
  const d = value ? toDate(value) : null;
  return d ? timeFmt.format(d) : "—";
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatMoney(value: number | null | undefined): string {
  return BRL.format(value ?? 0);
}

/**
 * Valor digitado em número: "1.234,56", "120,5", "R$ 80", "1.500" (ponto de milhar, como se escreve no
 * Brasil) ou "120.50" (ponto decimal, com 1 ou 2 casas). Vazio = null; inválido ou negativo = NaN.
 */
export function parseMoney(text: string): number | null {
  const raw = text.trim().replace(/^R\$\s*/i, "").replace(/\s+/g, "");
  if (!raw) return null;
  let normalized = raw;
  if (raw.includes(",")) normalized = raw.replace(/\./g, "").replace(",", ".");
  else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g, "");
  return /^\d+(\.\d*)?$/.test(normalized) ? Number(normalized) : NaN;
}

/** Número para o campo de valor ("120,50"). */
export function moneyInput(value: number | null | undefined): string {
  return value == null ? "" : value.toFixed(2).replace(".", ",");
}

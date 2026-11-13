const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return dateTimeFmt.format(new Date(value));
}

/** Data sem hora ("2026-11-19", ex.: validade) é dia do calendário: lida como UTC, no Brasil
 *  (UTC-3) viraria 21h do dia anterior e a tela mostraria 18/11. */
function parseDate(value: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return dateFmt.format(parseDate(value));
}

export function formatShort(value: string | null | undefined): string {
  if (!value) return "—";
  return shortFmt.format(new Date(value));
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

/** Converte ISO (UTC) para o valor de <input type="datetime-local"> no fuso do navegador. */
export function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Converte o valor de <input type="datetime-local"> para ISO com fuso. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Hora local, ex.: "14:05". */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return timeFmt.format(new Date(value));
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatMoney(value: number | null | undefined): string {
  return BRL.format(value ?? 0);
}

/** Valor digitado ("1.234,56", "120,5", "R$ 80" ou "120.50") em número; vazio = null; inválido = NaN. */
export function parseMoney(text: string): number | null {
  const raw = text.trim().replace(/^R\$\s*/, "");
  if (!raw) return null;
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  return Number(normalized);
}

/** Número para o campo de valor ("120,50"). */
export function moneyInput(value: number | null | undefined): string {
  return value == null ? "" : value.toFixed(2).replace(".", ",");
}

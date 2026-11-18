import { dayKey, formatDateTime, formatMoney, formatTime } from "@/lib/format";
import { dayTimeLabel } from "./dayTime";

/**
 * Convite pelo WhatsApp para o técnico parceiro (ou para o grupo de técnicos), o bastante para ele
 * topar ou não: serviço, bairro e cidade, data e valor. Cliente, loja e endereço só depois que ele
 * estiver na OS (o técnico é terceiro).
 */
export function inviteText({
  name,
  service,
  district,
  city,
  state,
  startIso,
  fee,
}: {
  /** Sem nome: o convite vai para o grupo ("Quem pega?"). */
  name?: string | null;
  service: string;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  startIso?: string | null;
  fee?: number | null;
}): string {
  const first = name?.trim().split(/\s+/)[0];
  const town = [city, state].filter(Boolean).join(" - ");
  const place = [district, town].filter(Boolean).join(", ");
  return [
    first ? `Olá, ${first}! Temos um chamado da Maxx para você:` : "Pessoal, temos um chamado da Maxx:",
    `• ${service.trim() || "Atendimento técnico"}`,
    `• ${place || "local a confirmar"}`,
    `• ${startIso ? formatDateTime(startIso) : "data a combinar"}`,
    fee != null ? `• Valor: ${formatMoney(fee)}` : null,
    first ? "Topa? Responda aqui que eu te coloco na OS." : "Quem pega? Responda aqui.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** "Nome S." (primeiro nome e a inicial do último sobrenome): dois "João" no grupo não se confundem. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** "A", "A e B", "A, B e C". */
function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}` : (names[0] ?? "");
}

/**
 * Prazo da oferta no texto, no fuso da operação: só a hora quando vence no mesmo dia ("15:30"); senão
 * com o dia ("amanhã 02:00", "qua 19/11 08:00").
 */
export function offerDeadlineText(expiresAt: string, now: number): string {
  return dayKey(expiresAt) === dayKey(now) ? formatTime(expiresAt) : dayTimeLabel(expiresAt, now, true);
}

/**
 * Texto da oferta com preço para o grupo de técnicos no WhatsApp: a central manda a OS no app para os
 * técnicos escolhidos e avisa o grupo. A mesma regra do convite: serviço, bairro e cidade, data e valor;
 * cliente, loja e endereço só depois que o técnico aceitar. Sem contraproposta: quem aceitar primeiro
 * pelo app fica com a OS.
 */
export function offerText({
  code,
  service,
  district,
  city,
  state,
  startIso,
  amount,
  expiresAt,
  technicians = [],
  now,
}: {
  /** Nº da OS (o mesmo que o técnico vê na oferta, no app). */
  code?: string | null;
  service: string;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  startIso?: string | null;
  amount: number;
  /** Prazo para responder; sem ele, a oferta vale até alguém aceitar ou a central cancelar. */
  expiresAt?: string | null;
  /** Para quem a oferta foi no app (o grupo sabe quem pode aceitar). */
  technicians?: string[];
  /** Agora (ms): decide se o prazo sai só com a hora ou também com o dia. */
  now: number;
}): string {
  const town = [city, state].filter(Boolean).join(" - ");
  const place = [district, town].filter(Boolean).join(", ");
  const names = technicians.map(shortName).filter(Boolean);
  return [
    `Pessoal, temos um chamado da Maxx para aceitar no app${code ? ` (${code})` : ""}:`,
    `• ${service.trim() || "Atendimento técnico"}`,
    `• ${place || "local a confirmar"}`,
    `• ${startIso ? formatDateTime(startIso) : "data a combinar"}`,
    `• Valor: ${formatMoney(amount)}`,
    names.length ? `Enviado no app para ${joinNames(names)}.` : null,
    expiresAt
      ? `Aceite pelo app até ${offerDeadlineText(expiresAt, now)}. Quem aceitar primeiro fica com a OS.`
      : "Aceite pelo app (sem prazo). Quem aceitar primeiro fica com a OS.",
  ]
    .filter(Boolean)
    .join("\n");
}

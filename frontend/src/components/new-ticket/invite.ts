import { formatDateTime, formatMoney } from "@/lib/format";

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

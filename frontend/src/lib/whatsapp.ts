// Compartilhar pelo WhatsApp e copiar texto: a central fala com os técnicos parceiros e com os
// clientes pelo WhatsApp (nunca pelo app).

import { api } from "./api";

/**
 * Acima disso o link do WhatsApp pode cortar ou não abrir (o texto vai inteiro no endereço): melhor
 * copiar o texto e colar na conversa.
 */
export const WHATSAPP_TEXT_LIMIT = 1800;

/** Texto pronto da OS para o grupo do WhatsApp: um modelo de /textos já preenchido pela API. */
export interface GroupText {
  key: string;
  name: string;
  text: string;
  /** O texto do momento da OS (no máximo um): atividade confirmada, técnico a caminho, encerrada... */
  suggested: boolean;
}

/** Aviso depois de copiar um texto pronto (no menu da OS, no botão de copiar e no aviso em tempo real). */
export const GROUP_TEXT_COPIED = "Texto copiado. Cole no grupo do WhatsApp.";

/**
 * Texto lido há mais que isso é buscado de novo antes de copiar: hora, previsão de chegada e situação
 * da OS mudam.
 */
export const GROUP_TEXT_FRESH_MS = 60_000;

/**
 * Textos prontos da OS. A chave fica sob ["ticket", id]: o que muda a OS (salvar, mudar a situação,
 * evento em tempo real) relê os textos junto.
 */
export function groupTextsQuery(ticketId: string) {
  return {
    queryKey: ["ticket", ticketId, "messages"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.get<GroupText[]>(`/tickets/${ticketId}/messages`, undefined, { signal }),
  };
}

/** O sugerido primeiro (só ele marcado); os outros na ordem dos modelos. */
export function suggestedFirst(list: GroupText[]): GroupText[] {
  const pick = list.find((m) => m.suggested);
  if (!pick) return list;
  return [pick, ...list.filter((m) => m !== pick).map((m) => (m.suggested ? { ...m, suggested: false } : m))];
}

/** Abre a conversa com o número (DDD + número; o 55 entra quando falta) já com o texto. */
export function whatsappUrl(phone: string | null | undefined, text: string): string {
  // O 0 do DDD antigo ("011 99999-8888") não existe no número internacional.
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const number = !digits ? "" : digits.startsWith("55") && digits.length > 11 ? digits : `55${digits}`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/**
 * WhatsApp sem número, para o grupo (a pessoa escolhe a conversa). O texto longo demais para ir no
 * endereço (WHATSAPP_TEXT_LIMIT) abre a conversa vazia: copie e cole.
 */
export function groupShareUrl(text: string): string {
  return whatsappUrl(null, text.length <= WHATSAPP_TEXT_LIMIT ? text : "");
}

/**
 * Copia o texto para a área de transferência. Em http na rede do escritório (ex.:
 * http://servidor:3001) o navegador não libera a área de transferência moderna: aí vale o "copiar"
 * antigo, por um campo escondido. Devolve false quando nada foi copiado (avise a pessoa).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permissão negada ou página sem foco: tenta o caminho antigo abaixo.
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.inset = "0 auto auto 0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  focused?.focus({ preventScroll: true });
  return copied;
}

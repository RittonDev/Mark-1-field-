// Compartilhar pelo WhatsApp e copiar texto: a central fala com os técnicos parceiros e com os
// clientes pelo WhatsApp (nunca pelo app).

/**
 * Acima disso o link do WhatsApp pode cortar ou não abrir (o texto vai inteiro no endereço): melhor
 * copiar o texto e colar na conversa.
 */
export const WHATSAPP_TEXT_LIMIT = 1800;

/** Abre a conversa com o número (DDD + número; o 55 entra quando falta) já com o texto. */
export function whatsappUrl(phone: string | null | undefined, text: string): string {
  // O 0 do DDD antigo ("011 99999-8888") não existe no número internacional.
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const number = !digits ? "" : digits.startsWith("55") && digits.length > 11 ? digits : `55${digits}`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
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

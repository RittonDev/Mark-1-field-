// Links do WhatsApp: a central fala com os técnicos parceiros pelo WhatsApp (nunca pelo app).

/** Abre a conversa com o número (DDD + número; o 55 entra quando falta) já com o texto. */
export function whatsappUrl(phone: string | null | undefined, text: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  const number = !digits ? "" : digits.startsWith("55") && digits.length > 11 ? digits : `55${digits}`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

"use client";

// Chave PIX do técnico na central. Só ele cadastra e troca (app, Conta › Meu cadastro, com a senha); a
// central vê em Pagamentos e no cadastro em Técnicos, copia para pagar e só remove. Os formatos são os de
// backend/app/core/pix.py (PIX_KEY_TYPE e formatPixKey em constants.ts).

import { useToast } from "@/components/Toaster";
import { formatPixKey, PIX_KEY_TYPE, PIX_RECENT_DAYS } from "./constants";
import { OPERATION_TZ } from "./format";
import type { PixInfo } from "./types";
import { copyText } from "./whatsapp";

const DAY_MS = 86_400_000;
const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ });

/** Cor do selo "Chave nova" (âmbar, a mesma de "Em risco"). */
export const PIX_NEW_COLOR = "#d97706";

/** Tipo e chave para conferir com o que o banco mostra: "CPF 123.456.789-09". */
export function pixText(pix: Pick<PixInfo, "key_type" | "key">): string {
  return `${PIX_KEY_TYPE[pix.key_type] ?? pix.key_type} ${formatPixKey(pix.key_type, pix.key)}`;
}

/** A chave mudou há menos de PIX_RECENT_DAYS dias: "Chave nova", confirmar com ele no grupo antes de pagar. */
export function pixRecent(updatedAt: string | null | undefined, now: number): boolean {
  const at = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(at) && now - at < PIX_RECENT_DAYS * DAY_MS;
}

/** Dia da troca da chave ("18/11"), no fuso da operação. */
export function pixDay(updatedAt: string | null | undefined): string {
  const at = updatedAt ? new Date(updatedAt) : null;
  return at && !Number.isNaN(at.getTime()) ? dayFmt.format(at) : "";
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    // Sem acento: o NFD separa a letra da marca, e as marcas (Unicode M) saem.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

/** O titular da conta não é o próprio técnico (acento, maiúsculas e espaços não contam). */
export function holderDiffers(pix: Pick<PixInfo, "holder_name">, name: string): boolean {
  return !!pix.holder_name && plain(pix.holder_name) !== plain(name);
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Mensagem do "Pedir a chave" (conversa do técnico no WhatsApp). */
export function askPixText(name: string): string {
  return `Olá, ${firstName(name)}! Cadastre sua chave PIX no app Maxx Field, em Conta › Meu cadastro, para receber pelos chamados.`;
}

/**
 * Copia a chave crua, como o app do banco pede, e avisa com o tipo, a chave formatada e o titular, para
 * conferir com o nome que o banco mostra antes de confirmar o pagamento.
 */
export function useCopyPix() {
  const { toast } = useToast();
  return async (name: string, pix: PixInfo): Promise<boolean> => {
    const shown = pixText(pix);
    const copied = await copyText(pix.key);
    toast(
      copied
        ? {
            title: `Chave PIX de ${name} copiada`,
            description: pix.holder_name ? `${shown} · titular ${pix.holder_name}` : shown,
            tone: "success",
          }
        : { title: "Não foi possível copiar a chave PIX", description: `${shown}: copie à mão.`, tone: "error" },
    );
    return copied;
  };
}

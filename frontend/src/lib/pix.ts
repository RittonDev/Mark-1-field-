"use client";

// Chave PIX do técnico na central. Só ele cadastra e troca (app, Perfil › Configurações › Chave PIX, com a
// senha); a central vê em Pagamentos e no cadastro em Técnicos, copia para pagar e só remove. Os formatos são os
// de backend/app/core/pix.py (PIX_KEY_TYPE e formatPixKey em constants.ts; a máscara, maskPixKey, aqui).

import { useToast } from "@/components/Toaster";
import { formatPixKey, PIX_KEY_TYPE, PIX_RECENT_DAYS } from "./constants";
import { OPERATION_TZ } from "./format";
import type { PixInfo, PixKeyType } from "./types";
import { copyText } from "./whatsapp";

const DAY_MS = 86_400_000;
const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ });

/** Cor do selo "Chave nova" (âmbar, a mesma de "Em risco"). */
export const PIX_NEW_COLOR = "#d97706";

/** Tipo e chave para conferir com o que o banco mostra: "CPF 123.456.789-09". */
export function pixText(pix: Pick<PixInfo, "key_type" | "key">): string {
  return `${PIX_KEY_TYPE[pix.key_type] ?? pix.key_type} ${formatPixKey(pix.key_type, pix.key)}`;
}

/** Os caracteres da ponta, contados como no Python (um emoji é um só). */
const head = (text: string, n: number) => Array.from(text).slice(0, n).join("");
const tail = (text: string, n: number) => Array.from(text).slice(-n).join("");

/**
 * Só o bastante para reconhecer a chave, igual a core/pix.mask (o histórico e o registro do pagamento): CPF
 * "***.456.789-**", CNPJ "12.345.678/****-**", e-mail "t***@exemplo.com", celular "+55 (11) *****-7777" e o resto
 * "…4000".
 */
export function maskPixKey(type: PixKeyType, key: string): string {
  if (type === "cpf" && key.length === 11) return `***.${key.slice(3, 6)}.${key.slice(6, 9)}-**`;
  if (type === "cnpj" && key.length === 14) return `${key.slice(0, 2)}.${key.slice(2, 5)}.${key.slice(5, 8)}/****-**`;
  if (type === "email" && key.includes("@")) {
    const at = key.indexOf("@");
    return `${head(key.slice(0, at), 1)}***@${key.slice(at + 1)}`;
  }
  if (type === "phone") {
    let digits = key.replace(/\D/g, "");
    if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
    if (digits.length === 11) return `+55 (${digits.slice(0, 2)}) *****-${digits.slice(7)}`;
  }
  return `…${tail(key, 4)}`;
}

/**
 * Tipo e chave no extrato do WhatsApp, que passa pelo endereço do wa.me e pela área de transferência: CPF e CNPJ
 * mascarados ("CPF ***.456.789-**"); e-mail, celular e chave aleatória inteiros, para o técnico ver onde vai
 * receber (com máscara, uma chave parecida passaria). O "Copiar PIX" continua com a chave crua.
 */
export function pixStatementText(pix: Pick<PixInfo, "key_type" | "key">): string {
  const shown = pix.key_type === "cpf" || pix.key_type === "cnpj" ? maskPixKey(pix.key_type, pix.key) : formatPixKey(pix.key_type, pix.key);
  return `${PIX_KEY_TYPE[pix.key_type] ?? pix.key_type} ${shown}`;
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
  return `Olá, ${firstName(name)}! Cadastre sua chave PIX no app Maxx Field, em Perfil › Configurações › Chave PIX, para receber pelos chamados.`;
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

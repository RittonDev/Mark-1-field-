"use client";

// Formas de recebimento do técnico na central (chaves PIX e contas, uma preferencial). Só ele cadastra e troca (app,
// Perfil › Configurações › Formas de recebimento, com a senha); a central vê com Pagamentos (em Pagamentos e na ficha do
// técnico), copia para pagar e só remove. O texto mascarado (payoutMethodText), a conta inteira (bankAccountText) e os
// formatos da chave (formatPixKey, maskPixKey) ficam em constants.ts, iguais no app.

import { useToast } from "@/components/Toaster";
import { bankAccountText, formatPixKey, PAYOUT_RECENT_DAYS, payoutMethodText, PIX_KEY_TYPE } from "./constants";
import { formatDocument, OPERATION_TZ } from "./format";
import type { PayoutMethod, PixInfo } from "./types";
import { copyText } from "./whatsapp";

const DAY_MS = 86_400_000;
const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: OPERATION_TZ });

/** Cor dos selos "Nova" e "Titular diferente" (âmbar, a mesma de "Em risco"). */
export const PAYOUT_NEW_COLOR = "#d97706";

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Mensagem do "Pedir no WhatsApp" (conversa do técnico): onde ele cadastra a forma de recebimento. */
export function askPayoutText(name: string): string {
  return `Olá, ${firstName(name)}! Cadastre onde quer receber no app Maxx Field, em Perfil › Configurações › Formas de recebimento, para receber pelos chamados.`;
}

/** CPF ou CNPJ do titular com o nome do documento: "CPF 123.456.789-09" | "CNPJ 12.345.678/0001-95". */
export function holderDocumentText(doc: string | null | undefined): string {
  if (!doc) return "";
  if (doc.length === 11) return `CPF ${formatDocument(doc)}`;
  if (doc.length === 14) return `CNPJ ${formatDocument(doc)}`;
  return doc;
}

/** Para quem paga, com tudo à vista: PIX "PIX CPF · 123.456.789-09"; conta, bankAccountText. */
export function payoutDestinationText(method: PayoutMethod): string {
  return method.kind === "pix"
    ? `PIX ${PIX_KEY_TYPE[method.pix_key_type] ?? method.pix_key_type} · ${formatPixKey(method.pix_key_type, method.pix_key)}`
    : bankAccountText(method);
}

/**
 * O que o "Copiar" leva para pagar: PIX, a chave crua (como o app do banco pede); conta, bankAccountText com o titular
 * ("Banco Exemplo (999) · Ag. 0001 · Conta 12345-6 · Conta corrente · Titular: Tecnico Alfa · CPF 123.456.789-09").
 */
export function payoutCopyText(method: PayoutMethod): string {
  if (method.kind === "pix") return method.pix_key;
  const holderDoc = holderDocumentText(method.holder_document);
  return `${bankAccountText(method)} · Titular: ${method.holder_name}${holderDoc ? ` · ${holderDoc}` : ""}`;
}

/**
 * A linha do extrato do WhatsApp: a preferencial mascarada (payoutMethodText, com "•": o "*" vira negrito no WhatsApp),
 * ou o pedido para cadastrar no app quando ele não tem nenhuma.
 */
export function payoutStatementText(method: PayoutMethod | null): string {
  return method
    ? `Forma de recebimento: ${payoutMethodText(method)}`
    : "Forma de recebimento: não cadastrada (cadastre no app, em Perfil › Configurações › Formas de recebimento)";
}

/** O destino do pagamento mudou há menos de PAYOUT_RECENT_DAYS dias (`destination_changed_at`): "Nova". */
export function payoutRecent(changedAt: string | null | undefined, now: number): boolean {
  const at = changedAt ? Date.parse(changedAt) : Number.NaN;
  return Number.isFinite(at) && now - at < PAYOUT_RECENT_DAYS * DAY_MS;
}

/** Dia da troca ("18/11"), no fuso da operação. */
export function payoutDay(changedAt: string | null | undefined): string {
  const at = changedAt ? new Date(changedAt) : null;
  return at && !Number.isNaN(at.getTime()) ? dayFmt.format(at) : "";
}

/**
 * Copia o que vai para o banco (payoutCopyText) e avisa com o destino e o titular, para conferir com o nome que o banco
 * mostra antes de confirmar o pagamento.
 */
export function useCopyPayout() {
  const { toast } = useToast();
  return async (name: string, method: PayoutMethod): Promise<boolean> => {
    const shown = payoutDestinationText(method);
    const copied = await copyText(payoutCopyText(method));
    const pix = method.kind === "pix";
    toast(
      copied
        ? {
            title: pix ? `Chave PIX de ${name} copiada` : `Dados da conta de ${name} copiados`,
            description: `${shown} · titular ${method.holder_name}`,
            tone: "success",
          }
        : {
            title: pix ? "Não foi possível copiar a chave PIX" : "Não foi possível copiar os dados da conta",
            description: `${shown}: copie à mão.`,
            tone: "error",
          },
    );
    return copied;
  };
}

// --------------------------------------------------------------------------- chave PIX única (V1 apaga)

/** @deprecated Sai no fechamento da Entrega 1 (V1): use PAYOUT_NEW_COLOR. Só o TechnicianPayment.tsx (o W1 apaga) usa. */
export const PIX_NEW_COLOR = PAYOUT_NEW_COLOR;

/** @deprecated Sai no fechamento da Entrega 1 (V1): use askPayoutText. Só o TechnicianPayment.tsx (o W1 apaga) usa. */
export function askPixText(name: string): string {
  return askPayoutText(name);
}

/** @deprecated Sai no fechamento da Entrega 1 (V1): use payoutRecent. Só o TechnicianPayment.tsx (o W1 apaga) usa. */
export function pixRecent(updatedAt: string | null | undefined, now: number): boolean {
  return payoutRecent(updatedAt, now);
}

/** @deprecated Sai no fechamento da Entrega 1 (V1): use useCopyPayout. Só o TechnicianPayment.tsx (o W1 apaga) usa. */
export function useCopyPix() {
  const { toast } = useToast();
  return async (name: string, pix: PixInfo): Promise<boolean> => {
    const shown = `${PIX_KEY_TYPE[pix.key_type] ?? pix.key_type} ${formatPixKey(pix.key_type, pix.key)}`;
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

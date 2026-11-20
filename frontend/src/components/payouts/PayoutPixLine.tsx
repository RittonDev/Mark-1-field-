"use client";

import { Copy, MessageCircle } from "lucide-react";
import { Pill } from "@/components/ui";
import { formatPixKey, PIX_KEY_TYPE } from "@/lib/constants";
import { askPixText, holderDiffers, PIX_NEW_COLOR, pixDay, pixRecent, useCopyPix } from "@/lib/pix";
import type { PixInfo } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

/**
 * Para onde pagar, embaixo do nome do técnico em Pagamentos: a chave PIX, com "Copiar PIX" e o selo "Chave
 * nova" (mudou há menos de PIX_RECENT_DAYS dias), ou "Sem chave PIX" com o pedido pelo WhatsApp. Só o técnico
 * cadastra a chave (app, Perfil › Configurações › Chave PIX); o titular aparece quando não é ele.
 */
export function PayoutPixLine({ name, pix, phone, now }: { name: string; pix: PixInfo | null; phone: string | null; now: number }) {
  const copyPix = useCopyPix();
  if (!pix) {
    return (
      <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-muted">
        <span className="font-medium text-amber-800 dark:text-amber-300">Sem chave PIX</span>
        {phone ? (
          <a
            href={whatsappUrl(phone, askPixText(name))}
            target="_blank"
            rel="noreferrer"
            title={`Pedir a chave PIX a ${name} no WhatsApp`}
            className="inline-flex items-center gap-1 rounded font-medium text-ink underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
          >
            <MessageCircle className="size-3.5 text-ink-muted" />
            Pedir a chave
          </a>
        ) : null}
      </p>
    );
  }
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-muted">
      <span className="min-w-0 break-words">
        PIX {PIX_KEY_TYPE[pix.key_type] ?? pix.key_type} ·{" "}
        <span className="font-medium text-ink tabular-nums">{formatPixKey(pix.key_type, pix.key)}</span>
        {holderDiffers(pix, name) ? ` · titular ${pix.holder_name}` : ""}
      </span>
      {pixRecent(pix.updated_at, now) ? (
        <span title={`Alterada em ${pixDay(pix.updated_at)} pelo técnico. Confirme com ele no grupo antes de pagar.`}>
          <Pill color={PIX_NEW_COLOR}>Chave nova</Pill>
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void copyPix(name, pix)}
        aria-label={`Copiar PIX de ${name}`}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface px-2 font-medium text-ink shadow-elev-1 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
      >
        <Copy className="size-3.5" />
        Copiar PIX
      </button>
    </p>
  );
}

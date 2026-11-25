"use client";

import { Copy, MessageCircle } from "lucide-react";
import { TechnicianLink } from "@/components/technicians/TechnicianLink";
import { Pill } from "@/components/ui";
import { bankAccountText, formatPixKey, PIX_KEY_TYPE } from "@/lib/constants";
import { useCan } from "@/lib/permissions";
import { askPayoutText, holderDocumentText, PAYOUT_NEW_COLOR, payoutDay, payoutRecent, useCopyPayout } from "@/lib/pix";
import type { PayoutMethodSummary, UUID } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";

const linkClass =
  "inline-flex items-center gap-1 rounded font-medium text-ink underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none";

/**
 * Para onde pagar, embaixo do nome do técnico em Pagamentos: a forma de recebimento preferencial (PIX ou conta), com
 * "Copiar PIX" ou "Copiar dados", o selo "Nova" (o destino mudou há menos de PAYOUT_RECENT_DAYS dias) e o link para as
 * outras formas dele na ficha; sem nenhuma, "Sem forma de recebimento" com o pedido pelo WhatsApp. Só o técnico
 * cadastra (app, Perfil › Configurações › Formas de recebimento); o titular aparece quando não é ele nem a empresa dele.
 */
export function PayoutMethodLine({
  name,
  technicianId,
  summary,
  phone,
  now,
}: {
  name: string;
  technicianId: UUID;
  /** A preferencial e quantas ele tem; null: nenhuma cadastrada. */
  summary: PayoutMethodSummary | null;
  phone: string | null;
  now: number;
}) {
  const copy = useCopyPayout();
  // A ficha do técnico é da tela Técnicos: sem ela, o "+1 outra" fica só como texto.
  const canTechnicians = useCan("base.technicians");
  if (!summary) {
    return (
      <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-muted">
        <span className="font-medium text-amber-800 dark:text-amber-300">Sem forma de recebimento</span>
        {phone ? (
          <a
            href={whatsappUrl(phone, askPayoutText(name))}
            target="_blank"
            rel="noopener noreferrer"
            title={`Pedir a ${name} no WhatsApp que cadastre onde quer receber`}
            className={linkClass}
          >
            <MessageCircle className="size-3.5 text-ink-muted" />
            Pedir no WhatsApp
          </a>
        ) : null}
      </p>
    );
  }
  const method = summary.preferred;
  const others = summary.total - 1;
  const othersText = others === 1 ? "+1 outra" : `+${others} outras`;
  const holder = [method.holder_name, holderDocumentText(method.holder_document)].filter(Boolean).join(" · ");
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-muted">
      <span className="min-w-0 break-words">
        {method.kind === "pix" ? (
          <>
            PIX {PIX_KEY_TYPE[method.pix_key_type] ?? method.pix_key_type} ·{" "}
            <span className="font-medium text-ink tabular-nums">{formatPixKey(method.pix_key_type, method.pix_key)}</span>
          </>
        ) : (
          <span className="font-medium text-ink tabular-nums">{bankAccountText(method)}</span>
        )}
        {method.holder_differs ? (
          <span className="font-medium text-amber-800 dark:text-amber-300" title={`Titular diferente: ${holder}`}>
            {" "}
            · titular {method.holder_name}
          </span>
        ) : null}
      </span>
      {payoutRecent(method.destination_changed_at, now) ? (
        <span title={`Mudou em ${payoutDay(method.destination_changed_at)} pelo técnico. Confirme com ele no grupo antes de pagar.`}>
          <Pill color={PAYOUT_NEW_COLOR}>Nova</Pill>
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void copy(name, method)}
        aria-label={method.kind === "pix" ? `Copiar PIX de ${name}` : `Copiar os dados da conta de ${name}`}
        className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface px-2 font-medium text-ink shadow-elev-1 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
      >
        <Copy className="size-3.5" />
        {method.kind === "pix" ? "Copiar PIX" : "Copiar dados"}
      </button>
      {others > 0 ? (
        canTechnicians ? (
          // Em outra aba: o fechamento (filtros e seleção) continua aqui.
          <TechnicianLink
            id={technicianId}
            section="recebimento"
            target="_blank"
            title={`Ver as formas de recebimento de ${name}`}
            className={linkClass}
          >
            {othersText}
          </TechnicianLink>
        ) : (
          <span title="As outras formas ficam na ficha do técnico, em Técnicos">{othersText}</span>
        )
      ) : null}
    </p>
  );
}

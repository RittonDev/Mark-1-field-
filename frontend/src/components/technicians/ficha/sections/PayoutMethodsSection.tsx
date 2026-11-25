"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, MessageCircle, Trash2, Wallet } from "lucide-react";
import Link from "next/link";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, ErrorBox, Pill, Skeleton } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, apiErrorCode } from "@/lib/api";
import { bankAccountText, formatPixKey, PAYOUT_KIND, PAYOUT_RECENT_DAYS, PIX_KEY_TYPE } from "@/lib/constants";
import { formatDate, formatDocument, formatMoney } from "@/lib/format";
import { useCan } from "@/lib/permissions";
import { askPayoutText, payoutCopyText } from "@/lib/pix";
import type { PayoutBoard, PayoutMethodAdmin, Technician, UUID } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";
import { refreshTechnicianViews } from "../../refresh";
import { useCopy } from "../../useCopy";
import { fichaLabel } from "../FichaNav";
import { apiErrorText, SectionCard } from "../SectionCard";

const DAY_MS = 86_400_000;
/** "Nova" e "Titular diferente": âmbar (pede conferir com ele antes de pagar). */
const AMBER = "#d97706";

/** A chave formatada ("123.456.789-09") ou a conta inteira, para quem paga. */
function destinationText(m: PayoutMethodAdmin): string {
  return m.kind === "pix" ? formatPixKey(m.pix_key_type, m.pix_key) : bankAccountText(m);
}

/** "Chave PIX · CPF" | "Conta bancária". */
function kindText(m: PayoutMethodAdmin): string {
  return m.kind === "pix" ? `${PAYOUT_KIND.pix} · ${PIX_KEY_TYPE[m.pix_key_type] ?? m.pix_key_type}` : PAYOUT_KIND.bank;
}

/**
 * Formas de recebimento (só com Pagamentos; remover com Pagamentos em Editar). Quem cadastra e troca é o técnico, no
 * app, com a senha: a central vê, copia para pagar e remove. "Nova": o destino do pagamento mudou há menos de
 * PAYOUT_RECENT_DAYS dias (confirmar com ele no grupo antes de pagar).
 */
export function PayoutMethodsSection({ tech }: { tech: Technician }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const copy = useCopy();
  const canRemove = useCan("commercial.payouts", "edit");
  const now = useNow(60_000);
  const methods = useQuery({
    queryKey: ["technicians", "payout-methods", tech.id],
    queryFn: ({ signal }) => api.get<PayoutMethodAdmin[]>(`/technicians/${tech.id}/payout-methods`, undefined, { signal }),
    staleTime: 30_000,
  });
  // O resumo do que ele tem a receber (a mesma busca de Pagamentos, só deste técnico).
  const board = useQuery({
    queryKey: ["payouts", "technician", tech.id, "resumo"],
    queryFn: ({ signal }) => api.get<PayoutBoard>("/payouts", { technician_id: tech.id }, { signal }),
    staleTime: 60_000,
  });
  const remove = useMutation({
    mutationFn: (methodId: UUID) => api.delete<void>(`/technicians/${tech.id}/payout-methods/${methodId}`),
    onSuccess: () => toast({ title: "Forma de recebimento removida", tone: "success" }),
    onError: (error) =>
      // Já removida (outra tela, o próprio técnico): o aviso da API, e a lista relê.
      toast(
        apiErrorCode(error) === "PAYOUT_METHOD_NOT_FOUND"
          ? { title: apiErrorText(error), tone: "error" }
          : { title: "A forma de recebimento continua no cadastro", description: apiErrorText(error), tone: "error" },
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["payouts"] });
      refreshTechnicianViews(queryClient);
    },
  });

  const list = methods.data ?? [];
  const askRemove = async (m: PayoutMethodAdmin) => {
    const ok = await confirm({
      tone: "danger",
      title: `Remover esta forma de recebimento de ${tech.name}?`,
      description: `Ele cadastra outra no app, em Configurações › Formas de recebimento.${
        m.preferred && list.length > 1 ? " A mais recente passa a ser a preferencial." : ""
      }`,
      confirmLabel: "Remover",
    });
    if (ok) remove.mutate(m.id);
  };
  const copyMethod = (m: PayoutMethodAdmin) =>
    void copy(payoutCopyText(m), {
      title: m.kind === "pix" ? `Chave PIX de ${tech.name} copiada` : `Dados da conta de ${tech.name} copiados`,
      description: `${m.kind === "pix" ? `${PIX_KEY_TYPE[m.pix_key_type]} ` : ""}${destinationText(m)} · titular ${m.holder_name}`,
    });

  const summary = board.data?.summary;
  return (
    <SectionCard title={fichaLabel("recebimento")}>
      {methods.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : methods.error ? (
        <ErrorBox message={apiErrorText(methods.error)} onRetry={() => void methods.refetch()} />
      ) : !list.length ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
          Nenhuma forma de recebimento.
          <a
            href={whatsappUrl(tech.phone, askPayoutText(tech.name))}
            target="_blank"
            rel="noopener noreferrer"
            title={tech.phone ? `Pedir a ${tech.name} no WhatsApp` : "Sem celular no cadastro: escolha a conversa dele no WhatsApp"}
            className="inline-flex items-center gap-1 rounded font-medium text-ink underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
          >
            <MessageCircle className="size-3.5 text-ink-muted" />
            Pedir no WhatsApp
          </a>
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-busy={remove.isPending || undefined}>
          {list.map((m) => {
            const fresh = now - Date.parse(m.destination_changed_at) < PAYOUT_RECENT_DAYS * DAY_MS;
            const holder = [m.holder_name, m.holder_document ? formatDocument(m.holder_document) : null].filter(Boolean).join(" · ");
            return (
              <li key={m.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                    {kindText(m)}
                    {m.preferred ? <Pill color="var(--brand)">Preferencial</Pill> : null}
                    {fresh ? <Pill color={AMBER}>Nova</Pill> : null}
                    {m.holder_differs ? (
                      <span title={`Titular: ${holder}`} className="inline-flex">
                        <Pill color={AMBER}>Titular diferente</Pill>
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-sm break-words text-ink tabular-nums">{destinationText(m)}</p>
                  <p className="mt-0.5 text-xs break-words text-ink-muted">
                    Titular: {holder} · alterada em {formatDate(m.changed_at)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" onClick={() => copyMethod(m)}>
                    <Copy className="size-3.5" />
                    Copiar
                  </Button>
                  {canRemove ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => void askRemove(m)}
                      className="text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                    >
                      <Trash2 className="size-3.5" />
                      Remover
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {summary && board.data?.items.length ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <p className="text-xs text-ink-muted tabular-nums">
            A pagar <strong className="font-semibold text-ink">{formatMoney(summary.to_pay)}</strong> · Previsto{" "}
            {formatMoney(summary.expected)} · Pago {formatMoney(summary.paid)}
          </p>
          <Link href="/pagamentos" className={buttonClassName("ghost", "sm")}>
            <Wallet className="size-3.5" />
            Ver em Pagamentos
          </Link>
        </div>
      ) : null}
    </SectionCard>
  );
}

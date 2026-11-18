"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Copy, MessageCircle, Trash2, Wallet } from "lucide-react";
import Link from "next/link";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, ErrorBox, Pill, SectionTitle, Skeleton } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { api, errorMessage } from "@/lib/api";
import { formatPixKey, PIX_KEY_TYPE } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { useCan } from "@/lib/permissions";
import { askPixText, PIX_NEW_COLOR, pixRecent, useCopyPix } from "@/lib/pix";
import type { PayoutBoard, Technician } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";
import { refreshTechnicianViews } from "./refresh";

/**
 * "Pagamento" no cadastro do técnico (só para quem tem Pagamentos): a chave PIX e o resumo do que ele tem a
 * receber. Só o técnico cadastra e troca a chave (app, com a senha): aqui a central copia para pagar e, com
 * Pagamentos em Editar, remove. Fica fora do fieldset travado do cadastro: quem só vê Técnicos ainda copia.
 * `dirty`: o cadastro tem alteração não salva (o link para Pagamentos abre em outra aba).
 */
export function TechnicianPayment({ tech, dirty }: { tech: Pick<Technician, "id" | "name" | "phone">; dirty: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const copyPix = useCopyPix();
  const canEdit = useCan("commercial.payouts", "edit");
  const now = useNow(60_000);
  const board = useQuery({
    queryKey: ["payouts", "technician", tech.id],
    queryFn: ({ signal }) => api.get<PayoutBoard>("/payouts", { technician_id: tech.id, with_pix: true }, { signal }),
    staleTime: 60_000,
  });
  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/technicians/${tech.id}/pix`),
    onSuccess: () => toast({ title: `Chave PIX de ${tech.name} removida`, tone: "success" }),
    onError: (error) => toast({ title: "A chave PIX continua no cadastro", description: errorMessage(error), tone: "error" }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["payouts"] });
      refreshTechnicianViews(queryClient);
    },
  });

  const confirmRemove = async () => {
    const ok = await confirm({
      tone: "danger",
      title: `Remover a chave PIX de ${tech.name}?`,
      description: "Ele precisa cadastrar uma chave nova no app (Conta › Meu cadastro) para receber.",
      confirmLabel: "Remover chave",
    });
    if (ok) remove.mutate();
  };

  // Sem o mapa `pix` (API sem a chave PIX), fica só o resumo, como antes: "Sem chave PIX" seria engano.
  const pixKnown = board.data?.pix !== undefined;
  const pix = board.data?.pix?.[tech.id] ?? null;
  const summary = board.data?.summary;
  if (board.data && !pixKnown && !board.data.items.length) return null;
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-line p-3">
      <SectionTitle>Pagamento</SectionTitle>
      {board.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : board.error ? (
        <ErrorBox message={errorMessage(board.error)} onRetry={() => void board.refetch()} />
      ) : (
        <>
          {!pixKnown ? null : pix ? (
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm break-words text-ink">
                  <span className="font-semibold">PIX</span> · {PIX_KEY_TYPE[pix.key_type] ?? pix.key_type} ·{" "}
                  <span className="font-medium tabular-nums">{formatPixKey(pix.key_type, pix.key)}</span>
                </p>
                <p className="mt-0.5 text-xs break-words text-ink-muted">
                  Titular: {pix.holder_name ?? "não informado"}
                  {pix.updated_at ? ` · alterada em ${formatDate(pix.updated_at)}` : ""}
                </p>
                {pixRecent(pix.updated_at, now) ? (
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs font-medium text-amber-800 dark:text-amber-300">
                    <Pill color={PIX_NEW_COLOR}>Chave nova</Pill>
                    confirme com ele no grupo antes de pagar
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" onClick={() => void copyPix(tech.name, pix)}>
                  <Copy className="size-3.5" />
                  Copiar chave
                </Button>
                {canEdit ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={remove.isPending}
                    onClick={() => void confirmRemove()}
                    className="text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                  >
                    {remove.isPending ? null : <Trash2 className="size-3.5" />}
                    Remover chave
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
              Sem chave PIX.
              <a
                href={whatsappUrl(tech.phone, askPixText(tech.name))}
                target="_blank"
                rel="noreferrer"
                title={tech.phone ? `Pedir a chave a ${tech.name} no WhatsApp` : "Sem celular no cadastro: escolha a conversa dele no WhatsApp"}
                className="inline-flex items-center gap-1 rounded font-medium text-ink underline-offset-2 hover:text-brand hover:underline focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
              >
                <MessageCircle className="size-3.5 text-ink-muted" />
                Pedir no WhatsApp
              </a>
            </p>
          )}
          {summary && board.data?.items.length ? (
            <div className={clsx("flex flex-wrap items-center justify-between gap-2", pixKnown && "border-t border-line pt-2.5")}>
              <p className="text-xs text-ink-muted tabular-nums">
                A pagar <strong className="font-semibold text-ink">{formatMoney(summary.to_pay)}</strong> · Previsto{" "}
                {formatMoney(summary.expected)} · Pago {formatMoney(summary.paid)}
              </p>
              <Link
                href="/pagamentos"
                className={buttonClassName("ghost", "sm")}
                target={dirty ? "_blank" : undefined}
                rel={dirty ? "noreferrer" : undefined}
              >
                <Wallet className="size-3.5" />
                Ver em Pagamentos
              </Link>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

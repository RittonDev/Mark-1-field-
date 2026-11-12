"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { FileText, PackageOpen, X } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, ErrorBox } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatShort } from "@/lib/format";
import type { PartRequest, PartRequestStatus, Quote, TicketDetail } from "@/lib/types";
import { QuoteEditor } from "./QuotesCard";

const STATUS: Record<PartRequestStatus, { label: string; className: string }> = {
  open: { label: "Aguardando orçamento", className: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25" },
  quoted: { label: "Orçamento enviado", className: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25" },
  approved: { label: "Aprovada: pode instalar", className: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25" },
  rejected: { label: "Recusada", className: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25" },
  cancelled: { label: "Cancelada", className: "bg-surface-2 text-ink-muted ring-line" },
};

/** Peças pedidas pelo técnico em campo: viram orçamento, que o cliente aprova pelo link antes da instalação. */
export function PartRequestsCard({ ticket }: { ticket: TicketDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [quoting, setQuoting] = useState<PartRequest | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const requests = ticket.part_requests ?? [];
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
    queryClient.invalidateQueries({ queryKey: ["tickets"] });
  };
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: PartRequestStatus; quote_id?: string; response_note?: string | null }) =>
      api.patch(`/part-requests/${id}`, body),
    onSuccess: refresh,
  });

  if (requests.length === 0) return null;
  const openCount = requests.filter((r) => r.status === "open").length;

  return (
    <Card className="animate-enter overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <PackageOpen className="size-4 text-amber-600 dark:text-amber-400" />
            Pedidos de peça do técnico
            {openCount ? (
              <span className="rounded-full bg-amber-100 px-1.5 text-[11px] leading-[18px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                {openCount}
              </span>
            ) : null}
          </span>
        }
        description="Peça só entra com orçamento aprovado e assinado pelo cliente."
      />
      <ul className="divide-y divide-line">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">
                {r.quantity.toLocaleString("pt-BR")} {r.unit} · {r.description}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {r.requested_by?.name ?? "Técnico"} · {formatShort(r.created_at)}
                {r.quote_code ? ` · ${r.quote_code}` : ""}
              </p>
              {r.note ? <p className="mt-1 text-xs text-ink-muted italic">“{r.note}”</p> : null}
              {r.response_note ? <p className="mt-1 text-xs text-ink-subtle">Resposta: {r.response_note}</p> : null}
              {r.attachments.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {r.attachments.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setZoom(a.url)}
                      className="size-12 overflow-hidden rounded-lg border border-line bg-surface-2"
                      aria-label="Ver foto da peça"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- link assinado da API */}
                      <img src={a.url} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <span className={clsx("rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", STATUS[r.status].className)}>
                {STATUS[r.status].label}
              </span>
              {r.status === "open" && ticket.can_assign ? (
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={update.isPending && update.variables?.id === r.id}
                    onClick={() => {
                      const note = window.prompt("Motivo para não pedir esta peça (o técnico vê):");
                      if (note !== null) update.mutate({ id: r.id, status: "rejected", response_note: note || null });
                    }}
                  >
                    Recusar
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => setQuoting(r)}>
                    <FileText className="size-3.5" />
                    Montar orçamento
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {update.error ? (
        <div className="px-5 pb-4">
          <ErrorBox message={errorMessage(update.error)} />
        </div>
      ) : null}
      {quoting ? (
        <QuoteEditor
          ticket={ticket}
          quote={null}
          prefill={{
            title: `Peças · ${ticket.code}`,
            items: [{ description: quoting.description, quantity: quoting.quantity, unit: quoting.unit, kind: "product" }],
          }}
          onClose={() => setQuoting(null)}
          onSaved={(saved: Quote) => {
            update.mutate({ id: quoting.id, status: "quoted", quote_id: saved.id });
            queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id, "quotes"] });
            toast({ title: `${saved.code} criado a partir do pedido`, description: "Envie o link para o cliente aprovar.", tone: "success" });
          }}
        />
      ) : null}
      {zoom ? (
        <div className="fixed inset-0 z-50 flex animate-fade items-center justify-center bg-black/80 p-4" onClick={() => setZoom(null)}>
          <button type="button" className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white" aria-label="Fechar">
            <X className="size-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="Foto da peça" className="max-h-[90vh] max-w-full animate-pop rounded-xl object-contain" />
        </div>
      ) : null}
    </Card>
  );
}

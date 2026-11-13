"use client";

import { ExternalLink, FileText, History } from "lucide-react";
import { Card, CardHeader, SectionTitle } from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { TicketDetail } from "@/lib/types";

const DEADLINE: Record<string, string> = {
  completedOnSchedule: "cumprido no prazo",
  completedOutOfSchedule: "cumprido fora do prazo",
  outOfSchedule: "fora do prazo",
  onSchedule: "no prazo",
};

const isImage = (type: string | null, url: string) => (type ?? "").startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);

/** O que veio do Field Control na migração: valores, itens, a solicitação original do cliente e os arquivos. */
export function LegacyOrderCard({ ticket }: { ticket: TicketDetail }) {
  const legacy = ticket.legacy;
  if (!legacy) return null;
  const values = legacy.values;
  const items = legacy.items ?? [];
  const files = legacy.files ?? [];
  const hasValues = values && (values.total || values.products || values.services || values.expenses);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <History className="size-4 text-ink-subtle" />
            Histórico do Field Control
          </span>
        }
        description={`OS migrada${legacy.identifier ? ` · nº ${legacy.identifier} no Field Control` : ""}`}
      />
      <div className="flex flex-col gap-4 p-5">
        {legacy.migration_note ? (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-muted">{legacy.migration_note}</p>
        ) : null}

        {legacy.request ? (
          <div>
            <SectionTitle className="mb-1">
              Solicitação do cliente
              {legacy.request.created_at ? (
                <span className="font-normal text-ink-muted"> · {formatDateTime(legacy.request.created_at)}</span>
              ) : null}
            </SectionTitle>
            {legacy.request.subject ? <p className="text-sm font-semibold text-ink">{legacy.request.subject}</p> : null}
            {legacy.request.message ? <p className="mt-0.5 text-sm whitespace-pre-wrap text-ink-muted">{legacy.request.message}</p> : null}
            {legacy.request.contact_email || legacy.request.contact_phone ? (
              <p className="mt-1 text-xs text-ink-subtle">
                Contato: {[legacy.request.contact_email, legacy.request.contact_phone].filter(Boolean).join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}

        {items.length ? (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="bg-[var(--table-head)] text-left text-[11px] font-bold tracking-[0.05em] text-ink-muted uppercase">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2 text-right">Qtd.</th>
                  <th className="px-3 py-2 text-right">Valor</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((i, k) => (
                  <tr key={k}>
                    <td className="px-3 py-2 font-semibold text-ink">{i.name}</td>
                    <td className="px-3 py-2 text-ink-muted">{i.type === "service" ? "Serviço" : "Produto"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{i.quantity.toLocaleString("pt-BR")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(i.value)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(i.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {hasValues ? (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
            {[
              ["Produtos", values.products],
              ["Serviços", values.services],
              ["Despesas", values.expenses],
              ["Total da OS", values.total],
            ].map(([label, value]) => (
              <div key={label as string} className="bg-surface px-3 py-2.5">
                <p className="text-[11px] text-ink-muted">{label}</p>
                <p className="text-sm font-semibold text-ink tabular-nums">{formatMoney(value as number)}</p>
              </div>
            ))}
          </div>
        ) : null}

        {legacy.deadline && (legacy.deadline.response_status || legacy.deadline.solution_status) ? (
          <p className="text-xs text-ink-muted">
            Prazo no Field Control: resposta {DEADLINE[legacy.deadline.response_status ?? ""] ?? "—"} · solução{" "}
            {DEADLINE[legacy.deadline.solution_status ?? ""] ?? "—"}
          </p>
        ) : null}

        {files.length ? (
          <div>
            <SectionTitle className="mb-2">Arquivos ({files.length})</SectionTitle>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {files.map((f, k) =>
                isImage(f.type, f.url) ? (
                  <a key={k} href={f.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line bg-surface-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- arquivo ainda no armazenamento do Field Control */}
                    <img src={f.url} alt={f.title ?? "Arquivo"} loading="lazy" className="aspect-square w-full object-cover" />
                  </a>
                ) : (
                  <a
                    key={k}
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-line bg-surface-2 p-2 text-center text-[11px] text-ink-muted hover:text-brand"
                  >
                    <FileText className="size-5" />
                    <span className="line-clamp-2">{f.title ?? "Arquivo"}</span>
                    <ExternalLink className="size-3" />
                  </a>
                ),
              )}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

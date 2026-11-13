"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/badges";
import { TicketLink } from "@/components/ticket/TicketLink";
import { useNow } from "@/components/useNow";
import { api } from "@/lib/api";
import { formatMinutes } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import type { Page, TicketListItem, UUID } from "@/lib/types";
import { dayTimeLabel } from "./dayTime";

const PANEL_TITLE = "Abre a OS no painel, por cima desta tela (Ctrl+clique: outra aba)";

/**
 * OS ainda abertas na mesma loja: evita mandar dois técnicos para o mesmo problema. Cada OS abre no
 * painel por cima da Nova OS (o formulário continua aqui).
 */
export function OpenAtLocation({ locationId }: { locationId: UUID }) {
  const now = useNow(60_000);
  const open = useQuery({
    queryKey: ["tickets", "open-at-location", locationId],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", { location_id: locationId, open_only: true, page_size: 5, order_by: "-created_at" }),
    staleTime: 15_000,
  });
  const data = open.data;
  if (!data || data.total === 0) return null;
  return (
    <div className="animate-enter rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/30 dark:bg-amber-500/10" role="status">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        {data.total === 1 ? "Já existe 1 OS aberta nesta loja" : `Já existem ${data.total} OS abertas nesta loja`}
      </p>
      <ul className="mt-1.5 flex flex-col divide-y divide-amber-200/70 dark:divide-amber-500/20">
        {data.items.map((t) => (
          <li key={t.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <TicketLink ticketId={t.id} className="min-w-0 text-sm font-semibold text-ink hover:text-brand-ink hover:underline" title={PANEL_TITLE}>
              <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted">{t.code}</span>
              {t.title}
            </TicketLink>
            <span className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
              <StatusBadge status={t.status} />
              <span>aberta há {formatMinutes(Math.max(0, (now - new Date(t.created_at).getTime()) / 60_000))}</span>
              <span>· {t.assignee ? t.assignee.name : "sem técnico"}</span>
              {t.scheduled_start ? <span>· visita {dayTimeLabel(t.scheduled_start, now, true)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-amber-800 dark:text-amber-200/90">Confira se não é o mesmo problema antes de abrir outra.</p>
        {data.total > data.items.length ? (
          <Link
            href={`/chamados?location_id=${locationId}&view=abertos`}
            target="_blank"
            className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 hover:underline dark:text-amber-200"
          >
            Ver todas ({data.total})
            <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only"> (abre em outra aba)</span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** O mesmo nº de chamado do cliente já tem OS: provavelmente é o mesmo pedido chegando de novo. */
export function SameClientReference({ reference }: { reference: string }) {
  const ref = useDebounced(reference.trim(), 600);
  const found = useQuery({
    queryKey: ["tickets", "client-reference", ref.toLowerCase()],
    queryFn: () => api.get<Page<TicketListItem>>("/tickets", { q: ref, page_size: 5, order_by: "-created_at" }),
    enabled: ref.length >= 4,
    staleTime: 30_000,
  });
  const same = (found.data?.items ?? []).filter((t) => t.client_reference?.trim().toLowerCase() === ref.toLowerCase());
  if (ref.length < 4 || same.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs font-medium text-amber-800 dark:text-amber-200" role="status">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      Já existe OS com o chamado {ref} do cliente:
      {same.map((t, i) => (
        <span key={t.id}>
          <TicketLink ticketId={t.id} className="font-mono font-semibold underline-offset-2 hover:underline" title={PANEL_TITLE}>
            {t.code}
          </TicketLink>
          {i < same.length - 1 ? "," : ""}
        </span>
      ))}
    </p>
  );
}

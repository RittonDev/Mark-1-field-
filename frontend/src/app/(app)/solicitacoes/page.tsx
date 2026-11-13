"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardPlus, Hand, MapPin, UserRound } from "lucide-react";
import { useState } from "react";
import { PriorityBadge, StatusBadge } from "@/components/badges";
import { Tabs } from "@/components/motion";
import { OpenTicketButton, QuickEditButton } from "@/components/ticket/QuickEditButton";
import { Button, Card, EmptyState, ErrorBox, LoadingBlock, PageHeader } from "@/components/ui";
import { useNow } from "@/components/useNow";
import { useToast } from "@/components/Toaster";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRelative } from "@/lib/format";
import type { Page, TicketListItem } from "@/lib/types";

type Tab = "new" | "all";

/**
 * Solicitações: o que os clientes abrem no portal (antes vinha pelo WhatsApp ou e-mail e a central
 * digitava a OS). A central analisa, puxa para a fila, escolhe o técnico e segue o fluxo da OS.
 */
export default function RequestsInboxPage() {
  const now = useNow(60_000);
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("new");

  const list = useQuery({
    queryKey: ["solicitacoes", tab],
    queryFn: () =>
      api.get<Page<TicketListItem>>("/tickets", {
        source: "portal",
        status: tab === "new" ? ["new", "triage"] : undefined,
        order_by: "-created_at",
        page_size: 100,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const count = useQuery({
    queryKey: ["solicitacoes", "count"],
    queryFn: () => api.get<{ pending: number }>("/portal/inbox-count"),
  });

  const claim = useMutation({
    mutationFn: (t: TicketListItem) => api.post(`/tickets/${t.id}/claim`),
    onSuccess: (_, t) => {
      toast({ title: `${t.code} está na sua fila` });
      void queryClient.invalidateQueries({ queryKey: ["solicitacoes"] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (error) => toast({ title: errorMessage(error), tone: "error" }),
  });

  const items = list.data?.items ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Solicitações"
        description="Chamados que os clientes abrem pelo portal. Analise, puxe para a sua fila e escolha o técnico."
      />
      <Tabs<Tab>
        items={[
          { key: "new", label: "Esperando a central", count: count.data?.pending ?? null },
          { key: "all", label: "Todas do portal" },
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel="Solicitações"
        className="mb-4"
      />

      {list.isLoading ? (
        <LoadingBlock rows={4} />
      ) : list.error ? (
        <ErrorBox message={errorMessage(list.error)} />
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={<ClipboardPlus />}
            title={tab === "new" ? "Nenhuma solicitação esperando" : "Nenhuma solicitação do portal ainda"}
            description="Quando um cliente abrir um chamado pelo portal ou pelo app instalado no Windows, ele aparece aqui na hora."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {items.map((t) => (
              <li key={t.id} className="flex items-start gap-4 px-4 py-3.5 transition-colors hover:bg-[var(--row-hover)] sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <OpenTicketButton ticketId={t.id} className="font-mono text-xs text-ink-subtle hover:text-brand">
                      {t.code}
                    </OpenTicketButton>
                    <span className="text-sm font-semibold text-ink">{t.customer?.name ?? "Sem cliente"}</span>
                    <StatusBadge status={t.status} />
                    <PriorityBadge priority={t.priority} compact />
                  </div>
                  <OpenTicketButton ticketId={t.id} className="mt-1 block text-left font-semibold text-ink hover:text-brand">
                    {t.title}
                  </OpenTicketButton>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                    {t.location ? (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3.5" />
                        {t.location.name}
                        {t.location.city ? ` · ${t.location.city}` : ""}
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="size-3.5" />
                      {t.requester_name ?? "Cliente"} · {formatRelative(t.created_at, now)}
                    </span>
                    {t.owner ? <span>Na fila de {t.owner.id === user?.id ? "você" : t.owner.name}</span> : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!t.owner ? (
                    <Button size="sm" onClick={() => claim.mutate(t)} loading={claim.isPending && claim.variables?.id === t.id}>
                      <Hand className="size-4" />
                      Puxar
                    </Button>
                  ) : null}
                  <QuickEditButton ticketId={t.id} code={t.code} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hand, UserRoundCheck } from "lucide-react";
import { useToast } from "@/components/Toaster";
import { Button, Card, ErrorBox } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { STATUS } from "@/lib/constants";
import { initials } from "@/lib/format";
import type { QueuesOut, TicketDetail } from "@/lib/types";

/** Analista responsável pela OS (quem acompanha): puxar para a própria fila ou passar a um colega. */
export function OwnerCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const owner = ticket.owner ?? null;
  const open = ["open", "active", "pending"].includes(STATUS[ticket.status].group);
  const queues = useQuery({
    queryKey: ["tickets", "queues"],
    queryFn: () => api.get<QueuesOut>("/queues"),
    enabled: ticket.can_assign,
    staleTime: 60_000,
  });
  const done = (title: string) => {
    queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
    queryClient.invalidateQueries({ queryKey: ["tickets"] });
    toast({ title, tone: "success" });
  };
  const claim = useMutation({
    mutationFn: () => api.post<TicketDetail>(`/tickets/${ticket.id}/claim`),
    onSuccess: () => done(`${ticket.code} está na sua fila`),
  });
  const transfer = useMutation({
    mutationFn: (ownerId: string | null) =>
      api.patch<TicketDetail>(`/tickets/${ticket.id}`, { owner_id: ownerId, expected_version: ticket.version }),
    onSuccess: (updated) => done(updated.owner ? `Agora com ${updated.owner.name}` : "OS sem analista responsável"),
  });

  if (!ticket.can_assign) return null;
  const mine = owner?.id === user?.id;
  const error = claim.error ?? transfer.error;

  return (
    <Card className="p-4">
      <p className="mb-3 text-xs font-medium text-ink-subtle">Analista responsável</p>
      <div className="flex items-center gap-3">
        {owner ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand to-brand-cyan text-xs font-semibold text-white">
            {initials(owner.name)}
          </span>
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-subtle">
            <UserRoundCheck className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{owner ? (mine ? `${owner.name} (você)` : owner.name) : "Sem analista"}</p>
          <p className="text-xs text-ink-muted">Acompanha a OS até o fim</p>
        </div>
      </div>
      {open && !mine ? (
        <Button variant="primary" className="mt-3 w-full" loading={claim.isPending} onClick={() => claim.mutate()}>
          <Hand className="size-4" />
          Puxar para minha fila
        </Button>
      ) : null}
      {open ? (
        <label className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
          <span className="shrink-0">Passar para</span>
          <select
            value=""
            disabled={transfer.isPending || !queues.data}
            onChange={(e) => {
              if (!e.target.value) return;
              transfer.mutate(e.target.value === "none" ? null : e.target.value);
            }}
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 pr-7 text-xs text-ink"
          >
            <option value="">Escolher colega...</option>
            {(queues.data?.queues ?? [])
              .filter((q) => q.user.id !== owner?.id)
              .map((q) => (
                <option key={q.user.id} value={q.user.id}>
                  {q.user.name} ({q.open} abertas)
                </option>
              ))}
            {owner ? <option value="none">Ninguém (volta para Sem analista)</option> : null}
          </select>
        </label>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ErrorBox message={errorMessage(error)} />
        </div>
      ) : null}
    </Card>
  );
}

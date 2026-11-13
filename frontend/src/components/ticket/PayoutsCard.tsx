"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { useState } from "react";
import { Button, Card, CardHeader, Dialog, ErrorBox, Input, Pill } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { PAYOUT_STATUS } from "@/lib/constants";
import { formatDate, formatMoney, moneyInput, parseMoney } from "@/lib/format";
import type { Payout, TicketDetail, UUID } from "@/lib/types";

interface Person {
  id: UUID;
  name: string;
  role: "Responsável" | "Junto";
}

/** Quem está na OS (responsável e quem vai junto): cada um pode ter um valor. */
function people(ticket: TicketDetail): Person[] {
  const list: Person[] = [];
  if (ticket.assignee) list.push({ id: ticket.assignee.id, name: ticket.assignee.name, role: "Responsável" });
  for (const helper of ticket.helpers ?? []) {
    if (helper.id !== ticket.assignee?.id) list.push({ id: helper.id, name: helper.name, role: "Junto" });
  }
  return list;
}

function payoutOf(ticket: TicketDetail, technicianId: UUID): Payout | undefined {
  return (ticket.payouts ?? []).find((p) => p.technician.id === technicianId);
}

function StatusPill({ payout }: { payout: Payout }) {
  const info = PAYOUT_STATUS[payout.status];
  return (
    <Pill color={info.color}>
      {info.label}
      {payout.status === "paid" && payout.paid_at ? ` ${formatDate(payout.paid_at)}` : ""}
    </Pill>
  );
}

/** Valor de cada técnico na OS. Pago fica travado (desfaça em Pagamentos para mudar). */
export function PayoutsDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const team = people(ticket);
  const [values, setValues] = useState<Record<UUID, string>>(() =>
    Object.fromEntries(team.map((p) => [p.id, moneyInput(payoutOf(ticket, p.id)?.amount)])),
  );
  const changed = team.filter((p) => {
    const current = payoutOf(ticket, p.id);
    if (current?.status === "paid") return false;
    return (values[p.id] ?? "") !== moneyInput(current?.amount);
  });
  const invalid = changed.some((p) => {
    const value = parseMoney(values[p.id] ?? "");
    return value !== null && (!Number.isFinite(value) || value < 0);
  });

  const save = useMutation({
    mutationFn: async () => {
      for (const p of changed) {
        const value = parseMoney(values[p.id] ?? "");
        if (value === null) await api.delete(`/tickets/${ticket.id}/payouts/${p.id}`);
        else await api.put(`/tickets/${ticket.id}/payouts/${p.id}`, { amount: value });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ["payouts"] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Valor do técnico"
      description="Os técnicos são parceiros e recebem por chamado. O pagamento é feito em Pagamentos."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} disabled={!changed.length || invalid} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      {team.length ? (
        <ul className="flex flex-col gap-3">
          {team.map((p) => {
            const current = payoutOf(ticket, p.id);
            const paid = current?.status === "paid";
            const value = parseMoney(values[p.id] ?? "");
            const bad = value !== null && (!Number.isFinite(value) || value < 0);
            return (
              <li key={p.id} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                  <p className="text-xs text-ink-muted">{p.role}</p>
                </div>
                {current ? <StatusPill payout={current} /> : null}
                <div className="w-36">
                  <Input
                    inputMode="decimal"
                    aria-label={`Valor de ${p.name}`}
                    placeholder="R$ 0,00"
                    value={values[p.id] ?? ""}
                    disabled={paid}
                    onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))}
                    className={bad ? "border-red-400" : undefined}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">Coloque o técnico na OS (aba Geral) para definir o valor dele.</p>
      )}
      <p className="mt-4 text-xs text-ink-muted">Vazio tira o valor. Reembolsos (km, material) ficam em Custos extras.</p>
      {save.error ? (
        <div className="mt-3">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}
    </Dialog>
  );
}

/** Linha da aba Geral: o valor do responsável, ao lado de quem vai atender. */
export function PayoutLine({ ticket }: { ticket: TicketDetail }) {
  const [open, setOpen] = useState(false);
  if (!ticket.assignee) return null;
  const team = people(ticket);
  const total = (ticket.payouts ?? []).reduce((sum, p) => sum + p.amount, 0);
  const mine = payoutOf(ticket, ticket.assignee.id);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm">
      <Wallet className="size-4 text-ink-subtle" />
      <span className="text-ink-muted">Valor do técnico</span>
      <span className="font-medium text-ink tabular-nums">{mine ? formatMoney(mine.amount) : "não definido"}</span>
      {team.length > 1 && total ? <span className="text-xs text-ink-muted">· equipe {formatMoney(total)}</span> : null}
      {mine ? <StatusPill payout={mine} /> : null}
      <button type="button" onClick={() => setOpen(true)} className="ml-auto text-xs font-medium text-brand hover:underline">
        {mine ? "Alterar" : "Definir valor"}
      </button>
      {open ? <PayoutsDialog ticket={ticket} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** Quadro da aba de custos: quanto cada técnico recebe por esta OS. */
export function PayoutsCard({ ticket }: { ticket: TicketDetail }) {
  const [open, setOpen] = useState(false);
  const team = people(ticket);
  return (
    <Card>
      <CardHeader
        title="Pagamento dos técnicos"
        description="Os parceiros recebem por chamado. A central paga em Pagamentos."
        actions={
          team.length ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              Editar valores
            </Button>
          ) : null
        }
      />
      <div className="px-5 py-3">
        {team.length ? (
          <ul className="divide-y divide-line">
            {team.map((p) => {
              const payout = payoutOf(ticket, p.id);
              return (
                <li key={p.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{p.name}</p>
                    <p className="text-xs text-ink-muted">{p.role}</p>
                  </div>
                  {payout ? <StatusPill payout={payout} /> : null}
                  <span className="w-28 text-right text-sm font-medium text-ink tabular-nums">
                    {payout ? formatMoney(payout.amount) : <span className="font-normal text-ink-subtle">sem valor</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-2 text-sm text-ink-muted">Sem técnico na OS ainda.</p>
        )}
      </div>
      {open ? <PayoutsDialog ticket={ticket} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

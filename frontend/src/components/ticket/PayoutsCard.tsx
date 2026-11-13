"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, ErrorBox, Input, Pill } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { PAYOUT_STATUS } from "@/lib/constants";
import { formatDate, formatMoney, moneyInput } from "@/lib/format";
import { readDecimal } from "@/lib/quotes";
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

/**
 * Valores de quem já saiu da OS: o pago continua registrado (a API não apaga na troca de técnico) e
 * entra no total da equipe, então aparece aqui, só para consulta.
 */
function former(ticket: TicketDetail, team: Person[]): Payout[] {
  return (ticket.payouts ?? []).filter((p) => !team.some((t) => t.id === p.technician.id));
}

function payoutOf(ticket: TicketDetail, technicianId: UUID): Payout | undefined {
  return (ticket.payouts ?? []).find((p) => p.technician.id === technicianId);
}

const cents = (value: number) => Math.round(value * 100);

function StatusPill({ payout }: { payout: Payout }) {
  const info = PAYOUT_STATUS[payout.status];
  return (
    <Pill color={info.color}>
      {info.label}
      {payout.status === "paid" && payout.paid_at ? ` ${formatDate(payout.paid_at)}` : ""}
    </Pill>
  );
}

/** Valor digitado: vazio tira o valor (null); inválido traz a mensagem para mostrar no campo. */
function readAmount(text: string) {
  if (!text.trim()) return { value: null, error: null };
  return readDecimal(text, { decimals: 2, allowZero: true });
}

/** Valor de cada técnico na OS. Pago fica travado (desfaça em Pagamentos para mudar). */
export function PayoutsDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const team = people(ticket);
  const left = former(ticket, team);
  const [values, setValues] = useState<Record<UUID, string>>(() =>
    Object.fromEntries(team.map((p) => [p.id, moneyInput(payoutOf(ticket, p.id)?.amount)])),
  );
  const read = (id: UUID) => readAmount(values[id] ?? "");
  const changed = team.filter((p) => {
    const current = payoutOf(ticket, p.id);
    if (current?.status === "paid") return false;
    const { value, error } = read(p.id);
    if (error) return true;
    return value === null ? current !== undefined : current === undefined || cents(value) !== cents(current.amount);
  });
  const invalid = changed.some((p) => read(p.id).error !== null);
  const totalCents =
    team.reduce((sum, p) => {
      const current = payoutOf(ticket, p.id);
      if (current?.status === "paid") return sum + cents(current.amount);
      const { value } = read(p.id);
      return sum + (value === null ? 0 : cents(value));
    }, 0) + left.reduce((sum, p) => sum + cents(p.amount), 0);

  // Um técnico por vez: se um falhar, os anteriores já foram gravados. A OS é relida de qualquer jeito
  // (onSettled), então a tela mostra o que ficou salvo e o erro diz o que faltou.
  const save = useMutation({
    mutationFn: async () => {
      for (const p of changed) {
        const { value } = read(p.id);
        try {
          if (value === null) await api.delete(`/tickets/${ticket.id}/payouts/${p.id}`);
          else await api.put(`/tickets/${ticket.id}/payouts/${p.id}`, { amount: value.toFixed(2) });
        } catch (e) {
          throw new Error(`${p.name}: ${errorMessage(e)}`);
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ["payouts"] });
    },
    onSuccess: () => {
      toast({ title: "Valores salvos", tone: "success" });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={changed.length > 0}
      busy={save.isPending}
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
            const { error } = read(p.id);
            const hintId = `payout-${p.id}`;
            return (
              <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1 pt-1">
                  <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                  <p className="text-xs text-ink-muted">{p.role}</p>
                </div>
                {current ? (
                  <span className="pt-1.5">
                    <StatusPill payout={current} />
                  </span>
                ) : null}
                <div className="flex w-36 flex-col gap-1">
                  <Input
                    inputMode="decimal"
                    aria-label={`Valor de ${p.name}`}
                    aria-invalid={Boolean(error) || undefined}
                    aria-describedby={error || paid ? hintId : undefined}
                    placeholder="R$ 0,00"
                    value={values[p.id] ?? ""}
                    disabled={paid}
                    onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))}
                    className={error ? "border-red-400 dark:border-red-500/60" : undefined}
                  />
                  {error ? (
                    <span id={hintId} className="text-xs text-red-700 dark:text-red-400">
                      Valor inválido: {error.toLowerCase()}
                    </span>
                  ) : null}
                </div>
                {paid ? (
                  <p id={hintId} className="w-full text-right text-xs text-ink-muted">
                    Pago{current?.paid_at ? ` em ${formatDate(current.paid_at)}` : ""}. Para mudar, desfaça o pagamento em{" "}
                    <Link href="/pagamentos" className="font-medium text-brand hover:underline">
                      Pagamentos
                    </Link>
                    .
                  </p>
                ) : null}
              </li>
            );
          })}
          {left.map((p) => (
            <li key={p.id} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{p.technician.name}</p>
                <p className="text-xs text-ink-muted">Saiu da OS</p>
              </div>
              <StatusPill payout={p} />
              <span className="w-36 text-right text-sm font-medium text-ink tabular-nums">{formatMoney(p.amount)}</span>
            </li>
          ))}
          {team.length + left.length > 1 ? (
            <li className="flex items-center justify-between border-t border-line pt-3 text-sm">
              <span className="text-ink-muted">Total da equipe</span>
              <span className="font-semibold text-ink tabular-nums">{formatMoney(totalCents / 100)}</span>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">Coloque o técnico na OS (aba Geral) para definir o valor dele.</p>
      )}
      <p className="mt-4 text-xs text-ink-muted">Vazio tira o valor. Reembolsos (km, material) ficam em Custos extras.</p>
      {save.error ? (
        <div className="mt-3">
          <ErrorBox message={`Não foi possível salvar tudo. ${errorMessage(save.error)}`} />
        </div>
      ) : null}
    </Dialog>
  );
}

/** Linha da aba Geral: o valor do responsável, ao lado de quem vai atender. */
export function PayoutLine({ ticket }: { ticket: TicketDetail }) {
  const [open, setOpen] = useState(false);
  if (!ticket.assignee) return null;
  const payouts = ticket.payouts ?? [];
  const total = payouts.reduce((sum, p) => sum + cents(p.amount), 0) / 100;
  const mine = payoutOf(ticket, ticket.assignee.id);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm">
      <Wallet className="size-4 text-ink-subtle" />
      <span className="text-ink-muted">Valor do técnico</span>
      <span className="font-medium text-ink tabular-nums">{mine ? formatMoney(mine.amount) : "não definido"}</span>
      {payouts.length > 1 ? <span className="text-xs text-ink-muted">· equipe {formatMoney(total)}</span> : null}
      {mine ? <StatusPill payout={mine} /> : null}
      <button type="button" onClick={() => setOpen(true)} className="ml-auto rounded px-1 text-xs font-medium text-brand hover:underline">
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
  const left = former(ticket, team);
  const total = (ticket.payouts ?? []).reduce((sum, p) => sum + cents(p.amount), 0) / 100;
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
        {team.length || left.length ? (
          <ul className="divide-y divide-line">
            {team.map((p) => {
              const payout = payoutOf(ticket, p.id);
              return (
                <li key={p.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                    <p className="text-xs text-ink-muted">{p.role}</p>
                  </div>
                  {payout ? <StatusPill payout={payout} /> : null}
                  <span className="w-28 text-right text-sm font-medium text-ink tabular-nums">
                    {payout ? formatMoney(payout.amount) : <span className="font-normal text-ink-muted">sem valor</span>}
                  </span>
                </li>
              );
            })}
            {left.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{p.technician.name}</p>
                  <p className="text-xs text-ink-muted">Saiu da OS</p>
                </div>
                <StatusPill payout={p} />
                <span className="w-28 text-right text-sm font-medium text-ink tabular-nums">{formatMoney(p.amount)}</span>
              </li>
            ))}
            {(ticket.payouts ?? []).length > 1 ? (
              <li className="flex items-center justify-between py-2.5 text-sm">
                <span className="text-ink-muted">Total da equipe</span>
                <span className="w-28 text-right font-semibold text-ink tabular-nums">{formatMoney(total)}</span>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="py-2 text-sm text-ink-muted">Sem técnico na OS ainda.</p>
        )}
      </div>
      {open ? <PayoutsDialog ticket={ticket} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckCheck, Copy, RotateCcw, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Tabs } from "@/components/motion";
import { OpenTicketButton } from "@/components/ticket/QuickEditButton";
import { useToast } from "@/components/Toaster";
import { Button, Card, EmptyState, ErrorBox, LoadingBlock, PageHeader, Pill, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { PAYOUT_STATUS } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import type { PayoutLine, PayoutList, UUID } from "@/lib/types";

type View = "to_pay" | "expected" | "paid" | "all";

const VIEW_QUERY: Record<View, Record<string, string>> = {
  to_pay: { status: "pending", concluded: "true" },
  expected: { status: "pending", concluded: "false" },
  paid: { status: "paid" },
  all: {},
};

/** Últimos 12 meses ("2026-11") para o filtro de período. */
function lastMonths(): { value: string; label: string }[] {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    return { value, label: label.charAt(0).toUpperCase() + label.slice(1) };
  });
}

function monthRange(month: string): { date_from?: string; date_to?: string } {
  if (!month) return {};
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { date_from: `${month}-01`, date_to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Extrato para mandar ao técnico no WhatsApp. */
function statement(name: string, lines: PayoutLine[]): string {
  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  const rows = lines.map((l) => `• ${l.ticket.code} · ${l.ticket.location ?? l.ticket.customer ?? ""} · ${formatMoney(l.amount)}`);
  return [`*Maxx Field · pagamento*`, name, "", ...rows, "", `*Total: ${formatMoney(total)}*`].join("\n");
}

/**
 * Pagamentos: os técnicos são parceiros e recebem por chamado. Aqui a central vê quanto deve a cada
 * um (OS concluídas), o que ainda vai pagar (OS abertas) e marca como pago.
 */
export default function PayoutsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const months = useMemo(() => lastMonths(), []);
  const [view, setView] = useState<View>("to_pay");
  const [month, setMonth] = useState("");
  const [technicianId, setTechnicianId] = useState("");
  const [selected, setSelected] = useState<Set<UUID>>(new Set());

  const list = useQuery({
    queryKey: ["payouts", view, month, technicianId],
    queryFn: () =>
      api.get<PayoutList>("/payouts", {
        ...VIEW_QUERY[view],
        ...monthRange(month),
        technician_id: technicianId || undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const overview = useQuery({
    queryKey: ["payouts", "overview", month],
    queryFn: () => api.get<PayoutList>("/payouts", monthRange(month)),
    placeholderData: keepPreviousData,
  });

  const groups = useMemo(() => {
    const map = new Map<UUID, { id: UUID; name: string; lines: PayoutLine[] }>();
    for (const line of list.data?.items ?? []) {
      const group = map.get(line.technician.id) ?? { id: line.technician.id, name: line.technician.name, lines: [] };
      group.lines.push(line);
      map.set(line.technician.id, group);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [list.data]);
  const technicians = useMemo(() => {
    const map = new Map<UUID, string>();
    for (const line of overview.data?.items ?? []) map.set(line.technician.id, line.technician.name);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [overview.data]);

  const pay = useMutation({
    mutationFn: ({ ids, paid }: { ids: UUID[]; paid: boolean }) =>
      api.post<{ changed: number }>(paid ? "/payouts/pay" : "/payouts/unpay", { ids }),
    onSuccess: (data, { paid }) => {
      toast({ title: paid ? `${data.changed} pagamento(s) marcado(s) como pago` : `${data.changed} pagamento(s) voltaram para "a pagar"`, tone: "success" });
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["payouts"] });
      void queryClient.invalidateQueries({ queryKey: ["ticket"] });
    },
    onError: (error) => toast({ title: errorMessage(error), tone: "error" }),
  });

  const summary = overview.data?.summary;
  const toggle = (id: UUID) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Pagamentos"
        description="Os técnicos parceiros recebem por chamado. O valor de cada um é definido na OS."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} className="w-56" aria-label="Técnico">
              <option value="">Todos os técnicos</option>
              {technicians.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
            <Select value={month} onChange={(e) => setMonth(e.target.value)} className="w-48" aria-label="Período">
              <option value="">Todos os períodos</option>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(
          [
            ["to_pay", "A pagar", "OS concluídas", summary?.to_pay],
            ["expected", "Previsto", "OS ainda em andamento", summary?.expected],
            ["paid", "Pago", month ? "no período" : "até hoje", summary?.paid],
          ] as const
        ).map(([key, label, hint, value]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={clsx(
              "rounded-xl border px-4 py-3 text-left shadow-elev-1 transition-[border-color,box-shadow] duration-150",
              view === key ? "border-brand bg-brand-soft ring-2 ring-brand/15" : "border-line bg-surface hover:border-line-strong",
            )}
          >
            <span className="text-xs font-semibold text-ink/80">{label}</span>
            <span className="mt-0.5 block text-xl font-semibold tracking-tight text-ink tabular-nums">{formatMoney(value)}</span>
            <span className="text-xs text-ink-subtle">{hint}</span>
          </button>
        ))}
      </div>

      <Tabs<View>
        items={[
          { key: "to_pay", label: "A pagar" },
          { key: "expected", label: "Previsto" },
          { key: "paid", label: "Pagos" },
          { key: "all", label: "Todos" },
        ]}
        value={view}
        onChange={(key) => {
          setView(key);
          setSelected(new Set());
        }}
        ariaLabel="Pagamentos"
        className="mb-4"
      />

      {list.isLoading ? (
        <LoadingBlock rows={4} />
      ) : list.error ? (
        <ErrorBox message={errorMessage(list.error)} />
      ) : !groups.length ? (
        <Card>
          <EmptyState
            icon={<Wallet />}
            title="Nada por aqui"
            description="O valor de cada técnico é definido na OS (aba Geral, ao lado do colaborador) ou vem do tipo de serviço."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const total = group.lines.reduce((sum, l) => sum + l.amount, 0);
            const pending = group.lines.filter((l) => l.status === "pending");
            const chosen = group.lines.filter((l) => selected.has(l.id));
            return (
              <Card key={group.id} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-ink">{group.name}</p>
                    <p className="text-xs text-ink-muted">
                      {group.lines.length} OS · {formatMoney(total)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await navigator.clipboard.writeText(statement(group.name, group.lines));
                      toast({ title: "Extrato copiado: cole no WhatsApp do técnico", tone: "success" });
                    }}
                  >
                    <Copy className="size-4" />
                    Copiar extrato
                  </Button>
                  {view === "paid" ? (
                    <Button size="sm" disabled={!chosen.length} onClick={() => pay.mutate({ ids: chosen.map((l) => l.id), paid: false })}>
                      <RotateCcw className="size-4" />
                      Desfazer pagamento
                    </Button>
                  ) : pending.length ? (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={pay.isPending}
                      onClick={() => pay.mutate({ ids: (chosen.length ? chosen : pending).map((l) => l.id), paid: true })}
                    >
                      <CheckCheck className="size-4" />
                      {chosen.length ? `Pagar ${chosen.length} selecionada(s)` : `Pagar tudo (${formatMoney(pending.reduce((s, l) => s + l.amount, 0))})`}
                    </Button>
                  ) : null}
                </div>
                <ul className="divide-y divide-line">
                  {group.lines.map((line) => (
                    <li key={line.id} className="flex items-center gap-3 px-5 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(line.id)}
                        onChange={() => toggle(line.id)}
                        className="size-4 accent-[var(--brand)]"
                        aria-label={`Selecionar ${line.ticket.code}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">
                          <OpenTicketButton ticketId={line.ticket.id} className="mr-1.5 font-mono text-xs font-normal text-ink-subtle hover:text-brand">
                            {line.ticket.code}
                          </OpenTicketButton>
                          {line.ticket.title}
                        </p>
                        <p className="truncate text-xs text-ink-muted">
                          {[line.ticket.customer, line.ticket.location, line.ticket.city].filter(Boolean).join(" · ")}
                          {line.ticket.resolved_at ? ` · concluída ${formatDate(line.ticket.resolved_at)}` : " · em andamento"}
                          {line.note ? ` · ${line.note}` : ""}
                        </p>
                      </div>
                      <Pill color={PAYOUT_STATUS[line.status].color}>
                        {PAYOUT_STATUS[line.status].label}
                        {line.paid_at ? ` ${formatDate(line.paid_at)}` : ""}
                      </Pill>
                      <span className="w-28 text-right text-sm font-medium text-ink tabular-nums">{formatMoney(line.amount)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

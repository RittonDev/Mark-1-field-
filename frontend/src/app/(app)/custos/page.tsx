"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Download, Receipt } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, Card, EmptyState, ErrorBox, Input, LoadingBlock, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, isManager } from "@/lib/constants";
import { downloadCsv } from "@/lib/download";
import { EXPENSE_KIND, EXPENSE_STATUS } from "@/lib/expenses";
import { formatDate, formatMoney } from "@/lib/format";
import { useUsers } from "@/lib/queries";
import type { ExpenseReport, ExpenseStatus } from "@/lib/types";

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(y, m - 1, 1).toISOString(), end: new Date(y, m, 1).toISOString() };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function ExpensesPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [month, setMonth] = useState(currentMonth);
  const [technicianId, setTechnicianId] = useState("");
  const [status, setStatus] = useState<ExpenseStatus | "">("");
  const [selected, setSelected] = useState<string[]>([]);
  const technicians = useUsers({ role: "technician" });
  const range = monthRange(month);
  const report = useQuery({
    queryKey: ["expenses", month, technicianId, status],
    queryFn: () =>
      api.get<ExpenseReport>("/expenses", {
        ...range,
        technician_id: technicianId || undefined,
        status: status || undefined,
      }),
    placeholderData: (previous) => previous,
  });
  const markPaid = useMutation({
    mutationFn: () => api.post<{ updated: number }>("/expenses/mark-paid", { ids: selected }),
    onSuccess: (r) => {
      setSelected([]);
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      toast({ title: `${r.updated} custo(s) marcado(s) como reembolsado`, tone: "success" });
    },
    onError: (e) => toast({ title: errorMessage(e), tone: "error" }),
  });

  const data = report.data;
  const sums = useMemo(() => {
    const items = data?.items ?? [];
    const by = (s: ExpenseStatus) => items.filter((i) => i.status === s).reduce((t, i) => t + i.total, 0);
    return { approved: by("approved"), paid: by("paid"), pending: by("pending") };
  }, [data]);

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="Os custos extras são da gestão." />;
  }

  const payable = (data?.items ?? []).filter((i) => i.status === "approved");

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Custos extras"
        description="Reembolso aos técnicos: material, km rodado e despesas lançadas nas OS."
        actions={
          <>
            <KmRate canEdit={isManager(user?.role)} />
            <Button
              disabled={!data?.items.length}
              onClick={() =>
                downloadCsv(`custos-extras-${month}.csv`, [
                  ["data", "os", "cliente", "tipo", "descricao", "quantidade", "valor_unitario", "total", "tecnico", "situacao"],
                  ...(data?.items ?? []).map((i) => [
                    formatDate(i.created_at),
                    i.ticket.code,
                    i.ticket.customer?.name ?? "",
                    EXPENSE_KIND[i.kind].label,
                    i.description,
                    String(i.quantity).replace(".", ","),
                    i.unit_value.toFixed(2).replace(".", ","),
                    i.total.toFixed(2).replace(".", ","),
                    i.technician?.name ?? "",
                    EXPENSE_STATUS[i.status].label,
                  ]),
                ])
              }
            >
              <Download className="size-4" />
              Exportar CSV
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" aria-label="Mês" />
        <div className="w-full sm:w-56">
          <Select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} aria-label="Técnico">
            <option value="">Todos os técnicos</option>
            {(technicians.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-44">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus | "")} aria-label="Situação">
            <option value="">Todas as situações</option>
            {Object.entries(EXPENSE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {report.isLoading ? (
        <LoadingBlock />
      ) : report.error ? (
        <ErrorBox message={errorMessage(report.error)} />
      ) : !data || data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<Receipt className="size-6" />} title="Nenhum custo extra neste período" />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total no mês" value={formatMoney(data.total)} />
            <Stat label="A reembolsar (aprovado)" value={formatMoney(sums.approved)} tone="text-sky-700 dark:text-sky-300" />
            <Stat label="Reembolsado" value={formatMoney(sums.paid)} tone="text-emerald-700 dark:text-emerald-300" />
            <Stat label="Aguardando aprovação" value={formatMoney(sums.pending)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            <Card>
              <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
                <span className="text-sm text-ink-muted">
                  {selected.length ? `${selected.length} selecionado(s)` : `${data.items.length} lançamento(s)`}
                </span>
                <Button size="sm" variant="primary" disabled={!selected.length} loading={markPaid.isPending} onClick={() => markPaid.mutate()}>
                  <Check className="size-4" />
                  Marcar como reembolsado
                </Button>
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <input
                        type="checkbox"
                        aria-label="Selecionar aprovados"
                        checked={payable.length > 0 && selected.length === payable.length}
                        onChange={(e) => setSelected(e.target.checked ? payable.map((i) => i.id) : [])}
                      />
                    </Th>
                    <Th>OS</Th>
                    <Th>Custo</Th>
                    <Th className="hidden md:table-cell">Técnico</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Situação</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.id} className={clsx(i.status === "rejected" && "opacity-60")}>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Selecionar ${i.description}`}
                          disabled={i.status !== "approved"}
                          checked={selected.includes(i.id)}
                          onChange={(e) =>
                            setSelected((s) => (e.target.checked ? [...s, i.id] : s.filter((x) => x !== i.id)))
                          }
                        />
                      </Td>
                      <Td>
                        <Link href={`/chamados/${i.ticket.id}`} className="font-mono text-xs text-brand hover:underline">
                          {i.ticket.code}
                        </Link>
                        <span className="block max-w-48 truncate text-xs text-ink-muted">{i.ticket.customer?.name ?? i.ticket.title}</span>
                      </Td>
                      <Td>
                        <span className="block text-ink">{EXPENSE_KIND[i.kind].label}</span>
                        <span className="block max-w-56 truncate text-xs text-ink-muted">{i.description}</span>
                      </Td>
                      <Td className="hidden md:table-cell">{i.technician?.name ?? <span className="text-ink-muted">—</span>}</Td>
                      <Td className="text-right font-medium tabular-nums">{formatMoney(i.total)}</Td>
                      <Td>
                        <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", EXPENSE_STATUS[i.status].className)}>
                          {EXPENSE_STATUS[i.status].label}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>

            <div className="flex flex-col gap-4">
              <Card>
                <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">Por técnico</h2>
                <ul className="divide-y divide-line">
                  {data.by_technician.map((t) => (
                    <li key={t.technician?.id ?? "none"} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate text-ink">{t.technician?.name ?? "Custo da empresa"}</span>
                        <span className="text-xs text-ink-muted">
                          {t.count} lançamento(s){t.to_pay ? ` · a reembolsar ${formatMoney(t.to_pay)}` : ""}
                        </span>
                      </span>
                      <span className="font-medium tabular-nums">{formatMoney(t.total)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card>
                <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">Por tipo</h2>
                <ul className="divide-y divide-line">
                  {Object.entries(data.by_kind)
                    .sort((a, b) => b[1] - a[1])
                    .map(([kind, total]) => (
                      <li key={kind} className="flex justify-between px-4 py-2 text-sm">
                        <span className="text-ink">{kind}</span>
                        <span className="tabular-nums">{formatMoney(total)}</span>
                      </li>
                    ))}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={clsx("mt-1 text-xl font-semibold tabular-nums text-ink", tone)}>{value}</p>
    </Card>
  );
}

function KmRate({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "expenses"], queryFn: () => api.get<{ km_rate: number }>("/settings/expenses") });
  const [value, setValue] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (rate: string) => api.put("/settings/expenses", { km_rate: rate.replace(",", ".") }),
    onSuccess: () => {
      setValue(null);
      queryClient.invalidateQueries({ queryKey: ["settings", "expenses"] });
    },
  });
  if (!settings.data) return null;
  if (value === null) {
    return (
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => setValue(String(settings.data.km_rate).replace(".", ","))}
        className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted enabled:hover:border-brand enabled:hover:text-ink"
        title={canEdit ? "Alterar o valor do km" : "Só supervisor ou admin altera"}
      >
        Km: <span className="font-medium text-ink">{formatMoney(settings.data.km_rate)}</span>
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(value);
      }}
    >
      <span className="text-sm text-ink-muted">R$/km</span>
      <Input value={value} onChange={(e) => setValue(e.target.value)} className="w-20" inputMode="decimal" autoFocus />
      <Button size="sm" type="submit" variant="primary" loading={save.isPending}>
        Salvar
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setValue(null)}>
        Cancelar
      </Button>
    </form>
  );
}

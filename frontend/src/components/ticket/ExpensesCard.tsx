"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Lock, Paperclip, Pencil, Plus, Receipt, Trash2 } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Button, Card, CardHeader, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { EXPENSE_KIND, EXPENSE_STATUS } from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { useAssignable } from "@/lib/queries";
import type { Attachment, Expense, ExpenseKind, ExpenseStatus, TicketDetail } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

/** Custos extras da OS: material, km rodado, pedágio... Só a gestão lança e altera. */
export function ExpensesCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const manager = canManageTickets(user?.role);
  const invalidate = useInvalidateTicket(ticket.id);
  const onError = useTicketErrorHandler(ticket.id);
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const attachments = useQuery({
    queryKey: ["ticket", ticket.id, "attachments"],
    queryFn: () => api.get<Attachment[]>(`/tickets/${ticket.id}/attachments`),
    enabled: ticket.expenses.some((e) => e.receipt_attachment_id),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/expenses/${id}`),
    onSuccess: invalidate,
    onError,
  });
  const total = ticket.expenses.filter((e) => e.status !== "rejected").reduce((s, e) => s + e.total, 0);
  const receipt = (id: string | null) => (attachments.data ?? []).find((a) => a.id === id);

  return (
    <Card>
      <CardHeader
        title="Custos extras"
        description={
          manager
            ? "Material comprado, km rodado, pedágio... para reembolsar o técnico."
            : "Lançados pela gestão. O técnico vê, mas não altera."
        }
        actions={
          manager ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              Lançar
            </Button>
          ) : (
            <Lock className="size-4 text-ink-muted" aria-label="Somente leitura" />
          )
        }
      />
      {ticket.expenses.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-muted">Nenhum custo extra nesta OS.</p>
      ) : (
        <ul className="divide-y divide-line">
          {ticket.expenses.map((e) => {
            const kind = EXPENSE_KIND[e.kind];
            const file = receipt(e.receipt_attachment_id);
            return (
              <li key={e.id} className={clsx("flex items-start gap-3 px-4 py-2.5", e.status === "rejected" && "opacity-60")}>
                <Receipt className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    <span className="font-medium">{kind.label}</span> · {e.description}
                  </p>
                  <p className="text-xs text-ink-muted tabular-nums">
                    {e.quantity.toLocaleString("pt-BR")} {kind.unit} × {formatMoney(e.unit_value)}
                    {e.technician ? ` · reembolsar ${e.technician.name}` : ""}
                    {file?.download_url ? (
                      <a
                        href={absoluteApiUrl(file.download_url) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-1.5 inline-flex items-center gap-0.5 text-brand hover:underline"
                      >
                        <Paperclip className="size-3" />
                        comprovante
                      </a>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-sm font-medium text-ink tabular-nums">{formatMoney(e.total)}</span>
                  <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", EXPENSE_STATUS[e.status].className)}>
                    {EXPENSE_STATUS[e.status].label}
                  </span>
                </div>
                {manager ? (
                  <div className="flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      onClick={() => setEditing(e)}
                      className="rounded-md p-1 text-ink-muted hover:bg-surface-2 hover:text-ink"
                      aria-label="Editar custo"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={async () =>
                        (await confirm({
                          title: "Remover este custo?",
                          description: `“${e.description}” sai dos custos extras da OS.`,
                          confirmLabel: "Remover",
                          tone: "danger",
                        })) && remove.mutate(e.id)
                      }
                      className="rounded-md p-1 text-ink-muted hover:bg-surface-2 hover:text-red-600"
                      aria-label="Remover custo"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
          <li className="flex items-center justify-between bg-surface-2/60 px-4 py-2 text-sm">
            <span className="text-ink-muted">Total</span>
            <span className="font-semibold text-ink tabular-nums">{formatMoney(total)}</span>
          </li>
        </ul>
      )}
      {editing ? (
        <ExpenseDialog ticket={ticket} expense={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}

function ExpenseDialog({ ticket, expense, onClose }: { ticket: TicketDetail; expense: Expense | null; onClose: () => void }) {
  const invalidate = useInvalidateTicket(ticket.id);
  const people = useAssignable(null);
  const settings = useQuery({
    queryKey: ["settings", "expenses"],
    queryFn: () => api.get<{ km_rate: number }>("/settings/expenses"),
  });
  const attachments = useQuery({
    queryKey: ["ticket", ticket.id, "attachments"],
    queryFn: () => api.get<Attachment[]>(`/tickets/${ticket.id}/attachments`),
  });
  const [kind, setKind] = useState<ExpenseKind>(expense?.kind ?? "material");
  const [description, setDescription] = useState(expense?.description ?? "");
  const [quantity, setQuantity] = useState(expense ? String(expense.quantity) : "1");
  const [unitValue, setUnitValue] = useState(expense ? String(expense.unit_value) : "");
  const [technicianId, setTechnicianId] = useState(expense?.technician?.id ?? ticket.assignee?.id ?? "");
  const [status, setStatus] = useState<ExpenseStatus>(expense?.status ?? "pending");
  const [receiptId, setReceiptId] = useState(expense?.receipt_attachment_id ?? "");
  const [notes, setNotes] = useState(expense?.notes ?? "");
  const kmRate = settings.data?.km_rate;
  const effectiveUnit = unitValue === "" && kind === "km" ? kmRate : Number(unitValue.replace(",", "."));
  const total = (Number(quantity.replace(",", ".")) || 0) * (effectiveUnit || 0);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind,
        description,
        quantity: quantity.replace(",", "."),
        unit_value: unitValue === "" ? null : unitValue.replace(",", "."),
        technician_id: technicianId || null,
        status,
        notes: notes || null,
        receipt_attachment_id: receiptId || null,
      };
      return expense ? api.patch(`/expenses/${expense.id}`, body) : api.post(`/tickets/${ticket.id}/expenses`, body);
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={expense ? "Editar custo extra" : "Lançar custo extra"}
      description={`${ticket.code} · ${ticket.title}`}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Salvar · {formatMoney(total)}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tipo">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ExpenseKind)}>
            {Object.entries(EXPENSE_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Situação">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus)}>
            {Object.entries(EXPENSE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Descrição" required className="sm:col-span-2">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={kind === "km" ? "Ex.: Base → Loja 12 (ida e volta)" : "Ex.: Velcro 3 m"}
            maxLength={200}
          />
        </Field>
        <Field label={kind === "km" ? "Km rodados" : "Quantidade"}>
          <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" />
        </Field>
        <Field
          label={kind === "km" ? "Valor por km (R$)" : "Valor unitário (R$)"}
          hint={kind === "km" && kmRate !== undefined ? `Em branco: ${formatMoney(kmRate)}/km (Configurações)` : undefined}
        >
          <Input value={unitValue} onChange={(e) => setUnitValue(e.target.value)} inputMode="decimal" placeholder={kind === "km" ? String(kmRate ?? "") : "0,00"} />
        </Field>
        <Field label="Reembolsar a">
          <Select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
            <option value="">Ninguém (custo da empresa)</option>
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Comprovante (anexo da OS)">
          <Select value={receiptId} onChange={(e) => setReceiptId(e.target.value)}>
            <option value="">Sem comprovante</option>
            {(attachments.data ?? [])
              .filter((a) => a.kind !== "signature")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.filename}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Observações" className="sm:col-span-2">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {save.error ? (
          <div className="sm:col-span-2">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

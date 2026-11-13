"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Lock, Paperclip, Pencil, Plus, Receipt, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, Card, CardHeader, Dialog, ErrorBox, Field, Input, Pill, Select, Textarea } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { EXPENSE_KIND, EXPENSE_STATUS } from "@/lib/expenses";
import { formatDate, formatMoney, formatShort, moneyInput } from "@/lib/format";
import { useAssignable } from "@/lib/queries";
import { lineTotalCents, quantityInput, readDecimal } from "@/lib/quotes";
import type { Attachment, Expense, ExpenseKind, ExpenseStatus, TicketDetail } from "@/lib/types";
import { isViewableImage, uploadProblem, useTicketAttachments } from "./AttachmentsTab";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

const STATUS_DONE: Record<ExpenseStatus, string> = {
  pending: "Custo voltou para lançado",
  approved: "Custo aprovado",
  paid: "Reembolso registrado",
  rejected: "Custo recusado",
};

const sum = (list: Expense[]) => list.reduce((s, e) => s + Math.round(e.total * 100), 0) / 100;

/** Custos extras da OS: material, km rodado, pedágio... Só a gestão lança e altera. */
export function ExpensesCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();
  const manager = canManageTickets(user?.role);
  const invalidate = useInvalidateTicket(ticket.id);
  const onError = useTicketErrorHandler(ticket.id);
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const attachments = useTicketAttachments(
    ticket.id,
    ticket.expenses.some((e) => e.receipt_attachment_id),
  );
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/expenses/${id}`),
    onSuccess: () => {
      invalidate();
      toast({ title: "Custo removido", tone: "success" });
    },
    onError,
  });
  // Aprovar, recusar e reembolsar direto na linha (sem abrir o formulário).
  const setStatus = useMutation({
    mutationFn: ({ expense, status }: { expense: Expense; status: ExpenseStatus }) => api.patch<Expense>(`/expenses/${expense.id}`, { status }),
    onSuccess: (_, { status }) => {
      invalidate();
      toast({ title: STATUS_DONE[status], tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível mudar a situação", description: errorMessage(e), tone: "error" }),
  });
  const busy = (e: Expense, status: ExpenseStatus) =>
    setStatus.isPending && setStatus.variables?.expense.id === e.id && setStatus.variables.status === status;
  const total = sum(ticket.expenses.filter((e) => e.status !== "rejected"));
  const toReimburse = sum(ticket.expenses.filter((e) => e.status === "approved" && e.technician));
  const awaiting = sum(ticket.expenses.filter((e) => e.status === "pending"));
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
              <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-2.5">
                <Receipt className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    <span className="font-semibold">{kind.label}</span> · {e.description}
                  </p>
                  <p className="text-xs text-ink-muted tabular-nums">
                    {e.quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} {kind.unit} × {formatMoney(e.unit_value)}
                    {e.technician ? ` · reembolsar ${e.technician.name}` : " · custo da empresa"}
                    {file?.download_url ? (
                      <a
                        href={absoluteApiUrl(file.download_url) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-1.5 inline-flex items-center gap-0.5 text-brand hover:underline"
                        aria-label={`Abrir o comprovante de ${e.description}`}
                      >
                        <Paperclip className="size-3" />
                        comprovante
                      </a>
                    ) : null}
                  </p>
                  {e.status === "paid" && e.paid_at ? <p className="text-xs text-ink-muted">Reembolsado em {formatDate(e.paid_at)}</p> : null}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={clsx("text-sm font-medium tabular-nums", e.status === "rejected" ? "text-ink-muted line-through" : "text-ink")}>
                    {formatMoney(e.total)}
                  </span>
                  <Pill color={EXPENSE_STATUS[e.status].color}>{EXPENSE_STATUS[e.status].label}</Pill>
                </div>
                {manager ? (
                  <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
                    {e.status === "pending" ? (
                      <>
                        <Button size="sm" variant="ghost" loading={busy(e, "rejected")} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ expense: e, status: "rejected" })}>
                          Recusar
                        </Button>
                        <Button size="sm" loading={busy(e, "approved")} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ expense: e, status: "approved" })}>
                          {busy(e, "approved") ? null : <Check className="size-3.5" />}
                          Aprovar
                        </Button>
                      </>
                    ) : null}
                    {e.status === "approved" && e.technician ? (
                      <Button size="sm" loading={busy(e, "paid")} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ expense: e, status: "paid" })}>
                        Marcar reembolsado
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setEditing(e)}
                      className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                      aria-label={`Editar o custo ${e.description}`}
                      title="Editar"
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
                      className="rounded-md p-1.5 text-ink-muted hover:bg-surface-2 hover:text-red-600"
                      aria-label={`Remover o custo ${e.description}`}
                      title="Remover"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-surface-2/60 px-4 py-2 text-sm">
            <span className="text-xs text-ink-muted">
              A reembolsar <strong className="font-semibold text-ink tabular-nums">{formatMoney(toReimburse)}</strong>
              {awaiting ? (
                <>
                  {" "}
                  · aguardando aprovação <strong className="font-semibold text-ink tabular-nums">{formatMoney(awaiting)}</strong>
                </>
              ) : null}
            </span>
            <span className="text-ink-muted">
              Total <strong className="font-semibold text-ink tabular-nums">{formatMoney(total)}</strong>
            </span>
          </li>
        </ul>
      )}
      {editing ? (
        <ExpenseDialog ticket={ticket} expense={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}

const fieldError = "text-xs text-red-700 dark:text-red-400";
const invalidInput = "border-red-400 dark:border-red-500/60";

function ExpenseDialog({ ticket, expense, onClose }: { ticket: TicketDetail; expense: Expense | null; onClose: () => void }) {
  const invalidate = useInvalidateTicket(ticket.id);
  const confirm = useConfirm();
  const { toast } = useToast();
  const people = useAssignable(null);
  const settings = useQuery({
    queryKey: ["settings", "expenses"],
    queryFn: () => api.get<{ km_rate: number }>("/settings/expenses"),
  });
  const attachments = useTicketAttachments(ticket.id);
  const fileInput = useRef<HTMLInputElement>(null);
  // Valores iniciais no padrão brasileiro ("1,5"; "12,30"). Custo existente sem técnico continua da empresa.
  const [initial] = useState(() => ({
    kind: expense?.kind ?? ("material" as ExpenseKind),
    description: expense?.description ?? "",
    quantity: expense ? quantityInput(expense.quantity) : "1",
    unitValue: expense ? moneyInput(expense.unit_value) : "",
    technicianId: expense ? (expense.technician?.id ?? "") : (ticket.assignee?.id ?? ""),
    status: expense?.status ?? ("pending" as ExpenseStatus),
    receiptId: expense?.receipt_attachment_id ?? "",
    notes: expense?.notes ?? "",
  }));
  const [kind, setKind] = useState<ExpenseKind>(initial.kind);
  const [description, setDescription] = useState(initial.description);
  const [quantity, setQuantity] = useState(initial.quantity);
  const [unitValue, setUnitValue] = useState(initial.unitValue);
  const [technicianId, setTechnicianId] = useState(initial.technicianId);
  const [status, setStatus] = useState<ExpenseStatus>(initial.status);
  const [receiptId, setReceiptId] = useState(initial.receiptId);
  const [notes, setNotes] = useState(initial.notes);
  const [uploaded, setUploaded] = useState<Attachment | null>(null);
  const [tried, setTried] = useState(false);
  const kmRate = settings.data?.km_rate;

  const qty = readDecimal(quantity, { decimals: 3, emptyMessage: "Informe a quantidade" });
  // Km em branco usa o valor do km das Configurações.
  const usesRate = kind === "km" && unitValue.trim() === "";
  const unit = usesRate ? { value: kmRate ?? null, error: null } : readDecimal(unitValue, { decimals: 2, allowZero: true, emptyMessage: "Informe o valor" });
  const descriptionError = description.trim().length < 2 ? "Descreva o custo (pelo menos 2 letras)" : null;
  // Número que não dá para ler aparece na hora; o campo vazio, só ao salvar.
  const qtyError = qty.error && (tried || quantity.trim() !== "") ? qty.error : null;
  const unitError = unit.error && (tried || unitValue.trim() !== "") ? unit.error : null;
  const totalCents = qty.value !== null && unit.value !== null ? lineTotalCents(qty.value, unit.value) : 0;
  const invalid = Boolean(qty.error || unit.error || descriptionError);
  const dirty =
    JSON.stringify([kind, description, quantity, unitValue, technicianId, status, receiptId, notes]) !==
    JSON.stringify([initial.kind, initial.description, initial.quantity, initial.unitValue, initial.technicianId, initial.status, initial.receiptId, initial.notes]);

  // Comprovante: anexos da OS que não são foto de formulário nem assinatura (e o que acabou de subir).
  const receiptOptions = [
    ...(attachments.data ?? []).filter(
      (a) => a.kind !== "signature" && a.id !== ticket.signature_attachment_id && (!a.form_id || a.id === receiptId),
    ),
    ...(uploaded && !(attachments.data ?? []).some((a) => a.id === uploaded.id) ? [uploaded] : []),
  ];

  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind,
        description: description.trim(),
        quantity: String(qty.value),
        // Km em branco: no novo, a API usa o valor configurado; ao editar, vai o valor atual do km.
        unit_value: usesRate ? (expense && kmRate !== undefined ? String(kmRate) : null) : String(unit.value),
        technician_id: technicianId || null,
        status,
        notes: notes.trim() || null,
        receipt_attachment_id: receiptId || null,
      };
      return expense ? api.patch(`/expenses/${expense.id}`, body) : api.post(`/tickets/${ticket.id}/expenses`, body);
    },
    onSuccess: () => {
      invalidate();
      toast({ title: expense ? "Custo atualizado" : "Custo lançado", tone: "success" });
      onClose();
    },
  });
  // Comprovante enviado daqui entra como arquivo interno: fora do relatório do cliente e do app do técnico.
  const uploadReceipt = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "file");
      form.append("description", `Comprovante: ${description.trim() || EXPENSE_KIND[kind].label}`.slice(0, 500));
      return api.upload<Attachment>(`/tickets/${ticket.id}/attachments`, form);
    },
    onSuccess: (attachment) => {
      setUploaded(attachment);
      setReceiptId(attachment.id);
      invalidate();
    },
  });

  const submit = () => {
    setTried(true);
    if (!invalid) save.mutate();
  };
  const requestClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Descartar as alterações?",
        description: "O que você preencheu neste custo não foi salvo.",
        confirmLabel: "Descartar",
        tone: "danger",
      }))
    ) {
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onClose={requestClose}
      title={expense ? "Editar custo extra" : "Lançar custo extra"}
      description={`${ticket.code} · ${ticket.title}`}
      footer={
        <>
          <Button onClick={requestClose}>Cancelar</Button>
          <Button variant="primary" loading={save.isPending} disabled={Boolean(qtyError || unitError)} onClick={submit}>
            Salvar · {formatMoney(totalCents / 100)}
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
            aria-invalid={(tried && Boolean(descriptionError)) || undefined}
            className={tried && descriptionError ? invalidInput : undefined}
          />
          {tried && descriptionError ? <span className={fieldError}>{descriptionError}</span> : null}
        </Field>
        <Field label={kind === "km" ? "Km rodados" : "Quantidade"}>
          <Input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="decimal"
            aria-invalid={Boolean(qtyError) || undefined}
            className={qtyError ? invalidInput : undefined}
          />
          {qtyError ? <span className={fieldError}>{qtyError}</span> : null}
        </Field>
        <Field
          label={kind === "km" ? "Valor por km (R$)" : "Valor unitário (R$)"}
          hint={kind === "km" && kmRate !== undefined ? `Em branco: ${formatMoney(kmRate)}/km (Configurações)` : undefined}
        >
          <Input
            value={unitValue}
            onChange={(e) => setUnitValue(e.target.value)}
            inputMode="decimal"
            placeholder={kind === "km" && kmRate !== undefined ? moneyInput(kmRate) : "0,00"}
            aria-invalid={Boolean(unitError) || undefined}
            className={unitError ? invalidInput : undefined}
          />
          {unitError ? <span className={fieldError}>{unitError}</span> : null}
        </Field>
        <Field label="Reembolsar a" hint={technicianId ? undefined : "Custo da empresa: não entra no reembolso de ninguém."}>
          <Select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
            <option value="">Ninguém (custo da empresa)</option>
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {expense?.technician && !(people.data ?? []).some((p) => p.id === expense.technician?.id) ? (
              <option value={expense.technician.id}>{expense.technician.name}</option>
            ) : null}
          </Select>
        </Field>
        <div className="flex flex-col gap-1.5">
          <Field label="Comprovante (anexo da OS)">
            <Select value={receiptId} onChange={(e) => setReceiptId(e.target.value)}>
              <option value="">Sem comprovante</option>
              {receiptOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {isViewableImage(a) ? "Foto" : "Arquivo"} · {a.description || a.filename} · {formatShort(a.created_at)}
                </option>
              ))}
            </Select>
          </Field>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const problem = uploadProblem(file);
              if (problem) toast({ title: "Comprovante não enviado", description: `${file.name}: ${problem}.`, tone: "error" });
              else uploadReceipt.mutate(file);
            }}
          />
          <Button size="sm" variant="ghost" className="self-start" loading={uploadReceipt.isPending} onClick={() => fileInput.current?.click()}>
            {uploadReceipt.isPending ? null : <Upload className="size-3.5" />}
            Enviar comprovante
          </Button>
          {uploadReceipt.error ? <span className={fieldError}>{errorMessage(uploadReceipt.error)}</span> : null}
        </div>
        <Field label="Observações" className="sm:col-span-2">
          <Textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
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

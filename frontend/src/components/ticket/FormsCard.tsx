"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, CheckCircle2, ClipboardList, FileSignature, Lock, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { Button, Card, CardHeader, Checkbox, Dialog, ErrorBox, Field, Input, Select, Textarea } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, STATUS } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { Attachment, FormAnswer, FormField, FormTemplate, TicketDetail, TicketForm } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

const FORM_STATUS: Record<TicketForm["status"], { label: string; className: string }> = {
  pending: { label: "Não iniciado", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300" },
  in_progress: { label: "Em preenchimento", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  completed: { label: "Concluído", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
};

const questions = (form: TicketForm) => form.fields.filter((f) => f.type !== "section");

function answered(field: FormField, value: FormAnswer | undefined, photos: number): boolean {
  if (field.type === "photo") return photos >= Math.max(field.min_photos, 1);
  if (field.type === "confirm") return value === true;
  return value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

function useAttachments(ticketId: string) {
  return useQuery({
    queryKey: ["ticket", ticketId, "attachments"],
    queryFn: () => api.get<Attachment[]>(`/tickets/${ticketId}/attachments`),
  });
}

/** Formulários anexados à OS (a gestão decide) e a assinatura do responsável no local. */
export function FormsCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const manager = canManageTickets(user?.role);
  const invalidate = useInvalidateTicket(ticket.id);
  const onError = useTicketErrorHandler(ticket.id);
  const attachments = useAttachments(ticket.id);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const final = STATUS[ticket.status].final || ticket.status === "resolved";

  const photosOf = (formId: string) => (attachments.data ?? []).filter((a) => a.form_id === formId);
  const signature = (attachments.data ?? []).find((a) => a.id === ticket.signature_attachment_id);

  const toggleRequired = useMutation({
    mutationFn: (form: TicketForm) => api.patch(`/tickets/${ticket.id}/forms/${form.id}`, { required: !form.required }),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({
    mutationFn: (form: TicketForm) => api.delete(`/tickets/${ticket.id}/forms/${form.id}`),
    onSuccess: invalidate,
    onError,
  });
  const signatureRule = useMutation({
    mutationFn: (required: boolean) =>
      api.patch(`/tickets/${ticket.id}`, { signature_required: required, expected_version: ticket.version }),
    onSuccess: invalidate,
    onError,
  });

  if (!manager && ticket.forms.length === 0 && !ticket.signature_required) return null;
  const opened = ticket.forms.find((f) => f.id === openId) ?? null;

  return (
    <Card>
      <CardHeader
        title="Formulários e assinatura"
        description="O técnico preenche no app. A OS só é concluída com os obrigatórios prontos e a assinatura, quando exigida."
        actions={
          manager && !final ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              Adicionar
            </Button>
          ) : null
        }
      />
      <ul className="divide-y divide-line">
        {ticket.forms.length === 0 ? (
          <li className="px-4 py-4 text-sm text-ink-muted">Nenhum formulário nesta OS.</li>
        ) : (
          ticket.forms.map((form) => {
            const photos = photosOf(form.id);
            const qs = questions(form);
            const done = qs.filter((f) =>
              answered(f, form.answers[f.id], photos.filter((p) => p.field_id === f.id).length),
            ).length;
            const status = FORM_STATUS[form.status];
            return (
              <li key={form.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <ClipboardList className="size-4 shrink-0 text-ink-muted" />
                <button type="button" onClick={() => setOpenId(form.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-semibold text-ink hover:text-brand">{form.name}</span>
                  <span className="text-xs text-ink-muted">
                    {done}/{qs.length} respondidas · {photos.length} foto(s)
                    {form.completed_by ? ` · concluído por ${form.completed_by.name} em ${formatDateTime(form.completed_at)}` : ""}
                  </span>
                </button>
                <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", status.className)}>{status.label}</span>
                {manager && !final ? (
                  <button
                    type="button"
                    onClick={() => toggleRequired.mutate(form)}
                    className={clsx(
                      "rounded-full border px-2 py-0.5 text-xs font-medium",
                      form.required ? "border-brand/40 text-brand" : "border-line text-ink-muted",
                    )}
                    title="Clique para alternar"
                  >
                    {form.required ? "Obrigatório" : "Opcional"}
                  </button>
                ) : (
                  <span className="text-xs text-ink-muted">{form.required ? "Obrigatório" : "Opcional"}</span>
                )}
                {manager && !final ? (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Remover este formulário da OS?",
                        description: `“${form.name}” sai desta OS, com as respostas e as fotos dele.`,
                        confirmLabel: "Remover",
                        tone: "danger",
                      });
                      if (ok) remove.mutate(form);
                    }}
                    className="rounded-md p-1 text-ink-muted hover:bg-surface-2 hover:text-red-600"
                    aria-label={`Remover ${form.name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                ) : null}
              </li>
            );
          })
        )}
      </ul>

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <FileSignature className="size-4 shrink-0 text-ink-muted" />
        {ticket.signed_at ? (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {signature?.download_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- link assinado da API
              <img
                src={absoluteApiUrl(signature.download_url) ?? undefined}
                alt={`Assinatura de ${ticket.signer_name}`}
                className="h-12 w-28 rounded border border-line bg-white object-contain"
              />
            ) : null}
            <div className="min-w-0 text-sm">
              <p className="truncate font-semibold text-ink">
                {ticket.signer_name}
                {ticket.signer_role ? <span className="font-normal text-ink-muted"> · {ticket.signer_role}</span> : null}
              </p>
              <p className="text-xs text-ink-muted">Assinou em {formatDateTime(ticket.signed_at)}</p>
            </div>
          </div>
        ) : (
          <p className="min-w-0 flex-1 text-sm text-ink-muted">
            {ticket.signature_required
              ? "Assinatura do responsável no local: o técnico colhe no app, depois dos formulários obrigatórios."
              : "Assinatura do responsável no local: não exigida."}
          </p>
        )}
        {manager && !final && !ticket.signed_at ? (
          <Checkbox
            label="Exigir assinatura"
            checked={ticket.signature_required}
            onChange={(v) => signatureRule.mutate(v)}
          />
        ) : null}
      </div>

      {adding ? <AddFormDialog ticket={ticket} onClose={() => setAdding(false)} /> : null}
      {opened ? (
        <FormDialog
          ticket={ticket}
          form={opened}
          photos={photosOf(opened.id)}
          canFill={ticket.can_edit && (manager || !ticket.signed_at)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </Card>
  );
}

function AddFormDialog({ ticket, onClose }: { ticket: TicketDetail; onClose: () => void }) {
  const invalidate = useInvalidateTicket(ticket.id);
  const [templateId, setTemplateId] = useState("");
  const [required, setRequired] = useState(true);
  const templates = useQuery({
    queryKey: ["form-templates", "active"],
    queryFn: () => api.get<FormTemplate[]>("/form-templates", { active: true }),
  });
  const suggested = useQuery({
    queryKey: ["ticket", ticket.id, "form-suggestions"],
    queryFn: () => api.get<FormTemplate[]>(`/tickets/${ticket.id}/forms/suggestions`),
  });
  const attached = new Set(ticket.forms.map((f) => f.template_id));
  const add = useMutation({
    mutationFn: (id: string) => api.post(`/tickets/${ticket.id}/forms`, { template_id: id, required }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const available = (templates.data ?? []).filter((t) => !attached.has(t.id));

  return (
    <Dialog
      open
      onClose={onClose}
      title="Adicionar formulário à OS"
      description="O técnico vê o formulário no app e preenche no atendimento."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!templateId} loading={add.isPending} onClick={() => add.mutate(templateId)}>
            Adicionar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {(suggested.data ?? []).length ? (
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink/80">
              Sugeridos para {ticket.service_type?.name ?? "este tipo de serviço"}
            </p>
            <div className="flex flex-wrap gap-2">
              {(suggested.data ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(t.id)}
                  className={clsx(
                    "rounded-full border px-3 py-1 text-sm",
                    templateId === t.id ? "border-brand bg-brand text-white" : "border-line text-ink hover:border-brand",
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <Field label="Formulário">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Escolha um modelo...</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        {templates.data && templates.data.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nenhum modelo ainda. Crie em <a href="/formularios" className="text-brand hover:underline">Formulários</a>.
          </p>
        ) : null}
        <Checkbox
          label="Obrigatório: a OS só é concluída (e a assinatura só é colhida) com ele preenchido"
          checked={required}
          onChange={setRequired}
        />
        {add.error ? <ErrorBox message={errorMessage(add.error)} /> : null}
      </div>
    </Dialog>
  );
}

function FormDialog({
  ticket,
  form,
  photos,
  canFill,
  onClose,
}: {
  ticket: TicketDetail;
  form: TicketForm;
  photos: Attachment[];
  canFill: boolean;
  onClose: () => void;
}) {
  const invalidate = useInvalidateTicket(ticket.id);
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>(form.answers);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (complete: boolean) =>
      api.put<TicketForm>(`/tickets/${ticket.id}/forms/${form.id}/answers`, { answers, complete }),
    onSuccess: (_, complete) => {
      invalidate();
      setError(null);
      if (complete) onClose();
    },
    onError: (e) => {
      invalidate(); // as respostas foram gravadas mesmo quando falta algo para concluir
      setError(errorMessage(e));
    },
  });
  const upload = useMutation({
    mutationFn: ({ fieldId, file }: { fieldId: string; file: File }) => {
      const body = new FormData();
      body.append("file", file);
      body.append("field_id", fieldId);
      return api.upload(`/tickets/${ticket.id}/forms/${form.id}/photos`, body);
    },
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });
  const removePhoto = useMutation({
    mutationFn: (id: string) => api.delete(`/tickets/${ticket.id}/forms/${form.id}/photos/${id}`),
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });
  const set = (id: string, value: FormAnswer | undefined) =>
    setAnswers((a) => {
      const next = { ...a };
      if (value === undefined || value === "") delete next[id];
      else next[id] = value;
      return next;
    });

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={form.name}
      description={
        <span className="inline-flex items-center gap-2">
          <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", FORM_STATUS[form.status].className)}>
            {FORM_STATUS[form.status].label}
          </span>
          {form.required ? "Obrigatório" : "Opcional"}
          {!canFill ? (
            <span className="inline-flex items-center gap-1 text-xs">
              <Lock className="size-3" /> somente leitura
            </span>
          ) : null}
        </span>
      }
      footer={
        canFill ? (
          <>
            <Button onClick={onClose}>Fechar</Button>
            <Button loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>
              Salvar
            </Button>
            <Button variant="primary" loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>
              <CheckCircle2 className="size-4" />
              Concluir formulário
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Fechar</Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {form.fields.map((field) => {
          if (field.type === "section") {
            return (
              <h3 key={field.id} className="border-b border-line pb-1 text-xs font-bold tracking-wide text-ink-muted uppercase">
                {field.label}
              </h3>
            );
          }
          const fieldPhotos = photos.filter((p) => p.field_id === field.id);
          return (
            <div key={field.id} className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-ink/80">
                {field.label}
                {field.required || (field.type === "photo" && field.min_photos > 0) ? (
                  <span className="text-red-500"> *</span>
                ) : null}
              </span>
              {field.help ? <span className="-mt-1 text-xs text-ink-muted">{field.help}</span> : null}
              {field.type === "photo" ? (
                <PhotoField
                  field={field}
                  photos={fieldPhotos}
                  canFill={canFill}
                  uploading={upload.isPending && upload.variables?.fieldId === field.id}
                  onAdd={(file) => upload.mutate({ fieldId: field.id, file })}
                  onRemove={(id) => removePhoto.mutate(id)}
                />
              ) : canFill ? (
                <AnswerInput field={field} value={answers[field.id]} onChange={(v) => set(field.id, v)} />
              ) : (
                <p className="text-sm text-ink">{formatAnswer(field, form.answers[field.id])}</p>
              )}
            </div>
          );
        })}
        {error ? <ErrorBox message={error} /> : null}
        {ticket.signed_at && canFill ? (
          <p className="text-xs text-ink-muted">A assinatura já foi colhida: só a gestão altera este formulário.</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function formatAnswer(field: FormField, value: FormAnswer | undefined): string {
  if (value === undefined || value === "") return "—";
  if (typeof value === "boolean") return field.type === "confirm" ? (value ? "Confirmado" : "—") : value ? "Sim" : "Não";
  if (Array.isArray(value)) return value.join(", ");
  if (field.type === "date") return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR");
  return String(value);
}

function AnswerInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: FormAnswer | undefined;
  onChange: (v: FormAnswer | undefined) => void;
}) {
  switch (field.type) {
    case "textarea":
      return <Textarea rows={3} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return (
        <Input
          type="number"
          className="w-40"
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "date":
      return <Input type="date" className="w-48" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "yes_no":
      return (
        <div className="flex gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={value === v}
              onClick={() => onChange(value === v ? undefined : v)}
              className={clsx(
                "rounded-lg border px-4 py-1.5 text-sm",
                value === v ? "border-brand bg-brand text-white" : "border-line text-ink hover:border-brand",
              )}
            >
              {v ? "Sim" : "Não"}
            </button>
          ))}
        </div>
      );
    case "confirm":
      return <Checkbox label="Confirmo" checked={value === true} onChange={(v) => onChange(v ? true : undefined)} />;
    case "choice":
      return (
        <Select value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">Selecione...</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case "multi_choice": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-2">
          {field.options.map((o) => {
            const on = selected.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? selected.filter((s) => s !== o) : [...selected, o])}
                className={clsx(
                  "rounded-full border px-3 py-1 text-sm",
                  on ? "border-brand bg-brand text-white" : "border-line text-ink hover:border-brand",
                )}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return <Input value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

function PhotoField({
  field,
  photos,
  canFill,
  uploading,
  onAdd,
  onRemove,
}: {
  field: FormField;
  photos: Attachment[];
  canFill: boolean;
  uploading: boolean;
  onAdd: (file: File) => void;
  onRemove: (id: string) => void;
}) {
  const need = Math.max(field.min_photos, field.required ? 1 : 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {photos.map((p) => (
        <div key={p.id} className="group relative">
          <a href={absoluteApiUrl(p.download_url) ?? undefined} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element -- link assinado da API */}
            <img
              src={absoluteApiUrl(p.download_url) ?? undefined}
              alt={field.label}
              className="size-20 rounded-lg border border-line object-cover"
            />
          </a>
          {canFill ? (
            <button
              type="button"
              onClick={() => onRemove(p.id)}
              className="absolute -top-1.5 -right-1.5 hidden rounded-full bg-surface p-0.5 text-ink-muted shadow group-hover:block hover:text-red-600"
              aria-label="Remover foto"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
      {canFill && photos.length < field.max_photos ? (
        <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-xs text-ink-muted hover:border-brand hover:text-brand">
          <Camera className="size-5" />
          {uploading ? "Enviando..." : "Adicionar"}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onAdd(file);
            }}
          />
        </label>
      ) : null}
      <span className={clsx("text-xs", photos.length < need ? "text-amber-700 dark:text-amber-400" : "text-ink-muted")}>
        {photos.length}/{need > 0 ? `mín. ${need}` : "opcional"} · máx. {field.max_photos}
      </span>
    </div>
  );
}

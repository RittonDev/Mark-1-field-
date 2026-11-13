"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, CheckCircle2, ClipboardList, ExternalLink, FileSignature, FileText, Lock, Plus, Trash2, X } from "lucide-react";
import { useId, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { FILE_KIND_LABEL, fileKind, formAnchor } from "@/components/report/shared";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Card, CardHeader, Checkbox, Dialog, ErrorBox, Field, Input, Pill, Select, Textarea } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, STATUS } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { Attachment, FormAnswer, FormField, FormTemplate, TicketDetail, TicketForm } from "@/lib/types";
import { AttachmentImage, uploadProblem, useTicketAttachments } from "./AttachmentsTab";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

// Cinza: ninguém começou; azul: em preenchimento; verde: concluído.
const FORM_STATUS: Record<TicketForm["status"], { label: string; color: string }> = {
  pending: { label: "Não iniciado", color: "#64748b" },
  in_progress: { label: "Em preenchimento", color: "#2447ff" },
  completed: { label: "Concluído", color: "#10b981" },
};

/** Limite de texto da resposta (o mesmo da API). */
const TEXT_MAX = 5000;

const questions = (form: TicketForm) => form.fields.filter((f) => f.type !== "section");

function answered(field: FormField, value: FormAnswer | undefined, photos: number): boolean {
  if (field.type === "photo") return photos >= Math.max(field.min_photos, 1);
  if (field.type === "confirm") return value === true;
  return value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

/** Fotos que o campo exige para concluir (a mesma regra da API). */
const photosNeeded = (field: FormField) => Math.max(field.min_photos, field.required ? 1 : 0);

type Answers = Record<string, FormAnswer>;

const empty = (v: FormAnswer | undefined) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Mesma resposta: texto sem os espaços das pontas (como a API guarda) e múltipla escolha em qualquer ordem. */
function same(a: FormAnswer | undefined, b: FormAnswer | undefined): boolean {
  const norm = (v: FormAnswer | undefined) => (empty(v) ? undefined : typeof v === "string" ? v.trim() || undefined : v);
  const x = norm(a);
  const y = norm(b);
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v) => y.includes(v));
  return x === y;
}

/**
 * Só o que mudou desde a leitura. A API mexe apenas nas respostas enviadas: mandar tudo apagaria o que o
 * técnico respondeu no app enquanto o diálogo estava aberto; e a resposta apagada aqui vai como null.
 */
function changesOf(base: Answers, current: Answers): Record<string, FormAnswer | null> {
  const out: Record<string, FormAnswer | null> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (same(base[key], current[key])) continue;
    const value = current[key];
    out[key] = empty(value) ? null : typeof value === "string" ? value.trim() : value;
  }
  return out;
}

/** O que não foi mexido na tela passa a seguir o servidor; o que foi mexido continua como está. */
function rebase(current: Answers, base: Answers, server: Answers): Answers {
  const next = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(server)])) {
    if (!same(current[key], base[key])) continue;
    if (server[key] === undefined) delete next[key];
    else next[key] = server[key];
  }
  return next;
}

/** Formulários anexados à OS (a gestão decide) e a assinatura do responsável no local. */
export function FormsCard({ ticket }: { ticket: TicketDetail }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const manager = canManageTickets(user?.role);
  const invalidate = useInvalidateTicket(ticket.id);
  const onError = useTicketErrorHandler(ticket.id);
  const attachments = useTicketAttachments(ticket.id);
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
                <button type="button" onClick={() => setOpenId(form.id)} className="group min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-semibold text-ink group-hover:text-brand">{form.name}</span>
                  <span className="text-xs text-ink-muted">
                    {done}/{qs.length} respondidas · {photos.length} {photos.length === 1 ? "foto" : "fotos"}
                    {form.completed_by ? ` · concluído por ${form.completed_by.name} em ${formatDateTime(form.completed_at)}` : ""}
                  </span>
                </button>
                <Pill color={status.color}>{status.label}</Pill>
                {manager && !final ? (
                  <button
                    type="button"
                    onClick={() => toggleRequired.mutate(form)}
                    disabled={toggleRequired.isPending && toggleRequired.variables?.id === form.id}
                    aria-pressed={form.required}
                    aria-label={`${form.name}: obrigatório`}
                    className={clsx(
                      "rounded-full border px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-60",
                      form.required ? "border-brand/40 text-brand-ink" : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
                    )}
                    title={form.required ? "Obrigatório: clique para deixar opcional" : "Opcional: clique para tornar obrigatório"}
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
              <AttachmentImage
                attachment={signature}
                alt={`Assinatura de ${ticket.signer_name ?? "responsável"}`}
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
            disabled={signatureRule.isPending}
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
                  aria-pressed={templateId === t.id}
                  disabled={attached.has(t.id)}
                  title={attached.has(t.id) ? "Já está nesta OS" : undefined}
                  className={clsx(
                    "rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-50",
                    templateId === t.id
                      ? "border-brand bg-brand text-white dark:border-brand-strong dark:bg-brand-strong"
                      : "border-line text-ink hover:border-brand",
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
  const confirm = useConfirm();
  const { toast } = useToast();
  const uid = useId();
  // `base`: as respostas como estavam no servidor na última leitura; `answers`: o que está na tela.
  const [base, setBase] = useState<Answers>(form.answers);
  const [answers, setAnswers] = useState<Answers>(form.answers);
  const [error, setError] = useState<string | null>(null);
  // Depois da primeira tentativa de concluir, os campos que faltam ficam marcados (e saem ao preencher).
  const [checked, setChecked] = useState(false);
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const serverKey = JSON.stringify(form.answers);
  const [seenKey, setSeenKey] = useState(serverKey);
  if (serverKey !== seenKey) {
    // O técnico (ou outra pessoa) respondeu com o diálogo aberto: o que não foi mexido aqui segue o servidor.
    setSeenKey(serverKey);
    setAnswers(rebase(answers, base, form.answers));
    setBase(form.answers);
  }
  const changes = changesOf(base, answers);
  const dirty = Object.keys(changes).length > 0;
  const fieldPhotos = (fieldId: string) => photos.filter((p) => p.field_id === fieldId);
  // O que falta para concluir (a mesma regra da API): obrigatórios sem resposta e fotos abaixo do mínimo.
  const missingNow = () =>
    form.fields.filter((f) =>
      f.type === "section" ? false : f.type === "photo" ? fieldPhotos(f.id).length < photosNeeded(f) : f.required && !answered(f, answers[f.id], 0),
    );
  const lackingIds = new Set(checked ? missingNow().map((f) => f.id) : []);
  const domId = (fieldId: string) => `${uid}-${fieldId}`;

  const save = useMutation({
    mutationFn: ({ complete }: { complete: boolean; partial?: boolean }) =>
      api.put<TicketForm>(`/tickets/${ticket.id}/forms/${form.id}/answers`, { answers: changes, complete }),
    onSuccess: (saved, { complete, partial }) => {
      invalidate();
      setError(null);
      if (complete) {
        toast({ title: `${form.name} concluído`, tone: "success" });
        onClose();
        return;
      }
      setAnswers((current) => rebase(current, base, saved.answers));
      setBase(saved.answers);
      setSeenKey(JSON.stringify(saved.answers));
      if (!partial) toast({ title: "Respostas salvas", tone: "success" });
    },
    onError: (e) => {
      invalidate(); // ao concluir, as respostas são gravadas mesmo quando falta algo: a releitura acerta a tela
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
    onMutate: ({ fieldId }) => setUploading((u) => ({ ...u, [fieldId]: (u[fieldId] ?? 0) + 1 })),
    onSettled: (_data, _error, { fieldId }) => setUploading((u) => ({ ...u, [fieldId]: Math.max(0, (u[fieldId] ?? 1) - 1) })),
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });
  const removePhoto = useMutation({
    mutationFn: (id: string) => api.delete(`/tickets/${ticket.id}/forms/${form.id}/photos/${id}`),
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });
  const set = (field: FormField, value: FormAnswer | undefined) =>
    setAnswers((a) => {
      const next = { ...a };
      if (empty(value)) delete next[field.id];
      // Múltipla escolha na ordem das opções (a mesma da API).
      else next[field.id] = Array.isArray(value) ? field.options.filter((o) => value.includes(o)) : (value as FormAnswer);
      return next;
    });

  const requestClose = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Descartar as alterações?",
        description: "O que você respondeu aqui ainda não foi salvo.",
        confirmLabel: "Descartar",
        tone: "danger",
      }))
    ) {
      return;
    }
    onClose();
  };

  const askRemovePhoto = async (photo: Attachment, field: FormField, index: number) => {
    const ok = await confirm({
      title: "Remover esta foto?",
      description: `A foto ${index + 1} de “${field.label}” sai do formulário${form.status === "completed" ? ", que volta para Em preenchimento" : ""}. Não dá para desfazer.`,
      confirmLabel: "Remover",
      tone: "danger",
    });
    if (ok) removePhoto.mutate(photo.id);
  };

  // Concluir: confere aqui o que falta (marca os campos e leva até o primeiro); a API confere de novo.
  const finish = () => {
    const missing = missingNow();
    if (!missing.length) {
      save.mutate({ complete: true });
      return;
    }
    setChecked(true);
    setError(`Falta preencher: ${missing.map((f) => f.label).join("; ")}`);
    const first = document.getElementById(domId(missing[0].id));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    first?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    first?.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
    // O que já foi respondido não se perde: grava agora, sem concluir.
    if (dirty) {
      save.mutate({ complete: false, partial: true });
      toast({ title: "Respostas salvas", description: "Complete o que falta para concluir o formulário.", tone: "info" });
    }
  };

  const reportHref = ticket.report_link ? `${ticket.report_link.path}?preview=1#${formAnchor(form.name)}` : null;

  return (
    <Dialog
      open
      size="lg"
      onClose={requestClose}
      title={form.name}
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Pill color={FORM_STATUS[form.status].color}>{FORM_STATUS[form.status].label}</Pill>
          {form.required ? "Obrigatório" : "Opcional"}
          {!canFill ? (
            <span className="inline-flex items-center gap-1 text-xs">
              <Lock className="size-3" /> somente leitura
            </span>
          ) : null}
        </span>
      }
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {reportHref ? (
            <a href={reportHref} target="_blank" rel="noreferrer" className={buttonClassName("ghost", "md", "mr-auto")}>
              <ExternalLink className="size-4" />
              Ver no relatório do cliente
            </a>
          ) : null}
          {canFill ? (
            <>
              <Button onClick={requestClose}>Fechar</Button>
              <Button disabled={!dirty} loading={save.isPending && !save.variables?.complete} onClick={() => save.mutate({ complete: false })}>
                Salvar
              </Button>
              <Button variant="primary" loading={save.isPending && save.variables?.complete === true} onClick={finish}>
                <CheckCircle2 className="size-4" />
                Concluir formulário
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>Fechar</Button>
          )}
        </div>
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
          const invalid = lackingIds.has(field.id);
          return (
            <div
              key={field.id}
              id={domId(field.id)}
              className={clsx(
                "flex flex-col gap-1.5 rounded-lg",
                invalid && "-mx-2 bg-red-50/70 px-2 py-2 ring-1 ring-red-300 dark:bg-red-500/10 dark:ring-red-500/40",
              )}
            >
              <span className="text-sm font-semibold text-ink">
                {field.label}
                {field.required || (field.type === "photo" && field.min_photos > 0) ? <span className="text-red-500"> *</span> : null}
              </span>
              {field.help ? <span className="-mt-1 text-xs text-ink-muted">{field.help}</span> : null}
              {field.type === "photo" ? (
                <PhotoField
                  field={field}
                  photos={fieldPhotos(field.id)}
                  canFill={canFill}
                  uploading={(uploading[field.id] ?? 0) > 0}
                  onAdd={(file) => upload.mutate({ fieldId: field.id, file })}
                  onRemove={(photo, index) => askRemovePhoto(photo, field, index)}
                  onProblem={setError}
                />
              ) : canFill ? (
                <AnswerInput field={field} value={answers[field.id]} invalid={invalid} onChange={(v) => set(field, v)} />
              ) : (
                <p className="text-sm text-ink">{formatAnswer(field, form.answers[field.id])}</p>
              )}
              {invalid ? <span className="text-xs font-semibold text-red-700 dark:text-red-400">Obrigatório</span> : null}
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

const chipOn = "border-brand bg-brand text-white dark:border-brand-strong dark:bg-brand-strong";
const chipOff = "border-line text-ink hover:border-brand";

function AnswerInput({
  field,
  value,
  invalid,
  onChange,
}: {
  field: FormField;
  value: FormAnswer | undefined;
  invalid: boolean;
  onChange: (v: FormAnswer | undefined) => void;
}) {
  const invalidClass = invalid ? "border-red-400 dark:border-red-500/60" : undefined;
  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          rows={3}
          maxLength={TEXT_MAX}
          aria-invalid={invalid || undefined}
          className={invalidClass}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <Input
          type="number"
          inputMode="decimal"
          aria-invalid={invalid || undefined}
          className={clsx("w-40", invalidClass)}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <Input
          type="date"
          aria-invalid={invalid || undefined}
          className={clsx("w-48", invalidClass)}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "yes_no":
      return (
        <div className="flex gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={value === v}
              onClick={() => onChange(value === v ? undefined : v)}
              className={clsx("rounded-lg border px-4 py-1.5 text-sm transition-colors", value === v ? chipOn : chipOff)}
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
        <Select
          aria-invalid={invalid || undefined}
          className={invalidClass}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
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
                className={clsx("rounded-full border px-3 py-1 text-sm transition-colors", on ? chipOn : chipOff)}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return (
        <Input
          maxLength={TEXT_MAX}
          aria-invalid={invalid || undefined}
          className={invalidClass}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function PhotoField({
  field,
  photos,
  canFill,
  uploading,
  onAdd,
  onRemove,
  onProblem,
}: {
  field: FormField;
  photos: Attachment[];
  canFill: boolean;
  uploading: boolean;
  onAdd: (file: File) => void;
  onRemove: (photo: Attachment, index: number) => void;
  /** Arquivo recusado aqui mesmo (tamanho, formato, campo cheio). */
  onProblem: (message: string) => void;
}) {
  const need = photosNeeded(field);
  const room = field.max_photos - photos.length;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {photos.map((p, i) => {
        const url = absoluteApiUrl(p.download_url) ?? undefined;
        const kind = fileKind(p.filename, p.content_type);
        return (
          <div key={p.id} className="relative">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
              aria-label={`Abrir a foto ${i + 1} de ${field.label} em outra aba`}
            >
              {kind === "image" ? (
                <AttachmentImage attachment={p} alt={`Foto ${i + 1} de ${field.label}`} className="size-20 rounded-lg border border-line object-cover" />
              ) : (
                // PDF, vídeo ou HEIC guardados no campo de foto: o navegador não mostra como miniatura.
                <span className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-line bg-surface-2 text-[11px] font-semibold text-ink-muted">
                  <FileText className="size-5" />
                  {FILE_KIND_LABEL[kind]}
                </span>
              )}
            </a>
            {canFill ? (
              <button
                type="button"
                onClick={() => onRemove(p, i)}
                className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-line bg-surface text-ink-muted opacity-80 shadow-elev-1 transition-opacity hover:text-red-600 hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Remover a foto ${i + 1} de ${field.label}`}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
      {canFill && room > 0 ? (
        <label className="flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line text-xs text-ink-muted transition-colors focus-within:ring-2 focus-within:ring-brand/45 hover:border-brand hover:text-brand">
          <Camera className="size-5" />
          {uploading ? "Enviando..." : "Adicionar"}
          <input
            type="file"
            accept="image/*"
            multiple={room > 1}
            className="sr-only"
            aria-label={`Adicionar foto em ${field.label}`}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (picked.length > room) onProblem(`“${field.label}” aceita mais ${room} ${room === 1 ? "foto" : "fotos"}: as demais não foram enviadas.`);
              for (const file of picked.slice(0, room)) {
                const problem = uploadProblem(file);
                if (problem) onProblem(`${file.name}: ${problem}.`);
                else if (fileKind(file.name, file.type) !== "image") onProblem(`${file.name}: envie a foto em JPG ou PNG (HEIC não abre no navegador).`);
                else onAdd(file);
              }
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

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowLeft, ArrowUp, Camera, ChevronDown, Copy, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { FieldError, fold, plural, SearchField, UnsavedBar, useBeforeUnload } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Card, Checkbox, ErrorBox, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import type { FormField, FormFieldType, FormTemplate, ServiceType } from "@/lib/types";
import {
  ADD_ORDER,
  type Draft,
  hasProblems,
  invalidateForms,
  isChoice,
  LIMITS,
  newField,
  newId,
  payload,
  photoNeed,
  resumeDraft,
  retype,
  sameDraft,
  TYPE_LABEL,
  validate,
  writeStored,
} from "./draft";

type FocusTarget = "label" | "up" | "down";

/** Nome da pergunta para os botões ("Subir “Foto do rack”"), lido pelo leitor de tela. */
function nameOf(f: FormField, position: number) {
  const text = f.label.trim();
  if (text) return `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`;
  return `${f.type === "section" ? "a seção" : "a pergunta"} ${position}`;
}

/** Construtor do formulário: perguntas na ordem do app, prévia ao lado e rascunho que não se perde. */
export function FormEditor({
  editKey,
  template,
  serviceTypes,
  onLeave,
}: {
  editKey: string;
  /** Modelo salvo (null: formulário novo). */
  template: FormTemplate | null;
  serviceTypes: ServiceType[];
  /** Volta para a lista (quem chama decide entre voltar no histórico e trocar a URL). */
  onLeave: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  // Começa do rascunho guardado na aba (recarregou, voltou ou clicou no menu) ou do modelo salvo.
  const [{ initial, draft: start, restored }] = useState(() => resumeDraft(editKey, template));
  const [draft, setDraft] = useState(start);
  const [removed, setRemoved] = useState<{ field: FormField; index: number } | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const pendingFocus = useRef<{ id: string; target: FocusTarget } | "undo" | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const nameErrorId = useId();

  const dirty = !sameDraft(draft, initial);
  const problems = useMemo(() => validate(draft), [draft]);
  const invalid = showErrors && hasProblems(problems);
  const questions = draft.fields.filter((f) => f.type !== "section").length;
  const full = draft.fields.length >= LIMITS.fields;
  useBeforeUnload(dirty);

  // O rascunho fica guardado na aba até salvar ou descartar.
  useEffect(() => {
    writeStored({ key: editKey, initial, draft });
  }, [editKey, initial, draft]);

  // Foco depois de mexer na lista: a pergunta nova, o botão que moveu (ou o vizinho, se chegou na
  // ponta e ele desabilitou) ou o "Desfazer" da remoção. Sem isso o foco caía no <body>.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    if (pending === "undo") {
      undoButton.current?.focus();
      return;
    }
    const row = rows.current.get(pending.id);
    if (!row) return;
    const pick = (target: FocusTarget) => row.querySelector<HTMLInputElement | HTMLButtonElement>(`[data-focus="${target}"]`);
    const el = pick(pending.target);
    if (el && !el.disabled) el.focus();
    else pick(pending.target === "up" ? "down" : "up")?.focus();
  });

  const save = useMutation({
    mutationFn: () => {
      const body = payload(draft);
      return draft.id
        ? api.put<FormTemplate>(`/form-templates/${draft.id}`, body)
        : api.post<FormTemplate>("/form-templates", body);
    },
    onSuccess: (saved) => {
      invalidateForms(queryClient);
      writeStored(null);
      const newVersion = template !== null && saved.version !== template.version;
      toast({
        title: `Formulário “${saved.name}” salvo`,
        description: newVersion ? `Versão ${saved.version}: vale para as próximas OS; as que já têm o formulário seguem com a anterior.` : undefined,
        tone: "success",
      });
      onLeave();
    },
  });

  const setField = (id: string, patch: Partial<FormField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
  // Mudança na lista (incluir, mover, desfazer): o "Desfazer" da última remoção some.
  const reshape = (fields: FormField[], focus: { id: string; target: FocusTarget }) => {
    setDraft((d) => ({ ...d, fields }));
    setRemoved(null);
    pendingFocus.current = focus;
  };
  const insert = (index: number, field: FormField) =>
    reshape([...draft.fields.slice(0, index), field, ...draft.fields.slice(index)], { id: field.id, target: "label" });
  const move = (index: number, delta: -1 | 1) => {
    const j = index + delta;
    if (j < 0 || j >= draft.fields.length) return;
    const fields = [...draft.fields];
    [fields[index], fields[j]] = [fields[j], fields[index]];
    reshape(fields, { id: fields[j].id, target: delta < 0 ? "up" : "down" });
  };
  const remove = (index: number) => {
    const field = draft.fields[index];
    setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== field.id) }));
    setRemoved({ field, index });
    pendingFocus.current = "undo";
  };
  const undo = () => {
    if (!removed) return;
    const index = Math.min(removed.index, draft.fields.length);
    reshape([...draft.fields.slice(0, index), removed.field, ...draft.fields.slice(index)], { id: removed.field.id, target: "label" });
  };

  const trySave = () => {
    if (hasProblems(problems)) {
      setShowErrors(true);
      // Leva até o primeiro campo com problema (ou ao resumo, se o problema é do formulário todo).
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>('[data-form-editor] [aria-invalid="true"]') ?? summary.current;
        target?.scrollIntoView({ block: "center" });
        target?.focus({ preventScroll: true });
      });
      return;
    }
    save.mutate();
  };

  const leave = async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Descartar as alterações?",
        description: "As perguntas editadas ainda não foram salvas.",
        confirmLabel: "Descartar",
        cancelLabel: "Continuar editando",
        tone: "danger",
      }))
    ) {
      return;
    }
    writeStored(null);
    onLeave();
  };

  const badQuestions = Object.keys(problems.fields).length;
  const fixList = [problems.name ? "o nome" : null, badQuestions ? plural(badQuestions, "pergunta", "perguntas") : null]
    .filter(Boolean)
    .join(" e ");
  const summaryText = [fixList ? `Antes de salvar, corrija ${fixList}.` : null, ...problems.general].filter(Boolean).join(" ");
  const nameProblem = showErrors ? problems.name : undefined;
  const unsaved = dirty || !draft.id;

  return (
    <div className="mx-auto max-w-6xl" data-form-editor>
      <button
        type="button"
        onClick={leave}
        className="mb-3 inline-flex items-center gap-1 rounded-md text-sm text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
      >
        <ArrowLeft className="size-4" />
        Formulários
      </button>
      <PageHeader
        title={draft.id ? "Editar formulário" : "Novo formulário"}
        description={
          draft.id
            ? "As OS que já têm este formulário continuam com a versão anterior; as próximas recebem esta."
            : "Monte as perguntas na ordem em que o técnico vai responder."
        }
        actions={
          <>
            <Button onClick={leave}>Cancelar</Button>
            <Button variant="primary" loading={save.isPending} disabled={!unsaved} onClick={trySave}>
              Salvar formulário
            </Button>
          </>
        }
      />
      {restored ? (
        <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink-muted">
          Recuperamos as alterações que ainda não tinham sido salvas. Salve ou descarte quando terminar.
        </p>
      ) : null}
      <div ref={summary} tabIndex={-1} className="outline-none">
        {invalid ? (
          <div className="mb-4">
            <ErrorBox message={summaryText} />
          </div>
        ) : null}
        {save.error ? (
          <div className="mb-4">
            <ErrorBox message={errorMessage(save.error)} />
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Nome" required className="sm:col-span-2">
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Ex.: Preventiva de rack"
                maxLength={LIMITS.name}
                aria-invalid={nameProblem ? true : undefined}
                aria-describedby={nameProblem ? nameErrorId : undefined}
              />
              {nameProblem ? <FieldError id={nameErrorId}>{nameProblem}</FieldError> : null}
            </Field>
            <Field label="Descrição" className="sm:col-span-2" hint="Para a equipe: quando usar este formulário.">
              <Textarea
                rows={2}
                value={draft.description}
                maxLength={LIMITS.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </Field>
            <div className="sm:col-span-2">
              <ServiceTypePicker
                types={serviceTypes}
                value={draft.service_type_ids}
                onChange={(ids) => setDraft((d) => ({ ...d, service_type_ids: ids }))}
              />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Checkbox
                label="Pedir a assinatura do responsável no local depois deste formulário (quando ele for obrigatório na OS)"
                checked={draft.requires_signature}
                onChange={(v) => setDraft((d) => ({ ...d, requires_signature: v }))}
              />
              <Checkbox
                label="Ativo: aparece para anexar nas OS"
                checked={draft.is_active}
                onChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
              />
            </div>
          </Card>

          <Card>
            <ol className="divide-y divide-line">
              {draft.fields.map((f, i) => {
                const n = i + 1;
                const p = showErrors ? problems.fields[f.id] : undefined;
                const section = f.type === "section";
                const errId = `${f.id}-erro`;
                const lastQuestion = !section && questions === 1;
                return (
                  <FieldRow
                    key={f.id}
                    rowRef={(el) => {
                      if (el) rows.current.set(f.id, el);
                      else rows.current.delete(f.id);
                    }}
                    before={
                      removed && removed.index === i ? (
                        <RemovedNotice field={removed.field} onUndo={undo} buttonRef={undoButton} />
                      ) : null
                    }
                    section={section}
                  >
                    <span className="mt-2 w-6 shrink-0 text-right text-xs font-semibold text-ink-muted tabular-nums">{n}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex flex-wrap gap-2">
                        <div className="w-40 shrink-0">
                          <Select
                            value={f.type}
                            aria-label={`Tipo da ${section ? "seção" : "pergunta"} ${n}`}
                            onChange={(e) => {
                              const type = e.target.value as FormFieldType;
                              setDraft((d) => ({ ...d, fields: d.fields.map((x) => (x.id === f.id ? retype(x, type) : x)) }));
                            }}
                          >
                            {ADD_ORDER.map((t) => (
                              <option key={t} value={t}>
                                {TYPE_LABEL[t]}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Input
                          data-focus="label"
                          className="min-w-48 flex-1"
                          value={f.label}
                          maxLength={LIMITS.label}
                          onChange={(e) => setField(f.id, { label: e.target.value })}
                          placeholder={section ? "Título da seção" : "Escreva a pergunta"}
                          aria-label={`Texto da ${section ? "seção" : "pergunta"} ${n}`}
                          aria-invalid={p?.label ? true : undefined}
                          aria-describedby={p?.label ? `${errId}-texto` : undefined}
                        />
                      </div>
                      {p?.label ? <FieldError id={`${errId}-texto`}>{p.label}</FieldError> : null}
                      <Input
                        value={f.help ?? ""}
                        maxLength={LIMITS.help}
                        onChange={(e) => setField(f.id, { help: e.target.value || null })}
                        placeholder={section ? "Orientação da seção (opcional)" : "Orientação para o técnico (opcional)"}
                        aria-label={`Orientação da ${section ? "seção" : "pergunta"} ${n}`}
                        className="h-8 text-xs"
                      />
                      {isChoice(f.type) ? (
                        <>
                          <Textarea
                            rows={Math.min(8, Math.max(3, f.options.length + 1))}
                            value={f.options.join("\n")}
                            onChange={(e) => setField(f.id, { options: e.target.value.split("\n") })}
                            placeholder="Uma opção por linha"
                            aria-label={`Opções da pergunta ${n}, uma por linha`}
                            aria-invalid={p?.options ? true : undefined}
                            aria-describedby={p?.options ? `${errId}-opcoes` : undefined}
                            className="text-xs"
                          />
                          {p?.options ? <FieldError id={`${errId}-opcoes`}>{p.options}</FieldError> : null}
                        </>
                      ) : null}
                      {section ? null : (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                          <RowCheck
                            checked={f.type === "photo" ? photoNeed(f) > 0 : f.required}
                            label={`Obrigatória (pergunta ${n})`}
                            onChange={(v) =>
                              setField(
                                f.id,
                                f.type === "photo" ? { required: v, min_photos: v ? Math.max(1, f.min_photos) : 0 } : { required: v },
                              )
                            }
                          >
                            Obrigatória
                          </RowCheck>
                          {f.type === "photo" ? (
                            <>
                              <span className="inline-flex items-center gap-1.5">
                                <span className="font-semibold text-ink/80">Mínimo</span>
                                <NumberInput
                                  value={photoNeed(f)}
                                  min={0}
                                  max={LIMITS.minPhotos}
                                  label={`Mínimo de fotos da pergunta ${n} (0 = opcional)`}
                                  invalid={!!p?.photos}
                                  describedBy={p?.photos ? `${errId}-fotos` : undefined}
                                  onChange={(v) => setField(f.id, { min_photos: v, required: v > 0 })}
                                />
                              </span>
                              <span className="inline-flex items-center gap-1.5">
                                <span className="font-semibold text-ink/80">Máximo</span>
                                <NumberInput
                                  value={f.max_photos}
                                  min={1}
                                  max={LIMITS.maxPhotos}
                                  label={`Máximo de fotos da pergunta ${n}`}
                                  invalid={!!p?.photos}
                                  describedBy={p?.photos ? `${errId}-fotos` : undefined}
                                  onChange={(v) => setField(f.id, { max_photos: v })}
                                />
                              </span>
                              <span className="text-ink-muted">{photoNeed(f) > 0 ? "O técnico só conclui com as fotos mínimas." : "Fotos opcionais."}</span>
                            </>
                          ) : null}
                        </div>
                      )}
                      {p?.photos ? <FieldError id={`${errId}-fotos`}>{p.photos}</FieldError> : null}
                    </div>
                    <div className="flex shrink-0 flex-col gap-0.5">
                      <IconButton focusKey="up" label={`Subir ${nameOf(f, n)}`} onClick={() => move(i, -1)} disabled={i === 0}>
                        <ArrowUp className="size-3.5" />
                      </IconButton>
                      <IconButton
                        focusKey="down"
                        label={`Descer ${nameOf(f, n)}`}
                        onClick={() => move(i, 1)}
                        disabled={i === draft.fields.length - 1}
                      >
                        <ArrowDown className="size-3.5" />
                      </IconButton>
                      <IconButton label={`Inserir pergunta abaixo de ${nameOf(f, n)}`} onClick={() => insert(i + 1, newField("text"))} disabled={full}>
                        <Plus className="size-3.5" />
                      </IconButton>
                      <IconButton label={`Duplicar ${nameOf(f, n)}`} onClick={() => insert(i + 1, { ...f, id: newId() })} disabled={full}>
                        <Copy className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label={lastQuestion ? "O formulário precisa de pelo menos uma pergunta" : `Remover ${nameOf(f, n)}`}
                        danger
                        onClick={() => remove(i)}
                        disabled={lastQuestion || draft.fields.length === 1}
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </div>
                  </FieldRow>
                );
              })}
              {removed && removed.index >= draft.fields.length ? (
                <li>
                  <RemovedNotice field={removed.field} onUndo={undo} buttonRef={undoButton} />
                </li>
              ) : null}
            </ol>
            <div className="flex flex-wrap items-center gap-1.5 border-t border-line p-3">
              <span className="mr-1 text-xs font-semibold text-ink/80">Adicionar no fim:</span>
              {ADD_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={full}
                  onClick={() => insert(draft.fields.length, newField(t))}
                  className={buttonClassName("secondary", "sm", "h-7 px-2.5")}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
              <p className="mt-1 w-full text-xs text-ink-muted">
                {full
                  ? `Chegou ao limite de ${LIMITS.fields} perguntas e seções.`
                  : "Para pôr uma pergunta no meio, use o + da pergunta de cima. Depois é só trocar o tipo."}
              </p>
            </div>
          </Card>
        </div>

        <PhonePreview draft={draft} />
      </div>

      {unsaved ? (
        <UnsavedBar message={draft.id ? "Alterações não salvas" : "Formulário novo, ainda não salvo"}>
          <Button variant="ghost" onClick={leave}>
            {dirty ? "Descartar" : "Cancelar"}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={trySave}>
            Salvar formulário
          </Button>
        </UnsavedBar>
      ) : null}
    </div>
  );
}

function FieldRow({
  rowRef,
  before,
  section,
  children,
}: {
  rowRef: (el: HTMLLIElement | null) => void;
  before: React.ReactNode;
  section: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {before ? <li>{before}</li> : null}
      <li ref={rowRef} className={clsx("flex gap-3 p-3", section && "bg-surface-2/60")}>
        {children}
      </li>
    </>
  );
}

function RemovedNotice({
  field,
  onUndo,
  buttonRef,
}: {
  field: FormField;
  onUndo: () => void;
  buttonRef: React.Ref<HTMLButtonElement>;
}) {
  const what = field.type === "section" ? "Seção removida" : "Pergunta removida";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-surface-2/60 px-4 py-2 text-sm text-ink-muted" role="status">
      <span className="min-w-0 truncate">
        {what}
        {field.label.trim() ? `: “${field.label.trim()}”` : ""}
      </span>
      <Button ref={buttonRef} size="sm" variant="ghost" onClick={onUndo}>
        Desfazer
      </Button>
    </div>
  );
}

/** Número curto (fotos): texto livre enquanto digita; fora do campo volta ao valor válido. */
function NumberInput({
  value,
  min,
  max,
  label,
  invalid,
  describedBy,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  invalid: boolean;
  describedBy?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      inputMode="numeric"
      value={text ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (!/^\d{0,3}$/.test(raw)) return;
        setText(raw);
        if (raw) onChange(Math.min(max, Math.max(min, Number(raw))));
      }}
      onBlur={() => setText(null)}
      aria-label={label}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      className="h-7 w-14 px-2 text-center text-xs tabular-nums"
    />
  );
}

/** "Obrigatória" de cada pergunta, com o número no nome acessível (todas as linhas têm a mesma caixa). */
function RowCheck({
  checked,
  label,
  onChange,
  children,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 font-semibold text-ink/80 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        className="size-4 rounded border-line accent-[var(--brand)]"
      />
      {children}
    </label>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  focusKey,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  focusKey?: FocusTarget;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      data-focus={focusKey}
      className={clsx(
        "inline-flex size-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-30",
        "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
        danger ? "hover:text-red-600 dark:hover:text-red-400" : "hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** "Sugerir nas OS destes tipos": busca entre todos os tipos e os escolhidos à vista. */
function ServiceTypePicker({
  types,
  value,
  onChange,
}: {
  types: ServiceType[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const titleId = useId();
  const listId = useId();
  const byId = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const labelOf = (t: ServiceType) =>
    `${t.name}${t.customer ? ` · ${t.customer.name}` : ""}${t.is_active ? "" : " (inativo)"}`;
  // Tipos ativos e os inativos que já estavam escolhidos (para poder ver e tirar).
  const options = useMemo(() => {
    const q = fold(search.trim());
    return types.filter(
      (t) =>
        (t.is_active || value.includes(t.id)) &&
        (!q || fold(`${t.name} ${t.customer?.name ?? ""}`).includes(q)),
    );
  }, [types, value, search]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={titleId} className="text-xs font-semibold text-ink/80">
          Sugerir nas OS destes tipos de serviço
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={listId}>
          <ChevronDown className={clsx("size-3.5 transition-transform duration-150", open && "rotate-180")} />
          {open ? "Fechar a lista" : "Escolher tipos"}
        </Button>
      </div>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-labelledby={titleId}>
          {value.map((id) => {
            const t = byId.get(id);
            const text = t ? labelOf(t) : "Tipo removido do catálogo";
            return (
              <li key={id}>
                <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-0.5 pr-1 pl-2.5 text-xs font-medium text-ink">
                  {text}
                  <button
                    type="button"
                    onClick={() => toggle(id)}
                    aria-label={`Remover ${text}`}
                    className="rounded-full p-0.5 text-ink-muted hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-ink-muted">
          Nenhum tipo escolhido: o formulário só entra na OS quando alguém anexar.
        </p>
      )}
      {open ? (
        <div id={listId} className="flex flex-col gap-2">
          <SearchField value={search} onChange={setSearch} placeholder="Buscar tipo ou cliente" label="Buscar tipo de serviço" />
          <div role="group" aria-labelledby={titleId} className="max-h-60 overflow-y-auto rounded-lg border border-line py-1">
            {options.length === 0 ? (
              <p className="px-3 py-2 text-xs text-ink-muted">Nenhum tipo encontrado.</p>
            ) : (
              options.map((t) => (
                <label
                  key={t.id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(t.id)}
                    onChange={() => toggle(t.id)}
                    className="size-4 shrink-0 rounded border-line accent-[var(--brand)]"
                  />
                  <span className="min-w-0 truncate">{labelOf(t)}</span>
                </label>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Como o técnico vê no app (mesmos textos e marcas de components/forms/FieldInput do app). */
function PhonePreview({ draft }: { draft: Draft }) {
  return (
    <aside className="lg:sticky lg:top-20 lg:self-start" aria-label="Prévia no app do técnico">
      <p className="mb-2 text-xs font-bold tracking-wide text-ink-muted uppercase">Como o técnico vê</p>
      <div className="rounded-[1.75rem] border-8 border-ink/85 bg-canvas p-3 shadow-sm dark:border-black">
        <div className="max-h-[32rem] overflow-y-auto rounded-xl bg-surface p-3">
          <p className="text-sm font-bold text-ink">{draft.name.trim() || "Sem nome"}</p>
          <div className="mt-3 flex flex-col gap-3">
            {draft.fields.map((f) =>
              f.type === "section" ? (
                <div key={f.id} className="border-b border-line pb-1">
                  <p className="text-[11px] font-bold tracking-wide text-ink-muted uppercase">{f.label.trim() || "Seção"}</p>
                  {f.help?.trim() ? <p className="text-[11px] text-ink-muted">{f.help}</p> : null}
                </div>
              ) : (
                <div key={f.id}>
                  <p className="text-xs font-semibold text-ink">
                    {f.label.trim() || "Pergunta sem texto"}
                    {(f.type === "photo" ? photoNeed(f) > 0 : f.required) ? (
                      <span className="text-red-600 dark:text-red-400"> *</span>
                    ) : null}
                  </p>
                  {f.help?.trim() ? <p className="text-[11px] text-ink-muted">{f.help}</p> : null}
                  <PreviewControl f={f} />
                </div>
              ),
            )}
          </div>
          <div className="mt-4 rounded-lg bg-brand py-2 text-center text-xs font-semibold text-white dark:bg-brand-strong">
            Concluir formulário
          </div>
          {draft.requires_signature ? (
            <p className="mt-2 text-center text-[11px] text-ink-muted">Depois: assinatura do responsável no local</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function PreviewControl({ f }: { f: FormField }) {
  const box = "mt-1 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[11px] text-ink-subtle";
  switch (f.type) {
    case "photo": {
      const need = photoNeed(f);
      return (
        <div className="mt-1">
          <div className="flex gap-1.5">
            {Array.from({ length: Math.min(Math.max(need, 1), 3) }, (_, i) => (
              <span
                key={i}
                className="flex size-10 items-center justify-center rounded-md border border-dashed border-line-strong text-ink-muted"
              >
                <Camera className="size-3.5" />
              </span>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">
            {need ? `mín. ${need}` : "opcional"} · máx. {f.max_photos}
          </p>
        </div>
      );
    }
    case "yes_no":
      return (
        <div className="mt-1 flex gap-1.5">
          <span className={clsx(box, "mt-0 flex-1 text-center text-ink")}>Sim</span>
          <span className={clsx(box, "mt-0 flex-1 text-center text-ink")}>Não</span>
        </div>
      );
    case "choice":
    case "multi_choice": {
      const multi = f.type === "multi_choice";
      const options = f.options.map((o) => o.trim()).filter(Boolean);
      const more = options.length - 4;
      return (
        <div className="mt-1 flex flex-col gap-1">
          {multi ? <p className="text-[11px] text-ink-muted">Pode marcar mais de uma.</p> : null}
          {options.slice(0, 4).map((o, i) => (
            <span key={i} className="flex items-center gap-1.5 text-[11px] text-ink">
              <span aria-hidden className={clsx("size-3 shrink-0 border border-line-strong", multi ? "rounded-[3px]" : "rounded-full")} />
              {o}
            </span>
          ))}
          {more > 0 ? <span className="text-[11px] text-ink-muted">+{plural(more, "opção", "opções")}</span> : null}
        </div>
      );
    }
    case "confirm":
      return (
        <p className={clsx(box, "flex items-center gap-1.5 text-ink")}>
          <span aria-hidden className="size-3 shrink-0 rounded-[3px] border border-line-strong" />
          Confirmo
        </p>
      );
    case "date":
      return <p className={box}>dd/mm/aaaa</p>;
    case "number":
      return <p className={box}>0</p>;
    case "textarea":
      return <p className={clsx(box, "h-12")}>Digite aqui</p>;
    default:
      return <p className={box}>Digite aqui</p>;
  }
}

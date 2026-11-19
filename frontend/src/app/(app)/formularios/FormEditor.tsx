"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowLeft, ArrowUp, Camera, ChevronDown, Copy, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { FieldError, fold, plural, SearchField, UnsavedBar } from "@/components/settings/shared";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Card, Checkbox, ErrorBox, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { api, ApiError, errorMessage, request } from "@/lib/api";
import { useUnsavedChanges } from "@/lib/hooks";
import type { Category, FormField, FormFieldType, FormPrefill, FormTemplate, FormTemplateUsage, ServiceType } from "@/lib/types";
import {
  ADD_ORDER,
  changesLinks,
  changesTickets,
  type Draft,
  hasProblems,
  invalidateForms,
  isChoice,
  LIMITS,
  newField,
  newId,
  payload,
  photoNeed,
  PREFILL_LABEL,
  prefillOf,
  prefillSources,
  resumeDraft,
  retype,
  sameDraft,
  TYPE_LABEL,
  validate,
  writeStored,
} from "./draft";

// Campos e botões de uma pergunta que recebem o foco de volta depois de mover (data-focus).
type FocusTarget = "label" | "help" | "options" | "up" | "down";
const FOCUS_TARGETS: readonly string[] = ["label", "help", "options", "up", "down"];

/** "1 OS que ainda não começou", "3 OS que ainda não começaram". */
const notStarted = (n: number) => `${n.toLocaleString("pt-BR")} OS que ainda não ${n === 1 ? "começou" : "começaram"}`;

/** Com "Levar também...", o servidor passa por cada OS que ainda não começou: com muitas, leva mais que os 30 s de sempre. */
const APPLY_TIMEOUT_MS = 120_000;

/**
 * Aviso depois de salvar: a versão nova e, quando pedido ("Levar também..."), as OS que receberam a mudança
 * das perguntas (`fields`) e aquelas em que o formulário entrou ou de que saiu pelos vínculos (`links`).
 */
function savedDescription(saved: FormTemplate, newVersion: boolean, asked: { fields: boolean; links: boolean }): string | undefined {
  const parts: string[] = [];
  const applied = saved.applied_to;
  if (!asked.fields || applied === undefined || applied === null) {
    if (newVersion) parts.push(`Versão ${saved.version}: vale para as próximas OS; as que já têm o formulário seguem com a anterior.`);
  } else {
    const reached =
      applied === 0
        ? "Nenhuma OS aberta estava com ele sem começar."
        : applied === 1
          ? "A OS em que ele ainda não tinha começado também recebeu a mudança."
          : `As ${applied.toLocaleString("pt-BR")} OS em que ele ainda não tinha começado também receberam a mudança.`;
    parts.push(newVersion ? `Versão ${saved.version}. ${reached} As que já começaram seguem com a anterior.` : reached);
  }
  if (asked.links) {
    const attached = saved.attached_to ?? 0;
    const detached = saved.detached_from ?? 0;
    parts.push(
      attached && detached
        ? `Entrou em ${notStarted(attached)} e saiu de ${detached.toLocaleString("pt-BR")}.`
        : attached
          ? `Entrou em ${notStarted(attached)}.`
          : detached
            ? `Saiu de ${notStarted(detached)}.`
            : "Nenhuma OS que ainda não começou precisou mudar.",
    );
  }
  return parts.length ? parts.join(" ") : undefined;
}

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
  categories,
  onLeave,
}: {
  editKey: string;
  /** Modelo salvo (null: formulário novo). */
  template: FormTemplate | null;
  /** Catálogo de tipos de serviço (null: não carregou; os tipos já ligados continuam ligados). */
  serviceTypes: ServiceType[] | null;
  /** Categorias (null: não carregou; as já ligadas continuam ligadas). */
  categories: Category[] | null;
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
  // Levar a mudança também às OS que ainda não começaram: as perguntas novas onde o formulário não foi
  // começado, e os vínculos (entra onde passou a casar e sai de onde entrou sozinho e não casa mais).
  const [applyPending, setApplyPending] = useState(false);
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
  // Perguntas ou nome mudaram num modelo salvo, ou os tipos de OS e as categorias em que ele entra mudaram
  // (num formulário novo, ter algum): dá para levar a mudança às OS que ainda não começaram.
  const reachesTickets = template !== null && changesTickets(draft, initial);
  const linksMoved = changesLinks(draft, template ? initial : null);
  const offerApply = reachesTickets || linksMoved;
  // Fechar a aba ou sair da central pergunta antes (o rascunho da aba volta ao recarregar ou ao voltar).
  useUnsavedChanges(dirty);

  // O editor abre no topo (nome e descrição à vista), mesmo vindo de um formulário lá embaixo na lista.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

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
    // `overwrite`: a pessoa confirmou salvar por cima da versão que outra pessoa salvou.
    mutationFn: async ({ overwrite = false }: { overwrite?: boolean }) => {
      const body = payload(draft);
      const apply = applyPending && offerApply;
      const asked = { fields: apply && reachesTickets, links: apply && linksMoved };
      const timeoutMs = apply ? APPLY_TIMEOUT_MS : undefined;
      try {
        const saved = draft.id
          ? await request<FormTemplate>(`/form-templates/${draft.id}`, {
              method: "PUT",
              // A API recusa (409) se o modelo mudou depois da versão de onde o rascunho saiu.
              body: { ...body, base_updated_at: overwrite ? null : (draft.updated_at ?? null) },
              query: { apply_to_pending: apply },
              timeoutMs,
            })
          : await request<FormTemplate>("/form-templates", { method: "POST", body, query: { apply_to_pending: apply }, timeoutMs });
        return { saved, asked };
      } catch (e) {
        // A tela desistiu de esperar, mas o servidor segue levando a mudança às OS e grava no fim: salvar de novo na
        // hora daria "Outra pessoa salvou".
        if (apply && e instanceof ApiError && (e.status === 408 || e.status === 504)) {
          throw new ApiError(e.status, "O servidor ainda pode estar levando a mudança às OS. Confira a lista antes de salvar de novo.");
        }
        throw e;
      }
    },
    onSuccess: ({ saved, asked }) => {
      invalidateForms(queryClient);
      // As OS que mudaram (a versão nova, ou o formulário que entrou ou saiu) releem: painel e listas.
      if (saved.applied_to || saved.attached_to || saved.detached_from) {
        queryClient.invalidateQueries({ queryKey: ["ticket"] });
        queryClient.invalidateQueries({ queryKey: ["tickets"] });
      }
      writeStored(null);
      const newVersion = template !== null && saved.version !== template.version;
      toast({ title: `Formulário “${saved.name}” salvo`, description: savedDescription(saved, newVersion, asked), tone: "success" });
      onLeave();
    },
    // O erro aparece no topo: quem salvou pela barra do rodapé é levado até ele (e o leitor de tela também).
    onError: async (e) => {
      if (e instanceof ApiError && e.status === 409 && draft.id) {
        // A lista relê agora: quem voltar, descartar e abrir de novo já vê a versão da outra pessoa.
        invalidateForms(queryClient);
        const overwrite = await confirm({
          title: "Outra pessoa salvou este formulário",
          description:
            "Ele mudou depois que você começou a editar. Salvar por cima troca a versão dela pela sua. Para ver a versão dela, volte e descarte as suas alterações.",
          confirmLabel: "Salvar por cima",
          cancelLabel: "Voltar",
          tone: "danger",
        });
        if (overwrite) {
          save.mutate({ overwrite: true });
          return;
        }
      }
      requestAnimationFrame(() => {
        summary.current?.scrollIntoView({ block: "center" });
        summary.current?.focus({ preventScroll: true });
      });
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
  const move = (index: number, delta: -1 | 1, target: FocusTarget = delta < 0 ? "up" : "down") => {
    const j = index + delta;
    if (j < 0 || j >= draft.fields.length) return;
    const fields = [...draft.fields];
    [fields[index], fields[j]] = [fields[j], fields[index]];
    reshape(fields, { id: fields[j].id, target });
  };
  // Alt + seta para cima/baixo move a pergunta em que o foco está (o foco vai junto). No seletor de
  // tipo fica de fora: lá, Alt + seta abre a lista de tipos.
  const moveByKey = (index: number, e: React.KeyboardEvent<HTMLLIElement>) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    if (!(e.target instanceof HTMLElement) || e.target instanceof HTMLSelectElement) return;
    e.preventDefault();
    const focused = e.target.dataset.focus ?? "";
    move(index, e.key === "ArrowUp" ? -1 : 1, FOCUS_TARGETS.includes(focused) ? (focused as FocusTarget) : "label");
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
    save.mutate({});
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
            ? "As próximas OS recebem esta versão. Ao salvar, dá para levar a mudança também às OS em que o formulário ainda não começou."
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
              <LinksSection
                templateId={template?.id ?? null}
                serviceTypes={serviceTypes}
                categories={categories}
                typeIds={draft.service_type_ids}
                categoryIds={draft.category_ids}
                onTypes={(ids) => setDraft((d) => ({ ...d, service_type_ids: ids }))}
                onCategories={(ids) => setDraft((d) => ({ ...d, category_ids: ids }))}
              />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Checkbox
                label="Entra na OS como obrigatório"
                checked={draft.default_required}
                onChange={(v) => setDraft((d) => ({ ...d, default_required: v }))}
              />
              <Checkbox
                label="Pedir a assinatura do responsável no local depois deste formulário (quando ele for obrigatório na OS)"
                checked={draft.requires_signature}
                onChange={(v) => setDraft((d) => ({ ...d, requires_signature: v }))}
              />
              <Checkbox
                label="Ativo: entra nas OS e aparece para adicionar"
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
                    onKeyDown={(e) => moveByKey(i, e)}
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
                        data-focus="help"
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
                            data-focus="options"
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
                          {prefillSources(f.type).length ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span aria-hidden className="font-semibold text-ink/80">
                                Preencher com
                              </span>
                              <Select
                                value={prefillOf(f) ?? ""}
                                onChange={(e) => setField(f.id, { prefill: (e.target.value || null) as FormPrefill | null })}
                                aria-label={`Preencher a pergunta ${n} com`}
                                className="w-56"
                              >
                                <option value="">Resposta do técnico</option>
                                {prefillSources(f.type).map((source) => (
                                  <option key={source} value={source}>
                                    {PREFILL_LABEL[source]}
                                  </option>
                                ))}
                              </Select>
                            </span>
                          ) : null}
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
                                  // Mínimo acima do máximo: o máximo sobe junto (o técnico precisa conseguir enviar).
                                  onChange={(v) =>
                                    setField(f.id, { min_photos: v, required: v > 0, max_photos: Math.max(f.max_photos, v) })
                                  }
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
                  : "Para pôr uma pergunta no meio, use o + da pergunta de cima e depois troque o tipo. Para mover pelo teclado: Alt + seta para cima ou para baixo."}
              </p>
            </div>
          </Card>
        </div>

        <PhonePreview draft={draft} />
      </div>

      {unsaved ? (
        <UnsavedBar message={draft.id ? "Alterações não salvas" : "Formulário novo, ainda não salvo"}>
          {offerApply ? (
            <span className="mr-2">
              <Checkbox label="Levar também às OS que ainda não começaram" checked={applyPending} onChange={setApplyPending} />
            </span>
          ) : null}
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
  onKeyDown,
  before,
  section,
  children,
}: {
  rowRef: (el: HTMLLIElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => void;
  before: React.ReactNode;
  section: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {before ? <li>{before}</li> : null}
      <li ref={rowRef} onKeyDown={onKeyDown} className={clsx("flex gap-3 p-3", section && "bg-surface-2/60")}>
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

/** Uma opção da lista de vínculos (tipo de OS ou categoria). */
interface LinkOption {
  id: string;
  label: string;
  /** Texto em que a busca procura. */
  search: string;
}

const typeLabel = (t: ServiceType) => `${t.name}${t.customer ? ` · ${t.customer.name}` : ""}${t.is_active ? "" : " (inativo)"}`;
const categoryLabel = (c: Category) => `${c.full_name}${c.is_active ? "" : " (inativa)"}`;

/** Quantas subcategorias (filhas, netas... até 10 níveis, como a API) cada categoria cobre. */
function subcategoryCounts(categories: Category[]): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const c of categories) if (c.parent_id) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c.id]);
  const out = new Map<string, number>();
  for (const c of categories) {
    const seen = new Set<string>([c.id]);
    let level = children.get(c.id) ?? [];
    for (let depth = 0; level.length && depth < 10; depth += 1) {
      const next: string[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        next.push(...(children.get(id) ?? []));
      }
      level = next;
    }
    out.set(c.id, seen.size - 1);
  }
  return out;
}

/**
 * "Entra sozinho nas OS": os tipos de OS e as categorias (valem as subcategorias) em que o formulário entra
 * sozinho e, num modelo salvo, os tipos em que o histórico mostra que ele já é usado (um clique liga).
 */
function LinksSection({
  templateId,
  serviceTypes,
  categories,
  typeIds,
  categoryIds,
  onTypes,
  onCategories,
}: {
  /** Modelo salvo (o histórico de uso é dele); null: formulário novo. */
  templateId: string | null;
  serviceTypes: ServiceType[] | null;
  categories: Category[] | null;
  typeIds: string[];
  categoryIds: string[];
  onTypes: (ids: string[]) => void;
  onCategories: (ids: string[]) => void;
}) {
  const titleId = useId();
  const usage = useQuery({
    queryKey: ["form-templates", templateId, "usage"],
    queryFn: () => api.get<FormTemplateUsage>(`/form-templates/${templateId}/usage`),
    enabled: templateId !== null,
    staleTime: 5 * 60_000,
  });
  const typeById = useMemo(() => new Map((serviceTypes ?? []).map((t) => [t.id, t])), [serviceTypes]);
  const categoryById = useMemo(() => new Map((categories ?? []).map((c) => [c.id, c])), [categories]);
  const below = useMemo(() => subcategoryCounts(categories ?? []), [categories]);
  // Os ativos e os inativos que já estavam escolhidos (para poder ver e tirar).
  const typeOptions = useMemo<LinkOption[] | null>(
    () =>
      serviceTypes
        ? serviceTypes
            .filter((t) => t.is_active || typeIds.includes(t.id))
            .map((t) => ({ id: t.id, label: typeLabel(t), search: `${t.name} ${t.customer?.name ?? ""}` }))
        : null,
    [serviceTypes, typeIds],
  );
  const categoryOptions = useMemo<LinkOption[] | null>(
    () =>
      categories
        ? categories
            .filter((c) => c.is_active || categoryIds.includes(c.id))
            .sort((a, b) => a.full_name.localeCompare(b.full_name, "pt-BR"))
            .map((c) => ({ id: c.id, label: categoryLabel(c), search: c.full_name }))
        : null,
    [categories, categoryIds],
  );
  const typeChip = (id: string) => {
    const t = typeById.get(id);
    return t ? typeLabel(t) : serviceTypes ? "Tipo removido do catálogo" : "Tipo ligado";
  };
  const categoryChip = (id: string) => {
    const c = categoryById.get(id);
    if (!c) return categories ? "Categoria removida" : "Categoria ligada";
    const k = below.get(id) ?? 0;
    return k ? `${categoryLabel(c)} · +${plural(k, "subcategoria", "subcategorias")}` : categoryLabel(c);
  };
  const counts = [
    typeIds.length ? plural(typeIds.length, "tipo de OS", "tipos de OS") : null,
    categoryIds.length ? plural(categoryIds.length, "categoria", "categorias") : null,
  ]
    .filter(Boolean)
    .join(" e ");
  // Tipos em que o formulário já é usado (pelo menos 3 OS e metade das OS do tipo, nos últimos 12 meses).
  const fromHistory = (usage.data?.service_types ?? []).filter((u) => !typeIds.includes(u.id));
  const include = (ids: string[]) => onTypes([...typeIds, ...ids.filter((id) => !typeIds.includes(id))]);

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <h2 id={titleId} className="text-sm font-bold text-ink">
        Entra sozinho nas OS
        {counts ? <span className="font-normal text-ink-muted"> · {counts}</span> : null}
      </h2>
      <LinkPicker
        title="Tipos de OS"
        options={typeOptions}
        value={typeIds}
        onChange={onTypes}
        chipLabel={typeChip}
        openLabel="Escolher tipos"
        searchPlaceholder="Buscar tipo ou cliente"
        searchLabel="Buscar tipo de OS"
        notFound="Nenhum tipo encontrado."
        failed="Não foi possível carregar os tipos de OS agora. Os que já estão ligados continuam ligados ao salvar."
      />
      <LinkPicker
        title="Categorias"
        options={categoryOptions}
        value={categoryIds}
        onChange={onCategories}
        chipLabel={categoryChip}
        openLabel="Escolher categorias"
        searchPlaceholder="Buscar categoria"
        searchLabel="Buscar categoria"
        notFound="Nenhuma categoria encontrada."
        failed="Não foi possível carregar as categorias agora. As que já estão ligadas continuam ligadas ao salvar."
      />
      {typeIds.length || categoryIds.length ? null : (
        <p className="text-xs text-ink-muted">Nenhum tipo nem categoria: só entra quando alguém adicionar na OS.</p>
      )}
      {fromHistory.length ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-surface-2/60 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink/80">Pelo histórico:</span>
            {fromHistory.length >= 2 ? (
              <Button size="sm" variant="ghost" onClick={() => include(fromHistory.map((u) => u.id))}>
                Incluir todos
              </Button>
            ) : null}
          </div>
          <ul className="flex flex-col gap-1">
            {fromHistory.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink">
                <span className="min-w-0">
                  {u.name}
                  {u.customer ? ` · ${u.customer.name}` : ""} · {u.used.toLocaleString("pt-BR")} de {u.total.toLocaleString("pt-BR")} OS
                </span>
                <Button size="sm" variant="ghost" onClick={() => include([u.id])} aria-label={`Incluir ${u.name}`}>
                  Incluir
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Uma linha de vínculos: busca entre todas as opções e as escolhidas à vista, com o X para tirar. */
function LinkPicker({
  title,
  options,
  value,
  onChange,
  chipLabel,
  openLabel,
  searchPlaceholder,
  searchLabel,
  notFound,
  failed,
}: {
  title: string;
  /** null: a lista não carregou (dá para salvar o resto; os já ligados continuam). */
  options: LinkOption[] | null;
  value: string[];
  onChange: (ids: string[]) => void;
  chipLabel: (id: string) => string;
  openLabel: string;
  searchPlaceholder: string;
  searchLabel: string;
  notFound: string;
  failed: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const titleId = useId();
  const listId = useId();
  const shown = useMemo(() => {
    const q = fold(search.trim());
    return (options ?? []).filter((o) => !q || fold(o.search).includes(q));
  }, [options, search]);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={titleId} className="text-xs font-semibold text-ink/80">
          {title}
        </span>
        {options ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            // A lista só existe aberta: apontar para ela fechada seria apontar para o nada.
            aria-controls={open ? listId : undefined}
          >
            <ChevronDown className={clsx("size-3.5 transition-transform duration-150", open && "rotate-180")} />
            {open ? "Fechar a lista" : openLabel}
          </Button>
        ) : null}
      </div>
      {options ? null : <p className="text-xs text-ink-muted">{failed}</p>}
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-labelledby={titleId}>
          {value.map((id) => {
            const text = chipLabel(id);
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
      ) : null}
      {open ? (
        <div id={listId} className="flex flex-col gap-2">
          <SearchField value={search} onChange={setSearch} placeholder={searchPlaceholder} label={searchLabel} />
          <div role="group" aria-labelledby={titleId} className="max-h-60 overflow-y-auto rounded-lg border border-line py-1">
            {shown.length === 0 ? (
              <p className="px-3 py-2 text-xs text-ink-muted">{notFound}</p>
            ) : (
              shown.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={value.includes(o.id)}
                    onChange={() => toggle(o.id)}
                    className="size-4 shrink-0 rounded border-line accent-[var(--brand)]"
                  />
                  <span className="min-w-0 truncate">{o.label}</span>
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
        {/* Rola sozinha num formulário longo: com foco, as setas do teclado também rolam. */}
        <div
          tabIndex={0}
          role="group"
          aria-label="Perguntas na tela do app"
          className="max-h-[32rem] overflow-y-auto rounded-xl bg-surface p-3 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none"
        >
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
  // Resposta automática: a pergunta já chega preenchida com o dado da OS (o técnico corrige).
  const source = prefillOf(f);
  if (source) return <p className={clsx(box, "font-medium text-ink", f.type === "textarea" && "h-12")}>{PREFILL_LABEL[source]}</p>;
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

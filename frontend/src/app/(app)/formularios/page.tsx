"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Camera,
  CheckSquare,
  ClipboardList,
  Copy,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { MultiSelect } from "@/components/MultiSelect";
import { useToast } from "@/components/Toaster";
import { Button, Card, Checkbox, EmptyState, ErrorBox, Field, Input, LoadingBlock, PageHeader, Select, Textarea } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets } from "@/lib/constants";
import { useServiceTypes } from "@/lib/queries";
import type { FormField, FormFieldType, FormTemplate } from "@/lib/types";

const TYPE_LABEL: Record<FormFieldType, string> = {
  section: "Seção",
  text: "Texto curto",
  textarea: "Texto longo",
  number: "Número",
  yes_no: "Sim / Não",
  choice: "Escolha única",
  multi_choice: "Múltipla escolha",
  date: "Data",
  confirm: "Confirmação",
  photo: "Fotos",
};
const ADD_ORDER: FormFieldType[] = ["photo", "yes_no", "text", "textarea", "choice", "multi_choice", "number", "date", "confirm", "section"];

interface Draft {
  id?: string;
  name: string;
  description: string;
  fields: FormField[];
  service_type_ids: string[];
  requires_signature: boolean;
  is_active: boolean;
}

const newId = () => `f_${Math.random().toString(36).slice(2, 8)}`;

function field(type: FormFieldType, label: string, extra: Partial<FormField> = {}): FormField {
  return {
    id: newId(),
    type,
    label,
    help: null,
    required: type !== "section",
    options: type === "choice" || type === "multi_choice" ? ["Opção 1", "Opção 2"] : [],
    min_photos: type === "photo" ? 1 : 0,
    max_photos: 10,
    ...extra,
  };
}

// Pontos de partida para não começar do zero (o analista ajusta à vontade).
const EXAMPLES: { name: string; build: () => Draft }[] = [
  {
    name: "Preventiva de rack",
    build: () => ({
      name: "Preventiva de rack",
      description: "Fotos antes e depois e a checagem da organização do rack.",
      requires_signature: true,
      is_active: true,
      service_type_ids: [],
      fields: [
        field("section", "Antes do serviço"),
        field("photo", "Foto do rack antes", { min_photos: 2, max_photos: 6, help: "Frente e lateral, com a porta aberta" }),
        field("textarea", "Problemas encontrados", { required: false }),
        field("section", "Depois do serviço"),
        field("photo", "Foto do rack depois", { min_photos: 2, max_photos: 6 }),
        field("yes_no", "Cabos organizados e identificados?"),
        field("yes_no", "Patch cords com velcro?"),
        field("number", "Quantidade de velcro usada (unidades)", { required: false }),
        field("confirm", "Ambiente limpo e equipamentos ligados"),
      ],
    }),
  },
  {
    name: "Organização de PDV",
    build: () => ({
      name: "Organização de PDV",
      description: "Antes e depois de cada caixa.",
      requires_signature: true,
      is_active: true,
      service_type_ids: [],
      fields: [
        field("number", "Quantidade de PDVs atendidos"),
        field("photo", "Fotos dos PDVs antes", { min_photos: 1, max_photos: 20 }),
        field("photo", "Fotos dos PDVs depois", { min_photos: 1, max_photos: 20 }),
        field("multi_choice", "Itens verificados", { options: ["Impressora fiscal", "Leitor de código", "Gaveta", "Cabos", "Nobreak"] }),
        field("textarea", "Observações", { required: false }),
      ],
    }),
  },
  {
    name: "Instalação de câmera (CFTV)",
    build: () => ({
      name: "Instalação de câmera (CFTV)",
      description: "",
      requires_signature: true,
      is_active: true,
      service_type_ids: [],
      fields: [
        field("text", "Local da câmera"),
        field("choice", "Tipo de câmera", { options: ["Bullet", "Dome", "PTZ", "Fisheye"] }),
        field("photo", "Foto da câmera instalada", { min_photos: 1, max_photos: 4 }),
        field("photo", "Print da imagem no DVR/NVR", { min_photos: 1, max_photos: 4 }),
        field("yes_no", "Gravação testada?"),
      ],
    }),
  },
];

const EMPTY: Draft = {
  name: "",
  description: "",
  fields: [field("text", "Nova pergunta")],
  service_type_ids: [],
  requires_signature: true,
  is_active: true,
};

export default function FormsPage() {
  const { user } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const templates = useQuery({
    queryKey: ["form-templates"],
    queryFn: () => api.get<FormTemplate[]>("/form-templates"),
  });
  const serviceTypes = useServiceTypes({ active: true });
  const typeName = useMemo(
    () => Object.fromEntries((serviceTypes.data ?? []).map((t) => [t.id, t.name])),
    [serviceTypes.data],
  );

  if (user && !canManageTickets(user.role)) {
    return <ErrorBox message="Os formulários são montados por analistas e gestores." />;
  }
  if (draft) return <Editor initial={draft} onDone={() => setDraft(null)} />;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Formulários"
        description="Checklists que o técnico preenche no app. Você decide, em cada OS, se anexa e se é obrigatório."
        actions={
          <Button variant="primary" onClick={() => setDraft({ ...EMPTY, fields: [field("text", "Nova pergunta")] })}>
            <Plus className="size-4" />
            Novo formulário
          </Button>
        }
      />

      {templates.isLoading ? (
        <LoadingBlock />
      ) : (templates.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList className="size-6" />}
            title="Nenhum formulário ainda"
            description="Comece de um exemplo e ajuste, ou crie do zero."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <Button key={ex.name} onClick={() => setDraft(ex.build())}>
                    {ex.name}
                  </Button>
                ))}
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(templates.data ?? []).map((t) => {
              const qs = t.fields.filter((f) => f.type !== "section");
              const photos = t.fields.filter((f) => f.type === "photo").length;
              return (
                <Card key={t.id} className={clsx("flex flex-col p-4", !t.is_active && "opacity-60")}>
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-medium text-ink">{t.name}</h2>
                    {!t.is_active ? <span className="text-xs text-ink-muted">Inativo</span> : null}
                  </div>
                  {t.description ? <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{t.description}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                    <span className="inline-flex items-center gap-1">
                      <CheckSquare className="size-3.5" /> {qs.length} perguntas
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Camera className="size-3.5" /> {photos} campos de foto
                    </span>
                    <span>v{t.version}</span>
                  </div>
                  {t.service_type_ids.length ? (
                    <p className="mt-2 text-xs text-ink-muted">
                      Sugerido em: {t.service_type_ids.map((id) => typeName[id] ?? "tipo removido").join(", ")}
                    </p>
                  ) : null}
                  <div className="mt-auto flex gap-2 pt-4">
                    <Button size="sm" onClick={() => setDraft({ ...t, description: t.description ?? "" })}>
                      <Pencil className="size-3.5" />
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft({
                          ...t,
                          id: undefined,
                          name: `${t.name} (cópia)`,
                          description: t.description ?? "",
                          fields: t.fields.map((f) => ({ ...f, id: newId() })),
                        })
                      }
                    >
                      <Copy className="size-3.5" />
                      Duplicar
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-ink-muted">
            Exemplos para começar:{" "}
            {EXAMPLES.map((ex, i) => (
              <span key={ex.name}>
                {i ? " · " : ""}
                <button type="button" className="text-brand hover:underline" onClick={() => setDraft(ex.build())}>
                  {ex.name}
                </button>
              </span>
            ))}
          </p>
        </>
      )}
    </div>
  );
}

function Editor({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(initial);
  const serviceTypes = useServiceTypes({ active: true });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name,
        description: draft.description || null,
        fields: draft.fields,
        service_type_ids: draft.service_type_ids,
        requires_signature: draft.requires_signature,
        is_active: draft.is_active,
      };
      return draft.id
        ? api.put<FormTemplate>(`/form-templates/${draft.id}`, body)
        : api.post<FormTemplate>("/form-templates", body);
    },
    onSuccess: (t) => {
      queryClient.invalidateQueries({ queryKey: ["form-templates"] });
      toast({ title: `Formulário "${t.name}" salvo`, tone: "success" });
      onDone();
    },
  });
  const setField = (i: number, patch: Partial<FormField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const move = (i: number, delta: number) =>
    setDraft((d) => {
      const fields = [...d.fields];
      const j = i + delta;
      if (j < 0 || j >= fields.length) return d;
      [fields[i], fields[j]] = [fields[j], fields[i]];
      return { ...d, fields };
    });

  return (
    <div className="mx-auto max-w-6xl">
      <button type="button" onClick={onDone} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
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
            <Button onClick={onDone}>Cancelar</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Salvar formulário
            </Button>
          </>
        }
      />
      {save.error ? (
        <div className="mb-4">
          <ErrorBox message={errorMessage(save.error)} />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Nome" required className="sm:col-span-2">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ex.: Preventiva de rack" />
            </Field>
            <Field label="Descrição" className="sm:col-span-2">
              <Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <MultiSelect
                label="Sugerir nas OS destes tipos de serviço"
                options={(serviceTypes.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
                value={draft.service_type_ids}
                onChange={(v) => setDraft({ ...draft, service_type_ids: v })}
              />
            </div>
            <Checkbox
              label="Exige a assinatura do responsável no local (quando obrigatório)"
              checked={draft.requires_signature}
              onChange={(v) => setDraft({ ...draft, requires_signature: v })}
            />
            <Checkbox label="Ativo" checked={draft.is_active} onChange={(v) => setDraft({ ...draft, is_active: v })} />
          </Card>

          <Card>
            <ol className="divide-y divide-line">
              {draft.fields.map((f, i) => (
                <li key={f.id} className={clsx("flex gap-3 p-3", f.type === "section" && "bg-surface-2/60")}>
                  <span className="mt-2 w-5 shrink-0 text-right text-xs text-ink-muted tabular-nums">{i + 1}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap gap-2">
                      <div className="w-40 shrink-0">
                        <Select
                          value={f.type}
                          aria-label="Tipo do campo"
                          onChange={(e) => {
                            const type = e.target.value as FormFieldType;
                            const base = field(type, f.label);
                            setField(i, { type, options: f.options.length ? f.options : base.options, min_photos: base.min_photos, required: type !== "section" && f.required });
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
                        className="min-w-48 flex-1"
                        value={f.label}
                        onChange={(e) => setField(i, { label: e.target.value })}
                        placeholder={f.type === "section" ? "Título da seção" : "Pergunta"}
                        aria-label="Texto do campo"
                      />
                    </div>
                    {f.type !== "section" ? (
                      <Input
                        value={f.help ?? ""}
                        onChange={(e) => setField(i, { help: e.target.value || null })}
                        placeholder="Orientação para o técnico (opcional)"
                        aria-label="Orientação"
                        className="h-8 text-xs"
                      />
                    ) : null}
                    {f.type === "choice" || f.type === "multi_choice" ? (
                      <Textarea
                        rows={3}
                        value={f.options.join("\n")}
                        onChange={(e) => setField(i, { options: e.target.value.split("\n") })}
                        placeholder="Uma opção por linha"
                        aria-label="Opções"
                        className="text-xs"
                      />
                    ) : null}
                    <div className="flex flex-wrap items-center gap-4 text-xs text-ink-muted">
                      {f.type === "photo" ? (
                        <>
                          <label className="inline-flex items-center gap-1.5">
                            Mínimo
                            <Input
                              type="number"
                              min={0}
                              max={20}
                              value={f.min_photos}
                              onChange={(e) => setField(i, { min_photos: Number(e.target.value) })}
                              className="h-7 w-16 text-xs"
                            />
                          </label>
                          <label className="inline-flex items-center gap-1.5">
                            Máximo
                            <Input
                              type="number"
                              min={1}
                              max={30}
                              value={f.max_photos}
                              onChange={(e) => setField(i, { max_photos: Number(e.target.value) })}
                              className="h-7 w-16 text-xs"
                            />
                          </label>
                          <span>{f.min_photos > 0 ? "obrigatório" : "opcional"}</span>
                        </>
                      ) : f.type !== "section" ? (
                        <Checkbox label="Obrigatório" checked={f.required} onChange={(v) => setField(i, { required: v })} />
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <IconButton label="Subir" onClick={() => move(i, -1)} disabled={i === 0}>
                      <ArrowUp className="size-3.5" />
                    </IconButton>
                    <IconButton label="Descer" onClick={() => move(i, 1)} disabled={i === draft.fields.length - 1}>
                      <ArrowDown className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label="Remover"
                      danger
                      onClick={() => setDraft((d) => ({ ...d, fields: d.fields.filter((_, j) => j !== i) }))}
                      disabled={draft.fields.length === 1}
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-1.5 border-t border-line p-3">
              <span className="mr-1 self-center text-xs text-ink-muted">Adicionar:</span>
              {ADD_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    setDraft((d) => ({ ...d, fields: [...d.fields, field(t, t === "section" ? "Nova seção" : "Nova pergunta")] }))
                  }
                  className="rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:border-brand hover:text-brand"
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <p className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">Como o técnico vê</p>
          <div className="rounded-[1.75rem] border-8 border-ink/85 bg-canvas p-3 shadow-sm dark:border-black">
            <div className="max-h-[32rem] overflow-y-auto rounded-xl bg-surface p-3">
              <p className="text-sm font-semibold text-ink">{draft.name || "Sem nome"}</p>
              <div className="mt-3 flex flex-col gap-3">
                {draft.fields.map((f) =>
                  f.type === "section" ? (
                    <p key={f.id} className="border-b border-line pb-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
                      {f.label}
                    </p>
                  ) : (
                    <div key={f.id}>
                      <p className="text-xs font-medium text-ink">
                        {f.label}
                        {f.required || (f.type === "photo" && f.min_photos > 0) ? <span className="text-red-500"> *</span> : null}
                      </p>
                      <Preview f={f} />
                    </div>
                  ),
                )}
              </div>
              <div className="mt-4 rounded-lg bg-brand py-2 text-center text-xs font-medium text-white">Concluir formulário</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Preview({ f }: { f: FormField }) {
  const box = "mt-1 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-[11px] text-ink-muted";
  if (f.type === "photo")
    return (
      <div className="mt-1 flex gap-1.5">
        {Array.from({ length: Math.max(1, Math.min(f.min_photos, 3)) }, (_, i) => (
          <div key={i} className="flex size-10 items-center justify-center rounded-md border border-dashed border-line text-ink-muted">
            <Camera className="size-3.5" />
          </div>
        ))}
      </div>
    );
  if (f.type === "yes_no")
    return (
      <div className="mt-1 flex gap-1.5">
        <span className={box}>Sim</span>
        <span className={box}>Não</span>
      </div>
    );
  if (f.type === "choice" || f.type === "multi_choice")
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {f.options.filter(Boolean).slice(0, 4).map((o) => (
          <span key={o} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-muted">
            {o}
          </span>
        ))}
      </div>
    );
  if (f.type === "confirm") return <p className={box}>☐ Confirmo</p>;
  return <div className={clsx(box, f.type === "textarea" && "h-10")}>{f.help ?? " "}</div>;
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "rounded-md p-1 text-ink-muted hover:bg-surface-2 disabled:opacity-30",
        danger ? "hover:text-red-600" : "hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

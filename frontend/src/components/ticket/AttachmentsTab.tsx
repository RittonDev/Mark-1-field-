"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  FileVideo,
  ImageOff,
  ImagePlus,
  Info,
  Paperclip,
  Pencil,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { saveBlob } from "@/components/report/pdfAssets";
import { captionText, FILE_KIND_LABEL, fileKind, PHASE_LABEL, type PhotoPhase, photoPhase, withPhase } from "@/components/report/shared";
import { useToast } from "@/components/Toaster";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorBox,
  Input,
  isTopLayer,
  LoadingBlock,
  lockScroll,
  restoreFocus,
  Textarea,
  trapTab,
} from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { Attachment, TicketDetail, TicketForm, UUID } from "@/lib/types";
import { useInvalidateTicket } from "./useConflictHandler";

// ------------------------------------------------------------------ regras de envio

/** Limite de envio da API (espelha MAX_UPLOAD_MB em backend/app/core/config.py). */
export const MAX_UPLOAD_MB = 15;

/** Por que o arquivo não pode ir (vazio ou acima do limite); null quando pode. */
export function uploadProblem(file: File): string | null {
  if (file.size === 0) return "o arquivo está vazio";
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `tem ${formatBytes(file.size)}, acima do limite de ${MAX_UPLOAD_MB} MB`;
  return null;
}

/** Foto que o navegador mostra (HEIC do iPhone, PDF ou vídeo guardados como foto viram arquivo na tela). */
export function isViewableImage(a: Pick<Attachment, "filename" | "content_type">): boolean {
  return fileKind(a.filename, a.content_type) === "image";
}

// ------------------------------------------------------------------ lista e links assinados

// O link assinado da API vale 15 min (DOWNLOAD_TOKEN_MINUTES) e cada leitura da lista traz links novos:
// trocar o src de cada <img> baixaria todas as fotos de novo a cada mudança na OS. O link visto há menos
// de 8 min continua; com a releitura a cada 5 min, nenhum link fica na tela com mais de 13 min.
const REUSE_MS = 8 * 60_000;
const REFRESH_MS = 5 * 60_000;
const seenUrls = new Map<UUID, { url: string; at: number }>();

function keepUrls(list: Attachment[]): Attachment[] {
  const now = Date.now();
  return list.map((a) => {
    if (!a.download_url || a.external) return a;
    const seen = seenUrls.get(a.id);
    if (seen && now - seen.at < REUSE_MS) return { ...a, download_url: seen.url };
    seenUrls.set(a.id, { url: a.download_url, at: now });
    return a;
  });
}

/** Anexos da OS: a aba Anexos, os formulários e os custos usam a mesma lista (e os mesmos links). */
export function useTicketAttachments(ticketId: UUID, enabled = true) {
  return useQuery({
    queryKey: ["ticket", ticketId, "attachments"],
    queryFn: async () => keepUrls(await api.get<Attachment[]>(`/tickets/${ticketId}/attachments`)),
    enabled,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
}

/**
 * Imagem do anexo. Link expirado (a aba ficou aberta muito tempo) busca um novo uma vez; se ainda
 * falhar, mostra "Foto indisponível" no lugar do ícone quebrado.
 */
export function AttachmentImage({
  attachment,
  alt,
  className,
  eager = false,
}: {
  attachment: Attachment;
  alt: string;
  className?: string;
  eager?: boolean;
}) {
  const queryClient = useQueryClient();
  const url = absoluteApiUrl(attachment.download_url);
  const [failed, setFailed] = useState<string | null>(null);
  const retried = useRef(false);
  if (!url || failed === url) {
    return (
      <span
        role="img"
        aria-label={`${alt}: foto indisponível`}
        className={clsx("flex flex-col items-center justify-center gap-1 bg-surface-2 text-center text-[11px] text-ink-muted", className)}
      >
        <ImageOff className="size-4" />
        Foto indisponível
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- link assinado da API ou do armazenamento de origem
    <img
      src={url}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      className={className}
      onError={() => {
        if (!retried.current && !attachment.external) {
          retried.current = true;
          seenUrls.delete(attachment.id);
          void queryClient.invalidateQueries({ queryKey: ["ticket", attachment.ticket_id, "attachments"], exact: true });
          return;
        }
        setFailed(url);
      }}
    />
  );
}

/** Baixa com o nome original (a foto abriria na aba). Sem acesso ao arquivo de origem, abre para salvar. */
async function downloadAttachment(a: Attachment) {
  const url = absoluteApiUrl(a.download_url);
  if (!url) return;
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(String(res.status));
    saveBlob(await res.blob(), a.filename);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

// ------------------------------------------------------------------ rótulos

type Filter = "all" | "photos" | "forms" | "files";

function kindLabel(a: Attachment): string {
  if (a.kind === "signature") return "Assinatura";
  const kind = fileKind(a.filename, a.content_type);
  if (kind === "image") return a.kind === "photo" ? "Foto" : "Imagem";
  return FILE_KIND_LABEL[kind];
}

function meta(a: Attachment) {
  return [kindLabel(a), a.external ? "no Field Control" : formatBytes(a.size_bytes), a.uploaded_by?.name ?? null, formatDateTime(a.created_at)]
    .filter(Boolean)
    .join(" · ");
}

/** "Checklist de instalação · Foto do rack": de qual formulário e campo a foto é prova. */
function formContext(a: Attachment, forms: TicketForm[]): { form: TicketForm | null; label: string } | null {
  if (!a.form_id) return null;
  const form = forms.find((f) => f.id === a.form_id) ?? null;
  if (!form) return { form: null, label: "Formulário" };
  const field = form.fields.find((f) => f.id === a.field_id);
  return { form, label: field ? `${form.name} · ${field.label}` : form.name };
}

/** Vai para o relatório do cliente (e o técnico vê no app) ou fica só com a central. */
function inReport(a: Attachment): boolean {
  return a.form_id !== null || a.kind === "photo" || a.kind === "signature";
}

function VisibilityChip({ attachment }: { attachment: Attachment }) {
  return inReport(attachment) ? (
    <span
      className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand-ink"
      title="O cliente vê no relatório e o técnico vê no app"
    >
      No relatório
    </span>
  ) : (
    <span
      className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted"
      title="Fica só com a central: fora do relatório do cliente e do app do técnico"
    >
      Interno
    </span>
  );
}

/** Formulários da OS (para dizer de qual campo é cada foto), do que a OS aberta já carregou. */
function useTicketForms(ticketId: UUID): TicketForm[] {
  const ticket = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => api.get<TicketDetail>(`/tickets/${ticketId}`),
    select: (t: TicketDetail) => t.forms,
    staleTime: Infinity,
  });
  return ticket.data ?? [];
}

/** A aba está na camada de cima (nenhum diálogo ou menu aberto por cima da OS). */
function onTop(root: HTMLElement): boolean {
  const layer = root.closest('[aria-modal="true"]');
  if (layer) return isTopLayer(layer);
  return !document.querySelector('[aria-modal="true"], [role="menu"]');
}

/** Print colado vem como "image.png": ganha um nome com a data ("print-20261113-1405.png"). */
function pastedName(file: File, index: number, now: Date): File {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
  return new File([file], `print-${stamp}${index ? `-${index + 1}` : ""}.${ext}`, { type: file.type });
}

interface UploadOptions {
  caption: string;
  /** Imagem entra como foto (relatório do cliente e app do técnico) ou como arquivo interno. */
  photo: boolean;
}

/** Envia um arquivo. Devolve o erro (não foi) ou um aviso (foi, mas como arquivo). */
async function uploadOne(ticketId: UUID, file: File, options: UploadOptions): Promise<{ error?: string; note?: string }> {
  const problem = uploadProblem(file);
  if (problem) return { error: `${file.name}: ${problem}` };
  const kind = fileKind(file.name, file.type);
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind === "image" && options.photo ? "photo" : "file");
  if (options.caption) form.append("description", options.caption);
  try {
    await api.upload<Attachment>(`/tickets/${ticketId}/attachments`, form);
  } catch (e) {
    return { error: `${file.name}: ${errorMessage(e)}` };
  }
  if (kind === "heic") return { note: `${file.name}: o navegador não mostra HEIC, então entrou como arquivo. Para ver como foto, envie em JPG.` };
  return {};
}

/** Legenda do anexo: mostra, edita (gestão ou quem enviou) e salva. Nas fotos, marca antes e depois. */
function Caption({
  attachment,
  canEdit,
  phases,
  onSaved,
}: {
  attachment: Attachment;
  canEdit: boolean;
  /** Foto: oferece "Antes" e "Depois" (vira etiqueta e agrupa as fotos no relatório do cliente). */
  phases: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(attachment.description ?? "");
  const save = useMutation({
    mutationFn: () => api.patch<Attachment>(`/attachments/${attachment.id}`, { description: text.trim() || null }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
      toast({ title: "Descrição salva", tone: "success" });
    },
  });
  if (editing) {
    const submit = () => {
      if (!save.isPending) save.mutate();
    };
    const current = photoPhase(text);
    return (
      <div className="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
        {phases ? (
          <div className="flex items-center gap-1.5" role="group" aria-label="Fase da foto">
            {(["antes", "depois"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={current === p}
                onClick={() => setText((t) => withPhase(t, photoPhase(t) === p ? null : p).slice(0, 500))}
                className={clsx(
                  "h-6 rounded-full border px-2.5 text-[11px] font-semibold transition-colors",
                  current === p
                    ? "border-brand bg-brand text-white dark:border-brand-strong dark:bg-brand-strong"
                    : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
                )}
              >
                {PHASE_LABEL[p]}
              </button>
            ))}
          </div>
        ) : null}
        <Textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 500))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ex.: Rack antes da organização"
          aria-label={`Descrição de ${attachment.filename}`}
          autoFocus
          className="text-xs"
        />
        <div className="flex items-center justify-between gap-2 text-[11px] text-ink-subtle">
          <span>Ctrl+Enter salva</span>
          <span className="tabular-nums">{text.length}/500</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="secondary" className="w-full" onClick={() => setEditing(false)}>
            Cancelar
          </Button>
          <Button size="sm" variant="primary" className="w-full" loading={save.isPending} onClick={submit}>
            Salvar
          </Button>
        </div>
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </div>
    );
  }
  const phase = phases ? photoPhase(attachment.description) : null;
  // O marcador "Antes:"/"Depois:" vira a etiqueta da foto; aqui fica só o texto.
  const shown = phases ? captionText(attachment.description) || (phase ? PHASE_LABEL[phase] : "") : (attachment.description ?? "");
  if (shown) {
    if (!canEdit) return <p className="text-xs leading-relaxed text-ink">{shown}</p>;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setText(attachment.description ?? "");
          setEditing(true);
        }}
        className="group/caption -mx-1 rounded-md px-1 py-0.5 text-left text-xs leading-relaxed text-ink transition-colors hover:bg-surface-2"
        title="Editar descrição"
        aria-label={`Editar descrição: ${shown}`}
      >
        {shown}
        <Pencil className="ml-1.5 inline size-3 align-[-1px] text-ink-subtle opacity-0 transition-opacity group-hover/caption:opacity-100 group-focus-visible/caption:opacity-100 [@media(hover:none)]:opacity-100" />
      </button>
    );
  }
  return canEdit ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setText("");
        setEditing(true);
      }}
      className="inline-flex items-center gap-1 self-start rounded-md py-0.5 text-xs text-ink-muted hover:text-brand"
    >
      <Pencil className="size-3" />
      Adicionar descrição
    </button>
  ) : null;
}

/** Foto ampliada: navegação pelas setas, legenda, de qual formulário é, abrir o original e baixar. */
function Lightbox({
  items,
  index,
  forms,
  onClose,
  onMove,
}: {
  items: Attachment[];
  index: number;
  forms: TicketForm[];
  onClose: () => void;
  onMove: (i: number) => void;
}) {
  const a = items[index];
  const box = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [downloading, setDownloading] = useState(false);
  // Foco no Fechar ao abrir e de volta na miniatura ao fechar (teclado e leitor de tela); a página atrás não rola.
  useEffect(() => {
    const opener = document.activeElement;
    const unlock = lockScroll();
    closeButton.current?.focus();
    return () => {
      unlock();
      restoreFocus(opener);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const node = box.current;
      // Uma tecla que a camada de cima já tratou (a busca Ctrl+K aberta sobre a foto) fica com ela.
      if (e.defaultPrevented || !node || !isTopLayer(node)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        trapTab(e, node);
      } else if (e.key === "ArrowRight") {
        onMove(Math.min(items.length - 1, index + 1));
      } else if (e.key === "ArrowLeft") {
        onMove(Math.max(0, index - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, onMove]);
  if (!a) return null;
  const url = absoluteApiUrl(a.download_url);
  const phase = photoPhase(a.description);
  const title = captionText(a.description) || (phase ? PHASE_LABEL[phase] : "") || a.filename;
  const context = formContext(a, forms);
  const action = "inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-white/90 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60";
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={`Foto ${index + 1} de ${items.length}: ${title}`}
      className="fixed inset-0 z-50 flex animate-fade flex-col bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex items-center gap-2 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {phase ? <span className="mr-1.5 rounded bg-white/15 px-1.5 py-0.5 text-[11px]">{PHASE_LABEL[phase]}</span> : null}
            {title}
          </p>
          <p className="truncate text-xs text-white/75">
            {index + 1} de {items.length}
            {context ? ` · ${context.label}` : ""} · {meta(a)}
          </p>
        </div>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className={action} aria-label="Abrir o original em outra aba">
            <ExternalLink className="size-4" />
            <span className="hidden sm:inline">Abrir original</span>
          </a>
        ) : null}
        {url ? (
          <button
            type="button"
            className={action}
            disabled={downloading}
            aria-label={`Baixar ${a.filename}`}
            onClick={async () => {
              setDownloading(true);
              await downloadAttachment(a);
              setDownloading(false);
            }}
          >
            <Download className="size-4" />
            <span className="hidden sm:inline">{downloading ? "Baixando..." : "Baixar"}</span>
          </button>
        ) : null}
        <button ref={closeButton} type="button" onClick={onClose} className="ml-1 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Fechar">
          <X className="size-5" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-6 sm:px-16">
        {index > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMove(index - 1);
            }}
            className="absolute top-1/2 left-3 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Foto anterior"
          >
            <ChevronLeft className="size-6" />
          </button>
        ) : null}
        {index < items.length - 1 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMove(index + 1);
            }}
            className="absolute top-1/2 right-3 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            aria-label="Próxima foto"
          >
            <ChevronRight className="size-6" />
          </button>
        ) : null}
        <div onClick={(e) => e.stopPropagation()} className="flex max-h-full max-w-full">
          <AttachmentImage
            key={a.id}
            attachment={a}
            alt={title}
            eager
            className="max-h-[calc(100vh-7rem)] max-w-full animate-pop rounded-xl object-contain shadow-pop"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface Progress {
  done: number;
  total: number;
  failed: string[];
  notes: string[];
}

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

/**
 * Anexos da OS: o técnico envia pelo app; a gestão também envia daqui (arrastando do Windows ou colando
 * um print), decide se a foto vai para o relatório do cliente, descreve cada uma e exclui o que não serve.
 */
export function AttachmentsTab({
  ticketId,
  closed,
  canManage = false,
  signatureId = null,
}: {
  ticketId: UUID;
  closed: boolean;
  canManage?: boolean;
  signatureId?: UUID | null;
}) {
  const invalidate = useInvalidateTicket(ticketId);
  const { toast } = useToast();
  const confirm = useConfirm();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const queue = useRef<File[]>([]);
  const running = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<PhotoPhase | null>(null);
  const [toReport, setToReport] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [zoom, setZoom] = useState<number | null>(null);
  const canUpload = !closed || canManage;

  const attachments = useTicketAttachments(ticketId);
  const forms = useTicketForms(ticketId);

  const remove = useMutation({
    // Foto de formulário sai pelo formulário: ele volta para "Em preenchimento" se estava concluído.
    mutationFn: (a: Attachment) =>
      a.form_id ? api.delete(`/tickets/${ticketId}/forms/${a.form_id}/photos/${a.id}`) : api.delete(`/attachments/${a.id}`),
    onSuccess: (_, a) => {
      invalidate();
      toast({ title: "Anexo excluído", description: a.filename, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível excluir", description: errorMessage(e), tone: "error" }),
  });
  const askRemove = async (a: Attachment) => {
    const context = formContext(a, forms);
    let description: string;
    if (context?.form) {
      const field = context.form.fields.find((f) => f.id === a.field_id);
      description =
        `A foto sai do formulário “${context.form.name}”${field ? ` (campo ${field.label})` : ""}` +
        (context.form.status === "completed" ? " e ele volta para Em preenchimento: precisa ser concluído de novo." : ".") +
        " Não dá para desfazer.";
    } else {
      description = `“${a.filename}” sai da OS${inReport(a) ? " e do relatório do cliente" : ""}. Não dá para desfazer.`;
    }
    const ok = await confirm({ title: "Excluir este anexo?", description, confirmLabel: "Excluir", tone: "danger" });
    if (ok) remove.mutate(a);
  };

  // Fila de envio: três arquivos por vez; o que chega durante o envio (outro arraste, outro print) entra
  // na mesma fila. Descrição, fase e destino valem para o lote que começou.
  const drain = async (options: UploadOptions) => {
    running.current = true;
    let sent = 0;
    const worker = async () => {
      for (let file = queue.current.shift(); file; file = queue.current.shift()) {
        const result = await uploadOne(ticketId, file, options);
        if (!result.error) sent += 1;
        setProgress((p) =>
          p
            ? {
                ...p,
                done: p.done + 1,
                failed: result.error ? [...p.failed, result.error] : p.failed,
                notes: result.note ? [...p.notes, result.note] : p.notes,
              }
            : p,
        );
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    running.current = false;
    invalidate();
    if (inputRef.current) inputRef.current.value = "";
    if (sent) {
      toast({ title: sent === 1 ? "Anexo enviado" : `${sent} anexos enviados`, tone: "success" });
      setCaption("");
      setPhase(null);
    }
    setProgress((p) => (p && !p.failed.length && !p.notes.length ? null : p));
  };

  const sendFiles = (incoming: File[]) => {
    if (!incoming.length) return;
    queue.current.push(...incoming);
    setProgress((p) =>
      p && p.done < p.total ? { ...p, total: p.total + incoming.length } : { done: 0, total: incoming.length, failed: [], notes: [] },
    );
    if (!running.current) void drain({ caption: withPhase(caption.trim(), phase), photo: toReport });
  };

  // Colar um print (Win+Shift+S) com Ctrl+V. Num campo de texto, o texto colado continua indo para o campo.
  const onPaste = useEffectEvent((e: ClipboardEvent) => {
    const data = e.clipboardData;
    const pasted = Array.from(data?.files ?? []);
    const root = rootRef.current;
    if (!pasted.length || e.defaultPrevented || !root || !onTop(root)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("input, textarea, [contenteditable='true']") && data?.types.includes("text/plain")) return;
    e.preventDefault();
    const now = new Date();
    sendFiles(pasted.map((file, i) => pastedName(file, i, now)));
  });
  useEffect(() => {
    if (!canUpload) return;
    const paste = (e: ClipboardEvent) => onPaste(e);
    // Arquivo solto fora da área de envio: o navegador abriria o arquivo no lugar da OS.
    const stopDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    document.addEventListener("paste", paste);
    window.addEventListener("dragover", stopDrop);
    window.addEventListener("drop", stopDrop);
    return () => {
      document.removeEventListener("paste", paste);
      window.removeEventListener("dragover", stopDrop);
      window.removeEventListener("drop", stopDrop);
    };
  }, [canUpload]);

  const items = attachments.data ?? [];
  const photos = items.filter(isViewableImage);
  const files = items.filter((a) => !isViewableImage(a));
  const fromForms = items.filter((a) => a.form_id !== null);
  const shown = filter === "photos" ? photos : filter === "files" ? files : filter === "forms" ? fromForms : items;
  const shownPhotos = shown.filter(isViewableImage);
  const shownFiles = shown.filter((a) => !isViewableImage(a));
  const busy = progress !== null && progress.done < progress.total;

  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      {canUpload ? (
        <div
          onDragEnter={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            if (!hasFiles(e)) return;
            // Sair de um elemento de dentro da área também dispara dragleave: conta a profundidade.
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            sendFiles(Array.from(e.dataTransfer.files));
          }}
          className={clsx(
            "flex flex-col gap-3 rounded-xl border-2 border-dashed p-4 transition-colors",
            dragging ? "border-brand bg-brand-soft" : "border-line bg-surface-2/50",
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-brand shadow-elev-1 ring-1 ring-line">
              <ImagePlus className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">
                {dragging ? "Solte para enviar" : "Arraste fotos e arquivos para cá ou cole um print com Ctrl+V"}
              </p>
              <p className="text-xs text-ink-muted">Vários de uma vez, até {MAX_UPLOAD_MB} MB cada. PDF e outros arquivos ficam só com a central.</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                sendFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Button variant="primary" onClick={() => inputRef.current?.click()}>
              <Upload className="size-4" />
              Escolher do computador
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Fase das fotos" className="inline-flex shrink-0 rounded-lg border border-line bg-surface p-0.5">
              {(["antes", "depois"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={phase === p}
                  onClick={() => setPhase((current) => (current === p ? null : p))}
                  className={clsx(
                    "h-7 rounded-md px-2.5 text-xs font-semibold transition-colors",
                    phase === p ? "bg-brand text-white dark:bg-brand-strong" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  {PHASE_LABEL[p]}
                </button>
              ))}
            </div>
            <Input
              value={caption}
              onChange={(e) => setCaption(e.target.value.slice(0, 490))}
              placeholder="Descrição para os próximos envios (ex.: Rack depois da organização)"
              aria-label="Descrição dos anexos"
              className="min-w-48 flex-1"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <Checkbox label="Mostrar as fotos no relatório do cliente" checked={toReport} onChange={setToReport} />
            <p className="pl-6 text-xs text-ink-muted">
              {toReport
                ? "O cliente vê as fotos no relatório e o técnico vê no app."
                : "As imagens ficam só com a central: fora do relatório do cliente e do app do técnico (ex.: comprovantes)."}
            </p>
          </div>
          {progress ? (
            <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
              <div className="flex items-center justify-between text-xs text-ink-muted">
                <span>
                  {busy
                    ? `Enviando: ${progress.done} de ${progress.total} prontos...`
                    : `${progress.total - progress.failed.length} de ${progress.total} enviados`}
                </span>
                {!busy ? (
                  <button type="button" onClick={() => setProgress(null)} className="font-medium text-ink-muted hover:text-ink">
                    Fechar
                  </button>
                ) : null}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300"
                  style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </div>
              {progress.failed.map((f, i) => (
                <p key={`${f}-${i}`} className="text-xs text-red-700 dark:text-red-400">
                  {f}
                </p>
              ))}
              {progress.notes.map((n, i) => (
                <p key={`${n}-${i}`} className="flex items-start gap-1.5 text-xs text-ink-muted">
                  <Info className="mt-px size-3.5 shrink-0" />
                  {n}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {attachments.isLoading ? (
        <LoadingBlock rows={3} />
      ) : attachments.error ? (
        <div className="flex flex-col items-start gap-2">
          <ErrorBox message={errorMessage(attachments.error)} />
          <Button size="sm" onClick={() => void attachments.refetch()}>
            <RotateCw className="size-3.5" />
            Tentar de novo
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Paperclip />} title="Nenhum anexo" description="Fotos e arquivos enviados pelo técnico ou pela equipe aparecem aqui." />
      ) : (
        <>
          <Tabs
            variant="segmented"
            className="self-start"
            items={[
              { key: "all" as Filter, label: "Todos", count: items.length },
              { key: "photos" as Filter, label: "Fotos", count: photos.length },
              ...(fromForms.length ? [{ key: "forms" as Filter, label: "Dos formulários", count: fromForms.length }] : []),
              { key: "files" as Filter, label: "Arquivos", count: files.length },
            ]}
            value={filter}
            onChange={setFilter}
            ariaLabel="Filtrar anexos"
          />

          {shownPhotos.length ? (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {shownPhotos.map((a, i) => {
                const url = absoluteApiUrl(a.download_url);
                const isSignature = a.id === signatureId;
                const context = formContext(a, forms);
                const tilePhase = photoPhase(a.description);
                const label = captionText(a.description) || context?.label || a.filename;
                return (
                  <li
                    key={a.id}
                    className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-elev-1 transition-colors hover:border-line-strong"
                  >
                    <button
                      type="button"
                      onClick={() => setZoom(i)}
                      className="relative block bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none focus-visible:ring-inset"
                      aria-label={`Ampliar ${label}`}
                    >
                      <AttachmentImage
                        attachment={a}
                        alt={label}
                        className={clsx("aspect-[4/3] w-full", isSignature ? "bg-white object-contain p-2" : "object-cover")}
                      />
                      {isSignature || tilePhase ? (
                        <span className="absolute top-2 left-2 rounded-md bg-surface/90 px-1.5 py-0.5 text-[11px] font-semibold text-ink shadow-elev-1">
                          {isSignature ? "Assinatura" : PHASE_LABEL[tilePhase as PhotoPhase]}
                        </span>
                      ) : null}
                    </button>
                    <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                      {context ? (
                        <p className="truncate text-[11px] font-semibold text-ink-muted" title={context.label}>
                          {context.label}
                        </p>
                      ) : null}
                      <Caption attachment={a} canEdit={canManage} phases={!isSignature} onSaved={invalidate} />
                      <p className="truncate text-[11px] text-ink-subtle" title={`${a.filename} · ${meta(a)}`}>
                        {meta(a)}
                      </p>
                      <div className="mt-auto flex items-center justify-between gap-1">
                        <VisibilityChip attachment={a} />
                        <span className="flex items-center gap-0.5">
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-2 hover:text-brand"
                              aria-label={`Abrir ${a.filename} em outra aba`}
                              title="Abrir em outra aba"
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          ) : null}
                          {canManage && !isSignature ? (
                            <button
                              type="button"
                              disabled={remove.isPending && remove.variables?.id === a.id}
                              onClick={() => askRemove(a)}
                              className="rounded-md p-1.5 text-ink-subtle hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-500/10"
                              aria-label={`Excluir ${a.filename}`}
                              title="Excluir"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          ) : null}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {shownFiles.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
              {shownFiles.map((a) => {
                const url = absoluteApiUrl(a.download_url);
                const kind = fileKind(a.filename, a.content_type);
                const context = formContext(a, forms);
                return (
                  <li key={a.id} className="flex items-start gap-3 px-3.5 py-3">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-muted">
                      {kind === "video" ? <FileVideo className="size-4" /> : <FileText className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{a.filename}</p>
                      <p className="text-xs text-ink-subtle">
                        {context ? `${context.label} · ` : ""}
                        {meta(a)}
                      </p>
                      {kind === "heic" ? (
                        <p className="mt-0.5 text-xs text-ink-muted">Foto em HEIC: o navegador não mostra. Baixe para abrir no computador.</p>
                      ) : null}
                      <div className="mt-1">
                        <Caption attachment={a} canEdit={canManage} phases={false} onSaved={invalidate} />
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1">
                      <VisibilityChip attachment={a} />
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-surface-2"
                          aria-label={`Baixar ${a.filename}`}
                        >
                          <Download className="size-3.5" />
                          Baixar
                        </a>
                      ) : null}
                      {canManage && a.id !== signatureId ? (
                        <button
                          type="button"
                          disabled={remove.isPending && remove.variables?.id === a.id}
                          onClick={() => askRemove(a)}
                          className="rounded-md p-1.5 text-ink-subtle hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-500/10"
                          aria-label={`Excluir ${a.filename}`}
                          title="Excluir"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      )}

      {zoom !== null ? <Lightbox items={shownPhotos} index={zoom} forms={forms} onClose={() => setZoom(null)} onMove={setZoom} /> : null}
    </div>
  );
}

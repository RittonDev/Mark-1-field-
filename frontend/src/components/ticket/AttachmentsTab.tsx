"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  ImagePlus,
  Paperclip,
  Pencil,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useConfirm } from "@/components/Confirm";
import { Tabs } from "@/components/motion";
import { useToast } from "@/components/Toaster";
import { Button, EmptyState, ErrorBox, Input, isTopLayer, LoadingBlock, restoreFocus, Textarea, trapTab } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { ATTACHMENT_KIND } from "@/lib/constants";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { Attachment, UUID } from "@/lib/types";
import { useInvalidateTicket } from "./useConflictHandler";

type Filter = "all" | "photos" | "files";
const isImage = (a: Attachment) => a.content_type.startsWith("image/") || a.kind === "photo" || a.kind === "signature";

function meta(a: Attachment) {
  return [
    ATTACHMENT_KIND[a.kind] ?? a.kind,
    a.external ? "no Field Control" : formatBytes(a.size_bytes),
    a.uploaded_by?.name ?? null,
    formatDateTime(a.created_at),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Legenda do anexo: mostra, edita (gestão ou quem enviou) e salva. */
function Caption({ attachment, canEdit, onSaved }: { attachment: Attachment; canEdit: boolean; onSaved: () => void }) {
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
    return (
      <div className="flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
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
  if (attachment.description) {
    if (!canEdit) return <p className="text-xs leading-relaxed text-ink">{attachment.description}</p>;
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
        aria-label={`Editar descrição: ${attachment.description}`}
      >
        {attachment.description}
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
      className="inline-flex items-center gap-1 text-xs text-ink-subtle hover:text-brand"
    >
      <Pencil className="size-3" />
      Adicionar descrição
    </button>
  ) : null;
}

function Lightbox({ items, index, onClose, onMove }: { items: Attachment[]; index: number; onClose: () => void; onMove: (i: number) => void }) {
  const a = items[index];
  const box = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Foco no Fechar ao abrir e de volta na miniatura ao fechar (teclado e leitor de tela).
  useEffect(() => {
    const opener = document.activeElement;
    closeButton.current?.focus();
    return () => restoreFocus(opener);
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
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={`Foto: ${a.description || a.filename}`}
      className="fixed inset-0 z-50 flex animate-fade flex-col items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button ref={closeButton} type="button" onClick={onClose} className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Fechar">
        <X className="size-5" />
      </button>
      {index > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMove(index - 1);
          }}
          className="absolute top-1/2 left-4 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          aria-label="Anterior"
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
          className="absolute top-1/2 right-4 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          aria-label="Próxima"
        >
          <ChevronRight className="size-6" />
        </button>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- link assinado da API ou do armazenamento de origem */}
      <img src={absoluteApiUrl(a.download_url) ?? undefined} alt={a.description ?? a.filename} className="max-h-[80vh] max-w-full animate-pop rounded-xl object-contain shadow-pop" onClick={(e) => e.stopPropagation()} />
      <p className="mt-3 max-w-2xl text-center text-sm text-white/90">{a.description ?? a.filename}</p>
      <p className="mt-0.5 text-xs text-white/60">
        {index + 1} de {items.length} · {meta(a)}
      </p>
    </div>,
    document.body,
  );
}

/**
 * Anexos da OS: o técnico envia pelo app; a gestão também envia daqui (arrastando do Windows),
 * descreve cada foto (vai para o relatório do cliente) e exclui o que não serve.
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
  const queryClient = useQueryClient();
  const invalidate = useInvalidateTicket(ticketId);
  const { toast } = useToast();
  const confirm = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [caption, setCaption] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; failed: string[] } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [zoom, setZoom] = useState<number | null>(null);
  const canUpload = !closed || canManage;

  const attachments = useQuery({
    queryKey: ["ticket", ticketId, "attachments"],
    queryFn: () => api.get<Attachment[]>(`/tickets/${ticketId}/attachments`),
  });
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["ticket", ticketId, "attachments"] });
    invalidate();
  }, [queryClient, ticketId, invalidate]);

  const remove = useMutation({
    mutationFn: (a: Attachment) => api.delete(`/attachments/${a.id}`),
    onSuccess: (_, a) => {
      refresh();
      toast({ title: "Anexo excluído", description: a.filename, tone: "success" });
    },
    onError: (e) => toast({ title: "Não foi possível excluir", description: errorMessage(e), tone: "error" }),
  });
  const askRemove = async (a: Attachment) => {
    const ok = await confirm({
      title: "Excluir este anexo?",
      description: `“${a.filename}” sai da OS e do relatório do cliente. Não dá para desfazer.`,
      confirmLabel: "Excluir",
      tone: "danger",
    });
    if (ok) remove.mutate(a);
  };

  // Envia os arquivos um por um (fotos viram "Foto"; o resto, "Arquivo"), com a mesma descrição opcional.
  const sendFiles = async (files: File[]) => {
    if (!files.length) return;
    const failed: string[] = [];
    setProgress({ done: 0, total: files.length, failed });
    for (const [i, file] of files.entries()) {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", file.type.startsWith("image/") ? "photo" : "file");
      if (caption.trim()) form.append("description", caption.trim());
      try {
        await api.upload<Attachment>(`/tickets/${ticketId}/attachments`, form);
      } catch (e) {
        failed.push(`${file.name}: ${errorMessage(e)}`);
      }
      setProgress({ done: i + 1, total: files.length, failed: [...failed] });
    }
    refresh();
    if (inputRef.current) inputRef.current.value = "";
    const ok = files.length - failed.length;
    if (ok) {
      toast({ title: ok === 1 ? "Anexo enviado" : `${ok} anexos enviados`, tone: "success" });
      setCaption("");
    }
    if (!failed.length) setProgress(null);
  };

  const items = attachments.data ?? [];
  const photos = items.filter(isImage);
  const files = items.filter((a) => !isImage(a));
  const shown = filter === "photos" ? photos : filter === "files" ? files : items;
  const shownPhotos = shown.filter(isImage);
  const shownFiles = shown.filter((a) => !isImage(a));

  return (
    <div className="flex flex-col gap-4">
      {canUpload ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void sendFiles(Array.from(e.dataTransfer.files));
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
              <p className="text-sm font-semibold text-ink">{dragging ? "Solte para enviar" : "Arraste fotos e arquivos do computador para cá"}</p>
              <p className="text-xs text-ink-muted">Pode enviar vários de uma vez. Fotos entram como foto; PDF e outros, como arquivo.</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void sendFiles(Array.from(e.target.files ?? []))}
            />
            <Button variant="primary" onClick={() => inputRef.current?.click()} loading={progress !== null && progress.done < progress.total}>
              {progress !== null && progress.done < progress.total ? null : <Upload className="size-4" />}
              Escolher do computador
            </Button>
          </div>
          <Input
            value={caption}
            onChange={(e) => setCaption(e.target.value.slice(0, 500))}
            placeholder="Descrição opcional para os próximos envios (ex.: Rack depois da organização)"
            aria-label="Descrição dos anexos"
          />
          {progress ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs text-ink-muted">
                <span>
                  {progress.done < progress.total ? `Enviando ${progress.done + 1} de ${progress.total}...` : `${progress.total - progress.failed.length} de ${progress.total} enviados`}
                </span>
                {progress.done >= progress.total ? (
                  <button type="button" onClick={() => setProgress(null)} className="text-ink-subtle hover:text-ink">
                    Fechar
                  </button>
                ) : null}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
              {progress.failed.map((f) => (
                <p key={f} className="text-xs text-red-600 dark:text-red-400">
                  {f}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {attachments.isLoading ? (
        <LoadingBlock rows={3} />
      ) : attachments.error ? (
        <ErrorBox message={errorMessage(attachments.error)} />
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
              { key: "files" as Filter, label: "Arquivos", count: files.length },
            ]}
            value={filter}
            onChange={setFilter}
            ariaLabel="Filtrar anexos"
          />

          {shownPhotos.length ? (
            <ul className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {shownPhotos.map((a, i) => {
                const url = absoluteApiUrl(a.download_url);
                const isSignature = a.id === signatureId;
                return (
                  <li key={a.id} style={{ ["--i" as string]: i }} className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-elev-1">
                    <button type="button" onClick={() => setZoom(i)} className="relative block bg-surface-2" aria-label={`Ampliar ${a.filename}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- link assinado da API ou do armazenamento de origem */}
                      <img
                        src={url ?? undefined}
                        alt={a.description ?? a.filename}
                        loading="lazy"
                        className={clsx(
                          "aspect-[4/3] w-full transition-transform duration-500 ease-out-expo group-hover:scale-[1.03]",
                          isSignature ? "bg-white object-contain p-2" : "object-cover",
                        )}
                      />
                      {isSignature ? (
                        <span className="absolute top-2 left-2 rounded-md bg-surface/90 px-1.5 py-0.5 text-[11px] font-medium text-ink shadow-elev-1">Assinatura</span>
                      ) : null}
                    </button>
                    <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                      <Caption attachment={a} canEdit={canManage} onSaved={refresh} />
                      <p className="truncate text-[11px] text-ink-subtle" title={`${a.filename} · ${meta(a)}`}>
                        {meta(a)}
                      </p>
                      <div className="mt-auto flex items-center justify-end gap-1">
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-2 hover:text-brand" aria-label="Abrir" title="Abrir em outra aba">
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
                return (
                  <li key={a.id} className="flex items-start gap-3 px-3.5 py-3">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-subtle">
                      <FileText className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{a.filename}</p>
                      <p className="text-xs text-ink-subtle">{meta(a)}</p>
                      <div className="mt-1">
                        <Caption attachment={a} canEdit={canManage} onSaved={refresh} />
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1">
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-surface-2">
                          <Download className="size-3.5" />
                          Baixar
                        </a>
                      ) : null}
                      {canManage ? (
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

      {zoom !== null ? <Lightbox items={shownPhotos} index={zoom} onClose={() => setZoom(null)} onMove={setZoom} /> : null}
    </div>
  );
}

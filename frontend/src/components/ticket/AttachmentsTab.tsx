"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, FileImage, FileText, Paperclip, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button, EmptyState, ErrorBox, LoadingBlock, Select } from "@/components/ui";
import { absoluteApiUrl, api, errorMessage } from "@/lib/api";
import { ATTACHMENT_KIND } from "@/lib/constants";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { Attachment, UUID } from "@/lib/types";
import { useInvalidateTicket, useTicketErrorHandler } from "./useConflictHandler";

export function AttachmentsTab({ ticketId, closed }: { ticketId: UUID; closed: boolean }) {
  const invalidate = useInvalidateTicket(ticketId);
  const onError = useTicketErrorHandler(ticketId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("file");

  const attachments = useQuery({
    queryKey: ["ticket", ticketId, "attachments"],
    queryFn: () => api.get<Attachment[]>(`/tickets/${ticketId}/attachments`),
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", kind);
      return api.upload<Attachment>(`/tickets/${ticketId}/attachments`, form);
    },
    onSuccess: () => {
      if (inputRef.current) inputRef.current.value = "";
      invalidate();
    },
    onError,
  });

  const items = attachments.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {!closed ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line bg-surface-2 p-3">
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-40">
            {Object.entries(ATTACHMENT_KIND).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept={kind === "photo" ? "image/*" : undefined}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
            }}
          />
          <Button onClick={() => inputRef.current?.click()} loading={upload.isPending}>
            {upload.isPending ? null : <Upload className="size-4" />}
            Enviar arquivo
          </Button>
          <span className="text-xs text-ink-muted">Fotos de evidência, laudos, assinatura do cliente.</span>
        </div>
      ) : null}

      {attachments.isLoading ? (
        <LoadingBlock />
      ) : attachments.error ? (
        <ErrorBox message={errorMessage(attachments.error)} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Paperclip className="size-7" />} title="Nenhum anexo" />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {items.map((a) => {
            const url = absoluteApiUrl(a.download_url);
            const Icon = a.content_type.startsWith("image/") ? FileImage : FileText;
            return (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                <Icon className="size-5 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{a.filename}</p>
                  <p className="text-xs text-ink-muted">
                    {ATTACHMENT_KIND[a.kind] ?? a.kind} · {formatBytes(a.size_bytes)} · {a.uploaded_by?.name ?? "—"} ·{" "}
                    {formatDateTime(a.created_at)}
                  </p>
                </div>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-surface-2"
                  >
                    <Download className="size-3.5" />
                    Baixar
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

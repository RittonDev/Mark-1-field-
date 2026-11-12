"use client";

import clsx from "clsx";
import { FileText, ImageIcon, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type { UUID } from "@/lib/types";

/** Envia os arquivos escolhidos na abertura, um a um, para a OS recém-criada. */
export async function uploadPending(ticketId: UUID, files: File[], onProgress?: (done: number) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const [i, file] of files.entries()) {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", file.type.startsWith("image/") ? "photo" : "file");
    try {
      await api.upload(`/tickets/${ticketId}/attachments`, form);
    } catch {
      failed.push(file.name);
    }
    onProgress?.(i + 1);
  }
  return failed;
}

/** Anexos da abertura (prints, fotos que o cliente mandou, PDF): sobem quando a OS é criada. */
export function PendingFiles({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const add = (list: FileList | null) => {
    if (!list?.length) return;
    const seen = new Set(files.map((f) => `${f.name}:${f.size}`));
    onChange([...files, ...Array.from(list).filter((f) => !seen.has(`${f.name}:${f.size}`))].slice(0, 20));
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
        className={clsx(
          "flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-3.5 py-3 transition-colors",
          over ? "border-brand bg-brand-soft/50" : "border-line-strong bg-surface-2/60",
        )}
      >
        <Paperclip className="size-4 text-ink-subtle" />
        <p className="min-w-0 flex-1 text-xs text-ink-muted">
          Arraste prints, fotos ou PDFs que o cliente mandou, ou{" "}
          <button type="button" onClick={() => input.current?.click()} className="font-medium text-brand hover:underline">
            escolha do computador
          </button>
          . Sobem junto quando a OS for aberta.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {files.length ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {files.map((f) => (
            <li key={`${f.name}:${f.size}`} className="flex animate-fade items-center gap-2.5 px-3 py-2 text-sm">
              {f.type.startsWith("image/") ? <ImageIcon className="size-4 text-ink-subtle" /> : <FileText className="size-4 text-ink-subtle" />}
              <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
              <span className="text-xs text-ink-subtle tabular-nums">{formatBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => onChange(files.filter((x) => x !== f))}
                className="rounded p-1 text-ink-subtle hover:bg-surface-2 hover:text-red-600"
                aria-label={`Tirar ${f.name}`}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

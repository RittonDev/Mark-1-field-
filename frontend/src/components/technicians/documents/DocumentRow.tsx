"use client";

import { ExternalLink } from "lucide-react";
import { Button, buttonClassName, Pill } from "@/components/ui";
import { DOCUMENT_KIND, documentDue, documentDueText } from "@/lib/constants";
import { documentSentText } from "@/lib/documents";
import { formatBytes, formatDate, todayISO } from "@/lib/format";
import type { TechDocument, TechDocumentFile, UUID } from "@/lib/types";
import { FileLink } from "./FileLink";

/** As cores do selo (cor só para problema): vencida e vencendo. */
const DUE_COLOR = { expired: "#dc2626", soon: "#d97706" } as const;

/** "NR10.pdf · 1,2 MB · Enviado pelo técnico em 25/11/2026". */
function fileLine(file: TechDocumentFile): string {
  return `${file.file_name} · ${formatBytes(file.size)} · ${documentSentText(file, formatDate(file.uploaded_at))}`;
}

/**
 * A validade (só a certificação tem): vencida em vermelho e vencendo em âmbar, no selo; mais longe, o texto neutro
 * "Válida até …". Sem validade, nada.
 */
export function DocumentDueBadge({ expiresOn }: { expiresOn: string | null }) {
  const today = todayISO();
  const due = documentDue(expiresOn, today);
  const text = documentDueText(expiresOn, today);
  if (!due || !text) return null;
  if (due.state === "ok") return <span className="text-xs text-ink-muted">{text}</span>;
  return (
    <span title={`Validade ${formatDate(expiresOn)}`}>
      <Pill color={DUE_COLOR[due.state]}>{text}</Pill>
    </span>
  );
}

/**
 * Um documento do técnico: o título em negrito com o selo da validade, o arquivo ("{arquivo} · {tamanho} · {enviado}"),
 * "Abrir" (outra aba) e, com Editar, "Substituir", "Editar" (não no currículo) e "Excluir"; as versões anteriores num
 * bloco que abre e fecha, cada uma com o seu "Abrir". `showKind`: o tipo antes do título (a Homologação lista todos
 * juntos). `refetchFile(fileId)` relê a lista e devolve o link novo do arquivo (findFileUrl), para o link vencido.
 */
export function DocumentRow({
  doc,
  fetchedAt,
  refetchFile,
  canEdit,
  showKind = false,
  busy = false,
  onReplace,
  onEdit,
  onDelete,
}: {
  doc: TechDocument;
  /** Quando a lista foi lida (o dataUpdatedAt da consulta). */
  fetchedAt: number;
  refetchFile: (fileId: UUID) => Promise<string | null>;
  canEdit: boolean;
  showKind?: boolean;
  /** Excluindo: as ações ficam travadas. */
  busy?: boolean;
  onReplace?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const previous = doc.previous ?? [];
  const editable = canEdit && doc.kind !== "resume";

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {showKind ? <span className="text-xs font-medium text-ink-muted">{DOCUMENT_KIND[doc.kind]}</span> : null}
            <span className="font-semibold break-words text-ink">{doc.title}</span>
            <DocumentDueBadge expiresOn={doc.expires_on} />
          </p>
          <p className="text-xs break-words text-ink-muted">{fileLine(doc.file)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <FileLink
            url={doc.file.url}
            fetchedAt={fetchedAt}
            refresh={() => refetchFile(doc.file.id)}
            label={`Abrir ${doc.title} em outra aba`}
            className={buttonClassName("ghost", "sm")}
          >
            <ExternalLink aria-hidden className="size-3.5" />
            Abrir
          </FileLink>
          {canEdit && onReplace ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onReplace} aria-label={`Substituir o arquivo de ${doc.title}`}>
              Substituir
            </Button>
          ) : null}
          {editable && onEdit ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit} aria-label={`Editar ${doc.title}`}>
              Editar
            </Button>
          ) : null}
          {canEdit && onDelete ? (
            <Button size="sm" variant="ghost" loading={busy} onClick={onDelete} aria-label={`Excluir ${doc.title}`}>
              Excluir
            </Button>
          ) : null}
        </div>
      </div>
      {previous.length ? (
        <details className="group text-xs">
          <summary className="w-fit cursor-pointer rounded font-medium text-ink-muted select-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none">
            Versões anteriores ({previous.length})
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
            {previous.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                <span className="min-w-0 break-words text-ink-muted">{fileLine(file)}</span>
                <FileLink
                  url={file.url}
                  fetchedAt={fetchedAt}
                  refresh={() => refetchFile(file.id)}
                  label={`Abrir ${file.file_name}, versão de ${formatDate(file.uploaded_at)}, em outra aba`}
                  className="inline-flex shrink-0 items-center gap-1 rounded font-medium text-ink-muted hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                >
                  <ExternalLink aria-hidden className="size-3" />
                  Abrir
                </FileLink>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

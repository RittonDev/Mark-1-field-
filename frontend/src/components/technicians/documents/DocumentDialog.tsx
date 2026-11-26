"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useToast } from "@/components/Toaster";
import { Button, buttonClassName, Dialog, ErrorBox, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { DOCUMENT_ACCEPT, DOCUMENT_KIND, DOCUMENT_LIMITS, DOCUMENT_TITLE_SUGGESTIONS } from "@/lib/constants";
import {
  cleanDocumentTitle,
  DOCUMENT_CREATE_TITLE,
  DOCUMENT_EDITED,
  DOCUMENT_MSG,
  DOCUMENT_REPLACED,
  DOCUMENT_SENT,
  documentExpiryProblem,
  documentFileProblem,
  documentPatch,
  documentTitleProblem,
  EXPIRY_FIRST_DAY,
  expiryLastDay,
  hasExpiry,
  hasTitle,
  newUploadId,
  withDocument,
} from "@/lib/documents";
import { formatBytes, todayISO } from "@/lib/format";
import type { TechDocument, TechDocumentKind, UUID } from "@/lib/types";
import { apiErrorText } from "../ficha/SectionCard";

/** O que o diálogo faz: enviar um documento novo de um tipo, substituir o arquivo de um ou editar título e validade. */
export type DocumentTarget =
  | { mode: "create"; kind: TechDocumentKind }
  | { mode: "replace"; doc: TechDocument }
  | { mode: "edit"; doc: TechDocument };

/** A consulta dos documentos do técnico (useTechDocuments). */
export const documentsKey = (technicianId: UUID) => ["technicians", "documents", technicianId] as const;

/**
 * Enviar, substituir ou editar um documento do técnico na ficha (Técnicos Editar). Enviar: "Título" (não no currículo,
 * com as sugestões do tipo), "Validade" (só na certificação) e o arquivo (PDF ou foto, até 10 MB). Substituir: o arquivo
 * e, na certificação, a validade (o arquivo atual vai para as versões anteriores). Editar: título e validade, só o que
 * mudou. O arquivo e o título são conferidos aqui antes (o servidor confere de novo, pelo conteúdo); o erro dele vai no
 * quadro de erro. Gravou: a lista na tela troca na hora e as telas do técnico (lista, histórico) buscam de novo.
 */
export function DocumentDialog({
  technicianId,
  target,
  onClose,
}: {
  technicianId: UUID;
  target: DocumentTarget;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const formId = useId();
  const listId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const doc = target.mode === "create" ? null : target.doc;
  const kind = target.mode === "create" ? target.kind : target.doc.kind;
  const today = todayISO();
  const [initial] = useState(() => ({ title: doc?.title ?? "", expiresOn: doc?.expires_on ?? "" }));
  const [title, setTitle] = useState(initial.title);
  const [expiresOn, setExpiresOn] = useState(initial.expiresOn);
  // O arquivo escolhido e o id do envio: o mesmo nas novas tentativas (o servidor não duplica), outro a cada arquivo.
  const [picked, setPicked] = useState<{ file: File; uploadId: string } | null>(null);
  const [tried, setTried] = useState(false);

  const showTitle = target.mode !== "replace" && hasTitle(kind);
  const showExpiry = hasExpiry(kind);
  const showFile = target.mode !== "edit";
  const suggestions = kind === "certification" || kind === "personal" ? DOCUMENT_TITLE_SUGGESTIONS[kind] : null;

  // O arquivo errado aparece na hora; o que falta (arquivo, título), só depois do primeiro envio.
  const fileError = !showFile ? null : picked ? documentFileProblem(picked.file) : tried ? DOCUMENT_MSG.file : null;
  const titleError = showTitle && tried ? documentTitleProblem(title) : null;
  const expiryError = showExpiry && tried ? documentExpiryProblem(expiresOn, today) : null;
  const patch = doc && target.mode === "edit" ? documentPatch(doc, { title, expiresOn }) : null;
  const unchanged = patch !== null && Object.keys(patch).length === 0;
  const dirty = picked !== null || title !== initial.title || expiresOn !== initial.expiresOn;

  const save = useMutation({
    mutationFn: async () => {
      const base = `/technicians/${technicianId}/documents`;
      if (doc && target.mode === "edit") return api.patch<TechDocument>(`${base}/${doc.id}`, patch);
      if (!picked) throw new Error(DOCUMENT_MSG.file);
      const form = new FormData();
      form.append("file", picked.file);
      form.append("client_upload_id", picked.uploadId);
      if (!doc) {
        form.append("kind", kind);
        // O currículo é sempre "Currículo" (o servidor também garante).
        form.append("title", hasTitle(kind) ? cleanDocumentTitle(title) : DOCUMENT_KIND.resume);
        if (showExpiry && expiresOn) form.append("expires_on", expiresOn);
        return api.upload<TechDocument>(base, form);
      }
      // Substituir: a validade só vai quando mudou ("" tira; sem ela, fica a de antes).
      if (showExpiry && expiresOn !== (doc.expires_on ?? "")) form.append("expires_on", expiresOn);
      return api.upload<TechDocument>(`${base}/${doc.id}/replace`, form);
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<TechDocument[]>(documentsKey(technicianId), (list) => withDocument(list, saved));
      // O vencimento da lista de Técnicos, o detalhe e o histórico do cadastro (a lista de documentos relê junto).
      void queryClient.invalidateQueries({ queryKey: ["technicians"] });
      toast({
        title: target.mode === "create" ? DOCUMENT_SENT[kind] : target.mode === "replace" ? DOCUMENT_REPLACED : DOCUMENT_EDITED,
        tone: "success",
      });
      onClose();
    },
    onError: () => {
      // Documento que saiu (outra pessoa excluiu) ou limite: a lista relê por trás do diálogo.
      void queryClient.invalidateQueries({ queryKey: documentsKey(technicianId) });
    },
  });

  const submit = () => {
    if (save.isPending) return;
    setTried(true);
    const problems = [
      showFile ? documentFileProblem(picked?.file) : null,
      showTitle ? documentTitleProblem(title) : null,
      showExpiry ? documentExpiryProblem(expiresOn, today) : null,
    ];
    if (problems.some(Boolean)) {
      // Os erros aparecem no próximo quadro: o primeiro campo com erro recebe o foco.
      window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    if (unchanged) return;
    save.mutate();
  };

  const dialogTitle =
    target.mode === "create"
      ? DOCUMENT_CREATE_TITLE[kind]
      : target.mode === "replace"
        ? `Substituir ${target.doc.title}`
        : `Editar ${target.doc.title}`;
  const submitLabel = target.mode === "create" ? "Enviar" : target.mode === "replace" ? "Substituir" : "Salvar";

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty}
      busy={save.isPending}
      title={dialogTitle}
      description={target.mode === "replace" ? "O arquivo atual vai para as versões anteriores." : undefined}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={save.isPending} disabled={unchanged}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {showTitle ? (
          <Field label="Título" required error={titleError}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={DOCUMENT_LIMITS.titleMax}
              list={suggestions ? listId : undefined}
              autoComplete="off"
              autoFocus
              aria-invalid={titleError ? true : undefined}
            />
            {suggestions ? (
              <datalist id={listId}>
                {suggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            ) : null}
          </Field>
        ) : null}
        {showExpiry ? (
          <Field label="Validade" error={expiryError} className="sm:max-w-xs">
            <Input
              type="date"
              value={expiresOn}
              min={EXPIRY_FIRST_DAY}
              max={expiryLastDay(today)}
              onChange={(e) => setExpiresOn(e.target.value)}
              aria-invalid={expiryError ? true : undefined}
            />
          </Field>
        ) : null}
        {showFile ? (
          <FilePicker picked={picked?.file ?? null} error={fileError} onPick={(file) => setPicked({ file, uploadId: newUploadId() })} />
        ) : null}
        {save.error ? <ErrorBox message={apiErrorText(save.error)} /> : null}
      </form>
    </Dialog>
  );
}

/** "Arquivo": o botão que abre o seletor (PDF ou foto) e, escolhido, "{nome} · {tamanho}". */
function FilePicker({ picked, error, onPick }: { picked: File | null; error: string | null; onPick: (file: File) => void }) {
  const errorId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-ink/80">
        Arquivo<span className="text-red-600 dark:text-red-400"> *</span>
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <label
          className={clsx(
            buttonClassName("secondary", "sm"),
            "cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus",
          )}
        >
          <Upload aria-hidden className="size-3.5" />
          {picked ? "Trocar arquivo" : "Escolher arquivo"}
          <input
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="sr-only"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Escolher o mesmo arquivo de novo dispara de novo.
              e.target.value = "";
              if (file) onPick(file);
            }}
          />
        </label>
        {picked ? (
          <span className="min-w-0 text-sm break-words text-ink">
            {picked.name} · {formatBytes(picked.size)}
          </span>
        ) : null}
      </div>
      {error ? (
        <span id={errorId} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}

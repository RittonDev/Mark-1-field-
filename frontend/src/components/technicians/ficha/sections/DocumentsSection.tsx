"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/Confirm";
import { useToast } from "@/components/Toaster";
import { Button, ErrorBox, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import { DOCUMENT_LIMIT_TEXT, DOCUMENT_REMOVED, documentsAtLimit, documentsOfKind, findFileUrl, withoutDocument } from "@/lib/documents";
import { useTechDocuments } from "@/lib/queries";
import type { TechDocument, TechDocumentKind, Technician, UUID } from "@/lib/types";
import { DocumentDialog, type DocumentTarget, documentsKey } from "../../documents/DocumentDialog";
import { DocumentRow } from "../../documents/DocumentRow";
import { fichaLabel } from "../FichaNav";
import { apiErrorText, SectionCard, SubTitle } from "../SectionCard";

/** O botão de enviar de cada tipo. */
const SEND_LABEL: Record<TechDocumentKind, string> = {
  certification: "Enviar certificação",
  personal: "Enviar documento",
  resume: "Enviar currículo",
  internal: "Enviar anexo",
};

/** O tipo sem nenhum documento. */
const EMPTY_TEXT: Record<TechDocumentKind, string> = {
  certification: "Nenhuma certificação.",
  personal: "Nenhum documento pessoal.",
  resume: "Nenhum currículo.",
  internal: "Nenhum anexo interno.",
};

/**
 * Os documentos do técnico na ficha (Documentos, Currículo e Anexos internos usam a mesma consulta, cada seção com os
 * seus tipos) e o que a central faz com eles: o diálogo de enviar, substituir e editar, e excluir (pergunta antes). O
 * link do arquivo abre em outra aba; lido há muito tempo, a lista é relida antes (`refetchFile`).
 */
export function useDocumentSection(technicianId: UUID) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const docs = useTechDocuments(technicianId);
  const [target, setTarget] = useState<DocumentTarget | null>(null);

  const remove = useMutation({
    mutationFn: (doc: TechDocument) => api.delete<void>(`/technicians/${technicianId}/documents/${doc.id}`),
    onSuccess: (_, doc) => {
      queryClient.setQueryData<TechDocument[]>(documentsKey(technicianId), (list) => withoutDocument(list, doc.id));
      // O vencimento da lista de Técnicos, o detalhe e o histórico do cadastro.
      void queryClient.invalidateQueries({ queryKey: ["technicians"] });
      toast({ title: DOCUMENT_REMOVED[doc.kind], tone: "success" });
    },
    onError: (error) => {
      toast({ title: "Não foi possível excluir", description: apiErrorText(error), tone: "error" });
      void queryClient.invalidateQueries({ queryKey: documentsKey(technicianId) });
    },
  });

  const askRemove = async (doc: TechDocument) => {
    const ok = await confirm({
      tone: "danger",
      title: `Excluir ${doc.title}?`,
      description: "O arquivo e as versões anteriores são apagados de vez.",
      confirmLabel: "Excluir",
    });
    if (ok) remove.mutate(doc);
  };

  /** O link novo de um arquivo (o atual ou uma versão), da lista relida agora; null se ele saiu da lista. */
  const refetchFile = async (fileId: UUID) => findFileUrl((await docs.refetch()).data, fileId);

  return {
    docs,
    open: setTarget,
    askRemove,
    removingId: remove.isPending ? (remove.variables?.id ?? null) : null,
    refetchFile,
    dialog: target ? <DocumentDialog technicianId={technicianId} target={target} onClose={() => setTarget(null)} /> : null,
  };
}

type DocumentSectionState = ReturnType<typeof useDocumentSection>;

/** A lista ainda chegando, o erro (com "Tentar de novo"; a API de antes da Gestão não tem a rota) ou os documentos. */
export function DocumentsLoaded({
  section,
  children,
}: {
  section: DocumentSectionState;
  children: (list: TechDocument[]) => React.ReactNode;
}) {
  const { docs } = section;
  if (docs.data) return <>{children(docs.data)}</>;
  if (docs.error) return <ErrorBox message={apiErrorText(docs.error)} onRetry={() => void docs.refetch()} />;
  return <Skeleton className="h-16 w-full" />;
}

/**
 * Um bloco de documentos de um tipo: o título (quando a seção tem mais de um bloco), o botão de enviar (com Editar e
 * abaixo do limite), as linhas (DocumentRow, com Substituir, Editar e Excluir para quem edita) ou o vazio.
 */
export function DocumentBlock({
  section,
  list,
  kind,
  canEdit,
  title,
  atLimit = false,
}: {
  section: DocumentSectionState;
  list: TechDocument[];
  kind: TechDocumentKind;
  canEdit: boolean;
  /** O título do bloco ("Certificações"); sem ele, o bloco é a seção. */
  title?: string;
  atLimit?: boolean;
}) {
  const items = documentsOfKind(list, kind);
  const send =
    canEdit && !atLimit ? (
      <Button size="sm" onClick={() => section.open({ mode: "create", kind })}>
        <Plus aria-hidden className="size-3.5" />
        {SEND_LABEL[kind]}
      </Button>
    ) : null;

  return (
    <section className="flex min-w-0 flex-col gap-3">
      {title || send ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title ? <SubTitle>{title}</SubTitle> : <span />}
          {send}
        </div>
      ) : null}
      {items.length ? (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((doc) => (
            <li key={doc.id} className="py-3 first:pt-0 last:pb-0">
              <DocumentRow
                doc={doc}
                fetchedAt={section.docs.dataUpdatedAt}
                refetchFile={section.refetchFile}
                canEdit={canEdit}
                busy={section.removingId === doc.id}
                onReplace={() => section.open({ mode: "replace", doc })}
                onEdit={() => section.open({ mode: "edit", doc })}
                onDelete={() => void section.askRemove(doc)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">{EMPTY_TEXT[kind]}</p>
      )}
    </section>
  );
}

/**
 * Documentos (Dados pessoais e cadastrais): as certificações (com a validade e o aviso de vencimento) e os documentos
 * pessoais, de qualquer origem (o técnico no app, a ficha da homologação, a central). Com Técnicos Editar, a central
 * envia, substitui (a versão anterior fica guardada), edita e exclui; até 30 entre os dois blocos.
 */
export function DocumentsSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const section = useDocumentSection(tech.id);
  return (
    <SectionCard title={fichaLabel("documentos")}>
      <DocumentsLoaded section={section}>
        {(list) => {
          const atLimit = documentsAtLimit(list, "certification");
          return (
            <>
              <DocumentBlock section={section} list={list} kind="certification" canEdit={canEdit} title="Certificações" atLimit={atLimit} />
              <div className="border-t border-line pt-5">
                <DocumentBlock
                  section={section}
                  list={list}
                  kind="personal"
                  canEdit={canEdit}
                  title="Documentos pessoais"
                  atLimit={atLimit}
                />
              </div>
              {canEdit && atLimit ? <p className="text-sm text-ink-muted">{DOCUMENT_LIMIT_TEXT.documents}</p> : null}
            </>
          );
        }}
      </DocumentsLoaded>
      {section.dialog}
    </SectionCard>
  );
}

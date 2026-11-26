"use client";

import { DOCUMENT_LIMIT_TEXT, documentsAtLimit } from "@/lib/documents";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";
import { DocumentBlock, DocumentsLoaded, useDocumentSection } from "./DocumentsSection";

/**
 * Anexos internos (Gestão): documentos da parceria que só a central vê (o técnico nunca, nem no app), com título e sem
 * validade, até 30. Só com Técnicos Editar (o menu nem mostra a seção sem ele); enviar, substituir, editar e excluir.
 */
export function InternalFilesSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const section = useDocumentSection(tech.id);
  return (
    <SectionCard title={fichaLabel("anexos")}>
      <DocumentsLoaded section={section}>
        {(list) => {
          const atLimit = documentsAtLimit(list, "internal");
          return (
            <>
              <DocumentBlock section={section} list={list} kind="internal" canEdit={canEdit} atLimit={atLimit} />
              {canEdit && atLimit ? <p className="text-sm text-ink-muted">{DOCUMENT_LIMIT_TEXT.internal}</p> : null}
            </>
          );
        }}
      </DocumentsLoaded>
      {section.dialog}
    </SectionCard>
  );
}

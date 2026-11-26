"use client";

import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";
import { DocumentBlock, DocumentsLoaded, useDocumentSection } from "./DocumentsSection";

/**
 * Currículo (Perfil profissional): um só, do técnico (app ou ficha da homologação) ou da central. Com Técnicos Editar,
 * a central envia (sem currículo), substitui (o anterior fica nas versões anteriores) e exclui; sem título próprio nem
 * validade.
 */
export function ResumeSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const section = useDocumentSection(tech.id);
  return (
    <SectionCard title={fichaLabel("curriculo")}>
      <DocumentsLoaded section={section}>
        {(list) => (
          // Com um currículo, enviar outro é Substituir (na linha).
          <DocumentBlock
            section={section}
            list={list}
            kind="resume"
            canEdit={canEdit}
            atLimit={list.some((doc) => doc.kind === "resume")}
          />
        )}
      </DocumentsLoaded>
      {section.dialog}
    </SectionCard>
  );
}

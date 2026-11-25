"use client";

import type { Technician } from "@/lib/types";
import { EducationPart, ProfileUnavailable, profileInfo, stampText } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/** Formação (só leitura; o técnico mantém no app): cursos, escolaridade e formação técnica. */
export function EducationSection({ tech }: { tech: Technician }) {
  const info = profileInfo(tech);
  return (
    <SectionCard title={fichaLabel("formacao")} aside={info ? stampText(info.stamps.education) : undefined}>
      {!info ? (
        <ProfileUnavailable />
      ) : info.informed.education ? (
        <EducationPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
    </SectionCard>
  );
}

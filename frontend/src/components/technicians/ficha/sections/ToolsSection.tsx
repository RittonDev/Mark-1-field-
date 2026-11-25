"use client";

import type { Technician } from "@/lib/types";
import { ProfileUnavailable, profileInfo, stampText, ToolsPart } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/** Ferramental (só leitura; o técnico marca no app, da lista de Configurações › Técnicos). */
export function ToolsSection({ tech }: { tech: Technician }) {
  const info = profileInfo(tech);
  return (
    <SectionCard title={fichaLabel("ferramental")} aside={info ? stampText(info.stamps.tools) : undefined}>
      {!info ? (
        <ProfileUnavailable />
      ) : info.informed.tools ? (
        <ToolsPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
    </SectionCard>
  );
}

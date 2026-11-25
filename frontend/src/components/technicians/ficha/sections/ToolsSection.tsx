"use client";

import type { Technician } from "@/lib/types";
import { partStamp, ProfileUnavailable, profileInfo, ToolsPart } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/** Ferramental (só leitura; o técnico marca no app, da lista de Configurações › Técnicos). */
export function ToolsSection({ tech }: { tech: Technician }) {
  const info = profileInfo(tech);
  return (
    <SectionCard title={fichaLabel("ferramental")} aside={partStamp(info, "tools")}>
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

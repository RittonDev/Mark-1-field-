"use client";

import type { Technician } from "@/lib/types";
import { HomologationAreas, ProfileUnavailable, profileInfo, SkillsPart, stampText } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/**
 * Aptidões (só leitura; o técnico mantém no app): cada uma com o nível e o "desde", e as áreas da ficha aprovada na
 * homologação (o link para a ficha fica no cabeçalho).
 */
export function SkillsSection({ tech }: { tech: Technician }) {
  const info = profileInfo(tech);
  return (
    <SectionCard title={fichaLabel("aptidoes")} aside={info ? stampText(info.stamps.skills) : undefined}>
      {!info ? (
        <ProfileUnavailable />
      ) : info.informed.skills ? (
        <SkillsPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
      <HomologationAreas tech={tech} />
    </SectionCard>
  );
}

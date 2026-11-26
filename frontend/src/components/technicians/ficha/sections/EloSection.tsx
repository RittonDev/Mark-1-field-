"use client";

import { useState } from "react";
import { useLeaveGuard } from "@/components/settings/shared";
import type { Technician } from "@/lib/types";
import { LevelSection } from "../../LevelSection";
import { TechnicianStatsSection } from "../../TechnicianStats";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/**
 * Elo (o de hoje): a faixa, os critérios, as ocorrências (desconsiderar pede Editar) e os atendimentos por mês. O
 * motivo de desconsiderar digitado e não enviado segura a saída da tela, como um formulário.
 */
export function EloSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const [draft, setDraft] = useState(false);
  useLeaveGuard(draft, "O motivo de desconsiderar ainda não foi enviado.");
  return (
    <SectionCard title={fichaLabel("elo")}>
      {/* O título "Elo" é o da seção: o do LevelSection sai (hideTitle), e a faixa continua escrita junto da medalha. */}
      <LevelSection tech={tech} readOnly={!canEdit} dirty={false} onDraftChange={setDraft} hideTitle />
      <TechnicianStatsSection technicianId={tech.id} />
    </SectionCard>
  );
}

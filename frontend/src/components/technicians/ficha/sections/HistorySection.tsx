"use client";

import type { Technician } from "@/lib/types";
import { ProfileHistory } from "../../ProfileHistory";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/** Histórico do cadastro: o que mudou, quando, por quem e por onde (app, central, ficha da homologação, link do e-mail). */
export function HistorySection({ tech }: { tech: Technician }) {
  return (
    <SectionCard title={fichaLabel("historico")}>
      <ProfileHistory technicianId={tech.id} bare />
    </SectionCard>
  );
}

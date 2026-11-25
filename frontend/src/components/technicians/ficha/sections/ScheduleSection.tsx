"use client";

import { NeutralChip } from "@/components/settings/shared";
import { periodText, unavailableOn } from "@/lib/constants";
import { todayISO } from "@/lib/format";
import type { Technician } from "@/lib/types";
import { AvailabilityPart, ProfileUnavailable, profileInfo, stampText } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { SectionCard, SubTitle } from "../SectionCard";

/**
 * Dias e horários (só leitura; o técnico mantém no app): os turnos em que atende, com o carimbo de quando chegou, e os
 * períodos em que avisou que não atende (sem motivo). Nesses períodos ele sai das sugestões e das ofertas.
 */
export function ScheduleSection({ tech }: { tech: Technician }) {
  const info = profileInfo(tech);
  const today = todayISO();
  // A API manda só os que não terminaram, pelo início.
  const periods = (tech.unavailability ?? []).filter((p) => p.end >= today);
  const now = unavailableOn(periods, today);

  return (
    <SectionCard title={fichaLabel("dias-e-horarios")} aside={info ? stampText(info.stamps.availability) : undefined}>
      {!info ? (
        <ProfileUnavailable />
      ) : info.informed.availability ? (
        <AvailabilityPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
      <section className="flex flex-col gap-2 border-t border-line pt-5">
        <SubTitle>Indisponibilidade</SubTitle>
        {periods.length ? (
          <ul className="flex flex-col gap-1.5">
            {periods.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                {periodText(p)}
                {now?.id === p.id ? <NeutralChip>Agora</NeutralChip> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nenhum período de indisponibilidade.</p>
        )}
      </section>
    </SectionCard>
  );
}

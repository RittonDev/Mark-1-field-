"use client";

import type { Technician } from "@/lib/types";
import { ProfileUnavailable, profileInfo, stampText, TransportPart, vehicleText } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { SectionCard } from "../SectionCard";

/** Transporte (só leitura; o técnico mantém no app): meios de transporte, CNH e o veículo (modelo e placa). */
export function TransportSection({ tech }: { tech: Technician }) {
  const info = profileInfo(tech);
  const vehicle = vehicleText(tech);
  return (
    <SectionCard title={fichaLabel("transporte")} aside={info ? stampText(info.stamps.transport) : undefined}>
      {!info ? (
        <>
          <ProfileUnavailable />
          {vehicle ? <p className="text-sm text-ink">{vehicle}</p> : null}
        </>
      ) : info.informed.transport ? (
        <TransportPart tech={tech} withVehicle />
      ) : (
        <>
          <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
          {vehicle ? <p className="text-sm text-ink">{vehicle}</p> : null}
        </>
      )}
    </SectionCard>
  );
}

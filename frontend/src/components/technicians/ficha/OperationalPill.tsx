"use client";

import { Pill } from "@/components/ui";
import { OPERATIONAL_STATUS } from "@/lib/constants";
import { OPERATIONAL_STATUS_COLOR, operationalTitle } from "@/lib/technicians";
import type { OperationalStatus } from "@/lib/types";

/**
 * O selo "Inativo" / "Bloqueado" com o motivo no `title` (sem o motivo, "Não recebe OS"). Ativo não tem selo: cor só para
 * problema. Serve a ficha, Favoritos, Mais próximos e o Mapa (qualquer técnico com a situação).
 */
export function OperationalPill({
  tech,
}: {
  tech: { operational_status?: OperationalStatus; operational_reason?: string | null };
}) {
  const status = tech.operational_status ?? "active";
  if (status === "active") return null;
  return (
    <span title={operationalTitle(tech.operational_reason)} className="inline-flex shrink-0">
      <Pill color={OPERATIONAL_STATUS_COLOR[status]}>{OPERATIONAL_STATUS[status]}</Pill>
    </span>
  );
}

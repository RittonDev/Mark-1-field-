import { PRIORITY, SLA_STATUS, STATUS } from "../lib/constants";
import { computeSlaStatus } from "../lib/sla";
import type { ProjectRef, TicketListItem, TicketPriority, TicketStatus } from "../lib/types";
import { useTheme } from "../theme/theme";
import { Badge } from "./ui";

/** OS de projeto: avisa o técnico que o trabalho faz parte de um projeto (somente leitura). */
export function ProjectBadge({ project }: { project: ProjectRef | null | undefined }) {
  const c = useTheme();
  if (!project) return null;
  return <Badge label={`Projeto ${project.code} · ${project.name}`} color={c.info} />;
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  const info = STATUS[status];
  return <Badge label={info?.label ?? status} color={info?.color ?? "#64748b"} />;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const info = PRIORITY[priority];
  return <Badge label={`${info.code} ${info.label}`} color={info.color} />;
}

/** SLA recalculado no aparelho (o relógio continua correndo offline). */
export function SlaBadge({ ticket, now }: { ticket: TicketListItem; now: number }) {
  const status = computeSlaStatus(ticket, now);
  const info = SLA_STATUS[status];
  return <Badge label={`SLA ${info.label.toLowerCase()}`} color={info.color} />;
}

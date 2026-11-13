import { STATUS } from "../lib/constants";
import type { TicketStatus } from "../lib/types";
import { Badge } from "./ui";

// O técnico é terceiro: no app só o status da OS. Prioridade, SLA e projeto ficam com a gestão.
export function StatusBadge({ status }: { status: TicketStatus }) {
  const info = STATUS[status];
  return <Badge label={info?.label ?? status} color={info?.color ?? "#64748b"} />;
}

import { Pill } from "@/components/ui";
import { CLIENT_STATUS, clientStatusColor } from "@/lib/portal";
import type { TicketStatus } from "@/lib/types";

/** Situação da solicitação com o nome que o cliente entende ("Técnico a caminho", "Concluída"). */
export function Badge({ status }: { status: TicketStatus }) {
  const color = clientStatusColor(status);
  return (
    <Pill color={color}>
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {CLIENT_STATUS[status]}
    </Pill>
  );
}

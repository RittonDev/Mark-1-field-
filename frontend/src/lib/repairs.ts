import type { Repair, RepairStatus } from "./types";

// Etapas na ordem do fluxo (espelha REPAIR_STATUS_LABEL em backend/app/schemas/repair.py).
export const REPAIR_STATUS: Record<RepairStatus, { label: string; color: string }> = {
  withdrawn: { label: "Retirado no cliente", color: "#64748b" },
  received: { label: "Recebido na Maxx", color: "#2447ff" },
  sent_to_vendor: { label: "Enviado à assistência", color: "#0891b2" },
  vendor_quote: { label: "Orçamento da assistência", color: "#d97706" },
  in_repair: { label: "Em reparo", color: "#7c3aed" },
  ready_at_vendor: { label: "Pronto na assistência", color: "#0d9488" },
  back_in_stock: { label: "De volta na Maxx", color: "#059669" },
  delivered: { label: "Entregue ao cliente", color: "#16a34a" },
  unrepairable: { label: "Sem conserto", color: "#dc2626" },
  cancelled: { label: "Cancelado", color: "#98a2b3" },
};

export const REPAIR_FLOW: RepairStatus[] = [
  "withdrawn",
  "received",
  "sent_to_vendor",
  "vendor_quote",
  "in_repair",
  "ready_at_vendor",
  "back_in_stock",
];

/** Etapas em aberto fora do fluxo normal: o equipamento sem conserto ainda precisa voltar ao cliente. */
export const REPAIR_OPEN_EXTRA: RepairStatus[] = ["unrepairable"];

/** Ir para estas etapas pede o motivo (a observação vira obrigatória). */
export const REPAIR_REASON_REQUIRED: RepairStatus[] = ["cancelled", "unrepairable"];

/** Com quem o equipamento está agora, pela etapa (a pergunta da tela: "cadê a impressora da loja X?"). */
export function repairWhere(r: Pick<Repair, "status" | "vendor_name">): string {
  switch (r.status) {
    case "withdrawn":
      return "Com o técnico";
    case "received":
    case "back_in_stock":
      return "Na Maxx";
    case "sent_to_vendor":
    case "vendor_quote":
    case "in_repair":
    case "ready_at_vendor":
      return r.vendor_name ? `Na assistência ${r.vendor_name}` : "Na assistência";
    case "unrepairable":
      return "Sem conserto, devolver ao cliente";
    case "delivered":
      return "Com o cliente";
    case "cancelled":
      return "—";
  }
}

/** Há quanto tempo, em dias inteiros: "desde hoje", "há 1 dia", "há 5 dias". */
export function daysAgo(days: number): string {
  if (days <= 0) return "desde hoje";
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

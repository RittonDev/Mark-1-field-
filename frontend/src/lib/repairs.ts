import type { RepairStatus } from "./types";

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

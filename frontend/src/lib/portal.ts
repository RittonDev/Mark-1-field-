// Portal do cliente: rótulos na língua do cliente (ele não conhece o fluxo interno da OS).

import { STATUS } from "./constants";
import type { Level, TicketStatus } from "./types";

export const CLIENT_STATUS: Record<TicketStatus, string> = {
  new: "Recebida",
  triage: "Em análise",
  assigned: "Técnico definido",
  scheduled: "Visita agendada",
  en_route: "Técnico a caminho",
  in_progress: "Em atendimento",
  on_hold_customer: "Aguardando vocês",
  on_hold_vendor: "Aguardando peça",
  resolved: "Concluída",
  closed: "Concluída",
  cancelled: "Cancelada",
  reopened: "Reaberta",
};

/** Cor da etapa (a mesma da central, para as duas pontas falarem da mesma coisa). */
export const clientStatusColor = (status: TicketStatus) => STATUS[status]?.color ?? "#64748b";

export const TIMELINE_LABEL: Record<TicketStatus | "created", string> = {
  created: "Solicitação recebida",
  ...CLIENT_STATUS,
};

export const URGENCY_OPTIONS: { value: Level; label: string; hint: string }[] = [
  { value: "low", label: "Pode esperar", hint: "Não atrapalha o atendimento da loja" },
  { value: "medium", label: "Normal", hint: "Atrapalha, mas a loja segue funcionando" },
  { value: "high", label: "Urgente", hint: "Parou o caixa, a rede ou as vendas" },
];

const LAST_LOCATION = "maxx.portal.lastLocation";
const LAST_CONTACT = "maxx.portal.lastContact";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Navegador sem armazenamento: só não lembra da última loja.
  }
}

/** A última loja e o último contato usados, para a próxima solicitação sair em segundos. */
export const portalMemory = {
  lastLocation: () => read(LAST_LOCATION),
  lastContact: () => read(LAST_CONTACT) ?? "",
  remember: (locationId: string, contact: string) => {
    write(LAST_LOCATION, locationId);
    if (contact.trim()) write(LAST_CONTACT, contact.trim());
  },
};

"use client";

// Portal do cliente: rótulos na língua do cliente (ele não conhece o fluxo interno da OS).

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { STATUS } from "./constants";
import { dayKey, formatDateTime, formatTime } from "./format";
import type { Level, PortalLocation, PortalMe, PortalRequestDetail, TicketStatus, UUID } from "./types";

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

/**
 * Cor da etapa (a mesma da central, para as duas pontas falarem da mesma coisa). "Fechada" é
 * "Concluída" para o cliente: mesma palavra, mesma cor.
 */
export const clientStatusColor = (status: TicketStatus) =>
  STATUS[status === "closed" ? "resolved" : status]?.color ?? "#64748b";

export const TIMELINE_LABEL: Record<TicketStatus | "created", string> = {
  created: "Solicitação recebida",
  ...CLIENT_STATUS,
};

type Timeline = PortalRequestDetail["timeline"];

/**
 * Andamento como o cliente lê: etapas seguidas com o mesmo nome aparecem uma vez só, com a hora da
 * primeira (resolvida e depois fechada são as duas "Concluída").
 */
export function clientTimeline(timeline: Timeline): Timeline {
  return timeline.filter((entry, i) => i === 0 || TIMELINE_LABEL[entry.status] !== TIMELINE_LABEL[timeline[i - 1].status]);
}

/** Empresa desativada (sem contrato): o histórico continua no portal, abrir solicitação não. */
export const PORTAL_SUSPENDED = "O acesso da sua empresa para abrir solicitações está suspenso. Fale com a central da Maxx.";

export const canOpenRequests = (me: PortalMe | undefined) => me?.can_open_requests !== false;

export const URGENCY_OPTIONS: { value: Level; label: string; hint: string }[] = [
  { value: "low", label: "Pode esperar", hint: "Não atrapalha o atendimento da loja" },
  { value: "medium", label: "Normal", hint: "Atrapalha, mas a loja segue funcionando" },
  { value: "high", label: "Urgente", hint: "Parou o caixa, a rede ou as vendas" },
];

/**
 * Janela da visita: "14/11/2026, 14:00–16:00" no mesmo dia; início e fim completos se passar do dia.
 * O dia é o do fuso da operação, o mesmo das horas mostradas.
 */
export function visitWindow(start: string, end: string | null | undefined): string {
  if (!end) return formatDateTime(start);
  return dayKey(start) === dayKey(end)
    ? `${formatDateTime(start)}–${formatTime(end)}`
    : `${formatDateTime(start)} até ${formatDateTime(end)}`;
}

/** A empresa do usuário e quantas lojas ativas ela tem (o cabeçalho e a nova solicitação usam). */
export function usePortalMe(enabled = true) {
  return useQuery({
    queryKey: ["portal", "me"],
    queryFn: () => api.get<PortalMe>("/portal/me"),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

// Lembranças deste navegador, sempre por usuário: num computador da loja usado por várias pessoas
// (de empresas diferentes, inclusive), ninguém recebe a loja e o contato de outra pessoa.
const PREFIX = "maxx.portal.";
const key = (name: "lastLocation" | "lastContact", userId: UUID) => `${PREFIX}${name}.${userId}`;

function read(name: string): string | null {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}

function write(name: string, value: string) {
  try {
    window.localStorage.setItem(name, value);
  } catch {
    // Navegador sem armazenamento: só não lembra da última loja.
  }
}

function remove(name: string) {
  try {
    window.localStorage.removeItem(name);
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}

/** A última loja e o último contato usados, para a próxima solicitação sair em segundos. */
export const portalMemory = {
  lastLocation: (userId: UUID): PortalLocation | null => {
    const raw = read(key("lastLocation", userId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PortalLocation;
      return parsed && typeof parsed.id === "string" ? parsed : null;
    } catch {
      return null;
    }
  },
  lastContact: (userId: UUID) => read(key("lastContact", userId)) ?? "",
  remember: (userId: UUID, location: PortalLocation, contact: string) => {
    write(key("lastLocation", userId), JSON.stringify(location));
    if (contact.trim()) write(key("lastContact", userId), contact.trim());
  },
  /** A loja lembrada saiu da empresa (ou foi desativada): esquece para não sugerir de novo. */
  forgetLocation: (userId: UUID) => remove(key("lastLocation", userId)),
  /** Ao sair: apaga tudo o que o portal guardou neste navegador (inclusive as chaves antigas, sem usuário). */
  clear: () => {
    try {
      const keys = Object.keys(window.localStorage).filter((k) => k.startsWith(PREFIX));
      keys.forEach(remove);
    } catch {
      // Sem armazenamento, não há o que apagar.
    }
  },
};

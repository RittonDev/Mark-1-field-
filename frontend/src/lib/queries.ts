"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Query } from "./api";
import type {
  AssignableUser,
  CalendarEvent,
  Category,
  ConflictItem,
  Customer,
  DayActivities,
  LiveTechnician,
  MapDistances,
  Location,
  Page,
  ServiceType,
  Team,
  TrackingHistory,
  UnproductiveReason,
  User,
  UUID,
  ViolationReason,
} from "./types";

const LOOKUP_STALE = 60_000;

export function useTeams() {
  return useQuery({ queryKey: ["teams"], queryFn: () => api.get<Team[]>("/teams"), staleTime: LOOKUP_STALE });
}

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<Category[]>("/categories"),
    staleTime: LOOKUP_STALE,
  });
}

export function useCustomers(q?: string) {
  return useQuery({
    queryKey: ["customers", q ?? ""],
    queryFn: () => api.get<Customer[]>("/customers", { q }),
    staleTime: LOOKUP_STALE,
  });
}

export function useLocations(customerId: UUID | null | undefined) {
  return useQuery({
    queryKey: ["locations", customerId],
    queryFn: () => api.get<Location[]>(`/customers/${customerId}/locations`),
    enabled: Boolean(customerId),
    staleTime: LOOKUP_STALE,
  });
}

/** Busca de locais (filiais) paginada: nome, código, CNPJ, endereço ou cliente. */
export function useLocationSearch(params: {
  q?: string;
  customerId?: UUID | null;
  active?: boolean;
  page?: number;
  pageSize?: number;
}) {
  const { q, customerId, active, page = 1, pageSize = 50 } = params;
  return useQuery({
    queryKey: ["locations", "search", q ?? "", customerId ?? "", active ?? "", page, pageSize],
    queryFn: () =>
      api.get<Page<Location>>("/locations", {
        q: q || undefined,
        customer_id: customerId ?? undefined,
        active,
        page,
        page_size: pageSize,
      }),
    placeholderData: (prev) => prev,
  });
}

/** Motivos de violação de SLA (cadastro). */
export function useViolationReasons(active?: boolean) {
  return useQuery({
    queryKey: ["violation-reasons", active ?? ""],
    queryFn: () => api.get<ViolationReason[]>("/violation-reasons", { active }),
    staleTime: LOOKUP_STALE,
  });
}

/** Atividades do dia. Chave sob ["tickets"]: o tempo real (WebSocket) já invalida. */
export function useDayActivities(day: string | null, teamId?: UUID | null) {
  return useQuery({
    queryKey: ["tickets", "day", day, teamId ?? ""],
    queryFn: () => api.get<DayActivities>("/activities/day", { date: day ?? undefined, team_id: teamId ?? undefined }),
    enabled: Boolean(day),
    // "Atrasada" depende do relógio: revalida a cada minuto mesmo sem eventos.
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
}

/** Catálogo de tipos de serviço. Com cliente: os gerais + os daquele cliente. */
export function useServiceTypes(params: { customerId?: UUID | null; active?: boolean; enabled?: boolean } = {}) {
  const { customerId, active, enabled = true } = params;
  return useQuery({
    queryKey: ["service-types", customerId ?? "", active ?? ""],
    queryFn: () =>
      api.get<ServiceType[]>("/service-types", { customer_id: customerId ?? undefined, active }),
    staleTime: LOOKUP_STALE,
    enabled,
  });
}

/** Analistas, técnicos e supervisores para atribuição (só a equipe interna pode listar). */
export function useAssignable(teamId?: UUID | null, enabled = true) {
  return useQuery({
    queryKey: ["assignable", teamId ?? ""],
    queryFn: () => api.get<AssignableUser[]>("/users/assignable", { team_id: teamId ?? undefined }),
    staleTime: 15_000,
    enabled,
  });
}

export function useUsers(params: { q?: string; role?: string; team_id?: string } = {}) {
  return useQuery({
    queryKey: ["users", params],
    queryFn: () => api.get<User[]>("/users", params),
  });
}

/**
 * Técnicos no mapa ao vivo. O WebSocket atualiza as posições na hora; a releitura
 * periódica cobre o "sem sinal", que depende só da passagem do tempo.
 */
export function useLiveTechnicians(teamId?: UUID | null) {
  return useQuery({
    queryKey: ["tracking", "live", teamId ?? ""],
    queryFn: () => api.get<LiveTechnician[]>("/tracking/live", { team_id: teamId ?? undefined }),
    refetchInterval: 60_000,
  });
}

/** Posição de agora e casa de cada técnico; com loja, as distâncias até ela (mais perto primeiro). */
export function useMapDistances(locationId: UUID | null, teamId?: UUID | null, enabled = true) {
  return useQuery({
    queryKey: ["tracking", "distances", locationId ?? "", teamId ?? ""],
    queryFn: () =>
      api.get<MapDistances>("/tracking/distances", {
        location_id: locationId ?? undefined,
        team_id: teamId ?? undefined,
      }),
    refetchInterval: 60_000,
    enabled,
  });
}

export function useTrackingHistory(userId: UUID | null, date: string) {
  return useQuery({
    queryKey: ["tracking", "history", userId, date],
    queryFn: () => api.get<TrackingHistory>("/tracking/history", { user_id: userId ?? undefined, date }),
    enabled: !!userId,
  });
}

export interface CalendarQuery {
  start: string;
  end: string;
  assignee_id?: UUID[];
  unassigned?: boolean;
  team_id?: UUID;
  customer_id?: UUID;
  location_id?: UUID;
  city?: string;
  status?: string[];
}

export function useCalendar(params: CalendarQuery) {
  return useQuery({
    queryKey: ["tickets", "calendar", params],
    queryFn: () => api.get<CalendarEvent[]>("/calendar", params as unknown as Query),
    placeholderData: (previous) => previous,
  });
}

/** Prévia de conflito ao escolher técnico e horário (antes de salvar). */
export function useScheduleConflicts(params: {
  assigneeId: UUID | null | undefined;
  start: string | null;
  end?: string | null;
  estimatedMinutes?: number | null;
  excludeId?: UUID;
}) {
  const { assigneeId, start, end, estimatedMinutes, excludeId } = params;
  return useQuery({
    queryKey: ["tickets", "conflicts", assigneeId, start, end, estimatedMinutes, excludeId],
    queryFn: () =>
      api.get<ConflictItem[]>("/calendar/conflicts", {
        assignee_id: assigneeId ?? undefined,
        start: start ?? undefined,
        end: end ?? undefined,
        estimated_minutes: estimatedMinutes ?? undefined,
        exclude_id: excludeId,
      }),
    enabled: !!assigneeId && !!start,
    staleTime: 10_000,
  });
}

export function useUnproductiveReasons(active?: boolean) {
  return useQuery({
    queryKey: ["unproductive-reasons", active ?? ""],
    queryFn: () => api.get<UnproductiveReason[]>("/unproductive-reasons", { active }),
    staleTime: LOOKUP_STALE,
  });
}

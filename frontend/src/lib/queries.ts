"use client";

import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type Query } from "./api";
import type {
  AccessCatalog,
  AccessProfile,
  AssignableUser,
  CalendarEvent,
  Category,
  ConflictItem,
  Customer,
  DayActivities,
  FavoriteCityDetail,
  FavoritesOut,
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

// Todas as buscas repassam o `signal` do React Query: a busca que ficou obsoleta (texto digitado mudou,
// filtro trocado, tela fechada) é cancelada em vez de ocupar a API até o fim.

export function useTeams() {
  return useQuery({
    queryKey: ["teams"],
    queryFn: ({ signal }) => api.get<Team[]>("/teams", undefined, { signal }),
    staleTime: LOOKUP_STALE,
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => api.get<Category[]>("/categories", undefined, { signal }),
    staleTime: LOOKUP_STALE,
  });
}

export function useCustomers(q?: string) {
  return useQuery({
    queryKey: ["customers", q ?? ""],
    queryFn: ({ signal }) => api.get<Customer[]>("/customers", { q }, { signal }),
    staleTime: LOOKUP_STALE,
  });
}

export function useLocations(customerId: UUID | null | undefined) {
  return useQuery({
    queryKey: ["locations", customerId],
    queryFn: ({ signal }) => api.get<Location[]>(`/customers/${customerId}/locations`, undefined, { signal }),
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
    queryFn: ({ signal }) =>
      api.get<Page<Location>>(
        "/locations",
        {
          q: q || undefined,
          customer_id: customerId ?? undefined,
          active,
          page,
          page_size: pageSize,
        },
        { signal },
      ),
    placeholderData: (prev) => prev,
  });
}

/** Motivos de violação de SLA (cadastro). */
export function useViolationReasons(active?: boolean) {
  return useQuery({
    queryKey: ["violation-reasons", active ?? ""],
    queryFn: ({ signal }) => api.get<ViolationReason[]>("/violation-reasons", { active }, { signal }),
    staleTime: LOOKUP_STALE,
  });
}

/** Atividades do dia. Chave sob ["tickets"]: o tempo real (WebSocket) já invalida. */
export function useDayActivities(day: string | null, teamId?: UUID | null) {
  return useQuery({
    queryKey: ["tickets", "day", day, teamId ?? ""],
    queryFn: ({ signal }) =>
      api.get<DayActivities>("/activities/day", { date: day ?? undefined, team_id: teamId ?? undefined }, { signal }),
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
    queryFn: ({ signal }) =>
      api.get<ServiceType[]>("/service-types", { customer_id: customerId ?? undefined, active }, { signal }),
    staleTime: LOOKUP_STALE,
    enabled,
  });
}

/** Analistas, técnicos e supervisores para atribuição (só a equipe interna pode listar). */
export function useAssignable(teamId?: UUID | null, enabled = true) {
  return useQuery({
    queryKey: ["assignable", teamId ?? ""],
    queryFn: ({ signal }) => api.get<AssignableUser[]>("/users/assignable", { team_id: teamId ?? undefined }, { signal }),
    staleTime: 15_000,
    enabled,
  });
}

export function useUsers(params: { q?: string; role?: string; team_id?: string; access_profile_id?: string } = {}) {
  return useQuery({
    queryKey: ["users", params],
    queryFn: ({ signal }) => api.get<User[]>("/users", params, { signal }),
  });
}

/** Telas com nível de acesso (na ordem do menu) e o acesso padrão de cada papel. */
export function useAccessCatalog(enabled = true) {
  return useQuery({
    queryKey: ["access", "catalog"],
    queryFn: ({ signal }) => api.get<AccessCatalog>("/access/catalog", undefined, { signal }),
    staleTime: 10 * 60_000,
    enabled,
  });
}

/** Perfis de acesso (Supervisor, Analista e os criados na tela), com quantas pessoas usam cada um. */
export function useAccessProfiles(enabled = true) {
  return useQuery({
    queryKey: ["access", "profiles"],
    queryFn: ({ signal }) => api.get<AccessProfile[]>("/access/profiles", undefined, { signal }),
    staleTime: LOOKUP_STALE,
    enabled,
  });
}

/**
 * Técnicos no mapa ao vivo. O WebSocket atualiza as posições na hora; a releitura
 * periódica cobre o "sem sinal", que depende só da passagem do tempo.
 */
export function useLiveTechnicians(teamId?: UUID | null) {
  return useQuery({
    queryKey: ["tracking", "live", teamId ?? ""],
    queryFn: ({ signal }) => api.get<LiveTechnician[]>("/tracking/live", { team_id: teamId ?? undefined }, { signal }),
    refetchInterval: 60_000,
  });
}

/** Posição de agora e casa de cada técnico; com loja, as distâncias até ela (mais perto primeiro). */
export function useMapDistances(locationId: UUID | null, teamId?: UUID | null, enabled = true) {
  return useQuery({
    queryKey: ["tracking", "distances", locationId ?? "", teamId ?? ""],
    queryFn: ({ signal }) =>
      api.get<MapDistances>(
        "/tracking/distances",
        {
          location_id: locationId ?? undefined,
          team_id: teamId ?? undefined,
        },
        { signal },
      ),
    refetchInterval: 60_000,
    enabled,
  });
}

export function useTrackingHistory(userId: UUID | null, date: string) {
  return useQuery({
    queryKey: ["tracking", "history", userId, date],
    queryFn: ({ signal }) =>
      api.get<TrackingHistory>("/tracking/history", { user_id: userId ?? undefined, date }, { signal }),
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
    queryFn: ({ signal }) => api.get<CalendarEvent[]>("/calendar", params as unknown as Query, { signal }),
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
    queryFn: ({ signal }) =>
      api.get<ConflictItem[]>(
        "/calendar/conflicts",
        {
          assignee_id: assigneeId ?? undefined,
          start: start ?? undefined,
          end: end ?? undefined,
          estimated_minutes: estimatedMinutes ?? undefined,
          exclude_id: excludeId,
        },
        { signal },
      ),
    enabled: !!assigneeId && !!start,
    staleTime: 10_000,
  });
}

export function useUnproductiveReasons(active?: boolean) {
  return useQuery({
    queryKey: ["unproductive-reasons", active ?? ""],
    queryFn: ({ signal }) => api.get<UnproductiveReason[]>("/unproductive-reasons", { active }, { signal }),
    staleTime: LOOKUP_STALE,
  });
}

/**
 * Técnicos favoritos por cidade: todas as cidades com loja (inclusive as sem favorito) e a regra
 * automática (janela, mínimo de OS, quantos por cidade). Com `technicianId`, só as cidades em que ele é
 * favorito ou foi tirado da lista.
 */
export function useFavorites(params: { state?: string; technicianId?: UUID } = {}) {
  return useQuery({
    queryKey: ["technician-favorites", "list", params],
    queryFn: ({ signal }) =>
      api.get<FavoritesOut>(
        "/technicians/favorites",
        { state: params.state || undefined, technician_id: params.technicianId || undefined },
        { signal },
      ),
    staleTime: 60_000,
  });
}

/**
 * Favoritos da cidade da loja (Nova OS e editor da OS): a estrela dos sugeridos, a ordem do
 * Colaborador e os favoritos sem acesso ao app. Loja sem cidade e UF (422) ou que não existe mais
 * (404) não tem favoritos: null.
 */
export function useCityFavorites(locationId: UUID | null | undefined) {
  return useQuery({
    queryKey: ["technician-favorites", "city", locationId],
    queryFn: async ({ signal }) => {
      try {
        return await api.get<FavoriteCityDetail>("/technicians/favorites/city", { location_id: locationId ?? undefined }, { signal });
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 422)) return null;
        throw error;
      }
    },
    enabled: Boolean(locationId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

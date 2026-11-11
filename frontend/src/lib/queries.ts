"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { AssignableUser, Category, Customer, Location, Team, User, UUID } from "./types";

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

/** Analistas para atribuição (só equipe técnica pode listar). */
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

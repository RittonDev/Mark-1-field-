import type { QueryClient } from "@tanstack/react-query";

/**
 * Depois de criar, editar, importar ou aprovar um técnico: a base técnica, o mapa ao vivo, as listas de
 * atribuição e os usuários mudam juntos (nome, grupo e acesso ao app).
 */
export function refreshTechnicianViews(queryClient: QueryClient) {
  for (const key of ["technicians", "tracking", "assignable", "users"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

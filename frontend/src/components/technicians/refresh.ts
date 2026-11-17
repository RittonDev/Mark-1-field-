import type { QueryClient } from "@tanstack/react-query";

/**
 * Depois de criar, editar, importar ou aprovar um técnico: a base técnica, o mapa ao vivo, as listas de
 * atribuição e os usuários mudam juntos (nome, grupo e acesso ao app), e também os favoritos por cidade
 * e os técnicos sugeridos na OS (quem ganha acesso ao app passa a ter estrela e a ser sugerido).
 */
export function refreshTechnicianViews(queryClient: QueryClient) {
  for (const key of ["technicians", "tracking", "assignable", "users", "technician-favorites", "technician-suggest"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

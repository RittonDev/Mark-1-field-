"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { loginPath } from "@/lib/access";
import { useAuth } from "@/lib/auth";
import { isManager } from "@/lib/constants";
import type { UserRole } from "@/lib/types";

/** Tela de entrada de cada perfil: gestor no Início, analista na fila dele, usuário do cliente no portal. */
function landingFor(role: UserRole): string {
  if (role === "requester") return "/portal";
  if (isManager(role)) return "/inicio";
  // Analista (e o técnico, que a central desconecta e orienta a usar o app).
  return "/minha-fila";
}

/**
 * A raiz só encaminha. O perfil vem da sessão guardada no navegador, então a decisão é feita aqui (sem
 * ir ao servidor): até a sessão ser lida, a tela fica só com o fundo, sem piscar outra tela no caminho.
 * Sem sessão, vai para o login.
 */
export default function Home() {
  const router = useRouter();
  const { ready, user } = useAuth();

  useEffect(() => {
    if (!ready) return;
    router.replace(user ? landingFor(user.role) : loginPath());
  }, [ready, user, router]);

  return <div className="min-h-dvh bg-canvas" role="status" aria-label="Abrindo a central" />;
}

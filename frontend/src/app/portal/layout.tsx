"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Building2, LogOut, RotateCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { InstallAppButton, useServiceWorker } from "@/components/portal/InstallApp";
import { Button, EmptyState, Spinner } from "@/components/ui";
import { homePath } from "@/lib/access";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { initials } from "@/lib/format";
import { portalMemory, usePortalMe } from "@/lib/portal";

/**
 * Portal do cliente: em vez de mandar mensagem no WhatsApp ou e-mail, o cliente abre a solicitação
 * aqui (no navegador ou no app instalado no Windows) e acompanha a visita. Sem o menu da central:
 * só as solicitações da empresa dele.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { ready, user, logout } = useAuth();
  const isClient = user?.role === "requester";
  useServiceWorker();

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      queryClient.clear();
      router.replace("/login");
    } else if (!isClient) {
      router.replace(homePath(user.role));
    }
  }, [ready, user, isClient, router, queryClient]);

  const me = usePortalMe(ready && isClient);

  if (!ready || !user || !isClient) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas" role="status">
        <Spinner />
        <span className="sr-only">Carregando o portal...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Link href="/portal" aria-label="Maxx Field: solicitações" className="shrink-0">
            <Logo />
          </Link>
          {me.data ? (
            <span className="hidden min-w-0 items-center gap-1.5 truncate rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-muted sm:inline-flex">
              <Building2 className="size-3.5 shrink-0" />
              <span className="truncate">{me.data.customer.name}</span>
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <InstallAppButton />
            <ThemeToggle />
            <span
              className="ml-1 flex size-8 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-muted"
              title={user.name}
            >
              <span aria-hidden>{initials(user.name)}</span>
              <span className="sr-only">Conectado como {user.name}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                // Sai e apaga o que o portal lembrava neste navegador (computador da loja é compartilhado).
                portalMemory.clear();
                logout();
                queryClient.clear();
                router.replace("/login");
              }}
              className="rounded-lg p-2 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
              title="Sair"
              aria-label="Sair"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
        {me.data ? (
          <p className="flex items-center gap-1.5 border-t border-line px-4 py-1.5 text-xs font-medium text-ink-muted sm:hidden">
            <Building2 className="size-3.5 shrink-0" />
            <span className="truncate">{me.data.customer.name}</span>
          </p>
        ) : null}
      </header>
      <main className="mx-auto max-w-3xl animate-enter px-4 py-6 sm:py-8">
        {me.error ? (
          <EmptyState
            icon={<Building2 />}
            title="Acesso ao portal"
            description={errorMessage(me.error)}
            action={
              <Button onClick={() => void me.refetch()} loading={me.isFetching}>
                {me.isFetching ? null : <RotateCw className="size-4" />}
                Tentar de novo
              </Button>
            }
          />
        ) : (
          children
        )}
      </main>
    </div>
  );
}

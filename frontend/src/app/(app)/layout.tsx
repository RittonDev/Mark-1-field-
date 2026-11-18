"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/Brand";
import { CommandPalette } from "@/components/CommandPalette";
import { watchDeniedRecents } from "@/components/home/search";
import { navLabelFor } from "@/components/nav";
import { NoAccess } from "@/components/NoAccess";
import { MobileNav, Sidebar, Topbar } from "@/components/Shell";
import { TicketPanelProvider } from "@/components/ticket/TicketPanel";
import { canUseWeb, homePath, loginPath } from "@/lib/access";
import { ACCESS_DENIED_EVENT, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDocumentTitle } from "@/lib/hooks";
import { canAccess, itemForPath } from "@/lib/permissions";
import { RealtimeProvider } from "@/lib/realtime";
import { sessionStore } from "@/lib/session";
import type { User } from "@/lib/types";

/** Releitura do usuário: o perfil de acesso pode mudar com a central aberta. */
const ME_INTERVAL_MS = 5 * 60_000;

/** Abertura enquanto a sessão carrega: o símbolo da marca "respirando". */
function SplashLoader() {
  return (
    <div className="flex min-h-dvh animate-fade flex-col items-center justify-center gap-4 bg-canvas" role="status">
      <span className="relative flex size-14 items-center justify-center rounded-2xl bg-surface shadow-elev-2 ring-1 ring-line">
        <span className="absolute inset-0 animate-ping rounded-2xl bg-brand/10 [animation-duration:1.8s]" />
        <BrandMark height={16} />
      </span>
      <span className="text-xs font-medium text-ink-muted">Carregando sua sessão...</span>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { ready, user, logout } = useAuth();
  // Menu do celular aberto nesta tela: trocar de tela (link, Voltar) fecha sozinho.
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menuOpen = menuAt === pathname;
  const lastUserId = useRef<string | null>(null);

  // Nome da tela na aba do navegador (a própria página pode trocar por um mais preciso).
  useDocumentTitle(navLabelFor(pathname), { fallback: true });

  // Sessão de técnico de campo aberta antes da separação de canais: encerra e orienta a usar o app.
  const wrongChannel = !!user && !canUseWeb(user.role);
  // Usuário do cliente: o lugar dele é o portal de solicitações (sem o menu da central).
  const isClient = user?.role === "requester";

  useEffect(() => {
    if (ready && wrongChannel) {
      // Sem sessão, o ramo de baixo limpa o cache e leva ao login, que orienta a usar o app.
      logout("channel");
    } else if (ready && !user) {
      queryClient.clear();
      router.replace(loginPath());
    } else if (ready && isClient) {
      router.replace("/portal");
    }
  }, [ready, user, wrongChannel, isClient, logout, router, queryClient]);

  // Outra pessoa entrou neste navegador (em outra aba): recomeça do início, sem o cache, o tempo real e
  // a OS aberta de quem estava antes.
  const userId = user?.id ?? null;
  const role = user?.role;
  useEffect(() => {
    if (userId && lastUserId.current && userId !== lastUserId.current) {
      window.location.replace(homePath(role));
      return;
    }
    if (userId) lastUserId.current = userId;
  }, [userId, role]);

  // O usuário de agora (perfil e ajustes de acesso), relido de 5 em 5 minutos, ao voltar para a aba, no
  // aviso de acesso alterado (tempo real) e depois de um 403 de tela sem acesso.
  const central = ready && !!user && !wrongChannel && !isClient;
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: ({ signal }) => api.get<User>("/auth/me", undefined, { signal }),
    enabled: central,
    staleTime: ME_INTERVAL_MS,
    refetchInterval: ME_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  const fresh = me.data;
  useEffect(() => {
    const current = sessionStore.get()?.user;
    if (!fresh || !current || fresh.id !== current.id) return;
    // Só o acesso decide: o menu, a busca e a guarda das telas seguem o novo na hora.
    if (JSON.stringify(fresh.access ?? null) !== JSON.stringify(current.access ?? null)) sessionStore.updateUser(fresh);
  }, [fresh]);

  useEffect(() => {
    if (!central) return;
    const recheck = () => void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    window.addEventListener(ACCESS_DENIED_EVENT, recheck);
    // OS recente que deixou de abrir (outra fila ou excluída) sai das recentes da busca.
    const unwatch = watchDeniedRecents(queryClient);
    return () => {
      window.removeEventListener(ACCESS_DENIED_EVENT, recheck);
      unwatch();
    };
  }, [central, queryClient]);

  if (!ready || !user || wrongChannel || isClient) return <SplashLoader />;
  // Sessão aberta antes dos perfis de acesso: espera o /auth/me para não mostrar um menu que muda logo
  // depois (se ele falhar, segue com o acesso padrão do papel, que é o de antes).
  if (user.access === undefined && me.isPending) return <SplashLoader />;

  // Tela de um módulo fora do perfil (link direto, favorito, ?next=): a tela amigável no lugar da
  // página, sem que ela chegue a buscar nada na API.
  const item = itemForPath(pathname);
  const blocked = !!item && !canAccess(user, item);

  return (
    <RealtimeProvider key={user.id} userId={user.id}>
      {/* A OS aberta no painel lateral (?os=<id>) vale para todas as telas da central. */}
      <TicketPanelProvider>
        <div className="flex min-h-screen bg-chrome print:block print:min-h-0 print:bg-white">
          {/* Teclado: pula o menu (mais de 20 links) direto para a tela. */}
          <a
            href="#conteudo"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("conteudo")?.focus();
            }}
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink focus:shadow-pop"
          >
            Pular para o conteúdo
          </a>
          <Sidebar user={user} onLogout={logout} />
          <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2 print:p-0">
            {/* Área de trabalho em "folha" sobre a moldura. */}
            <div className="flex flex-1 flex-col border-chrome-line bg-sheet [overflow:clip] md:rounded-2xl md:border md:shadow-sheet print:rounded-none print:border-0 print:shadow-none">
              <Topbar onOpenMenu={() => setMenuAt(pathname)} menuOpen={menuOpen} />
              {/* A chave pela rota refaz a entrada suave a cada troca de tela. */}
              <main key={pathname} id="conteudo" tabIndex={-1} className="flex-1 animate-enter px-4 py-6 outline-none md:px-8 print:p-0">
                {blocked && item ? <NoAccess kind="module" item={item} /> : children}
              </main>
            </div>
          </div>
        </div>
        <MobileNav user={user} open={menuOpen} onClose={() => setMenuAt(null)} onLogout={logout} />
        <CommandPalette user={user} />
      </TicketPanelProvider>
    </RealtimeProvider>
  );
}

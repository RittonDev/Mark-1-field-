"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/Brand";
import { CommandPalette } from "@/components/CommandPalette";
import { navLabelFor } from "@/components/nav";
import { MobileNav, Sidebar, Topbar } from "@/components/Shell";
import { TicketPanelProvider } from "@/components/ticket/TicketPanel";
import { canUseWeb, homePath, loginPath } from "@/lib/access";
import { useAuth } from "@/lib/auth";
import { useDocumentTitle } from "@/lib/hooks";
import { RealtimeProvider } from "@/lib/realtime";

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

  if (!ready || !user || wrongChannel || isClient) return <SplashLoader />;

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
                {children}
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

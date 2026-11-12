"use client";

import { useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { Sidebar, Topbar } from "@/components/Shell";
import { canUseWeb } from "@/lib/access";
import { useAuth } from "@/lib/auth";
import { RealtimeProvider } from "@/lib/realtime";

/** Abertura enquanto a sessão carrega: o símbolo da marca "respirando". */
function SplashLoader() {
  return (
    <div className="flex min-h-screen animate-fade flex-col items-center justify-center gap-4 bg-canvas" role="status">
      <span className="relative flex size-14 items-center justify-center rounded-2xl bg-surface shadow-elev-2 ring-1 ring-line">
        <span className="absolute inset-0 animate-ping rounded-2xl bg-brand/10 [animation-duration:1.8s]" />
        <Image src="/brand/maxxfield-mark.png" alt="" width={32} height={16} priority />
      </span>
      <span className="text-xs font-medium text-ink-subtle">Carregando sua sessão...</span>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { ready, user, logout } = useAuth();

  // Sessão de técnico de campo aberta antes da separação de canais: encerra e orienta a usar o app.
  const wrongChannel = !!user && !canUseWeb(user.role);

  useEffect(() => {
    if (ready && wrongChannel) {
      logout();
      queryClient.clear();
      router.replace("/login?acesso=app");
    } else if (ready && !user) {
      queryClient.clear();
      router.replace("/login");
    }
  }, [ready, user, wrongChannel, logout, router, queryClient]);

  if (!ready || !user || wrongChannel) return <SplashLoader />;

  return (
    <RealtimeProvider userId={user.id}>
      <div className="flex min-h-screen bg-canvas">
        <Sidebar user={user} onLogout={logout} />
        <div className="flex min-w-0 flex-1 flex-col lg:py-2 lg:pr-2">
          {/* Área de trabalho em "folha" sobre a moldura. */}
          <div className="flex flex-1 flex-col border-l border-line bg-sheet [overflow:clip] lg:rounded-2xl lg:border lg:shadow-sheet">
            <Topbar />
            {/* A chave pela rota refaz a entrada suave a cada troca de tela. */}
            <main key={pathname} className="flex-1 animate-enter px-4 py-6 md:px-8">
              {children}
            </main>
          </div>
        </div>
      </div>
      <CommandPalette user={user} />
    </RealtimeProvider>
  );
}

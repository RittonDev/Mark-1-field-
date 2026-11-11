"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Sidebar, Topbar } from "@/components/Shell";
import { LoadingBlock } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { RealtimeProvider } from "@/lib/realtime";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { ready, user, logout } = useAuth();

  useEffect(() => {
    if (ready && !user) {
      queryClient.clear();
      router.replace("/login");
    }
  }, [ready, user, router, queryClient]);

  if (!ready || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="Carregando sessão..." />
      </div>
    );
  }

  return (
    <RealtimeProvider userId={user.id}>
      <div className="flex min-h-screen">
        <Sidebar user={user} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar user={user} onLogout={logout} />
          <main className="flex-1 px-4 py-6 md:px-6">{children}</main>
        </div>
      </div>
    </RealtimeProvider>
  );
}

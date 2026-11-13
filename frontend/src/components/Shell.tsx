"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { LogOut, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { openCommandPalette } from "@/components/CommandPalette";
import { GROUPS, visibleNav } from "@/components/nav";
import { Kbd } from "@/components/ui";
import { homePath } from "@/lib/access";
import { api } from "@/lib/api";
import { canManageTickets, ROLE } from "@/lib/constants";
import { initials } from "@/lib/format";
import { useConnectionState } from "@/lib/realtime";
import type { User } from "@/lib/types";

export { visibleNav } from "@/components/nav";

/**
 * Menu lateral claro, integrado à moldura (grafite no tema escuro).
 * O item ativo ganha uma "placa" branca que desliza entre os itens ao navegar.
 */
export function Sidebar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const pathname = usePathname();
  // Fichas de homologação aguardando análise (o evento em tempo real atualiza).
  const pending = useQuery({
    queryKey: ["onboarding", "pending-count"],
    queryFn: () => api.get<{ pending: number }>("/onboarding/applications/pending-count"),
    enabled: canManageTickets(user.role),
    staleTime: 60_000,
  });
  // Solicitações do portal esperando a central (o evento em tempo real atualiza).
  const requests = useQuery({
    queryKey: ["solicitacoes", "count"],
    queryFn: () => api.get<{ pending: number }>("/portal/inbox-count"),
    enabled: canManageTickets(user.role),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  const badges: Record<string, number> = {
    "/homologacao": pending.data?.pending ?? 0,
    "/solicitacoes": requests.data?.pending ?? 0,
  };
  const items = visibleNav(user.role);

  const wrap = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const root = wrap.current;
    const el = plate.current;
    if (!root || !el) return;
    const measure = () => {
      const active = root.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!active) {
        el.style.opacity = "0";
        return;
      }
      el.style.opacity = "1";
      el.style.height = `${active.offsetHeight}px`;
      el.style.width = `${active.offsetWidth}px`;
      el.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    };
    if (!placed.current) {
      el.style.transition = "none";
      measure();
      void el.offsetWidth;
      el.style.transition = "";
      placed.current = true;
    } else {
      measure();
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [pathname, items.length]);

  return (
    <aside className="sticky top-0 flex h-screen w-16 shrink-0 flex-col lg:w-[248px]">
      <Link
        href={homePath(user.role)}
        className="flex h-14 shrink-0 items-center px-4 lg:px-5"
        aria-label="Maxx Field: início"
      >
        <span className="lg:hidden">
          <Logo compact />
        </span>
        <span className="hidden lg:inline-flex">
          <Logo />
        </span>
      </Link>
      <nav className="flex-1 overflow-y-auto px-2.5 pb-4" aria-label="Menu principal">
        <div ref={wrap} className="relative">
          <span
            ref={plate}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 rounded-lg bg-surface opacity-0 shadow-elev-1 ring-1 ring-line transition-[transform,height,width,opacity] duration-200 ease-out-expo"
          />
          {GROUPS.map((group) => {
            const groupItems = items.filter((i) => i.group === group.key);
            if (!groupItems.length) return null;
            return (
              <div key={group.key} className={group.label ? "mt-5" : "mt-1"}>
                {group.label ? (
                  <p className="mb-1 hidden px-2.5 text-[11px] font-semibold text-chrome-subtle lg:block">{group.label}</p>
                ) : null}
                <div className="flex flex-col gap-px">
                  {groupItems.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        title={item.label}
                        aria-current={active ? "page" : undefined}
                        className={clsx(
                          "group relative flex h-[34px] items-center justify-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors lg:justify-start",
                          active ? "text-ink" : "text-chrome-muted hover:bg-chrome-hover hover:text-chrome-ink",
                        )}
                      >
                        <span className="relative shrink-0">
                          <Icon
                            className={clsx(
                              "size-[17px] transition-colors",
                              active ? "text-brand" : "text-chrome-subtle group-hover:text-chrome-muted",
                            )}
                          />
                          {badges[item.href] ? (
                            <span className="absolute -top-1 -right-1 size-2 rounded-full bg-red-500 ring-2 ring-chrome lg:hidden" aria-hidden />
                          ) : null}
                        </span>
                        <span className="hidden flex-1 truncate lg:inline">{item.label}</span>
                        {badges[item.href] ? (
                          <span
                            className="hidden min-w-5 rounded-full bg-red-500 px-1.5 text-center text-[11px] leading-[18px] font-semibold text-white tabular-nums lg:inline"
                            aria-label={`${badges[item.href]} pendentes`}
                          >
                            {badges[item.href]}
                          </span>
                        ) : null}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="shrink-0 border-t border-chrome-line p-2.5">
        <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 lg:px-2">
          <div className="hidden size-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-brand to-brand-cyan text-[11px] font-semibold text-white ring-2 ring-surface lg:flex">
            {initials(user.name)}
          </div>
          <div className="hidden min-w-0 flex-1 leading-tight lg:block">
            <p className="truncate text-[13px] font-semibold text-chrome-ink">{user.name}</p>
            <p className="truncate text-[11px] text-chrome-subtle">
              {ROLE[user.role]}
              {user.team ? ` · ${user.team.name}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="mx-auto rounded-lg p-2 text-chrome-subtle transition-colors hover:bg-chrome-hover hover:text-chrome-ink lg:mx-0"
            title="Sair"
            aria-label="Sair"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function ConnectionIndicator() {
  const state = useConnectionState();
  const label = state === "online" ? "Tempo real" : state === "connecting" ? "Conectando..." : "Offline";
  return (
    <span
      className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-surface px-3 text-xs font-medium text-ink-muted"
      title={state === "online" ? "Atualizações em tempo real ativas" : label}
    >
      {/* Ponto fixo quando está tudo bem (nada piscando o dia inteiro); só "conectando" pulsa. */}
      <span
        className={clsx(
          "size-2 rounded-full ring-2",
          state === "online" && "bg-emerald-500 ring-emerald-500/15",
          state === "connecting" && "animate-pulse bg-amber-500 ring-amber-500/15",
          state === "offline" && "bg-red-500 ring-red-500/15",
        )}
      />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

export function Topbar() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-sheet/85 px-4 backdrop-blur-md md:px-6">
      <button
        type="button"
        onClick={openCommandPalette}
        className="group inline-flex h-9 w-full max-w-md items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-sm text-ink-subtle shadow-elev-1 transition-[border-color,color] hover:border-line-strong hover:text-ink-muted"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 truncate text-left">Buscar OS, cliente ou tela...</span>
        <span className="hidden items-center gap-1 sm:inline-flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="ml-auto flex items-center gap-2">
        <ConnectionIndicator />
        <ThemeToggle />
      </div>
    </header>
  );
}

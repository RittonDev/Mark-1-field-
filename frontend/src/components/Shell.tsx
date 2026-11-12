"use client";

import clsx from "clsx";
import {
  Building2,
  CalendarClock,
  HardDrive,
  LayoutDashboard,
  LogOut,
  MapPin,
  MapPinned,
  Settings,
  SquareKanban,
  Ticket,
  Timer,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo, ThemeToggle } from "@/components/Brand";
import { canManageTickets, isManager, isStaff, ROLE } from "@/lib/constants";
import { initials } from "@/lib/format";
import { useConnectionState } from "@/lib/realtime";
import type { User, UserRole } from "@/lib/types";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  visible: (role: UserRole) => boolean;
}

const NAV: NavItem[] = [
  { href: "/chamados", label: "Chamados", icon: Ticket, visible: () => true },
  { href: "/dia", label: "Atividades do dia", icon: CalendarClock, visible: isStaff },
  { href: "/mapa", label: "Mapa ao vivo", icon: MapPinned, visible: canManageTickets },
  { href: "/quadro", label: "Quadro", icon: SquareKanban, visible: isStaff },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, visible: isStaff },
  { href: "/clientes", label: "Clientes", icon: Building2, visible: isStaff },
  { href: "/locais", label: "Locais", icon: MapPin, visible: isStaff },
  { href: "/tipos-servico", label: "Tipos de serviço", icon: Timer, visible: canManageTickets },
  { href: "/ativos", label: "Ativos", icon: HardDrive, visible: isStaff },
  { href: "/usuarios", label: "Usuários", icon: Users, visible: canManageTickets },
  { href: "/configuracoes", label: "Configurações", icon: Settings, visible: isManager },
];

export function visibleNav(role: UserRole) {
  return NAV.filter((item) => item.visible(role));
}

export function Sidebar({ user }: { user: User }) {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-sidebar-line bg-sidebar text-sidebar-ink lg:w-60">
      <Link href="/chamados" className="flex h-14 items-center px-4" aria-label="Maxx Field — chamados">
        <span className="lg:hidden">
          <Logo compact />
        </span>
        <span className="hidden lg:inline-flex">
          <Logo />
        </span>
      </Link>
      <div className="brand-gradient mx-4 h-0.5 w-10 rounded-full" />
      <nav className="mt-2 flex flex-1 flex-col gap-0.5 px-2">
        {visibleNav(user.role).map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={clsx(
                "flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors",
                active ? "bg-sidebar-active font-medium text-brand" : "hover:bg-surface-2 hover:text-ink",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="hidden lg:inline">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="hidden px-4 py-3 text-[11px] text-sidebar-ink/70 lg:block">Maxx Field · v0.1</div>
    </aside>
  );
}

function ConnectionIndicator() {
  const state = useConnectionState();
  const label = state === "online" ? "Tempo real ativo" : state === "connecting" ? "Conectando..." : "Offline";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-ink-muted"
      title={label}
    >
      <span
        className={clsx(
          "size-2 rounded-full",
          state === "online" && "bg-emerald-500",
          state === "connecting" && "animate-pulse bg-amber-500",
          state === "offline" && "bg-red-500",
        )}
      />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

export function Topbar({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-end gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur md:px-6">
      <ThemeToggle />
      <ConnectionIndicator />
      <div className="flex items-center gap-2.5 border-l border-line pl-3">
        <div className="flex size-8 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand">
          {initials(user.name)}
        </div>
        <div className="hidden leading-tight sm:block">
          <p className="text-sm font-medium text-ink">{user.name}</p>
          <p className="text-[11px] text-ink-muted">
            {ROLE[user.role]}
            {user.team ? ` · ${user.team.name}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="ml-1 rounded-md p-2 text-ink-muted hover:bg-surface-2 hover:text-ink"
          title="Sair"
          aria-label="Sair"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </header>
  );
}

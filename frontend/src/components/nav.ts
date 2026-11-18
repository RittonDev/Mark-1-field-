import {
  BadgeCheck,
  BarChart3,
  Building2,
  CalendarClock,
  CalendarDays,
  ClipboardPlus,
  ClipboardList,
  FileText,
  FolderKanban,
  HardHat,
  House,
  Inbox,
  LayoutDashboard,
  MapPin,
  MapPinned,
  MessageSquareText,
  PackageSearch,
  Receipt,
  Settings,
  Ticket,
  Timer,
  Users,
  Wallet,
} from "lucide-react";
import { canManageTickets } from "@/lib/constants";
import { canAccess } from "@/lib/permissions";
import type { AccessItemKey, User } from "@/lib/types";

export type NavGroup = "main" | "operation" | "commercial" | "base" | "analysis" | "setup";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tela com nível de acesso no perfil; null = núcleo (toda a gestão das OS). */
  access: AccessItemKey | null;
  /** Núcleo que aparece para qualquer papel da central (Chamados). */
  everyone?: boolean;
  group: NavGroup;
}

// Seções do menu na ordem do dia a dia: atender, vender, cadastrar, analisar, configurar.
export const GROUPS: { key: NavGroup; label: string | null }[] = [
  { key: "main", label: null },
  { key: "operation", label: "Operação" },
  { key: "commercial", label: "Comercial" },
  { key: "base", label: "Base" },
  { key: "analysis", label: "Análise" },
  { key: "setup", label: "Configuração" },
];

export const NAV: NavItem[] = [
  // Visão do gestor: pontos de atenção das OS, sugestões e a busca de tudo.
  { href: "/inicio", label: "Início", icon: House, access: null, group: "main" },
  { href: "/minha-fila", label: "Minha fila", icon: Inbox, access: null, group: "main" },
  // Pedidos que os clientes abrem no portal (antes chegavam pelo WhatsApp ou e-mail).
  { href: "/solicitacoes", label: "Solicitações", icon: ClipboardPlus, access: null, group: "main" },
  { href: "/chamados", label: "Chamados", icon: Ticket, access: null, everyone: true, group: "main" },
  { href: "/agenda", label: "Calendário", icon: CalendarDays, access: "operation.calendar", group: "operation" },
  { href: "/dia", label: "Atividades do dia", icon: CalendarClock, access: "operation.day", group: "operation" },
  { href: "/mapa", label: "Mapa ao vivo", icon: MapPinned, access: "operation.map", group: "operation" },
  { href: "/assistencia", label: "Assistência externa", icon: PackageSearch, access: "operation.repairs", group: "operation" },
  { href: "/orcamentos", label: "Orçamentos", icon: FileText, access: "commercial.quotes", group: "commercial" },
  { href: "/projetos", label: "Projetos", icon: FolderKanban, access: "commercial.projects", group: "commercial" },
  { href: "/custos", label: "Custos extras", icon: Receipt, access: "commercial.expenses", group: "commercial" },
  // Técnicos parceiros recebem por chamado: o fechamento dos pagamentos.
  { href: "/pagamentos", label: "Pagamentos", icon: Wallet, access: "commercial.payouts", group: "commercial" },
  { href: "/clientes", label: "Clientes", icon: Building2, access: "base.customers", group: "base" },
  { href: "/locais", label: "Locais", icon: MapPin, access: "base.locations", group: "base" },
  { href: "/tecnicos", label: "Técnicos", icon: HardHat, access: "base.technicians", group: "base" },
  { href: "/homologacao", label: "Homologação", icon: BadgeCheck, access: "base.onboarding", group: "base" },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, access: "analysis.dashboard", group: "analysis" },
  { href: "/relatorios", label: "Relatórios", icon: BarChart3, access: "analysis.reports", group: "analysis" },
  { href: "/formularios", label: "Formulários", icon: ClipboardList, access: "setup.forms", group: "setup" },
  { href: "/textos", label: "Textos do WhatsApp", icon: MessageSquareText, access: "setup.messages", group: "setup" },
  { href: "/tipos-servico", label: "Tipos de serviço", icon: Timer, access: "setup.service_types", group: "setup" },
  { href: "/usuarios", label: "Usuários", icon: Users, access: "setup.users", group: "setup" },
  { href: "/configuracoes", label: "Configurações", icon: Settings, access: "setup.settings", group: "setup" },
];

/**
 * Itens do menu que a pessoa pode abrir: o núcleo para a gestão das OS e cada tela de módulo pelo
 * perfil de acesso. O grupo que fica sem itens some do menu com o título.
 */
export function visibleNav(user: User | null | undefined): NavItem[] {
  if (!user) return [];
  return NAV.filter((item) => (item.access ? canAccess(user, item.access) : item.everyone || canManageTickets(user.role)));
}

/** Ícone de cada tela no menu (a matriz de acesso usa o mesmo). */
export const NAV_ICONS = Object.fromEntries(NAV.filter((n) => n.access).map((n) => [n.access, n.icon])) as Partial<
  Record<AccessItemKey, NavItem["icon"]>
>;

// Telas dentro de um item do menu que têm nome próprio na aba do navegador.
const SUB_PAGES: Record<string, string> = {
  "/chamados/novo": "Nova OS",
};

/** Nome da tela para o título da aba: a subtela conhecida ou o item do menu de maior prefixo. */
export function navLabelFor(pathname: string): string | null {
  if (SUB_PAGES[pathname]) return SUB_PAGES[pathname];
  let best: NavItem | null = null;
  for (const item of NAV) {
    const match = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (match && (!best || item.href.length > best.href.length)) best = item;
  }
  return best?.label ?? null;
}

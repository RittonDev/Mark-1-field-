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
  Inbox,
  LayoutDashboard,
  MapPin,
  MapPinned,
  MessageSquareText,
  PackageSearch,
  Receipt,
  Settings,
  SquareKanban,
  Ticket,
  Timer,
  Users,
  Wallet,
} from "lucide-react";
import { canManageTickets, isManager, isStaff } from "@/lib/constants";
import type { UserRole } from "@/lib/types";

export type NavGroup = "main" | "operation" | "commercial" | "base" | "analysis" | "setup";

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  visible: (role: UserRole) => boolean;
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
  { href: "/minha-fila", label: "Minha fila", icon: Inbox, visible: canManageTickets, group: "main" },
  // Pedidos que os clientes abrem no portal (antes chegavam pelo WhatsApp ou e-mail).
  { href: "/solicitacoes", label: "Solicitações", icon: ClipboardPlus, visible: canManageTickets, group: "main" },
  { href: "/chamados", label: "Chamados", icon: Ticket, visible: () => true, group: "main" },
  { href: "/agenda", label: "Calendário", icon: CalendarDays, visible: canManageTickets, group: "operation" },
  { href: "/dia", label: "Atividades do dia", icon: CalendarClock, visible: isStaff, group: "operation" },
  { href: "/mapa", label: "Mapa ao vivo", icon: MapPinned, visible: canManageTickets, group: "operation" },
  { href: "/quadro", label: "Quadro", icon: SquareKanban, visible: isStaff, group: "operation" },
  { href: "/assistencia", label: "Assistência externa", icon: PackageSearch, visible: canManageTickets, group: "operation" },
  { href: "/orcamentos", label: "Orçamentos", icon: FileText, visible: canManageTickets, group: "commercial" },
  { href: "/projetos", label: "Projetos", icon: FolderKanban, visible: canManageTickets, group: "commercial" },
  { href: "/custos", label: "Custos extras", icon: Receipt, visible: canManageTickets, group: "commercial" },
  // Técnicos parceiros recebem por chamado: o fechamento dos pagamentos.
  { href: "/pagamentos", label: "Pagamentos", icon: Wallet, visible: canManageTickets, group: "commercial" },
  { href: "/clientes", label: "Clientes", icon: Building2, visible: isStaff, group: "base" },
  { href: "/locais", label: "Locais", icon: MapPin, visible: isStaff, group: "base" },
  { href: "/tecnicos", label: "Técnicos", icon: HardHat, visible: canManageTickets, group: "base" },
  { href: "/homologacao", label: "Homologação", icon: BadgeCheck, visible: canManageTickets, group: "base" },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, visible: isStaff, group: "analysis" },
  { href: "/relatorios", label: "Relatórios", icon: BarChart3, visible: canManageTickets, group: "analysis" },
  { href: "/formularios", label: "Formulários", icon: ClipboardList, visible: canManageTickets, group: "setup" },
  { href: "/textos", label: "Textos do WhatsApp", icon: MessageSquareText, visible: canManageTickets, group: "setup" },
  { href: "/tipos-servico", label: "Tipos de serviço", icon: Timer, visible: canManageTickets, group: "setup" },
  { href: "/usuarios", label: "Usuários", icon: Users, visible: canManageTickets, group: "setup" },
  { href: "/configuracoes", label: "Configurações", icon: Settings, visible: isManager, group: "setup" },
];

export function visibleNav(role: UserRole) {
  return NAV.filter((item) => item.visible(role));
}

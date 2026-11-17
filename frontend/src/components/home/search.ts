// Busca da central (Ctrl+K e a caixa do Início): a busca inteligente da API, as OS recentes e as telas
// e ações achadas aqui mesmo, sem ir ao servidor.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AlarmClock,
  Download,
  FilePlus2,
  Inbox,
  KeyRound,
  ListChecks,
  MoonStar,
  Receipt,
  Tags,
  UserX,
  Wallet,
} from "lucide-react";
import { visibleNav } from "@/components/nav";
import { api, ApiError, request } from "@/lib/api";
import { canManageTickets, isManager } from "@/lib/constants";
import { sessionStore } from "@/lib/session";
import type { Customer, Location, Page, TicketListItem, UserRole, UUID } from "@/lib/types";
import { ticketsListHref, ticketsViewHref } from "./links";
import type { NameLike, SmartSearchResult } from "./types";

/** Texto sem acento, em minúsculas e sem espaços nas pontas ("Técnico" -> "tecnico"). */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Nome que chega como texto ou como referência ({ id, name }). */
export function nameOf(value: NameLike): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  return value.name?.trim() || null;
}

/** Código da OS como a central vê ("OS-016976"), o mesmo da API (format_ticket_code). */
export const ticketCode = (number: number) => `OS-${String(number).padStart(6, "0")}`;

// ------------------------------------------------------------------ OS recentes

/** OS aberta há pouco (o analista reabre as mesmas OS o dia todo). */
export interface RecentTicket {
  id: UUID;
  code: string;
  title: string;
}

const RECENT_LIMIT = 8;
const recentKey = (userId: string) => `mf:recentes:${userId}`;

export function readRecent(userId: string): RecentTicket[] {
  try {
    const raw = window.localStorage.getItem(recentKey(userId));
    const list = raw ? (JSON.parse(raw) as RecentTicket[]) : [];
    return Array.isArray(list)
      ? list.filter((t) => t && typeof t.id === "string" && typeof t.code === "string" && typeof t.title === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Guarda a OS entre as recentes da busca (deste usuário, neste navegador). */
export function rememberRecentTicket(ticket: RecentTicket) {
  const userId = sessionStore.get()?.user.id;
  if (!userId) return;
  try {
    const next = [{ id: ticket.id, code: ticket.code, title: ticket.title }, ...readRecent(userId).filter((t) => t.id !== ticket.id)];
    window.localStorage.setItem(recentKey(userId), JSON.stringify(next.slice(0, RECENT_LIMIT)));
  } catch {
    // Sem armazenamento: só não aparece em "Recentes".
  }
}

// ------------------------------------------------------------------ telas e ações

type Icon = React.ComponentType<{ className?: string }>;

/** Destino de uma tela ou ação: um endereço da central ou algo que acontece aqui (tema, senha). */
export type ScreenTarget = { href: string } | { action: "theme" | "password" };

export interface ScreenEntry {
  id: string;
  label: string;
  /** Segunda linha (o que a ação faz, quando o nome não basta). */
  detail?: string;
  icon: Icon;
  /** Outros nomes pelos quais a pessoa procura (sem acento não importa). */
  keywords: string[];
  target: ScreenTarget;
  kind: "screen" | "action";
}

/** Outros nomes de cada tela do menu (como a equipe fala no dia a dia). */
const SYNONYMS: Record<string, string[]> = {
  "/inicio": ["home", "painel", "pontos de atenção", "resumo", "visão geral", "gestor"],
  "/minha-fila": ["fila", "minhas os", "meus chamados", "minha fila"],
  "/solicitacoes": ["pedidos", "portal", "solicitação do cliente", "pedidos do portal"],
  "/chamados": ["os", "ordens de serviço", "lista de os", "tickets", "chamado", "lista"],
  "/agenda": ["calendário", "agendamentos", "agenda"],
  "/dia": ["atividades", "hoje", "programação do dia", "roteiro", "dia"],
  "/mapa": ["mapa", "ao vivo", "rastreamento", "localização", "gps", "onde está o técnico", "jornada"],
  "/quadro": ["kanban", "colunas"],
  "/assistencia": ["laboratório", "conserto", "reparo", "bancada", "rma", "assistência técnica"],
  "/orcamentos": ["orçamento", "proposta", "cotação", "catálogo de itens"],
  "/projetos": ["projeto", "implantação", "rollout"],
  "/custos": ["despesas", "custo", "reembolso", "gastos", "aprovar custos"],
  "/pagamentos": ["pagamento", "repasse", "pagar técnico", "pgto", "acerto", "a pagar"],
  "/clientes": ["empresas", "cliente", "cnpj", "redes"],
  "/locais": ["lojas", "loja", "filiais", "endereços", "unidades"],
  "/tecnicos": ["técnico", "parceiros", "base técnica", "prestadores", "terceiros", "freelancers"],
  "/homologacao": ["homologar", "cadastro de técnico", "aprovar técnico", "credenciamento"],
  "/dashboard": ["indicadores", "kpi", "gráficos", "métricas", "sla"],
  "/relatorios": ["relatório", "fechamento", "diário", "fechamento do dia"],
  "/formularios": ["checklist", "formulário", "questionário"],
  "/textos": ["whatsapp", "mensagens", "modelos de texto", "zap", "textos prontos"],
  "/tipos-servico": ["serviços", "tipo de serviço", "tempo padrão"],
  "/usuarios": ["usuário", "equipe", "analistas", "acessos", "login"],
  "/configuracoes": ["ajustes", "configuração", "sla", "categorias", "empresa", "motivos"],
};

interface ActionDef extends Omit<ScreenEntry, "kind"> {
  visible: (role: UserRole, ctx: { passwordAllowed: boolean }) => boolean;
}

const ACTIONS: ActionDef[] = [
  {
    id: "a-new",
    label: "Nova OS",
    detail: "Abrir uma ordem de serviço",
    icon: FilePlus2,
    keywords: ["nova ordem de serviço", "abrir chamado", "abrir os", "criar os", "novo chamado", "cadastrar os"],
    target: { href: "/chamados/novo" },
    visible: canManageTickets,
  },
  {
    id: "a-export",
    label: "Exportar chamados",
    detail: "Abre Chamados: filtre e use Exportar, na barra da lista",
    icon: Download,
    keywords: ["exportar", "planilha", "excel", "csv", "baixar os", "exportação"],
    target: { href: "/chamados" },
    visible: canManageTickets,
  },
  {
    id: "a-mine",
    label: "Minhas OS",
    detail: "Em aberto com você",
    icon: ListChecks,
    keywords: ["meus chamados", "minhas ordens", "comigo"],
    target: { href: ticketsViewHref("minhas") },
    visible: canManageTickets,
  },
  {
    id: "a-unassigned",
    label: "OS sem técnico",
    detail: "Em aberto, ainda sem técnico",
    icon: UserX,
    keywords: ["sem técnico", "sem tecnico", "não atribuídas", "sem responsável", "atribuir técnico"],
    target: { href: ticketsListHref({ unassigned: true, open_only: true }) },
    visible: canManageTickets,
  },
  {
    id: "a-sla",
    label: "OS com SLA violado",
    detail: "Em aberto com o prazo estourado",
    icon: AlarmClock,
    keywords: ["sla violado", "atrasadas", "prazo estourado", "fora do prazo", "vencidas"],
    target: { href: ticketsListHref({ sla_breached: true }) },
    visible: canManageTickets,
  },
  {
    id: "a-no-owner",
    label: "OS sem analista",
    detail: "Abertas sem analista responsável",
    icon: Inbox,
    keywords: ["sem analista", "sem dono", "órfãs", "puxar os"],
    target: { href: "/minha-fila?analista=sem" },
    visible: canManageTickets,
  },
  {
    id: "a-tags",
    label: "Etiquetas automáticas",
    detail: "Configurações · Etiquetas",
    icon: Tags,
    keywords: ["etiquetas", "tags", "regras de etiqueta", "rótulos", "marcadores"],
    target: { href: "/configuracoes#etiquetas" },
    visible: isManager,
  },
  {
    id: "a-payouts",
    label: "Pagamentos pendentes",
    detail: "Técnicos parceiros a pagar",
    icon: Wallet,
    keywords: ["pagar técnicos", "a pagar", "pendente pgto", "pgto pendente", "repasse pendente"],
    target: { href: "/pagamentos" },
    visible: canManageTickets,
  },
  {
    id: "a-costs",
    label: "Custos para aprovar",
    detail: "Custos extras lançados nas OS",
    icon: Receipt,
    keywords: ["aprovar custos", "custos pendentes", "despesas pendentes", "reembolso"],
    target: { href: "/custos" },
    visible: canManageTickets,
  },
  {
    id: "a-password",
    label: "Trocar senha",
    detail: "A senha de entrada na central",
    icon: KeyRound,
    keywords: ["alterar senha", "mudar senha", "nova senha", "senha"],
    target: { action: "password" },
    visible: (_role, ctx) => ctx.passwordAllowed,
  },
  {
    id: "a-theme",
    label: "Alternar tema claro / escuro",
    icon: MoonStar,
    keywords: ["tema", "modo escuro", "dark", "modo claro", "noturno"],
    target: { action: "theme" },
    visible: () => true,
  },
];

/** Telas do menu (na ordem dele) e ações que a pessoa pode usar. */
export function screenCatalog(role: UserRole, ctx: { passwordAllowed: boolean }): { screens: ScreenEntry[]; actions: ScreenEntry[] } {
  const screens: ScreenEntry[] = visibleNav(role).map((n) => ({
    id: `p-${n.href}`,
    label: n.label,
    icon: n.icon,
    keywords: SYNONYMS[n.href] ?? [],
    target: { href: n.href },
    kind: "screen",
  }));
  const actions: ScreenEntry[] = ACTIONS.filter((a) => a.visible(role, ctx)).map((a) => ({
    id: a.id,
    label: a.label,
    detail: a.detail,
    icon: a.icon,
    keywords: a.keywords,
    target: a.target,
    kind: "action",
  }));
  return { screens, actions };
}

// Palavras que não ajudam a achar a tela ("ir para a tela de pagamentos").
const STOPWORDS = new Set(["de", "da", "do", "das", "dos", "e", "o", "a", "as", "para", "pra", "no", "na", "nos", "nas", "em", "um", "uma", "ir", "tela", "pagina", "abrir", "ver"]);

const wordsOf = (s: string) => normalizeText(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Nota de 0 a 100: quanto a tela ou ação combina com o texto (0 = não combina). */
export function scoreScreen(entry: ScreenEntry, text: string): number {
  const q = normalizeText(text).replace(/\s+/g, " ");
  if (!q) return 0;
  const label = normalizeText(entry.label);
  const keys = entry.keywords.map(normalizeText);
  if (label === q) return 100;
  if (label.startsWith(q)) return 90;
  if (keys.includes(q)) return 85;
  if (keys.some((k) => k.startsWith(q))) return 70;
  // Cada palavra digitada começa alguma palavra do nome ou dos sinônimos, em qualquer ordem.
  const typed = wordsOf(q).filter((w) => !STOPWORDS.has(w));
  if (typed.length) {
    const labelWords = wordsOf(entry.label);
    const allWords = [...labelWords, ...keys.flatMap(wordsOf)];
    if (typed.every((w) => allWords.some((x) => x.startsWith(w)))) {
      return typed.every((w) => labelWords.some((x) => x.startsWith(w))) ? 60 : 50;
    }
  }
  if (q.length >= 3 && (label.includes(q) || keys.some((k) => k.includes(q)))) return 30;
  return 0;
}

/** As telas e ações que combinam com o texto, da mais parecida para a menos (empate: a ordem do menu). */
export function matchScreens(entries: ScreenEntry[], text: string, limit = 5): { entry: ScreenEntry; score: number }[] {
  return entries
    .map((entry, index) => ({ entry, index, score: scoreScreen(entry, text) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ entry, score }) => ({ entry, score }));
}

// ------------------------------------------------------------------ busca inteligente (API)

/** Nº de resultados de cada grupo que a busca pede à API. */
const SMART_LIMIT = 6;

/** Garante listas mesmo que a API omita algum campo. */
function normalizeSmart(data: Partial<SmartSearchResult> | null, q: string): SmartSearchResult {
  return {
    query: data?.query ?? q,
    chips: Array.isArray(data?.chips) ? data.chips : [],
    filters: data?.filters ?? null,
    total: typeof data?.total === "number" ? data.total : (data?.tickets?.length ?? 0),
    tickets: Array.isArray(data?.tickets) ? data.tickets : [],
    customers: Array.isArray(data?.customers) ? data.customers : [],
    locations: Array.isArray(data?.locations) ? data.locations : [],
    technicians: Array.isArray(data?.technicians) ? data.technicians : [],
  };
}

/**
 * Transição: enquanto a API em uso não tiver /search/smart (rota inexistente), a busca usa as buscas
 * de texto de antes (OS, clientes e locais), sem a interpretação da frase.
 */
async function legacySearch(q: string, signal: AbortSignal): Promise<SmartSearchResult> {
  const places = q.length >= 2;
  const [tickets, customers, locations] = await Promise.all([
    api.get<Page<TicketListItem>>("/tickets", { q, page_size: SMART_LIMIT }, { signal }),
    places ? api.get<Customer[]>("/customers", { q }, { signal }).catch(() => [] as Customer[]) : Promise.resolve([] as Customer[]),
    places
      ? api
          .get<Page<Location>>("/locations", { q, page_size: 5, active: true }, { signal })
          .then((p) => p.items)
          .catch(() => [] as Location[])
      : Promise.resolve([] as Location[]),
  ]);
  return {
    query: q,
    chips: [],
    filters: { q },
    total: tickets.total,
    tickets: tickets.items.map((t) => ({
      id: t.id,
      number: t.number,
      title: t.title,
      status: t.status,
      customer: t.customer?.name ?? null,
      location: t.location?.name ?? null,
      city: t.location?.city ?? null,
      technician: t.assignee?.name ?? null,
      scheduled_start: t.scheduled_start,
      created_at: t.created_at,
      tags: t.tags ?? [],
    })),
    customers: customers.slice(0, 4).map((c) => ({ id: c.id, name: c.name, document: c.document, open_count: c.open_tickets ?? 0 })),
    locations: locations.map((l) => ({ id: l.id, name: l.name, code: l.code, city: l.city, customer: l.customer?.name ?? null })),
    technicians: [],
  };
}

/** A rota não existe nesta API (404 do próprio framework ou método não aceito). */
const routeMissing = (error: unknown) =>
  error instanceof ApiError && (error.status === 405 || (error.status === 404 && error.detail === "Not Found"));

async function smartSearch(q: string, signal: AbortSignal): Promise<SmartSearchResult> {
  try {
    const data = await api.get<Partial<SmartSearchResult>>("/search/smart", { q, limit: SMART_LIMIT }, { signal });
    return normalizeSmart(data, q);
  } catch (error) {
    if (routeMissing(error)) return legacySearch(q, signal);
    throw error;
  }
}

/**
 * Busca inteligente: uma por pausa na digitação (quem chama passa o texto já com o atraso), cancelada
 * quando o texto muda, e o resultado anterior continua na tela até o novo chegar.
 */
export function useSmartSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: ["search", "smart", q],
    queryFn: ({ signal }) => smartSearch(q, signal),
    enabled,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    // Erro do pedido (4xx) não melhora tentando de novo; falha de rede ou do servidor, uma vez.
    retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1,
  });
}

/** O texto já vale uma busca: nº de OS com 1 dígito, texto a partir de 2 letras. */
export function isSearchable(q: string): boolean {
  return q.length >= 2 || (/^\d+$/.test(q) && q.length >= 1);
}

interface AuthProviders {
  password_for_staff: boolean;
}

/**
 * "Trocar senha" só quando a equipe pode entrar com senha. Mesma chave e mesma busca do menu da conta
 * (Shell): a resposta é compartilhada.
 */
export function usePasswordAllowed(): boolean {
  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => request<AuthProviders>("/auth/providers", { auth: false }),
    staleTime: 5 * 60_000,
  });
  return providers.data?.password_for_staff === true;
}

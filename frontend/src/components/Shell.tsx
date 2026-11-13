"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Bell,
  Check,
  ChevronsUpDown,
  KeyRound,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Sun,
  WifiOff,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { applyTheme, clearThemeChoice, Logo, ThemeToggle, type ThemeChoice, useThemeChoice } from "@/components/Brand";
import { openCommandPalette } from "@/components/CommandPalette";
import { useConfirm } from "@/components/Confirm";
import { GROUPS, type NavItem, visibleNav } from "@/components/nav";
import { useToast } from "@/components/Toaster";
import { useTicketPanel } from "@/components/ticket/TicketPanel";
import {
  Button,
  buttonClassName,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  isTopLayer,
  Kbd,
  lockScroll,
  restoreFocus,
  trapTab,
} from "@/components/ui";
import { useNow } from "@/components/useNow";
import { homePath } from "@/lib/access";
import { api, errorMessage, request } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageTickets, ROLE } from "@/lib/constants";
import { formatRelative, initials } from "@/lib/format";
import { hasUnsavedChanges, useDocumentTitleCount } from "@/lib/hooks";
import {
  onOpenFeedRequest,
  onOpenTicketRequest,
  type RealtimeNotice,
  useConnectionState,
  useRealtimeControl,
  useRealtimeFeed,
} from "@/lib/realtime";
import { sessionStore } from "@/lib/session";
import type { TokenResponse, User } from "@/lib/types";

export { visibleNav } from "@/components/nav";

/** Id da gaveta do menu no celular (o botão "Abrir menu" aponta para ela). */
export const MOBILE_NAV_ID = "menu-celular";

// ------------------------------------------------------------------ peças comuns do menu

/** Pendências no menu: fichas de homologação e solicitações do portal (o tempo real atualiza). */
function useNavBadges(user: User): Record<string, number> {
  const manager = canManageTickets(user.role);
  const pending = useQuery({
    queryKey: ["onboarding", "pending-count"],
    queryFn: () => api.get<{ pending: number }>("/onboarding/applications/pending-count"),
    enabled: manager,
    staleTime: 60_000,
  });
  const requests = useQuery({
    queryKey: ["solicitacoes", "count"],
    queryFn: () => api.get<{ pending: number }>("/portal/inbox-count"),
    enabled: manager,
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  return {
    "/homologacao": pending.data?.pending ?? 0,
    "/solicitacoes": requests.data?.pending ?? 0,
  };
}

/** Contador neutro (pendência não é problema): cor só para atraso e erro. */
function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "min-w-5 rounded-full bg-surface px-1.5 text-center text-[11px] leading-[18px] font-semibold text-ink tabular-nums ring-1 ring-chrome-line dark:bg-surface-3",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function Avatar({ user }: { user: User }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink-muted ring-1 ring-chrome-line"
    >
      {initials(user.name)}
    </span>
  );
}

const isActive = (pathname: string, item: NavItem) => pathname === item.href || pathname.startsWith(`${item.href}/`);

interface AuthProviders {
  microsoft: boolean;
  password_for_staff: boolean;
  microsoft_domains: string[];
}

/** "Trocar senha" só faz sentido quando a equipe pode entrar com senha (senão o login é só Microsoft). */
function usePasswordAllowed(): boolean {
  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => request<AuthProviders>("/auth/providers", { auth: false }),
    staleTime: 5 * 60_000,
  });
  return providers.data?.password_for_staff === true;
}

/** Sair, perguntando antes quando há formulário com alterações não salvas na tela. */
function useLogoutGuard(onLogout: () => void) {
  const confirm = useConfirm();
  return async () => {
    if (
      hasUnsavedChanges() &&
      !(await confirm({
        title: "Sair sem salvar?",
        description: "Há alterações não salvas na tela. Se sair agora, elas se perdem.",
        confirmLabel: "Sair mesmo assim",
        cancelLabel: "Continuar editando",
        tone: "danger",
      }))
    ) {
      return;
    }
    onLogout();
  };
}

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const formId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [tried, setTried] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post<TokenResponse>("/auth/change-password", { current_password: current, new_password: next }),
  });
  const close = () => {
    setCurrent("");
    setNext("");
    setRepeat("");
    setTried(false);
    save.reset();
    onClose();
  };
  const currentError = tried && !current ? "Digite a senha atual." : null;
  const nextError =
    (tried || next.length >= 8) && next.length < 8
      ? "Use pelo menos 8 caracteres."
      : next && next === current
        ? "A nova senha precisa ser diferente da atual."
        : null;
  const repeatError = (tried || repeat.length >= next.length) && repeat !== next && repeat ? "As senhas não conferem." : tried && !repeat ? "Repita a nova senha." : null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!current || next.length < 8 || next === current || repeat !== next) return;
    save.mutate(undefined, {
      onSuccess: (data) => {
        // A API encerra as outras sessões e devolve tokens novos para esta.
        sessionStore.fromTokenResponse(data);
        toast({ title: "Senha alterada", description: "As outras sessões abertas foram encerradas.", tone: "success" });
        close();
      },
    });
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title="Trocar senha"
      description="Ao salvar, as outras sessões abertas com a senha antiga são encerradas."
      dirty={Boolean(current || next || repeat)}
      busy={save.isPending}
      footer={
        <>
          <Button onClick={close} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={save.isPending}>
            Salvar senha
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Senha atual" required error={currentError}>
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            aria-invalid={currentError ? true : undefined}
            autoFocus
          />
        </Field>
        <Field label="Nova senha" required hint="Pelo menos 8 caracteres." error={nextError}>
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={nextError ? true : undefined}
          />
        </Field>
        <Field label="Repita a nova senha" required error={repeatError}>
          <Input
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            aria-invalid={repeatError ? true : undefined}
          />
        </Field>
        {save.error ? <ErrorBox message={errorMessage(save.error)} /> : null}
      </form>
    </Dialog>
  );
}

const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Escuro", icon: Moon },
  { value: "system", label: "Automático", icon: Monitor },
];

const menuItemClass =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-2";

/**
 * A conta no rodapé do menu: nome e papel; ao clicar, o tema (Claro, Escuro ou Automático, que segue o
 * sistema), "Trocar senha" e "Sair". Teclado no padrão de menu (setas, Home, End, Esc).
 */
function UserMenu({ user, onLogout, wide }: { user: User; onLogout: () => void; wide: boolean }) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const choice = useThemeChoice();
  const allowPassword = usePasswordAllowed();
  const logout = useLogoutGuard(onLogout);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const team = `${ROLE[user.role]}${user.team ? ` · ${user.team.name}` : ""}`;
  return (
    <div ref={root} className={clsx("relative", wide && "lg:min-w-0 lg:flex-1")} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Conta de ${user.name}`}
        title={wide ? undefined : user.name}
        className={clsx(
          "flex w-full items-center justify-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-chrome-hover",
          wide && "lg:justify-start lg:px-2",
        )}
      >
        <Avatar user={user} />
        <span className={clsx("hidden min-w-0 flex-1 leading-tight", wide && "lg:block")}>
          <span className="block truncate text-[13px] font-semibold text-chrome-ink">{user.name}</span>
          <span className="block truncate text-[11px] text-chrome-subtle">{team}</span>
        </span>
        <ChevronsUpDown aria-hidden className={clsx("hidden size-3.5 shrink-0 text-chrome-subtle", wide && "lg:block")} />
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Conta"
          className={clsx(
            "absolute bottom-0 left-full z-50 ml-2 w-64 animate-pop rounded-xl border border-line bg-surface p-1.5 shadow-pop",
            wide && "lg:bottom-full lg:left-0 lg:mb-2 lg:ml-0 lg:w-full",
          )}
        >
          <div role="none" className="border-b border-line px-2.5 pt-1.5 pb-2.5">
            <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-muted">{user.email}</p>
            <p className="truncate text-xs text-ink-muted">{team}</p>
          </div>
          <p role="none" className="px-2.5 pt-2.5 pb-1 text-[11px] font-bold tracking-[0.06em] text-ink-muted uppercase">
            Tema
          </p>
          <div role="group" aria-label="Tema">
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon;
              const checked = choice === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onClick={() => (option.value === "system" ? clearThemeChoice() : applyTheme(option.value))}
                  className={menuItemClass}
                >
                  <Icon aria-hidden className="size-4 text-ink-subtle" />
                  <span className="flex-1">{option.label}</span>
                  {checked ? <Check aria-hidden className="size-4 text-brand" /> : null}
                </button>
              );
            })}
          </div>
          <div role="separator" className="my-1.5 h-px bg-line" />
          {allowPassword ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setChanging(true);
              }}
              className={menuItemClass}
            >
              <KeyRound aria-hidden className="size-4 text-ink-subtle" />
              Trocar senha
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className={menuItemClass}
          >
            <LogOut aria-hidden className="size-4 text-ink-subtle" />
            Sair
          </button>
        </div>
      ) : null}
      <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} />
    </div>
  );
}

// Menu recolhido no computador (só o trilho de ícones): a escolha fica salva neste navegador.
const MENU_KEY = "mf:menu";
const MENU_EVENT = "mf:menu";
let collapsedFallback = false;

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(MENU_KEY) === "recolhido";
  } catch {
    return collapsedFallback;
  }
}

function writeCollapsed(value: boolean) {
  collapsedFallback = value;
  try {
    if (value) window.localStorage.setItem(MENU_KEY, "recolhido");
    else window.localStorage.removeItem(MENU_KEY);
  } catch {
    // Sem armazenamento: vale até recarregar.
  }
  window.dispatchEvent(new Event(MENU_EVENT));
}

function subscribeCollapsed(onChange: () => void) {
  window.addEventListener(MENU_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(MENU_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Menu lateral claro, integrado à moldura (grafite no tema escuro). Do tablet para cima; no celular,
 * o menu é a gaveta (MobileNav). A partir de 1024 px mostra os nomes, e dá para recolher ao trilho.
 * O item ativo ganha uma "placa" branca que desliza entre os itens ao navegar.
 */
export function Sidebar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const pathname = usePathname();
  const badges = useNavBadges(user);
  // Solicitações esperando a central aparecem no título da aba, mesmo em segundo plano.
  useDocumentTitleCount(badges["/solicitacoes"]);
  const items = visibleNav(user.role);
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const wide = !collapsed;

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
                  <p className="mb-1.5 hidden px-2.5 text-[10.5px] font-bold tracking-[0.08em] text-chrome-subtle uppercase lg:block">{group.label}</p>
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
                          active ? "font-semibold text-ink" : "text-chrome-muted hover:bg-chrome-hover hover:text-chrome-ink",
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

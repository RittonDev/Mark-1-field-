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
  RefreshCw,
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
  // Erros aparecem depois de tentar salvar (ou, na repetição, quando já dá para comparar).
  const currentError = tried && !current ? "Digite a senha atual." : null;
  const nextError =
    tried && next.length < 8
      ? "Use pelo menos 8 caracteres."
      : next && next === current
        ? "A nova senha precisa ser diferente da atual."
        : null;
  const repeatError =
    tried && !repeat
      ? "Repita a nova senha."
      : repeat && repeat !== next && (tried || repeat.length >= next.length)
        ? "As senhas não conferem."
        : null;
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
  }, [pathname, items.length, collapsed]);

  return (
    <aside
      className={clsx(
        "sticky top-0 z-40 hidden h-dvh w-16 shrink-0 flex-col md:flex print:hidden",
        wide && "lg:w-[248px]",
      )}
    >
      <Link
        href={homePath(user.role)}
        className={clsx("flex h-14 shrink-0 items-center justify-center", wide && "lg:justify-start lg:px-5")}
        aria-label="Maxx Field: início"
      >
        <span className={clsx(wide && "lg:hidden")}>
          <Logo compact />
        </span>
        {wide ? (
          <span className="hidden lg:inline-flex">
            <Logo />
          </span>
        ) : null}
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
                  <p
                    className={clsx(
                      "mb-1.5 hidden px-2.5 text-[10.5px] font-bold tracking-[0.08em] text-chrome-subtle uppercase",
                      wide && "lg:block",
                    )}
                  >
                    {group.label}
                  </p>
                ) : null}
                <div className="flex flex-col gap-px">
                  {groupItems.map((item) => {
                    const active = isActive(pathname, item);
                    const Icon = item.icon;
                    const count = badges[item.href] ?? 0;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        title={item.label}
                        aria-current={active ? "page" : undefined}
                        className={clsx(
                          "group relative flex h-[34px] items-center justify-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
                          wide && "lg:justify-start",
                          active ? "font-semibold text-ink" : "text-chrome-muted hover:bg-chrome-hover hover:text-chrome-ink",
                        )}
                      >
                        <span className="relative shrink-0">
                          <Icon
                            aria-hidden
                            className={clsx(
                              "size-[17px] transition-colors",
                              active ? "text-brand" : "text-chrome-subtle group-hover:text-chrome-muted",
                            )}
                          />
                          {count ? (
                            <span
                              aria-hidden
                              className={clsx("absolute -top-1 -right-1 size-2 rounded-full bg-ink ring-2 ring-chrome", wide && "lg:hidden")}
                            />
                          ) : null}
                        </span>
                        {/* No trilho o nome fica só para o leitor de tela (e no title, para o mouse). */}
                        <span className={clsx("sr-only", wide && "lg:hidden")}>{item.label}</span>
                        <span className={clsx("hidden flex-1 truncate", wide && "lg:inline")}>{item.label}</span>
                        {count ? (
                          <>
                            <CountBadge count={count} className={clsx("hidden", wide && "lg:inline")} />
                            <span className="sr-only">, {count} pendentes</span>
                          </>
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
        <div className={clsx("flex flex-col items-stretch gap-1", wide && "lg:flex-row lg:items-center")}>
          <UserMenu user={user} onLogout={onLogout} wide={wide} />
          <button
            type="button"
            onClick={() => writeCollapsed(!collapsed)}
            aria-label="Recolher menu"
            aria-pressed={collapsed}
            title={collapsed ? "Mostrar os nomes do menu" : "Recolher o menu"}
            className="hidden size-8 shrink-0 items-center justify-center self-center rounded-lg text-chrome-subtle transition-colors hover:bg-chrome-hover hover:text-chrome-ink lg:inline-flex"
          >
            {collapsed ? <PanelLeftOpen aria-hidden className="size-4" /> : <PanelLeftClose aria-hidden className="size-4" />}
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * Menu do celular (abaixo de 768 px): gaveta pela esquerda com os nomes, os grupos, as pendências e a
 * conta. Fecha com Esc, clique fora, troca de tela ou clique num item.
 */
export function MobileNav({
  user,
  open,
  onClose,
  onLogout,
}: {
  user: User;
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  const badges = useNavBadges(user);
  const items = visibleNav(user.role);
  const panel = useRef<HTMLDivElement>(null);
  const [changing, setChanging] = useState(false);
  const allowPassword = usePasswordAllowed();
  const logout = useLogoutGuard(onLogout);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const node = panel.current;
    if (e.defaultPrevented || !node) return;
    if (e.key === "Escape" && isTopLayer(node)) onClose();
    else if (e.key === "Tab" && isTopLayer(node, false)) trapTab(e, node);
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const unlock = lockScroll();
    panel.current?.focus();
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
      unlock();
      restoreFocus(opener);
    };
  }, [open]);

  const team = `${ROLE[user.role]}${user.team ? ` · ${user.team.name}` : ""}`;
  const footerButton =
    "flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-sm font-medium text-chrome-muted transition-colors hover:bg-chrome-hover hover:text-chrome-ink";
  return (
    <>
      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 md:hidden print:hidden" onClick={(e) => e.stopPropagation()}>
              <div className="absolute inset-0 animate-fade bg-[rgb(9_11_15/0.42)] backdrop-blur-[2px]" onClick={onClose} aria-hidden />
              <div
                ref={panel}
                id={MOBILE_NAV_ID}
                role="dialog"
                aria-modal="true"
                aria-label="Menu"
                tabIndex={-1}
                className="relative flex h-full w-[min(84vw,300px)] animate-drawer-left flex-col bg-chrome shadow-pop outline-none"
              >
                <div className="flex h-14 shrink-0 items-center justify-between pr-2 pl-4">
                  <Link href={homePath(user.role)} onClick={onClose} aria-label="Maxx Field: início">
                    <Logo />
                  </Link>
                  <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex size-10 items-center justify-center rounded-lg text-chrome-muted transition-colors hover:bg-chrome-hover hover:text-chrome-ink"
                    aria-label="Fechar menu"
                  >
                    <X aria-hidden className="size-5" />
                  </button>
                </div>
                <nav className="flex-1 overflow-y-auto px-2.5 pb-4" aria-label="Menu principal">
                  {GROUPS.map((group) => {
                    const groupItems = items.filter((i) => i.group === group.key);
                    if (!groupItems.length) return null;
                    return (
                      <div key={group.key} className={group.label ? "mt-4" : "mt-1"}>
                        {group.label ? (
                          <p className="mb-1 px-2.5 text-[10.5px] font-bold tracking-[0.08em] text-chrome-subtle uppercase">{group.label}</p>
                        ) : null}
                        <div className="flex flex-col gap-px">
                          {groupItems.map((item) => {
                            const active = isActive(pathname, item);
                            const Icon = item.icon;
                            const count = badges[item.href] ?? 0;
                            return (
                              <Link
                                key={item.href}
                                href={item.href}
                                onClick={onClose}
                                aria-current={active ? "page" : undefined}
                                className={clsx(
                                  "flex h-10 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors",
                                  active
                                    ? "bg-surface font-semibold text-ink shadow-elev-1 ring-1 ring-line"
                                    : "font-medium text-chrome-muted hover:bg-chrome-hover hover:text-chrome-ink",
                                )}
                              >
                                <Icon aria-hidden className={clsx("size-[18px] shrink-0", active ? "text-brand" : "text-chrome-subtle")} />
                                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                                {count ? (
                                  <>
                                    <CountBadge count={count} />
                                    <span className="sr-only">, {count} pendentes</span>
                                  </>
                                ) : null}
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </nav>
                <div className="shrink-0 border-t border-chrome-line p-2.5">
                  <div className="flex items-center gap-2.5 px-1.5 pt-1 pb-2">
                    <Avatar user={user} />
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="truncate text-[13px] font-semibold text-chrome-ink">{user.name}</p>
                      <p className="truncate text-[11px] text-chrome-subtle">{team}</p>
                    </div>
                  </div>
                  {allowPassword ? (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        setChanging(true);
                      }}
                      className={footerButton}
                    >
                      <KeyRound aria-hidden className="size-4 text-chrome-subtle" />
                      Trocar senha
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      void logout();
                    }}
                    className={footerButton}
                  >
                    <LogOut aria-hidden className="size-4 text-chrome-subtle" />
                    Sair
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      <ChangePasswordDialog open={changing} onClose={() => setChanging(false)} />
    </>
  );
}

/**
 * Tempo real fora: aparece só se a falha durar mais de 3 s (a reconexão rápida de um deploy ou de uma
 * troca de Wi-Fi não pisca na tela). Conectado, não ocupa a barra.
 */
function ConnectionIndicator() {
  const state = useConnectionState();
  const { reconnect } = useRealtimeControl();
  const [late, setLate] = useState(false);
  if (state === "online" && late) setLate(false);

  useEffect(() => {
    if (state === "online") return;
    const timer = window.setTimeout(() => setLate(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const down = state !== "online" && late;
  const offline = state === "offline";
  const label = offline ? "Sem tempo real" : "Reconectando...";
  return (
    <>
      {/* Região viva fora do fluxo (sem ocupar espaço na barra): o leitor de tela ouve a queda e a volta. */}
      <span role="status" className="sr-only">
        {down ? label : ""}
      </span>
      {down ? (
        <span
          className={clsx(
            "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium",
            offline
              ? "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
              : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200",
          )}
          title={
            offline
              ? "As telas não se atualizam sozinhas até a conexão voltar. Recarregue para ver o mais recente."
              : "Tentando reconectar as atualizações em tempo real."
          }
        >
          <span aria-hidden className={clsx("size-2 rounded-full", offline ? "bg-red-500" : "bg-amber-500")} />
          <span aria-hidden className="hidden sm:inline">
            {label}
          </span>
          <button
            type="button"
            onClick={reconnect}
            className="inline-flex items-center font-semibold underline-offset-2 hover:underline"
          >
            <RefreshCw aria-hidden className="size-3.5 sm:hidden" />
            <span className="sr-only sm:not-sr-only">Tentar agora</span>
          </button>
        </span>
      ) : null}
    </>
  );
}

/** Lista dos avisos recentes (OS resolvida, orçamento respondido, pedido de peça, ficha nova...). */
function NoticesButton() {
  const { items, unread, readAt, markAllRead } = useRealtimeFeed();
  const [open, setOpen] = useState(false);
  // Até onde já tinha visto quando abriu: os mais novos ficam marcados enquanto a lista está aberta.
  const [seenUntil, setSeenUntil] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const ticketPanel = useTicketPanel();
  const router = useRouter();
  const now = useNow(30_000);

  const show = () => {
    setSeenUntil(readAt);
    setOpen(true);
    markAllRead();
  };
  const hide = () => {
    setOpen(false);
    markAllRead();
  };

  // O "Ver avisos" de um aviso agrupado abre a lista.
  const onRequest = useEffectEvent(() => show());
  useEffect(() => onOpenFeedRequest(() => onRequest()), []);

  const onOutside = useEffectEvent((e: Event) => {
    if (e instanceof KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      hide();
      trigger.current?.focus();
    } else if (!root.current?.contains(e.target as Node)) {
      hide();
    }
  });
  useEffect(() => {
    if (!open) return;
    const listener = (e: Event) => onOutside(e);
    document.addEventListener("mousedown", listener);
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("keydown", listener);
    };
  }, [open]);

  const openNotice = (notice: RealtimeNotice) => {
    hide();
    if (notice.ticketId) {
      if (ticketPanel) ticketPanel.open(notice.ticketId);
      else router.push(`/chamados/${notice.ticketId}`);
    } else if (notice.href) {
      router.push(notice.href);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => (open ? hide() : show())}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={unread ? `Avisos, ${unread} novos` : "Avisos"}
        title="Avisos"
        className="relative inline-flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Bell aria-hidden className="size-4" />
        {unread ? (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-ink px-1 text-center text-[10px] leading-4 font-semibold text-surface tabular-nums ring-2 ring-sheet"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={listId}
          role="region"
          aria-label="Avisos"
          className="absolute top-full right-0 z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] animate-pop overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <p className="text-sm font-bold text-ink">Avisos</p>
            <p className="text-xs text-ink-muted">Desta sessão</p>
          </div>
          {items.length === 0 ? (
            <EmptyState
              size="sm"
              icon={<Bell />}
              title="Nenhum aviso por enquanto"
              description="OS resolvidas, orçamentos respondidos, pedidos de peça e OS passadas para a sua fila aparecem aqui."
            />
          ) : (
            <ul className="max-h-[min(26rem,70vh)] divide-y divide-line overflow-y-auto">
              {items.map((notice) => {
                const fresh = Date.parse(notice.at) > seenUntil;
                return (
                  <li key={notice.id}>
                    <button
                      type="button"
                      onClick={() => openNotice(notice)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
                    >
                      <span aria-hidden className={clsx("mt-1.5 size-2 shrink-0 rounded-full", fresh ? "bg-brand" : "bg-line-strong")} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium break-words text-ink">{notice.title}</span>
                        {notice.description ? (
                          <span className="block truncate text-xs text-ink-muted">{notice.description}</span>
                        ) : null}
                        <span className="mt-0.5 block text-[11px] text-ink-subtle">
                          {fresh ? <span className="sr-only">Novo, </span> : null}
                          {formatRelative(notice.at, now)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** Navegador sem internet (o React Query pausa as buscas e nada salva até a conexão voltar). */
function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

export function Topbar({ onOpenMenu, menuOpen = false }: { onOpenMenu?: () => void; menuOpen?: boolean } = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const ticketPanel = useTicketPanel();
  const { user } = useAuth();
  const online = useOnline();

  // "Abrir" de um aviso: a OS abre no painel lateral, sem sair da tela.
  useEffect(
    () => onOpenTicketRequest((id) => (ticketPanel ? ticketPanel.open(id) : router.push(`/chamados/${id}`))),
    [ticketPanel, router],
  );

  // Abrir OS é a tarefa mais frequente da central (chamados chegam pelo WhatsApp e e-mail o dia todo).
  const canCreate = canManageTickets(user?.role) && pathname !== "/chamados/novo";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-sheet/85 backdrop-blur-md print:hidden">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4 md:px-6">
        {onOpenMenu ? (
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Abrir menu"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls={MOBILE_NAV_ID}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink md:hidden"
          >
            <Menu aria-hidden className="size-5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={openCommandPalette}
          aria-keyshortcuts="Control+K"
          className="group inline-flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-sm text-ink-subtle shadow-elev-1 transition-[border-color,color] hover:border-line-strong hover:text-ink-muted sm:max-w-md"
        >
          <Search aria-hidden className="size-4 shrink-0" />
          <span className="flex-1 truncate text-left">Buscar OS, loja, cliente ou tela...</span>
          <span aria-hidden className="hidden items-center gap-1 sm:inline-flex">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ConnectionIndicator />
          {canCreate ? (
            <Link href="/chamados/novo" className={buttonClassName("primary", "md")} title="Nova ordem de serviço">
              <Plus aria-hidden className="size-4" />
              <span className="sr-only sm:not-sr-only">Nova OS</span>
            </Link>
          ) : null}
          <NoticesButton />
          <ThemeToggle />
        </div>
      </div>
      <div role="status">
        {online ? null : (
          <p className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-900 md:px-6 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
            <WifiOff aria-hidden className="size-3.5 shrink-0" />
            Sem internet. O que aparece pode estar desatualizado e nada será salvo até a conexão voltar.
          </p>
        )}
      </div>
    </header>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Eye, EyeOff, Info, Lock, Mail, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { LoginArt } from "@/components/LoginArt";
import { Button, ErrorBox, Skeleton } from "@/components/ui";
import { homePath, peekLoginNext, rememberLoginNext, safeNextPath, WEB_DENIED_MESSAGE } from "@/lib/access";
import { API_URL, ApiError, errorMessage, request } from "@/lib/api";
import { useAuth, useIsClient } from "@/lib/auth";

interface Providers {
  microsoft: boolean;
  password_for_staff: boolean;
  microsoft_domains: string[];
}

// Códigos devolvidos pela API na volta do login Microsoft (?sso_error=...).
const SSO_ERRORS: Record<string, string> = {
  not_registered: "Sua conta Microsoft ainda não tem acesso ao Maxx Field. Peça o cadastro ao administrador.",
  domain_not_allowed: "Use a sua conta Microsoft corporativa (domínio da empresa).",
  wrong_tenant: "Esta conta Microsoft não pertence à empresa.",
  role_not_allowed: "O acesso pelo navegador é para analistas e gestores. Técnicos usam o app no celular.",
  inactive: "Seu acesso está desativado. Fale com o administrador.",
  account_mismatch: "Este e-mail já está vinculado a outra conta Microsoft. Fale com o administrador.",
  cancelled: "Login com a Microsoft cancelado.",
  invalid_state: "O login expirou. Tente de novo.",
  invalid_token: "Não foi possível validar o login da Microsoft. Tente de novo.",
  provider_error: "A Microsoft não respondeu como esperado. Tente de novo em instantes.",
};

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="size-4" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

const YEAR = new Date().getFullYear();

const inputClass =
  "h-11 w-full rounded-xl border border-line bg-surface pl-10 text-sm text-ink shadow-elev-1 placeholder:text-ink-subtle " +
  "transition-[border-color,box-shadow] hover:border-line-strong focus:border-brand focus:ring-4 focus:ring-brand/15 focus:outline-none " +
  "dark:border-line-strong aria-[invalid=true]:border-red-500 aria-[invalid=true]:hover:border-red-500 " +
  "aria-[invalid=true]:focus:border-red-500 aria-[invalid=true]:focus:ring-red-500/15";

/** Recados que chegam pela URL, lidos uma vez na abertura da tela. */
interface UrlNotice {
  /** Endereço para voltar depois de entrar (conferido pelo perfil na hora de usar). */
  next: string | null;
  /** Técnico no navegador (?acesso=app) ou erro do login Microsoft (?sso_error=). */
  error: string | null;
  /** A sessão venceu (?motivo=expirou). */
  expired: boolean;
}

// Parâmetros que só trazem o recado: saem da barra de endereço depois de lidos (um F5 não repete o
// erro antigo). O ?next= fica, para valer também depois de recarregar.
const NOTICE_PARAMS = ["sso_error", "acesso", "motivo"];

function readUrlNotice(): UrlNotice {
  const params = new URLSearchParams(window.location.search);
  const ssoError = params.get("sso_error");
  return {
    // Na volta de um login Microsoft que falhou, o endereço de antes espera na aba.
    next: params.get("next") ?? peekLoginNext(),
    error:
      params.get("acesso") === "app"
        ? WEB_DENIED_MESSAGE
        : ssoError
          ? (SSO_ERRORS[ssoError] ?? "Não foi possível entrar com a Microsoft.")
          : null,
    expired: params.get("motivo") === "expirou",
  };
}

export default function LoginPage() {
  const router = useRouter();
  const { ready, user, login } = useAuth();
  const isClient = useIsClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // E-mail ou senha recusados: os dois campos ficam marcados (a API não diz qual dos dois errou).
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [notice, setNotice] = useState<UrlNotice | null>(null);
  // O recado da URL (erro do login Microsoft, sessão que terminou) some na primeira tentativa nova.
  const [noticeSeen, setNoticeSeen] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => request<Providers>("/auth/providers", { auth: false }),
    staleTime: 5 * 60_000,
  });

  // A URL só existe no navegador: lida depois da hidratação, uma vez.
  if (isClient && notice === null) setNotice(readUrlNotice());

  useEffect(() => {
    if (!notice) return;
    const url = new URL(window.location.href);
    const before = url.search;
    NOTICE_PARAMS.forEach((key) => url.searchParams.delete(key));
    if (url.search !== before) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [notice]);

  // Logado (inclusive logo após entrar): volta ao link que abriu (a OS mandada no WhatsApp) ou vai
  // para a tela inicial do perfil.
  useEffect(() => {
    if (!ready || !user || !notice) return;
    rememberLoginNext(null);
    router.replace(safeNextPath(notice.next, user.role) ?? homePath(user.role));
  }, [ready, user, notice, router]);

  // Voltar do navegador depois de ir para a Microsoft: a página volta da memória com o botão travado.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const urlError = noticeSeen ? null : (notice?.error ?? null);
  const shownError = error ?? urlError;
  const expired = !noticeSeen && !shownError && !!notice?.expired;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInvalid(false);
    setNoticeSeen(true);
    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      const wrongCredentials = err instanceof ApiError && err.status === 401;
      setError(errorMessage(err));
      setInvalid(wrongCredentials);
      setLoading(false);
      // Senha recusada: o foco volta à senha, já selecionada para digitar de novo.
      if (wrongCredentials) {
        passwordRef.current?.focus();
        passwordRef.current?.select();
      }
    }
  }

  const microsoft = providers.data?.microsoft ?? false;
  const domain = providers.data?.microsoft_domains[0];
  // Com a Microsoft obrigatória para a gestão, o formulário de senha fica recolhido
  // (serve ao portal do solicitante e à conta de emergência do admin).
  const passwordCollapsed = microsoft && providers.data?.password_for_staff === false && !showForm;

  return (
    <main className="grid min-h-dvh bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
      <section className="flex min-h-dvh flex-col px-6 py-6 sm:px-10">
        <header className="flex items-center justify-between">
          <Logo />
          <ThemeToggle />
        </header>

        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-10">
          <div className="stagger">
            <p className="text-sm font-medium text-brand" style={{ ["--i" as string]: 0 }}>
              Central de operações de campo
            </p>
            <h1 className="mt-2 text-[30px] leading-tight font-bold tracking-[-0.02em] text-ink" style={{ ["--i" as string]: 1 }}>
              Entre na sua conta
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted" style={{ ["--i" as string]: 2 }}>
              Entre para acompanhar chamados, técnicos em campo e prazos da sua operação.
            </p>

            <div className="mt-8 flex flex-col gap-4" style={{ ["--i" as string]: 3 }}>
              {expired ? (
                <p
                  role="status"
                  className="flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink-muted shadow-elev-1"
                >
                  <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
                  Sua sessão terminou. Entre de novo para continuar.
                </p>
              ) : null}
              {providers.isError ? (
                <ErrorBox
                  message="O servidor não respondeu. Confira a internet e tente de novo."
                  onRetry={() => void providers.refetch()}
                />
              ) : null}
              {providers.isLoading ? (
                <>
                  <Skeleton className="h-11 rounded-xl" />
                  <Skeleton className="h-11 rounded-xl opacity-70" />
                </>
              ) : (
                <>
                  {microsoft ? (
                    <>
                      <Button
                        variant="ink"
                        size="lg"
                        className="w-full rounded-xl"
                        loading={redirecting}
                        onClick={() => {
                          setRedirecting(true);
                          setNoticeSeen(true);
                          // A volta da Microsoft chega em outra tela: o link de origem espera na aba.
                          rememberLoginNext(notice?.next ?? null);
                          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- vai para a API (outra origem), que redireciona à Microsoft
                          window.location.href = `${API_URL}/auth/microsoft/start`;
                        }}
                      >
                        {redirecting ? null : <MicrosoftLogo />}
                        Entrar com a Microsoft
                      </Button>
                      <p className="-mt-1.5 text-center text-xs text-ink-subtle">
                        Analistas e gestores: conta corporativa{domain ? ` @${domain}` : ""}
                      </p>
                      {passwordCollapsed ? (
                        <button
                          type="button"
                          onClick={() => setShowForm(true)}
                          className="inline-flex items-center justify-center gap-1 text-xs text-ink-muted transition-colors hover:text-ink"
                        >
                          Portal do cliente: entrar com e-mail e senha
                          <ChevronDown aria-hidden className="size-3.5" />
                        </button>
                      ) : (
                        <div className="flex items-center gap-3 text-xs text-ink-subtle">
                          <span className="h-px flex-1 bg-line" />
                          ou com e-mail
                          <span className="h-px flex-1 bg-line" />
                        </div>
                      )}
                    </>
                  ) : null}

                  {passwordCollapsed ? null : (
                    <form onSubmit={onSubmit} className="flex animate-enter flex-col gap-3">
                      <label className="relative block">
                        <span className="sr-only">E-mail</span>
                        <Mail
                          aria-hidden
                          className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-subtle"
                        />
                        <input
                          id="login-email"
                          name="email"
                          type="text"
                          inputMode="email"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          autoComplete="username"
                          placeholder="E-mail ou usuário"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          // Sem Microsoft, ou ao abrir o formulário do portal: o foco já vai para o e-mail.
                          autoFocus={!microsoft || showForm}
                          aria-invalid={invalid || undefined}
                          aria-describedby={shownError ? errorId : undefined}
                          className={`${inputClass} pr-3`}
                        />
                      </label>
                      <label className="relative block">
                        <span className="sr-only">Senha</span>
                        <Lock
                          aria-hidden
                          className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-subtle"
                        />
                        <input
                          ref={passwordRef}
                          id="login-password"
                          name="password"
                          type={reveal ? "text" : "password"}
                          autoComplete="current-password"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          placeholder="Sua senha"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          aria-invalid={invalid || undefined}
                          aria-describedby={shownError ? errorId : undefined}
                          className={`${inputClass} pr-11`}
                        />
                        <button
                          type="button"
                          onClick={() => setReveal((v) => !v)}
                          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
                          aria-label={reveal ? "Esconder a senha" : "Mostrar a senha"}
                          aria-pressed={reveal}
                        >
                          {reveal ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                        </button>
                      </label>
                      <Button
                        type="submit"
                        variant={microsoft ? "secondary" : "primary"}
                        size="lg"
                        loading={loading}
                        className="mt-1 w-full rounded-xl"
                      >
                        Entrar
                      </Button>
                    </form>
                  )}
                  {shownError ? (
                    <div id={errorId}>
                      <ErrorBox message={shownError} />
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div
              className="mt-10 flex items-start gap-3 rounded-xl border border-line bg-surface/60 p-3.5 text-xs leading-relaxed text-ink-muted"
              style={{ ["--i" as string]: 4 }}
            >
              <Smartphone className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
              <span>
                <span className="font-semibold text-ink">Técnico de campo?</span> Use o app Maxx Field no celular
                (Android ou iOS) com o e-mail do seu cadastro.
              </span>
            </div>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-subtle">
          <span>© {YEAR} Maxx Field</span>
          <span>Seus dados são tratados conforme a LGPD.</span>
        </footer>
      </section>

      <section className="hidden p-3 lg:block">
        <div className="sticky top-3 h-[calc(100vh-1.5rem)]">
          <LoginArt microsoft={microsoft} />
        </div>
      </section>
    </main>
  );
}

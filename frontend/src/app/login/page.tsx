"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, ErrorBox, Field, Input, Spinner } from "@/components/ui";
import { Logo, ThemeToggle } from "@/components/Brand";
import { WEB_DENIED_MESSAGE } from "@/lib/access";
import { API_URL, errorMessage, request } from "@/lib/api";
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

export default function LoginPage() {
  const router = useRouter();
  const { ready, user, login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => request<Providers>("/auth/providers", { auth: false }),
    staleTime: 5 * 60_000,
  });
  // Mensagens que chegam pela URL: sessão de técnico encerrada (?acesso=app) ou erro do SSO.
  const isClient = useIsClient();
  const params = isClient ? new URLSearchParams(window.location.search) : null;
  const ssoError = params?.get("sso_error");
  const urlError =
    params?.get("acesso") === "app"
      ? WEB_DENIED_MESSAGE
      : ssoError
        ? (SSO_ERRORS[ssoError] ?? "Não foi possível entrar com a Microsoft.")
        : null;
  const shownError = error ?? urlError;

  useEffect(() => {
    if (ready && user) router.replace("/chamados");
  }, [ready, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace("/chamados");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const microsoft = providers.data?.microsoft ?? false;
  // Com a Microsoft obrigatória para a gestão, o formulário de senha fica recolhido
  // (serve ao portal do solicitante e à conta de emergência do admin).
  const passwordCollapsed = microsoft && providers.data?.password_for_staff === false && !showPassword;

  const passwordForm = (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label="E-mail">
        <Input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus={!microsoft}
        />
      </Field>
      <Field label="Senha">
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <Button type="submit" variant={microsoft ? "secondary" : "primary"} loading={loading} className="w-full">
        {loading ? null : <LogIn className="size-4" />}
        Entrar com e-mail e senha
      </Button>
    </form>
  );

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-canvas p-4">
      <ThemeToggle className="absolute top-4 right-4" />
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <Logo size="lg" />
          <div className="brand-gradient h-0.5 w-12 rounded-full" />
          <p className="text-sm text-ink-muted">Gestão de chamados e ordens de serviço de T.I.</p>
        </div>
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
          {providers.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : (
            <>
              {microsoft ? (
                <>
                  <Button
                    variant="primary"
                    className="w-full"
                    loading={redirecting}
                    onClick={() => {
                      setRedirecting(true);
                      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- vai para a API (outra origem), que redireciona à Microsoft
                      window.location.href = `${API_URL}/auth/microsoft/start`;
                    }}
                  >
                    {redirecting ? null : <MicrosoftLogo />}
                    Entrar com Microsoft
                  </Button>
                  <p className="-mt-1 text-center text-xs text-ink-muted">
                    Analistas e gestores: use a conta corporativa
                    {providers.data?.microsoft_domains.length ? ` @${providers.data.microsoft_domains[0]}` : ""}.
                  </p>
                  {passwordCollapsed ? (
                    <button
                      type="button"
                      onClick={() => setShowPassword(true)}
                      className="inline-flex items-center justify-center gap-1 text-xs text-ink-muted hover:text-ink"
                    >
                      Portal do cliente: entrar com e-mail e senha
                      <ChevronDown className="size-3.5" />
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 text-xs text-ink-muted">
                      <span className="h-px flex-1 bg-line" />
                      ou
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                </>
              ) : null}
              {passwordCollapsed ? null : passwordForm}
              {shownError ? <ErrorBox message={shownError} /> : null}
            </>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-ink-muted">
          Acesso para analistas e gestores. Técnico de campo? Use o app Maxx Field no celular.
        </p>
      </div>
    </main>
  );
}

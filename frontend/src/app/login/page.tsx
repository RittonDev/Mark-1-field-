"use client";

import { LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, ErrorBox, Field, Input } from "@/components/ui";
import { Logo, ThemeToggle } from "@/components/Brand";
import { WEB_DENIED_MESSAGE } from "@/lib/access";
import { errorMessage } from "@/lib/api";
import { useAuth, useIsClient } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { ready, user, login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Vindo de uma sessão de técnico encerrada pelo layout (?acesso=app). Derivado, sem setState em efeito.
  const isClient = useIsClient();
  const redirectedFromApp =
    isClient && new URLSearchParams(window.location.search).get("acesso") === "app";
  const shownError = error ?? (redirectedFromApp ? WEB_DENIED_MESSAGE : null);

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

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-canvas p-4">
      <ThemeToggle className="absolute top-4 right-4" />
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <Logo size="lg" />
          <div className="brand-gradient h-0.5 w-12 rounded-full" />
          <p className="text-sm text-ink-muted">Gestão de chamados e ordens de serviço de T.I.</p>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6 shadow-sm">
          <Field label="E-mail">
            <Input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
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
          {shownError ? <ErrorBox message={shownError} /> : null}
          <Button type="submit" variant="primary" loading={loading} className="w-full">
            {loading ? null : <LogIn className="size-4" />}
            Entrar
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-ink-muted">
          Acesso para analistas e gestores. Técnico de campo? Use o app Maxx Field no celular.
        </p>
      </div>
    </main>
  );
}

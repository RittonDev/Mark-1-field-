"use client";

import { Headset, LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, ErrorBox, Field, Input } from "@/components/ui";
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
    if (ready && user) router.replace("/dashboard");
  }, [ready, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace("/dashboard");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-brand text-white shadow-md">
            <Headset className="size-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-ink">MaxxChamados</h1>
            <p className="text-sm text-ink-muted">Gestão de chamados e OS de T.I.</p>
          </div>
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
          Acesso para analistas e gestores. Técnico de campo? Use o app MaxxChamados no celular.
        </p>
      </div>
    </main>
  );
}

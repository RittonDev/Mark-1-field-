"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Brand";
import { Button, ErrorBox, Spinner } from "@/components/ui";
import { homePath, safeNextPath, takeLoginNext } from "@/lib/access";
import { errorMessage, request } from "@/lib/api";
import { sessionStore } from "@/lib/session";
import type { TokenResponse } from "@/lib/types";

/**
 * Volta do login Microsoft: troca o código de uso único (no fragmento #code=) pelos tokens e leva ao
 * link que a pessoa tinha aberto antes de entrar (guardado na aba) ou à tela inicial do perfil.
 */
export default function MicrosoftCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // o código vale uma vez (o modo estrito roda o efeito 2x)
    started.current = true;
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
    // Tira o código da barra de endereço e do histórico.
    window.history.replaceState(null, "", window.location.pathname);
    if (!code) {
      router.replace("/login");
      return;
    }
    request<TokenResponse>("/auth/microsoft/exchange", { method: "POST", body: { code }, auth: false })
      .then((data) => {
        sessionStore.fromTokenResponse(data);
        router.replace(safeNextPath(takeLoginNext(), data.user.role) ?? homePath(data.user.role));
      })
      .catch((err) => setError(errorMessage(err)));
  }, [router]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-canvas p-4">
      <Logo size="lg" />
      {error ? (
        <div className="flex w-full max-w-sm flex-col gap-3">
          <ErrorBox title="Não foi possível entrar com a Microsoft" message={error} />
          <Button onClick={() => router.replace("/login")}>Voltar ao login</Button>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="size-4" />
          Entrando com a Microsoft...
        </p>
      )}
    </main>
  );
}

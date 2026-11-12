"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Brand";
import { Button, ErrorBox, Spinner } from "@/components/ui";
import { errorMessage, request } from "@/lib/api";
import { sessionStore } from "@/lib/session";
import type { TokenResponse } from "@/lib/types";

/** Volta do login Microsoft: troca o código de uso único (no fragmento #code=) pelos tokens. */
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
        router.replace("/chamados");
      })
      .catch((err) => setError(errorMessage(err)));
  }, [router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-canvas p-4">
      <Logo size="lg" />
      {error ? (
        <div className="flex w-full max-w-sm flex-col gap-3">
          <ErrorBox message={error} />
          <Button onClick={() => router.replace("/login")}>Voltar ao login</Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner className="size-4" />
          Entrando com a Microsoft...
        </p>
      )}
    </main>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { Hourglass, Link2Off, Loader2, MailCheck, TriangleAlert, WifiOff } from "lucide-react";
import { apiText, isOffline, PublicPanel, PublicShell, useHashToken } from "@/components/PublicPage";
import { Button } from "@/components/ui";
import { ApiError, request } from "@/lib/api";
import type { VerifyEmailResult } from "@/lib/types";

const GONE_TEXT = "Peça um novo link no app, em Configurações › Contato, ou à central pelo WhatsApp.";

/** O que a validação deixou valendo, para a pessoa. */
function doneText(result: VerifyEmailResult): string {
  if (result.kind === "signup") return `${result.email} está validado. A equipe analisa o seu cadastro e avisa pelo WhatsApp.`;
  if (result.kind === "change") return `Agora você entra no app com ${result.email}.`;
  return `${result.email} está validado.`;
}

/**
 * Validar o e-mail pelo link (ficha de cadastro, troca do e-mail no app ou pedido da central). Valida ao abrir: o link
 * já é o pedido. Validar de novo um e-mail já validado responde igual.
 */
export default function VerifyEmailPage() {
  const token = useHashToken();
  const verify = useQuery({
    queryKey: ["verify-email", token],
    queryFn: () => request<VerifyEmailResult>("/auth/verify-email", { method: "POST", auth: false, body: { token } }),
    enabled: !!token,
    // Uma vez só por abertura: nada de repetir sozinho (o "Tentar de novo" pede de novo).
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const error = verify.error;
  const status = error instanceof ApiError ? error.status : 0;
  const retry = (
    <Button variant="primary" loading={verify.isFetching} onClick={() => void verify.refetch()}>
      Tentar de novo
    </Button>
  );

  return (
    <PublicShell>
      {token === null ? (
        <PublicPanel
          icon={<Link2Off className="size-10 text-ink-muted" />}
          title="Link incompleto"
          text="Abra de novo o link do e-mail que você recebeu."
        />
      ) : verify.data ? (
        <PublicPanel icon={<MailCheck className="size-10 text-brand" />} title="E-mail validado" text={doneText(verify.data)} />
      ) : !error ? (
        <PublicPanel icon={<Loader2 className="size-10 animate-spin text-ink-muted" />} title="Validando o e-mail…" />
      ) : status === 410 || status === 422 ? (
        <PublicPanel
          icon={<Link2Off className="size-10 text-ink-muted" />}
          title="Link vencido ou já usado"
          text={status === 410 ? apiText(error, GONE_TEXT) : GONE_TEXT}
        />
      ) : status === 409 ? (
        <PublicPanel
          icon={<TriangleAlert className="size-10 text-red-600 dark:text-red-400" />}
          title="Não foi possível validar"
          text={apiText(error, "Fale com a central pelo WhatsApp.")}
        />
      ) : status === 429 ? (
        <PublicPanel
          icon={<Hourglass className="size-10 text-ink-muted" />}
          title="Muitas tentativas"
          text="Espere alguns minutos e abra o link de novo."
        />
      ) : isOffline(error) ? (
        <PublicPanel
          icon={<WifiOff className="size-10 text-ink-muted" />}
          title="Sem conexão"
          text="Não conseguimos validar agora. Confira a internet e tente de novo."
          action={retry}
        />
      ) : (
        <PublicPanel
          icon={<WifiOff className="size-10 text-ink-muted" />}
          title="Validação indisponível"
          text="Não conseguimos validar agora. Tente de novo em alguns minutos."
          action={retry}
        />
      )}
    </PublicShell>
  );
}

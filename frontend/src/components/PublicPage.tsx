"use client";

// Páginas abertas por link, sem login (ficha de cadastro do técnico, validar e-mail, definir senha): o cabeçalho com a
// marca e o tema, e o painel de um estado só (enviado, link vencido, sem conexão, pronto).

import clsx from "clsx";
import { useEffect, useSyncExternalStore } from "react";
import { Logo, ThemeToggle } from "@/components/Brand";
import { Card } from "@/components/ui";
import { ApiError } from "@/lib/api";

// ------------------------------------------------------------------ token do link (#token=...)

/*
 * Os links dos e-mails trazem o token no fragmento ({WEB_URL}/validar-email#token=...): o navegador não o manda a
 * nenhum servidor (nem ao da página, nem no Referer). A página lê uma vez ao abrir e tira o fragmento do endereço, para
 * ele não ficar no histórico nem aparecer numa foto da tela; o token segue só na memória da aba (o "Tentar de novo" usa).
 */
let hashToken: string | null | undefined;

function tokenInHash(): string | null {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token")?.trim();
  return token || null;
}

function readHashToken(): string | null {
  if (hashToken === undefined) hashToken = tokenInHash();
  return hashToken;
}

/** Outro link aberto na mesma aba (só o fragmento muda, sem recarregar): vale o token novo. */
function subscribeHash(onChange: () => void) {
  const listener = () => {
    const token = tokenInHash();
    if (!token || token === hashToken) return;
    hashToken = token;
    onChange();
  };
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** O token do link: undefined enquanto a página hidrata; null quando o endereço chegou sem ele (link cortado). */
export function useHashToken(): string | null | undefined {
  const token = useSyncExternalStore(subscribeHash, readHashToken, () => undefined);
  useEffect(() => {
    if (token === undefined || !window.location.hash) return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [token]);
  return token;
}

/** O texto da API (com ponto final, como nas telas) ou, sem ele, o da página. */
export function apiText(error: unknown, fallback: string): string {
  const detail = error instanceof ApiError && typeof error.detail === "string" ? error.detail.trim() : "";
  if (!detail) return fallback;
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

/** Sem resposta da API (sem internet ou tempo esgotado). */
export function isOffline(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 408);
}

// ------------------------------------------------------------------ moldura e painel

/** Logo e tema no topo, o traço da marca e o conteúdo; `wide` para a ficha (formulário em duas colunas). */
export function PublicShell({
  children,
  wide = false,
  footer,
}: {
  children: React.ReactNode;
  wide?: boolean;
  /** Linha pequena no pé da página. */
  footer?: React.ReactNode;
}) {
  const width = wide ? "max-w-2xl" : "max-w-md";
  return (
    <div className="min-h-screen bg-canvas">
      <header className={clsx("mx-auto flex items-center justify-between px-4 pt-6", width)}>
        <Logo />
        <ThemeToggle />
      </header>
      <div className={clsx("brand-gradient mx-auto mt-3 h-1 rounded-full", width)} />
      <main className={clsx("mx-auto px-4 py-6", width)}>
        {children}
        {footer ? <p className="mt-6 text-center text-xs text-ink-muted">{footer}</p> : null}
      </main>
    </div>
  );
}

/** Um estado da página: ícone, título, texto e, se houver, a ação. */
export function PublicPanel({
  icon,
  title,
  text,
  note,
  textId,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  text?: React.ReactNode;
  /** Uma linha curta abaixo do texto. */
  note?: React.ReactNode;
  /** id do texto e da linha (para a ação apontar para eles com aria-describedby). */
  textId?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      {icon}
      <h1 id={textId ? `${textId}-titulo` : undefined} className="text-lg font-bold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      {text || note ? (
        <div id={textId} className="max-w-md space-y-1 text-sm text-ink-muted">
          {text ? <p>{text}</p> : null}
          {note ? <p>{note}</p> : null}
        </div>
      ) : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </Card>
  );
}

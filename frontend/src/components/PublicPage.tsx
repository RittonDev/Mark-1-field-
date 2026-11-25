"use client";

// Páginas abertas por link, sem login (ficha de cadastro do técnico, validar e-mail, definir senha): o cabeçalho com a
// marca e o tema, e o painel de um estado só (enviado, link vencido, sem conexão, pronto).

import clsx from "clsx";
import { Logo, ThemeToggle } from "@/components/Brand";
import { Card } from "@/components/ui";

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

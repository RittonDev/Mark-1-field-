"use client";

import clsx from "clsx";
import { TriangleAlert } from "lucide-react";

/** Erro de um campo, logo abaixo dele (o campo aponta para ele com aria-describedby). */
export function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span id={id} className="text-xs font-medium text-red-600 dark:text-red-400">
      {children}
    </span>
  );
}

/** Asterisco de campo obrigatório no rótulo (o campo leva aria-required; o leitor de tela não lê o "*"). */
export function Asterisk() {
  return (
    <span aria-hidden className="text-red-600 dark:text-red-400">
      {" "}
      *
    </span>
  );
}

/** Aviso âmbar dentro de um passo (horário que já passou, agendamento depois do prazo). */
export function Caution({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
      role="status"
    >
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** id da dica de um passo (o campo aponta para ela com aria-describedby). */
export const stepHintId = (titleId: string) => `${titleId}-dica`;

/**
 * Um passo da Nova OS, na ordem do Field Control: número, rótulo em negrito (com * quando obrigatório),
 * o campo, a dica (quando há) ou o erro logo abaixo dele e, depois, o que complementa o passo (avisos, sugestões).
 * O número ganha a cor da marca quando o passo já está preenchido. Vai dentro de um <ol> em grade
 * (uma coluna no estreito, duas no largo), que dá o espaçamento entre os passos.
 */
export function Step({
  n,
  title,
  titleId,
  htmlFor,
  required,
  done,
  aside,
  hint,
  error,
  errorId,
  children,
  extra,
  className,
}: {
  n: number;
  title: string;
  titleId: string;
  /** Campo nativo: o rótulo vira <label for>. Sem ele, o campo usa aria-labelledby={titleId}. */
  htmlFor?: string;
  required?: boolean;
  done: boolean;
  /** À direita do rótulo (ex.: os atalhos Hoje e Amanhã). */
  aside?: React.ReactNode;
  /** Só o que muda com a OS (duração do tipo, horário escolhido): o campo em si não precisa de explicação. */
  hint?: React.ReactNode;
  error?: string;
  errorId?: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
  /** Posição na grade dos passos (ex.: ocupar duas linhas). */
  className?: string;
}) {
  const label = (
    <>
      {title}
      {required ? <Asterisk /> : null}
    </>
  );
  return (
    <li className={clsx("flex min-w-0 gap-3", className)}>
      <span
        aria-hidden
        className={clsx(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums transition-colors duration-200",
          done ? "bg-brand-soft text-brand-ink" : "bg-surface-2 text-ink-muted ring-1 ring-line ring-inset",
        )}
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {htmlFor ? (
            <label id={titleId} htmlFor={htmlFor} className="text-sm font-bold text-ink">
              {label}
            </label>
          ) : (
            <span id={titleId} className="text-sm font-bold text-ink">
              {label}
            </span>
          )}
          {aside}
        </div>
        {children}
        {error && errorId ? (
          <FieldError id={errorId}>{error}</FieldError>
        ) : hint ? (
          <div id={stepHintId(titleId)} className="text-xs text-ink-muted">
            {hint}
          </div>
        ) : null}
        {extra}
      </div>
    </li>
  );
}

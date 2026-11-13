"use client";

import clsx from "clsx";
import { Loader2, TriangleAlert, X } from "lucide-react";
import { forwardRef, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ink";
type ButtonSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white hover:bg-brand-strong shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(16_24_40/0.14)]",
  secondary: "border border-line bg-surface text-ink shadow-elev-1 hover:border-line-strong hover:bg-surface-2",
  ghost: "text-ink-muted hover:bg-ink/[0.05] hover:text-ink",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(16_24_40/0.14)]",
  // Neutro e forte (ex.: "Entrar com a Microsoft"): grafite no claro, claro no escuro.
  ink: "bg-ink text-surface hover:bg-ink/90 shadow-[0_1px_2px_rgb(16_24_40/0.18)]",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-sm",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap select-none",
        "transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:translate-y-px",
        "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        buttonSizes[size],
        buttonVariants[variant],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
});

const fieldBase =
  "rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-elev-1 placeholder:text-ink-subtle " +
  "transition-[border-color,box-shadow] duration-150 hover:border-line-strong " +
  "focus:border-brand focus:ring-4 focus:ring-brand/15 focus:outline-none disabled:opacity-60";

/**
 * Campo ocupa a largura toda, a menos que a tela passe uma largura própria (ex.: "w-40"). Com as duas
 * classes juntas, "w-full" ganhava no CSS e o campo estourava a linha (data e grupo empilhados no Dia).
 */
function fieldWidth(className?: string) {
  return className && /(^|\s)w-/.test(className) ? null : "w-full";
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={clsx(fieldBase, fieldWidth(className), "h-9", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 4, ...props }, ref) {
    return <textarea ref={ref} rows={rows} className={clsx(fieldBase, fieldWidth(className), "py-2", className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={clsx(fieldBase, fieldWidth(className), "h-9 pr-8", className)} {...props}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx("flex flex-col gap-1.5", className)}>
      {/* Rótulo em negrito e mais escuro: o formulário se lê pelos rótulos. */}
      <span className="text-xs font-semibold text-ink/80">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-ink-subtle">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink select-none">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 rounded border-line accent-[var(--brand)]"
      />
      {label}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={clsx("rounded-xl border border-line bg-surface shadow-elev-1", className)}>{children}</div>;
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="flex min-w-0 gap-2.5">
        {/* Marca da seção nas cores da logo (azul -> ciano): ajuda a achar cada bloco na tela. */}
        <span aria-hidden className="mt-[3px] h-3.5 w-[3px] shrink-0 rounded-full bg-linear-to-b from-brand to-brand-cyan" />
        <div className="min-w-0">
          <h2 className="text-[15px] leading-5 font-bold tracking-[-0.01em] text-ink">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Título de um bloco dentro de cartão, aba ou formulário (ex.: "Técnicos mais indicados", "Contato").
 * Mesmo padrão em todas as telas: negrito, com a marca da seção nas cores da logo.
 */
export function SectionTitle({
  children,
  aside,
  className,
}: {
  children: React.ReactNode;
  /** Ação ou informação à direita (ex.: "Copiar convite", contador). */
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex items-center justify-between gap-3", className)}>
      <h3 className="flex min-w-0 items-center gap-2 text-[13px] leading-5 font-bold tracking-[-0.005em] text-ink">
        <span aria-hidden className="h-3 w-[3px] shrink-0 rounded-full bg-linear-to-b from-brand to-brand-cyan" />
        <span className="min-w-0 truncate">{children}</span>
      </h3>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
    </div>
  );
}

/**
 * Etiqueta de estado (status, prioridade, SLA). O texto mistura a cor com a tinta do tema: no claro fica
 * mais escuro e no escuro mais claro, então âmbar, ciano e verde continuam legíveis (a cor pura sobre
 * fundo claro não passava de ~2,5:1). Fundo e borda são a mesma cor bem diluída na superfície.
 */
export function Pill({ color, children, className }: { color: string; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        className,
      )}
      style={{
        color: `color-mix(in oklab, ${color} 64%, var(--ink))`,
        backgroundColor: `color-mix(in oklab, ${color} 9%, var(--surface))`,
        borderColor: `color-mix(in oklab, ${color} 22%, var(--surface))`,
      }}
    >
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-sans text-[10px] font-semibold text-ink-subtle",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("size-5 animate-spin text-ink-muted", className)} />;
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={clsx("skeleton", className)} style={style} aria-hidden />;
}

const SKELETON_WIDTHS = [
  [64, 40],
  [48, 30],
  [56, 44],
  [42, 26],
];

/** Carregamento com o formato do conteúdo (linhas), no lugar do "Carregando...". */
export function LoadingBlock({ label = "Carregando...", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4 px-4 py-6">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => {
        const [a, b] = SKELETON_WIDTHS[i % SKELETON_WIDTHS.length];
        return (
          <div key={i} className="flex items-center gap-3" style={{ opacity: 1 - i * 0.16 }}>
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3" style={{ width: `${a}%` }} />
              <Skeleton className="h-2.5" style={{ width: `${b}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex animate-enter flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon ? (
        <div className="mb-1 flex size-12 items-center justify-center rounded-2xl bg-brand-soft text-brand ring-1 ring-brand/10 [&_svg]:size-6">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-bold text-ink">{title}</p>
      {description ? <p className="max-w-sm text-xs leading-relaxed text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex animate-enter items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Linha pequena acima do título (ex.: data, contexto). */
  eyebrow?: React.ReactNode;
}) {
  // Ações sempre à direita do título (no celular, embaixo): uma descrição longa quebra dentro do
  // próprio bloco em vez de empurrar os botões para a linha de baixo.
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 text-xs font-medium text-ink-subtle">{eyebrow}</p> : null}
        <h1 className="text-[22px] leading-tight font-bold tracking-[-0.02em] text-ink">{title}</h1>
        {/* O traço da logo (azul -> ciano -> verde-água -> menta) embaixo do título de cada tela. */}
        <span aria-hidden className="brand-gradient mt-2 block h-[3px] w-10 rounded-full" />
        {description ? <p className="mt-1 max-w-3xl text-sm text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// Trava a rolagem da página enquanto houver diálogo aberto (contador para diálogos empilhados).
let scrollLocks = 0;
export function lockScroll() {
  scrollLocks += 1;
  if (scrollLocks === 1) document.documentElement.style.overflow = "hidden";
  return () => {
    scrollLocks -= 1;
    if (scrollLocks === 0) document.documentElement.style.overflow = "";
  };
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg";
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const unlock = lockScroll();
    // Leva o foco para o diálogo, sem roubar o de um campo com autoFocus.
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus();
    return unlock;
  }, [open]);

  if (!open) return null;
  // No <body>: fora das animações e recortes da página. Mesmo no <body>, o clique "sobe" pela árvore do
  // React até quem abriu o diálogo (ex.: a linha clicável de uma lista, que abriria a OS em página);
  // o stopPropagation para o clique aqui.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-fade items-start justify-center overflow-y-auto bg-[rgb(9_11_15/0.42)] p-4 pt-[9vh] backdrop-blur-[3px]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          "relative w-full animate-pop rounded-2xl border border-line bg-surface shadow-pop outline-none",
          size === "lg" ? "max-w-2xl" : "max-w-lg",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-bold tracking-[-0.01em] text-ink">
              {title}
            </h2>
            {description ? <div className="mt-1 text-sm text-ink-muted">{description}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mt-0.5 -mr-1 rounded-lg p-1.5 text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Fechar"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 rounded-b-2xl border-t border-line bg-surface-2/50 px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={clsx(
        "border-b border-line bg-[var(--table-head)] px-3 py-2.5 text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-ink-muted uppercase first:pl-4 last:pr-4",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={clsx("border-b border-line px-3 py-3 align-middle text-ink first:pl-4 last:pr-4", className)}>
      {children}
    </td>
  );
}

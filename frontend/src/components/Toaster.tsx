"use client";

import clsx from "clsx";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type Tone = "info" | "success" | "error";

/** Botão de texto no aviso (ex.: "Abrir" a OS). Clicar também fecha o aviso. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
  action?: ToastAction;
}

interface ToastApi {
  toast: (t: { title: string; description?: string; tone?: Tone; action?: ToastAction }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_MS = 5000;
const ERROR_MS = 8000;
// Com botão de ação dá tempo de ler e decidir.
const ACTION_MS = 8000;

const durationOf = (t: Toast) => (t.tone === "error" ? ERROR_MS : t.action ? ACTION_MS : TOAST_MS);

/**
 * Um aviso. O tempo para enquanto o mouse está em cima ou o foco está dentro (dá para ler uma
 * descrição longa até o fim) e recomeça de onde parou.
 */
function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const duration = durationOf(t);
  const remaining = useRef(duration);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(t.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [paused, t.id, onDismiss]);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className={clsx(
        "pointer-events-auto relative flex animate-toast items-start gap-3 overflow-hidden rounded-xl border bg-surface p-3.5 shadow-pop",
        t.tone === "error" ? "border-red-300 dark:border-red-900" : "border-line",
      )}
    >
      {/* Tempo até sumir sozinho (para junto com o relógio). */}
      <span
        aria-hidden
        className={clsx(
          "absolute inset-x-0 bottom-0 h-0.5 origin-left",
          t.tone === "success" ? "bg-emerald-500/70" : t.tone === "error" ? "bg-red-500/70" : "bg-brand/70",
        )}
        style={{ animation: `mf-progress ${duration}ms linear forwards`, animationPlayState: paused ? "paused" : "running" }}
      />
      {t.tone === "success" ? (
        <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : t.tone === "error" ? (
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
      ) : (
        <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-ink">{t.title}</p>
        {t.description ? <p className="mt-0.5 text-xs break-words text-ink-muted">{t.description}</p> : null}
        {t.action ? (
          <button
            type="button"
            onClick={() => {
              t.action?.onClick();
              onDismiss(t.id);
            }}
            className="mt-1.5 -ml-1 rounded px-1 py-0.5 text-xs font-semibold text-brand-ink hover:bg-brand-soft"
          >
            {t.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(t.id)}
        className="-mt-1 -mr-1 rounded-md p-1 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        aria-label="Fechar aviso"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Leitor de tela: o texto do último aviso vai para uma região viva que já existe na página (um aviso
  // que nasce com role="status" costuma passar em silêncio). Erro é anunciado na hora (assertive).
  const [announce, setAnnounce] = useState({ polite: "", assertive: "" });
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastApi["toast"]>(({ title, description, tone = "info", action }) => {
    const id = nextId.current++;
    const item: Toast = { id, title, description, tone, action };
    setToasts((list) => {
      // O mesmo aviso de novo (ex.: o mesmo erro a cada clique): substitui o anterior e recomeça o tempo,
      // em vez de empilhar cópias.
      const last = list[list.length - 1];
      if (last && last.title === title && last.description === description && last.tone === tone) {
        return [...list.slice(0, -1), item];
      }
      return [...list.slice(-4), item];
    });
    // O id no fim (invisível) faz o mesmo texto ser anunciado de novo.
    const message = `${description ? `${title}. ${description}` : title}${"​".repeat(id % 2)}`;
    setAnnounce((current) => (tone === "error" ? { ...current, assertive: message } : { ...current, polite: message }));
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce.polite}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {announce.assertive}
      </div>
      {/* No celular, a largura da tela menos as margens; no computador, à direita (acima do rodapé do
          painel da OS quando ele está aberto: ver .mf-toasts em globals.css). */}
      <div className="mf-toasts pointer-events-none fixed inset-x-4 bottom-4 z-[100] flex flex-col gap-2 sm:left-auto sm:w-full sm:max-w-sm print:hidden">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast fora do ToastProvider");
  return ctx;
}

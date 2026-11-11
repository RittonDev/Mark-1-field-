"use client";

import clsx from "clsx";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

type Tone = "info" | "success" | "error";

interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
}

interface ToastApi {
  toast: (t: { title: string; description?: string; tone?: Tone }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastApi["toast"]>(
    ({ title, description, tone = "info" }) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-4), { id, title, description, tone }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 8000 : 5000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={clsx(
              "pointer-events-auto flex items-start gap-3 rounded-lg border bg-surface p-3 shadow-lg",
              t.tone === "error" ? "border-red-300 dark:border-red-900" : "border-line",
            )}
          >
            {t.tone === "success" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            ) : t.tone === "error" ? (
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-500" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-brand" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{t.title}</p>
              {t.description ? <p className="mt-0.5 text-xs text-ink-muted">{t.description}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
              aria-label="Fechar"
            >
              <X className="size-3.5" />
            </button>
          </div>
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

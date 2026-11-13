"use client";

// Peças comuns das telas de configuração (formulários, textos, tipos de serviço, usuários e
// configurações): busca sem acento, plural, coluna "Editar", situação, erros de campo e o aviso
// de alterações não salvas.

import clsx from "clsx";
import { Search, SquarePen } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useConfirm } from "@/components/Confirm";
import { Input } from "@/components/ui";

/** Texto para busca: sem acento e sem maiúsculas ("Organização" acha "organizacao"). */
export function fold(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** "1 pergunta", "3 perguntas", "1.006 usuários". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}

/** Com alterações não salvas, o navegador pergunta antes de recarregar ou fechar a aba. */
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Navegadores mais antigos só perguntam com o returnValue preenchido.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}

/**
 * Fechar um diálogo de cadastro (X, Cancelar, Esc ou clique fora): com algo preenchido, pergunta
 * antes de descartar. Um clique perdido fora do diálogo não apaga mais o que foi digitado.
 */
export function useDiscardGuard(dirty: boolean, onClose: () => void) {
  const confirm = useConfirm();
  return useCallback(async () => {
    if (
      !dirty ||
      (await confirm({
        title: "Descartar o que foi preenchido?",
        description: "As alterações deste cadastro ainda não foram salvas.",
        confirmLabel: "Descartar",
        cancelLabel: "Continuar editando",
        tone: "danger",
      }))
    ) {
      onClose();
    }
  }, [dirty, confirm, onClose]);
}

/** Busca com lupa e nome acessível (o placeholder sozinho não é lido como rótulo). */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={clsx("relative", className)}>
      <Search aria-hidden className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-muted" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pl-9"
      />
    </div>
  );
}

/** Botão da coluna fixa "Editar" das listas (padrão do Field Control), com o nome do item no rótulo. */
export function RowEditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1",
        "transition-[border-color,background-color] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px",
        "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
      )}
    >
      <SquarePen className="size-4" />
    </button>
  );
}

/** Etiqueta neutra de situação (no lugar de apagar a linha, que derrubava o contraste do texto). */
export function InactiveChip({ label = "Inativo" }: { label?: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-ink-muted">
      {label}
    </span>
  );
}

/** Situação na coluna da lista: ativo em texto discreto, inativo com a etiqueta. */
export function ActiveState({ active, feminine = false }: { active: boolean; feminine?: boolean }) {
  return active ? (
    <span className="text-xs text-ink-muted">{feminine ? "Ativa" : "Ativo"}</span>
  ) : (
    <InactiveChip label={feminine ? "Inativa" : "Inativo"} />
  );
}

/** Mensagem de erro de um campo (ligada ao campo por aria-describedby). */
export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <span id={id} className="text-xs font-medium text-red-600 dark:text-red-400">
      {children}
    </span>
  );
}

/** Barra presa ao rodapé enquanto há alterações não salvas: salvar ou descartar sem voltar ao topo. */
export function UnsavedBar({ message, children }: { message: string; children: React.ReactNode }) {
  return (
    <div
      role="region"
      aria-label="Alterações não salvas"
      className="sticky bottom-4 z-20 mt-4 flex animate-enter flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-pop backdrop-blur-sm"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
        {message}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

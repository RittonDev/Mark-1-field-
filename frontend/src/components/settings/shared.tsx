"use client";

// Peças comuns das telas de configuração (formulários, textos, tipos de serviço, usuários e
// configurações): busca sem acento, plural, coluna "Editar", situação, erros de campo e o aviso
// de alterações não salvas.

import clsx from "clsx";
import { Search, SquarePen } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { useConfirm } from "@/components/Confirm";
import { Input } from "@/components/ui";
import { useUnsavedChanges } from "@/lib/hooks";

const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

/** Texto para busca: sem acento e sem maiúsculas ("Organização" acha "organizacao"). */
export function fold(text: string | null | undefined): string {
  // NFD separa a letra do acento; os acentos (marcas combinantes U+0300 a U+036F) saem.
  return (text ?? "")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase();
}

/** "1 pergunta", "3 perguntas", "1.006 usuários". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
}

type ConfirmFn = ReturnType<typeof useConfirm>;

// Formulários da tela com alteração não salva (um único ouvinte de clique atende todos).
const leaveGuards = new Map<symbol, { description: string; confirm: ConfirmFn }>();
// O clique liberado depois da confirmação passa direto.
let releasing = false;

function guardLinks(e: MouseEvent) {
  if (releasing || leaveGuards.size === 0 || e.defaultPrevented || e.button !== 0) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const anchor = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href, window.location.href);
  const here = window.location;
  // Outro site é navegação de verdade (o navegador já pergunta); âncora da própria tela não sai dela.
  if (url.origin !== here.origin || (url.pathname === here.pathname && url.search === here.search)) return;
  e.preventDefault();
  e.stopPropagation();
  const guards = [...leaveGuards.values()];
  void guards[0]
    .confirm({
      title: "Sair sem salvar?",
      description: guards.length === 1 ? guards[0].description : "Há alterações não salvas em mais de um lugar desta tela.",
      confirmLabel: "Sair sem salvar",
      cancelLabel: "Continuar editando",
      tone: "danger",
    })
    .then((ok) => {
      if (!ok || !anchor.isConnected) return;
      releasing = true;
      try {
        anchor.click();
      } finally {
        releasing = false;
      }
    });
}

/**
 * Enquanto houver alteração não salva: o navegador pergunta antes de recarregar ou fechar a aba, o
 * Sair da central pergunta antes de encerrar a sessão e um link interno (menu, atalho, outra tela)
 * pede confirmação antes de sair. O Voltar do navegador não dá para segurar (não pode ser cancelado).
 */
export function useLeaveGuard(dirty: boolean, description: string) {
  const confirm = useConfirm();
  useUnsavedChanges(dirty);
  useEffect(() => {
    if (!dirty) return;
    const key = Symbol("alteracoes");
    leaveGuards.set(key, { description, confirm });
    // Na captura, antes do Next tratar o link: o clique só segue se a pessoa confirmar.
    if (leaveGuards.size === 1) window.addEventListener("click", guardLinks, true);
    return () => {
      leaveGuards.delete(key);
      if (leaveGuards.size === 0) window.removeEventListener("click", guardLinks, true);
    };
  }, [dirty, description, confirm]);
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

const ROW_EDIT_CLASS = clsx(
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-brand shadow-elev-1",
  "transition-[border-color,background-color] duration-150 hover:border-brand/40 hover:bg-brand-soft active:translate-y-px",
  "focus-visible:ring-2 focus-visible:ring-brand/45 focus-visible:outline-none",
);

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
      className={ROW_EDIT_CLASS}
    >
      <SquarePen className="size-4" />
    </button>
  );
}

/** O mesmo botão "Editar" quando o cadastro fica em outra tela (ex.: o técnico, em Técnicos). */
export function RowEditLink({ label, href }: { label: string; href: string }) {
  return (
    <Link href={href} aria-label={label} title={label} className={ROW_EDIT_CLASS}>
      <SquarePen className="size-4" />
    </Link>
  );
}

/** Etiqueta neutra para categoria (papel, responsabilidade): cor só sinaliza problema. */
export function NeutralChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink-muted">
      {children}
    </span>
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
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AGENT_LABEL, AGENT_PROMPT, AgentMark, AgentScan } from "@/components/home/agent";
import { readRecent } from "@/components/home/search";
import { AgentReply, SearchResults, useSearchController } from "@/components/home/SearchResults";
import { isTopLayer, Kbd, lockScroll, restoreFocus, trapTab } from "@/components/ui";
import type { User } from "@/lib/types";

// As OS recentes ficam com a busca (components/home/search.ts); continuam saindo daqui também.
export { type RecentTicket, rememberRecentTicket } from "@/components/home/search";

const OPEN_EVENT = "mf:command-open";

/** Abre o Maxx Agent, a busca da central (o atalho Ctrl+K / ⌘K também abre). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandPalette({ user }: { user: User }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  return open ? <Palette user={user} onClose={() => setOpen(false)} /> : null;
}

/**
 * O Maxx Agent em qualquer tela (Ctrl+K): a mesma busca da caixa do Início. A frase vai para a busca
 * inteligente da API ("atrasadas em santos", "16976", "técnico joão novembro"), que devolve o que entendeu, as
 * OS, os clientes, os locais e os técnicos; as telas e ações são achadas aqui mesmo, sem acento importar. A
 * moldura do diálogo fica neutra: a cara do agente é só a marca, a linha do campo e a resposta.
 */
function Palette({ user, onClose }: { user: User; onClose: () => void }) {
  const [recent] = useState(() => readRecent(user.id));
  // Quem tinha o foco quando a busca abriu, lido no render: o autoFocus do campo roda antes dos efeitos
  // e já teria levado o foco para a busca.
  const [opener] = useState(() => document.activeElement);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ctl = useSearchController({ user, recent, mode: "palette", onLeave: onClose, listRef });

  // Modal: trava a rolagem da página, prende o Tab e devolve o foco a quem abriu.
  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const unlock = lockScroll();
    const onKey = (e: KeyboardEvent) => {
      const node = dialogRef.current;
      if (!node || e.defaultPrevented) return;
      if (e.key === "Tab" && isTopLayer(node, false)) trapTab(e, node);
      else if (e.key === "Escape" && isTopLayer(node)) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlock();
      // Abriu a OS no painel: o foco é dele. Senão volta ao botão de busca (ou a quem abriu com Ctrl+K).
      const focused = document.activeElement;
      if (!focused || focused === document.body) restoreFocus(opener);
    };
  }, [opener]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    ctl.onKeyDown(e);
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex animate-fade items-start justify-center bg-[rgb(9_11_15/0.42)] p-4 pt-[12vh] backdrop-blur-[3px] print:hidden">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={AGENT_LABEL}
        className="relative flex max-h-[72vh] w-full max-w-2xl animate-pop flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
      >
        <div className="relative flex items-center gap-3 border-b border-line px-4">
          <AgentMark size="md" thinking={ctl.thinking} />
          <input
            autoFocus
            value={ctl.query}
            onChange={(e) => ctl.setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`${AGENT_PROMPT}: OS, cliente, loja, técnico, período ou tela`}
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-subtle"
            role="combobox"
            aria-label={AGENT_PROMPT}
            aria-expanded="true"
            aria-controls={ctl.listId}
            aria-autocomplete="list"
            aria-activedescendant={ctl.activeId}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          <span aria-hidden className="hidden sm:inline-flex">
            <Kbd>Esc</Kbd>
          </span>
          {/* O fio do agente sob o campo; enquanto ele procura, a linha que corre. */}
          <span aria-hidden className="mf-agent-rule" />
          {ctl.thinking ? <AgentScan /> : null}
        </div>
        <AgentReply ctl={ctl} />
        <div ref={listRef} className="flex-1 overflow-y-auto p-2">
          <SearchResults ctl={ctl} onLeave={onClose} />
        </div>
        <div className="hidden items-center gap-4 border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-subtle sm:flex">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navegar
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Enter</Kbd> abrir
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Shift</Kbd>
            <Kbd>Enter</Kbd> outra aba
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>Enter</Kbd> abre a página
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

"use client";

import { useEffect, useState } from "react";

/** Valor atrasado (para busca enquanto digita). */
export function useDebounced<T>(value: T, ms = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// ------------------------------------------------------------------ título da aba do navegador

/*
 * "(3) Minha fila · Maxx Field": cada tela registra o próprio nome e o menu, o contador de pendências.
 * Vale o título de maior prioridade (a página vence o nome do menu); no empate, o mais recente.
 * Com várias OS abertas em abas (Ctrl+clique), dá para distinguir cada uma pelo título.
 */
const APP_NAME = "Maxx Field";

interface TitleEntry {
  title: string;
  priority: number;
  order: number;
}

const titleEntries = new Map<symbol, TitleEntry>();
const titleCounts = new Map<symbol, number>();
let titleOrder = 0;
let titleObserver: MutationObserver | null = null;

function desiredTitle(): string | null {
  if (titleEntries.size === 0 && titleCounts.size === 0) return null;
  let best: TitleEntry | null = null;
  for (const entry of titleEntries.values()) {
    if (!best || entry.priority > best.priority || (entry.priority === best.priority && entry.order > best.order)) best = entry;
  }
  let count = 0;
  for (const n of titleCounts.values()) count += n;
  const prefix = count > 0 ? `(${count > 99 ? "99+" : count}) ` : "";
  return `${prefix}${best ? `${best.title} · ` : ""}${APP_NAME}`;
}

function applyTitle() {
  const wanted = desiredTitle();
  if (wanted === null) {
    // Ninguém mais define o título (saiu da central): volta a valer o do Next.
    titleObserver?.disconnect();
    titleObserver = null;
    return;
  }
  if (document.title !== wanted) document.title = wanted;
  if (!titleObserver) {
    // O Next troca o <title> ao navegar entre rotas com metadados diferentes (ex.: do login para a fila).
    titleObserver = new MutationObserver(() => {
      const current = desiredTitle();
      if (current !== null && document.title !== current) document.title = current;
    });
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
}

/**
 * Nome da tela no título da aba ("Nova OS · Maxx Field"). Vazio não registra nada.
 * `fallback`: nome de reserva (o do item do menu), que a própria página pode trocar por um mais preciso.
 */
export function useDocumentTitle(title?: string | null, options?: { fallback?: boolean }) {
  const priority = options?.fallback ? 0 : 1;
  useEffect(() => {
    if (!title) return;
    const key = Symbol("title");
    titleOrder += 1;
    titleEntries.set(key, { title, priority, order: titleOrder });
    applyTitle();
    return () => {
      titleEntries.delete(key);
      applyTitle();
    };
  }, [title, priority]);
}

/** Pendências no começo do título ("(3) ..."): aparece mesmo com a aba em segundo plano. */
export function useDocumentTitleCount(count: number | null | undefined) {
  useEffect(() => {
    if (!count || count < 0) return;
    const key = Symbol("count");
    titleCounts.set(key, count);
    applyTitle();
    return () => {
      titleCounts.delete(key);
      applyTitle();
    };
  }, [count]);
}

// ------------------------------------------------------------------ alterações não salvas

let unsavedForms = 0;

/** Há algum formulário com alterações não salvas na tela (ex.: o Sair pergunta antes de encerrar). */
export function hasUnsavedChanges(): boolean {
  return unsavedForms > 0;
}

/**
 * Enquanto `dirty`, fechar ou recarregar a aba pede confirmação do navegador, e o Sair da central
 * pergunta antes de encerrar a sessão.
 */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    unsavedForms += 1;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Navegadores antigos só perguntam com o returnValue preenchido.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unsavedForms -= 1;
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty]);
}

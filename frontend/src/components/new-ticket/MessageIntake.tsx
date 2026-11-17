"use client";

import clsx from "clsx";
import { ChevronDown, ClipboardPaste, Lightbulb, Undo2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button, Card, Textarea } from "@/components/ui";

export interface FilledChip {
  key: string;
  label: string;
}

export interface IntakeSuggestion {
  key: string;
  label: string;
  action: string;
  onApply: () => void;
}

/**
 * "Colar mensagem do WhatsApp ou e-mail": o analista cola a conversa ou o e-mail do cliente e os campos
 * vazios da OS se preenchem (cliente, localização, escopo e, em Mais detalhes, origem, contato e nº do
 * chamado). Fica fechado até ser usado. Cada campo preenchido vira um chip que desfaz; a urgência só
 * aparece como sugestão.
 */
export function MessageIntake({
  onFill,
  filled,
  onUndo,
  suggestions,
}: {
  onFill: (text: string) => void;
  filled: FilledChip[];
  onUndo: (key: string) => void;
  suggestions: IntakeSuggestion[];
}) {
  const panelId = useId();
  const textId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const fill = () => {
    if (!text.trim()) return;
    onFill(text);
    setText("");
  };
  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((o) => !o);
          // Abriu: o foco vai direto para a caixa (é só colar).
          if (!open) window.requestAnimationFrame(() => area.current?.focus());
        }}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none sm:px-5"
      >
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
          <ClipboardPaste className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-ink">Colar mensagem do WhatsApp ou e-mail</span>
        </span>
        <ChevronDown aria-hidden className={clsx("size-4 shrink-0 text-ink-subtle transition-transform duration-200", open && "rotate-180")} />
      </button>
      {/* Sempre no documento (o aria-controls aponta para ele); fechado, fica escondido. */}
      <div id={panelId} hidden={!open} className="animate-enter border-t border-line px-4 py-3 sm:px-5">
        <label htmlFor={textId} className="text-xs font-semibold text-ink/80">
          Mensagem do cliente
        </label>
        <Textarea
          ref={area}
          id={textId}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl+Enter aqui preenche os campos (no resto da tela, cria a OS).
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              fill();
            }
          }}
          className="mt-1.5"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!text.trim()} onClick={fill}>
            Preencher campos
          </Button>
          {text ? (
            <Button size="sm" variant="ghost" onClick={() => setText("")}>
              Limpar
            </Button>
          ) : null}
        </div>
      </div>
      {filled.length || suggestions.length ? (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:px-5" aria-live="polite">
          {filled.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-ink/80">Preenchido pela mensagem:</span>
              {filled.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-2.5 text-xs font-medium text-brand-ink"
                >
                  <span className="truncate">{chip.label}</span>
                  <button
                    type="button"
                    onClick={() => onUndo(chip.key)}
                    className="rounded-full p-0.5 hover:bg-brand/15 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                    aria-label={`Desfazer: ${chip.label}`}
                    title="Desfazer"
                  >
                    <Undo2 aria-hidden className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {suggestions.map((s) => (
            <p key={s.key} className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
              <Lightbulb aria-hidden className="size-3.5 shrink-0 text-ink-subtle" />
              {s.label}
              <button type="button" onClick={s.onApply} className="font-semibold text-brand-ink hover:underline">
                {s.action}
              </button>
            </p>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

"use client";

import { ClipboardPaste, Lightbulb, Undo2 } from "lucide-react";
import { useId, useState } from "react";
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
 * "Mensagem do cliente": o analista cola a conversa do WhatsApp ou o e-mail e os campos vazios da OS
 * se preenchem (origem, título, descrição, contato, nº do chamado e a loja). Cada campo preenchido vira
 * um chip que desfaz; a urgência só aparece como sugestão.
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
  const titleId = useId();
  const [text, setText] = useState("");
  const fill = () => {
    if (!text.trim()) return;
    onFill(text);
    setText("");
  };
  return (
    <Card>
      <div className="flex items-start gap-3 px-5 py-4">
        <span aria-hidden className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
          <ClipboardPaste className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[15px] leading-5 font-bold tracking-[-0.01em] text-ink">
            Mensagem do cliente <span className="text-xs font-medium text-ink-muted">(opcional)</span>
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Cole a conversa do WhatsApp ou o e-mail: os campos vazios se preenchem (loja, título, contato, nº do chamado). O
            texto não sai do navegador.
          </p>
          <Textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Enter aqui preenche os campos (no resto da tela, abre a OS).
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                fill();
              }
            }}
            aria-labelledby={titleId}
            placeholder="[09:41, 13/11/2026] Cliente: A loja 41 está sem sistema desde ontem..."
            className="mt-2.5"
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
          {filled.length || suggestions.length ? (
            <div className="mt-3 flex flex-col gap-2" aria-live="polite">
              {filled.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-ink/80">Preenchido:</span>
                  {filled.map((chip) => (
                    <span
                      key={chip.key}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-2.5 text-xs font-medium text-brand-ink"
                    >
                      <span className="truncate">{chip.label}</span>
                      <button
                        type="button"
                        onClick={() => onUndo(chip.key)}
                        className="rounded-full p-0.5 hover:bg-brand/15"
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
        </div>
      </div>
    </Card>
  );
}

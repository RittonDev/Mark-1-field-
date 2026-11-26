"use client";

import clsx from "clsx";
import { Star } from "lucide-react";
import { useRef, useState } from "react";
import { RATING_MAX, scoreText } from "@/lib/ratings";

const STARS = Array.from({ length: RATING_MAX }, (_, i) => i + 1);

const STAR_SIZE = { sm: "size-3.5", md: "size-4", lg: "size-5" } as const;

/**
 * As estrelas de uma nota ou de uma média (arredondada), só visual: o texto ("4 de 5", "Média 4,6 de 5…") vai ao lado,
 * para o leitor de tela. Cheias em tom neutro (cor só para problema; a nota baixa fica vermelha no texto).
 */
export function RatingStars({
  value,
  size = "md",
  className,
}: {
  value: number;
  size?: keyof typeof STAR_SIZE;
  className?: string;
}) {
  const full = Math.max(0, Math.min(RATING_MAX, Math.round(value)));
  return (
    <span aria-hidden className={clsx("inline-flex shrink-0 items-center gap-0.5", className)}>
      {STARS.map((n) => (
        <Star key={n} className={clsx(STAR_SIZE[size], n <= full ? "fill-current text-ink-muted" : "text-line-strong")} />
      ))}
    </span>
  );
}

/**
 * A escolha da nota: cinco estrelas num grupo de rádio ("Nota"; cada uma "{n} de 5"). As setas trocam a nota (direita e
 * baixo sobem, esquerda e cima descem, sem dar a volta), Home e End vão às pontas; o Tab entra na marcada (sem nota, na
 * primeira). Marcadas na cor da marca (estado ativo). Fora de um `Field` (que é um <label>: o clique no rótulo marcaria a
 * primeira estrela): com um título visível, passe o id dele em `labelledBy`.
 */
export function RatingInput({
  value,
  onChange,
  disabled = false,
  id,
  labelledBy,
  describedBy,
  invalid,
}: {
  /** 1 a 5; null: nenhuma. */
  value: number | null;
  onChange: (score: number) => void;
  disabled?: boolean;
  id?: string;
  labelledBy?: string;
  /** O id do erro do campo. */
  describedBy?: string;
  invalid?: boolean;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // A estrela sob o mouse mostra a nota que o clique daria.
  const [hover, setHover] = useState<number | null>(null);
  const checked = value !== null && Number.isInteger(value) && value >= 1 && value <= RATING_MAX ? value : null;
  const shown = disabled ? (checked ?? 0) : (hover ?? checked ?? 0);
  const tabStop = checked ?? 1;

  const move = (to: number) => {
    setHover(null);
    if (to !== checked) onChange(to);
    buttons.current[to - 1]?.focus();
  };

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={labelledBy ? undefined : "Nota"}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-disabled={disabled || undefined}
      className="inline-flex items-center gap-0.5"
      onMouseLeave={() => setHover(null)}
    >
      {STARS.map((n) => {
        const on = n <= shown;
        return (
          <button
            key={n}
            ref={(el) => {
              buttons.current[n - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked === n}
            aria-label={scoreText(n)}
            title={scoreText(n)}
            tabIndex={n === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => move(n)}
            onMouseEnter={() => setHover(n)}
            onKeyDown={(e) => {
              const to =
                e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? Math.min(RATING_MAX, n + 1)
                  : e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? Math.max(1, n - 1)
                    : e.key === "Home"
                      ? 1
                      : e.key === "End"
                        ? RATING_MAX
                        : null;
              if (to === null) return;
              e.preventDefault();
              move(to);
            }}
            className={clsx(
              "inline-flex size-9 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
              on ? "text-brand" : "text-ink-subtle",
            )}
          >
            <Star aria-hidden className={clsx("size-6", on && "fill-current")} />
          </button>
        );
      })}
    </div>
  );
}

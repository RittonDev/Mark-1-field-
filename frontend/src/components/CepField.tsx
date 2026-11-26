"use client";

import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Field, Input } from "@/components/ui";
import {
  ADDRESS_SLOTS,
  type AddressSlots,
  cepDigits,
  cepLineFill,
  type CepMode,
  companyLineFill,
  companyLineFromCep,
  NO_ADDRESS,
} from "@/lib/address";
import { cepQuery, useCepLookup } from "@/lib/cep";
import { CEP_TEXT, cepFill, cepSummary } from "@/lib/constants";
import { maskCep } from "@/lib/onboarding";
import type { CepAddress } from "@/lib/types";

/** O que veio junto do endereço aplicado. */
export interface CepApplyInfo {
  /** Campos que o CEP trocou ("company": ["street"], a linha). */
  filled: (keyof AddressSlots)[];
  /** "auto": a resposta da busca; "use": a pessoa tocou em "Usar este endereço". */
  via: "auto" | "use";
  /** A pessoa ainda estava no CEP (ou pediu "Usar este endereço"): dá para levar o foco ao próximo campo. */
  focus: boolean;
  cep: CepAddress;
}

interface CepFieldCommon {
  /** O CEP na tela; `onChange` recebe já com a máscara ("01001-000"). */
  value: string;
  onChange: (masked: string) => void;
  label?: string;
  required?: boolean;
  /** Erro do formulário ("CEP inválido: use os 8 números."): aparece no lugar da dica, em vermelho. */
  error?: string | null;
  disabled?: boolean;
  /** Classe do bloco (a coluna da grade). */
  className?: string;
  inputClassName?: string;
  name?: string;
  /** false na ficha pública (sem login, limite por IP). Na central a busca vai logada (limite por pessoa). */
  auth?: boolean;
  /** Recebe o foco depois de aplicar: "parts" → Número; "line" → a linha (cursor no fim); "company" → a linha. */
  focusRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** "parts", CEP geral (sem logradouro) e Logradouro vazio: o foco vai para o Logradouro. */
  streetRef?: React.RefObject<HTMLInputElement | null>;
  /** Atributos a mais do campo (o aria-describedby do recado no fim da etapa, na ficha pública). */
  inputProps?: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "name" | "disabled">;
}

export type CepFieldProps = CepFieldCommon &
  (
    | {
        /** "parts": logradouro, bairro, cidade e UF em campos (ficha pública, Técnicos); "line": rua, número e complemento
         *  num campo, em `street` (Clientes, Locais). */
        mode: CepMode;
        address: AddressSlots;
        /** O endereço gravado, ou o que a pessoa não digitou (campo igual a ele é livre para o CEP). Sem ele, vale o da
         *  abertura do formulário. */
        opened?: AddressSlots;
        /** O formulário grava os campos (e, em "parts", esvazia Número e Complemento livres quando o logradouro mudou). */
        onApply: (next: AddressSlots, info: CepApplyInfo) => void;
      }
    | {
        /** "company": o endereço inteiro numa linha (Configurações › Empresa); o CEP vai para o fim da linha. */
        mode: "company";
        address: { line: string };
        onApply: (next: { line: string; caret: number }, info: CepApplyInfo) => void;
      }
  );

const EVERY_SLOT: ReadonlySet<keyof AddressSlots> = new Set(ADDRESS_SLOTS);
const NO_SLOT: ReadonlySet<keyof AddressSlots> = new Set();

/** O endereço na tela difere do CEP em algum campo preenchido (o que o CEP não traz não conta). */
function differsFrom(props: CepFieldProps, cep: CepAddress): boolean {
  if (props.mode === "company") return companyLineFill(props.address.line, cep).differs;
  return props.mode === "line"
    ? cepLineFill(props.address, NO_ADDRESS, NO_SLOT, cep).differs
    : cepFill(props.address, NO_ADDRESS, NO_SLOT, cep).differs;
}

interface FocusRequest {
  target: "next" | "street";
  /** Posição do cursor (null: no fim). */
  caret: number | null;
}

/**
 * Campo de CEP com a busca (os 6 lugares do endereço seguem a mesma regra). Busca só depois que a pessoa digita no campo
 * (abrir um cadastro com CEP não busca), uma vez por CEP. Achou: preenche os campos livres (vazios, iguais ao aberto ou
 * da busca anterior) pelo `onApply`; o que a pessoa digitou fica e, se difere, aparece "CEP de {resumo}." com "Usar este
 * endereço". Não achou ou fora do ar: só a linha de status; nada trava o salvar. Resposta atrasada (outro CEP digitado) é
 * ignorada.
 */
export function CepField(props: CepFieldProps) {
  const {
    value,
    onChange,
    label = "CEP",
    required,
    error,
    disabled,
    className,
    inputClassName,
    name,
    auth = true,
    focusRef,
    streetRef,
    inputProps,
  } = props;
  const queryClient = useQueryClient();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // A pessoa digitou no campo: a partir daí o CEP de 8 números é buscado.
  const [armed, setArmed] = useState(false);
  const lookup = useCepLookup(value, armed && !disabled, { auth });
  const digits = cepDigits(value);
  // O CEP cuja resposta já foi aplicada: a linha "CEP de..." só aparece depois disso (sem piscar antes do preenchimento).
  const [handled, setHandled] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  // O endereço da abertura do formulário: campo igual a ele é livre ("parts" e "line", quando a tela não passa `opened`).
  const [mounted] = useState<AddressSlots | null>(() => (props.mode === "company" ? null : props.address));
  // A tela mais recente, para a resposta que chega depois (a pessoa pode ter mexido em outro campo no meio).
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  // O CEP digitado por último (a resposta de outro CEP é ignorada).
  const typed = useRef("");
  // Os valores que a última busca pôs: o campo que ainda está com eles continua livre (`auto` de cepFill).
  const applied = useRef<Partial<AddressSlots>>({});

  // Depois de aplicar, o foco segue para o próximo campo (com o valor novo já na tela).
  useEffect(() => {
    if (!focusRequest) return;
    const target = (focusRequest.target === "street" ? streetRef?.current : null) ?? focusRef?.current ?? null;
    if (!target) {
      // Sem para onde ir: o botão "Usar este endereço" sumiu com o foco nele; volta ao CEP.
      if (document.activeElement === document.body) inputRef.current?.focus();
      return;
    }
    target.focus();
    const position = focusRequest.caret ?? target.value.length;
    try {
      target.setSelectionRange(position, position);
    } catch {
      // Campo sem seleção de texto (date, number): basta o foco.
    }
  }, [focusRequest, focusRef, streetRef]);

  function apply(cep: CepAddress, via: CepApplyInfo["via"]) {
    const current = latest.current;
    const focus = via === "use" || document.activeElement === inputRef.current;
    if (current.mode === "company") {
      const line = current.address.line;
      const fresh = companyLineFromCep(cep);
      const next = via === "use" ? { line: fresh.text, caret: fresh.caret } : companyLineFill(line, cep).next;
      if (!next) return;
      current.onApply(next, { filled: ["street"], via, focus, cep });
      // Linha nova (vazia ou trocada): o cursor vai para o fim do logradouro. Só o CEP acrescentado no fim: o foco fica.
      if (focus && (via === "use" || !line.trim())) setFocusRequest({ target: "next", caret: next.caret });
      return;
    }
    const auto = new Set(ADDRESS_SLOTS.filter((key) => applied.current[key] !== undefined && current.address[key] === applied.current[key]));
    const opened = current.opened ?? mounted ?? NO_ADDRESS;
    const result =
      current.mode === "line"
        ? cepLineFill(current.address, opened, via === "use" ? EVERY_SLOT : auto, cep)
        : cepFill(current.address, opened, via === "use" ? EVERY_SLOT : auto, cep);
    for (const key of result.filled) applied.current[key] = result.next[key];
    if (result.filled.length) current.onApply(result.next, { filled: result.filled, via, focus, cep });
    if (!focus) return;
    if (current.mode === "line") {
      // A linha ganhou o logradouro: a pessoa completa o número no fim dela.
      if (result.filled.includes("street") || via === "use") setFocusRequest({ target: "next", caret: null });
    } else if (result.filled.length || via === "use") {
      setFocusRequest({ target: !cep.street && !result.next.street.trim() ? "street" : "next", caret: null });
    }
  }

  function change(text: string) {
    const masked = maskCep(text);
    const next = cepDigits(masked);
    const before = cepDigits(value);
    onChange(masked);
    setArmed(true);
    typed.current = next;
    // Uma vez por CEP: o 9º toque (ou colar o mesmo CEP) não busca de novo.
    if (next.length !== 8 || next === before) return;
    queryClient.fetchQuery(cepQuery(next, auth)).then(
      (cep) => {
        if (typed.current !== next) return;
        apply(cep, "auto");
        setHandled(next);
      },
      () => {
        // Não achou ou fora do ar: a linha de status (useCepLookup) avisa; os campos continuam livres.
      },
    );
  }

  const found = lookup.state === "found" && lookup.cep && handled === digits ? lookup.cep : null;
  const conflict = found && !disabled && differsFrom(props, found) ? found : null;
  const status =
    lookup.state === "loading"
      ? CEP_TEXT.searching
      : lookup.state === "not_found"
        ? CEP_TEXT.notFound
        : lookup.state === "unavailable"
          ? CEP_TEXT.unavailable
          : null;
  const describedBy = [inputProps?.["aria-describedby"], status || conflict ? statusId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={clsx("flex flex-col", className)}>
      <Field label={label} required={required} error={error}>
        <span className="relative block">
          <Input
            {...inputProps}
            ref={inputRef}
            name={name}
            value={value}
            onChange={(e) => change(e.target.value)}
            disabled={disabled}
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="00000-000"
            // Sem maxLength: colar "01.001-000" (10 caracteres) perderia o último número; a máscara já para em 9.
            aria-invalid={error ? true : inputProps?.["aria-invalid"]}
            aria-describedby={describedBy}
            className={clsx(lookup.state === "loading" && "pr-9", inputClassName)}
          />
          {lookup.state === "loading" ? (
            <Loader2
              aria-hidden
              className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-ink-subtle"
            />
          ) : null}
        </span>
      </Field>
      {/* Sempre no DOM: o leitor de tela anuncia a busca e o resultado quando o texto muda. */}
      <div id={statusId} role="status" className={clsx("text-xs text-ink-muted", (status || conflict) && "mt-1.5")}>
        {status ??
          (conflict ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>CEP de {cepSummary(conflict)}.</span>
              <button
                type="button"
                onClick={() => apply(conflict, "use")}
                className="inline-flex items-center rounded font-semibold text-brand-ink underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none pointer-coarse:min-h-11"
              >
                {CEP_TEXT.use}
              </button>
            </span>
          ) : null)}
      </div>
    </div>
  );
}

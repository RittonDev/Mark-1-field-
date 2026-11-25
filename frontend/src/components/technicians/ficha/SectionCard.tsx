"use client";

import { useRef } from "react";
import { Button, Card, ErrorBox } from "@/components/ui";
import { errorMessage } from "@/lib/api";
import type { SectionFormState } from "./useSectionForm";

/** O título da seção na tela: recebe o foco ao trocar de seção (a ficha mostra uma seção por vez). */
export const FICHA_HEADING_ID = "ficha-secao-titulo";

/**
 * Uma seção da ficha: o cartão com o título (h2, como o CardHeader) e, à direita, `aside` (o carimbo do perfil técnico,
 * um contador). Formulário e ações ficam no corpo (SectionForm).
 */
export function SectionCard({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-5 py-3.5">
        <div className="flex min-w-0 gap-2.5">
          {/* A marca da seção nas cores da logo, como no CardHeader. */}
          <span aria-hidden className="mt-[3px] h-3.5 w-[3px] shrink-0 rounded-full bg-linear-to-b from-brand to-brand-cyan" />
          <h2
            id={FICHA_HEADING_ID}
            tabIndex={-1}
            className="scroll-mt-24 text-[15px] leading-5 font-bold tracking-[-0.01em] text-ink outline-none"
          >
            {title}
          </h2>
        </div>
        {aside ? <div className="text-xs text-ink-muted">{aside}</div> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-5 p-5">{children}</div>
    </Card>
  );
}

/** Título de um bloco dentro da seção ("Indisponibilidade", "E-mail de login"). */
export function SubTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-bold tracking-wide text-ink-muted uppercase">{children}</h3>;
}

/** "Alterações não salvas", Descartar e Salvar (só com Editar). */
export function SectionActions({ dirty, saving, onDiscard }: { dirty: boolean; saving: boolean; onDiscard: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
      {dirty ? <span className="mr-auto text-xs font-semibold text-ink-muted">Alterações não salvas</span> : null}
      {dirty ? (
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Descartar
        </Button>
      ) : null}
      <Button type="submit" variant="primary" disabled={!dirty} loading={saving}>
        Salvar
      </Button>
    </div>
  );
}

/**
 * O formulário de uma seção com Salvar próprio (useSectionForm): Enter num campo salva. Só com Visualizar, os campos
 * ficam travados (fieldset) e não há ações. Erro da gravação acima das ações; campo com erro recebe o foco.
 */
export function SectionForm<V extends object>({
  form,
  canEdit,
  children,
}: {
  form: SectionFormState<V>;
  canEdit: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      noValidate
      className="flex min-w-0 flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canEdit) return;
        void form.submit().then((ok) => {
          if (ok) return;
          // Os erros aparecem no próximo quadro: o primeiro campo com erro recebe o foco.
          window.requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
        });
      }}
    >
      <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-4">
        {children}
      </fieldset>
      {form.error ? <ErrorBox message={errorMessage(form.error)} /> : null}
      {canEdit ? <SectionActions dirty={form.dirty} saving={form.saving} onDiscard={form.discard} /> : null}
    </form>
  );
}

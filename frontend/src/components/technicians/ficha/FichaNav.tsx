"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConfirmLeave } from "@/components/Confirm";
import { Select } from "@/components/ui";
import { CADASTRO_DELIVERY, TECH_SECTION_GROUPS } from "@/lib/constants";
import { type FichaSectionKey, GESTAO_GROUP, technicianHref } from "@/lib/technicians";
import type { UUID } from "@/lib/types";

/** Um grupo do menu da ficha, só com as seções que estão no ar. */
export interface FichaMenuGroup {
  key: string;
  label: string;
  sections: { key: FichaSectionKey; label: string }[];
}

const ALL_GROUPS = [...TECH_SECTION_GROUPS, GESTAO_GROUP];

/**
 * As seções que pedem um acesso a mais, com o aviso de quem abre o endereço sem ele (o item nem está no menu):
 * Formas de recebimento só com Pagamentos; Anexos internos só com Técnicos em Editar.
 */
const GATED: Partial<Record<FichaSectionKey, { allowed: (canPayouts: boolean, canEditTechnicians: boolean) => boolean; text: string }>> = {
  recebimento: { allowed: (canPayouts) => canPayouts, text: "Formas de recebimento: só com acesso a Pagamentos." },
  anexos: { allowed: (_, canEditTechnicians) => canEditTechnicians, text: "Anexos internos: só com Técnicos em Editar." },
};

/**
 * O menu da ficha: os três grupos de TECH_SECTION_GROUPS (os mesmos nomes do app) e o grupo Gestão, só com as seções da
 * entrega no ar (`delivery <= CADASTRO_DELIVERY`). Formas de recebimento só com Pagamentos; Anexos internos só com
 * Técnicos em Editar.
 */
export function fichaMenu(canPayouts: boolean, canEditTechnicians: boolean): FichaMenuGroup[] {
  return ALL_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    sections: group.sections
      .filter((s) => s.delivery <= CADASTRO_DELIVERY && (GATED[s.key]?.allowed(canPayouts, canEditTechnicians) ?? true))
      .map((s) => ({ key: s.key, label: s.label })),
  })).filter((group) => group.sections.length > 0);
}

/**
 * A seção pedida na URL (`?secao=`) que a pessoa não pode ver, com o aviso que fica no lugar dela; null quando pode (ou
 * quando a seção não pede acesso a mais).
 */
export function fichaDenied(
  param: string | null,
  canPayouts: boolean,
  canEditTechnicians: boolean,
): { key: FichaSectionKey; text: string } | null {
  if (param !== "recebimento" && param !== "anexos") return null;
  const gate = GATED[param];
  return gate && !gate.allowed(canPayouts, canEditTechnicians) ? { key: param, text: gate.text } : null;
}

/** O nome da seção (o mesmo do menu), para o título do cartão e o aviso de alterações não salvas. */
export function fichaLabel(key: FichaSectionKey): string {
  for (const group of ALL_GROUPS) {
    const found = group.sections.find((s) => s.key === key);
    if (found) return found.label;
  }
  return key;
}

const ITEM =
  "block rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none";

/**
 * O menu da ficha: no computador, a coluna presa à esquerda (cada item é um link de verdade, com a seção na URL:
 * Ctrl/⌘+clique e o botão do meio abrem outra aba); no celular, um seletor acima da seção. Trocar de seção com
 * alteração não salva pergunta antes (os links pela guarda de useLeaveGuard; o seletor aqui).
 * `active` null: nenhuma seção do menu na tela (Formas de recebimento sem Pagamentos, Anexos internos sem Técnicos em
 * Editar).
 */
export function FichaNav({
  technicianId,
  groups,
  active,
  blockedLabel,
}: {
  technicianId: UUID;
  groups: FichaMenuGroup[];
  active: FichaSectionKey | null;
  /** A seção pedida que a pessoa não pode ver (fica no seletor, travada, enquanto é a da tela). */
  blockedLabel?: { key: FichaSectionKey; label: string } | null;
}) {
  const router = useRouter();
  const confirmLeave = useConfirmLeave();
  const selected = active ?? blockedLabel?.key ?? "";

  return (
    <>
      <nav aria-label="Seções da ficha" className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] self-start overflow-y-auto pb-2 lg:block">
        {groups.map((group) => (
          <div key={group.key} className="mb-4 last:mb-0">
            <p className="mb-1 px-3 text-[11px] font-bold tracking-wide text-ink-muted uppercase">{group.label}</p>
            <ul className="flex flex-col gap-0.5">
              {group.sections.map((s) => {
                const current = s.key === active;
                return (
                  <li key={s.key}>
                    <Link
                      href={technicianHref(technicianId, s.key)}
                      replace
                      scroll={false}
                      aria-current={current ? "page" : undefined}
                      className={clsx(
                        ITEM,
                        current ? "bg-nav-active text-brand-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      {s.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="lg:hidden">
        <Select
          aria-label="Seção"
          value={selected}
          onChange={async (e) => {
            const next = e.target.value as FichaSectionKey;
            // O seletor volta sozinho para a seção da tela (controlado); só troca depois do "Sair sem salvar".
            if (next === selected || !(await confirmLeave())) return;
            router.replace(technicianHref(technicianId, next), { scroll: false });
          }}
        >
          {blockedLabel && !active ? (
            <option value={blockedLabel.key} disabled>
              {blockedLabel.label}
            </option>
          ) : null}
          {groups.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.sections.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
    </>
  );
}

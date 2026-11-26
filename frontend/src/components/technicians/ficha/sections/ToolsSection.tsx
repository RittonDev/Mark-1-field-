"use client";

import { useState } from "react";
import { fold, SearchField } from "@/components/settings/shared";
import { ErrorBox, Skeleton } from "@/components/ui";
import { useTechCatalog } from "@/lib/queries";
import { cleanText, isPreGestao, sortedIds } from "@/lib/techProfileEdit";
import type { Technician, UUID } from "@/lib/types";
import { partStamp, ProfileUnavailable, profileInfo, ToolsPart } from "../../TechProfileView";
import { CatalogChips, EmptyCatalog } from "../CatalogChips";
import { fichaLabel } from "../FichaNav";
import { apiErrorText, SectionCard, SectionForm } from "../SectionCard";
import { useSectionForm } from "../useSectionForm";

/** A busca aparece com mais de 15 ferramentas. */
const SEARCH_FROM = 16;

interface ToolsForm {
  ids: UUID[];
}

const read = (t: Technician): ToolsForm => ({ ids: sortedIds(t.tool_ids ?? []) });
// A mesma lista em outra ordem não é mudança. As desativadas guardadas o servidor mantém (não vêm nem vão).
const body = (v: ToolsForm) => ({ tool_ids: sortedIds(v.ids) });

/**
 * Ferramental: as ferramentas do catálogo (Configurações › Técnicos) que ele tem. Com Técnicos Editar e a API da Gestão,
 * a central marca e desmarca as ativas (grava no Salvar, carimbo "pela central"); só com Visualizar, ou com a API de
 * antes, como era.
 */
export function ToolsSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const info = profileInfo(tech);
  if (canEdit && info && !isPreGestao(tech)) return <ToolsEditor tech={tech} />;

  const pre = isPreGestao(tech);
  return (
    <SectionCard title={fichaLabel("ferramental")} aside={partStamp(info, "tools")}>
      {!info ? (
        <ProfileUnavailable />
      ) : !pre || info.informed.tools ? (
        <ToolsPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
    </SectionCard>
  );
}

function ToolsEditor({ tech }: { tech: Technician }) {
  const label = fichaLabel("ferramental");
  const info = profileInfo(tech);
  const catalog = useTechCatalog("tools", true);
  const form = useSectionForm({ tech, label, read, body, savedTitle: "Ferramental salvo" });
  const { value, set } = form;
  const [search, setSearch] = useState("");
  // A marcada que saiu das ativas depois de a lista carregar (desativada agora) aparece para poder ser tirada.
  const active = catalog.data ?? [];
  const known = new Set(active.map((t) => t.id));
  const items = [...active, ...(tech.tools ?? []).filter((t) => value.ids.includes(t.id) && !known.has(t.id))];
  const searchable = items.length >= SEARCH_FROM;
  const term = searchable ? fold(cleanText(search)) : "";
  const shown = term ? items.filter((t) => fold(t.name).includes(term)) : items;
  const count = value.ids.length;

  return (
    <SectionCard title={label} aside={partStamp(info, "tools")}>
      <SectionForm form={form} canEdit>
        {catalog.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : catalog.error && !catalog.data ? (
          <ErrorBox message={apiErrorText(catalog.error)} onRetry={() => void catalog.refetch()} />
        ) : !items.length ? (
          <EmptyCatalog text="Nenhuma ferramenta cadastrada." />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {searchable ? (
                // Enter na busca não salva a seção.
                <div
                  className="w-full sm:max-w-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                >
                  <SearchField value={search} onChange={setSearch} placeholder="Buscar ferramenta" label="Buscar ferramenta" />
                </div>
              ) : null}
              <p className="text-xs text-ink-muted tabular-nums" aria-live="polite">
                {count === 1 ? "1 marcada" : `${count} marcadas`}
              </p>
            </div>
            {shown.length ? (
              <CatalogChips
                label={label}
                items={shown}
                selected={value.ids}
                onToggle={(id) =>
                  set("ids", value.ids.includes(id) ? value.ids.filter((other) => other !== id) : [...value.ids, id])
                }
              />
            ) : (
              <p role="status" className="text-sm text-ink-muted">
                Nenhuma ferramenta com este nome.
              </p>
            )}
          </div>
        )}
      </SectionForm>
    </SectionCard>
  );
}

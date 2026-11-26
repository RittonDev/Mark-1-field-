"use client";

import { ErrorBox, Skeleton } from "@/components/ui";
import { TECH_PROFILE_LIMITS } from "@/lib/constants";
import { useTechCatalog } from "@/lib/queries";
import { isPreGestao, sortedIds } from "@/lib/techProfileEdit";
import type { Technician, UUID } from "@/lib/types";
import { partStamp, ProfileUnavailable, profileInfo } from "../../TechProfileView";
import { CatalogChips, EmptyCatalog } from "../CatalogChips";
import { fichaLabel } from "../FichaNav";
import { apiErrorText, SectionCard, SectionForm } from "../SectionCard";
import { useSectionForm } from "../useSectionForm";

interface AreasForm {
  ids: UUID[];
}

const read = (t: Technician): AreasForm => ({ ids: sortedIds(t.area_ids ?? []) });
// A mesma lista em outra ordem não é mudança. As desativadas guardadas o servidor mantém (não vêm nem vão).
const body = (v: AreasForm) => ({ area_ids: sortedIds(v.ids) });

/**
 * Áreas de atuação: as áreas do catálogo (Configurações › Técnicos) em que ele atende, até 20. Com Técnicos Editar, a
 * central marca e desmarca as ativas (grava no Salvar, carimbo "pela central"); só com Visualizar, as marcadas. A API de
 * antes da Gestão não tem as áreas: indisponível.
 */
export function AreasSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const info = profileInfo(tech);
  if (isPreGestao(tech) || !info) {
    return (
      <SectionCard title={fichaLabel("areas-de-atuacao")}>
        <ProfileUnavailable />
      </SectionCard>
    );
  }
  if (canEdit) return <AreasEditor tech={tech} />;

  const areas = tech.areas ?? [];
  return (
    <SectionCard title={fichaLabel("areas-de-atuacao")} aside={partStamp(info, "areas")}>
      {areas.length ? (
        <CatalogChips label={fichaLabel("areas-de-atuacao")} items={areas} selected={areas.map((a) => a.id)} />
      ) : (
        <p className="text-sm text-ink-muted">Nenhuma área.</p>
      )}
    </SectionCard>
  );
}

function AreasEditor({ tech }: { tech: Technician }) {
  const label = fichaLabel("areas-de-atuacao");
  const info = profileInfo(tech);
  const catalog = useTechCatalog("areas", true);
  const form = useSectionForm({ tech, label, read, body, savedTitle: "Áreas de atuação salvas" });
  const { value, set } = form;
  // A marcada que saiu das ativas depois de a lista carregar (desativada agora) aparece para poder ser tirada.
  const active = catalog.data ?? [];
  const known = new Set(active.map((a) => a.id));
  const items = [
    ...active,
    ...(tech.areas ?? []).filter((a) => value.ids.includes(a.id) && !known.has(a.id)),
  ];
  const full = value.ids.length >= TECH_PROFILE_LIMITS.areas;

  return (
    <SectionCard title={label} aside={partStamp(info, "areas")}>
      <SectionForm form={form} canEdit>
        {catalog.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : catalog.error && !catalog.data ? (
          <ErrorBox message={apiErrorText(catalog.error)} onRetry={() => void catalog.refetch()} />
        ) : !items.length ? (
          <EmptyCatalog text="Nenhuma área cadastrada." />
        ) : (
          <div className="flex flex-col gap-2">
            <CatalogChips
              label={label}
              items={items}
              selected={value.ids}
              max={TECH_PROFILE_LIMITS.areas}
              onToggle={(id) =>
                set("ids", value.ids.includes(id) ? value.ids.filter((other) => other !== id) : [...value.ids, id])
              }
            />
            <p className="text-xs text-ink-muted tabular-nums">
              {full
                ? `Até ${TECH_PROFILE_LIMITS.areas} áreas de atuação.`
                : value.ids.length === 1
                  ? "1 marcada"
                  : `${value.ids.length} marcadas`}
            </p>
          </div>
        )}
      </SectionForm>
    </SectionCard>
  );
}

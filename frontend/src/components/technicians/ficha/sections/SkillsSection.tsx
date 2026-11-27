"use client";

import clsx from "clsx";
import { useId, useMemo } from "react";
import { type ComboItem, Combobox, searchText } from "@/components/new-ticket/Combobox";
import { Button, ErrorBox, Skeleton } from "@/components/ui";
import { SKILL_LEVEL, SKILL_LEVEL_ORDER, sinceText } from "@/lib/constants";
import { useTechCatalog } from "@/lib/queries";
import { isPreGestao, PROFILE_EDIT_LIMITS, skillsBody } from "@/lib/techProfileEdit";
import type { SkillLevel, TechCatalogItem, Technician, UUID } from "@/lib/types";
import { partStamp, ProfileUnavailable, profileInfo, SkillsPart } from "../../TechProfileView";
import { EmptyCatalog } from "../CatalogChips";
import { fichaLabel } from "../FichaNav";
import { apiErrorText, LegacyNote, SectionCard, SectionForm } from "../SectionCard";
import { useSectionForm } from "../useSectionForm";

/** Uma aptidão na tela: a do catálogo, o nível e o "desde" (a incluída agora ainda não tem: o servidor grava hoje). */
interface SkillRow {
  skill_id: UUID;
  name: string;
  level: SkillLevel;
  since: string | null;
}

interface SkillsForm {
  items: SkillRow[];
}

const read = (t: Technician): SkillsForm => ({
  items: (t.skills ?? []).map((s) => ({ skill_id: s.skill_id, name: s.name, level: s.level, since: s.since ?? null })),
});
// {skill_id, level} pelo id: a mesma lista em outra ordem não é mudança (o "desde" o servidor mantém pelo id).
const body = (v: SkillsForm) => ({ skills: skillsBody(v.items) });

/** O id do botão de nível marcado de uma aptidão (o foco vai para ele ao incluir). */
const levelId = (skillId: UUID, level: SkillLevel) => `aptidao-${skillId}-${level}`;

/**
 * Aptidões: as do catálogo (Configurações › Técnicos), cada uma com o nível e o "desde", até 30. Com Técnicos Editar e
 * a API da Gestão, a central inclui (pela busca), muda o nível e tira (grava no Salvar, carimbo "pela central"); só com
 * Visualizar, ou com a API de antes, como era.
 */
export function SkillsSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const info = profileInfo(tech);
  if (canEdit && info && !isPreGestao(tech)) return <SkillsEditor tech={tech} />;

  const pre = isPreGestao(tech);
  return (
    <SectionCard title={fichaLabel("aptidoes")} aside={partStamp(info, "skills")}>
      {/* A API de antes da Gestão não grava o perfil pela central: só leitura, com o aviso para quem edita. */}
      {canEdit && pre && info ? <LegacyNote /> : null}
      {!info ? (
        <ProfileUnavailable />
      ) : !pre || info.informed.skills ? (
        <SkillsPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
    </SectionCard>
  );
}

function SkillsEditor({ tech }: { tech: Technician }) {
  const label = fichaLabel("aptidoes");
  const info = profileInfo(tech);
  const catalog = useTechCatalog("skills", true);
  const form = useSectionForm({ tech, label, read, body, savedTitle: "Aptidões salvas" });
  const { value, set } = form;
  const comboLabel = useId();
  const full = value.items.length >= PROFILE_EDIT_LIMITS.skills;

  // As ativas que ele ainda não tem, na ordem do catálogo (alfabética).
  const options = useMemo<ComboItem<TechCatalogItem>[]>(() => {
    const taken = new Set(value.items.map((s) => s.skill_id));
    return (catalog.data ?? [])
      .filter((s) => !taken.has(s.id))
      .map((s) => ({ key: s.id, item: s, label: s.name, haystack: searchText(s.name) }));
  }, [catalog.data, value.items]);

  const change = (skillId: UUID, level: SkillLevel) =>
    set(
      "items",
      value.items.map((s) => (s.skill_id === skillId ? { ...s, level } : s)),
    );

  const include = (skill: TechCatalogItem | null) => {
    if (!skill || value.items.some((s) => s.skill_id === skill.id)) return;
    set("items", [...value.items, { skill_id: skill.id, name: skill.name, level: "intermediario", since: null }]);
    // O foco vai para o nível da aptidão incluída (no próximo quadro, já na tela).
    window.requestAnimationFrame(() => document.getElementById(levelId(skill.id, "intermediario"))?.focus());
  };

  const catalogEmpty = !catalog.isLoading && !catalog.error && !(catalog.data ?? []).length;

  return (
    <SectionCard title={label} aside={partStamp(info, "skills")}>
      <SectionForm form={form} canEdit>
        {value.items.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {value.items.map((skill) => (
              <li key={skill.skill_id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1 basis-40 text-sm font-semibold break-words text-ink">{skill.name}</span>
                <LevelPicker
                  name={skill.name}
                  skillId={skill.skill_id}
                  value={skill.level}
                  onChange={(level) => change(skill.skill_id, level)}
                />
                <span className="w-28 text-xs text-ink-muted">{skill.since ? sinceText(skill.since) : null}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Tirar ${skill.name}`}
                  onClick={() =>
                    set(
                      "items",
                      value.items.filter((other) => other.skill_id !== skill.skill_id),
                    )
                  }
                >
                  Tirar
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nenhuma aptidão.</p>
        )}

        <div className="flex flex-col gap-1.5 border-t border-line pt-5">
          {catalog.isLoading ? (
            <Skeleton className="h-9 w-full sm:max-w-sm" />
          ) : catalog.error && !catalog.data ? (
            <ErrorBox message={apiErrorText(catalog.error)} onRetry={() => void catalog.refetch()} />
          ) : catalogEmpty ? (
            <EmptyCatalog text="Nenhuma aptidão cadastrada." />
          ) : full ? (
            <p className="text-sm text-ink-muted">Limite de {PROFILE_EDIT_LIMITS.skills} aptidões.</p>
          ) : (
            <>
              <span id={comboLabel} className="text-xs font-semibold text-ink/80">
                Incluir aptidão
              </span>
              <div className="sm:max-w-sm">
                <Combobox
                  items={options}
                  value=""
                  onChange={include}
                  renderItem={(s) => s.name}
                  placeholder="Buscar aptidão"
                  emptyText="Nenhuma aptidão com este nome"
                  labelledBy={comboLabel}
                />
              </div>
            </>
          )}
        </div>
      </SectionForm>
    </SectionCard>
  );
}

/**
 * O nível da aptidão em três botões ("Nível de {nome}"): um grupo de rádio, com as setas trocando o nível (e o foco) e
 * só o marcado na ordem do Tab.
 */
function LevelPicker({
  name,
  skillId,
  value,
  onChange,
}: {
  name: string;
  skillId: UUID;
  value: SkillLevel;
  onChange: (level: SkillLevel) => void;
}) {
  const move = (from: SkillLevel, step: 1 | -1) => {
    const i = SKILL_LEVEL_ORDER.indexOf(from);
    const next = SKILL_LEVEL_ORDER[(i + step + SKILL_LEVEL_ORDER.length) % SKILL_LEVEL_ORDER.length];
    onChange(next);
    window.requestAnimationFrame(() => document.getElementById(levelId(skillId, next))?.focus());
  };
  return (
    <div role="radiogroup" aria-label={`Nível de ${name}`} className="inline-flex rounded-lg border border-line p-0.5">
      {SKILL_LEVEL_ORDER.map((level) => {
        const on = level === value;
        return (
          <button
            key={level}
            id={levelId(skillId, level)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(level)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(level, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(level, -1);
              }
            }}
            className={clsx(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              "focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none",
              on ? "bg-nav-active text-brand-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            {SKILL_LEVEL[level]}
          </button>
        );
      })}
    </div>
  );
}

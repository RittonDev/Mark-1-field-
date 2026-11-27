"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button, Checkbox, Field, Input, Select } from "@/components/ui";
import { EDUCATION_LEVEL, EDUCATION_LEVEL_ORDER } from "@/lib/constants";
import { todayISO } from "@/lib/format";
import {
  type EducationDraft,
  educationBody,
  educationEditProblem,
  isPreGestao,
  PROFILE_EDIT_LIMITS,
  thisMonth,
} from "@/lib/techProfileEdit";
import type { EducationLevel, Technician, UUID } from "@/lib/types";
import { EducationPart, partStamp, ProfileUnavailable, profileInfo } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { LegacyNote, SectionCard, SectionForm } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";

/** Um curso na tela: o gravado tem `id` (e a chave é ele); o incluído agora, só a chave. */
type EducationRow = EducationDraft & { id: UUID | null; key: string };

interface EducationForm {
  items: EducationRow[];
}

const read = (t: Technician): EducationForm => ({
  items: (t.education ?? []).map((item) => ({
    id: item.id,
    key: item.id,
    course: item.course,
    level: item.level,
    institution: item.institution,
    start: item.start,
    end: item.end,
    ongoing: item.end === null,
  })),
});

const body = (v: EducationForm) => ({ education: educationBody(v.items) });

/** O erro de um campo de um curso: "{chave}.{campo}". */
const errorKey = (row: EducationRow, field: string) => `${row.key}.${field}`;

function validate(v: EducationForm): SectionErrors {
  const today = todayISO();
  const errors: SectionErrors = {};
  for (const row of v.items) {
    for (const [field, message] of Object.entries(educationEditProblem(row, today))) {
      errors[errorKey(row, field)] = message;
    }
  }
  return errors;
}

/**
 * Formação: cursos, escolaridade e formação técnica (até 20). Com Técnicos Editar e a API da Gestão, a central inclui,
 * corrige e tira (grava no Salvar, carimbo "pela central"), com as mesmas regras e mensagens do app; só com
 * Visualizar, ou com a API de antes, como era.
 */
export function EducationSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const info = profileInfo(tech);
  if (canEdit && info && !isPreGestao(tech)) return <EducationEditor tech={tech} />;

  const pre = isPreGestao(tech);
  return (
    <SectionCard title={fichaLabel("formacao")} aside={partStamp(info, "education")}>
      {/* A API de antes da Gestão não grava o perfil pela central: só leitura, com o aviso para quem edita. */}
      {canEdit && pre && info ? <LegacyNote /> : null}
      {!info ? (
        <ProfileUnavailable />
      ) : !pre || info.informed.education ? (
        <EducationPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
    </SectionCard>
  );
}

function EducationEditor({ tech }: { tech: Technician }) {
  const label = fichaLabel("formacao");
  const info = profileInfo(tech);
  const form = useSectionForm({ tech, label, read, body, validate, savedTitle: "Formação salva" });
  const { value, set, errors } = form;
  const [added, setAdded] = useState(0);
  const month = thisMonth(todayISO());
  const full = value.items.length >= PROFILE_EDIT_LIMITS.education;

  const change = (key: string, values: Partial<EducationRow>) =>
    set(
      "items",
      value.items.map((row) => (row.key === key ? { ...row, ...values } : row)),
    );

  const include = () => {
    const key = `novo-${added}`;
    setAdded((n) => n + 1);
    set("items", [
      ...value.items,
      { id: null, key, course: "", level: null, institution: "", start: null, end: null, ongoing: false },
    ]);
    // O curso novo recebe o foco no próximo quadro (já na tela).
    window.requestAnimationFrame(() => document.getElementById(`formacao-${key}-curso`)?.focus());
  };

  return (
    <SectionCard title={label} aside={partStamp(info, "education")}>
      <SectionForm form={form} canEdit>
        {value.items.length ? (
          <ul className="flex flex-col gap-3">
            {value.items.map((row) => {
              const error = (field: string) => errors[errorKey(row, field)];
              const name = row.course.trim() || "a formação";
              return (
                <li key={row.key} className="flex min-w-0 flex-col gap-3 rounded-lg border border-line p-3">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
                    <Field label="Curso" required error={error("course")}>
                      <Input
                        id={`formacao-${row.key}-curso`}
                        value={row.course}
                        onChange={(e) => change(row.key, { course: e.target.value })}
                        maxLength={PROFILE_EDIT_LIMITS.course}
                        autoComplete="off"
                        aria-invalid={error("course") ? true : undefined}
                      />
                    </Field>
                    <Field label="Nível" required error={error("level")}>
                      <Select
                        value={row.level ?? ""}
                        onChange={(e) => change(row.key, { level: (e.target.value || null) as EducationLevel | null })}
                        aria-invalid={error("level") ? true : undefined}
                      >
                        <option value="">—</option>
                        {EDUCATION_LEVEL_ORDER.map((level) => (
                          <option key={level} value={level}>
                            {EDUCATION_LEVEL[level]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Instituição" required error={error("institution")}>
                    <Input
                      value={row.institution}
                      onChange={(e) => change(row.key, { institution: e.target.value })}
                      maxLength={PROFILE_EDIT_LIMITS.institution}
                      autoComplete="off"
                      aria-invalid={error("institution") ? true : undefined}
                    />
                  </Field>
                  <div className="flex flex-wrap items-start gap-3">
                    <Field label="Início" required error={error("start")} className="w-44">
                      <Input
                        type="month"
                        value={row.start ?? ""}
                        min={PROFILE_EDIT_LIMITS.firstMonth}
                        max={month}
                        onChange={(e) => change(row.key, { start: e.target.value || null })}
                        aria-invalid={error("start") ? true : undefined}
                      />
                    </Field>
                    <Field label="Fim" required={!row.ongoing} error={row.ongoing ? undefined : error("end")} className="w-44">
                      <Input
                        type="month"
                        value={row.ongoing ? "" : (row.end ?? "")}
                        min={row.start || PROFILE_EDIT_LIMITS.firstMonth}
                        max={month}
                        disabled={row.ongoing}
                        onChange={(e) => change(row.key, { end: e.target.value || null })}
                        aria-invalid={!row.ongoing && error("end") ? true : undefined}
                      />
                    </Field>
                    {/* Alinhado aos campos (o rótulo deles fica em cima). */}
                    <div className="flex h-9 items-center sm:mt-[1.375rem]">
                      <Checkbox
                        label="Em andamento"
                        checked={row.ongoing}
                        onChange={(on) => change(row.key, { ongoing: on, end: on ? null : row.end })}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Tirar ${name}`}
                      onClick={() =>
                        set(
                          "items",
                          value.items.filter((other) => other.key !== row.key),
                        )
                      }
                    >
                      Tirar
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nenhuma formação.</p>
        )}
        {full ? (
          <p className="text-sm text-ink-muted">Limite de {PROFILE_EDIT_LIMITS.education} formações.</p>
        ) : (
          <Button className="self-start" onClick={include}>
            <Plus aria-hidden className="size-3.5" />
            Incluir formação
          </Button>
        )}
      </SectionForm>
    </SectionCard>
  );
}

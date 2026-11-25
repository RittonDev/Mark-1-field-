"use client";

import { Field, Input, Select } from "@/components/ui";
import { useServiceTypes, useTeams } from "@/lib/queries";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { SectionCard, SectionForm } from "../SectionCard";
import { ServicePicker } from "../ServicePicker";
import { useSectionForm } from "../useSectionForm";

interface TeamForm {
  teamId: string;
  jobTitle: string;
  start: string;
  end: string;
  breakStart: string;
  breakEnd: string;
  serviceIds: string[];
}

/** "08:00" (a API manda "08:00:00"). */
const time = (value: string | null | undefined) => value?.slice(0, 5) ?? "";

const read = (t: Technician): TeamForm => ({
  teamId: t.team?.id ?? "",
  jobTitle: t.job_title ?? "",
  start: time(t.work_schedule?.start),
  end: time(t.work_schedule?.end),
  breakStart: time(t.work_schedule?.break_start),
  breakEnd: time(t.work_schedule?.break_end),
  serviceIds: (t.services ?? []).map((s) => s.id),
});

const body = (v: TeamForm) => ({
  team_id: v.teamId || null,
  job_title: v.jobTitle.trim() || null,
  // Sem início nem fim, sem jornada (o intervalo sozinho não vale).
  work_schedule:
    v.start || v.end
      ? { start: v.start || null, end: v.end || null, break_start: v.breakStart || null, break_end: v.breakEnd || null }
      : null,
  service_type_ids: [...v.serviceIds].sort(),
});

const SCHEDULE_FIELDS = [
  ["start", "Jornada: início"],
  ["end", "Jornada: fim"],
  ["breakStart", "Intervalo: de"],
  ["breakEnd", "Intervalo: até"],
] as const;

/** Equipe e jornada (só a central): grupo técnico, cargo, jornada e os serviços que ele faz. */
export function TeamSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const label = fichaLabel("equipe");
  const teams = useTeams();
  const serviceTypes = useServiceTypes({ active: true });
  const form = useSectionForm({ tech, label, read, body, savedTitle: "Equipe e jornada salvas" });
  const { value, set } = form;
  const teamList = teams.data ?? [];
  // O grupo gravado enquanto a lista não chega (ou fora dela) continua na escolha.
  const savedTeam = tech.team && tech.team.id === value.teamId && !teamList.some((t) => t.id === value.teamId) ? tech.team : null;

  return (
    <SectionCard title={label}>
      <SectionForm form={form} canEdit={canEdit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Grupo técnico">
            <Select value={value.teamId} onChange={(e) => set("teamId", e.target.value)}>
              <option value="">Sem grupo</option>
              {teamList
                .filter((t) => t.is_active || t.id === value.teamId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              {savedTeam ? <option value={savedTeam.id}>{savedTeam.name}</option> : null}
            </Select>
          </Field>
          <Field label="Cargo">
            <Input value={value.jobTitle} onChange={(e) => set("jobTitle", e.target.value)} maxLength={120} autoComplete="off" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SCHEDULE_FIELDS.map(([key, text]) => (
            <Field key={key} label={text}>
              <Input type="time" value={value[key]} onChange={(e) => set(key, e.target.value)} />
            </Field>
          ))}
        </div>
        <ServicePicker
          value={value.serviceIds}
          onChange={(ids) => set("serviceIds", ids)}
          options={serviceTypes.data ?? []}
          saved={tech.services ?? []}
          loading={serviceTypes.isLoading}
          readOnly={!canEdit}
        />
        {tech.legacy ? (
          <p className="text-xs text-ink-muted">
            Importado do Field Control{tech.legacy.id ? ` · ID ${tech.legacy.id}` : ""}
            {tech.legacy.territories?.length ? ` · territórios: ${tech.legacy.territories.join(", ")}` : ""}
          </p>
        ) : null}
      </SectionForm>
    </SectionCard>
  );
}

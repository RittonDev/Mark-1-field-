"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { NeutralChip } from "@/components/settings/shared";
import { Button, Field, Input } from "@/components/ui";
import { ALL_SLOTS, periodText, sortSlots, unavailableOn } from "@/lib/constants";
import { todayISO } from "@/lib/format";
import {
  allSlots,
  isPreGestao,
  PERIOD_MSG,
  periodBounds,
  periodProblem,
  PROFILE_EDIT_LIMITS,
  toggleSlot,
  unavailabilityBody,
} from "@/lib/techProfileEdit";
import type { AvailabilitySlot, Technician, UnavailabilityIn } from "@/lib/types";
import { AvailabilityGrid, AvailabilityPart, partStamp, ProfileUnavailable, profileInfo } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { LegacyNote, SectionCard, SectionForm, SubTitle } from "../SectionCard";
import { useSectionForm } from "../useSectionForm";

/** Os períodos que não terminaram (a API já manda só esses, pelo início). */
const openPeriods = <T extends { end: string }>(list: readonly T[] | null | undefined, today: string) =>
  (list ?? []).filter((p) => p.end >= today);

/** O período na tela: o gravado tem `id`; o incluído agora, a chave dele (some ao salvar). */
type PeriodRow = UnavailabilityIn & { key: string };

interface ScheduleForm {
  slots: AvailabilitySlot[];
  periods: PeriodRow[];
}

/**
 * Dias e horários: os turnos em que atende (grade de 7 dias por 4 turnos) e os períodos em que não atende (sem motivo;
 * nesses dias ele sai das sugestões e das ofertas). Com Técnicos Editar e a API da Gestão, a central marca os turnos e
 * inclui ou tira períodos (grava no Salvar, carimbo "pela central"); só com Visualizar, ou com a API de antes, como era.
 */
export function ScheduleSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const info = profileInfo(tech);
  if (canEdit && info && !isPreGestao(tech)) return <ScheduleEditor tech={tech} />;

  const today = todayISO();
  const periods = openPeriods(tech.unavailability, today);
  const now = unavailableOn(periods, today);
  const pre = isPreGestao(tech);
  return (
    <SectionCard title={fichaLabel("dias-e-horarios")} aside={partStamp(info, "availability")}>
      {/* A API de antes da Gestão não grava o perfil pela central: só leitura, com o aviso para quem edita. */}
      {canEdit && pre && info ? <LegacyNote /> : null}
      {!info ? (
        <ProfileUnavailable />
      ) : !pre || info.informed.availability ? (
        <AvailabilityPart tech={tech} />
      ) : (
        <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
      )}
      <section className="flex flex-col gap-2 border-t border-line pt-5">
        <SubTitle>Indisponibilidade</SubTitle>
        {periods.length ? (
          <ul className="flex flex-col gap-1.5">
            {periods.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                {periodText(p)}
                {now?.id === p.id ? <NeutralChip>Agora</NeutralChip> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nenhum período de indisponibilidade.</p>
        )}
      </section>
    </SectionCard>
  );
}

function ScheduleEditor({ tech }: { tech: Technician }) {
  const label = fichaLabel("dias-e-horarios");
  const info = profileInfo(tech);
  const today = todayISO();
  const form = useSectionForm<ScheduleForm>({
    tech,
    label,
    read: (t) => ({
      slots: sortSlots(t.availability ?? []),
      periods: openPeriods(t.unavailability, todayISO()).map((p) => ({ id: p.id, start: p.start, end: p.end, key: p.id })),
    }),
    body: (v) => ({ availability: sortSlots(v.slots), unavailability: unavailabilityBody(v.periods) }),
    savedTitle: "Dias e horários salvos",
  });
  const { value, set } = form;
  const [draft, setDraft] = useState({ start: "", end: "" });
  const [tried, setTried] = useState(false);
  const [added, setAdded] = useState(0);

  const bounds = periodBounds(today);
  const draftErrors: Partial<Record<"start" | "end", string>> = tried
    ? periodProblem({ start: draft.start || null, end: draft.end || null }, value.periods, today)
    : {};
  const full = value.periods.length >= PROFILE_EDIT_LIMITS.periods;
  const now = unavailableOn(
    value.periods.map((p) => ({ id: p.key, start: p.start, end: p.end })),
    today,
  );

  const include = () => {
    setTried(true);
    const errors = periodProblem({ start: draft.start || null, end: draft.end || null }, value.periods, today);
    if (errors.start || errors.end) return;
    const key = `novo-${added}`;
    setAdded((n) => n + 1);
    const next = [...value.periods, { start: draft.start, end: draft.end, key }];
    next.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
    set("periods", next);
    setDraft({ start: "", end: "" });
    setTried(false);
  };

  // Enter nas datas inclui o período (em vez de salvar a seção sem ele).
  const enterIncludes = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    include();
  };

  return (
    <SectionCard title={label} aside={partStamp(info, "availability")}>
      <SectionForm form={form} canEdit>
        <div className="flex flex-col gap-2">
          <AvailabilityGrid slots={value.slots} onToggle={(slot) => set("slots", toggleSlot(value.slots, slot))} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xs text-ink-muted tabular-nums">
              {value.slots.length} de {ALL_SLOTS.length} turnos
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={value.slots.length === ALL_SLOTS.length}
              onClick={() => set("slots", allSlots())}
            >
              Marcar todos
            </Button>
            <Button size="sm" variant="ghost" disabled={!value.slots.length} onClick={() => set("slots", [])}>
              Limpar
            </Button>
          </div>
        </div>

        <section className="flex flex-col gap-3 border-t border-line pt-5">
          <SubTitle>Indisponibilidade</SubTitle>
          {value.periods.length ? (
            <ul className="flex flex-col gap-1">
              {value.periods.map((p) => (
                <li key={p.key} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                  {periodText(p)}
                  {now?.id === p.key ? <NeutralChip>Agora</NeutralChip> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Tirar o período ${periodText(p)}`}
                    onClick={() =>
                      set(
                        "periods",
                        value.periods.filter((other) => other.key !== p.key),
                      )
                    }
                  >
                    Tirar
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">Nenhum período de indisponibilidade.</p>
          )}
          {full ? (
            <p className="text-sm text-ink-muted">{PERIOD_MSG.limit}</p>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              <Field label="De" error={draftErrors.start} className="w-44">
                <Input
                  type="date"
                  value={draft.start}
                  min={bounds.min}
                  max={bounds.max}
                  onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
                  onKeyDown={enterIncludes}
                  aria-invalid={draftErrors.start ? true : undefined}
                />
              </Field>
              <Field label="Até" error={draftErrors.end} className="w-44">
                <Input
                  type="date"
                  value={draft.end}
                  min={draft.start && draft.start > bounds.min ? draft.start : bounds.min}
                  max={bounds.max}
                  onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))}
                  onKeyDown={enterIncludes}
                  aria-invalid={draftErrors.end ? true : undefined}
                />
              </Field>
              {/* Alinhado aos campos (o rótulo deles fica em cima). */}
              <Button className="sm:mt-[1.375rem]" onClick={include}>
                <Plus aria-hidden className="size-3.5" />
                Incluir período
              </Button>
            </div>
          )}
        </section>
      </SectionForm>
    </SectionCard>
  );
}

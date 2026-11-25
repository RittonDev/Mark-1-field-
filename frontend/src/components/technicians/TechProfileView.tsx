"use client";

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BadgeCheck, CalendarDays, Check, Wrench } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { buttonClassName, EmptyState, ErrorBox, Skeleton } from "@/components/ui";
import { api } from "@/lib/api";
import {
  ALL_SLOTS,
  DAY_PERIOD,
  DAY_PERIOD_ORDER,
  EDUCATION_LEVEL,
  educationPeriodText,
  formatPlate,
  SKILL_LEVEL,
  sinceText,
  slotsText,
  sortSlots,
  TRANSPORT_MODE,
  TRANSPORT_MODE_ORDER,
  WEEKDAY,
  WEEKDAY_ORDER,
} from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { labelMap, useOnboardingCatalog } from "@/lib/onboarding";
import { useCan } from "@/lib/permissions";
import type { Technician, TechProfilePart, TechProfileStamp, TechProfileStamps, UUID } from "@/lib/types";

// O perfil técnico (o técnico mantém no app; a central só vê) em peças: a ficha do técnico (/tecnicos/[id]) mostra
// cada uma na sua seção (Dias e horários, Transporte, Formação, Aptidões, Ferramental), com o carimbo de quando e por
// onde chegou. TechProfileView, a vista de tudo junto da ficha antiga da lista, monta as mesmas peças.

/** Etiqueta neutra (ferramentas, meios de transporte, CNH e o nível da aptidão). */
const CHIP = "rounded-full border border-line px-2.5 py-0.5 text-xs text-ink";

/** Quando e por onde a parte chegou: o técnico no app ou a ficha da homologação (na aprovação). */
export function stampText(stamp: TechProfileStamp | null | undefined): string {
  if (!stamp) return "Não informado";
  return stamp.via === "app"
    ? `Informado pelo técnico em ${formatDate(stamp.at)}`
    : `Da ficha da homologação, ${formatDate(stamp.at)}`;
}

/**
 * Os carimbos e o que já foi informado de cada parte (com data ou, sem ela, com dado). null: o servidor ainda não tem o
 * perfil técnico (o detalhe vem sem as partes).
 */
export function profileInfo(
  tech: Technician,
): { stamps: TechProfileStamps; informed: Record<TechProfilePart, boolean> } | null {
  const stamps = tech.tech_profile_updated;
  if (!stamps) return null;
  return {
    stamps,
    informed: {
      availability: !!stamps.availability || (tech.availability ?? []).length > 0,
      tools: !!stamps.tools || (tech.tools ?? []).length > 0,
      transport: !!stamps.transport || !!tech.transport,
      skills: !!stamps.skills || (tech.skills ?? []).length > 0,
      education: !!stamps.education || (tech.education ?? []).length > 0,
    },
  };
}

/** O servidor ainda não tem esta parte do cadastro (antes de a API nova subir). */
export function ProfileUnavailable() {
  return (
    <EmptyState
      size="sm"
      icon={<Wrench />}
      title="Indisponível no momento"
      description="O servidor ainda não tem esta parte do cadastro. Tente de novo mais tarde."
    />
  );
}

/**
 * A disponibilidade numa grade de 7 dias por 4 turnos (só leitura). O leitor de tela ouve o resumo na legenda e, célula
 * a célula, "Disponível" ou "Indisponível".
 */
export function AvailabilityGrid({ slots }: { slots: readonly string[] }) {
  const marked = new Set(slots);
  return (
    <table className="w-full max-w-md table-fixed border-separate border-spacing-1 text-xs">
      <caption className="sr-only">Disponibilidade por dia e turno: {slotsText(slots) || "nenhum turno"}</caption>
      <colgroup>
        <col className="w-11" />
        {DAY_PERIOD_ORDER.map((period) => (
          <col key={period} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <td />
          {DAY_PERIOD_ORDER.map((period) => (
            <th key={period} scope="col" className="px-0.5 pb-0.5 text-center font-semibold text-ink-muted">
              <span className="block truncate">{DAY_PERIOD[period].label}</span>
              <span className="block text-[10px] font-normal text-ink-subtle">{DAY_PERIOD[period].hours}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {WEEKDAY_ORDER.map((day) => (
          <tr key={day}>
            <th scope="row" title={WEEKDAY[day].label} className="pr-1 text-left font-semibold text-ink-muted capitalize">
              {WEEKDAY[day].short}
            </th>
            {DAY_PERIOD_ORDER.map((period) => {
              const on = marked.has(`${day}:${period}`);
              return (
                <td
                  key={period}
                  className={clsx(
                    "h-7 rounded-md text-center",
                    on ? "bg-brand-soft text-brand-ink dark:bg-brand/15" : "bg-surface-2",
                  )}
                >
                  {on ? <Check aria-hidden className="mx-auto size-3.5" /> : null}
                  <span className="sr-only">{on ? "Disponível" : "Indisponível"}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Os turnos em que ele atende: a grade e "{n} de 28 turnos". */
export function AvailabilityPart({ tech }: { tech: Technician }) {
  const slots = sortSlots(tech.availability ?? []);
  if (!slots.length) return <p className="text-sm text-ink-muted">Nenhum turno marcado</p>;
  return (
    <div className="flex flex-col gap-2">
      <AvailabilityGrid slots={slots} />
      <p className="text-xs text-ink-muted tabular-nums">
        {slots.length} de {ALL_SLOTS.length} turnos
      </p>
    </div>
  );
}

/** As ferramentas que ele marcou no app, em ordem alfabética. */
export function ToolsPart({ tech }: { tech: Technician }) {
  const tools = [...(tech.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  if (!tools.length) return <p className="text-sm text-ink-muted">Nenhuma ferramenta marcada</p>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Ferramental">
      {tools.map((tool) => (
        <li key={tool.id} className={CHIP}>
          {tool.name}
        </li>
      ))}
    </ul>
  );
}

/** "Veículo: Modelo Exemplo · ABC-1234" (só o que houver); null sem modelo nem placa. */
export function vehicleText(tech: Pick<Technician, "vehicle_model" | "vehicle_plate">): string | null {
  const parts = [tech.vehicle_model?.trim(), tech.vehicle_plate ? formatPlate(tech.vehicle_plate) : null].filter(Boolean);
  return parts.length ? `Veículo: ${parts.join(" · ")}` : null;
}

/** Meios de transporte e CNH (com `withVehicle`, também o veículo, do cadastro). */
export function TransportPart({ tech, withVehicle = false }: { tech: Technician; withVehicle?: boolean }) {
  const transport = tech.transport ?? null;
  const modes = transport ? TRANSPORT_MODE_ORDER.filter((m) => transport.modes.includes(m)) : [];
  const vehicle = withVehicle ? vehicleText(tech) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {modes.length ? (
          modes.map((mode) => (
            <span key={mode} className={CHIP}>
              {TRANSPORT_MODE[mode]}
            </span>
          ))
        ) : (
          <span className="text-sm text-ink-muted">Nenhum meio de transporte</span>
        )}
        {transport ? <span className={CHIP}>{transport.driver_license ? "Com CNH" : "Sem CNH"}</span> : null}
      </div>
      {vehicle ? <p className="text-sm text-ink">{vehicle}</p> : null}
    </div>
  );
}

/** As aptidões com o nível e o "desde". */
export function SkillsPart({ tech }: { tech: Technician }) {
  const skills = tech.skills ?? [];
  if (!skills.length) return <p className="text-sm text-ink-muted">Nenhuma aptidão</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {skills.map((skill, i) => (
        <li key={`${i}-${skill.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-semibold text-ink">{skill.name}</span>
          <span className="rounded-full border border-line px-2 py-px text-[11px] text-ink">
            {SKILL_LEVEL[skill.level] ?? skill.level}
          </span>
          {skill.since ? <span className="text-xs text-ink-muted">{sinceText(skill.since)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Os cursos e a formação, com a instituição e o período. */
export function EducationPart({ tech }: { tech: Technician }) {
  const education = tech.education ?? [];
  if (!education.length) return <p className="text-sm text-ink-muted">Nenhuma formação</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {education.map((item) => (
        <li key={item.id} className="min-w-0 text-sm">
          <p className="font-semibold break-words text-ink">{item.course}</p>
          <p className="text-xs break-words text-ink-muted">
            {EDUCATION_LEVEL[item.level] ?? item.level} · {item.institution}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-muted">
            <CalendarDays aria-hidden className="size-3.5 shrink-0" />
            {educationPeriodText(item.start, item.end)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** As áreas da ficha aprovada (rótulos do catálogo da homologação); `action` à direita do título. Sem áreas nem ação: nada. */
export function HomologationAreas({ tech, action }: { tech: Technician; action?: React.ReactNode }) {
  const catalog = useOnboardingCatalog();
  const areas = useMemo(() => labelMap(catalog.data?.service_areas), [catalog.data]);
  const list = tech.service_areas ?? [];
  if (!list.length && !action) return null;
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold tracking-wide text-ink-muted uppercase">Áreas da homologação</h3>
        {action}
      </div>
      {list.length ? (
        <div className="flex flex-wrap gap-1.5">
          {list.map((k) => (
            <span key={k} className="rounded-full bg-nav-active px-2.5 py-0.5 text-xs font-medium text-brand-ink">
              {areas[k] ?? k}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Cabeçalho de uma parte na vista de tudo junto: o título e, à direita, quando chegou ("Não informado" sem a parte). */
function Part({
  title,
  stamp,
  informed,
  children,
}: {
  title: string;
  stamp: TechProfileStamp | null | undefined;
  /** A parte já foi informada (com data ou, sem ela, com dado): sem isso, só o "Não informado". */
  informed: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-xs font-bold tracking-wide text-ink-muted uppercase">{title}</h3>
        {stamp || !informed ? <p className="text-xs text-ink-muted">{stampText(stamp)}</p> : null}
      </div>
      {informed ? children : null}
    </section>
  );
}

/**
 * "Perfil técnico" de tudo junto (só leitura), da ficha antiga em diálogo na lista de Técnicos: disponibilidade,
 * ferramental, transporte, aptidões e formação, cada parte com a data e a origem, e as áreas da homologação. Lê o
 * detalhe (GET /technicians/{id}); o tempo real (profile.changed) relê sozinho. `dirty`: o cadastro tem alteração não
 * salva (o link da ficha da homologação abre em outra aba). A ficha em página própria usa as peças acima.
 */
export function TechProfileView({ technicianId, dirty }: { technicianId: UUID; dirty: boolean }) {
  const canOnboarding = useCan("base.onboarding");
  const query = useQuery({
    queryKey: ["technicians", "one", technicianId],
    queryFn: ({ signal }) => api.get<Technician>(`/technicians/${technicianId}`, undefined, { signal }),
    staleTime: 30_000,
  });
  const detail = query.data;

  if (!detail) {
    // Tentando de novo depois do erro: o esqueleto volta enquanto busca.
    return query.isError && !query.isFetching ? (
      <ErrorBox message="Não deu para carregar o perfil técnico." onRetry={() => void query.refetch()} />
    ) : (
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        <span className="sr-only">Carregando o perfil técnico</span>
        <Skeleton className="h-48 w-full max-w-md" />
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  // Áreas da homologação: as da ficha aprovada e o link para ela (com Homologação).
  const homologation =
    detail.service_areas.length || (detail.application_id && canOnboarding) ? (
      <HomologationAreas
        tech={detail}
        action={
          detail.application_id && canOnboarding ? (
            // Com alteração não salva, abre em outra aba: sair daqui descartaria o cadastro.
            <Link
              href={`/homologacao?ficha=${detail.application_id}`}
              className={buttonClassName("ghost", "sm")}
              target={dirty ? "_blank" : undefined}
              rel={dirty ? "noreferrer" : undefined}
            >
              <BadgeCheck className="size-3.5" />
              Ver ficha da homologação
            </Link>
          ) : undefined
        }
      />
    ) : null;

  const info = profileInfo(detail);
  // Servidor sem o perfil técnico (antes de a API nova subir): o detalhe vem sem as partes.
  if (!info) {
    return (
      <div className="flex flex-col gap-5">
        <ProfileUnavailable />
        {homologation}
      </div>
    );
  }
  const { stamps, informed } = info;

  if (!Object.values(informed).some(Boolean) && !homologation) {
    return (
      <EmptyState
        icon={<Wrench />}
        title="Perfil técnico ainda não informado"
        description="O técnico preenche no app, em Configurações."
      />
    );
  }

  const toolsCount = (detail.tools ?? []).length;
  return (
    <div className="flex flex-col gap-5">
      {query.isRefetchError ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
          Não deu para atualizar agora.
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="rounded font-semibold text-ink underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-60"
          >
            Tentar de novo
          </button>
        </p>
      ) : null}
      <p className="text-xs text-ink-muted">O técnico mantém estes dados no app.</p>

      <Part title="Disponibilidade" stamp={stamps.availability} informed={informed.availability}>
        <AvailabilityPart tech={detail} />
      </Part>

      <div className="grid gap-5 lg:grid-cols-2">
        <Part title={toolsCount ? `Ferramental · ${toolsCount}` : "Ferramental"} stamp={stamps.tools} informed={informed.tools}>
          <ToolsPart tech={detail} />
        </Part>

        <Part title="Transporte" stamp={stamps.transport} informed={informed.transport}>
          <TransportPart tech={detail} />
        </Part>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Part title="Aptidões" stamp={stamps.skills} informed={informed.skills}>
          <SkillsPart tech={detail} />
        </Part>

        <Part title="Formação" stamp={stamps.education} informed={informed.education}>
          <EducationPart tech={detail} />
        </Part>
      </div>

      {homologation}
    </div>
  );
}

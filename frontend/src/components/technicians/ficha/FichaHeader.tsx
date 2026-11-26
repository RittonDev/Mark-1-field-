"use client";

import { BadgeCheck, ClipboardList, MessageCircle } from "lucide-react";
import Link from "next/link";
import { NeutralChip } from "@/components/settings/shared";
import { buttonClassName, Card, Pill } from "@/components/ui";
import { periodShort, periodText, unavailableOn } from "@/lib/constants";
import { todayISO } from "@/lib/format";
import { useCan } from "@/lib/permissions";
import { isOutOfActive } from "@/lib/technicians";
import type { Technician } from "@/lib/types";
import { whatsappUrl } from "@/lib/whatsapp";
import { LevelBadge } from "../LevelBadge";
import { useTechnicianLevel } from "../LevelSection";
import { TechAvatar } from "../TechAvatar";
import { OperationalPill } from "./OperationalPill";

/** Cor dos selos de problema que não são a situação (indisponível hoje). */
const AMBER = "#d97706";

/**
 * O topo da ficha: foto, nome, cargo e grupo, o elo, os selos (situação, sem acesso ao app, indisponível hoje) e os
 * atalhos para fora da ficha (WhatsApp em outra aba; as OS abertas e a ficha da homologação são links de verdade).
 */
export function FichaHeader({ tech }: { tech: Technician }) {
  const canOnboarding = useCan("base.onboarding");
  // O elo recalculado agora (a mesma busca da seção Elo); enquanto chega, o selo guardado da lista.
  const level = useTechnicianLevel(tech.id).data;
  const badge = level
    ? { tier: level.tier, atRisk: level.at_risk !== null }
    : tech.level
      ? { tier: tech.level.tier, atRisk: tech.level.at_risk }
      : null;
  const today = todayISO();
  const away = unavailableOn(tech.unavailability, today);
  const role = [tech.job_title?.trim() || "Técnico", tech.team?.name].filter(Boolean).join(" · ");
  const outOfActive = isOutOfActive(tech);

  return (
    <Card className="mb-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <TechAvatar tech={tech} size="lg" />
          <div className="min-w-0">
            <h1 className="text-[22px] leading-tight font-bold tracking-[-0.02em] break-words text-ink">{tech.name}</h1>
            {/* O traço da logo embaixo do título, como no PageHeader. */}
            <span aria-hidden className="brand-gradient mt-2 block h-[3px] w-10 rounded-full" />
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
              {role}
              {badge ? <LevelBadge tier={badge.tier} atRisk={badge.atRisk} size="sm" /> : null}
            </p>
            {outOfActive || !tech.is_active || away ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <OperationalPill tech={tech} />
                {tech.is_active ? null : <NeutralChip>Sem acesso ao app</NeutralChip>}
                {away ? (
                  <span title={periodText(away)} className="inline-flex">
                    <Pill color={AMBER}>Indisponível {periodShort(away, today)}</Pill>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tech.phone ? (
            <a
              href={whatsappUrl(tech.phone, "")}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassName("secondary", "sm")}
              title={`Conversar com ${tech.name} no WhatsApp`}
            >
              <MessageCircle className="size-3.5" />
              WhatsApp
            </a>
          ) : null}
          {tech.open_tickets > 0 ? (
            <Link href={`/chamados?assignee_id=${tech.id}&open_only=true`} className={buttonClassName("ghost", "sm")}>
              <ClipboardList className="size-3.5" />
              OS abertas · {tech.open_tickets}
            </Link>
          ) : null}
          {tech.application_id && canOnboarding ? (
            <Link href={`/homologacao?ficha=${tech.application_id}`} className={buttonClassName("ghost", "sm")}>
              <BadgeCheck className="size-3.5" />
              Ficha da homologação
            </Link>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

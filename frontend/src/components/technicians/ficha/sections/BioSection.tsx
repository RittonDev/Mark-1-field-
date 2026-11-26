"use client";

import { Textarea } from "@/components/ui";
import { normalizeBio, PROFILE_LIMITS } from "@/lib/constants";
import { isLegacyDetail } from "@/lib/technicians";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { FICHA_HEADING_ID, LegacyNote, SectionCard, SectionForm } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";

interface BioForm {
  bio: string;
}

const read = (t: Technician): BioForm => ({ bio: t.bio ?? "" });
// Com os parágrafos, como a API grava (normalizeBio = personal.bio): compara e envia o mesmo texto.
const body = (v: BioForm) => ({ bio: normalizeBio(v.bio) || null });
const validate = (v: BioForm): SectionErrors =>
  normalizeBio(v.bio).length > PROFILE_LIMITS.bio ? { bio: `No máximo ${PROFILE_LIMITS.bio} caracteres.` } : {};

/**
 * Mini biografia (opcional): a experiência e a atuação, em até 500 caracteres, com os parágrafos (o limite conta depois
 * de juntar as linhas em branco repetidas). Com a API de antes (até a publicação), só leitura.
 */
export function BioSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const label = fichaLabel("mini-biografia");
  const legacy = isLegacyDetail(tech);
  const form = useSectionForm({ tech, label, read, body, validate, savedTitle: "Mini biografia salva" });
  const { value, set, errors } = form;

  return (
    <SectionCard title={label}>
      {legacy ? <LegacyNote /> : null}
      <SectionForm form={form} canEdit={canEdit && !legacy}>
        {/* O título da seção é o rótulo do campo (um rótulo igual logo abaixo dele seria repetido). */}
        <div className="flex flex-col gap-1.5">
          <Textarea
            rows={5}
            value={value.bio}
            onChange={(e) => set("bio", e.target.value)}
            maxLength={PROFILE_LIMITS.bio}
            aria-labelledby={FICHA_HEADING_ID}
            aria-invalid={errors.bio ? true : undefined}
          />
          <div className="flex items-start justify-between gap-3 text-xs">
            {errors.bio ? (
              <span role="alert" className="font-medium text-red-600 dark:text-red-400">
                {errors.bio}
              </span>
            ) : (
              <span />
            )}
            <span className="shrink-0 text-ink-muted tabular-nums">
              {normalizeBio(value.bio).length}/{PROFILE_LIMITS.bio}
            </span>
          </div>
        </div>
      </SectionForm>
    </SectionCard>
  );
}

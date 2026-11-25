"use client";

import { Field, Textarea } from "@/components/ui";
import { PROFILE_LIMITS } from "@/lib/constants";
import type { Technician } from "@/lib/types";
import { fichaLabel } from "../FichaNav";
import { SectionCard, SectionForm } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";

interface BioForm {
  bio: string;
}

const read = (t: Technician): BioForm => ({ bio: t.bio ?? "" });
const body = (v: BioForm) => ({ bio: v.bio.trim() || null });
const validate = (v: BioForm): SectionErrors =>
  v.bio.trim().length > PROFILE_LIMITS.bio ? { bio: `No máximo ${PROFILE_LIMITS.bio} caracteres.` } : {};

/** Mini biografia (opcional): a experiência e a atuação, em até 500 caracteres. */
export function BioSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const label = fichaLabel("mini-biografia");
  const form = useSectionForm({ tech, label, read, body, validate, savedTitle: "Mini biografia salva" });
  const { value, set, errors } = form;

  return (
    <SectionCard title={label}>
      <SectionForm form={form} canEdit={canEdit}>
        <div className="flex flex-col gap-1">
          <Field label={label} error={errors.bio}>
            <Textarea
              rows={5}
              value={value.bio}
              onChange={(e) => set("bio", e.target.value)}
              maxLength={PROFILE_LIMITS.bio}
              aria-invalid={errors.bio ? true : undefined}
            />
          </Field>
          <p className="self-end text-xs text-ink-muted tabular-nums">
            {value.bio.length}/{PROFILE_LIMITS.bio}
          </p>
        </div>
      </SectionForm>
    </SectionCard>
  );
}

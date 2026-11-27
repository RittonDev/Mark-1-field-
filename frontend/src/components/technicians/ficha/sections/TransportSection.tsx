"use client";

import { Checkbox, Field, Input } from "@/components/ui";
import { isValidPlate, normalizePlate, PROFILE_LIMITS, TRANSPORT_MODE, TRANSPORT_MODE_ORDER } from "@/lib/constants";
import { cleanText, isPreGestao, transportBody } from "@/lib/techProfileEdit";
import type { Technician, TransportMode } from "@/lib/types";
import { partStamp, ProfileUnavailable, profileInfo, TransportPart, vehicleText } from "../../TechProfileView";
import { fichaLabel } from "../FichaNav";
import { LegacyNote, SectionCard, SectionForm, SubTitle } from "../SectionCard";
import { type SectionErrors, useSectionForm } from "../useSectionForm";

interface TransportForm {
  modes: TransportMode[];
  driverLicense: boolean;
  model: string;
  plate: string;
}

const PLATE_MSG = "Placa inválida: confira as letras e os números.";

// O transporte nunca informado é lido como nenhum meio e sem CNH: sem mudança, não vai no corpo.
const read = (t: Technician): TransportForm => ({
  modes: transportBody(t.transport?.modes ?? [], false).modes,
  driverLicense: t.transport?.driver_license ?? false,
  model: t.vehicle_model ?? "",
  plate: normalizePlate(t.vehicle_plate ?? ""),
});

const body = (v: TransportForm) => ({
  transport: transportBody(v.modes, v.driverLicense),
  vehicle_model: cleanText(v.model) || null,
  vehicle_plate: normalizePlate(v.plate) || null,
});

function validate(v: TransportForm): SectionErrors {
  const plate = normalizePlate(v.plate);
  return plate && !isValidPlate(plate) ? { plate: PLATE_MSG } : {};
}

/**
 * Transporte: meios de transporte, CNH e o veículo (modelo e placa). Com Técnicos Editar e a API da Gestão, a central
 * muda (grava no Salvar, carimbo "pela central"); só com Visualizar, ou com a API de antes, como era.
 */
export function TransportSection({ tech, canEdit }: { tech: Technician; canEdit: boolean }) {
  const info = profileInfo(tech);
  if (canEdit && info && !isPreGestao(tech)) return <TransportEditor tech={tech} />;

  const vehicle = vehicleText(tech);
  const pre = isPreGestao(tech);
  return (
    <SectionCard title={fichaLabel("transporte")} aside={partStamp(info, "transport")}>
      {/* A API de antes da Gestão não grava o perfil pela central: só leitura, com o aviso para quem edita. */}
      {canEdit && pre && info ? <LegacyNote /> : null}
      {!info ? (
        <>
          <ProfileUnavailable />
          {vehicle ? <p className="text-sm text-ink">{vehicle}</p> : null}
        </>
      ) : !pre || info.informed.transport ? (
        <TransportPart tech={tech} withVehicle />
      ) : (
        <>
          <p className="text-sm text-ink-muted">O técnico preenche no app, em Configurações.</p>
          {vehicle ? <p className="text-sm text-ink">{vehicle}</p> : null}
        </>
      )}
    </SectionCard>
  );
}

function TransportEditor({ tech }: { tech: Technician }) {
  const label = fichaLabel("transporte");
  const info = profileInfo(tech);
  const form = useSectionForm({ tech, label, read, body, validate, savedTitle: "Transporte salvo" });
  const { value, set, errors } = form;

  return (
    <SectionCard title={label} aside={partStamp(info, "transport")}>
      <SectionForm form={form} canEdit>
        <fieldset className="flex min-w-0 flex-col gap-2.5">
          <legend className="mb-2.5">
            <SubTitle>Meios de transporte</SubTitle>
          </legend>
          <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {TRANSPORT_MODE_ORDER.map((mode) => (
              <Checkbox
                key={mode}
                label={TRANSPORT_MODE[mode]}
                checked={value.modes.includes(mode)}
                onChange={(on) =>
                  set("modes", transportBody(on ? [...value.modes, mode] : value.modes.filter((m) => m !== mode), false).modes)
                }
              />
            ))}
          </div>
        </fieldset>
        <Checkbox label="Tem CNH" checked={value.driverLicense} onChange={(on) => set("driverLicense", on)} />
        <div className="grid gap-4 border-t border-line pt-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field label="Modelo do veículo">
            <Input
              value={value.model}
              onChange={(e) => set("model", e.target.value)}
              maxLength={PROFILE_LIMITS.vehicleModel}
              autoComplete="off"
            />
          </Field>
          <Field label="Placa" error={errors.plate}>
            <Input
              value={value.plate}
              onChange={(e) => set("plate", normalizePlate(e.target.value))}
              autoComplete="off"
              autoCapitalize="characters"
              aria-invalid={errors.plate ? true : undefined}
            />
          </Field>
        </div>
      </SectionForm>
    </SectionCard>
  );
}

// Folha do veículo (Configurações › Transporte): modelo e placa, os dois opcionais e gravados juntos (vazio limpa). Placa
// antiga ou Mercosul, em maiúsculas e sem o hífen. Os erros aparecem depois de tocar em "Salvar"; o do servidor, no fim
// da folha. Quem grava é a tela.

import { useRef, useState } from "react";
import type { TextInputInstance } from "react-native";
import { normalizePlate, PROFILE_LIMITS } from "../../lib/constants";
import { haptic } from "../../lib/haptics";
import { reviewVehicle, vehicleDraftOf, type VehicleDraft } from "../../lib/profileForm";
import type { MyProfileUpdate } from "../../lib/types";
import { Field, Input } from "../ui";
import { FormSheet } from "./FormSheet";

export function VehicleSheet({
  visible,
  model,
  plate,
  onSubmit,
  onClose,
  onClosed,
}: {
  visible: boolean;
  /** O gravado. */
  model: string | null;
  plate: string | null;
  /** Grava. Devolve a mensagem de erro, ou null quando gravou (a tela fecha a folha). */
  onSubmit: (body: MyProfileUpdate) => Promise<string | null>;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [base] = useState(() => vehicleDraftOf(model, plate));
  const [draft, setDraft] = useState<VehicleDraft>(base);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plateRef = useRef<TextInputInstance>(null);

  const review = reviewVehicle(draft, { model, plate });
  const changed = Object.keys(review.body).length > 0;
  const shown = attempted ? review.errors : {};

  function update(patch: Partial<VehicleDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  }

  async function submit() {
    if (busy) return;
    setAttempted(true);
    setError(null);
    if (Object.keys(review.errors).length) {
      haptic.warning();
      return;
    }
    if (!changed) return;
    setBusy(true);
    const message = await onSubmit(review.body);
    setBusy(false);
    if (message) {
      haptic.warning();
      setError(message);
    }
  }

  return (
    <FormSheet
      visible={visible}
      title="Veículo"
      submitLabel="Salvar"
      onSubmit={() => void submit()}
      onClose={onClose}
      onClosed={onClosed}
      busy={busy}
      error={error}
      dirty={changed}
      submitDisabled={!changed}
    >
      <Field label="Modelo" error={shown.model}>
        <Input
          value={draft.model}
          onChangeText={(text) => update({ model: text })}
          maxLength={PROFILE_LIMITS.vehicleModel}
          autoCapitalize="words"
          autoFocus={!base.model && !base.plate}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => plateRef.current?.focus()}
          accessibilityLabel="Modelo do veículo"
        />
      </Field>
      <Field label="Placa" error={shown.plate}>
        <Input
          ref={plateRef}
          value={draft.plate}
          // Colar "abc-1234" vira "ABC1234" (normalizePlate corta em 7; o maxLength cortaria o colado antes de tirar o hífen).
          onChangeText={(text) => update({ plate: normalizePlate(text) })}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          accessibilityLabel="Placa do veículo"
        />
      </Field>
    </FormSheet>
  );
}

import { Pressable, StyleSheet, Text, View } from "react-native";
import { RESPONSIBILITY } from "../lib/constants";
import type { ViolationReason, ViolationScope } from "../lib/types";
import { colors, Field, Input, tint } from "./ui";

export interface ViolationValues {
  response: string;
  resolution: string;
  note: string;
}

function ReasonPicker({
  scope,
  label,
  value,
  onChange,
  reasons,
}: {
  scope: Exclude<ViolationScope, "both">;
  label: string;
  value: string;
  onChange: (value: string) => void;
  reasons: ViolationReason[];
}) {
  const options = reasons.filter((r) => r.applies_to === scope || r.applies_to === "both");
  const choices = [{ id: "", name: "Deixar para o analista justificar", responsibility: null }, ...options];
  return (
    <Field label={label}>
      <View style={styles.options} accessibilityRole="radiogroup">
        {choices.map((choice) => {
          const selected = value === choice.id;
          return (
            <Pressable
              key={choice.id || "none"}
              onPress={() => onChange(choice.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <View style={[styles.radio, selected && styles.radioSelected]} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.optionText, !choice.id && styles.optionMuted]}>{choice.name}</Text>
                {choice.responsibility ? (
                  <Text style={[styles.responsibility, { color: RESPONSIBILITY[choice.responsibility].color }]}>
                    Responsabilidade: {RESPONSIBILITY[choice.responsibility].label}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

/**
 * Motivo da violação por relógio de SLA, como o ViolationFields da web. Só mostra o relógio que furou.
 * No app é opcional: sem motivo, a OS fica "pendente de justificativa" e o analista completa na web.
 */
export function ViolationFields({
  responseBreached,
  resolutionBreached,
  values,
  onChange,
  reasons,
}: {
  responseBreached: boolean;
  resolutionBreached: boolean;
  values: ViolationValues;
  onChange: (values: ViolationValues) => void;
  reasons: ViolationReason[];
}) {
  if (!responseBreached && !resolutionBreached) return null;
  const clocks = [responseBreached && "1ª resposta", resolutionBreached && "solução"].filter(Boolean).join(" e ");
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Esta OS violou o prazo de {clocks}. Qual foi o motivo?</Text>
      <Text style={styles.hint}>Opcional. Sem motivo, o analista justifica depois pela web.</Text>
      {reasons.length === 0 ? (
        <Text style={styles.hint}>
          A lista de motivos ainda não foi baixada neste aparelho. Conecte-se para escolher, ou resolva e deixe a
          justificativa para o analista.
        </Text>
      ) : (
        <>
          {responseBreached ? (
            <ReasonPicker
              scope="response"
              label="Motivo — 1ª resposta"
              value={values.response}
              onChange={(response) => onChange({ ...values, response })}
              reasons={reasons}
            />
          ) : null}
          {resolutionBreached ? (
            <ReasonPicker
              scope="resolution"
              label="Motivo — solução"
              value={values.resolution}
              onChange={(resolution) => onChange({ ...values, resolution })}
              reasons={reasons}
            />
          ) : null}
        </>
      )}
      <Field label="Detalhe (opcional)">
        <Input
          value={values.note}
          onChangeText={(note) => onChange({ ...values, note })}
          multiline
          placeholder="O que aconteceu?"
        />
      </Field>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tint(colors.danger, "44"),
    backgroundColor: tint(colors.danger, "0d"),
  },
  title: { fontSize: 14, fontWeight: "700", color: colors.danger },
  hint: { fontSize: 12, color: colors.inkMuted },
  options: { gap: 6 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  optionSelected: { borderColor: colors.brand, backgroundColor: "#eff6ff" },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: "#94a3b8" },
  radioSelected: { borderColor: colors.brand, backgroundColor: colors.brand },
  optionText: { fontSize: 14, color: colors.ink },
  optionMuted: { color: colors.inkMuted, fontStyle: "italic" },
  responsibility: { fontSize: 12, marginTop: 2 },
});

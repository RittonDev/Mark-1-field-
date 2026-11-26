// Configurações › Dados pessoais: nome completo (vai para os textos do grupo do cliente, o relatório e o portal), CPF (o
// técnico informa uma vez; depois, só a central corrige), RG (número, órgão emissor e UF, os três juntos) e nascimento.
// Não pede senha; antes de gravar o CPF, a tela pede para conferir os números. A central é avisada. Só online, como todo
// o cadastro; com a API de antes do cadastro V2, "Indisponível no momento".

import { router } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, View, type TextInputInstance } from "react-native";
import { DateField } from "../../components/forms/DateField";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Text } from "../../components/Text";
import { Field, Input } from "../../components/ui";
import { normalizeIssuer, normalizeRg } from "../../lib/constants";
import { maskCpf } from "../../lib/masks";
import { hasCadastroV2 } from "../../lib/profile";
import { birthLimits, PERSONAL_SECTION, todayIso } from "../../lib/profileForm";
import { useProfileForm } from "../../lib/useProfileForm";
import { useStyles, type Palette } from "../../theme/theme";

export default function PersonalDataScreen() {
  const styles = useStyles(makeStyles);
  const state = useProfileForm(PERSONAL_SECTION);
  const { base, errors, update, saving } = state;
  // Os limites do seletor do nascimento, pelo dia em que a tela abriu.
  const [limits] = useState(() => birthLimits(todayIso()));
  const cpfRef = useRef<TextInputInstance>(null);
  const rgRef = useRef<TextInputInstance>(null);
  const issuerRef = useRef<TextInputInstance>(null);
  const rgStateRef = useRef<TextInputInstance>(null);

  if (state.profile && !hasCadastroV2(state.profile)) return <CadastroUnavailable onRetry={state.retry} />;

  return (
    <ProfileFormScreen state={state}>
      {(form) => (
        <>
          <FormCard>
            <Field label="Nome completo" required error={errors.name}>
              <Input
                value={form.name}
                onChangeText={(name) => update({ name })}
                accessibilityLabel="Nome completo"
                autoCapitalize="words"
                autoComplete="name"
                textContentType="name"
                maxLength={160}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => (base?.cpfLocked ? rgRef : cpfRef).current?.focus()}
              />
            </Field>
            {base?.cpfLocked ? (
              // O gravado, só leitura: quem corrige é a central.
              <Field label="CPF" hint="Para corrigir, fale com a central.">
                <Input value={base.cpf} editable={false} accessibilityLabel="CPF" style={styles.readOnly} />
              </Field>
            ) : (
              <Field label="CPF" error={errors.cpf}>
                <Input
                  ref={cpfRef}
                  value={form.cpf}
                  onChangeText={(text) => update({ cpf: maskCpf(text) })}
                  accessibilityLabel="CPF"
                  keyboardType="number-pad"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => rgRef.current?.focus()}
                />
              </Field>
            )}
            <Field label="RG" error={errors.rgNumber}>
              <Input
                ref={rgRef}
                value={form.rgNumber}
                onChangeText={(text) => update({ rgNumber: normalizeRg(text) })}
                accessibilityLabel="Número do RG"
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => issuerRef.current?.focus()}
              />
            </Field>
            <View style={styles.row}>
              <View style={styles.grow}>
                <Field label="Órgão emissor" error={errors.rgIssuer}>
                  <Input
                    ref={issuerRef}
                    value={form.rgIssuer}
                    onChangeText={(text) => update({ rgIssuer: normalizeIssuer(text) })}
                    accessibilityLabel="Órgão emissor do RG"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    autoComplete="off"
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => rgStateRef.current?.focus()}
                  />
                </Field>
              </View>
              <View style={styles.uf}>
                <Field label="UF" error={errors.rgState}>
                  <Input
                    ref={rgStateRef}
                    value={form.rgState}
                    onChangeText={(text) => update({ rgState: text.replace(/[^A-Za-z]/g, "").toUpperCase() })}
                    accessibilityLabel="UF do RG"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    autoComplete="off"
                    maxLength={2}
                    returnKeyType="done"
                  />
                </Field>
              </View>
            </View>
            <Field label="Data de nascimento" hint="É preciso ter 18 anos ou mais." error={errors.birthDate}>
              <DateField
                value={form.birthDate}
                onChange={(birthDate) => update({ birthDate })}
                label="Data de nascimento"
                min={limits.min}
                max={limits.max}
                initial={limits.initial}
                todayShortcut={false}
              />
            </Field>
          </FormCard>
          <Pressable
            // Salvando, não sai da tela: ao terminar, o "voltar" fecharia o aviso em vez dos dados pessoais.
            onPress={() => router.push("/privacidade")}
            disabled={saving}
            hitSlop={14}
            accessibilityRole="link"
            accessibilityState={{ disabled: saving }}
            style={({ pressed }) => [styles.privacy, (pressed || saving) && styles.linkPressed]}
          >
            <Text style={styles.link}>Aviso de privacidade</Text>
          </Pressable>
        </>
      )}
    </ProfileFormScreen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    // Órgão emissor e UF lado a lado; com a fonte grande, a UF desce para baixo.
    row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 12 },
    grow: { flexGrow: 1, flexBasis: 160 },
    uf: { width: 84 },
    readOnly: { color: c.inkMuted },
    privacy: { alignSelf: "flex-start" },
    link: { fontSize: 13, fontWeight: "600", color: c.brandInk },
    linkPressed: { opacity: 0.6 },
  });

// Configurações › Endereço: CEP, logradouro, número, complemento, bairro, cidade e UF (obrigatórias só aqui) e a região
// que atende. O CEP de 8 números busca o endereço (lib/cep.ts) e preenche o que está livre (vazio, igual ao gravado ou
// posto pela busca anterior: a regra dos 6 lugares, cepPatch); o CEP geral (sem logradouro) esvazia o logradouro e o
// bairro que ainda são da busca anterior; logradouro trocado de fato (outra grafia não conta) esvazia o número e o
// complemento que a pessoa não mexeu, e o foco vai para o Número. O que ela digitou fica e, se difere, aparece "CEP de
// {resumo}." com "Usar este endereço". Não achou ou sem o serviço: só o aviso; nada trava o Salvar. Não pede senha; a
// central é avisada. Só online, como todo o cadastro; com a API de antes do cadastro V2, "Indisponível no momento".

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type TextInputInstance } from "react-native";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Text } from "../../components/Text";
import { Field, Input } from "../../components/ui";
import { lookupCep } from "../../lib/cep";
import { CEP_TEXT, cepSummary, PROFILE_LIMITS, type CepSlots } from "../../lib/constants";
import { maskCep, onlyDigits } from "../../lib/masks";
import { hasCadastroV2 } from "../../lib/profile";
import { ADDRESS_SECTION, addressSlots, cepDiffers, cepPatch, type AddressForm } from "../../lib/profileForm";
import type { CepAddress } from "../../lib/types";
import { useProfileForm } from "../../lib/useProfileForm";
import { useStyles, useTheme, type Palette } from "../../theme/theme";

/** A busca do CEP que está no campo. */
type CepLookup =
  | { digits: string; status: "loading" | "not_found" | "unavailable" }
  | { digits: string; status: "found"; address: CepAddress };

const SLOT_KEYS = ["street", "district", "city", "state"] as const;

export default function AddressScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const state = useProfileForm(ADDRESS_SECTION);
  const { form, base, errors, update } = state;
  const [cep, setCep] = useState<CepLookup | null>(null);
  // O formulário e o gravado de agora, para a resposta da busca que chega depois (a pessoa pode ter mexido no meio).
  const latest = useRef<{ form: AddressForm | null; base: AddressForm | null }>({ form, base });
  useEffect(() => {
    latest.current = { form, base };
  });
  // Os valores que a busca pôs: o campo que continua com eles está livre para a próxima busca (o `auto` de cepFill).
  const applied = useRef<Partial<CepSlots>>({});
  // O CEP digitado por último: a resposta de outro CEP é ignorada.
  const typed = useRef("");
  const cepRef = useRef<TextInputInstance>(null);
  const streetRef = useRef<TextInputInstance>(null);
  const numberRef = useRef<TextInputInstance>(null);
  const complementRef = useRef<TextInputInstance>(null);
  const districtRef = useRef<TextInputInstance>(null);
  const cityRef = useRef<TextInputInstance>(null);
  const ufRef = useRef<TextInputInstance>(null);
  const coverageRef = useRef<TextInputInstance>(null);

  if (state.profile && !hasCadastroV2(state.profile)) return <CadastroUnavailable onRetry={state.retry} />;

  /** O CEP achado sobre a tela; `use`: "Usar este endereço". Ainda no CEP (ou pediu), o foco segue para o próximo campo. */
  function applyCep(address: CepAddress, use: boolean) {
    const { form: current, base: saved } = latest.current;
    if (!current || !saved) return;
    const slots = addressSlots(current);
    const auto = new Set(SLOT_KEYS.filter((key) => applied.current[key] !== undefined && slots[key] === applied.current[key]));
    const result = cepPatch(current, saved, auto, address, use);
    applied.current = { ...applied.current, ...result.filled };
    if (Object.keys(result.patch).length) update(result.patch);
    if (use || cepRef.current?.isFocused()) (result.focus === "street" ? streetRef : numberRef).current?.focus();
  }

  function changeCep(text: string) {
    const masked = maskCep(text);
    const digits = onlyDigits(masked);
    update({ zip: masked });
    typed.current = digits;
    if (digits.length !== 8) return;
    // Uma busca por CEP: o mesmo de novo não sai (só depois de "indisponível", que pode ter sido a rede).
    if (cep && cep.digits === digits && cep.status !== "unavailable") return;
    setCep({ digits, status: "loading" });
    void lookupCep(digits).then((outcome) => {
      if (typed.current !== digits) return;
      if (outcome.status === "found") {
        setCep({ digits, status: "found", address: outcome.address });
        applyCep(outcome.address, false);
      } else {
        setCep({ digits, status: outcome.status });
      }
    });
  }

  return (
    <ProfileFormScreen state={state}>
      {(shown) => {
        // A busca do CEP que está no campo (apagou um número: o aviso some até completar de novo).
        const lookup = cep && cep.digits === onlyDigits(shown.zip) ? cep : null;
        const found = lookup?.status === "found" ? lookup.address : null;
        const conflict = found && cepDiffers(shown, found) ? found : null;
        const status =
          lookup?.status === "loading"
            ? CEP_TEXT.searching
            : lookup?.status === "not_found"
              ? CEP_TEXT.notFound
              : lookup?.status === "unavailable"
                ? CEP_TEXT.unavailable
                : null;
        return (
          <FormCard>
            <View style={styles.cep}>
              <Field label="CEP" error={errors.zip}>
                <Input
                  ref={cepRef}
                  value={shown.zip}
                  onChangeText={changeCep}
                  accessibilityLabel="CEP"
                  keyboardType="number-pad"
                  autoComplete="postal-code"
                  textContentType="postalCode"
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => streetRef.current?.focus()}
                  // Sempre um `right` (vazio fora da busca): trocar a forma do campo no meio da digitação tiraria o foco.
                  right={
                    <View style={styles.spinner}>
                      {lookup?.status === "loading" ? <ActivityIndicator size="small" color={c.inkMuted} /> : null}
                    </View>
                  }
                />
              </Field>
              <View accessibilityLiveRegion="polite">
                {status ? <Text style={styles.cepText}>{status}</Text> : null}
                {conflict ? (
                  <View style={styles.conflict}>
                    <Text style={styles.cepText}>{`CEP de ${cepSummary(conflict)}.`}</Text>
                    <Pressable
                      onPress={() => applyCep(conflict, true)}
                      hitSlop={8}
                      accessibilityRole="button"
                      style={({ pressed }) => [styles.use, pressed && styles.pressed]}
                    >
                      <Text style={styles.useText}>{CEP_TEXT.use}</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            </View>
            <Field label="Logradouro" error={errors.street}>
              <Input
                ref={streetRef}
                value={shown.street}
                onChangeText={(street) => update({ street })}
                accessibilityLabel="Logradouro"
                autoCapitalize="words"
                autoComplete="address-line1"
                textContentType="streetAddressLine1"
                maxLength={255}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => numberRef.current?.focus()}
              />
            </Field>
            <View style={styles.row}>
              <View style={styles.number}>
                <Field label="Número" error={errors.number}>
                  <Input
                    ref={numberRef}
                    value={shown.number}
                    onChangeText={(number) => update({ number })}
                    accessibilityLabel="Número"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={PROFILE_LIMITS.addressNumber}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => complementRef.current?.focus()}
                  />
                </Field>
              </View>
              <View style={styles.grow}>
                <Field label="Complemento" error={errors.complement}>
                  <Input
                    ref={complementRef}
                    value={shown.complement}
                    onChangeText={(complement) => update({ complement })}
                    accessibilityLabel="Complemento"
                    autoComplete="address-line2"
                    textContentType="streetAddressLine2"
                    maxLength={PROFILE_LIMITS.addressComplement}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => districtRef.current?.focus()}
                  />
                </Field>
              </View>
            </View>
            <Field label="Bairro" error={errors.district}>
              <Input
                ref={districtRef}
                value={shown.district}
                onChangeText={(district) => update({ district })}
                accessibilityLabel="Bairro"
                autoCapitalize="words"
                maxLength={120}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => cityRef.current?.focus()}
              />
            </Field>
            <View style={styles.row}>
              <View style={styles.grow}>
                <Field label="Cidade" required error={errors.city}>
                  <Input
                    ref={cityRef}
                    value={shown.city}
                    onChangeText={(city) => update({ city })}
                    accessibilityLabel="Cidade"
                    autoCapitalize="words"
                    textContentType="addressCity"
                    maxLength={120}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => ufRef.current?.focus()}
                  />
                </Field>
              </View>
              <View style={styles.uf}>
                <Field label="UF" required error={errors.uf}>
                  <Input
                    ref={ufRef}
                    value={shown.uf}
                    onChangeText={(text) => update({ uf: text.replace(/[^A-Za-z]/g, "").toUpperCase() })}
                    accessibilityLabel="UF"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    textContentType="addressState"
                    maxLength={2}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => coverageRef.current?.focus()}
                  />
                </Field>
              </View>
            </View>
            <Field label="Região que atende" error={errors.coverage}>
              <Input
                ref={coverageRef}
                value={shown.coverage}
                onChangeText={(coverage) => update({ coverage })}
                accessibilityLabel="Região que atende"
                multiline
                maxLength={1000}
              />
            </Field>
          </FormCard>
        );
      }}
    </ProfileFormScreen>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    cep: { gap: 6 },
    spinner: { width: 20, alignItems: "center", justifyContent: "center" },
    cepText: { fontSize: 12, lineHeight: 17, color: c.inkMuted },
    conflict: { gap: 2 },
    use: { alignSelf: "flex-start", minHeight: 36, justifyContent: "center" },
    useText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    pressed: { opacity: 0.6 },
    // Lado a lado; com a fonte grande, o segundo campo desce para baixo do primeiro.
    row: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 12 },
    grow: { flexGrow: 1, flexBasis: 160 },
    number: { width: 110 },
    uf: { width: 84 },
  });

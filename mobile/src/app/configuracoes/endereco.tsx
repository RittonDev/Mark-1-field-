// Configurações › Endereço: CEP, endereço, bairro, cidade e UF (obrigatórias só aqui) e a região que atende. Não pede
// senha; a central é avisada. Só online, como todo o cadastro.

import { useRef } from "react";
import { StyleSheet, View, type TextInputInstance } from "react-native";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Field, Input } from "../../components/ui";
import { maskCep } from "../../lib/masks";
import { ADDRESS_SECTION } from "../../lib/profileForm";
import { useProfileForm } from "../../lib/useProfileForm";

export default function AddressScreen() {
  const state = useProfileForm(ADDRESS_SECTION);
  const { errors, update } = state;
  const addressRef = useRef<TextInputInstance>(null);
  const districtRef = useRef<TextInputInstance>(null);
  const cityRef = useRef<TextInputInstance>(null);
  const ufRef = useRef<TextInputInstance>(null);
  const coverageRef = useRef<TextInputInstance>(null);
  return (
    <ProfileFormScreen state={state}>
      {(form) => (
        <FormCard>
          <Field label="CEP" error={errors.zip}>
            <Input
              value={form.zip}
              onChangeText={(text) => update({ zip: maskCep(text) })}
              accessibilityLabel="CEP"
              keyboardType="number-pad"
              autoComplete="postal-code"
              textContentType="postalCode"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => addressRef.current?.focus()}
            />
          </Field>
          <Field label="Endereço (rua, número e complemento)" error={errors.addressLine}>
            <Input
              ref={addressRef}
              value={form.addressLine}
              onChangeText={(addressLine) => update({ addressLine })}
              accessibilityLabel="Endereço: rua, número e complemento"
              autoComplete="street-address"
              textContentType="fullStreetAddress"
              maxLength={255}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => districtRef.current?.focus()}
            />
          </Field>
          <Field label="Bairro" error={errors.district}>
            <Input
              ref={districtRef}
              value={form.district}
              onChangeText={(district) => update({ district })}
              accessibilityLabel="Bairro"
              autoCapitalize="words"
              maxLength={120}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => cityRef.current?.focus()}
            />
          </Field>
          <View style={styles.cityRow}>
            <View style={styles.cityField}>
              <Field label="Cidade" required error={errors.city}>
                <Input
                  ref={cityRef}
                  value={form.city}
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
            <View style={styles.ufField}>
              <Field label="UF" required error={errors.uf}>
                <Input
                  ref={ufRef}
                  value={form.uf}
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
              value={form.coverage}
              onChangeText={(coverage) => update({ coverage })}
              accessibilityLabel="Região que atende"
              multiline
              maxLength={1000}
            />
          </Field>
        </FormCard>
      )}
    </ProfileFormScreen>
  );
}

const styles = StyleSheet.create({
  cityRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  cityField: { flex: 1 },
  ufField: { width: 84 },
});

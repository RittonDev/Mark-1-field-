// Configurações › Mini biografia: um texto curto e opcional sobre a experiência e a atuação do técnico, que a central vê
// na ficha dele. Até 500 caracteres (o contador conta como o servidor); vazio apaga. Não pede senha; a central é avisada.
// Só online, como todo o cadastro; com a API de antes do cadastro V2, "Indisponível no momento".

import { StyleSheet } from "react-native";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Field, Input } from "../../components/ui";
import { PROFILE_LIMITS } from "../../lib/constants";
import { hasCadastroV2 } from "../../lib/profile";
import { BIO_SECTION, bioCount } from "../../lib/profileForm";
import { useProfileForm } from "../../lib/useProfileForm";

export default function BioScreen() {
  const state = useProfileForm(BIO_SECTION);

  if (state.profile && !hasCadastroV2(state.profile)) return <CadastroUnavailable onRetry={state.retry} />;

  return (
    <ProfileFormScreen state={state}>
      {(form) => (
        <FormCard>
          <Field label="Mini biografia" hint={bioCount(form.bio)} error={state.errors.bio}>
            <Input
              value={form.bio}
              onChangeText={(bio) => state.update({ bio })}
              accessibilityLabel="Mini biografia"
              accessibilityHint={`Até ${PROFILE_LIMITS.bio} caracteres`}
              multiline
              autoCapitalize="sentences"
              maxLength={PROFILE_LIMITS.bio}
              style={styles.bio}
            />
          </Field>
        </FormCard>
      )}
    </ProfileFormScreen>
  );
}

const styles = StyleSheet.create({
  bio: { minHeight: 120 },
});

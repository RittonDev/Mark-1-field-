// Configurações › Dados pessoais: o nome completo (vai para os textos do grupo do cliente, o relatório e o portal). Não
// pede senha; a central é avisada da mudança. Só online, como todo o cadastro.

import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Field, Input } from "../../components/ui";
import { NAME_SECTION } from "../../lib/profileForm";
import { useProfileForm } from "../../lib/useProfileForm";

export default function PersonalDataScreen() {
  const state = useProfileForm(NAME_SECTION);
  return (
    <ProfileFormScreen state={state}>
      {(form) => (
        <FormCard>
          <Field label="Nome completo" required error={state.errors.name}>
            <Input
              value={form.name}
              onChangeText={(name) => state.update({ name })}
              accessibilityLabel="Nome completo"
              autoCapitalize="words"
              autoComplete="name"
              textContentType="name"
              maxLength={160}
              returnKeyType="done"
              onSubmitEditing={() => void state.save()}
            />
          </Field>
        </FormCard>
      )}
    </ProfileFormScreen>
  );
}

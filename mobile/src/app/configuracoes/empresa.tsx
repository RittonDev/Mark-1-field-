// Configurações › Dados empresariais: CNPJ (aceita o alfanumérico), razão social e nome fantasia, os três opcionais e
// gravados juntos; razão social ou nome fantasia pedem o CNPJ. Mudar pede a senha atual (conta invadida não troca a
// empresa que recebe), e a central é avisada. Só online, como todo o cadastro; com a API de antes do cadastro V2,
// "Indisponível no momento".

import { useRef } from "react";
import type { TextInputInstance } from "react-native";
import { CadastroUnavailable } from "../../components/settings/CadastroUnavailable";
import { FormCard, ProfileFormScreen } from "../../components/settings/ProfileFormScreen";
import { Field, Input } from "../../components/ui";
import { PROFILE_LIMITS } from "../../lib/constants";
import { maskCnpj } from "../../lib/masks";
import { hasCadastroV2 } from "../../lib/profile";
import { COMPANY_SECTION } from "../../lib/profileForm";
import { useProfileForm } from "../../lib/useProfileForm";

export default function CompanyScreen() {
  const state = useProfileForm(COMPANY_SECTION);
  const { errors, update } = state;
  const nameRef = useRef<TextInputInstance>(null);
  const tradeNameRef = useRef<TextInputInstance>(null);

  if (state.profile && !hasCadastroV2(state.profile)) return <CadastroUnavailable onRetry={state.retry} />;

  return (
    <ProfileFormScreen state={state}>
      {(form) => (
        <FormCard>
          <Field label="CNPJ" error={errors.cnpj}>
            <Input
              value={form.cnpj}
              onChangeText={(text) => update({ cnpj: maskCnpj(text) })}
              accessibilityLabel="CNPJ"
              // CNPJ alfanumérico: o teclado padrão, em maiúsculas.
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => nameRef.current?.focus()}
            />
          </Field>
          <Field label="Razão social" error={errors.name}>
            <Input
              ref={nameRef}
              value={form.name}
              onChangeText={(name) => update({ name })}
              accessibilityLabel="Razão social"
              autoCapitalize="words"
              autoComplete="organization"
              textContentType="organizationName"
              maxLength={PROFILE_LIMITS.companyName}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => tradeNameRef.current?.focus()}
            />
          </Field>
          <Field label="Nome fantasia" error={errors.tradeName}>
            <Input
              ref={tradeNameRef}
              value={form.tradeName}
              onChangeText={(tradeName) => update({ tradeName })}
              accessibilityLabel="Nome fantasia"
              autoCapitalize="words"
              maxLength={PROFILE_LIMITS.companyName}
              returnKeyType="done"
              onSubmitEditing={() => void state.save()}
            />
          </Field>
        </FormCard>
      )}
    </ProfileFormScreen>
  );
}

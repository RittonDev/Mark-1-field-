// Moldura dos formulários do cadastro em Configurações (Dados pessoais, Endereço, Contato, Mini biografia e Dados
// empresariais): sem o cadastro na memória, o ProfileGate; com ele, o aviso de sem internet, o aviso de dados velhos (a
// releitura falhou), os campos da tela (puxar para atualizar relê sem apagar o que foi digitado), o rodapé fixo "Salvar"
// com o primeiro erro e a folha da senha. O estado vem de useProfileForm.

import { HeaderHeightContext } from "expo-router/react-navigation";
import { useContext, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet } from "react-native";
import type { ProfileFormState } from "../../lib/useProfileForm";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Button, Card, ErrorBox, InfoBox } from "../ui";
import { FixedFooter } from "./FixedFooter";
import { OfflineNotice } from "./OfflineNotice";
import { PasswordSheet } from "./PasswordSheet";
import { ProfileGate } from "./ProfileGate";

/** O cartão dos campos de uma tela do cadastro. */
export function FormCard({ children }: { children: ReactNode }) {
  return <Card style={cardStyle.card}>{children}</Card>;
}

const cardStyle = StyleSheet.create({ card: { gap: 12 } });

export function ProfileFormScreen<F extends object, K extends string>({
  state,
  children,
}: {
  state: ProfileFormState<F, K>;
  /** Os campos, com o formulário já montado. */
  children: (form: F) => ReactNode;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  // O teclado sobe a partir do cabeçalho.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const { profile, form, load, sheet } = state;

  if (!profile || !form) {
    return <ProfileGate load={load.status === "error" ? load : { status: "loading" }} onRetry={state.retry} />;
  }

  // Abriu com o cadastro da memória e a releitura falhou por erro do servidor (sem rede, o OfflineNotice já avisa).
  const stale = load.status === "error" && !load.offline;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={state.refresh} colors={[c.primary]} tintColor={c.primary} />}
      >
        <OfflineNotice />
        {stale ? <InfoBox message="Não foi possível atualizar agora. Os dados podem estar desatualizados." /> : null}
        {children(form)}
      </ScrollView>

      <FixedFooter>
        {state.footerError ? <ErrorBox message={state.footerError} /> : null}
        <Button
          title="Salvar"
          variant="primary"
          onPress={() => void state.save()}
          loading={state.saving && !sheet?.visible}
          disabled={!state.dirty || state.saving}
        />
      </FixedFooter>

      {sheet ? <PasswordSheet {...sheet} /> : null}
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    content: { padding: 16, gap: 14 },
  });

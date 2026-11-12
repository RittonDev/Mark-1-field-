import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../components/Brand";
import { Button, Card, ErrorBox, Field, Input } from "../components/ui";
import { changePassword } from "../lib/account";
import { errorMessage } from "../lib/api";
import { logout } from "../lib/auth";
import { useSession } from "../lib/session";
import { showToast } from "../lib/toast";
import { useStyles, type Palette } from "../theme/theme";

const MIN_LENGTH = 8;

/** Primeiro acesso: o técnico troca a senha provisória antes de usar o app. */
export default function ChangePasswordScreen() {
  const { user } = useSession();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    if (!current) return setError("Informe a senha atual (a provisória que você recebeu).");
    if (next.length < MIN_LENGTH) return setError(`A nova senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`);
    if (next === current) return setError("A nova senha precisa ser diferente da atual.");
    if (next !== confirm) return setError("A confirmação não confere com a nova senha.");
    setSaving(true);
    try {
      await changePassword(current, next);
      showToast("Senha alterada", { tone: "success" });
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <BrandLogo />
        <Card style={{ gap: 16 }}>
          <View style={{ gap: 4 }}>
            <Text style={styles.title}>Crie sua senha</Text>
            <Text style={styles.lead}>
              {user?.name ? `${user.name.split(" ")[0]}, este` : "Este"} é seu primeiro acesso. Troque a senha provisória
              por uma só sua antes de continuar.
            </Text>
          </View>
          <Field label="Senha atual (provisória)">
            <Input value={current} onChangeText={setCurrent} secureTextEntry autoComplete="password" textContentType="password" />
          </Field>
          <Field label="Nova senha" hint={`Pelo menos ${MIN_LENGTH} caracteres.`}>
            <Input value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
          </Field>
          <Field label="Confirme a nova senha">
            <Input
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoComplete="new-password"
              textContentType="newPassword"
              onSubmitEditing={submit}
            />
          </Field>
          {error ? <ErrorBox message={error} /> : null}
          <Button title="Salvar e continuar" variant="primary" onPress={submit} loading={saving} />
        </Card>
        <Button compact variant="ghost" title="Sair" onPress={() => void logout()} style={{ alignSelf: "center" }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    container: { paddingHorizontal: 20, gap: 24, flexGrow: 1, maxWidth: 480, width: "100%", alignSelf: "center" },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    lead: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
  });

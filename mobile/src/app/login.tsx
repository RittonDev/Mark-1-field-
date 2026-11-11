import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, colors, ErrorBox, Field, Input } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { login } from "../lib/auth";
import { APP_VERSION, normalizeApiUrl } from "../lib/config";
import { session, useSession } from "../lib/session";

export default function LoginScreen() {
  const { expired } = useSession();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState(() => session.get().lastEmail ?? "");
  const [password, setPassword] = useState("");
  const [apiUrl, setApiUrl] = useState(() => session.get().apiUrl);
  const [editingServer, setEditingServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!email.trim() || !password) {
      setError("Informe e-mail e senha.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(email, password, apiUrl);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        setError(
          `Não foi possível falar com ${normalizeApiUrl(apiUrl)}. Confira o endereço do servidor e se o celular está na mesma rede Wi-Fi.`,
        );
        setEditingServer(true);
      } else {
        setError(errorMessage(e));
      }
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <Text style={styles.logo}>MaxxChamados</Text>
          <Text style={styles.subtitle}>App do técnico de campo</Text>
        </View>

        <Card style={{ gap: 16 }}>
          {expired ? <ErrorBox message="Sua sessão expirou. Entre novamente; o que estava pendente no aparelho será enviado." /> : null}
          <Field label="E-mail">
            <Input
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="username"
              placeholder="voce@empresa.com.br"
              returnKeyType="next"
            />
          </Field>
          <Field label="Senha">
            <Input
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={submit}
            />
          </Field>

          {editingServer ? (
            <Field label="Servidor da API" hint="IP da máquina com a API na mesma rede, ex.: 192.168.0.10:8000">
              <Input
                value={apiUrl}
                onChangeText={setApiUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </Field>
          ) : (
            <View style={styles.server}>
              <Text style={styles.serverText} numberOfLines={1}>
                Servidor: {apiUrl}
              </Text>
              <Button compact variant="ghost" title="Alterar" onPress={() => setEditingServer(true)} />
            </View>
          )}

          {error ? <ErrorBox message={error} /> : null}
          <Button title="Entrar" variant="primary" onPress={submit} loading={loading} />
        </Card>
        <Text style={styles.version}>Versão {APP_VERSION}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 20, gap: 24, flexGrow: 1 },
  brand: { alignItems: "center", gap: 4 },
  logo: { fontSize: 28, fontWeight: "800", color: colors.brand },
  subtitle: { fontSize: 15, color: colors.inkMuted },
  server: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  serverText: { fontSize: 12, color: colors.inkMuted, flex: 1 },
  version: { textAlign: "center", fontSize: 12, color: colors.inkMuted },
});

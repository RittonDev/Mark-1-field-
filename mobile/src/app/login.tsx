import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../components/Brand";
import { Button, Card, ErrorBox, Field, Input } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { login } from "../lib/auth";
import { APP_VERSION, normalizeApiUrl } from "../lib/config";
import { session, useSession } from "../lib/session";
import { useStyles, type Palette } from "../theme/theme";

export default function LoginScreen() {
  const { expired, notice } = useSession();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const banner =
    notice ?? (expired ? "Sua sessão expirou. Entre novamente; o que estava pendente no aparelho será enviado." : null);
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
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <BrandLogo size="lg" />
          <Text style={styles.subtitle}>Atendimento de campo</Text>
        </View>

        <Card style={{ gap: 16 }}>
          <View style={{ gap: 4 }}>
            <Text style={styles.title}>Entrar</Text>
            <Text style={styles.lead}>Use o e-mail e a senha do seu cadastro, ou a senha provisória enviada pela sua empresa.</Text>
          </View>
          {banner && !error ? <ErrorBox message={banner} /> : null}
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
              <Input value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            </Field>
          ) : null}

          {error ? <ErrorBox message={error} /> : null}
          <Button title="Entrar" variant="primary" onPress={submit} loading={loading} />
        </Card>

        <View style={styles.footer}>
          {!editingServer ? (
            <Button compact variant="ghost" title="Configurar servidor" onPress={() => setEditingServer(true)} />
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {apiUrl}
          </Text>
          <Text style={styles.meta}>Versão {APP_VERSION} · exclusivo para técnicos de campo</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    container: { paddingHorizontal: 20, gap: 28, flexGrow: 1, maxWidth: 480, width: "100%", alignSelf: "center" },
    brand: { gap: 10, paddingHorizontal: 4 },
    subtitle: { fontSize: 15, color: c.inkMuted },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    lead: { fontSize: 14, color: c.inkMuted, lineHeight: 20 },
    footer: { alignItems: "center", gap: 4 },
    meta: { fontSize: 12, color: c.inkSubtle, textAlign: "center" },
  });

import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../components/Brand";
import { Icon } from "../components/Icon";
import { RouteMapPattern } from "../components/RouteMapPattern";
import { Text } from "../components/Text";
import { Button, ErrorBox, Field, Input } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { login } from "../lib/auth";
import { APP_VERSION, normalizeApiUrl } from "../lib/config";
import { notify } from "../lib/dialogs";
import { session, useSession } from "../lib/session";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";

export default function LoginScreen() {
  const { expired, notice } = useSession();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const banner =
    notice ?? (expired ? "Sua sessão expirou. Entre novamente; o que estava pendente no aparelho será enviado." : null);
  const [email, setEmail] = useState(() => session.get().lastEmail ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [apiUrl, setApiUrl] = useState(() => session.get().apiUrl);
  const [editingServer, setEditingServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const enter = (i: number) => (reduced ? undefined : FadeInDown.delay(i * 60).duration(320));

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

  // Técnicos não redefinem a senha sozinhos: a central gera uma senha provisória.
  function forgot() {
    notify(
      "Esqueci minha senha",
      "Peça à central (analista ou supervisor) para redefinir sua senha. Você recebe uma senha provisória e cria uma nova no primeiro acesso.",
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <RouteMapPattern height={300 + insets.top} />
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View entering={enter(0)} style={styles.brand}>
          <BrandLogo size="lg" />
        </Animated.View>

        <Animated.View entering={enter(1)} style={styles.heading}>
          <Text style={styles.title}>Bem-vindo de volta</Text>
          <Text style={styles.lead}>Entre com o e-mail e a senha do seu cadastro de técnico.</Text>
        </Animated.View>

        <Animated.View entering={enter(2)} style={styles.form}>
          {banner && !error ? <ErrorBox message={banner} /> : null}
          <Field label="E-mail">
            <Input
              icon="mail"
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
              icon="lock"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoComplete="password"
              textContentType="password"
              placeholder="Sua senha"
              returnKeyType="go"
              onSubmitEditing={submit}
              right={
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  <Icon name={showPassword ? "eyeOff" : "eye"} size={18} color={c.inkSubtle} />
                </Pressable>
              }
            />
          </Field>

          {editingServer ? (
            <Field label="Servidor da API" hint="IP da máquina com a API na mesma rede, ex.: 192.168.0.10:8000">
              <Input value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            </Field>
          ) : null}

          {error ? <ErrorBox message={error} /> : null}
          <Button title="Entrar" variant="primary" onPress={submit} loading={loading} />
          <Pressable onPress={forgot} accessibilityRole="button" hitSlop={8} style={styles.forgot}>
            <Text style={styles.forgotText}>Esqueci minha senha</Text>
          </Pressable>
        </Animated.View>

        <View style={styles.footer}>
          {!editingServer ? (
            <Pressable onPress={() => setEditingServer(true)} accessibilityRole="button" hitSlop={8}>
              <Text style={styles.meta}>
                Servidor: <Text style={styles.metaStrong}>{apiUrl}</Text>
              </Text>
            </Pressable>
          ) : null}
          <Text style={styles.meta}>Versão {APP_VERSION} · exclusivo para técnicos de campo</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    container: { paddingHorizontal: 24, gap: 28, flexGrow: 1, maxWidth: 440, width: "100%", alignSelf: "center" },
    brand: { paddingTop: 24 },
    heading: { gap: 8, marginTop: 40 },
    title: { fontSize: 28, fontWeight: "700", color: c.ink, letterSpacing: -0.4 },
    lead: { fontSize: 15, color: c.inkMuted, lineHeight: 22 },
    form: {
      gap: 16,
      padding: 20,
      borderRadius: RADIUS.card,
      backgroundColor: c.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      boxShadow: c.elevation,
    },
    forgot: { alignSelf: "center", paddingVertical: 4 },
    forgotText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    footer: { alignItems: "center", gap: 6, marginTop: "auto" },
    meta: { fontSize: 12, color: c.inkSubtle, textAlign: "center" },
    metaStrong: { color: c.inkMuted, fontWeight: "600" },
  });

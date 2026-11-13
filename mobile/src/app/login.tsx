import NetInfo from "@react-native-community/netinfo";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, type TextInputInstance } from "react-native";
import Animated, { FadeInDown, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../components/Brand";
import { Icon } from "../components/Icon";
import { ENTER_OFFSET } from "../components/motion";
import { RouteMapPattern } from "../components/RouteMapPattern";
import { Text } from "../components/Text";
import { Button, ErrorBox, Field, InfoBox, Input } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { login } from "../lib/auth";
import { APP_VERSION, defaultApiUrl, normalizeApiUrl } from "../lib/config";
import { countPending } from "../lib/db";
import { confirmAction, notify } from "../lib/dialogs";
import { canEditServer, session, useSession } from "../lib/session";
import { RADIUS, useStyles, useTheme, type Palette } from "../theme/theme";

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
  const passwordRef = useRef<TextInputInstance>(null);
  const enter = (i: number) =>
    reduced
      ? undefined
      : FadeInDown.delay(i * 50)
          .duration(240)
          .withInitialValues({ opacity: 0, transform: [{ translateY: ENTER_OFFSET }] });

  /**
   * Outro técnico usou este aparelho e deixou itens sem enviar: entrar com outra conta apaga o que é
   * dele (login → wipeLocalData). Pergunta antes, em vez de apagar calado.
   */
  async function confirmOtherAccount(): Promise<boolean> {
    const previous = session.get().lastEmail;
    if (!previous || sameEmail(previous, email)) return true;
    const { ops, photos } = await countPending().catch(() => ({ ops: 0, photos: 0 }));
    const pending = ops + photos;
    if (!pending) return true;
    return confirmAction(
      "Apagar itens de outro técnico?",
      `Este aparelho tem ${pending === 1 ? "1 item não enviado" : `${pending} itens não enviados`} de outro técnico. Entrar com outra conta vai apagá-${pending === 1 ? "lo" : "los"}.`,
      { confirmText: "Entrar e apagar", destructive: true },
    );
  }

  async function submit() {
    // "Ir" no teclado duas vezes não manda dois logins.
    if (loading) return;
    if (!email.trim() || !password) {
      setError("Informe e-mail e senha.");
      return;
    }
    // No app publicado vale sempre o servidor configurado no build (mesmo que outro tenha ficado salvo).
    // Fora do desenvolvimento, servidor digitado à mão só com https: a senha não pode ir em texto aberto.
    const server = canEditServer ? normalizeApiUrl(apiUrl) : defaultApiUrl();
    if (!__DEV__ && server !== defaultApiUrl() && !/^https:\/\//i.test(server)) {
      setError("Use um endereço de servidor seguro, começando com https://.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Sem rede, avisa na hora em vez de esperar o tempo limite da requisição (20 s).
      const net = await NetInfo.fetch();
      if (net.isConnected === false) {
        setError("Sem internet. Conecte-se aos dados móveis ou a um Wi-Fi para entrar.");
        setLoading(false);
        return;
      }
      if (!(await confirmOtherAccount())) {
        setLoading(false);
        return;
      }
      await login(email, password, server);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        setError("Sem conexão com o servidor. Confira a internet do celular (dados móveis ou Wi-Fi) e tente de novo.");
        if (canEditServer) setEditingServer(true);
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
      "Peça à central (analista ou supervisor), no grupo de WhatsApp, para redefinir sua senha. Você recebe uma senha provisória e cria uma nova ao entrar.",
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <RouteMapPattern height={300 + insets.top} />
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        <Animated.View entering={enter(0)} style={styles.brand}>
          <BrandLogo size="lg" />
        </Animated.View>

        <Animated.View entering={enter(1)} style={styles.heading}>
          <Text style={styles.title} accessibilityRole="header">
            Entrar no Maxx Field
          </Text>
          <Text style={styles.lead}>Use o e-mail e a senha do seu cadastro de técnico.</Text>
        </Animated.View>

        <Animated.View entering={enter(2)} style={styles.form}>
          {banner && !error ? <InfoBox message={banner} /> : null}
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
              placeholder="seuemail@exemplo.com"
              accessibilityLabel="E-mail"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
          </Field>
          <Field label="Senha">
            <Input
              ref={passwordRef}
              icon="lock"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoComplete="current-password"
              textContentType="password"
              placeholder="Sua senha"
              accessibilityLabel="Senha"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              right={
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={14}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  <Icon name={showPassword ? "eyeOff" : "eye"} size={18} color={c.inkMuted} />
                </Pressable>
              }
            />
          </Field>

          {canEditServer && editingServer ? (
            <Field label="Servidor da API" hint="Desenvolvimento: endereço da API na rede local, ex.: 192.168.0.10:8000">
              <Input
                value={apiUrl}
                onChangeText={setApiUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                accessibilityLabel="Servidor da API"
              />
            </Field>
          ) : null}

          {error ? <ErrorBox message={error} /> : null}
          <Button title="Entrar" variant="primary" onPress={() => void submit()} loading={loading} />
          <Pressable onPress={forgot} accessibilityRole="button" hitSlop={4} style={styles.forgot}>
            <Text style={styles.forgotText}>Esqueci minha senha</Text>
          </Pressable>
        </Animated.View>

        <View style={styles.footer}>
          {canEditServer && !editingServer ? (
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
    container: { paddingHorizontal: 24, gap: 24, flexGrow: 1, maxWidth: 440, width: "100%", alignSelf: "center" },
    brand: { paddingTop: 24 },
    heading: { gap: 8, marginTop: 28 },
    title: { fontSize: 26, fontWeight: "700", color: c.ink, letterSpacing: -0.4 },
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
    forgot: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
    forgotText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    footer: { alignItems: "center", gap: 6, marginTop: "auto" },
    meta: { fontSize: 12, color: c.inkMuted, textAlign: "center" },
    metaStrong: { color: c.ink, fontWeight: "600" },
  });

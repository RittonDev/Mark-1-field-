// "Esqueci minha senha" (sem login, aberta pelo login): o técnico pede o link para criar uma senha nova. O link (2 h, uso
// único) vai para o e-mail validado e abre a página web "Definir nova senha"; trocada a senha, o servidor encerra as
// sessões. A resposta é a mesma exista ou não o cadastro, para ninguém descobrir quais e-mails estão no sistema. Com a
// API de antes (sem a rota) ou com o envio de e-mail desligado, a tela manda pedir à central pelo WhatsApp. O e-mail
// digitado no login (e o servidor, no desenvolvimento) chega pela memória (lib/forgotPassword.ts).

import { router } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { useContext, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon";
import { Text } from "../components/Text";
import { Button, Card, ErrorBox, Field, InfoBox, Input } from "../components/ui";
import { ApiError, errorMessage } from "../lib/api";
import { requestPasswordReset } from "../lib/auth";
import { defaultApiUrl, normalizeApiUrl } from "../lib/config";
import { FORGOT_MSG, forgotHandoff, forgotOutcome, forgotProblem, forgotSentText } from "../lib/forgotPassword";
import { haptic } from "../lib/haptics";
import { noNetwork } from "../lib/net";
import { canEditServer, session } from "../lib/session";
import { showToast } from "../lib/toast";
import { useStyles, useTheme, type Palette } from "../theme/theme";

/** O pedido (o formulário), o link enviado, ou o caminho pela central (a API de antes ou o envio desligado). */
type Phase = "form" | "sent" | "legacy" | "disabled";

const SERVER_DOWN = "Sem conexão com o servidor. Confira a internet do celular (dados móveis ou Wi-Fi) e tente de novo.";

export default function ForgotPasswordScreen() {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const [handoff] = useState(() => forgotHandoff.take());
  const [email, setEmail] = useState(handoff.email);
  const [phase, setPhase] = useState<Phase>("form");
  // O e-mail para onde o último pedido foi (o "Enviar de novo" usa o mesmo).
  const [sentTo, setSentTo] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const problem = forgotProblem(email);

  function backToLogin() {
    if (router.canGoBack()) router.back();
    else router.replace("/login");
  }

  /** O servidor pela regra do login: no app publicado, o do build; no desenvolvimento, o digitado no login. */
  function serverUrl(): { url: string } | { error: string } {
    const url = canEditServer ? normalizeApiUrl(handoff.server ?? session.get().apiUrl) : defaultApiUrl();
    if (!url) return { error: "Informe o endereço do servidor na tela de entrar." };
    if (!__DEV__ && url !== defaultApiUrl() && !/^https:\/\//i.test(url)) {
      return { error: "Use um endereço de servidor seguro, começando com https://." };
    }
    return { url };
  }

  async function send(target: string) {
    // Dois toques seguidos (ou o "Enviar" do teclado junto do botão) não mandam dois pedidos.
    if (sending.current) return;
    setError(null);
    const server = serverUrl();
    if ("error" in server) {
      setError(server.error);
      return;
    }
    sending.current = true;
    setBusy(true);
    try {
      if (await noNetwork()) {
        setError(FORGOT_MSG.offline);
        return;
      }
      await requestPasswordReset(target, server.url);
      haptic.success();
      // "Enviar de novo": a tela não muda, o aviso confirma o pedido.
      if (phase === "sent") showToast("Pedido enviado de novo", { tone: "success" });
      setSentTo(target);
      setPhase("sent");
    } catch (e) {
      const outcome = e instanceof ApiError ? forgotOutcome(e.status, e.code) : "error";
      if (outcome === "legacy" || outcome === "disabled") setPhase(outcome);
      else if (outcome === "offline") setError((await noNetwork()) ? FORGOT_MSG.offline : SERVER_DOWN);
      else setError(errorMessage(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function submit() {
    setAttempted(true);
    if (problem) return;
    void send(email.trim());
  }

  let content: ReactNode;
  if (phase === "sent") {
    content = (
      <Card style={styles.card}>
        <View style={styles.sentIcon}>
          <Icon name="mail" size={22} color={c.brandInk} />
        </View>
        <View style={styles.sentText}>
          <Text style={styles.title} accessibilityRole="header">
            {FORGOT_MSG.sentTitle}
          </Text>
          <Text style={styles.lead}>{forgotSentText(sentTo)}</Text>
          <Text style={styles.muted}>{FORGOT_MSG.spam}</Text>
        </View>
        {error ? <ErrorBox message={error} /> : null}
        <Button title="Voltar para o login" variant="primary" onPress={backToLogin} disabled={busy} />
        <Button title="Enviar de novo" variant="ghost" onPress={() => void send(sentTo)} loading={busy} />
      </Card>
    );
  } else if (phase === "legacy" || phase === "disabled") {
    content = (
      <Card style={styles.card}>
        <InfoBox message={phase === "legacy" ? FORGOT_MSG.legacy : FORGOT_MSG.disabled} />
        <Button title="Voltar para o login" variant="primary" onPress={backToLogin} />
      </Card>
    );
  } else {
    content = (
      <Card style={styles.card}>
        <Field label="E-mail" error={attempted ? problem : null}>
          <Input
            icon="mail"
            value={email}
            onChangeText={(text) => {
              setEmail(text.replace(/\s/g, ""));
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="email"
            textContentType="username"
            autoFocus={!handoff.email}
            accessibilityLabel="E-mail"
            returnKeyType="send"
            onSubmitEditing={submit}
          />
        </Field>
        {error ? <ErrorBox message={error} /> : null}
        <Button title="Enviar link" variant="primary" onPress={submit} loading={busy} />
      </Card>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        {content}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    container: { paddingHorizontal: 20, paddingTop: 20, gap: 24, flexGrow: 1, maxWidth: 480, width: "100%", alignSelf: "center" },
    card: { gap: 16 },
    sentIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primarySoft,
    },
    sentText: { gap: 8 },
    title: { fontSize: 20, fontWeight: "700", color: c.ink },
    lead: { fontSize: 15, lineHeight: 22, color: c.ink },
    muted: { fontSize: 14, lineHeight: 20, color: c.inkMuted },
  });

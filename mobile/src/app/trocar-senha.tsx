import { router } from "expo-router";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { useContext, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BrandLogo } from "../components/Brand";
import { Icon } from "../components/Icon";
import { Text } from "../components/Text";
import { Button, Card, ErrorBox, Field, Input } from "../components/ui";
import { changePassword, mustChangePassword } from "../lib/account";
import { errorMessage } from "../lib/api";
import { logout } from "../lib/auth";
import { useSession } from "../lib/session";
import { startSync, stopSync } from "../lib/sync";
import { showToast } from "../lib/toast";
import { useStyles, useTheme, type Palette } from "../theme/theme";

const MIN_LENGTH = 8;
const MISMATCH = "A confirmação não confere com a nova senha.";

/**
 * Troca de senha. Com senha provisória (primeiro acesso ou redefinida pela central) é a única tela do
 * app até trocar. Depois, o técnico troca quando quiser pela Conta (ex.: a senha vazou).
 */
export default function ChangePasswordScreen() {
  const { user, status } = useSession();
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // Com cabeçalho (troca pela Conta), o teclado sobe a partir dele.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  // Lido ao abrir: depois da troca o usuário deixa de ter senha provisória, mas a tela não muda de modo.
  const [forced] = useState(() => mustChangePassword(user));
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nextRef = useRef<TextInputInstance>(null);
  const confirmRef = useRef<TextInputInstance>(null);

  function problem(): string | null {
    if (!current) return forced ? "Informe a senha atual (a provisória que você recebeu)." : "Informe a senha atual.";
    if (next.length < MIN_LENGTH) return `A nova senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`;
    if (next === current) return "A nova senha precisa ser diferente da atual.";
    if (next !== confirm) return MISMATCH;
    return null;
  }

  async function submit() {
    // Dois "concluir" seguidos não mandam duas trocas (a segunda iria com a senha antiga).
    if (saving) return;
    const invalid = problem();
    setError(invalid);
    if (invalid) return;
    setSaving(true);
    // A troca encerra as outras sessões: o sync para durante ela, para nenhuma chamada sair com o token antigo.
    const pauseSync = !forced && status === "signedIn";
    if (pauseSync) stopSync();
    try {
      await changePassword(current, next);
      showToast("Senha alterada", { tone: "success", description: forced ? undefined : "Os outros aparelhos saíram da conta." });
      if (!forced && router.canGoBack()) router.back();
      else router.replace("/");
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    } finally {
      if (pauseSync) startSync();
    }
  }

  const toggle = (
    <Pressable
      onPress={() => setShow((v) => !v)}
      hitSlop={14}
      accessibilityRole="button"
      accessibilityLabel={show ? "Ocultar senhas" : "Mostrar senhas"}
    >
      <Icon name={show ? "eyeOff" : "eye"} size={18} color={c.inkMuted} />
    </Pressable>
  );

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingTop: forced ? insets.top + 48 : 20, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      >
        {forced ? <BrandLogo /> : null}
        <Card style={{ gap: 16 }}>
          <View style={{ gap: 4 }}>
            <Text style={styles.title} accessibilityRole="header">
              {forced ? "Crie sua senha" : "Escolha uma nova senha"}
            </Text>
            <Text style={styles.lead}>
              {forced
                ? `${user?.name ? `${user.name.split(" ")[0]}, você` : "Você"} entrou com uma senha provisória. Crie uma senha só sua para continuar.`
                : "Ao trocar, os outros aparelhos saem da conta. Neste celular você continua conectado."}
            </Text>
          </View>
          <Field label={forced ? "Senha atual (provisória)" : "Senha atual"}>
            <Input
              value={current}
              onChangeText={setCurrent}
              secureTextEntry={!show}
              autoComplete="current-password"
              textContentType="password"
              accessibilityLabel={forced ? "Senha atual, a provisória" : "Senha atual"}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => nextRef.current?.focus()}
            />
          </Field>
          <Field label="Nova senha" hint={`Pelo menos ${MIN_LENGTH} caracteres.`}>
            <Input
              ref={nextRef}
              value={next}
              onChangeText={setNext}
              secureTextEntry={!show}
              autoComplete="new-password"
              textContentType="newPassword"
              accessibilityLabel="Nova senha"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => confirmRef.current?.focus()}
              right={toggle}
            />
          </Field>
          <Field label="Confirme a nova senha" error={confirmError}>
            <Input
              ref={confirmRef}
              value={confirm}
              onChangeText={(value) => {
                setConfirm(value);
                if (confirmError && value === next) setConfirmError(null);
              }}
              onBlur={() => setConfirmError(confirm && confirm !== next ? MISMATCH : null)}
              secureTextEntry={!show}
              autoComplete="new-password"
              textContentType="newPassword"
              accessibilityLabel="Confirme a nova senha"
              returnKeyType="done"
              onSubmitEditing={() => void submit()}
            />
          </Field>
          {error ? <ErrorBox message={error} /> : null}
          <Button title={forced ? "Salvar e continuar" : "Salvar nova senha"} variant="primary" onPress={() => void submit()} loading={saving} />
        </Card>
        {forced ? (
          <Button compact variant="ghost" title="Sair" onPress={() => void logout()} disabled={saving} style={{ alignSelf: "center" }} />
        ) : null}
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

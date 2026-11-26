// Contato › a troca de e-mail esperando o link: o e-mail novo, "Pendente de validação", quando o link saiu e as ações
// "Reenviar link" (só com o envio de e-mail ligado) e "Cancelar troca". Até o link ser aberto, o login continua o de
// hoje. Neutro: a linha Contato do menu já avisa em âmbar.

import { StyleSheet, View } from "react-native";
import { linkSentText } from "../../lib/profileForm";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Button } from "../ui";

export function EmailPendingBox({
  email,
  sentAt,
  busy,
  disabled = false,
  onResend,
  onCancel,
}: {
  /** O e-mail novo, esperando a validação. */
  email: string;
  /** Quando o último link saiu (null: sem registro). */
  sentAt: string | null;
  /** A ação no ar (o botão dela mostra o carregando; os dois ficam desligados). */
  busy: "resend" | "cancel" | null;
  /** Desliga os dois (o formulário está salvando). */
  disabled?: boolean;
  /** Sem ela (envio de e-mail desligado), só "Cancelar troca". */
  onResend?: () => void;
  onCancel: () => void;
}) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const sent = sentAt ? linkSentText(sentAt) : null;
  const off = disabled || busy !== null;
  return (
    <View style={styles.box}>
      <View style={styles.head} accessible accessibilityLabel={`E-mail novo ${email}, pendente de validação${sent ? `, ${sent.toLowerCase()}` : ""}`}>
        <Icon name="mail" size={18} color={c.inkMuted} />
        <View style={styles.text}>
          <Text style={styles.email} numberOfLines={2}>
            {email}
          </Text>
          <Text style={styles.state}>Pendente de validação</Text>
          {sent ? <Text style={styles.sent}>{sent}</Text> : null}
        </View>
      </View>
      <View style={styles.actions}>
        {onResend ? <Button compact title="Reenviar link" onPress={onResend} loading={busy === "resend"} disabled={off} /> : null}
        <Button compact variant="ghost" title="Cancelar troca" onPress={onCancel} loading={busy === "cancel"} disabled={off} />
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    box: {
      gap: 12,
      padding: 12,
      borderRadius: RADIUS.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.line,
      backgroundColor: c.surface2,
    },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    text: { flex: 1, gap: 2 },
    email: { fontSize: 15, fontWeight: "700", color: c.ink },
    state: { fontSize: 13, color: c.ink },
    sent: { fontSize: 13, color: c.inkMuted },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  });

import { useEffect, useState } from "react";
import { Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { api, errorMessage } from "../../lib/api";
import { copyText, openWhatsApp } from "../../lib/device-actions";
import { isOnline, useSyncStatus } from "../../lib/sync";
import type { LocalTicket } from "../../lib/syncTypes";
import { showToast } from "../../lib/toast";
import type { ReportLink } from "../../lib/types";
import { useStyles, useTheme, type Palette } from "../../theme/theme";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Button, Card } from "../ui";

/** Mensagem para o cliente, com o link do relatório (WhatsApp ou outro app). */
export function reportMessage(ticket: Pick<LocalTicket, "code" | "location">, url: string): string {
  const place = ticket.location?.name?.trim();
  return [
    `Olá! O atendimento ${ticket.code}${place ? ` em ${place}` : ""} foi concluído.`,
    `Relatório com fotos, checklist e assinatura: ${url}`,
  ].join("\n");
}

/**
 * OS concluída: o técnico responsável envia ao cliente o link do relatório (resumo, fotos,
 * checklist e assinatura), como no fechamento do Field Control: no WhatsApp ele escolhe o contato
 * (o app não recebe o contato da loja), compartilha por outro app ou copia o link.
 */
export function ReportShareCard({ ticket }: { ticket: LocalTicket }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  const online = isOnline(useSyncStatus());
  const [fetched, setFetched] = useState<ReportLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = ticket.report_link ?? fetched;
  // A conclusão ainda está na fila do aparelho: o servidor só cria o link quando a receber.
  const waiting = ticket.pending_ops > 0;

  // OS antiga (sem link) ou o aparelho ainda não recebeu o link: pede ao servidor.
  useEffect(() => {
    if (link || waiting || !online || error) return;
    let alive = true;
    api
      .post<ReportLink>(`/tickets/${ticket.id}/report-link`)
      .then((out) => {
        if (alive) setFetched(out);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [link, waiting, online, error, ticket.id]);

  async function copy(url: string) {
    const ok = await copyText(url);
    showToast(ok ? "Link copiado" : "Não foi possível copiar", {
      tone: ok ? "success" : "error",
      description: ok ? "Cole na conversa com o cliente." : undefined,
    });
  }

  async function whatsapp(url: string) {
    try {
      await openWhatsApp(reportMessage(ticket, url));
    } catch {
      showToast("O WhatsApp não abriu", { tone: "error", description: "Use Compartilhar ou copie o link." });
    }
  }

  async function share(url: string) {
    try {
      await Share.share({ message: reportMessage(ticket, url) });
    } catch {
      // Sem folha de compartilhamento (ex.: navegador): copia para colar onde quiser.
      await copy(url);
    }
  }

  let body: React.ReactNode;
  if (link) {
    const url = link.url;
    body = (
      <>
        <View style={styles.row}>
          <Button title="WhatsApp" variant="primary" onPress={() => void whatsapp(url)} style={{ flex: 1 }} />
          <Button title="Compartilhar" icon="share" onPress={() => void share(url)} style={{ flex: 1 }} />
        </View>
        <Text style={styles.hint}>No WhatsApp, escolha a conversa com o cliente.</Text>
        <View style={styles.links}>
          <Pressable onPress={() => void copy(url)} hitSlop={8} accessibilityRole="button" style={styles.link}>
            <Icon name="copy" size={16} color={c.brandInk} />
            <Text style={styles.linkText}>Copiar link</Text>
          </Pressable>
          <Pressable
            onPress={() => void Linking.openURL(url).catch(() => undefined)}
            hitSlop={8}
            accessibilityRole="link"
            style={styles.link}
          >
            <Icon name="eye" size={16} color={c.brandInk} />
            <Text style={styles.linkText}>Ver como o cliente vê</Text>
          </Pressable>
        </View>
      </>
    );
  } else if (waiting) {
    body = <Text style={styles.status}>A conclusão ainda está sendo enviada. O link aparece assim que a central receber.</Text>;
  } else if (!online) {
    body = <Text style={styles.status}>Sem conexão. O link do relatório aparece quando o app voltar a sincronizar.</Text>;
  } else if (error) {
    body = (
      <View style={{ gap: 10 }}>
        <Text style={[styles.status, { color: c.danger }]}>Não foi possível gerar o link: {error}</Text>
        <Button title="Tentar de novo" compact onPress={() => setError(null)} style={{ alignSelf: "flex-start" }} />
      </View>
    );
  } else {
    body = <Text style={styles.status}>Gerando o link do relatório…</Text>;
  }

  return (
    <Card style={{ gap: 12 }}>
      <View style={styles.head}>
        <View style={styles.badge}>
          <Icon name="note" size={20} color={c.brandInk} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title}>Relatório para o cliente</Text>
          <Text style={styles.subtitle}>Resumo do atendimento com fotos, checklist e assinatura.</Text>
        </View>
      </View>
      {body}
    </Card>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", gap: 12 },
    badge: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: c.primarySoft,
      alignItems: "center",
      justifyContent: "center",
    },
    title: { fontSize: 16, fontWeight: "700", color: c.ink },
    subtitle: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    row: { flexDirection: "row", gap: 10 },
    hint: { fontSize: 12, color: c.inkSubtle, lineHeight: 17 },
    links: { flexDirection: "row", flexWrap: "wrap", gap: 18 },
    link: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 },
    linkText: { fontSize: 14, fontWeight: "600", color: c.brandInk },
    status: { fontSize: 13, color: c.inkMuted, lineHeight: 19 },
  });

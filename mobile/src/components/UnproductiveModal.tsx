import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { errorMessage } from "../lib/api";
import { useLiveQuery } from "../lib/changes";
import { getUnproductiveReasons, getUnproductiveReasonsAt } from "../lib/db";
import { haptic } from "../lib/haptics";
import { enqueueUnproductive, isOnline, requestSync, useSyncStatus } from "../lib/sync";
import type { LocalTicket } from "../lib/syncTypes";
import { showToast } from "../lib/toast";
import { RADIUS, useStyles, type Palette } from "../theme/theme";
import { Skeleton } from "./Skeleton";
import { Text } from "./Text";
import { LocationLine, useLocationFix } from "./ticket/LocationLine";
import { SheetScaffold } from "./ticket/SheetScaffold";
import { Button, ErrorBox, Field, Input } from "./ui";

type Phase = "idle" | "locating" | "saving";

/**
 * Visita improdutiva: o técnico foi ao local e não conseguiu atender. A OS volta para
 * "Atribuído" sem agenda (a central reagenda) e o motivo vai para o histórico, com GPS.
 * O técnico vê só o motivo e a descrição (quem arca com a visita é decisão da gestão).
 * Vai pela fila de sync: funciona offline.
 */
export function UnproductiveModal({ ticket, onClose }: { ticket: LocalTicket; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const sync = useSyncStatus();
  const online = isOnline(sync);
  const reasons = useLiveQuery(getUnproductiveReasons);
  const reasonsAt = useLiveQuery(getUnproductiveReasonsAt);
  const location = useLocationFix();
  const [open, setOpen] = useState(true);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const cancelled = useRef(false);
  const skipWait = useRef<(() => void) | null>(null);

  function close() {
    if (phase === "saving") return;
    if (phase === "locating") {
      // Voltar enquanto busca o GPS cancela: a visita não é registrada.
      cancelled.current = true;
      skipWait.current?.();
    }
    setOpen(false);
  }

  async function confirm() {
    setError(null);
    if (!reasonId) {
      haptic.warning();
      setError("Escolha o motivo da visita improdutiva.");
      return;
    }
    cancelled.current = false;
    setPhase("locating");
    const position = await Promise.race([
      location.wait(),
      new Promise<null>((resolve) => {
        skipWait.current = () => resolve(null);
      }),
    ]);
    skipWait.current = null;
    if (cancelled.current) return;
    setPhase("saving");
    try {
      await enqueueUnproductive(ticket.id, {
        reason_id: reasonId,
        note: note.trim() || null,
        latitude: position?.status === "ok" ? position.latitude : null,
        longitude: position?.status === "ok" ? position.longitude : null,
      });
    } catch (e) {
      setError(errorMessage(e));
      setPhase("idle");
      return;
    }
    haptic.warning();
    showToast(`${ticket.code}: visita improdutiva registrada`, {
      tone: "success",
      description: online ? "A OS voltou para a central reagendar." : "Salvo no aparelho; vai para a central quando houver conexão.",
    });
    setOpen(false);
  }

  let reasonList: ReactNode;
  if (reasons === undefined || reasonsAt === undefined) {
    reasonList = (
      <View style={{ gap: 8 }} accessibilityLabel="Carregando os motivos">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={52} radius={RADIUS.control} />
        ))}
      </View>
    );
  } else if (reasons.length === 0) {
    reasonList = reasonsAt ? (
      <Text style={styles.hint}>Nenhum motivo cadastrado pela central. Fale com a central no grupo.</Text>
    ) : (
      <View style={{ gap: 10 }}>
        <Text style={styles.hint}>
          {online ? "A lista de motivos ainda não foi baixada neste aparelho." : "Conecte-se para baixar a lista de motivos."}
        </Text>
        {online ? (
          <Button
            title="Baixar agora"
            compact
            loading={sync.syncing}
            onPress={() => void requestSync()}
            style={{ alignSelf: "flex-start" }}
          />
        ) : null}
      </View>
    );
  } else {
    reasonList = (
      <View style={{ gap: 8 }} accessibilityRole="radiogroup">
        {reasons.map((reason) => {
          const selected = reasonId === reason.id;
          return (
            <Pressable
              key={reason.id}
              onPress={() => {
                haptic.select();
                setReasonId(reason.id);
              }}
              disabled={phase !== "idle"}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              style={[styles.option, selected && styles.optionSelected]}
            >
              <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.optionText}>{reason.name}</Text>
                {reason.description ? <Text style={styles.hint}>{reason.description}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <SheetScaffold
      visible={open}
      title="Visita improdutiva"
      code={ticket.code}
      description="Use quando você foi ao local e não conseguiu atender. A OS volta para a central reagendar e sai da sua agenda."
      onRequestClose={close}
      onClosed={onClose}
      footer={
        <>
          <Button title="Voltar" onPress={close} disabled={phase === "saving"} style={{ flex: 1 }} />
          <Button
            title={phase === "locating" ? "Obtendo localização…" : "Registrar"}
            variant="danger"
            onPress={() => void confirm()}
            loading={phase !== "idle"}
            disabled={!reasons?.length}
            style={{ flex: 1.4 }}
          />
        </>
      }
    >
      <Field label="Motivo" required>
        {reasonList}
      </Field>
      <Field label="O que aconteceu no local">
        <Input
          value={note}
          onChangeText={setNote}
          multiline
          editable={phase === "idle"}
          placeholder="Opcional. Ex.: loja fechada, responsável ausente."
        />
      </Field>
      <View style={{ gap: 4 }}>
        <LocationLine fix={location.fix} onAllow={() => void location.allow()} />
        {phase === "locating" ? (
          <Pressable onPress={() => skipWait.current?.()} hitSlop={8} accessibilityRole="button" style={styles.skip}>
            <Text style={styles.skipText}>Seguir sem localização</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <ErrorBox message={error} /> : null}
    </SheetScaffold>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    hint: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    option: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      minHeight: 52,
      padding: 14,
      borderRadius: RADIUS.control,
      borderWidth: 1.5,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
    },
    optionSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: c.inkMuted,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
    },
    radioSelected: { borderColor: c.primary, backgroundColor: c.primary },
    radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.onPrimary },
    optionText: { fontSize: 15, fontWeight: "600", color: c.ink, lineHeight: 21 },
    skip: { alignSelf: "flex-start", paddingVertical: 4 },
    skipText: { fontSize: 14, fontWeight: "600", color: c.brandInk, textDecorationLine: "underline" },
  });

// O arquivo de um documento ou do currículo (Configurações › Documentos e Currículo). Sem arquivo, as três origens
// (FileChoices): "Escolher arquivo" (o seletor do sistema, PDF ou foto) e, numa linha, "Tirar foto" e "Da galeria". Com
// arquivo, o cartão dele (ícone, nome numa linha e a linha do tipo e do tamanho) com "Abrir" (só o arquivo já gravado:
// o link é pedido na hora) e "Trocar", que abre a folha com as três origens (FileSourceSheet). Quem usa escolhe e
// guarda o arquivo (lib/documentFile.ts); aqui é só o desenho.

import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { RADIUS, useStyles, useTheme, type Palette } from "../../theme/theme";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { Icon } from "../Icon";
import { Text } from "../Text";
import { Button, Field } from "../ui";

/** De onde vem o arquivo: o seletor do sistema, a câmera ou a galeria. */
export type FileSource = "document" | "camera" | "library";

/** O arquivo que o campo mostra: o escolhido agora ou o gravado. */
export interface ShownFile {
  name: string;
  /** Foto (ícone da câmera) ou PDF (ícone do documento). */
  photo: boolean;
  /** "PDF · 1,2 MB" ou, do gravado, "PDF · 1,2 MB · enviado em 20/11/2026". */
  line: string;
}

/** A folha "Trocar" / "Substituir": as três origens. A escolha roda depois que a folha sai (o seletor abre no iPhone). */
export function FileSourceSheet({
  visible,
  title,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  onPick: (source: FileSource) => void;
  onClose: () => void;
}) {
  const actions: SheetAction[] = [
    { key: "document", label: "Escolher arquivo", icon: "note", onPress: () => onPick("document") },
    { key: "camera", label: "Tirar foto", icon: "camera", onPress: () => onPick("camera") },
    { key: "library", label: "Da galeria", icon: "plus", onPress: () => onPick("library") },
  ];
  return <ActionSheet visible={visible} title={title} actions={actions} onClose={onClose} />;
}

/** Sem arquivo: "Escolher arquivo" (principal) e, numa linha, "Tirar foto" e "Da galeria". */
export function FileChoices({ onPick, disabled = false }: { onPick: (source: FileSource) => void; disabled?: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.choices}>
      <Button title="Escolher arquivo" icon="note" variant="primary" onPress={() => onPick("document")} disabled={disabled} />
      <View style={styles.photoRow}>
        <Button title="Tirar foto" icon="camera" onPress={() => onPick("camera")} disabled={disabled} style={styles.half} />
        <Button title="Da galeria" onPress={() => onPick("library")} disabled={disabled} style={styles.half} />
      </View>
    </View>
  );
}

/** O cartão do arquivo: ícone, nome e a linha do tipo; à direita, as ações que vierem. */
export function FileCard({ file, actions }: { file: ShownFile; actions?: ReactNode }) {
  const c = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.fileRow}>
      <View style={styles.fileMain} accessible accessibilityLabel={`${file.name}, ${file.line}`}>
        <View style={styles.fileIcon}>
          <Icon name={file.photo ? "camera" : "note"} size={20} color={c.brandInk} />
        </View>
        <View style={styles.fileText}>
          <Text style={styles.fileName} numberOfLines={1}>
            {file.name}
          </Text>
          <Text style={styles.fileLine}>{file.line}</Text>
        </View>
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

/**
 * O campo "Arquivo" do formulário: as origens sem arquivo; com ele, o cartão com "Abrir" (`onOpen`, só o gravado) e
 * "Trocar". `error`: o que falta ou o arquivo que não serve.
 */
export function FileField({
  label = "Arquivo",
  required = true,
  file,
  onPick,
  onOpen,
  disabled = false,
  error,
}: {
  label?: string;
  required?: boolean;
  file: ShownFile | null;
  onPick: (source: FileSource) => void;
  onOpen?: () => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <>
      <Field label={label} required={required} error={error}>
        {file ? (
          <FileCard
            file={file}
            actions={
              <>
                {onOpen ? <Button compact variant="ghost" title="Abrir" onPress={onOpen} disabled={disabled} /> : null}
                <Button compact variant="ghost" title="Trocar" onPress={() => setMenu(true)} disabled={disabled} />
              </>
            }
          />
        ) : (
          <FileChoices onPick={onPick} disabled={disabled} />
        )}
      </Field>
      {/* Um Modal: fora do fluxo do formulário. */}
      <FileSourceSheet visible={menu && Boolean(file)} title={label} onPick={onPick} onClose={() => setMenu(false)} />
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    choices: { gap: 8 },
    photoRow: { flexDirection: "row", gap: 8 },
    half: { flex: 1 },
    fileRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
      padding: 12,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: c.lineStrong,
      backgroundColor: c.surface,
    },
    fileMain: { flexDirection: "row", alignItems: "center", gap: 12, flexGrow: 1, flexShrink: 1, flexBasis: 180 },
    fileIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.primarySoft,
    },
    fileText: { flex: 1, gap: 2 },
    fileName: { fontSize: 15, fontWeight: "700", color: c.ink },
    fileLine: { fontSize: 13, color: c.inkMuted, lineHeight: 18 },
    actions: { flexDirection: "row", alignItems: "center", marginLeft: "auto" },
  });

// Fotos da OS pela câmera e pela galeria, com as mesmas opções em todas as telas (avulsa, campo de
// formulário e pedido de peça), mensagens claras quando algo falha e a recuperação da foto quando o
// Android fecha o app com a câmera aberta (comum em aparelho simples): antes de abrir a câmera o alvo
// fica guardado no aparelho e, ao voltar para a OS, ImagePicker.getPendingResultAsync devolve a foto.

import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import { getKv, setKv } from "../../lib/db";
import { askOpenSettings, notify } from "../../lib/dialogs";

export type CaptureTarget =
  | { kind: "loose"; ticketId: string }
  | { kind: "form"; ticketId: string; formId: string; fieldId: string }
  | { kind: "part"; ticketId: string };

type StoredTarget = CaptureTarget & { at: string };

const TARGET_KEY = "camera_target";
const RECOVER_WINDOW_MS = 30 * 60_000;

/** Qualidade 0,5: a foto fica bem menor e continua servindo de evidência. */
const OPTIONS: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.5, exif: false };

async function remember(target: CaptureTarget) {
  if (Platform.OS !== "android") return;
  await setKv(TARGET_KEY, JSON.stringify({ ...target, at: new Date().toISOString() } satisfies StoredTarget)).catch(() => undefined);
}

async function forget() {
  if (Platform.OS !== "android") return;
  await setKv(TARGET_KEY, null).catch(() => undefined);
}

async function cameraAllowed(): Promise<boolean> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (permission.granted) return true;
  const message = "Libere o acesso à câmera nas configurações do aparelho para fotografar o atendimento.";
  if (permission.canAskAgain) notify("Câmera bloqueada", message);
  else await askOpenSettings("Câmera bloqueada", message);
  return false;
}

/**
 * Abre a câmera (uma foto) ou a galeria (até `limit`). Devolve as fotos escolhidas, ou [] quando o
 * técnico cancelou ou algo falhou (o aviso já foi mostrado).
 */
export async function capturePhotos(
  source: "camera" | "library",
  target: CaptureTarget,
  limit = 1,
): Promise<ImagePicker.ImagePickerAsset[]> {
  let remembered = false;
  try {
    if (source === "camera" && !(await cameraAllowed())) return [];
    await remember(target);
    remembered = true;
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync(OPTIONS)
        : await ImagePicker.launchImageLibraryAsync({
            ...OPTIONS,
            allowsMultipleSelection: limit > 1,
            selectionLimit: Math.max(1, limit),
          });
    if (result.canceled) return [];
    return result.assets.slice(0, Math.max(1, limit));
  } catch (error) {
    // O erro técnico fica no log; o técnico recebe o que fazer.
    console.warn("Falha ao abrir a câmera/galeria", error);
    notify(
      source === "camera" ? "Não foi possível abrir a câmera" : "Não foi possível abrir a galeria",
      source === "camera"
        ? "Feche outros apps que estejam usando a câmera e tente de novo."
        : "Feche e abra a galeria de novo. Se continuar, reinicie o aparelho.",
    );
    return [];
  } finally {
    if (remembered) await forget();
  }
}

let recovering: Promise<unknown> | null = null;

/**
 * Foto tirada antes de o Android fechar o app. Só consome o resultado quando o alvo guardado é desta
 * tela (`match`) e tem menos de 30 min; senão deixa para a tela certa.
 */
export function recoverCapture(
  match: (target: CaptureTarget) => boolean,
): Promise<{ target: CaptureTarget; assets: ImagePicker.ImagePickerAsset[] } | null> {
  if (Platform.OS !== "android") return Promise.resolve(null);
  // Uma recuperação por vez: duas telas montando juntas não disputam o mesmo resultado.
  const run = (recovering ?? Promise.resolve()).then(async () => {
    const raw = await getKv(TARGET_KEY).catch(() => null);
    if (!raw) return null;
    let stored: StoredTarget;
    try {
      stored = JSON.parse(raw) as StoredTarget;
    } catch {
      await forget();
      return null;
    }
    if (!(Date.now() - new Date(stored.at).getTime() <= RECOVER_WINDOW_MS)) {
      await forget();
      return null;
    }
    if (!match(stored)) return null;
    const result = await ImagePicker.getPendingResultAsync().catch(() => null);
    await forget();
    if (!result || "code" in result || result.canceled || !result.assets.length) return null;
    return { target: stored as CaptureTarget, assets: result.assets };
  });
  recovering = run.catch(() => undefined);
  return run;
}

// Documentos pessoais, certificações e currículo do técnico (Configurações › Documentos e Currículo; contrato da Entrega
// 2, §6.3): as rotas de /me/profile/documents, todas na fila das gravações do cadastro (writeProfile, lib/profile.ts),
// que guarda o MyProfile devolvido (a lista vem em MyProfile.documents, sem link). Tudo online: nada entra na fila
// offline (documento é dado pessoal e não fica no aparelho; o servidor confere o tipo e o limite na hora e avisa a
// central). O envio leva um `client_upload_id`: mandado de novo depois de uma resposta perdida, devolve o mesmo
// documento em vez de criar outro. O arquivo abre por um link assinado de 30 min, pedido na hora (não fica no cadastro).

import { Linking, Platform } from "react-native";
import { absoluteApiUrl, api, ApiError, errorMessage, uploadFile } from "./api";
import type { PickedDocumentFile } from "./documentFile";
import { noNetwork, offlineFailure } from "./net";
import { loadProfile, writeProfile } from "./profile";
import { showToast } from "./toast";
import type { DocumentLink, MyDocument, MyProfile, TechDocumentUpdate } from "./types";

const BASE = "/me/profile/documents";

/** A resposta da rota (o cadastro inteiro); sem corpo, o cadastro é lido de novo na mesma vez da fila. */
async function profileOf(response: MyProfile | null | undefined): Promise<MyProfile> {
  return response ?? api.get<MyProfile>("/me/profile");
}

/**
 * POST /me/profile/documents (multipart: `file`, `kind`, `title`, `expires_on`, `client_upload_id`). Com um currículo
 * gravado, o currículo enviado troca o arquivo dele (o servidor guarda o anterior como versão).
 */
export function sendDocument(file: PickedDocumentFile, fields: Record<string, string>): Promise<MyProfile> {
  return writeProfile(async () => profileOf(await uploadFile<MyProfile | null>(BASE, file.uri, fields, file.mimeType, file.name)));
}

/** POST …/{id}/replace (multipart: `file`, `client_upload_id` e, se mudaram junto, `title` e `expires_on`). */
export function replaceDocument(id: string, file: PickedDocumentFile, fields: Record<string, string>): Promise<MyProfile> {
  return writeProfile(async () =>
    profileOf(await uploadFile<MyProfile | null>(`${BASE}/${encodeURIComponent(id)}/replace`, file.uri, fields, file.mimeType, file.name)),
  );
}

/** PATCH …/{id}: só o título ou a validade (o tipo não muda). */
export function updateDocument(id: string, body: TechDocumentUpdate): Promise<MyProfile> {
  return writeProfile(async () => profileOf(await api.patch<MyProfile | null>(`${BASE}/${encodeURIComponent(id)}`, body)));
}

/**
 * DELETE …/{id}. O que já tinha saído (404: excluído em outro aparelho ou pela central) conta como excluído, depois de
 * reler o cadastro; se ele continua na lista, o erro volta.
 */
export async function deleteDocument(id: string): Promise<MyProfile> {
  try {
    return await writeProfile(async () => profileOf(await api.delete<MyProfile | null>(`${BASE}/${encodeURIComponent(id)}`)));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
    const profile = await loadProfile();
    if (Array.isArray(profile.documents) && profile.documents.some((doc) => doc.id === id)) throw error;
    return profile;
  }
}

/** GET …/{id}/link: o link assinado de 30 min, já absoluto. */
export async function documentLink(id: string): Promise<string> {
  const link = await api.get<DocumentLink>(`${BASE}/${encodeURIComponent(id)}/link`);
  const url = absoluteApiUrl(link?.url);
  if (!url) throw new Error("Arquivo indisponível");
  return url;
}

const NO_INTERNET = "Sem internet";
const OFFLINE_OPEN = "Conecte o aparelho para abrir o arquivo.";

/** Só um arquivo abrindo por vez (dois toques seguidos não abrem duas abas). */
let opening = false;

/**
 * Abre o arquivo no navegador do aparelho (a foto abre na tela; o PDF baixa), com os avisos de sempre. Chame direto no
 * toque: na pré-visualização web a aba nova abre já no toque (vazia) e recebe o endereço quando o link chega, porque o
 * bloqueador de janelas do navegador barra a aba aberta depois da espera.
 */
export async function openDocument(doc: Pick<MyDocument, "id">): Promise<void> {
  if (opening) return;
  opening = true;
  const tab = Platform.OS === "web" && typeof window !== "undefined" ? window.open("", "_blank") : null;
  // A página do arquivo não alcança o app (a aba foi aberta por ele).
  if (tab) tab.opener = null;
  try {
    if (await noNetwork()) {
      tab?.close();
      showToast(NO_INTERNET, { description: OFFLINE_OPEN });
      return;
    }
    const url = await documentLink(doc.id);
    if (tab) tab.location.href = url;
    else await Linking.openURL(url);
  } catch (error) {
    tab?.close();
    if (await offlineFailure(error)) showToast(NO_INTERNET, { description: OFFLINE_OPEN });
    else showToast("Não foi possível abrir o arquivo", { tone: "error", description: errorMessage(error) });
  } finally {
    opening = false;
  }
}

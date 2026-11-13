"use client";

// Homologação: catálogo (rótulos vêm da API), o aviso de privacidade (LGPD) da ficha e as
// validações e máscaras dos documentos (as mesmas da API).

import { useQuery } from "@tanstack/react-query";
import { request } from "./api";
import type { OnboardingCatalog } from "./types";

/** As 27 UFs (a API recusa outra sigla). */
export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB",
  "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

export function useOnboardingCatalog() {
  return useQuery({
    queryKey: ["onboarding", "catalog"],
    queryFn: () => request<OnboardingCatalog>("/public/onboarding/catalog", { auth: false }),
    staleTime: Infinity,
  });
}

export function labelMap(items: { key: string; label: string }[] | undefined): Record<string, string> {
  return Object.fromEntries((items ?? []).map((i) => [i.key, i.label]));
}

/** Link que o técnico abre no celular. Em produção, defina NEXT_PUBLIC_WEB_URL (endereço público). */
export function inviteUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_WEB_URL || window.location.origin).replace(/\/$/, "");
  return `${base}/cadastro-tecnico/${token}`;
}

/**
 * Endereço que só abre na rede da empresa (localhost, IP interno, nome sem domínio): o técnico no 4G
 * não consegue abrir um link assim.
 */
export function isInternalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "0.0.0.0") {
    return true;
  }
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!ip) return !host.includes(".") && !host.includes(":");
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

// Mudou o texto? Mude também PRIVACY_VERSION em backend/app/schemas/onboarding.py.
export const PRIVACY_NOTICE: { title: string; body: string }[] = [
  {
    title: "Quem trata seus dados",
    body: "A Maxx Field, como controladora, para avaliar seu cadastro como técnico parceiro e, se aprovado, para a gestão dos atendimentos.",
  },
  {
    title: "Quais dados",
    body: "Os desta ficha: identificação (nome, CPF, nascimento, foto), contato, endereço, região de atendimento, experiência, skills e disponibilidade.",
  },
  {
    title: "Para quê",
    body: "Homologação técnica, cadastro na base de técnicos, distribuição de ordens de serviço e contato sobre os atendimentos. Não vendemos nem compartilhamos seus dados para marketing.",
  },
  {
    title: "Localização (GPS)",
    body: "Se aprovado, o app coleta sua localização somente durante a jornada que você mesmo inicia e encerra, para acompanhar o deslocamento até o cliente. O app pede sua autorização antes da primeira jornada.",
  },
  {
    title: "Por quanto tempo",
    body: "Enquanto você fizer parte da base técnica e pelo prazo exigido em lei. Fichas reprovadas são excluídas após a análise e o prazo legal aplicável.",
  },
  {
    title: "Seus direitos",
    body: "Você pode pedir acesso, correção, portabilidade ou exclusão dos seus dados e revogar consentimentos a qualquer momento, pelo canal de privacidade da Maxx Field.",
  },
];

export function isValidCpf(value: string): boolean {
  const d = value.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

const CNPJ_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * CNPJ, inclusive o alfanumérico da Receita (as 12 primeiras posições podem ter letras; os 2 dígitos
 * verificadores são números). Mesmo cálculo de backend/app/core/documents.py: valor ASCII - 48.
 */
export function isValidCnpj(value: string): boolean {
  const d = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(d) || new Set(d).size === 1) return false;
  const digit = (chars: string, weights: number[]) => {
    const total = weights.reduce((sum, w, i) => sum + (chars.charCodeAt(i) - 48) * w, 0);
    const rest = total % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const base = d.slice(0, 12);
  const first = digit(base, CNPJ_WEIGHTS);
  const second = digit(`${base}${first}`, [6, ...CNPJ_WEIGHTS]);
  return d.slice(12) === `${first}${second}`;
}

export function maskCpf(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

/** 00.000.000/0000-00 (aceita letras nas 12 primeiras posições, como o CNPJ alfanumérico). */
export function maskCnpj(value: string): string {
  const d = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase().slice(0, 14);
  const parts = [d.slice(0, 2), d.slice(2, 5), d.slice(5, 8), d.slice(8, 12), d.slice(12)];
  let out = parts[0];
  if (parts[1]) out += `.${parts[1]}`;
  if (parts[2]) out += `.${parts[2]}`;
  if (parts[3]) out += `/${parts[3]}`;
  if (parts[4]) out += `-${parts[4]}`;
  return out;
}

/** 00000-000 */
export function maskCep(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

export function maskPhone(value: string): string {
  let d = value.replace(/\D/g, "");
  // Número colado com o código do país (+55 11 9...): o campo guarda só DDD + número.
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** Desenha a foto reduzida (lado maior `max` px) num canvas: as fotos de celular têm de 4 a 10 MB. */
function drawResized(file: File, max: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não foi possível ler a imagem"));
    };
    img.src = url;
  });
}

/** Reduz a foto no próprio celular (lado maior 512 px, JPEG) antes de enviar. */
export async function resizePhoto(file: File, max = 512): Promise<string> {
  return (await drawResized(file, max)).toDataURL("image/jpeg", 0.85);
}

/** O mesmo, como arquivo (upload por formulário): a foto chega com poucos KB e passa no limite de 2 MB. */
export async function resizePhotoBlob(file: File, max = 512): Promise<Blob> {
  const canvas = await drawResized(file, max);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Não foi possível ler a imagem"))), "image/jpeg", 0.85),
  );
}

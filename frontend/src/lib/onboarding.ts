"use client";

// Homologação: catálogo (rótulos vêm da API) e o aviso de privacidade (LGPD) da ficha.

import { useQuery } from "@tanstack/react-query";
import { request } from "./api";
import type { OnboardingCatalog } from "./types";

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

export function maskCpf(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

export function maskPhone(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** Reduz a foto no próprio celular (lado maior 512 px, JPEG) antes de enviar. */
export function resizePhoto(file: File, max = 512): Promise<string> {
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
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não foi possível ler a imagem"));
    };
    img.src = url;
  });
}

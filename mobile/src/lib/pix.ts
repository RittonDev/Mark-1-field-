// Chave PIX no Meu cadastro: máscara e teclado por tipo e a validação antes de enviar. As regras e as mensagens
// são as de backend/app/core/pix.py (o servidor confere de novo); formatPixKey (constants.ts) mostra a chave gravada.

import type { TextInputProps } from "react-native";
import { isValidCnpj, isValidCpf, maskCnpj, maskCpf, maskPhone, onlyDigits } from "./masks";
import type { PixKeyType } from "./types";

/** Tamanho máximo da chave por e-mail no PIX. */
const EMAIL_MAX = 77;

export const PIX_INVALID: Record<PixKeyType, string> = {
  cpf: "CPF inválido: confira os números",
  cnpj: "CNPJ inválido: confira os números",
  email: "E-mail inválido",
  phone: "Celular inválido: use DDD e número, com o 9",
  random: "Chave aleatória inválida: copie a chave do app do seu banco",
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// DDD de dois dígitos sem zero e o número do celular, que começa com 9.
const MOBILE = /^[1-9]{2}9\d{8}$/;
const RANDOM = /^[0-9a-f]{32}$/;

/**
 * A chave como o servidor grava (CPF com 11 dígitos, CNPJ em maiúsculas, e-mail em minúsculas, celular "+55" e
 * 11 dígitos, chave aleatória 8-4-4-4-12), ou a mensagem do que está errado.
 */
export function parsePixKey(type: PixKeyType, text: string): { key: string } | { error: string } {
  const raw = text.trim();
  switch (type) {
    case "cpf": {
      const digits = onlyDigits(raw);
      return isValidCpf(digits) ? { key: digits } : { error: PIX_INVALID.cpf };
    }
    case "cnpj": {
      const clean = raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
      return isValidCnpj(clean) ? { key: clean } : { error: PIX_INVALID.cnpj };
    }
    case "email": {
      const email = raw.toLowerCase();
      return email.length <= EMAIL_MAX && EMAIL.test(email) ? { key: email } : { error: PIX_INVALID.email };
    }
    case "phone": {
      let digits = onlyDigits(raw);
      if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
      return MOBILE.test(digits) ? { key: `+55${digits}` } : { error: PIX_INVALID.phone };
    }
    case "random": {
      const hexa = raw.replace(/[\s-]/g, "").toLowerCase();
      if (!RANDOM.test(hexa)) return { error: PIX_INVALID.random };
      return { key: `${hexa.slice(0, 8)}-${hexa.slice(8, 12)}-${hexa.slice(12, 16)}-${hexa.slice(16, 20)}-${hexa.slice(20)}` };
    }
  }
}

/** O que a pessoa digita, com a máscara do tipo (o celular fica só com DDD e número). */
export function maskPixInput(type: PixKeyType, text: string): string {
  switch (type) {
    case "cpf":
      return maskCpf(text);
    case "cnpj":
      return maskCnpj(text);
    case "phone":
      return maskPhone(text);
    case "email":
      return text.replace(/\s/g, "");
    case "random":
      return text.trim();
  }
}

/** A chave gravada no jeito de editar (CPF, CNPJ e celular com a máscara do campo). */
export function pixInputValue(type: PixKeyType, key: string): string {
  return type === "email" || type === "random" ? key : maskPixInput(type, key);
}

/**
 * Teclado e preenchimento automático do campo da chave, conforme o tipo. CPF, CNPJ e celular não têm maxLength: a
 * máscara já corta, e o limite cortaria antes dela uma chave colada com espaços ou com o +55.
 */
export function pixKeyInputProps(type: PixKeyType): TextInputProps {
  switch (type) {
    case "cpf":
      return { keyboardType: "number-pad" };
    case "cnpj":
      // O CNPJ alfanumérico pode ter letras: teclado completo, em maiúsculas.
      return { keyboardType: "default", autoCapitalize: "characters", autoCorrect: false };
    case "phone":
      return { keyboardType: "phone-pad", autoComplete: "tel", textContentType: "telephoneNumber" };
    case "email":
      return {
        keyboardType: "email-address",
        autoCapitalize: "none",
        autoCorrect: false,
        autoComplete: "email",
        textContentType: "emailAddress",
        maxLength: EMAIL_MAX,
      };
    case "random":
      return { keyboardType: "default", autoCapitalize: "none", autoCorrect: false, spellCheck: false };
  }
}

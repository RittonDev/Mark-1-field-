// Lê a mensagem do cliente colada na Nova OS (conversa do WhatsApp ou e-mail) e sugere os campos.
// Roda só no navegador: o texto não vai para nenhum serviço de fora.

export type IntakeSource = "whatsapp" | "email";

export interface IntakeParse {
  source: IntakeSource | null;
  /** Assunto do e-mail ou a primeira frase útil da conversa. */
  title: string | null;
  /** O texto inteiro, limpo (sem data, hora e cabeçalhos). */
  description: string;
  /** Quem escreveu: o primeiro remetente da conversa ou o "De:" do e-mail. */
  contactName: string | null;
  /** Telefone achado no texto (ou no remetente) ou, no e-mail, o endereço de quem mandou. */
  contact: string | null;
  /** Nº do chamado no sistema do cliente (ex.: INC0012345). */
  clientReference: string | null;
  /** CNPJ da loja, só os dígitos. */
  cnpj: string | null;
  /** Como a mensagem chama a loja ("loja 41 Outlet Brasília"), para a busca. */
  storeHint: string | null;
  /** A mensagem fala em urgência (só vira sugestão; nunca muda a prioridade sozinha). */
  urgent: boolean;
}

// Linhas da conversa copiada ou exportada do WhatsApp: data, hora e remetente antes do texto.
const WHATSAPP_LINES = [
  // WhatsApp Web e desktop: "[09:41, 13/11/2026] Nome: texto"
  /^\[(\d{1,2}:\d{2}(?::\d{2})?),\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\]\s*([^:]{1,60}?):\s?(.*)$/,
  // iPhone: "[13/11/2026, 09:41:12] Nome: texto"
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,60}?):\s?(.*)$/,
  // Android: "13/11/2026 09:41 - Nome: texto"
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2})\s*-\s*([^:]{1,60}?):\s?(.*)$/,
];
const WHATSAPP_NOISE = /^<?\s*(m[íi]dia oculta|media omitted|arquivo de m[íi]dia oculto|imagem ocultada|esta mensagem foi apagada|this message was deleted|mensagem apagada)\s*>?$/i;

const EMAIL_HEADER =
  /^(de|from|para|to|cc|cco|bcc|assunto|subject|enviado|enviada|enviado em|enviada em|sent|data|date|importância|importance)\s*:\s*(.*)$/i;
const EMAIL_HISTORY = /^(-{2,}\s*(mensagem original|original message|mensagem encaminhada|forwarded message)\s*-{2,}|em .+ escreveu:|on .+ wrote:)$/i;
const SUBJECT_PREFIX = /^\s*((re|res|enc|fw|fwd|tr)\s*:\s*)+/i;

const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/;
const PHONE = /(?:\+?55[\s.-]?)?\(?\b(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// Nº de chamado em sistemas de atendimento (ServiceNow, Jira...): "INC0012345", "RITM-123456".
const REF_CODE = /\b(INC|RITM|REQ|SR|CHG|WO|TASK|CS)[\s-]?(\d{4,})\b/i;
// "Chamado nº 123456", "protocolo: AB-2026-0042", "ticket #98765" (o nº da nossa OS, "OS 15829", fica de fora).
const REF_WORD =
  /\b(?:chamado|protocolo|ticket|incidente|ocorr[êe]ncia|solicita[çc][ãa]o|requisi[çc][ãa]o)\s*(?:n[º°o]\.?|n[uú]mero|#)?\s*[:#]?\s*([A-Z]{0,6}-?\d{3,}[A-Z0-9-]*)\b/i;
const STORE = /\b(?:loja|filial|unidade|lj)\.?\s*(?:n[º°o]\.?\s*)?[:#-]?\s*([\p{L}\p{N}][\p{L}\p{N} '&-]{1,48})/iu;
// Onde a menção da loja acaba ("loja 41 Outlet Brasília está sem sistema" -> "41 Outlet Brasília").
const STORE_STOP = new Set([
  "esta", "está", "estão", "estao", "com", "sem", "que", "não", "nao", "precisa", "precisamos", "parou", "parada",
  "parado", "hoje", "amanhã", "amanha", "ontem", "e", "para", "pra", "por", "favor", "urgente", "fora", "ficou",
  "tá", "ta", "teve", "tem", "deu", "voltou", "apresenta", "apresentando", "chamado", "pdv", "caixa",
]);
const URGENT =
  /\b(urgente|urg[êe]ncia|parad[oa]s?|fora do ar|sem sistema|inoperante|emerg[êe]ncia|caiu|n[ãa]o liga|travad[oa]s?)\b/i;
// Saudação no começo da frase (seguida de pontuação ou espaço: "oito PDVs" não perde o "oi").
const GREETING =
  /^(bom dia|boa tarde|boa noite|ol[áa]|oi|prezad[oa]s?|pessoal|caros?|tudo bem\??)(?=[\s,!.:;?-]|$)[\s,!.:;-]*/i;

const TITLE_MAX = 90;

/** Tira caracteres invisíveis que o WhatsApp põe no começo das linhas exportadas. */
function clean(line: string): string {
  return line.replace(/[‎‏‪-‮﻿]/g, "").trimEnd();
}

function formatPhone(ddd: string, first: string, last: string): string {
  return `(${ddd}) ${first}-${last}`;
}

function findPhone(text: string): string | null {
  const m = PHONE.exec(text.replace(new RegExp(CNPJ.source, "g"), " "));
  return m ? formatPhone(m[1], m[2], m[3]) : null;
}

/** Primeira frase útil como título: sem saudação, até 90 letras, cortando entre palavras. */
function titleFrom(lines: string[]): string | null {
  for (const raw of lines) {
    let line = raw.trim();
    // A saudação pode vir duas vezes ("Bom dia, pessoal!").
    line = line.replace(GREETING, "").replace(GREETING, "").trim();
    if (line.length < 3) continue;
    // Só a primeira frase, quando ela já diz o problema.
    const sentence = line.split(/(?<=[.!?])\s+/)[0];
    if (sentence.length >= 15) line = sentence;
    if (line.length > TITLE_MAX) {
      const cut = line.slice(0, TITLE_MAX);
      const space = cut.lastIndexOf(" ");
      line = space > 40 ? cut.slice(0, space) : cut;
    }
    line = line.replace(/[\s,;:.!?-]+$/, "");
    if (line.length < 3) continue;
    return line.charAt(0).toUpperCase() + line.slice(1);
  }
  return null;
}

function storeHintFrom(text: string): string | null {
  const m = STORE.exec(text);
  if (!m) return null;
  const words = m[1].replace(/\s+-\s+/g, " ").split(/\s+/).filter(Boolean);
  // "na filial de Campinas": o "de" não ajuda na busca.
  while (words.length && /^(d[aoe]s?|n[ao]s?)$/i.test(words[0])) words.shift();
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length && STORE_STOP.has(word.toLowerCase())) break;
    kept.push(word);
    if (kept.length === 4) break;
  }
  const hint = kept.join(" ").replace(/[-'&\s]+$/, "");
  return hint.length >= 2 ? hint : null;
}

function referenceFrom(text: string): string | null {
  const code = REF_CODE.exec(text);
  if (code) return `${code[1].toUpperCase()}${code[2]}`;
  const word = REF_WORD.exec(text);
  return word ? word[1].toUpperCase() : null;
}

interface WhatsAppMessage {
  sender: string;
  lines: string[];
}

function parseWhatsApp(lines: string[]): WhatsAppMessage[] | null {
  const messages: WhatsAppMessage[] = [];
  let matched = 0;
  for (const line of lines) {
    let hit: RegExpExecArray | null = null;
    for (const re of WHATSAPP_LINES) {
      hit = re.exec(line);
      if (hit) break;
    }
    if (hit) {
      matched += 1;
      // Foto, áudio ou mensagem apagada: só a marcação do WhatsApp, sem texto.
      if (!WHATSAPP_NOISE.test(hit[4].trim())) messages.push({ sender: hit[3].replace(/^~\s*/, "").trim(), lines: [hit[4]] });
    } else if (messages.length) {
      messages[messages.length - 1].lines.push(line);
    } else if (line.trim()) {
      // Texto antes da primeira linha com data: não é uma conversa copiada.
      return null;
    }
  }
  return matched ? messages : null;
}

function senderName(sender: string): string | null {
  // Contato fora da agenda aparece como o número: aí não há nome.
  return /\d{4}/.test(sender) ? null : sender;
}

/** Junta as linhas: sem espaços nas pontas e no máximo uma linha em branco seguida. */
function tidy(lines: string[]): string {
  return lines
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseIntake(raw: string): IntakeParse {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(clean)
    .filter((l) => !WHATSAPP_NOISE.test(l.trim()));

  let source: IntakeSource | null = null;
  let title: string | null = null;
  let contactName: string | null = null;
  let contact: string | null = null;
  let body: string[] = lines;

  const chat = parseWhatsApp(lines);
  if (chat) {
    source = "whatsapp";
    const senders = [...new Set(chat.map((m) => m.sender))];
    const first = chat[0]?.sender ?? "";
    contactName = first ? senderName(first) : null;
    contact = findPhone(first);
    body =
      senders.length > 1
        ? chat.flatMap((m) => [`${senderName(m.sender) ?? m.sender}: ${m.lines[0]}`, ...m.lines.slice(1)])
        : chat.flatMap((m) => m.lines);
    title = titleFrom(chat.flatMap((m) => m.lines));
  } else {
    // E-mail: cabeçalhos "De:" e "Assunto:" nas primeiras linhas (acabam na primeira linha em branco).
    const headers = new Map<string, string>();
    let lastHeader = -1;
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      const line = lines[i].trim();
      const m = EMAIL_HEADER.exec(line);
      if (m) {
        const key = m[1].toLowerCase();
        if (!headers.has(key)) headers.set(key, m[2].trim());
        lastHeader = i;
      } else if (lastHeader >= 0 && !line) {
        break;
      }
    }
    const from = headers.get("de") ?? headers.get("from");
    const subject = headers.get("assunto") ?? headers.get("subject");
    if (from !== undefined && subject !== undefined) {
      source = "email";
      const address = EMAIL.exec(from)?.[0] ?? null;
      const name = from.replace(/<[^>]*>/g, "").replace(EMAIL, "").replace(/["'[\]()]/g, "").trim();
      contactName = name || null;
      contact = address;
      title = subject.replace(SUBJECT_PREFIX, "").trim() || null;
      const rest = lines.slice(lastHeader + 1);
      const history = rest.findIndex((l) => EMAIL_HISTORY.test(l.trim()));
      body = history >= 0 ? rest.slice(0, history) : rest;
    } else {
      title = titleFrom(lines);
    }
  }

  const description = tidy(body);
  const text = lines.join("\n");
  const phone = findPhone(description);
  const cnpj = CNPJ.exec(text)?.[0].replace(/\D/g, "") ?? null;

  return {
    source,
    title: title ? title.slice(0, 200) : null,
    description,
    contactName: contactName ? contactName.slice(0, 160) : null,
    // Telefone do corpo da mensagem vale mais que o e-mail do remetente (o técnico liga para ele).
    contact: (phone ?? contact)?.slice(0, 160) ?? null,
    clientReference: referenceFrom(text)?.slice(0, 80) ?? null,
    cnpj: cnpj && cnpj.length === 14 ? cnpj : null,
    storeHint: storeHintFrom(description),
    urgent: URGENT.test(text),
  };
}

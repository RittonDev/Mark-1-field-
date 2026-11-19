// A frase da busca da central (a Mia): o nome da agente, o texto sem acento e os ajustes feitos na frase
// antes de ela ir para a API. Sem React e sem o alias "@/": o teste de unidade (tests/phrase.test.mjs)
// importa este arquivo direto no Node.

/** Nome da agente de busca da central: M(axx) + IA. Os textos da interface a tratam no feminino. */
export const AGENT_NAME = "Mia";

/** Texto sem acento, em minúsculas e sem espaços nas pontas ("Técnico" -> "tecnico"). */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const NAME = AGENT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Só no começo da frase e só com pontuação depois do nome ("Mia, ...", "Mia,16976", "MIA: ...") ou
// saudação antes ("oi Mia ...", "Olá, Mia! ...", "e aí Mia, ..."): "mia", "mia atrasadas", "Miami" e
// "técnico mia" ficam. O ponto só conta seguido de espaço ou no fim: "mia.com.br", "mia.silva@exemplo.com"
// e "MIA.01" são o que se procura. Depois da saudação, o nome não pode seguir com letra, número ou ".x".
const VOCATIVE = new RegExp(
  String.raw`^\s*(?:(?:oi|ol[aá]|ei|e\s+a[ií])[\s,!.]+${NAME}(?![\p{L}\p{N}_]|\.[^\s,:;!.])|${NAME}(?:\s*[,:;!]|\.+(?=\s|$)))[\s,:;!.-]*`,
  "iu",
);

/** A frase sem o nome da agente quando a pessoa fala com ela ("Mia, atrasadas" -> "atrasadas"). */
export function stripAgentName(text: string): string {
  return text.replace(VOCATIVE, "");
}

/** Palavra comparável: sem acento, minúscula e sem a pontuação colada nas pontas ("Campinas?" -> "campinas"). */
const bare = (token: string) => normalizeText(token).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

/**
 * A frase sem as palavras dadas, comparadas sem acento, sem maiúscula e sem a pontuação colada
 * ("quantas OS atrasadas em campinas?" sem "quantas" -> "OS atrasadas em campinas?"). O resto é
 * juntado com um espaço; sem nada para tirar, a frase volta igual.
 */
export function dropWords(text: string, words: string): string {
  const drop = new Set(words.split(/\s+/).map(bare).filter(Boolean));
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => !drop.has(bare(token)));
  return kept.length === tokens.length ? text : kept.join(" ").trim();
}

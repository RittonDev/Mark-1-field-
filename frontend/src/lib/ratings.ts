// Avaliação do cliente (só a central): os textos e as regras puras da área Avaliações da ficha e do cartão "Avaliação do
// cliente" da OS. Só `import type` (testável no Node, como lib/constants.ts): tests/ratings.test.mjs. A média com uma
// casa e os limites dos campos também estão em lib/constants.ts (ratingText e RATING_LIMITS): a sonda confere que batem.

import type { ISODate, Ref, TechnicianRating, TechnicianRatingIn } from "./types";

/** A nota vai de 1 a 5. */
export const RATING_MAX = 5;

/** Nota até aqui é problema (vermelho na lista da ficha). */
export const LOW_SCORE = 2;

/** Os limites dos campos (= RATING_LIMITS de lib/constants.ts e o RatingIn da API). */
const LIMITS = { comment: 1000, rater: 120 } as const;

/** A área sem nenhuma avaliação. */
export const NO_RATINGS = "Nenhuma avaliação.";

/** "4 de 5". */
export function scoreText(score: number): string {
  return `${score} de ${RATING_MAX}`;
}

/** "1 avaliação" | "12 avaliações" | "1.234 avaliações". */
export function ratingsCountText(count: number): string {
  return count === 1 ? "1 avaliação" : `${count.toLocaleString("pt-BR")} avaliações`;
}

/** A média com uma casa e vírgula ("4,6"; 4 → "4,0"); sem média, "—". O servidor já arredonda (= ratingText). */
export function averageText(average: number | null | undefined): string {
  return average === null || average === undefined ? "—" : average.toFixed(1).replace(".", ",");
}

/** O resumo para o leitor de tela: "Média 4,6 de 5, 12 avaliações". */
export function ratingsSummaryLabel(average: number | null | undefined, count: number): string {
  return `Média ${averageText(average)} de ${RATING_MAX}, ${ratingsCountText(count)}`;
}

/** A nota baixa (até LOW_SCORE) aparece como problema. */
export function isLowScore(score: number): boolean {
  return score <= LOW_SCORE;
}

/** "Avaliado por {quem avaliou}" (no cliente); sem o nome, null. */
export function raterText(raterName: string | null | undefined): string | null {
  const name = raterName?.trim();
  return name ? `Avaliado por ${name}` : null;
}

/**
 * Quem registrou e quem corrigiu: "Registrada por {nome} em {data}" (+ " · corrigida por {nome} em {data}"). `date`
 * formata a data (formatDate de lib/format.ts na tela). Quem registrou e foi excluído do sistema: "Registrada em {data}".
 */
export function ratingTrail(
  rating: { created_at: ISODate; created_by: Ref | null; updated_at: ISODate; updated_by: Ref | null },
  date: (value: ISODate) => string,
): string {
  const created = rating.created_by
    ? `Registrada por ${rating.created_by.name} em ${date(rating.created_at)}`
    : `Registrada em ${date(rating.created_at)}`;
  return rating.updated_by ? `${created} · corrigida por ${rating.updated_by.name} em ${date(rating.updated_at)}` : created;
}

// --------------------------------------------------------------------------- formulário (cartão da OS)

/** O formulário da avaliação na tela: a nota (null: nenhuma escolhida), o comentário e quem avaliou, como digitados. */
export interface RatingForm {
  score: number | null;
  comment: string;
  rater_name: string;
}

export type RatingField = keyof RatingForm;

/** Os textos de erro da tela (o servidor tem os dele, sem ponto). */
export const RATING_MSG = {
  score: "Escolha a nota.",
  comment: `No máximo ${LIMITS.comment} caracteres.`,
  rater_name: `No máximo ${LIMITS.rater} caracteres.`,
} as const;

/** O formulário vazio ou o da avaliação gravada (Editar). */
export function ratingFormOf(rating: Pick<TechnicianRating, "score" | "comment" | "rater_name"> | null | undefined): RatingForm {
  return rating
    ? { score: rating.score, comment: rating.comment ?? "", rater_name: rating.rater_name ?? "" }
    : { score: null, comment: "", rater_name: "" };
}

/** Caracteres como o servidor conta (um emoji é um só). */
const length = (text: string) => Array.from(text).length;

/** Os erros da tela por campo ({} sem erro): nota inteira de 1 a 5; comentário e quem avaliou sem os espaços das pontas. */
export function ratingProblem(form: RatingForm): Partial<Record<RatingField, string>> {
  const errors: Partial<Record<RatingField, string>> = {};
  const { score } = form;
  if (score === null || !Number.isInteger(score) || score < 1 || score > RATING_MAX) errors.score = RATING_MSG.score;
  if (length(form.comment.trim()) > LIMITS.comment) errors.comment = RATING_MSG.comment;
  if (length(cleanName(form.rater_name)) > LIMITS.rater) errors.rater_name = RATING_MSG.rater_name;
  return errors;
}

/** Quem avaliou numa linha só: espaços das pontas saem e os do meio viram um. */
function cleanName(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** O corpo do PUT /tickets/{id}/ratings/{technician_id} (depois de ratingProblem): espaços das pontas saem; vazio vira null. */
export function ratingBody(form: RatingForm & { score: number }): TechnicianRatingIn {
  const comment = form.comment.trim();
  const rater = cleanName(form.rater_name);
  return { score: form.score, comment: comment || null, rater_name: rater || null };
}

/** O formulário dá na avaliação gravada (o Salvar fica travado sem mudança); sem avaliação gravada, false. */
export function sameRating(
  form: RatingForm,
  saved: Pick<TechnicianRating, "score" | "comment" | "rater_name"> | null | undefined,
): boolean {
  if (!saved || form.score === null) return false;
  const body = ratingBody({ ...form, score: form.score });
  return body.score === saved.score && body.comment === (saved.comment ?? null) && body.rater_name === (saved.rater_name ?? null);
}

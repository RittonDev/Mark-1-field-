// Avaliação do cliente na central (lib/ratings.ts): a nota em texto, a contagem, a média (igual ao ratingText de
// lib/constants.ts), o rastro de quem registrou e corrigiu, e o formulário do cartão da OS (erros, corpo e "sem
// mudança"). Dados fictícios. Sem dependência nova: node:test com o type stripping do Node 22.
// Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RATING_LIMITS, ratingText } from "../src/lib/constants.ts";
import {
  averageText,
  isLowScore,
  LOW_SCORE,
  NO_RATINGS,
  RATING_MAX,
  RATING_MSG,
  ratingBody,
  ratingFormOf,
  ratingProblem,
  raterText,
  ratingsCountText,
  ratingsSummaryLabel,
  ratingTrail,
  sameRating,
  scoreText,
} from "../src/lib/ratings.ts";

const ANA = { id: "3f2c8a1e-5b7d-4c9a-8e6f-1a2b3c4d5e6f", name: "Analista Exemplo" };
const BIA = { id: "4a3d9b2f-6c8e-4dab-9f70-2b3c4d5e6f70", name: "Supervisora Exemplo" };
/** Datas ISO viram dd/mm/aaaa pelo dia (o formatDate da tela faz isso no fuso da operação). */
const day = (iso) => iso.slice(0, 10).split("-").reverse().join("/");

describe("textos", () => {
  it('scoreText: "{n} de 5"', () => {
    assert.equal(RATING_MAX, 5);
    assert.equal(scoreText(4), "4 de 5");
    assert.equal(scoreText(1), "1 de 5");
    assert.equal(scoreText(5), "5 de 5");
  });

  it("ratingsCountText: singular, plural e milhar", () => {
    assert.equal(ratingsCountText(1), "1 avaliação");
    assert.equal(ratingsCountText(12), "12 avaliações");
    assert.equal(ratingsCountText(0), "0 avaliações");
    assert.equal(ratingsCountText(1234), "1.234 avaliações");
    assert.equal(NO_RATINGS, "Nenhuma avaliação.");
  });

  it("averageText: uma casa com vírgula; sem média, —; igual ao ratingText", () => {
    assert.equal(averageText(4.6), "4,6");
    assert.equal(averageText(4), "4,0");
    assert.equal(averageText(4.3), "4,3");
    assert.equal(averageText(null), "—");
    assert.equal(averageText(undefined), "—");
    for (const n of [1, 1.5, 2.25, 3.9, 4, 4.3, 4.6, 5]) assert.equal(averageText(n), ratingText(n), String(n));
  });

  it("ratingsSummaryLabel: o resumo do leitor de tela", () => {
    assert.equal(ratingsSummaryLabel(4.6, 12), "Média 4,6 de 5, 12 avaliações");
    assert.equal(ratingsSummaryLabel(4, 1), "Média 4,0 de 5, 1 avaliação");
  });

  it("isLowScore: até 2 é problema", () => {
    assert.equal(LOW_SCORE, 2);
    assert.deepEqual([1, 2, 3, 4, 5].map(isLowScore), [true, true, false, false, false]);
  });

  it('raterText: "Avaliado por {nome}"; vazio, null', () => {
    assert.equal(raterText("Gerente Exemplo"), "Avaliado por Gerente Exemplo");
    assert.equal(raterText("  Gerente Exemplo "), "Avaliado por Gerente Exemplo");
    assert.equal(raterText(""), null);
    assert.equal(raterText("   "), null);
    assert.equal(raterText(null), null);
  });

  it("ratingTrail: quem registrou e, se houve, quem corrigiu", () => {
    const base = { created_at: "2026-11-20T13:00:00Z", created_by: ANA, updated_at: "2026-11-20T13:00:00Z", updated_by: null };
    assert.equal(ratingTrail(base, day), "Registrada por Analista Exemplo em 20/11/2026");
    assert.equal(
      ratingTrail({ ...base, updated_at: "2026-11-25T10:00:00Z", updated_by: BIA }, day),
      "Registrada por Analista Exemplo em 20/11/2026 · corrigida por Supervisora Exemplo em 25/11/2026",
    );
    assert.equal(ratingTrail({ ...base, created_by: null }, day), "Registrada em 20/11/2026");
  });
});

describe("formulário da avaliação (cartão da OS)", () => {
  const ok = { score: 4, comment: "Atendimento rápido", rater_name: "Gerente Exemplo" };

  it("os limites batem com lib/constants.ts", () => {
    assert.deepEqual(RATING_LIMITS, { comment: 1000, rater: 120 });
    assert.deepEqual(RATING_MSG, {
      score: "Escolha a nota.",
      comment: "No máximo 1000 caracteres.",
      rater_name: "No máximo 120 caracteres.",
    });
  });

  it("ratingProblem: sem nota", () => {
    assert.deepEqual(ratingProblem({ ...ok, score: null }), { score: "Escolha a nota." });
    for (const score of [0, 6, 2.5, -1]) assert.deepEqual(ratingProblem({ ...ok, score }), { score: "Escolha a nota." }, String(score));
    for (const score of [1, 2, 3, 4, 5]) assert.deepEqual(ratingProblem({ ...ok, score }), {}, String(score));
  });

  it("ratingProblem: 1000 e 120 caracteres passam; 1001 e 121, não", () => {
    assert.deepEqual(ratingProblem({ ...ok, comment: "a".repeat(RATING_LIMITS.comment) }), {});
    assert.deepEqual(ratingProblem({ ...ok, comment: "a".repeat(RATING_LIMITS.comment + 1) }), {
      comment: "No máximo 1000 caracteres.",
    });
    assert.deepEqual(ratingProblem({ ...ok, rater_name: "b".repeat(RATING_LIMITS.rater) }), {});
    assert.deepEqual(ratingProblem({ ...ok, rater_name: "b".repeat(RATING_LIMITS.rater + 1) }), {
      rater_name: "No máximo 120 caracteres.",
    });
    // Os espaços das pontas não contam; um emoji conta um (como o servidor).
    assert.deepEqual(ratingProblem({ ...ok, comment: `  ${"a".repeat(1000)}  ` }), {});
    assert.deepEqual(ratingProblem({ ...ok, comment: "😀".repeat(1000) }), {});
    assert.deepEqual(ratingProblem({ score: null, comment: "a".repeat(1001), rater_name: "b".repeat(121) }), {
      score: "Escolha a nota.",
      comment: "No máximo 1000 caracteres.",
      rater_name: "No máximo 120 caracteres.",
    });
  });

  it("ratingBody: espaços saem; vazio vira null", () => {
    assert.deepEqual(ratingBody(ok), { score: 4, comment: "Atendimento rápido", rater_name: "Gerente Exemplo" });
    assert.deepEqual(ratingBody({ score: 5, comment: "  Ótimo\natendimento  ", rater_name: "  Gerente   Exemplo " }), {
      score: 5,
      comment: "Ótimo\natendimento",
      rater_name: "Gerente Exemplo",
    });
    assert.deepEqual(ratingBody({ score: 3, comment: "   ", rater_name: "" }), { score: 3, comment: null, rater_name: null });
  });

  it("ratingFormOf: vazio ou a avaliação gravada", () => {
    assert.deepEqual(ratingFormOf(null), { score: null, comment: "", rater_name: "" });
    assert.deepEqual(ratingFormOf({ score: 2, comment: null, rater_name: "Gerente Exemplo" }), {
      score: 2,
      comment: "",
      rater_name: "Gerente Exemplo",
    });
  });

  it("sameRating: o formulário igual ao gravado trava o Salvar", () => {
    const saved = { score: 4, comment: "Atendimento rápido", rater_name: null };
    assert.equal(sameRating(ratingFormOf(saved), saved), true);
    assert.equal(sameRating({ score: 4, comment: " Atendimento rápido ", rater_name: "  " }, saved), true);
    assert.equal(sameRating({ score: 5, comment: "Atendimento rápido", rater_name: "" }, saved), false);
    assert.equal(sameRating({ score: 4, comment: "", rater_name: "" }, saved), false);
    assert.equal(sameRating({ score: 4, comment: "Atendimento rápido", rater_name: "Gerente Exemplo" }, saved), false);
    // Sem avaliação gravada (Registrar) ou sem nota: nunca "igual".
    assert.equal(sameRating(ok, null), false);
    assert.equal(sameRating({ score: null, comment: "", rater_name: "" }, saved), false);
  });
});

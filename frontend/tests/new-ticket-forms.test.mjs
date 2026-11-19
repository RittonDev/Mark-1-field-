// Formulários da Nova OS (components/new-ticket/draft.ts): o que vai no POST /tickets. Sem dependência nova:
// node:test com o type stripping do Node 22. Na pasta frontend: node --experimental-strip-types --test "tests/*.test.mjs"
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blankDraft,
  MAX_FORMS,
  openingForms,
  withCategory,
  withFormToggled,
  withLinkedForms,
  withServiceType,
} from "../src/components/new-ticket/draft.ts";

const template = (id, name, extra = {}) => ({
  id,
  name,
  is_active: true,
  service_type_ids: [],
  category_ids: [],
  default_required: true,
  requires_signature: false,
  fields: [],
  ...extra,
});
const serviceType = { id: "tipo-preventiva", name: "Preventiva", category_id: null, estimated_minutes: 60, customer_id: null };
const categories = [
  { id: "cat-mae", parent_id: null, name: "Impressoras", full_name: "Impressoras" },
  { id: "cat-filha", parent_id: "cat-mae", name: "Laser", full_name: "Impressoras > Laser" },
];
const withType = (templates) => withLinkedForms(withServiceType(blankDraft("whatsapp"), serviceType), templates, categories);
/** Pôr à mão e tirar de novo. */
const putAndTake = (d, id) => withFormToggled(withFormToggled(d, id), id);

describe("openingForms", () => {
  it("manda o ligado que o analista desmarcou em forms_left_out", () => {
    const templates = [template("a", "A", { service_type_ids: [serviceType.id] }), template("b", "B", { service_type_ids: [serviceType.id] })];
    const d = withFormToggled(withType(templates), "a");
    assert.deepEqual(openingForms(d, templates, categories), {
      forms: [{ template_id: "b", required: true }],
      forms_left_out: ["a"],
    });
  });

  it("manda também o tirado que a tela não sabe ligado (o vínculo é mais novo que os modelos lidos): a API decide", () => {
    const templates = [template("x", "X")];
    const d = putAndTake(withType(templates), "x");
    assert.deepEqual(openingForms(d, templates, categories), { forms: [], forms_left_out: ["x"] });
  });

  it("sem a lista de categorias, manda o tirado que é da categoria de cima", () => {
    const templates = [template("p", "P", { category_ids: ["cat-mae"] })];
    const d = putAndTake(withLinkedForms(withCategory(blankDraft("whatsapp"), "cat-filha"), templates, undefined), "p");
    assert.deepEqual(openingForms(d, templates, undefined), { forms: [], forms_left_out: ["p"] });
  });

  it("põe primeiro os ligados que a tela conhece e para em 20", () => {
    const linked = ["l0", "l1", "l2"].map((id) => template(id, id.toUpperCase(), { service_type_ids: [serviceType.id] }));
    const loose = Array.from({ length: 25 }, (_, i) => template(`s${i}`, `S${String(i).padStart(2, "0")}`));
    let d = withType([...linked, ...loose]);
    for (const t of loose) d = putAndTake(d, t.id);
    for (const t of linked) d = withFormToggled(d, t.id);
    const { forms_left_out } = openingForms(d, [...linked, ...loose], categories);
    assert.equal(forms_left_out.length, MAX_FORMS);
    assert.deepEqual(forms_left_out.slice(0, 3), ["l0", "l1", "l2"]);
    assert.deepEqual(forms_left_out.slice(3), loose.slice(0, MAX_FORMS - 3).map((t) => t.id));
  });

  it("não manda o que voltou para a lista nem repete", () => {
    const templates = [template("a", "A", { service_type_ids: [serviceType.id] }), template("u", "U")];
    const d = { ...putAndTake(withType(templates), "u"), uncheckedFormIds: ["u", "u", "a"] };
    assert.deepEqual(openingForms(d, templates, categories), {
      forms: [{ template_id: "a", required: true }],
      forms_left_out: ["u"],
    });
  });
});

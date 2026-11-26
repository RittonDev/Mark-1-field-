// Formas de recebimento do técnico (Configurações › Formas de recebimento): as rotas próprias de
// /me/profile/payout-methods (adicionar, editar, tornar preferencial e excluir). Cada pedido leva a senha atual (conta
// invadida não desvia o pagamento), sai na fila das gravações do cadastro (lib/profile.ts, writeProfile) e devolve o
// MyProfile inteiro, que fica na memória. Só online: nada vai para a fila offline, o SQLite, o kv nem o SecureStore. A
// lista não vai no PATCH /me/profile: não reenvia chaves e contas a cada mudança e não traz de volta a que a central
// excluiu. Depois dos erros que dizem que a lista da tela está velha (payoutListStale, em lib/payoutForm.ts), a tela
// relê o cadastro.

import { api, request } from "./api";
import { writeProfile } from "./profile";
import type { MyProfile, PasswordConfirm, PayoutMethodCreate, PayoutMethodIn, PayoutMethodUpdate, UUID } from "./types";

const BASE = "/me/profile/payout-methods";
const pathOf = (id: UUID) => `${BASE}/${encodeURIComponent(id)}`;

/** POST: a primeira é sempre a preferencial; `preferred` passa a preferência para a nova. */
export function addPayoutMethod(input: PayoutMethodIn, options: { preferred: boolean; password: string }): Promise<MyProfile> {
  const body: PayoutMethodCreate = { ...input, preferred: options.preferred, current_password: options.password };
  return writeProfile(() => api.post<MyProfile>(BASE, body));
}

/** PUT: manda tudo de novo (o tipo não muda: PIX continua PIX). */
export function updatePayoutMethod(id: UUID, input: PayoutMethodIn, password: string): Promise<MyProfile> {
  const body: PayoutMethodUpdate = { ...input, current_password: password };
  return writeProfile(() => request<MyProfile>(pathOf(id), { method: "PUT", body }));
}

/** A forma passa a ser onde a central paga (a anterior deixa de ser). */
export function preferPayoutMethod(id: UUID, password: string): Promise<MyProfile> {
  const body: PasswordConfirm = { current_password: password };
  return writeProfile(() => api.post<MyProfile>(`${pathOf(id)}/preferred`, body));
}

/** Exclui (POST, porque leva a senha no corpo); sendo a preferencial, a mais nova das que ficam vira a preferencial. */
export function removePayoutMethod(id: UUID, password: string): Promise<MyProfile> {
  const body: PasswordConfirm = { current_password: password };
  return writeProfile(() => api.post<MyProfile>(`${pathOf(id)}/remove`, body));
}

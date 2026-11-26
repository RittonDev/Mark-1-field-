// Regras do campo de data (components/forms/DateField.tsx) fora do componente: puro e sem import, entra nas sondas de
// mobile/tests.

/**
 * Calendário do iPhone (inline), com as datas "AAAA-MM-DD": o toque num dia do mês à vista muda só o dia (o mesmo mês e
 * ano, outro dia) e fecha o calendário. Trocar o mês ou o ano pelo cabeçalho também muda a data (o mesmo dia em outro
 * mês) e não fecha: a pessoa ainda vai escolher o dia (ou toca em "OK").
 */
export function isDayTap(before: string, after: string): boolean {
  return before.slice(0, 7) === after.slice(0, 7) && before !== after;
}

"""Técnico e modelo nos eventos antigos

Só dados, sem DDL. Preenche dois ids que os eventos antigos guardavam apenas pelo nome:

- Atribuições importadas do Field Control (event_type 'assigned', data.source 'fieldcontrol'):
  ganham data.technician_id, o id do usuário cujo nome é igual ao de to_value, ignorando caixa e
  espaços nas pontas. to_value guarda o nome cortado em 64 letras, então o nome do usuário é
  comparado cortado do mesmo jeito. Só quando um único usuário, de qualquer papel, tem esse nome e
  ele é técnico (papel 'technician'): o nome repetido (também entre um técnico e um usuário de
  escritório, que pode ter sido o colaborador no Field Control), o de quem não é técnico e o sem
  casamento ficam como estão (a busca "técnico que atuou" continua casando esses pelo nome). Com o
  id, a OS migrada não some da busca quando o técnico troca o nome (Meu cadastro, Técnicos) e o
  homônimo não entra nela (services/tickets.py, acted_by_clause).
- Formulários tirados da OS antes dos formulários automáticos (event_type 'form_removed' só com
  data.form_id): ganham data.template_id, o modelo cujo nome é igual ao de from_value (o nome do
  formulário cortado em 64 letras, como o remove_from_ticket antigo gravava), com a mesma regra.
  Assim a remoção feita por uma pessoa antes da subida conta como decisão dela e o modelo não volta
  sozinho para a OS (services/forms.py, left_out).

Cada parte é um UPDATE ... FROM só, sobre os eventos que ainda não têm o id: rodar de novo não muda
nada. Os testes rodam estes mesmos textos (tests/test_acted_by_rename.py).

Revision ID: e4b6d8f0a2c3
Revises: e3d5f7a9b2c4
Create Date: 2026-11-19
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e4b6d8f0a2c3"
down_revision: str | None = "e3d5f7a9b2c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# users.role é VARCHAR com o valor do enum ('technician': app/models/_types.py, str_enum); o CAST
# para text mantém a comparação certa também se a coluna virar um ENUM nativo.
FC_TECHNICIANS = """
UPDATE ticket_events e
   SET data = jsonb_set(e.data, '{technician_id}', to_jsonb(m.id))
  FROM (
        SELECT lower(btrim(left(btrim(u.name), 64))) AS name, min(CAST(u.id AS text)) AS id
          FROM users u
         GROUP BY lower(btrim(left(btrim(u.name), 64)))
        HAVING count(*) = 1 AND bool_and(CAST(u.role AS text) = 'technician')
       ) m
 WHERE e.event_type = 'assigned'
   AND e.data ->> 'source' = 'fieldcontrol'
   AND e.data ->> 'technician_id' IS NULL
   AND lower(btrim(e.to_value)) = m.name
"""

REMOVED_FORMS = """
UPDATE ticket_events e
   SET data = jsonb_set(e.data, '{template_id}', to_jsonb(m.id))
  FROM (
        SELECT lower(btrim(left(btrim(t.name), 64))) AS name, min(CAST(t.id AS text)) AS id
          FROM form_templates t
         GROUP BY lower(btrim(left(btrim(t.name), 64)))
        HAVING count(*) = 1
       ) m
 WHERE e.event_type = 'form_removed'
   AND e.data ->> 'form_id' IS NOT NULL
   AND e.data ->> 'template_id' IS NULL
   AND lower(btrim(e.from_value)) = m.name
"""


def upgrade() -> None:
    op.execute(FC_TECHNICIANS)
    op.execute(REMOVED_FORMS)


def downgrade() -> None:
    # Nada a desfazer: os ids gravados continuam certos e o código anterior não depende da falta
    # deles (a busca casava pelo nome, e a remoção com o modelo só conta como decisão de uma pessoa).
    pass

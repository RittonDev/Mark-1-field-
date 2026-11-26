"""GET /public/cep/{cep}: o endereço do CEP (CepAddress de lib/types.ts, igual na web e no app)."""

from pydantic import BaseModel


class CepOut(BaseModel):
    """`cep` formatado ("01001-000"). CEP geral da cidade: `street` e `district` null. Textos sem
    espaços sobrando; `state` é uma UF que existe."""

    cep: str
    street: str | None = None
    district: str | None = None
    city: str
    state: str

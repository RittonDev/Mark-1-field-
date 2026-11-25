"""Formas de recebimento do técnico parceiro (pago por chamado): chaves PIX e contas bancárias.

Só o próprio técnico cadastra e muda, no app e com a senha (services/payout_methods.py); a central
vê e remove em Pagamentos. Com a lista não vazia, sempre uma é a preferencial (onde a central
paga): o índice único parcial garante no máximo uma, e o serviço promove outra quando a preferencial
sai. A chave fica normalizada (core/pix.py); a agência com 4 números; o documento do titular (CPF
ou CNPJ) sem pontuação. `changed_at` marca a última troca da chave, da conta ou do titular e, com
`preferred_since`, o "Nova" da central. O histórico e o registro do pagamento guardam só o texto
mascarado (core/payout.py).
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import BankAccountType, PayoutMethodKind, PixKeyType
from app.db.base import Base, Timestamps, UUIDPrimaryKey, utcnow
from app.models._types import str_enum


class TechnicianPayoutMethod(UUIDPrimaryKey, Timestamps, Base):
    __tablename__ = "technician_payout_methods"
    __table_args__ = (
        # Uma preferencial por técnico.
        Index(
            "uq_technician_payout_methods_preferred",
            "user_id",
            unique=True,
            postgresql_where=text("preferred"),
        ),
        # A mesma chave ou a mesma conta não entra duas vezes (o serviço também compara a conta sem
        # os zeros à esquerda; os índices ficam de reserva para a gravação simultânea).
        Index(
            "uq_technician_payout_methods_pix",
            "user_id",
            "pix_key_type",
            "pix_key",
            unique=True,
            postgresql_where=text("kind = 'pix'"),
        ),
        Index(
            "uq_technician_payout_methods_bank",
            "user_id",
            "bank_code",
            "branch",
            "account_number",
            "account_digit",
            unique=True,
            postgresql_where=text("kind = 'bank'"),
        ),
        # Os campos do tipo preenchidos, e só no tipo certo.
        CheckConstraint(
            "(kind = 'pix') = (pix_key IS NOT NULL AND pix_key_type IS NOT NULL)",
            name="pix_fields",
        ),
        CheckConstraint(
            "(kind = 'bank') = (bank_code IS NOT NULL AND branch IS NOT NULL"
            " AND account_number IS NOT NULL AND account_digit IS NOT NULL"
            " AND account_type IS NOT NULL)",
            name="bank_fields",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[PayoutMethodKind] = mapped_column(str_enum(PayoutMethodKind))
    # PIX
    pix_key_type: Mapped[PixKeyType | None] = mapped_column(str_enum(PixKeyType))
    pix_key: Mapped[str | None] = mapped_column(String(80))
    # Conta: banco (código de 3 números e o nome), agência (4 números), conta, dígito (número ou X)
    # e o tipo.
    bank_code: Mapped[str | None] = mapped_column(String(3))
    bank_name: Mapped[str | None] = mapped_column(String(80))
    branch: Mapped[str | None] = mapped_column(String(4))
    account_number: Mapped[str | None] = mapped_column(String(20))
    account_digit: Mapped[str | None] = mapped_column(String(1))
    account_type: Mapped[BankAccountType | None] = mapped_column(str_enum(BankAccountType))
    # Titular: nome e CPF ou CNPJ (na chave CPF/CNPJ, a própria chave; null só nas chaves de antes
    # que não são CPF/CNPJ).
    holder_name: Mapped[str] = mapped_column(String(160))
    holder_document: Mapped[str | None] = mapped_column(String(14))
    preferred: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Quando virou a preferencial (null fora dela).
    preferred_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

from enum import StrEnum

from sqlalchemy import Enum as SAEnum


def str_enum(enum_cls: type[StrEnum]) -> SAEnum:
    """Enum guardado como VARCHAR (sem tipo ENUM nativo do Postgres).

    Adicionar um status novo não exige migration de tipo.
    """
    return SAEnum(
        enum_cls,
        native_enum=False,
        length=32,
        values_callable=lambda e: [m.value for m in e],
        validate_strings=True,
    )

class DomainError(Exception):
    """Base dos erros de regra de negócio (mapeados para HTTP em app.main)."""


class WorkflowError(DomainError):
    """Transição inválida ou pré-condição não atendida (HTTP 422)."""


class PermissionDenied(DomainError):
    """Usuário sem permissão para a ação (HTTP 403)."""


class AccessDenied(PermissionDenied):
    """403 com código, para a tela amigável de "sem acesso" (core/permissions.py).

    code: MODULE_FORBIDDEN (tela fora do perfil), QUEUE_FORBIDDEN (OS ou fila de outro analista)
    ou ACCESS_CAP (dar mais acesso do que se tem). Os extras (item, module, required) vão no corpo.
    """

    def __init__(self, message: str, *, code: str, **extra: str) -> None:
        self.code = code
        self.extra = extra
        super().__init__(message)


class NotFound(DomainError):
    """Registro inexistente ou fora do escopo do usuário (HTTP 404)."""


class VersionConflict(DomainError):
    """A OS mudou desde que o cliente a leu (HTTP 409)."""

    def __init__(self, current_version: int | None = None) -> None:
        self.current_version = current_version
        super().__init__("A OS foi alterada por outra pessoa. Recarregue e tente de novo.")


class CodedError(DomainError):
    """Erro de regra com `code` no corpo e o status HTTP dele: app.main responde
    {"detail": mensagem, "code": code}. A web e o app reagem pelo código (LINK_GONE, EMAIL_IN_USE,
    MAIL_DISABLED, CEP_NOT_FOUND, PAYOUT_METHOD_DUPLICATE...) e mostram o `detail`."""

    def __init__(self, message: str, code: str, status_code: int = 422) -> None:
        self.code = code
        self.status_code = status_code
        super().__init__(message)


class OfferError(DomainError):
    """Oferta de OS que não pode mais ser respondida (HTTP 409) ou que o técnico ainda não abriu
    (HTTP 422), com `code` no corpo para o app reagir (services/offers.py)."""

    def __init__(self, message: str, *, code: str, status_code: int = 409) -> None:
        self.code = code
        self.status_code = status_code
        super().__init__(message)


class ScheduleConflict(DomainError):
    """O responsável já tem OS no horário (HTTP 409, code SCHEDULE_CONFLICT)."""

    def __init__(self, message: str, conflicts: list[dict]) -> None:
        self.conflicts = conflicts
        super().__init__(message)

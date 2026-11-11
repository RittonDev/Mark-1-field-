class DomainError(Exception):
    """Base dos erros de regra de negócio (mapeados para HTTP em app.main)."""


class WorkflowError(DomainError):
    """Transição inválida ou pré-condição não atendida (HTTP 422)."""


class PermissionDenied(DomainError):
    """Usuário sem permissão para a ação (HTTP 403)."""


class NotFound(DomainError):
    """Registro inexistente ou fora do escopo do usuário (HTTP 404)."""


class VersionConflict(DomainError):
    """A OS mudou desde que o cliente a leu (HTTP 409)."""

    def __init__(self, current_version: int | None = None) -> None:
        self.current_version = current_version
        super().__init__("A OS foi alterada por outra pessoa. Recarregue e tente de novo.")

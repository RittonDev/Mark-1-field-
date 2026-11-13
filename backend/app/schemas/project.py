import datetime as dt
import uuid
from decimal import Decimal

from pydantic import BaseModel, Field, computed_field

from app.core.enums import ProjectStatus
from app.schemas.common import Ref
from app.schemas.expense import Money


class ProjectIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    customer_id: uuid.UUID | None = None
    description: str | None = Field(default=None, max_length=5000)
    status: ProjectStatus = ProjectStatus.ACTIVE
    start_date: dt.date | None = None
    end_date: dt.date | None = None
    contract_value: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    pricing_notes: str | None = Field(default=None, max_length=5000)
    manager_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    member_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)


class ProjectStats(BaseModel):
    tickets_total: int = 0
    tickets_open: int = 0
    tickets_done: int = 0
    # OS canceladas contam no total, mas não no progresso (não vão ser feitas).
    tickets_cancelled: int = 0
    unproductive: int = 0
    expenses_total: Money = Decimal("0")
    # Valores por chamado dos técnicos parceiros (pagos ou não): o principal custo do projeto.
    payouts_total: Money = Decimal("0")
    quotes_approved_total: Money = Decimal("0")

    @computed_field  # type: ignore[prop-decorator]
    @property
    def progress(self) -> float:
        """Concluídas sobre as que ainda valem (o total sem as canceladas)."""
        planned = self.tickets_total - self.tickets_cancelled
        return round(self.tickets_done / planned, 3) if planned > 0 else 0.0


class ProjectOut(BaseModel):
    id: uuid.UUID
    number: int
    name: str
    customer: Ref | None
    description: str | None
    status: ProjectStatus
    start_date: dt.date | None
    end_date: dt.date | None
    contract_value: Money | None
    pricing_notes: str | None
    manager: Ref | None
    team: Ref | None
    members: list[Ref]
    stats: ProjectStats
    created_at: dt.datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return f"PRJ-{self.number:04d}"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def margin(self) -> float | None:
        """Valor do contrato menos os custos extras e os valores dos técnicos nas OS do projeto."""
        if self.contract_value is None:
            return None
        return float(self.contract_value - self.stats.expenses_total - self.stats.payouts_total)

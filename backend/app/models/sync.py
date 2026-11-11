import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import DevicePlatform
from app.db.base import Base, Timestamps, UUIDPrimaryKey, created_at_column
from app.models._types import str_enum


class DeviceToken(UUIDPrimaryKey, Timestamps, Base):
    """Token de push (FCM / APNs) de um aparelho do técnico."""

    __tablename__ = "device_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    platform: Mapped[DevicePlatform] = mapped_column(str_enum(DevicePlatform))
    token: Mapped[str] = mapped_column(String(512), unique=True)
    app_version: Mapped[str | None] = mapped_column(String(40))
    last_seen_at: Mapped[datetime] = created_at_column()


class SyncOperation(UUIDPrimaryKey, Base):
    """Operação offline enviada pelo app. Garante idempotência por `client_op_id`."""

    __tablename__ = "sync_operations"
    __table_args__ = (
        UniqueConstraint("user_id", "client_op_id", name="uq_sync_operations_user_op"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    client_op_id: Mapped[str] = mapped_column(String(64))
    op_type: Mapped[str] = mapped_column(String(32))
    ticket_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("tickets.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(16))  # applied | rejected | conflict
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = created_at_column()

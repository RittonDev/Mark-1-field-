"""Documentos do técnico: certificações (com validade opcional), documentos pessoais, o currículo e
os anexos internos da central (contrato da Entrega 2, §6.3, §6.4 e §6.8).

Quem vê e mexe:
- o técnico, no app (/me/profile/documents*): os próprios certificação, pessoal e currículo, de
  qualquer `via`; o anexo interno nunca chega a ele (404);
- a central (Técnicos): os quatro tipos; o anexo interno só com Técnicos Editar (nem na lista sem
  ele);
- a ficha da homologação: depois do envio, com o `upload_token` de 2 h, os três tipos do técnico;
  a aprovação passa os mesmos registros ao técnico (`user_id`), sem copiar arquivo.

O arquivo segue o pipeline da nota fiscal: o tipo pelo conteúdo (PDF, JPG, PNG ou WebP; GIF, HEIC,
XML e HTML ficam fora, também com a extensão trocada), até 10 MB, o nome limpo e o link assinado de
30 min (foto abre na tela, PDF baixa). Pastas: documents/{user_id}/ e
documents/fichas/{application_id}/ (a aprovação não move).

Versões com id estável: substituir copia o arquivo de antes para uma linha de versão
(`version_of_id`, `replaced_at` agora, `client_upload_id` null) e grava o novo no próprio documento,
que mantém o id (`uploaded_*` agora); ficam as 3 versões mais novas, a mais antiga além disso sai do
banco e do disco. Excluir leva as versões (FK em cascata; as chaves são lidas antes). O currículo é um
só: enviar outro substitui. Arquivo sai do disco só depois do commit; o commit do envio falhou, o
arquivo novo sai (a rota cuida).

Uma gravação por vez de cada dono (trava `technician-documents:{user_id | application_id}`): o mesmo
envio repetido (`client_upload_id` do mesmo dono) devolve o mesmo documento, e os limites (30
certificações e documentos pessoais, 30 anexos internos, 10 arquivos por ficha) são conferidos
lendo o banco antes de gravar.

Histórico do cadastro (campo `documents` ou `internal_attachments`; a central sem Técnicos Editar lê
"***" nos anexos internos): "incluiu Certificação NR10 (vence 10/12/2027)", "substituiu o arquivo de
Currículo", "renomeou Certificação NR10 → NR35", "mudou a validade de Certificação NR10: sem
validade → 10/12/2027", "excluiu Documento pessoal RG". A ficha ainda sem técnico não tem histórico;
a aprovação devolve um item por arquivo para a linha "Aprovado na homologação".
"""

import re
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import PurePosixPath
from typing import Any, Literal, cast

from fastapi import UploadFile
from sqlalchemy import ColumnElement, delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import text as text_utils
from app.core.config import settings
from app.core.enums import ApplicationStatus, OperationalStatus, TechDocumentKind, UserRole
from app.core.security import InvalidToken, create_token, decode_token
from app.db.base import utcnow
from app.models import TechnicianApplication, TechnicianDocument, User
from app.schemas.common import Ref
from app.schemas.personal import local_today
from app.schemas.technician_document import (
    CertificationDueOut,
    DocumentLinkOut,
    FichaDocumentOut,
    MyDocumentOut,
    TechDocumentFileOut,
    TechDocumentOut,
    TechDocumentUpdate,
    TechDocumentVia,
    TechnicianDocumentKind,
)
from app.services import storage, user_history
from app.services.errors import CodedError, WorkflowError

# Limites (= DOCUMENT_LIMITS e DOCUMENT_WARN_DAYS de constants.ts).
MAX_MB = 10
LINK_MINUTES = 30
TITLE_MIN, TITLE_MAX = 2, 80
# Certificações e documentos pessoais atuais por técnico (o currículo é um só e não conta).
PER_TECHNICIAN = 30
# Anexos internos atuais por técnico.
INTERNAL_MAX = 30
# Arquivos atuais por ficha da homologação.
PER_FICHA = 10
# Versões anteriores guardadas de cada documento.
VERSIONS = 3
# O aviso de vencimento: vencidas e as que vencem até hoje + 30.
WARN_DAYS = 30
# Validade: de 2000-01-01 a hoje + 20 anos (fuso da operação).
FIRST_DAY = date(2000, 1, 1)
YEARS_AHEAD = 20
# O upload_token da ficha enviada e os envios por hora (app: por técnico; ficha: por IP).
FICHA_UPLOAD_HOURS = 2
UPLOADS_PER_HOUR = 30
UPLOAD_WINDOW_SECONDS = 3600
APP_RATE_SCOPE = "documents-user"
FICHA_RATE_SCOPE = "ficha-documents-ip"

CERTIFICATION = TechDocumentKind.CERTIFICATION
PERSONAL = TechDocumentKind.PERSONAL
RESUME = TechDocumentKind.RESUME
INTERNAL = TechDocumentKind.INTERNAL
# O que o técnico envia e vê (app e ficha); a central, os quatro.
TECHNICIAN_KINDS: tuple[TechDocumentKind, ...] = (CERTIFICATION, PERSONAL, RESUME)
ALL_KINDS: tuple[TechDocumentKind, ...] = (*TECHNICIAN_KINDS, INTERNAL)
# = DOCUMENT_KIND de constants.ts.
KIND_LABEL: dict[TechDocumentKind, str] = {
    CERTIFICATION: "Certificação",
    PERSONAL: "Documento pessoal",
    RESUME: "Currículo",
    INTERNAL: "Anexo interno",
}
_KIND_ORDER = {kind: index for index, kind in enumerate(ALL_KINDS)}
RESUME_TITLE = "Currículo"

# O tipo pelo conteúdo (storage.sniff_document): PDF ou foto. XML e GIF não são documento.
ALLOWED_TYPES = frozenset({"application/pdf", "image/jpeg", "image/png", "image/webp"})

# Campos do histórico do cadastro.
DOCUMENTS_FIELD = "documents"
INTERNAL_FIELD = "internal_attachments"

NO_FILE = "Escolha o arquivo"
EMPTY_FILE = "O arquivo está vazio"
BAD_TYPE = "Envie PDF ou foto (JPG, PNG ou WebP)"
NO_KIND = "Escolha o tipo do documento"
NO_TITLE = "Informe o título"
LONG_TITLE = f"O título tem no máximo {TITLE_MAX} caracteres"
EXPIRY_ONLY_CERTIFICATION = "Só a certificação tem validade"
BAD_EXPIRY = "Confira a validade"
DOCUMENTS_LIMIT = (
    f"Limite de {PER_TECHNICIAN} documentos e certificações. Exclua um para enviar outro"
)
INTERNAL_LIMIT = f"Limite de {INTERNAL_MAX} anexos internos. Exclua um para enviar outro"
NOT_FOUND = "Este documento não existe mais. Atualize a lista"
BAD_UPLOAD = "Envio inválido: atualize e tente de novo"
FICHA_GONE = (
    "O prazo para enviar arquivos desta ficha acabou. Fale com a central pelo WhatsApp"
)
FICHA_NOT_PENDING = "A ficha já foi analisada. Fale com a central pelo WhatsApp"
FICHA_LIMIT = f"Limite de {PER_FICHA} arquivos na ficha"
TOO_MANY = "Muitos arquivos enviados. Tente mais tarde"
LINK_EXPIRED = "Link expirado"
LINK_INVALID = "Link inválido"
NO_EXPIRY_TEXT = "sem validade"

_DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

ExpiryStatus = Literal["expired", "soon", "ok"]


class _Keep:
    """Substituir sem o campo: fica o valor de antes."""


KEEP = _Keep()


# --------------------------------------------------------------------------- datas e textos


def current_day() -> date:
    """Hoje no fuso da operação."""
    return local_today()


def last_expiry_day(day: date) -> date:
    """A maior validade aceita: hoje + 20 anos (o 29/02 vira 28/02)."""
    try:
        return day.replace(year=day.year + YEARS_AHEAD)
    except ValueError:
        return day.replace(year=day.year + YEARS_AHEAD, day=28)


def expiry_status(expires_on: date | None, today: date) -> ExpiryStatus | None:
    """Antes de hoje: "expired"; de hoje a hoje + 30: "soon"; depois: "ok". Sem validade: None."""
    if expires_on is None:
        return None
    if expires_on < today:
        return "expired"
    if expires_on <= today + timedelta(days=WARN_DAYS):
        return "soon"
    return "ok"


def day_text(day: date) -> str:
    return f"{day.day:02d}/{day.month:02d}/{day.year:04d}"


def document_name(kind: TechDocumentKind, title: str) -> str:
    """ "{Tipo} {título}" ("Certificação NR10"); o currículo é só "Currículo"."""
    if kind == RESUME:
        return KIND_LABEL[RESUME]
    return f"{KIND_LABEL[kind]} {title}"


def _due_suffix(expires_on: date | None) -> str:
    return f" (vence {day_text(expires_on)})" if expires_on is not None else ""


def _expiry_text(expires_on: date | None) -> str:
    return day_text(expires_on) if expires_on is not None else NO_EXPIRY_TEXT


def _item(kind: TechDocumentKind, phrase: str) -> dict[str, Any]:
    """Um item do histórico do cadastro (`from` null, `to` = a frase)."""
    field_name = INTERNAL_FIELD if kind == INTERNAL else DOCUMENTS_FIELD
    return {"field": field_name, "from": None, "to": phrase}


# --------------------------------------------------------------------------- campos do envio


def read_kind(raw: str | None, kinds: Iterable[TechDocumentKind]) -> TechDocumentKind:
    """O tipo entre os que quem envia pode usar ("internal" do app ou da ficha: o mesmo erro)."""
    value = (raw or "").strip()
    for kind in kinds:
        if value == kind.value:
            return kind
    raise WorkflowError(NO_KIND)


def read_title(raw: str | None, kind: TechDocumentKind) -> str:
    """Limpo, de 2 a 80; o currículo é sempre "Currículo"."""
    if kind == RESUME:
        return RESUME_TITLE
    title = text_utils.clean(raw)
    if len(title) < TITLE_MIN:
        raise WorkflowError(NO_TITLE)
    if len(title) > TITLE_MAX:
        raise WorkflowError(LONG_TITLE)
    return title


def read_expiry(raw: str | None, kind: TechDocumentKind, today: date) -> date | None:
    """ "AAAA-MM-DD" de 2000-01-01 a hoje + 20 anos, só na certificação. Vazio: sem validade."""
    value = (raw or "").strip()
    if not value:
        return None
    if kind != CERTIFICATION:
        raise WorkflowError(EXPIRY_ONLY_CERTIFICATION)
    if _DAY_RE.fullmatch(value) is None:
        raise WorkflowError(BAD_EXPIRY)
    try:
        day = date.fromisoformat(value)
    except ValueError as exc:
        raise WorkflowError(BAD_EXPIRY) from exc
    if not FIRST_DAY <= day <= last_expiry_day(today):
        raise WorkflowError(BAD_EXPIRY)
    return day


def read_upload_id(raw: str | None) -> uuid.UUID | None:
    """A chave do envio (o app e a ficha geram uma por arquivo). Estragada: 422."""
    value = (raw or "").strip()
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise WorkflowError(BAD_UPLOAD) from exc


async def _sniff(upload: UploadFile) -> str:
    """O tipo real pelo começo do arquivo (não pelo nome nem pelo que o aparelho declarou)."""
    head = await upload.read(1024)
    await upload.seek(0)
    if not head:
        raise WorkflowError(EMPTY_FILE)
    content_type = storage.sniff_document(head)
    if content_type not in ALLOWED_TYPES:
        raise WorkflowError(BAD_TYPE)
    return content_type


def _file_name(upload: UploadFile) -> str:
    """O nome como na nota fiscal (sem a pasta), sem controles nem formatação, até 255."""
    name = PurePosixPath((upload.filename or "").replace("\\", "/")).name
    return (text_utils.clean(name) or "arquivo")[:255]


async def _save(upload: UploadFile, folder: str) -> tuple[str, int]:
    try:
        return await storage.save_upload_in(folder, upload, max_mb=MAX_MB)
    except storage.UploadTooLarge as exc:
        raise WorkflowError(str(exc)) from exc


def remove_files(keys: Iterable[str | None]) -> None:
    """Depois do commit: os arquivos que saíram (versões além de 3, documentos excluídos, a ficha
    apagada com a foto) saem do disco. Falha do disco fica no log (storage.delete)."""
    for key in keys:
        if key:
            storage.delete(key)


# --------------------------------------------------------------------------- dono e trava


@dataclass(frozen=True)
class Owner:
    """De quem é o documento: o técnico ou, antes da aprovação, a ficha."""

    user: User | None = None
    application: TechnicianApplication | None = None

    @property
    def key(self) -> str:
        return f"technician-documents:{self._id}"

    @property
    def _id(self) -> uuid.UUID:
        if self.user is not None:
            return self.user.id
        assert self.application is not None
        return self.application.id

    @property
    def folder(self) -> str:
        if self.user is not None:
            return f"documents/{self.user.id}"
        return f"documents/fichas/{self._id}"

    def condition(self) -> ColumnElement[bool]:
        if self.user is not None:
            return TechnicianDocument.user_id == self.user.id
        return TechnicianDocument.application_id == self._id

    def owns(self, doc: TechnicianDocument) -> bool:
        if self.user is not None:
            return doc.user_id == self.user.id
        return doc.application_id == self._id


async def _lock(db: AsyncSession, owner: Owner) -> None:
    """Uma gravação por vez de cada dono, até o fim da transação."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": owner.key}
    )


@dataclass
class Saved:
    """O que a gravação fez: o documento (None na exclusão), se nasceu agora (201), as mudanças do
    histórico do cadastro (vazio: nada a avisar), o arquivo gravado agora (sai se o commit falhar) e
    os arquivos que saem do disco depois do commit."""

    document: TechnicianDocument | None
    created: bool = False
    changes: list[dict[str, Any]] = field(default_factory=list)
    new_key: str | None = None
    drop: list[str] = field(default_factory=list)


def _not_found() -> CodedError:
    return CodedError(NOT_FOUND, "DOCUMENT_NOT_FOUND", 404)


async def _current(
    db: AsyncSession, owner: Owner, document_id: uuid.UUID, kinds: Sequence[TechDocumentKind]
) -> TechnicianDocument:
    """O documento atual do dono (relido do banco); versão, de outro dono ou de tipo que quem pede
    não vê: 404 DOCUMENT_NOT_FOUND."""
    doc = await db.scalar(
        select(TechnicianDocument)
        .where(
            TechnicianDocument.id == document_id,
            TechnicianDocument.version_of_id.is_(None),
            owner.condition(),
        )
        .execution_options(populate_existing=True)
    )
    if doc is None or doc.kind not in kinds:
        raise _not_found()
    return doc


async def _by_upload_id(
    db: AsyncSession, owner: Owner, upload_id: uuid.UUID | None
) -> TechnicianDocument | None:
    """O documento já gravado com esta chave de envio; de outro dono, 422."""
    if upload_id is None:
        return None
    doc = await db.scalar(
        select(TechnicianDocument)
        .where(TechnicianDocument.client_upload_id == upload_id)
        .execution_options(populate_existing=True)
    )
    if doc is None:
        return None
    if not owner.owns(doc) or doc.version_of_id is not None:
        raise WorkflowError(BAD_UPLOAD)
    return doc


async def _check_limit(db: AsyncSession, owner: Owner, kind: TechDocumentKind) -> None:
    """Antes de um documento novo (substituir não conta)."""
    current = TechnicianDocument.version_of_id.is_(None)
    count = select(func.count()).select_from(TechnicianDocument).where(owner.condition(), current)
    if owner.user is None:
        if (await db.scalar(count) or 0) >= PER_FICHA:
            raise CodedError(FICHA_LIMIT, "FICHA_DOCUMENTS_LIMIT", 422)
        return
    if kind == INTERNAL:
        if (await db.scalar(count.where(TechnicianDocument.kind == INTERNAL)) or 0) >= INTERNAL_MAX:
            raise CodedError(INTERNAL_LIMIT, "INTERNAL_LIMIT", 422)
    elif kind in (CERTIFICATION, PERSONAL):
        counted = count.where(TechnicianDocument.kind.in_((CERTIFICATION, PERSONAL)))
        if (await db.scalar(counted) or 0) >= PER_TECHNICIAN:
            raise CodedError(DOCUMENTS_LIMIT, "DOCUMENTS_LIMIT", 422)


def _record(
    db: AsyncSession,
    owner: Owner,
    changes: list[dict[str, Any]],
    *,
    actor: User | None,
    via: str,
) -> list[dict[str, Any]]:
    """O histórico do cadastro (a ficha ainda sem técnico não tem). Devolve o que gravou."""
    if owner.user is None or not changes:
        return []
    user_history.record(db, owner.user, changes, via=via, actor=actor)
    return changes


# --------------------------------------------------------------------------- gravação


async def add(
    db: AsyncSession,
    owner: Owner,
    upload: UploadFile | None,
    *,
    kind: str | None,
    title: str | None,
    expires_on: str | None,
    client_upload_id: str | None,
    kinds: Sequence[TechDocumentKind],
    actor: User | None,
    via: str,
) -> Saved:
    """Enviar (os campos do multipart, em texto). A mesma `client_upload_id` do mesmo dono devolve o
    documento já gravado sem gravar nada (`created` falso, sem mudanças); de outro dono, 422. O
    currículo com um atual substitui o arquivo dele. Tudo no banco é conferido antes de gravar o
    arquivo; se a gravação no banco falhar depois, o arquivo sai do disco (a rota faz o mesmo se o
    commit falhar: `new_key`)."""
    if upload is None:
        raise WorkflowError(NO_FILE)
    picked = read_kind(kind, kinds)
    clean_title = read_title(title, picked)
    expiry = read_expiry(expires_on, picked, current_day())
    upload_id = read_upload_id(client_upload_id)
    content_type = await _sniff(upload)
    await _lock(db, owner)
    existing = await _by_upload_id(db, owner, upload_id)
    if existing is not None:
        if existing.kind not in kinds:
            raise WorkflowError(BAD_UPLOAD)
        return Saved(document=existing)
    if picked == RESUME:
        resume = await db.scalar(
            select(TechnicianDocument)
            .where(
                owner.condition(),
                TechnicianDocument.kind == RESUME,
                TechnicianDocument.version_of_id.is_(None),
            )
            .order_by(TechnicianDocument.created_at, TechnicianDocument.id)
            .limit(1)
            .execution_options(populate_existing=True)
        )
        if resume is not None:
            return await _replace(
                db,
                owner,
                resume,
                upload,
                content_type,
                title=None,
                expires_on=KEEP,
                upload_id=upload_id,
                actor=actor,
                via=via,
            )
    await _check_limit(db, owner, picked)
    storage_key, size = await _save(upload, owner.folder)
    doc = TechnicianDocument(
        id=uuid.uuid4(),
        user_id=owner.user.id if owner.user is not None else None,
        application_id=owner.application.id if owner.application is not None else None,
        version_of_id=None,
        kind=picked,
        title=clean_title,
        expires_on=expiry,
        file_name=_file_name(upload),
        content_type=content_type,
        size_bytes=size,
        storage_key=storage_key,
        uploaded_at=utcnow(),
        uploaded_by_id=actor.id if actor is not None else None,
        uploaded_via=via,
        replaced_at=None,
        client_upload_id=upload_id,
    )
    try:
        db.add(doc)
        await db.flush()
    except BaseException:
        storage.delete(storage_key)
        raise
    phrase = f"incluiu {document_name(picked, clean_title)}{_due_suffix(expiry)}"
    changes = _record(db, owner, [_item(picked, phrase)], actor=actor, via=via)
    return Saved(document=doc, created=True, changes=changes, new_key=storage_key)


async def _prune(db: AsyncSession, document_id: uuid.UUID) -> list[str]:
    """Só as VERSIONS versões mais novas ficam; as outras saem do banco (o arquivo, depois do
    commit: as chaves voltam)."""
    rows = (
        await db.execute(
            select(TechnicianDocument.id, TechnicianDocument.storage_key)
            .where(TechnicianDocument.version_of_id == document_id)
            .order_by(
                TechnicianDocument.replaced_at.desc(),
                TechnicianDocument.created_at.desc(),
                TechnicianDocument.id.desc(),
            )
        )
    ).all()
    extra = rows[VERSIONS:]
    if not extra:
        return []
    await db.execute(
        delete(TechnicianDocument)
        .where(TechnicianDocument.id.in_([row_id for row_id, _ in extra]))
        .execution_options(synchronize_session=False)
    )
    return [key for _, key in extra]


async def _replace(
    db: AsyncSession,
    owner: Owner,
    doc: TechnicianDocument,
    upload: UploadFile,
    content_type: str,
    *,
    title: str | None,
    expires_on: date | None | _Keep,
    upload_id: uuid.UUID | None,
    actor: User | None,
    via: str,
) -> Saved:
    """O arquivo atual vai para uma linha de versão e o documento (mesmo id) recebe o novo. `title`
    None e `expires_on` KEEP mantêm o que havia."""
    storage_key, size = await _save(upload, owner.folder)
    now = utcnow()
    old_title, old_expiry = doc.title, doc.expires_on
    version = TechnicianDocument(
        id=uuid.uuid4(),
        user_id=doc.user_id,
        application_id=doc.application_id,
        version_of_id=doc.id,
        kind=doc.kind,
        title=doc.title,
        expires_on=doc.expires_on,
        file_name=doc.file_name,
        content_type=doc.content_type,
        size_bytes=doc.size_bytes,
        storage_key=doc.storage_key,
        uploaded_at=doc.uploaded_at,
        uploaded_by_id=doc.uploaded_by_id,
        uploaded_via=doc.uploaded_via,
        replaced_at=now,
        client_upload_id=None,
    )
    doc.file_name = _file_name(upload)
    doc.content_type = content_type
    doc.size_bytes = size
    doc.storage_key = storage_key
    doc.uploaded_at = now
    doc.uploaded_by_id = actor.id if actor is not None else None
    doc.uploaded_via = via
    doc.client_upload_id = upload_id
    if title is not None:
        doc.title = title
    if not isinstance(expires_on, _Keep):
        doc.expires_on = expires_on
    try:
        db.add(version)
        await db.flush()
        drop = await _prune(db, doc.id)
    except BaseException:
        storage.delete(storage_key)
        raise
    items: list[dict[str, Any]] = []
    if doc.title != old_title:
        label = KIND_LABEL[doc.kind]
        items.append(_item(doc.kind, f"renomeou {label} {old_title} → {doc.title}"))
    phrase = f"substituiu o arquivo de {document_name(doc.kind, doc.title)}"
    if doc.expires_on != old_expiry:
        phrase += _due_suffix(doc.expires_on) or f" ({NO_EXPIRY_TEXT})"
    items.append(_item(doc.kind, phrase))
    changes = _record(db, owner, items, actor=actor, via=via)
    return Saved(document=doc, changes=changes, new_key=storage_key, drop=drop)


async def replace(
    db: AsyncSession,
    owner: Owner,
    document_id: uuid.UUID,
    upload: UploadFile | None,
    *,
    title: str | None,
    expires_on: str | None,
    client_upload_id: str | None,
    kinds: Sequence[TechDocumentKind],
    actor: User | None,
    via: str,
) -> Saved:
    """Substituir o arquivo (o tipo não muda). `title` e `expires_on` ausentes mantêm; `expires_on`
    "" tira a validade. O mesmo envio de novo (`client_upload_id` já gravado neste documento)
    devolve o documento sem gravar nada."""
    if upload is None:
        raise WorkflowError(NO_FILE)
    upload_id = read_upload_id(client_upload_id)
    content_type = await _sniff(upload)
    await _lock(db, owner)
    doc = await _current(db, owner, document_id, kinds)
    existing = await _by_upload_id(db, owner, upload_id)
    if existing is not None:
        if existing.id != doc.id:
            raise WorkflowError(BAD_UPLOAD)
        return Saved(document=doc)
    new_title = None if title is None else read_title(title, doc.kind)
    new_expiry: date | None | _Keep = (
        KEEP if expires_on is None else read_expiry(expires_on, doc.kind, current_day())
    )
    return await _replace(
        db,
        owner,
        doc,
        upload,
        content_type,
        title=new_title,
        expires_on=new_expiry,
        upload_id=upload_id,
        actor=actor,
        via=via,
    )


async def edit(
    db: AsyncSession,
    owner: Owner,
    document_id: uuid.UUID,
    data: TechDocumentUpdate,
    *,
    kinds: Sequence[TechDocumentKind],
    actor: User | None,
    via: str,
) -> Saved:
    """Título e validade, sem arquivo (o tipo nunca muda). Só o que vem muda; `expires_on` null ou
    "" tira a validade. Nada diferente: sem gravação nem histórico."""
    await _lock(db, owner)
    doc = await _current(db, owner, document_id, kinds)
    sent = data.model_fields_set
    new_title = doc.title
    if "title" in sent and data.title is not None:
        new_title = read_title(data.title, doc.kind)
    new_expiry = doc.expires_on
    if "expires_on" in sent:
        new_expiry = read_expiry(data.expires_on, doc.kind, current_day())
    items: list[dict[str, Any]] = []
    label = KIND_LABEL[doc.kind]
    if new_title != doc.title:
        items.append(_item(doc.kind, f"renomeou {label} {doc.title} → {new_title}"))
    if new_expiry != doc.expires_on:
        name = document_name(doc.kind, new_title)
        before, after = _expiry_text(doc.expires_on), _expiry_text(new_expiry)
        items.append(_item(doc.kind, f"mudou a validade de {name}: {before} → {after}"))
    if not items:
        return Saved(document=doc)
    doc.title = new_title
    doc.expires_on = new_expiry
    await db.flush()
    return Saved(document=doc, changes=_record(db, owner, items, actor=actor, via=via))


async def remove(
    db: AsyncSession,
    owner: Owner,
    document_id: uuid.UUID,
    *,
    kinds: Sequence[TechDocumentKind],
    actor: User | None,
    via: str,
) -> Saved:
    """Exclui o documento e as versões (FK em cascata). Os arquivos (lidos antes) saem do disco
    depois do commit (`drop`)."""
    await _lock(db, owner)
    doc = await _current(db, owner, document_id, kinds)
    keys = list(
        await db.scalars(
            select(TechnicianDocument.storage_key).where(
                (TechnicianDocument.id == doc.id) | (TechnicianDocument.version_of_id == doc.id)
            )
        )
    )
    phrase = f"excluiu {document_name(doc.kind, doc.title)}"
    kind = doc.kind
    await db.delete(doc)
    await db.flush()
    changes = _record(db, owner, [_item(kind, phrase)], actor=actor, via=via)
    return Saved(document=None, changes=changes, drop=keys)


# --------------------------------------------------------------------------- leituras


def _order_key(doc: TechnicianDocument) -> tuple[Any, ...]:
    """Certificação (a validade mais próxima primeiro; sem validade por último), pessoal, currículo,
    interno; dentro, o título sem acento e sem maiúsculas."""
    no_expiry = doc.kind != CERTIFICATION or doc.expires_on is None
    expiry = date.max if no_expiry or doc.expires_on is None else doc.expires_on
    return (_KIND_ORDER[doc.kind], no_expiry, expiry, text_utils.fold(doc.title), str(doc.id))


async def _currents(
    db: AsyncSession, condition: ColumnElement[bool], kinds: Sequence[TechDocumentKind]
) -> list[TechnicianDocument]:
    rows = await db.scalars(
        select(TechnicianDocument)
        .where(
            condition,
            TechnicianDocument.version_of_id.is_(None),
            TechnicianDocument.kind.in_(kinds),
        )
        .execution_options(populate_existing=True)
    )
    return sorted(rows, key=_order_key)


async def _versions(
    db: AsyncSession, document_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[TechnicianDocument]]:
    """As versões de cada documento, a mais nova primeiro."""
    out: dict[uuid.UUID, list[TechnicianDocument]] = {i: [] for i in document_ids}
    if not document_ids:
        return out
    rows = await db.scalars(
        select(TechnicianDocument)
        .where(TechnicianDocument.version_of_id.in_(list(document_ids)))
        .order_by(
            TechnicianDocument.replaced_at.desc(),
            TechnicianDocument.created_at.desc(),
            TechnicianDocument.id.desc(),
        )
        .execution_options(populate_existing=True)
    )
    for version in rows:
        if version.version_of_id is not None:
            out.setdefault(version.version_of_id, []).append(version)
    return out


def download_url(file_id: uuid.UUID, viewer_id: uuid.UUID | None) -> str:
    """Link assinado de 30 min para o arquivo (o documento ou uma versão; o uid diz quem pediu)."""
    extra = {"uid": str(viewer_id)} if viewer_id is not None else None
    token = create_token(
        f"document:{file_id}", "download", timedelta(minutes=LINK_MINUTES), extra
    )
    return f"{settings.API_PREFIX}/technician-documents/{file_id}/download?token={token}"


def _via(value: str) -> TechDocumentVia:
    return cast(TechDocumentVia, value)


def my_out(doc: TechnicianDocument) -> MyDocumentOut:
    return MyDocumentOut(
        id=doc.id,
        kind=cast(TechnicianDocumentKind, doc.kind.value),
        title=doc.title,
        expires_on=doc.expires_on,
        file_name=doc.file_name,
        content_type=doc.content_type,
        size=doc.size_bytes,
        uploaded_at=doc.uploaded_at,
        via=_via(doc.uploaded_via),
    )


def _file_out(doc: TechnicianDocument, viewer_id: uuid.UUID | None) -> TechDocumentFileOut:
    by = doc.uploaded_by
    return TechDocumentFileOut(
        id=doc.id,
        file_name=doc.file_name,
        content_type=doc.content_type,
        size=doc.size_bytes,
        uploaded_at=doc.uploaded_at,
        uploaded_by=Ref(id=by.id, name=by.name) if by is not None else None,
        via=_via(doc.uploaded_via),
        url=download_url(doc.id, viewer_id),
    )


def tech_out(
    doc: TechnicianDocument, versions: list[TechnicianDocument], viewer_id: uuid.UUID | None
) -> TechDocumentOut:
    return TechDocumentOut(
        id=doc.id,
        kind=doc.kind,
        title=doc.title,
        expires_on=doc.expires_on,
        file=_file_out(doc, viewer_id),
        previous=[_file_out(version, viewer_id) for version in versions],
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


def ficha_out(doc: TechnicianDocument) -> FichaDocumentOut:
    return FichaDocumentOut(
        id=doc.id,
        kind=cast(TechnicianDocumentKind, doc.kind.value),
        title=doc.title,
        expires_on=doc.expires_on,
        file_name=doc.file_name,
        size=doc.size_bytes,
    )


async def _central_list(
    db: AsyncSession,
    condition: ColumnElement[bool],
    kinds: Sequence[TechDocumentKind],
    viewer: User | None,
) -> list[TechDocumentOut]:
    docs = await _currents(db, condition, kinds)
    versions = await _versions(db, [doc.id for doc in docs])
    viewer_id = viewer.id if viewer is not None else None
    return [tech_out(doc, versions[doc.id], viewer_id) for doc in docs]


async def my_documents(db: AsyncSession, user: User) -> list[MyDocumentOut]:
    """MyProfile.documents: os atuais do técnico (certificação, pessoal e currículo, de qualquer
    `via`), na ordem da tela, sem link."""
    docs = await _currents(db, TechnicianDocument.user_id == user.id, TECHNICIAN_KINDS)
    return [my_out(doc) for doc in docs]


async def technician_documents(
    db: AsyncSession, user_id: uuid.UUID, viewer: User, *, internal: bool
) -> list[TechDocumentOut]:
    """A central: os atuais do técnico com as versões e os links (os anexos internos só com
    `internal`, quem tem Técnicos Editar)."""
    kinds = ALL_KINDS if internal else TECHNICIAN_KINDS
    return await _central_list(db, TechnicianDocument.user_id == user_id, kinds, viewer)


async def one_document(
    db: AsyncSession, document_id: uuid.UUID, viewer: User
) -> TechDocumentOut:
    """Um documento relido do banco, com as versões e os links (a resposta da central)."""
    doc = await db.scalar(
        select(TechnicianDocument)
        .where(TechnicianDocument.id == document_id, TechnicianDocument.version_of_id.is_(None))
        .execution_options(populate_existing=True)
    )
    if doc is None:
        raise _not_found()
    versions = await _versions(db, [doc.id])
    return tech_out(doc, versions[doc.id], viewer.id)


async def application_documents(
    db: AsyncSession, application_id: uuid.UUID, viewer: User | None
) -> list[TechDocumentOut]:
    """ApplicationDetail.documents: os arquivos que vieram da ficha (também depois da aprovação),
    com as versões e os links de quem abriu."""
    condition = TechnicianDocument.application_id == application_id
    return await _central_list(db, condition, TECHNICIAN_KINDS, viewer)


async def link(db: AsyncSession, user: User, document_id: uuid.UUID) -> DocumentLinkOut:
    """GET /me/profile/documents/{id}/link: o link de 30 min de um documento atual do técnico (o
    anexo interno, a versão e o de outro técnico: 404)."""
    doc = await _current(db, Owner(user=user), document_id, TECHNICIAN_KINDS)
    return DocumentLinkOut(
        url=download_url(doc.id, user.id),
        expires_at=utcnow() + timedelta(minutes=LINK_MINUTES),
    )


async def file_for_download(db: AsyncSession, file_id: uuid.UUID) -> tuple[str, str, str]:
    """(storage_key, content_type, file_name) do documento ou da versão; sumiu: 404
    DOCUMENT_NOT_FOUND."""
    row = (
        await db.execute(
            select(
                TechnicianDocument.storage_key,
                TechnicianDocument.content_type,
                TechnicianDocument.file_name,
            ).where(TechnicianDocument.id == file_id)
        )
    ).first()
    if row is None:
        raise _not_found()
    return row[0], row[1], row[2]


def check_download_token(token: str, file_id: uuid.UUID) -> None:
    """O link assinado: vencido ou estragado, 401 "Link expirado"; de outro arquivo, 401 "Link
    inválido"."""
    try:
        payload = decode_token(token, "download")
    except InvalidToken as exc:
        raise CodedError(LINK_EXPIRED, "LINK_EXPIRED", 401) from exc
    if payload.get("sub") != f"document:{file_id}":
        raise CodedError(LINK_INVALID, "LINK_INVALID", 401)


# --------------------------------------------------------------------------- vencimento


def _due_conditions(limit: date) -> tuple[ColumnElement[bool], ...]:
    """Certificação atual com validade até `limit` (vencidas e as que vencem até lá)."""
    return (
        TechnicianDocument.kind == CERTIFICATION,
        TechnicianDocument.version_of_id.is_(None),
        TechnicianDocument.expires_on.is_not(None),
        TechnicianDocument.expires_on <= limit,
    )


async def due_map(
    db: AsyncSession, user_ids: Iterable[uuid.UUID], *, today: date | None = None
) -> dict[uuid.UUID, CertificationDueOut]:
    """Por técnico, a certificação atual de menor validade entre as vencidas e as que vencem até
    hoje + 30 (empate: o título e o id), e quantas estão assim. Quem não tem nenhuma fica fora. Uma
    consulta; nenhuma sem ids."""
    ids = list(dict.fromkeys(user_ids))
    if not ids:
        return {}
    day = today or current_day()
    rows = await db.execute(
        select(
            TechnicianDocument.user_id,
            TechnicianDocument.id,
            TechnicianDocument.title,
            TechnicianDocument.expires_on,
        ).where(
            TechnicianDocument.user_id.in_(ids),
            *_due_conditions(day + timedelta(days=WARN_DAYS)),
        )
    )
    grouped: dict[uuid.UUID, list[tuple[date, str, uuid.UUID, str]]] = {}
    for user_id, doc_id, title, expires_on in rows:
        grouped.setdefault(user_id, []).append(
            (expires_on, text_utils.fold(title), doc_id, title)
        )
    out: dict[uuid.UUID, CertificationDueOut] = {}
    for user_id, items in grouped.items():
        expires_on, _, doc_id, title = min(items, key=lambda i: (i[0], i[1], str(i[2])))
        out[user_id] = CertificationDueOut(
            document_id=doc_id, title=title, expires_on=expires_on, count=len(items)
        )
    return out


async def due_count(db: AsyncSession, *, today: date | None = None) -> int:
    """Início: técnicos (papel técnico, com ou sem acesso) Ativos na operação com certificação
    vencida ou vencendo em até 30 dias (a mesma regra do `certification_due` da lista)."""
    day = today or current_day()
    count = await db.scalar(
        select(func.count(func.distinct(TechnicianDocument.user_id)))
        .join(User, User.id == TechnicianDocument.user_id)
        .where(
            *_due_conditions(day + timedelta(days=WARN_DAYS)),
            User.role == UserRole.TECHNICIAN,
            User.operational_status == OperationalStatus.ACTIVE,
        )
    )
    return int(count or 0)


# --------------------------------------------------------------------------- ficha da homologação


def ficha_upload_token(application: TechnicianApplication) -> tuple[str, datetime]:
    """O token de 2 h para enviar arquivos depois do envio da ficha (POST /public/onboarding/{token}
    responde com ele) e quando ele vence."""
    token = create_token(
        f"application:{application.id}", "ficha_upload", timedelta(hours=FICHA_UPLOAD_HOURS)
    )
    expires = decode_token(token, "ficha_upload")["exp"]
    return token, datetime.fromtimestamp(int(expires), UTC)


def _gone() -> CodedError:
    return CodedError(FICHA_GONE, "FICHA_UPLOAD_GONE", 410)


async def ficha_application(db: AsyncSession, token: str | None) -> TechnicianApplication:
    """A ficha do `upload_token`, travada para leitura até o fim da transação (a aprovação, a
    reprovação e a exclusão esperam o envio terminar). Token inválido ou vencido, ou a ficha que
    não existe mais: 410 FICHA_UPLOAD_GONE; já analisada: 409 APPLICATION_NOT_PENDING."""
    try:
        payload = decode_token(token or "", "ficha_upload")
    except InvalidToken as exc:
        raise _gone() from exc
    subject = str(payload.get("sub") or "")
    prefix, _, raw_id = subject.partition(":")
    try:
        application_id = uuid.UUID(raw_id)
    except ValueError as exc:
        raise _gone() from exc
    if prefix != "application":
        raise _gone()
    application = await db.scalar(
        select(TechnicianApplication)
        .where(TechnicianApplication.id == application_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    )
    if application is None:
        raise _gone()
    if application.status != ApplicationStatus.PENDING:
        raise CodedError(FICHA_NOT_PENDING, "APPLICATION_NOT_PENDING", 409)
    return application


async def attach_to_user(
    db: AsyncSession, application: TechnicianApplication, user: User
) -> list[dict[str, Any]]:
    """Aprovação: os documentos da ficha (e as versões) passam ao técnico (`user_id`), sem mover
    arquivo. Devolve um item `documents` por arquivo, na ordem da tela, para a linha "Aprovado na
    homologação" (via ficha)."""
    await db.flush()  # o técnico existe antes de os documentos apontarem para ele
    docs = await _currents(
        db,
        (TechnicianDocument.application_id == application.id)
        & TechnicianDocument.user_id.is_(None),
        TECHNICIAN_KINDS,
    )
    if not docs:
        return []
    await db.execute(
        update(TechnicianDocument)
        .where(
            TechnicianDocument.application_id == application.id,
            TechnicianDocument.user_id.is_(None),
        )
        .values(user_id=user.id, updated_at=utcnow())
        .execution_options(synchronize_session=False)
    )
    return [
        _item(doc.kind, f"incluiu {document_name(doc.kind, doc.title)}{_due_suffix(doc.expires_on)}")
        for doc in docs
    ]


async def drop_for_application(db: AsyncSession, application_id: uuid.UUID) -> list[str]:
    """A ficha vai ser apagada: saem os documentos só dela (sem técnico; as versões vão em cascata).
    Devolve as chaves dos arquivos para `remove_files` depois do commit."""
    only_ficha = (
        TechnicianDocument.application_id == application_id,
        TechnicianDocument.user_id.is_(None),
    )
    keys = list(await db.scalars(select(TechnicianDocument.storage_key).where(*only_ficha)))
    if keys:
        await db.execute(
            delete(TechnicianDocument)
            .where(*only_ficha, TechnicianDocument.version_of_id.is_(None))
            .execution_options(synchronize_session=False)
        )
        # Versão órfã (não devia existir): sai junto, para a ficha poder ser apagada.
        await db.execute(
            delete(TechnicianDocument)
            .where(*only_ficha)
            .execution_options(synchronize_session=False)
        )
    return keys

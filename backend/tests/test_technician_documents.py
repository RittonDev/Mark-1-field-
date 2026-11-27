"""Documentos do técnico (contrato da Entrega 2, §6.3, §6.4 e §6.8): o técnico envia no app, a
central vê e anexa os quatro tipos (o anexo interno só com Técnicos Editar), a ficha da homologação
manda os arquivos depois do envio e a aprovação os passa ao técnico; versões com id estável, link
assinado, vencimento (lista e Início) e o histórico do cadastro.

Só dados fictícios (Tecnico Alfa, "NR10 Exemplo", @exemplo.com). Os arquivos vão para o diretório
temporário de mídia do teste (como nas notas fiscais).
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.config import settings
from app.core.enums import OperationalStatus, TechDocumentKind, UserRole
from app.core.security import create_access_token, create_token
from app.models import TechnicianApplication, TechnicianDocument, User
from app.schemas import personal
from app.services import onboarding as onboarding_svc
from app.services import realtime
from app.services import technician_documents as docs
from tests.conftest import Actor, World, requires_db
from tests.test_access import restrict_analyst
from tests.test_b2_onboarding import cpf
from tests.test_onboarding import ficha, new_invite

API = settings.API_PREFIX
MINE = f"{API}/me/profile/documents"
APPS = f"{API}/onboarding/applications"
FICHA = f"{API}/public/onboarding-documents"

PDF = b"%PDF-1.4\n% documento de exemplo\n%%EOF\n"
PDF_NEW = b"%PDF-1.7\n% outro arquivo de exemplo\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 16
GIF = b"GIF89a" + b"\x00" * 16
HEIC = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 16
XML = b"<?xml version='1.0'?><documento/>"
HTML = b"<!DOCTYPE html><html><body>exemplo</body></html>"
MB = 1024 * 1024

BAD_TYPE = "Envie PDF ou foto (JPG, PNG ou WebP)"
NOT_FOUND = {"detail": docs.NOT_FOUND, "code": "DOCUMENT_NOT_FOUND"}


@pytest.fixture
def media(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture(autouse=True)
def _many_uploads(monkeypatch: pytest.MonkeyPatch) -> None:
    """Os testes enviam mais de 30 arquivos na hora; o limite tem um teste próprio."""
    monkeypatch.setattr(docs, "UPLOADS_PER_HOUR", 1000)


def _files(root: Path) -> set[str]:
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}


def _today() -> date:
    return personal.local_today()


def _br(day: date) -> str:
    return f"{day:%d/%m/%Y}"


def _upload(name: str, data: bytes | None, mime: str) -> dict | None:
    return {"file": (name, data, mime)} if data is not None else None


async def send_mine(
    client: AsyncClient,
    actor: Actor,
    data: bytes | None = PDF,
    *,
    name: str = "nr10.pdf",
    mime: str = "application/pdf",
    **fields: str | None,
) -> Response:
    body = {"kind": "certification", "title": "NR10 Exemplo", **fields}
    return await client.post(
        MINE,
        data={k: v for k, v in body.items() if v is not None},
        files=_upload(name, data, mime),
        headers=actor.headers,
    )


async def send_central(
    client: AsyncClient,
    headers: dict,
    user_id: object,
    data: bytes | None = PDF,
    *,
    name: str = "nr10.pdf",
    mime: str = "application/pdf",
    **fields: str | None,
) -> Response:
    body = {"kind": "certification", "title": "NR10 Exemplo", **fields}
    return await client.post(
        f"{API}/technicians/{user_id}/documents",
        data={k: v for k, v in body.items() if v is not None},
        files=_upload(name, data, mime),
        headers=headers,
    )


async def replace_mine(
    client: AsyncClient,
    actor: Actor,
    doc_id: str,
    data: bytes = PDF_NEW,
    *,
    name: str = "novo.pdf",
    mime: str = "application/pdf",
    **fields: str,
) -> Response:
    return await client.post(
        f"{MINE}/{doc_id}/replace",
        data=fields,
        files={"file": (name, data, mime)},
        headers=actor.headers,
    )


async def central_list(client: AsyncClient, headers: dict, user_id: object) -> list[dict]:
    r = await client.get(f"{API}/technicians/{user_id}/documents", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def history(client: AsyncClient, world: World, user_id: object) -> list[dict]:
    """O histórico do cadastro (o mais novo primeiro), lido pelo administrador."""
    r = await client.get(f"{API}/technicians/{user_id}/changes", headers=world.admin.headers)
    assert r.status_code == 200, r.text
    return r.json()


def phrases(rows: list[dict], *fields: str) -> list[tuple[str, str, str]]:
    """(via, campo, frase) dos itens desses campos, do mais novo para o mais antigo."""
    return [
        (row["via"], item["field"], item["to"])
        for row in rows
        for item in row["changes"]
        if item["field"] in fields
    ]


def detail(r: Response) -> str:
    return r.json()["detail"]


async def rows_of(engine: AsyncEngine, **where: object) -> list[TechnicianDocument]:
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        stmt = select(TechnicianDocument)
        for key, value in where.items():
            stmt = stmt.where(getattr(TechnicianDocument, key) == value)
        return list(await db.scalars(stmt.order_by(TechnicianDocument.created_at)))


def capture(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    published: list[dict] = []

    async def publish(event: dict) -> None:
        published.append(event)

    monkeypatch.setattr(realtime.bus, "publish", publish)
    return published


# =========================================================================== regras puras


def test_expiry_status_and_texts_at_the_boundaries() -> None:
    today = date(2026, 11, 26)
    cases = {
        date(2026, 11, 25): "expired",
        date(2026, 11, 26): "soon",
        date(2026, 11, 27): "soon",
        date(2026, 12, 26): "soon",
        date(2026, 12, 27): "ok",
        None: None,
    }
    assert {day: docs.expiry_status(day, today) for day in cases} == cases
    assert docs.last_expiry_day(date(2026, 11, 26)) == date(2046, 11, 26)
    assert docs.last_expiry_day(date(2028, 2, 29)) == date(2048, 2, 29)
    assert docs.last_expiry_day(date(2080, 2, 29)) == date(2100, 2, 28)  # 2100 não é bissexto
    assert docs.document_name(TechDocumentKind.CERTIFICATION, "NR10") == "Certificação NR10"
    assert docs.document_name(TechDocumentKind.RESUME, "Currículo") == "Currículo"
    assert docs.document_name(TechDocumentKind.INTERNAL, "Contrato") == "Anexo interno Contrato"


def test_form_rules() -> None:
    today = date(2026, 11, 26)
    cert, personal_, resume = (
        TechDocumentKind.CERTIFICATION,
        TechDocumentKind.PERSONAL,
        TechDocumentKind.RESUME,
    )
    assert docs.read_title("  NR10​   Exemplo ", cert) == "NR10 Exemplo"
    assert docs.read_title("qualquer", resume) == "Currículo"
    assert docs.read_title("x" * 80, cert) == "x" * 80
    for raw, message in (
        (None, docs.NO_TITLE),
        (" a ", docs.NO_TITLE),
        ("x" * 81, docs.LONG_TITLE),
    ):
        with pytest.raises(docs.WorkflowError, match=message):
            docs.read_title(raw, cert)
    assert docs.read_expiry("", cert, today) is None
    assert docs.read_expiry("2046-11-26", cert, today) == date(2046, 11, 26)
    assert docs.read_expiry("2000-01-01", cert, today) == date(2000, 1, 1)
    for raw in ("2046-11-27", "1999-12-31", "2026-02-30", "31/12/2027", "2027-1-5"):
        with pytest.raises(docs.WorkflowError, match=docs.BAD_EXPIRY):
            docs.read_expiry(raw, cert, today)
    with pytest.raises(docs.WorkflowError, match=docs.EXPIRY_ONLY_CERTIFICATION):
        docs.read_expiry("2027-01-01", personal_, today)
    with pytest.raises(docs.WorkflowError, match=docs.NO_KIND):
        docs.read_kind("internal", docs.TECHNICIAN_KINDS)
    assert docs.read_kind("internal", docs.ALL_KINDS) == TechDocumentKind.INTERNAL
    with pytest.raises(docs.WorkflowError, match=docs.BAD_UPLOAD):
        docs.read_upload_id("abc")


# =========================================================================== app do técnico


@requires_db
async def test_technician_sends_lists_replaces_edits_and_deletes(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    media: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published = capture(monkeypatch)
    tech, tech_id = world.tech, str(world.tech.user.id)
    due = _today() + timedelta(days=400)

    r = await send_mine(
        client, tech, expires_on=due.isoformat(), client_upload_id=str(uuid.uuid4())
    )
    assert r.status_code == 200, r.text
    [cert] = r.json()["documents"]
    assert {k: cert[k] for k in cert if k not in ("id", "uploaded_at")} == {
        "kind": "certification",
        "title": "NR10 Exemplo",
        "expires_on": due.isoformat(),
        "file_name": "nr10.pdf",
        "content_type": "application/pdf",
        "size": len(PDF),
        "via": "app",
    }
    r = await send_mine(
        client, tech, PNG, name="rg-frente.png", mime="image/png", kind="personal", title=" RG "
    )
    assert r.status_code == 200, r.text
    listed = r.json()["documents"]
    assert [(d["kind"], d["title"]) for d in listed] == [
        ("certification", "NR10 Exemplo"),
        ("personal", "RG"),
    ]
    rg = listed[1]
    # GET /me/profile traz a mesma lista (sem link).
    me = (await client.get(f"{API}/me/profile", headers=tech.headers)).json()
    assert me["documents"] == listed
    assert all("url" not in d for d in me["documents"])

    [row] = await rows_of(engine, id=uuid.UUID(cert["id"]))
    assert (row.user_id, row.application_id, row.uploaded_by_id, row.uploaded_via) == (
        world.tech.user.id,
        None,
        world.tech.user.id,
        "app",
    )
    assert row.storage_key.startswith(f"documents/{tech_id}/")
    assert (media / row.storage_key).read_bytes() == PDF

    # O link de 30 min, pedido na hora: o PDF baixa, a foto abre na tela.
    r = await client.get(f"{MINE}/{cert['id']}/link", headers=tech.headers)
    assert r.status_code == 200, r.text
    link = r.json()
    expires = datetime.fromisoformat(link["expires_at"])
    assert timedelta(minutes=29) < expires - datetime.now(UTC) <= timedelta(minutes=30)
    got = await client.get(link["url"])
    assert got.status_code == 200 and got.content == PDF
    assert got.headers["content-disposition"].startswith("attachment")
    photo = await client.get(
        (await client.get(f"{MINE}/{rg['id']}/link", headers=tech.headers)).json()["url"]
    )
    assert photo.headers["content-disposition"].startswith("inline")
    assert photo.headers["content-type"] == "image/png"

    # Substituir: o mesmo id, o arquivo novo; o anterior vira versão (as duas no disco).
    r = await replace_mine(client, tech, cert["id"], name="nr10-novo.pdf", expires_on="")
    assert r.status_code == 200, r.text
    after = next(d for d in r.json()["documents"] if d["id"] == cert["id"])
    assert (after["file_name"], after["expires_on"], after["size"]) == (
        "nr10-novo.pdf",
        None,
        len(PDF_NEW),
    )
    current, version = await rows_of(engine, user_id=world.tech.user.id, kind="certification")
    assert (current.id, current.version_of_id, current.replaced_at) == (row.id, None, None)
    assert (version.version_of_id, version.storage_key, version.file_name) == (
        row.id,
        row.storage_key,
        "nr10.pdf",
    )
    assert version.replaced_at is not None and version.client_upload_id is None
    assert version.expires_on == due  # a versão guarda a validade de antes
    assert {row.storage_key, current.storage_key} <= _files(media)

    # Editar título e validade (sem arquivo); o mesmo de novo não grava nada.
    new_due = _today() + timedelta(days=100)
    body = {"title": "NR35 Exemplo", "expires_on": new_due.isoformat()}
    r = await client.patch(f"{MINE}/{cert['id']}", json=body, headers=tech.headers)
    assert r.status_code == 200, r.text
    edited = next(d for d in r.json()["documents"] if d["id"] == cert["id"])
    assert (edited["title"], edited["expires_on"]) == ("NR35 Exemplo", new_due.isoformat())
    [reread] = await rows_of(engine, id=row.id)
    assert (reread.title, reread.expires_on) == ("NR35 Exemplo", new_due)
    before = len(await history(client, world, tech_id))
    r = await client.patch(f"{MINE}/{cert['id']}", json=body, headers=tech.headers)
    assert r.status_code == 200, r.text
    assert len(await history(client, world, tech_id)) == before
    # O tipo nunca muda.
    r = await client.patch(f"{MINE}/{cert['id']}", json={"kind": "personal"}, headers=tech.headers)
    assert r.status_code == 422, r.text

    # Excluir leva o documento e as versões, do banco e do disco.
    r = await client.delete(f"{MINE}/{cert['id']}", headers=tech.headers)
    assert r.status_code == 200, r.text
    assert [d["id"] for d in r.json()["documents"]] == [rg["id"]]
    assert await rows_of(engine, user_id=world.tech.user.id, kind="certification") == []
    assert {row.storage_key, current.storage_key}.isdisjoint(_files(media))
    r = await client.delete(f"{MINE}/{cert['id']}", headers=tech.headers)
    assert (r.status_code, r.json()) == (404, NOT_FOUND)

    assert phrases(await history(client, world, tech_id), "documents") == [
        ("app", "documents", "excluiu Certificação NR35 Exemplo"),
        ("app", "documents", "renomeou Certificação NR10 Exemplo → NR35 Exemplo"),
        (
            "app",
            "documents",
            f"mudou a validade de Certificação NR35 Exemplo: sem validade → {_br(new_due)}",
        ),
        ("app", "documents", "substituiu o arquivo de Certificação NR10 Exemplo (sem validade)"),
        ("app", "documents", "incluiu Documento pessoal RG"),
        ("app", "documents", f"incluiu Certificação NR10 Exemplo (vence {_br(due)})"),
    ]
    # A central é avisada; o app não recebe aviso da mudança que ele mesmo fez.
    changed = [e for e in published if e["type"] == "profile.changed"]
    assert changed and all(e["data"]["fields"] == ["documents"] for e in changed)
    assert all(e["data"]["via"] == "app" for e in changed)
    assert not [e for e in published if e["type"] == "me.profile_changed"]


@requires_db
async def test_document_validation(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    tech = world.tech
    # Pelo conteúdo: PDF, JPG, PNG e WebP; GIF, HEIC, XML e HTML ficam fora, também com a
    # extensão de foto ou de PDF.
    for name, data, mime in (
        ("a.pdf", PDF, "application/pdf"),
        ("b.jpg", JPEG, "image/jpeg"),
        ("c.png", PNG, "image/png"),
        ("d.webp", WEBP, "image/webp"),
    ):
        r = await send_mine(client, tech, data, name=name, mime=mime, title=f"Curso {name}")
        assert r.status_code == 200, (name, r.text)
    sent = {d["file_name"]: d["content_type"] for d in r.json()["documents"]}
    assert sent == {
        "a.pdf": "application/pdf",
        "b.jpg": "image/jpeg",
        "c.png": "image/png",
        "d.webp": "image/webp",
    }
    for name, data, mime in (
        ("e.gif", GIF, "image/gif"),
        ("f.heic", HEIC, "image/heic"),
        ("g.xml", XML, "application/xml"),
        ("h.html", HTML, "text/html"),
        ("foto.jpg", HTML, "image/jpeg"),
        ("nr10.pdf", GIF, "application/pdf"),
    ):
        r = await send_mine(client, tech, data, name=name, mime=mime)
        assert (r.status_code, detail(r)) == (422, BAD_TYPE), name

    # 10 MB exatos passam; 1 byte a mais, não.
    big = b"%PDF-1.4\n" + b"0" * (10 * MB - 9)
    r = await send_mine(client, tech, big, name="grande.pdf", title="Arquivo de 10 MB")
    assert r.status_code == 200, r.text
    r = await send_mine(client, tech, big + b"0", name="maior.pdf", title="Arquivo maior")
    assert (r.status_code, detail(r)) == (422, "Arquivo maior que 10 MB")
    assert not any("maior" in f for f in _files(media))

    cases: list[tuple[dict, str]] = [
        ({"data": b""}, "O arquivo está vazio"),
        ({"data": None}, "Escolha o arquivo"),
        ({"title": ""}, "Informe o título"),
        ({"title": " x "}, "Informe o título"),
        ({"title": "x" * 81}, "O título tem no máximo 80 caracteres"),
        (
            {"kind": "personal", "title": "RG", "expires_on": "2030-01-01"},
            docs.EXPIRY_ONLY_CERTIFICATION,
        ),
        ({"kind": "resume", "expires_on": "2030-01-01"}, docs.EXPIRY_ONLY_CERTIFICATION),
        ({"expires_on": "2026-02-30"}, "Confira a validade"),
        ({"expires_on": "1999-12-31"}, "Confira a validade"),
        ({"expires_on": "31/12/2030"}, "Confira a validade"),
        (
            {"expires_on": (docs.last_expiry_day(_today()) + timedelta(days=1)).isoformat()},
            "Confira a validade",
        ),
        ({"kind": "internal"}, "Escolha o tipo do documento"),
        ({"kind": ""}, "Escolha o tipo do documento"),
        ({"kind": "rg"}, "Escolha o tipo do documento"),
        ({"client_upload_id": "abc"}, docs.BAD_UPLOAD),
    ]
    for fields, message in cases:
        data = fields.pop("data", PDF)
        r = await send_mine(client, tech, data, **fields)
        assert (r.status_code, detail(r)) == (422, message), fields
    # O título de 80 e a validade de hoje + 20 anos passam.
    r = await send_mine(
        client, tech, title="x" * 80, expires_on=docs.last_expiry_day(_today()).isoformat()
    )
    assert r.status_code == 200, r.text

    # O mesmo envio de novo (resposta perdida) devolve o mesmo documento; de outro técnico, 422.
    upload_id = str(uuid.uuid4())
    first = await send_mine(client, tech, title="NR33 Exemplo", client_upload_id=upload_id)
    again = await send_mine(client, tech, title="NR33 Exemplo", client_upload_id=upload_id)
    assert first.status_code == again.status_code == 200
    assert first.json()["documents"] == again.json()["documents"]
    assert [d["title"] for d in again.json()["documents"]].count("NR33 Exemplo") == 1
    r = await send_mine(client, world.tech_other, title="NR33 Exemplo", client_upload_id=upload_id)
    assert (r.status_code, detail(r)) == (422, docs.BAD_UPLOAD)

    # Limite de 30 certificações e documentos pessoais (o currículo não conta).
    current = await rows_of(engine, user_id=world.tech.user.id, version_of_id=None)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        for n in range(docs.PER_TECHNICIAN - len(current)):
            db.add(
                TechnicianDocument(
                    user_id=world.tech.user.id,
                    kind=TechDocumentKind.PERSONAL,
                    title=f"Documento {n}",
                    file_name="doc.pdf",
                    content_type="application/pdf",
                    size_bytes=1,
                    storage_key=f"documents/{world.tech.user.id}/doc-{n}.pdf",
                    uploaded_via="app",
                )
            )
        await db.commit()
    r = await send_mine(client, tech, kind="personal", title="CNH")
    assert r.status_code == 422, r.text
    assert r.json() == {"detail": docs.DOCUMENTS_LIMIT, "code": "DOCUMENTS_LIMIT"}
    assert detail(r) == "Limite de 30 documentos e certificações. Exclua um para enviar outro"
    r = await send_mine(client, tech, kind="resume", title="")
    assert r.status_code == 200, r.text


@requires_db
async def test_app_uploads_per_hour(
    client: AsyncClient, world: World, media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(docs, "UPLOADS_PER_HOUR", 2)
    assert (await send_mine(client, world.tech, title="Curso A")).status_code == 200
    assert (await send_mine(client, world.tech, title="Curso B")).status_code == 200
    r = await send_mine(client, world.tech, title="Curso C")
    assert (r.status_code, detail(r)) == (429, "Muitos arquivos enviados. Tente mais tarde")
    assert int(r.headers["retry-after"]) > 0
    # Cada técnico tem a sua conta.
    assert (await send_mine(client, world.tech_other, title="Curso A")).status_code == 200


@requires_db
async def test_resume_is_one_and_versions_keep_the_three_newest(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    tech, tech_id = world.tech, world.tech.user.id
    r = await send_mine(client, tech, kind="resume", title="Meu currículo", name="cv-1.pdf")
    assert r.status_code == 200, r.text
    [resume] = r.json()["documents"]
    assert (resume["kind"], resume["title"], resume["expires_on"]) == ("resume", "Currículo", None)
    [first] = await rows_of(engine, id=uuid.UUID(resume["id"]))

    # Enviar outro currículo substitui o arquivo do atual (o mesmo id).
    for n in range(2, 6):
        r = await send_mine(client, tech, PDF_NEW + bytes([n]), kind="resume", name=f"cv-{n}.pdf")
        assert r.status_code == 200, r.text
        assert [(d["id"], d["file_name"]) for d in r.json()["documents"]] == [
            (resume["id"], f"cv-{n}.pdf")
        ]
    [listed] = await central_list(client, world.admin.headers, tech_id)
    assert listed["file"]["file_name"] == "cv-5.pdf"
    # Ficam as 3 versões mais novas, a mais nova primeiro; a mais antiga saiu do banco e do disco.
    assert [v["file_name"] for v in listed["previous"]] == ["cv-4.pdf", "cv-3.pdf", "cv-2.pdf"]
    versions = await rows_of(engine, version_of_id=first.id)
    assert len(versions) == 3
    assert first.storage_key not in _files(media)
    assert {v.storage_key for v in versions} <= _files(media)
    # Um currículo só.
    assert len(await rows_of(engine, user_id=tech_id, kind="resume", version_of_id=None)) == 1
    rows = phrases(await history(client, world, tech_id), "documents")
    assert rows[0] == ("app", "documents", "substituiu o arquivo de Currículo")
    assert rows[-1] == ("app", "documents", "incluiu Currículo")


# =========================================================================== central


@requires_db
async def test_central_attaches_replaces_edits_and_deletes(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    media: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published = capture(monkeypatch)
    adm, sup = world.admin.headers, world.supervisor.headers
    tech_id = world.tech.user.id
    soon = _today() + timedelta(days=10)
    sent = [
        await send_central(client, adm, tech_id, kind="internal", title="Contrato de parceria"),
        await send_central(
            client,
            adm,
            tech_id,
            PNG,
            name="cnh.png",
            mime="image/png",
            kind="personal",
            title="CNH",
        ),
        await send_central(client, adm, tech_id, kind="certification", title="NR35 Exemplo"),
        await send_central(client, adm, tech_id, kind="resume", title=""),
        await send_central(client, adm, tech_id, title="NR10 Exemplo", expires_on=soon.isoformat()),
    ]
    assert [r.status_code for r in sent] == [201] * 5, [r.text for r in sent]
    first = sent[0].json()
    assert (
        first["kind"],
        first["file"]["via"],
        first["file"]["uploaded_by"],
        first["previous"],
    ) == (
        "internal",
        "central",
        {"id": str(world.admin.user.id), "name": "Admin"},
        [],
    )
    assert first["file"]["id"] == first["id"] and "token=" in first["file"]["url"]
    # Ordem: certificações (a validade mais próxima primeiro; sem validade por último), pessoais,
    # currículo e anexos internos.
    listed = await central_list(client, adm, tech_id)
    assert [(d["kind"], d["title"]) for d in listed] == [
        ("certification", "NR10 Exemplo"),
        ("certification", "NR35 Exemplo"),
        ("personal", "CNH"),
        ("resume", "Currículo"),
        ("internal", "Contrato de parceria"),
    ]
    internal_id = first["id"]
    # O anexo interno não tem validade e nunca chega ao técnico.
    r = await send_central(
        client, adm, tech_id, kind="internal", title="Ocorrência", expires_on="2030-01-01"
    )
    assert (r.status_code, detail(r)) == (422, docs.EXPIRY_ONLY_CERTIFICATION)
    me = (await client.get(f"{API}/me/profile", headers=world.tech.headers)).json()
    assert [d["kind"] for d in me["documents"]] == [
        "certification",
        "certification",
        "personal",
        "resume",
    ]
    th = world.tech.headers
    for method, url, kwargs in (
        ("GET", f"{MINE}/{internal_id}/link", {}),
        ("PATCH", f"{MINE}/{internal_id}", {"json": {"title": "Outro"}}),
        ("DELETE", f"{MINE}/{internal_id}", {}),
        (
            "POST",
            f"{MINE}/{internal_id}/replace",
            {"files": {"file": ("x.pdf", PDF, "application/pdf")}},
        ),
    ):
        r = await client.request(method, url, headers=th, **kwargs)
        assert (r.status_code, r.json()) == (404, NOT_FOUND), (method, url)

    # Substituir pela central (outra pessoa): o mesmo id, quem mandou e a versão.
    nr35 = listed[1]
    r = await client.post(
        f"{API}/technicians/{tech_id}/documents/{nr35['id']}/replace",
        data={"title": "NR35 Atualizada", "expires_on": "2030-05-01"},
        files={"file": ("nr35.pdf", PDF_NEW, "application/pdf")},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    replaced = r.json()
    assert (replaced["id"], replaced["title"], replaced["expires_on"]) == (
        nr35["id"],
        "NR35 Atualizada",
        "2030-05-01",
    )
    assert replaced["file"]["uploaded_by"] == {"id": str(world.supervisor.user.id), "name": "Super"}
    assert replaced["file"]["file_name"] == "nr35.pdf"
    assert [(v["file_name"], v["uploaded_by"]["name"]) for v in replaced["previous"]] == [
        ("nr10.pdf", "Admin")
    ]
    # Editar: só o que vem; expires_on null tira a validade.
    r = await client.patch(
        f"{API}/technicians/{tech_id}/documents/{nr35['id']}",
        json={"expires_on": None},
        headers=sup,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["title"], r.json()["expires_on"]) == ("NR35 Atualizada", None)
    [reread] = await rows_of(engine, id=uuid.UUID(nr35["id"]))
    assert (reread.title, reread.expires_on, reread.uploaded_by_id) == (
        "NR35 Atualizada",
        None,
        world.supervisor.user.id,
    )
    # Excluir o anexo interno.
    r = await client.delete(f"{API}/technicians/{tech_id}/documents/{internal_id}", headers=sup)
    assert r.status_code == 204, r.text
    assert internal_id not in {d["id"] for d in await central_list(client, adm, tech_id)}

    rows = await history(client, world, tech_id)
    assert phrases(rows, "documents", "internal_attachments") == [
        ("central", "internal_attachments", "excluiu Anexo interno Contrato de parceria"),
        (
            "central",
            "documents",
            "mudou a validade de Certificação NR35 Atualizada: 01/05/2030 → sem validade",
        ),
        ("central", "documents", "renomeou Certificação NR35 Exemplo → NR35 Atualizada"),
        (
            "central",
            "documents",
            "substituiu o arquivo de Certificação NR35 Atualizada (vence 01/05/2030)",
        ),
        ("central", "documents", f"incluiu Certificação NR10 Exemplo (vence {_br(soon)})"),
        ("central", "documents", "incluiu Currículo"),
        ("central", "documents", "incluiu Certificação NR35 Exemplo"),
        ("central", "documents", "incluiu Documento pessoal CNH"),
        ("central", "internal_attachments", "incluiu Anexo interno Contrato de parceria"),
    ]
    # O app é avisado do que ele mostra (documentos), nunca do anexo interno.
    mine = [e for e in published if e["type"] == "me.profile_changed"]
    assert mine and all(e["audience"] == {"user_ids": [str(tech_id)]} for e in mine)
    changed = [e for e in published if e["type"] == "profile.changed"]
    assert len(mine) == len([e for e in changed if "documents" in e["data"]["fields"]])
    assert [
        e["data"]["fields"] for e in changed if "internal_attachments" in e["data"]["fields"]
    ] == [
        ["internal_attachments"],
        ["internal_attachments"],
    ]


@requires_db
async def test_internal_attachments_need_edit(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    adm, an = world.admin.headers, world.analyst.headers
    tech_id = world.tech.user.id
    internal = (await send_central(client, adm, tech_id, kind="internal", title="Contrato")).json()
    cert = (await send_central(client, adm, tech_id, title="NR10 Exemplo")).json()
    await restrict_analyst(client, world, **{"base.technicians": "view"})
    # Visualizar: a lista sem o anexo interno (nem o link dele).
    listed = await central_list(client, an, tech_id)
    assert [d["id"] for d in listed] == [cert["id"]]
    base = f"{API}/technicians/{tech_id}/documents"
    for method, url, kwargs in (
        (
            "POST",
            base,
            {
                "data": {"kind": "personal", "title": "RG"},
                "files": {"file": ("rg.pdf", PDF, "application/pdf")},
            },
        ),
        (
            "POST",
            f"{base}/{cert['id']}/replace",
            {"files": {"file": ("x.pdf", PDF, "application/pdf")}},
        ),
        ("PATCH", f"{base}/{cert['id']}", {"json": {"title": "Outro"}}),
        ("DELETE", f"{base}/{internal['id']}", {}),
    ):
        r = await client.request(method, url, headers=an, **kwargs)
        assert r.status_code == 403, (method, url, r.text)
        assert r.json()["code"] == "MODULE_FORBIDDEN"
    # Editar: vê e mexe nos quatro tipos.
    await restrict_analyst(client, world, **{"base.technicians": "edit"})
    assert {d["id"] for d in await central_list(client, an, tech_id)} == {
        cert["id"],
        internal["id"],
    }
    r = await client.patch(f"{base}/{internal['id']}", json={"title": "Contrato 2026"}, headers=an)
    assert r.status_code == 200, r.text
    # Sem Técnicos: nada.
    await restrict_analyst(client, world, **{"base.technicians": "none"})
    assert (await client.get(base, headers=an)).status_code == 403


@requires_db
async def test_download_link_is_signed_and_safe(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    adm, tech_id = world.admin.headers, world.tech.user.id
    photo = (
        await send_central(
            client,
            adm,
            tech_id,
            JPEG,
            name="rg.jpg",
            mime="image/jpeg",
            kind="personal",
            title="RG",
        )
    ).json()
    cert = (await send_central(client, adm, tech_id, title="NR10 Exemplo")).json()

    r = await client.get(photo["file"]["url"])
    assert r.status_code == 200 and r.content == JPEG
    assert r.headers["content-type"] == "image/jpeg"
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]
    r = await client.get(cert["file"]["url"])
    assert r.status_code == 200 and r.content == PDF
    assert r.headers["content-disposition"].startswith("attachment")
    assert "sandbox" in r.headers["content-security-policy"]

    url = f"{API}/technician-documents/{cert['id']}/download"
    other = create_token(f"document:{photo['id']}", "download", timedelta(minutes=30))
    expired = create_token(f"document:{cert['id']}", "download", timedelta(minutes=-1))
    access = create_access_token(str(world.admin.user.id), "admin")
    assert (await client.get(url, params={"token": other})).json() == {
        "detail": "Link inválido",
        "code": "LINK_INVALID",
    }
    for token in (expired, access, "estragado"):
        r = await client.get(url, params={"token": token})
        assert (r.status_code, detail(r)) == (401, "Link expirado")
    assert (await client.get(url)).status_code == 422  # sem token

    # A versão anterior abre pelo link dela.
    r = await client.post(
        f"{API}/technicians/{tech_id}/documents/{cert['id']}/replace",
        files={"file": ("novo.pdf", PDF_NEW, "application/pdf")},
        headers=adm,
    )
    [previous] = r.json()["previous"]
    got = await client.get(previous["url"])
    assert got.status_code == 200 and got.content == PDF
    assert (await client.get(r.json()["file"]["url"])).content == PDF_NEW

    # Arquivo sumido do disco: 404 FILE_MISSING; documento excluído: 404 DOCUMENT_NOT_FOUND.
    [row] = await rows_of(engine, id=uuid.UUID(photo["id"]))
    (media / row.storage_key).unlink()
    r = await client.get(photo["file"]["url"])
    assert r.json() == {"detail": "Arquivo não encontrado", "code": "FILE_MISSING"}
    assert r.status_code == 404
    await client.delete(f"{API}/technicians/{tech_id}/documents/{cert['id']}", headers=adm)
    r = await client.get(cert["file"]["url"])
    assert (r.status_code, r.json()) == (404, NOT_FOUND)


@requires_db
async def test_documents_of_another_technician_are_not_found(
    client: AsyncClient, world: World, media: Path
) -> None:
    other = (await send_mine(client, world.tech_other, title="NR10 Exemplo")).json()["documents"][0]
    th = world.tech.headers
    for method, url, kwargs in (
        ("GET", f"{MINE}/{other['id']}/link", {}),
        ("PATCH", f"{MINE}/{other['id']}", {"json": {"title": "Meu"}}),
        ("DELETE", f"{MINE}/{other['id']}", {}),
        (
            "POST",
            f"{MINE}/{other['id']}/replace",
            {"files": {"file": ("x.pdf", PDF, "application/pdf")}},
        ),
        ("GET", f"{MINE}/{uuid.uuid4()}/link", {}),
    ):
        r = await client.request(method, url, headers=th, **kwargs)
        assert (r.status_code, r.json()) == (404, NOT_FOUND), (method, url)
    # Na central, pelo técnico errado: 404; quem não é técnico: 404 do técnico.
    adm = world.admin.headers
    wrong = f"{API}/technicians/{world.tech.user.id}/documents/{other['id']}"
    assert (await client.patch(wrong, json={"title": "X"}, headers=adm)).status_code == 404
    assert (await client.delete(wrong, headers=adm)).status_code == 404
    r = await client.get(f"{API}/technicians/{world.admin.user.id}/documents", headers=adm)
    assert r.status_code == 404
    # Cada um no seu lugar: o técnico não usa a central; a gestão não usa o app.
    r = await client.get(f"{API}/technicians/{world.tech.user.id}/documents", headers=th)
    assert r.status_code == 403
    r = await send_mine(client, world.analyst, title="NR10 Exemplo")
    assert r.status_code == 403


# =========================================================================== ficha da homologação


async def _ficha(
    client: AsyncClient, world: World, email: str, document: str = "123.456.789-09"
) -> tuple[str, str]:
    """Uma ficha enviada: (id, upload_token da resposta)."""
    invite = await new_invite(client, world, reusable=True, days_valid=30)
    r = await client.post(
        f"{API}/public/onboarding/{invite}",
        json=ficha(email=email, document=document, photo=None),
    )
    assert r.status_code == 201, r.text
    received = r.json()
    expires = datetime.fromisoformat(received["upload_expires_at"])
    assert timedelta(hours=1, minutes=59) < expires - datetime.now(UTC) <= timedelta(hours=2)
    listed = (await client.get(APPS, headers=world.analyst.headers)).json()
    app_id = next(a["id"] for a in listed if a["email"] == email.lower())
    return app_id, received["upload_token"]


async def send_ficha(
    client: AsyncClient,
    token: str,
    data: bytes = PDF,
    *,
    name: str = "nr10.pdf",
    mime: str = "application/pdf",
    **fields: str,
) -> Response:
    body = {"token": token, "kind": "certification", "title": "NR10 Exemplo", **fields}
    return await client.post(FICHA, data=body, files={"file": (name, data, mime)})


@requires_db
async def test_ficha_uploads_and_approval_moves_them_to_the_technician(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    app_id, token = await _ficha(client, world, "tecnico.alfa@exemplo.com")
    due = _today() + timedelta(days=200)
    upload_id = str(uuid.uuid4())
    r = await send_ficha(client, token, expires_on=due.isoformat(), client_upload_id=upload_id)
    assert r.status_code == 201, r.text
    cert = r.json()
    assert {k: cert[k] for k in cert if k != "id"} == {
        "kind": "certification",
        "title": "NR10 Exemplo",
        "expires_on": due.isoformat(),
        "file_name": "nr10.pdf",
        "size": len(PDF),
    }
    again = await send_ficha(client, token, expires_on=due.isoformat(), client_upload_id=upload_id)
    assert (again.status_code, again.json()) == (200, cert)
    rg = (
        await send_ficha(
            client, token, PNG, name="rg.png", mime="image/png", kind="personal", title="RG"
        )
    ).json()
    resume = await send_ficha(client, token, kind="resume", title="", name="cv.pdf")
    assert resume.status_code == 201, resume.text
    # O segundo currículo troca o arquivo do primeiro (o mesmo id).
    second = await send_ficha(client, token, PDF_NEW, kind="resume", name="cv-novo.pdf")
    assert (second.status_code, second.json()["id"]) == (200, resume.json()["id"])
    r = await send_ficha(client, token, kind="internal", title="Contrato")
    assert (r.status_code, detail(r)) == (422, "Escolha o tipo do documento")

    rows = await rows_of(engine, application_id=uuid.UUID(app_id))
    assert len(rows) == 4  # três atuais e a versão do currículo
    assert all((d.user_id, d.uploaded_by_id, d.uploaded_via) == (None, None, "ficha") for d in rows)
    assert all(d.storage_key.startswith(f"documents/fichas/{app_id}/") for d in rows)

    # A Homologação lista os arquivos (com os links).
    detail_ = (await client.get(f"{APPS}/{app_id}", headers=world.analyst.headers)).json()
    assert [(d["kind"], d["title"]) for d in detail_["documents"]] == [
        ("certification", "NR10 Exemplo"),
        ("personal", "RG"),
        ("resume", "Currículo"),
    ]
    assert (await client.get(detail_["documents"][0]["file"]["url"])).content == PDF

    # Remover um arquivo da ficha (de novo: já saiu).
    r = await client.post(f"{FICHA}/{rg['id']}/remove", json={"token": token})
    assert r.status_code == 204, r.text
    r = await client.post(f"{FICHA}/{rg['id']}/remove", json={"token": token})
    assert (r.status_code, r.json()) == (404, NOT_FOUND)
    assert not any(f.endswith("rg.png") for f in _files(media))

    # Aprovada: os arquivos passam ao técnico, sem mover, com a linha no histórico.
    r = await client.post(f"{APPS}/{app_id}/approve", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    tech_id = r.json()["technician"]["id"]
    listed = await central_list(client, world.admin.headers, tech_id)
    assert [
        (d["kind"], d["title"], d["file"]["via"], d["file"]["uploaded_by"]) for d in listed
    ] == [
        ("certification", "NR10 Exemplo", "ficha", None),
        ("resume", "Currículo", "ficha", None),
    ]
    assert [v["file_name"] for v in listed[1]["previous"]] == ["cv.pdf"]
    assert all(
        d.user_id == uuid.UUID(tech_id)
        for d in await rows_of(engine, application_id=uuid.UUID(app_id))
    )
    approved = (await history(client, world, tech_id))[-1]
    assert approved["via"] == "ficha"
    assert [(i["field"], i["to"]) for i in approved["changes"] if i["field"] == "documents"] == [
        ("documents", f"incluiu Certificação NR10 Exemplo (vence {_br(due)})"),
        ("documents", "incluiu Currículo"),
    ]
    headers = {"Authorization": f"Bearer {create_access_token(tech_id, UserRole.TECHNICIAN.value)}"}
    me = (await client.get(f"{API}/me/profile", headers=headers)).json()
    assert [(d["kind"], d["via"]) for d in me["documents"]] == [
        ("certification", "ficha"),
        ("resume", "ficha"),
    ]
    # A ficha analisada não recebe nem perde arquivo.
    r = await send_ficha(client, token, title="NR35 Exemplo")
    assert r.json() == {"detail": docs.FICHA_NOT_PENDING, "code": "APPLICATION_NOT_PENDING"}
    assert r.status_code == 409
    r = await client.post(f"{FICHA}/{cert['id']}/remove", json={"token": token})
    assert r.status_code == 409


@requires_db
async def test_ficha_upload_token_rules(
    client: AsyncClient,
    world: World,
    engine: AsyncEngine,
    media: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_id, token = await _ficha(client, world, "tecnico.beta@exemplo.com")
    gone = {"detail": docs.FICHA_GONE, "code": "FICHA_UPLOAD_GONE"}
    for bad in (
        "estragado",
        create_token(f"application:{app_id}", "ficha_upload", timedelta(minutes=-1)),
        create_token(f"application:{app_id}", "download", timedelta(minutes=30)),
        create_token(f"application:{uuid.uuid4()}", "ficha_upload", timedelta(hours=2)),
        create_token(f"document:{app_id}", "ficha_upload", timedelta(hours=2)),
    ):
        r = await send_ficha(client, bad)
        assert (r.status_code, r.json()) == (410, gone)
    r = await client.post(
        FICHA,
        data={"kind": "certification", "title": "NR10"},
        files={"file": ("a.pdf", PDF, "application/pdf")},
    )
    assert (r.status_code, r.json()) == (410, gone)

    # Até 10 arquivos por ficha.
    for n in range(docs.PER_FICHA):
        r = await send_ficha(client, token, title=f"Curso {n}")
        assert r.status_code == 201, r.text
    r = await send_ficha(client, token, title="Curso 11")
    assert r.status_code == 422
    assert r.json() == {"detail": "Limite de 10 arquivos na ficha", "code": "FICHA_DOCUMENTS_LIMIT"}

    # 30 envios por hora do mesmo IP (aqui, o limite baixo).
    monkeypatch.setattr(docs, "UPLOADS_PER_HOUR", docs.PER_FICHA + 1)
    r = await send_ficha(client, token, title="Curso 12")
    assert (r.status_code, detail(r)) == (429, "Muitos arquivos enviados. Tente mais tarde")
    assert int(r.headers["retry-after"]) > 0

    # Reprovada: 409.
    monkeypatch.setattr(docs, "UPLOADS_PER_HOUR", 1000)
    r = await client.post(
        f"{APPS}/{app_id}/reject", json={"reason": "Fora da região"}, headers=world.analyst.headers
    )
    assert r.status_code == 200, r.text
    r = await send_ficha(client, token, title="Curso 13")
    assert (r.status_code, r.json()["code"]) == (409, "APPLICATION_NOT_PENDING")


@requires_db
async def test_deleted_ficha_takes_its_documents(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    """A ficha apagada a pedido do titular (e a reprovada que a rotina apaga) leva os documentos e
    as versões, do banco e do disco."""
    first_id, first_token = await _ficha(client, world, "tecnico.gama@exemplo.com")
    assert (await send_ficha(client, first_token, kind="resume", name="cv.pdf")).status_code == 201
    assert (
        await send_ficha(client, first_token, PDF_NEW, kind="resume", name="cv-2.pdf")
    ).status_code == 200
    assert (
        await send_ficha(
            client, first_token, PNG, name="rg.png", mime="image/png", kind="personal", title="RG"
        )
    ).status_code == 201
    second_id, second_token = await _ficha(
        client, world, "tecnico.delta@exemplo.com", cpf("123456780")
    )
    assert (await send_ficha(client, second_token, title="NR10 Exemplo")).status_code == 201
    assert len(_files(media)) == 4

    an = world.analyst.headers
    for app_id in (first_id, second_id):
        r = await client.post(
            f"{APPS}/{app_id}/reject", json={"reason": "Fora da região"}, headers=an
        )
        assert r.status_code == 200, r.text
    r = await client.delete(f"{APPS}/{first_id}", headers=world.supervisor.headers)
    assert r.status_code == 204, r.text
    assert await rows_of(engine, application_id=uuid.UUID(first_id)) == []
    assert not any(f.startswith(f"documents/fichas/{first_id}/") for f in _files(media))

    # A rotina apaga a reprovada além do prazo, com os arquivos.
    old = datetime.now(UTC) - timedelta(days=settings.ONBOARDING_RETENTION_DAYS + 1)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        await db.execute(
            update(TechnicianApplication)
            .where(TechnicianApplication.id == uuid.UUID(second_id))
            .values(reviewed_at=old)
        )
        await db.commit()
        assert await onboarding_svc.purge_expired(db) >= 1
    assert await rows_of(engine, application_id=uuid.UUID(second_id)) == []
    assert _files(media) == set()


# =========================================================================== vencimento


@requires_db
async def test_due_map_and_count_at_the_boundaries(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    """Hoje fixo em 26/11/2026: vencidas e as que vencem até 26/12 contam; a versão substituída,
    o documento pessoal e a certificação sem validade, não."""
    today = date(2026, 11, 26)
    adm, tech_id, other_id = world.admin.headers, world.tech.user.id, world.tech_other.user.id
    for title, expires in (
        ("NR10 Exemplo", "2026-11-25"),
        ("NR12 Exemplo", "2026-11-26"),
        ("NR33 Exemplo", "2026-11-27"),
        ("NR35 Exemplo", "2026-12-26"),
        ("NR11 Exemplo", "2026-12-27"),
        ("Sem validade", None),
    ):
        r = await send_central(client, adm, tech_id, title=title, expires_on=expires)
        assert r.status_code == 201, r.text
    await send_central(client, adm, tech_id, kind="personal", title="RG")
    # A versão substituída com validade vencida não conta.
    old = (
        await send_central(client, adm, other_id, title="NR20 Exemplo", expires_on="2026-11-01")
    ).json()
    r = await client.post(
        f"{API}/technicians/{other_id}/documents/{old['id']}/replace",
        data={"expires_on": "2026-12-27"},
        files={"file": ("nr20.pdf", PDF_NEW, "application/pdf")},
        headers=adm,
    )
    assert r.status_code == 200, r.text

    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        due = await docs.due_map(db, [tech_id, other_id, world.admin.user.id], today=today)
        assert set(due) == {tech_id}
        nr10 = next(
            d for d in await central_list(client, adm, tech_id) if d["title"] == "NR10 Exemplo"
        )
        assert due[tech_id].model_dump() == {
            "document_id": uuid.UUID(nr10["id"]),
            "title": "NR10 Exemplo",
            "expires_on": date(2026, 11, 25),
            "count": 4,
        }
        assert await docs.due_map(db, [], today=today) == {}
        # Um dia depois, a de 27/12 entra; um mês antes, só as vencidas até lá.
        assert (await docs.due_map(db, [tech_id], today=date(2026, 11, 27)))[tech_id].count == 5
        assert await docs.due_map(db, [tech_id], today=date(2026, 10, 1)) == {}
        assert await docs.due_count(db, today=today) == 1
        # Com o outro técnico vencendo também: Ativo conta; Inativo, não.
        assert (await docs.due_count(db, today=date(2026, 11, 28))) == 2
        await db.execute(
            update(User)
            .where(User.id == other_id)
            .values(operational_status=OperationalStatus.INACTIVE)
        )
        await db.commit()
        assert (await docs.due_count(db, today=date(2026, 11, 28))) == 1
        # Sem acesso ao app continua contando (a regra é a situação na operação).
        await db.execute(update(User).where(User.id == tech_id).values(is_active=False))
        await db.commit()
        assert (await docs.due_count(db, today=today)) == 1


@requires_db
async def test_home_counts_technicians_with_certification_due(
    client: AsyncClient, world: World, engine: AsyncEngine, media: Path
) -> None:
    adm = world.admin.headers
    soon = (_today() + timedelta(days=5)).isoformat()
    later = (_today() + timedelta(days=60)).isoformat()
    assert (await send_central(client, adm, world.tech.user.id, expires_on=soon)).status_code == 201
    assert (
        await send_central(client, adm, world.tech_other.user.id, expires_on=later)
    ).status_code == 201
    r = await client.get(f"{API}/home/overview", headers=world.supervisor.headers)
    assert r.status_code == 200, r.text
    assert r.json()["pulse"]["team"]["certifications_due"] == 1
    # Sem Técnicos em Visualizar, nem conta.
    await restrict_analyst(client, world, **{"base.technicians": "none"})
    r = await client.get(f"{API}/home/overview", headers=world.analyst.headers)
    assert r.status_code == 200, r.text
    assert r.json()["pulse"]["team"]["certifications_due"] is None

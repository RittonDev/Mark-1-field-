"""Notas fiscais dos técnicos: o técnico envia pelo app (aba Ganhos) e a central confere em
Pagamentos.

Só dados fictícios ("Tecnico", "Redes", números de nota inventados).
"""

import asyncio
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from app.services import invoices, storage
from app.services import payouts as payouts_svc
from tests.conftest import Actor, World, requires_db
from tests.test_access import restrict_analyst
from tests.test_api import create, transition

API = settings.API_PREFIX
PDF = b"%PDF-1.4 teste"
XML = b"<?xml version='1.0'?><CompNfse/>"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
HTML = b"<!DOCTYPE html><html><body>nota</body></html>"
TYPE_ERROR = "Envie a nota em PDF, XML ou foto (JPG, PNG ou WebP)"
TOO_MANY = "Escolha até 200 OS por nota"


def _today() -> datetime:
    return datetime.now(ZoneInfo(settings.TIMEZONE))


def _month(offset: int = 0) -> str:
    """O mês atual (ou o seguinte, com offset=1) no fuso da operação, como AAAA-MM."""
    first = _today().date().replace(day=1)
    if offset:
        first = (first + timedelta(days=32)).replace(day=1)
    return f"{first:%Y-%m}"


def _files(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()]


@pytest.fixture
def media(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    return tmp_path


async def _payout(client: AsyncClient, world: World, ticket: dict, tech: Actor, amount: int) -> str:
    tech_id = str(tech.user.id)
    r = await client.put(
        f"{API}/tickets/{ticket['id']}/payouts/{tech_id}",
        json={"amount": amount},
        headers=world.analyst.headers,
    )
    assert r.status_code == 200, r.text
    return next(p["id"] for p in r.json() if p["technician"]["id"] == tech_id)


async def concluded(
    client: AsyncClient, world: World, title: str, amount: int, tech: Actor | None = None
) -> tuple[dict, str]:
    """OS resolvida pelo técnico com o valor dele: (OS, id do valor)."""
    tech = tech or world.tech
    t = await create(client, world, title=title, assignee_id=str(tech.user.id))
    payout = await _payout(client, world, t, tech, amount)
    t = (await client.get(f"{API}/tickets/{t['id']}", headers=tech.headers)).json()
    t = await transition(client, tech.headers, t, "in_progress")
    t = await transition(client, tech.headers, t, "resolved", resolution_notes="ok")
    return t, payout


async def still_open(
    client: AsyncClient, world: World, title: str, amount: int
) -> tuple[dict, str]:
    t = await create(client, world, title=title, assignee_id=str(world.tech.user.id))
    return t, await _payout(client, world, t, world.tech, amount)


async def send(
    client: AsyncClient,
    tech: Actor,
    *,
    number: str | None = "1234",
    amount: str | None = "300.00",
    file: tuple[str, bytes, str] | None = ("nota-1234.pdf", PDF, "application/pdf"),
    **fields: str,
) -> Response:
    data = {
        "number": number,
        "issue_date": _today().date().isoformat(),
        "amount": amount,
        "competence": _month(),
        **fields,
    }
    return await client.post(
        f"{API}/me/invoices",
        data={k: v for k, v in data.items() if v is not None},
        files={"file": file} if file else None,
        headers=tech.headers,
    )


def detail(r: Response) -> str:
    return r.json()["detail"]


@requires_db
async def test_technician_sends_lists_opens_and_deletes(
    client: AsyncClient, world: World, media: Path
) -> None:
    th, an = world.tech.headers, world.analyst.headers
    done, payout = await concluded(client, world, "Troca de PDV", 300)
    open_ticket, _ = await still_open(client, world, "Em andamento", 90)
    month = _month()

    # As OS que podem entrar na nota: a concluída do mês (a aberta não).
    r = await client.get(f"{API}/me/invoices/payouts", params={"month": month}, headers=th)
    assert r.status_code == 200, r.text
    assert [(c["payout_id"], c["code"], c["in_month"], c["invoice"]) for c in r.json()] == [
        (payout, done["code"], True, None)
    ]

    upload_id = str(uuid.uuid4())
    r = await send(client, world.tech, payout_ids=payout, client_upload_id=upload_id)
    assert r.status_code == 201, r.text
    sent = r.json()
    assert (sent["status"], sent["file_kind"], sent["content_type"]) == (
        "pending",
        "pdf",
        "application/pdf",
    )
    assert (sent["number"], sent["amount"], sent["competence"]) == ("1234", 300.0, month)
    assert [p["code"] for p in sent["payouts"]] == [done["code"]]
    assert sent["payouts_total"] == 300.0
    assert sent["download_url"].startswith(f"{API}/technician-invoices/")
    assert len(_files(media)) == 1

    # O mesmo envio de novo (a resposta se perdeu): a mesma nota, sem outra nem outro arquivo.
    again = await send(client, world.tech, payout_ids=payout, client_upload_id=upload_id)
    assert again.status_code == 200, again.text
    assert again.json()["id"] == sent["id"]
    assert [i["id"] for i in (await client.get(f"{API}/me/invoices", headers=th)).json()] == [
        sent["id"]
    ]
    listed = await client.get(f"{API}/me/invoices", params={"month": month}, headers=th)
    assert [i["id"] for i in listed.json()] == [sent["id"]]
    bad_month = await client.get(f"{API}/me/invoices", params={"month": "2026-13"}, headers=th)
    assert bad_month.status_code == 422 and detail(bad_month) == "Mês inválido (use AAAA-MM)"
    assert len(_files(media)) == 1

    # Só o próprio técnico: o colega não vê nem apaga; a central não usa as rotas do app.
    other = world.tech_other.headers
    assert (await client.get(f"{API}/me/invoices", headers=other)).json() == []
    r = await client.delete(f"{API}/me/invoices/{sent['id']}", headers=other)
    assert r.status_code == 404 and detail(r) == "Nota fiscal não encontrada"
    assert (await client.get(f"{API}/me/invoices", headers=an)).status_code == 403
    assert (await client.post(f"{API}/me/invoices", headers=an)).status_code == 403

    # Link assinado: PDF baixa (attachment), com nosniff.
    url = sent["download_url"]
    r = await client.get(url)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.content == PDF
    token = url.split("token=", 1)[1]
    tampered = token[:20] + ("A" if token[20] != "A" else "B") + token[21:]
    r = await client.get(url.replace(token, tampered))
    assert r.status_code == 401
    # O token de uma nota não abre outra.
    r = await client.get(
        f"{API}/technician-invoices/{uuid.uuid4()}/download", params={"token": token}
    )
    assert r.status_code == 401 and detail(r) == "Link inválido"

    # Meus ganhos: a linha da OS mostra a nota.
    earnings = (await client.get(f"{API}/me/earnings", params={"month": month}, headers=th)).json()
    lines = {i["ticket"]["id"]: i for i in earnings["items"]}
    assert lines[done["id"]]["invoice"] == {"id": sent["id"], "number": "1234", "status": "pending"}
    assert lines[open_ticket["id"]]["invoice"] is None

    # Apagar: a OS fica livre e o arquivo sai do disco.
    r = await client.delete(f"{API}/me/invoices/{sent['id']}", headers=th)
    assert r.status_code == 204, r.text
    assert _files(media) == []
    earnings = (await client.get(f"{API}/me/earnings", params={"month": month}, headers=th)).json()
    assert {i["ticket"]["id"]: i["invoice"] for i in earnings["items"]}[done["id"]] is None
    assert (await client.get(url)).status_code == 404
    assert (await client.get(f"{API}/me/invoices", headers=th)).json() == []


@requires_db
async def test_invoice_validation(
    client: AsyncClient, world: World, media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    th = world.tech.headers
    done, payout = await concluded(client, world, "Concluída", 300)
    open_ticket, open_payout = await still_open(client, world, "Aberta", 90)
    _, colleague_payout = await concluded(client, world, "Do colega", 200, tech=world.tech_other)

    # O tipo vem do conteúdo: HTML com nome de PDF não passa; XML e foto passam.
    r = await send(client, world.tech, file=("nota.pdf", HTML, "application/pdf"))
    assert r.status_code == 422 and detail(r) == TYPE_ERROR
    r = await send(client, world.tech, file=("nota.gif", b"GIF89a" + b"\x00" * 16, "image/gif"))
    assert r.status_code == 422 and detail(r) == TYPE_ERROR
    r = await send(client, world.tech, number="X-1", file=("nfse.xml", XML, "text/xml"))
    assert r.status_code == 201, r.text
    assert (r.json()["file_kind"], r.json()["content_type"]) == ("xml", "application/xml")
    r = await send(client, world.tech, number="F-1", file=("foto.png", PNG, "image/png"))
    assert r.status_code == 201, r.text
    assert (r.json()["file_kind"], r.json()["content_type"]) == ("image", "image/png")
    photo = await client.get(r.json()["download_url"])
    assert photo.headers["content-disposition"].startswith("inline")
    assert len(_files(media)) == 2

    # Campos.
    tomorrow = (_today() + timedelta(days=1)).date().isoformat()
    cases: list[tuple[dict, str]] = [
        ({"file": None}, "Escolha o arquivo da nota"),
        ({"file": ("vazio.pdf", b"", "application/pdf")}, "O arquivo da nota está vazio"),
        ({"number": ""}, "Informe o número da nota"),
        ({"number": "   "}, "Informe o número da nota"),
        ({"number": "9" * 31}, "O número da nota tem no máximo 30 caracteres"),
        ({"issue_date": ""}, "Informe a data de emissão"),
        ({"issue_date": "18/11/2026"}, "Data de emissão inválida (use AAAA-MM-DD)"),
        ({"issue_date": "1999-12-31"}, "Data de emissão inválida (use AAAA-MM-DD)"),
        ({"issue_date": tomorrow}, "A data de emissão não pode ser no futuro"),
        ({"amount": ""}, "Informe o valor da nota"),
        ({"amount": "abc"}, "Valor inválido"),
        ({"amount": "1.234,56"}, "Valor inválido"),
        ({"amount": "10.555"}, "Valor inválido"),
        ({"amount": "0"}, "O valor da nota precisa ser maior que zero"),
        ({"amount": "-5"}, "O valor da nota precisa ser maior que zero"),
        ({"competence": "2026-13"}, "Competência inválida (use AAAA-MM)"),
        ({"competence": _month(1)}, "A competência não pode ser um mês que ainda não chegou"),
        ({"note": "x" * 501}, "A observação tem no máximo 500 caracteres"),
        ({"payout_ids": ",".join(str(uuid.uuid4()) for _ in range(201))}, TOO_MANY),
        ({"payout_ids": colleague_payout}, "Uma das OS escolhidas não é sua"),
        ({"payout_ids": "nao-e-um-id"}, "Uma das OS escolhidas não é sua"),
        ({"payout_ids": open_payout}, f"A {open_ticket['code']} ainda não foi concluída"),
        ({"client_upload_id": "abc"}, "Envio inválido: atualize o app e tente de novo"),
    ]
    for override, message in cases:
        body = {"number": "500", "amount": "300.00", **override}
        r = await send(client, world.tech, **body)
        assert r.status_code == 422, (override, r.text)
        assert detail(r) == message, (override, r.text)
    assert len(_files(media)) == 2

    # O valor numa nota que aguarda conferência não entra em outra.
    r = await send(client, world.tech, number="1234", payout_ids=payout)
    assert r.status_code == 201, r.text
    r = await send(client, world.tech, number="999", payout_ids=payout)
    assert r.status_code == 422 and detail(r) == f"A {done['code']} já está na nota nº 1234"

    # Número repetido (sem espaços, maiúsculas e zeros à esquerda contam como o mesmo).
    for number in ("1234", "01234", " 12 34 "):
        r = await send(client, world.tech, number=number)
        assert r.status_code == 422 and detail(r) == "A nota nº 1234 já foi enviada", number
    r = await send(client, world.tech, number="x-1")
    assert r.status_code == 422 and detail(r) == "A nota nº X-1 já foi enviada"
    # O colega pode ter uma nota com o mesmo número.
    r = await send(client, world.tech_other, number="1234")
    assert r.status_code == 201, r.text

    # Arquivo grande demais: nada fica no disco.
    files_before = len(_files(media))
    monkeypatch.setattr(invoices, "INVOICE_MAX_MB", 0)
    r = await send(client, world.tech, number="777")
    assert r.status_code == 422 and "maior que" in detail(r)
    assert len(_files(media)) == files_before
    monkeypatch.setattr(invoices, "INVOICE_MAX_MB", 10)

    # Limite de notas por competência (contam também as recusadas).
    monkeypatch.setattr(invoices, "PER_MONTH", 3)
    r = await send(client, world.tech, number="778")
    assert r.status_code == 422 and detail(r).startswith("Limite de "), r.text
    assert len((await client.get(f"{API}/me/invoices", headers=th)).json()) == 3


@requires_db
async def test_central_checks_unchecks_and_rejects(
    client: AsyncClient, world: World, media: Path
) -> None:
    th, an = world.tech.headers, world.analyst.headers
    tech_id, analyst_id = str(world.tech.user.id), str(world.analyst.user.id)
    month = _month()
    done, payout = await concluded(client, world, "Rack", 450)
    r = await send(client, world.tech, number="77", amount="450.00", payout_ids=payout)
    assert r.status_code == 201, r.text
    sent = r.json()
    _, colleague_payout = await concluded(client, world, "Switch", 120, tech=world.tech_other)
    r = await send(
        client, world.tech_other, number="88", amount="120.00", payout_ids=colleague_payout
    )
    assert r.status_code == 201, r.text

    # A central vê as notas de todos os técnicos, com o resumo das abas.
    r = await client.get(f"{API}/technician-invoices", params={"month": month}, headers=an)
    assert r.status_code == 200, r.text
    listing = r.json()
    assert listing["summary"] == {
        "pending": 2,
        "checked": 0,
        "rejected": 0,
        "pending_amount": 570.0,
        "checked_amount": 0.0,
    }
    assert listing["total_count"] == 2
    r = await client.get(
        f"{API}/technician-invoices", params={"technician_id": tech_id}, headers=an
    )
    (item,) = r.json()["items"]
    assert item["id"] == sent["id"] and item["technician"] == {"id": tech_id, "name": "Tecnico"}
    assert [p["code"] for p in item["payouts"]] == [done["code"]]
    assert item["reviewed_by"] is None and item["download_url"]
    r = await client.get(f"{API}/technician-invoices", params={"status": "checked"}, headers=an)
    checked_only = r.json()
    assert (checked_only["items"], checked_only["total_count"]) == ([], 0)
    assert checked_only["summary"]["pending"] == 2
    other_month = await client.get(
        f"{API}/technician-invoices", params={"month": "2001-01"}, headers=an
    )
    assert other_month.json()["items"] == [] and other_month.json()["summary"]["pending"] == 0
    bad = await client.get(f"{API}/technician-invoices", params={"month": "11/2026"}, headers=an)
    assert bad.status_code == 422

    base = f"{API}/technician-invoices/{sent['id']}"
    # Conferir (de novo: como está). O técnico não apaga mais.
    r = await client.post(f"{base}/check", headers=an)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "checked" and r.json()["reviewed_at"]
    assert r.json()["reviewed_by"] == {"id": analyst_id, "name": "Analista"}
    assert (await client.post(f"{base}/check", headers=an)).json()["status"] == "checked"
    r = await client.delete(f"{API}/me/invoices/{sent['id']}", headers=th)
    assert r.status_code == 422
    assert detail(r) == "A central já conferiu esta nota: ela não pode mais ser apagada"
    r = await client.post(f"{base}/reject", json={"reason": "Valor errado"}, headers=an)
    assert r.status_code == 422 and detail(r) == "Desfaça a conferência antes de recusar"
    summary = (await client.get(f"{API}/technician-invoices", headers=an)).json()["summary"]
    assert (summary["checked"], summary["checked_amount"]) == (1, 450.0)

    # Desfazer a conferência.
    r = await client.post(f"{base}/uncheck", headers=an)
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["reviewed_at"], r.json()["reviewed_by"]) == (
        "pending",
        None,
        None,
    )
    assert (await client.post(f"{base}/uncheck", headers=an)).json()["status"] == "pending"

    # Recusar pede o motivo; recusada, as OS ficam livres.
    for body in ({}, {"reason": "  "}, {"reason": "ok"}, {"reason": "x" * 301}):
        r = await client.post(f"{base}/reject", json=body, headers=an)
        assert r.status_code == 422, (body, r.text)
    r = await client.post(f"{base}/reject", json={"reason": "  Número não confere  "}, headers=an)
    assert r.status_code == 200, r.text
    rejected = r.json()
    assert (rejected["status"], rejected["reject_reason"]) == ("rejected", "Número não confere")
    assert rejected["reviewed_by"]["id"] == analyst_id and rejected["payouts"] == []
    r = await client.get(f"{API}/payouts", params={"technician_id": tech_id}, headers=an)
    assert {i["ticket"]["id"]: i["invoice"] for i in r.json()["items"]}[done["id"]] is None
    mine = (await client.get(f"{API}/me/invoices", headers=th)).json()
    assert (mine[0]["status"], mine[0]["reject_reason"]) == ("rejected", "Número não confere")
    assert "reviewed_by" not in mine[0]

    # A recusa é final.
    r = await client.post(f"{base}/check", headers=an)
    assert r.status_code == 422 and detail(r) == "Nota recusada: o técnico envia outra"
    assert (await client.post(f"{base}/uncheck", headers=an)).status_code == 422
    r = await client.post(f"{base}/reject", json={"reason": "De novo"}, headers=an)
    assert r.status_code == 422 and detail(r) == "Esta nota já foi recusada"

    # O técnico envia outra com o mesmo número (a recusada não conta) e as mesmas OS, e apaga a
    # recusada.
    r = await send(client, world.tech, number="77", amount="450.00", payout_ids=payout)
    assert r.status_code == 201, r.text
    resent = r.json()
    assert (await client.delete(f"{API}/me/invoices/{sent['id']}", headers=th)).status_code == 204
    assert len(_files(media)) == 2

    # O técnico não usa as rotas da central.
    assert (await client.get(f"{API}/technician-invoices", headers=th)).status_code == 403
    r = await client.post(f"{API}/technician-invoices/{resent['id']}/check", headers=th)
    assert r.status_code == 403

    # Pagamentos em Visualizar: vê e baixa, mas não confere nem recusa.
    await restrict_analyst(client, world, **{"commercial.payouts": "view"})
    r = await client.get(f"{API}/technician-invoices", headers=an)
    assert r.status_code == 200 and len(r.json()["items"]) == 2
    resent_base = f"{API}/technician-invoices/{resent['id']}"
    for path, body in (("check", None), ("uncheck", None), ("reject", {"reason": "Sem acesso"})):
        r = await client.post(f"{resent_base}/{path}", json=body, headers=an)
        assert r.status_code == 403 and r.json()["code"] == "MODULE_FORBIDDEN", (path, r.text)


@requires_db
async def test_reassign_clears_the_invoice_link(
    client: AsyncClient, world: World, media: Path
) -> None:
    an, th = world.analyst.headers, world.tech.headers
    other_id = str(world.tech_other.user.id)
    done, payout = await concluded(client, world, "Nobreak", 200)
    r = await send(client, world.tech, number="55", amount="200.00", payout_ids=payout)
    assert r.status_code == 201, r.text
    sent = r.json()
    assert [p["payout_id"] for p in sent["payouts"]] == [payout]

    # A OS passa para o colega: o valor vai junto, sem a nota de quem saiu.
    t = (await client.get(f"{API}/tickets/{done['id']}", headers=an)).json()
    r = await client.post(
        f"{API}/tickets/{t['id']}/assign",
        json={"assignee_id": other_id, "expected_version": t["version"]},
        headers=an,
    )
    assert r.status_code == 200, r.text
    assert [(p["id"], p["technician"]["id"]) for p in r.json()["payouts"]] == [(payout, other_id)]
    r = await client.get(f"{API}/payouts", params={"technician_id": other_id}, headers=an)
    assert [(i["id"], i["invoice"]) for i in r.json()["items"]] == [(payout, None)]
    theirs = (await client.get(f"{API}/me/earnings", headers=world.tech_other.headers)).json()
    assert [i["invoice"] for i in theirs["items"]] == [None]
    r = await client.get(
        f"{API}/me/invoices/payouts", params={"month": _month()}, headers=world.tech_other.headers
    )
    assert [(c["payout_id"], c["invoice"]) for c in r.json()] == [(payout, None)]

    # A nota continua com o técnico, sem a OS.
    (mine,) = (await client.get(f"{API}/me/invoices", headers=th)).json()
    assert (mine["id"], mine["payouts"], mine["payouts_total"]) == (sent["id"], [], 0.0)


@requires_db
async def test_central_list_pending_queue_and_pages(
    client: AsyncClient, world: World, media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A aba "A conferir" pede status=pending: a fila vem da mais antiga para a mais nova, e as
    pendentes antigas não somem atrás das mais novas. O resto vem pelo offset."""
    an = world.analyst.headers
    monkeypatch.setattr(invoices, "LIST_LIMIT", 2)
    ids: dict[str, str] = {}
    for number in ("101", "102", "103", "104", "105"):
        r = await send(client, world.tech, number=number)
        assert r.status_code == 201, r.text
        ids[number] = r.json()["id"]
    # As duas mais novas já conferidas: aguardam as três mais antigas.
    for number in ("104", "105"):
        r = await client.post(f"{API}/technician-invoices/{ids[number]}/check", headers=an)
        assert r.status_code == 200, r.text

    async def page(**params: str | int) -> tuple[list[str], int]:
        r = await client.get(f"{API}/technician-invoices", params=params, headers=an)
        assert r.status_code == 200, r.text
        body = r.json()
        assert (body["summary"]["pending"], body["summary"]["checked"]) == (3, 2)
        return [i["number"] for i in body["items"]], body["total_count"]

    assert await page(status="pending") == (["101", "102"], 3)
    assert await page(status="pending", offset=2) == (["103"], 3)
    # Sem situação e nas outras: as mais novas primeiro.
    assert await page() == (["105", "104"], 5)
    assert await page(offset=2) == (["103", "102"], 5)
    assert await page(offset=4) == (["101"], 5)
    assert await page(offset=5) == ([], 5)
    assert await page(status="checked") == (["105", "104"], 2)
    for offset in (-1, 2**31):
        r = await client.get(f"{API}/technician-invoices", params={"offset": offset}, headers=an)
        assert r.status_code == 422, (offset, r.text)


async def _link(engine: AsyncEngine, payout_id: str, invoice_id: str) -> None:
    """Liga o valor à nota numa conexão à parte, já confirmada (o que o envio da nota grava)."""
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE ticket_payouts SET invoice_id = :i WHERE id = :p"),
            {"i": invoice_id, "p": payout_id},
        )


async def _payout_row(engine: AsyncEngine, payout_id: str) -> tuple[str, str | None]:
    """(técnico, nota) do valor, direto do banco."""
    async with engine.connect() as conn:
        technician_id, invoice_id = (
            await conn.execute(
                text("SELECT technician_id, invoice_id FROM ticket_payouts WHERE id = :p"),
                {"p": payout_id},
            )
        ).one()
    return str(technician_id), None if invoice_id is None else str(invoice_id)


async def _reassign(client: AsyncClient, world: World, ticket_id: str, to: Actor) -> Response:
    an = world.analyst.headers
    t = (await client.get(f"{API}/tickets/{ticket_id}", headers=an)).json()
    return await client.post(
        f"{API}/tickets/{ticket_id}/assign",
        json={"assignee_id": str(to.user.id), "expected_version": t["version"]},
        headers=an,
    )


async def _someone_waits_for_a_lock(engine: AsyncEngine) -> bool:
    """Alguma conexão deste banco esperando uma trava (até uns 10 s)."""
    for _ in range(200):
        async with engine.connect() as conn:
            waiting = await conn.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity"
                    " WHERE datname = current_database() AND wait_event_type = 'Lock'"
                )
            )
        if waiting:
            return True
        await asyncio.sleep(0.05)
    return False


@requires_db
async def test_reassign_clears_a_link_confirmed_meanwhile(
    client: AsyncClient,
    world: World,
    media: Path,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """O envio da nota liga o valor e confirma depois de a troca de técnico carregar a OS (o valor
    já está na sessão) e antes de mexer nele: a troca relê o valor e solta a ligação mesmo assim."""
    done, payout = await concluded(client, world, "Nobreak", 200)
    r = await send(client, world.tech, number="55", amount="200.00")
    assert r.status_code == 201, r.text
    sent = r.json()
    real = payouts_svc.on_assignee_changed
    calls: list[int] = []

    async def linked_first(*args: object) -> None:
        calls.append(1)
        await _link(engine, payout, sent["id"])
        await real(*args)  # type: ignore[arg-type]

    monkeypatch.setattr(payouts_svc, "on_assignee_changed", linked_first)
    r = await _reassign(client, world, done["id"], world.tech_other)
    assert r.status_code == 200, r.text
    assert calls == [1]
    assert await _payout_row(engine, payout) == (str(world.tech_other.user.id), None)
    (mine,) = (await client.get(f"{API}/me/invoices", headers=world.tech.headers)).json()
    assert (mine["id"], mine["payouts"]) == (sent["id"], [])


@requires_db
async def test_reassign_waits_for_the_invoice_being_sent(
    client: AsyncClient, world: World, media: Path, engine: AsyncEngine
) -> None:
    """O envio da nota segura o valor (FOR UPDATE) e liga: a troca de técnico espera o commit dele
    e, depois, solta a ligação."""
    done, payout = await concluded(client, world, "Nobreak", 200)
    r = await send(client, world.tech, number="56", amount="200.00")
    assert r.status_code == 201, r.text
    sent = r.json()
    async with engine.connect() as conn:
        sending = await conn.begin()
        await conn.execute(
            text("SELECT id FROM ticket_payouts WHERE id = :p FOR UPDATE"), {"p": payout}
        )
        await conn.execute(
            text("UPDATE ticket_payouts SET invoice_id = :i WHERE id = :p"),
            {"i": sent["id"], "p": payout},
        )
        task = asyncio.create_task(_reassign(client, world, done["id"], world.tech_other))
        try:
            waited = await _someone_waits_for_a_lock(engine)
        finally:
            await sending.commit()
        r = await asyncio.wait_for(task, 30)
    assert waited
    assert r.status_code == 200, r.text
    assert await _payout_row(engine, payout) == (str(world.tech_other.user.id), None)


@requires_db
async def test_link_to_another_technicians_invoice_counts_as_free(
    client: AsyncClient, world: World, media: Path, engine: AsyncEngine
) -> None:
    """Valor ligado à nota de outro técnico (forçado no banco): para o dono do valor, a OS está
    livre, e o envio dele sobrescreve a ligação sem mostrar o número da nota do outro."""
    other = world.tech_other
    done, payout = await concluded(client, world, "Nobreak", 200, tech=other)
    old, old_payout = await concluded(client, world, "Rack", 100, tech=other)
    r = await send(client, world.tech, number="4567", amount="300.00")
    assert r.status_code == 201, r.text
    theirs = r.json()
    async with engine.begin() as conn:
        # A OS "Rack" foi concluída num mês anterior.
        await conn.execute(
            text("UPDATE tickets SET resolved_at = resolved_at - interval '40 days' WHERE id = :t"),
            {"t": old["id"]},
        )
    for payout_id in (payout, old_payout):
        await _link(engine, payout_id, theirs["id"])

    r = await client.get(
        f"{API}/me/invoices/payouts", params={"month": _month()}, headers=other.headers
    )
    assert [(c["payout_id"], c["in_month"], c["invoice"]) for c in r.json()] == [
        (payout, True, None),
        (old_payout, False, None),
    ]
    r = await send(
        client, other, number="77", amount="300.00", payout_ids=f"{payout},{old_payout}"
    )
    assert r.status_code == 201, r.text
    sent = r.json()
    assert [p["payout_id"] for p in sent["payouts"]] == [payout, old_payout]
    for payout_id in (payout, old_payout):
        assert await _payout_row(engine, payout_id) == (str(other.user.id), sent["id"])
    # A nota do outro técnico continua sem essas OS.
    (mine,) = (await client.get(f"{API}/me/invoices", headers=world.tech.headers)).json()
    assert (mine["id"], mine["payouts"]) == (theirs["id"], [])


def test_storage_sniff_document() -> None:
    assert storage.sniff_document(PDF) == "application/pdf"
    assert storage.sniff_document(b"\n\n%PDF-1.7\n") == "application/pdf"
    assert storage.sniff_document(XML) == "application/xml"
    assert storage.sniff_document(b"\xef\xbb\xbf  <CompNfse>") == "application/xml"
    assert storage.sniff_document(JPEG) == "image/jpeg"
    assert storage.sniff_document(PNG) == "image/png"
    assert storage.sniff_document(HTML) is None
    assert storage.sniff_document(b"  <html><body></body></html>") is None
    assert storage.sniff_document(b"<svg xmlns='http://www.w3.org/2000/svg'/>") is None
    assert storage.sniff_document(b"<script>alert(1)</script>") is None
    assert storage.sniff_document(b"nota fiscal em texto") is None
    assert storage.sniff_document(b"") is None

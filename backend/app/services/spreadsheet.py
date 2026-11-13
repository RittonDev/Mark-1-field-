"""Leitura de planilhas de importação (CSV do Excel brasileiro ou XLSX).

CSV: aceita UTF-8 (com ou sem BOM), UTF-16 ("Texto Unicode" do Excel) e Windows-1252, separado
por ";", "," ou TAB. XLSX: primeira aba, cabeçalho na primeira linha. Os nomes das colunas são
normalizados (minúsculas, sem acento, espaços viram "_"), então "E-mail", "email" e "EMAIL"
batem. O .xls antigo não é lido: o aviso pede para salvar como .xlsx ou CSV.
"""

import csv
import io
import unicodedata
import zipfile
from typing import Any

from fastapi import UploadFile

MAX_ROWS = 5000
MAX_COLUMNS = 60
MAX_BYTES = 5 * 1024 * 1024
# XLSX é um ZIP: acima disso descompactado, é planilha grande demais (ou arquivo malicioso).
MAX_UNZIPPED_BYTES = 50 * 1024 * 1024
_OLE_HEADER = b"\xd0\xcf\x11\xe0"  # .xls (Excel 97-2003)
TOO_BIG = "Arquivo maior que 5 MB: divida a planilha em partes"
CSV_UNREADABLE = (
    "Não foi possível ler o CSV. No Excel, salve como CSV UTF-8 (separado por ponto e vírgula)"
)


class SpreadsheetError(Exception):
    pass


async def read_upload(upload: UploadFile, max_bytes: int = MAX_BYTES) -> bytes:
    """Lê o arquivo enviado sem passar do limite (um arquivo enorme não vai inteiro à memória)."""
    data = await upload.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise SpreadsheetError(TOO_BIG)
    return data


def normalize_header(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode()
    return "_".join(text.strip().lower().replace("-", " ").replace("/", " ").split())


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)  # telefone/CEP lidos como número pelo Excel
    return str(value).strip()


def _rows(
    header: list[Any], body: list[list[Any]], aliases: dict[str, str]
) -> list[dict[str, str]]:
    keys = [aliases.get(normalize_header(h), normalize_header(h)) for h in header[:MAX_COLUMNS]]
    out = []
    for raw in body:
        values = [_cell(v) for v in raw[:MAX_COLUMNS]]
        if not any(values):
            continue
        out.append({k: (values[i] if i < len(values) else "") for i, k in enumerate(keys) if k})
        if len(out) > MAX_ROWS:
            raise SpreadsheetError(f"Planilha com mais de {MAX_ROWS} linhas: divida em partes")
    return out


def _decode(data: bytes) -> str:
    # UTF-16 ("Texto Unicode" do Excel): começa pela marca BOM; sem ela, o NUL denuncia.
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return data.decode("utf-16")
        except UnicodeDecodeError as exc:
            raise SpreadsheetError(CSV_UNREADABLE) from exc
    if b"\x00" in data:
        raise SpreadsheetError(CSV_UNREADABLE)
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise SpreadsheetError(CSV_UNREADABLE)


def _delimiter(first_line: str) -> str:
    """O separador que mais aparece no cabeçalho (";" do Excel brasileiro ganha no empate)."""
    counts = {d: first_line.count(d) for d in (";", ",", "\t")}
    return max(counts, key=lambda d: (counts[d], d == ";", d == ","))


def _read_csv(data: bytes, aliases: dict[str, str]) -> list[dict[str, str]]:
    text = _decode(data)
    first_line = text.splitlines()[0] if text else ""
    try:
        table = list(csv.reader(io.StringIO(text), delimiter=_delimiter(first_line)))
    except csv.Error as exc:  # campo enorme, aspas quebradas
        raise SpreadsheetError(CSV_UNREADABLE) from exc
    if not table:
        raise SpreadsheetError("Planilha vazia")
    return _rows(table[0], table[1:], aliases)


def _check_zip(data: bytes) -> None:
    """XLSX "bomba": poucos MB que descompactam em GB travariam a API."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            unzipped = sum(info.file_size for info in archive.infolist())
    except zipfile.BadZipFile as exc:
        raise SpreadsheetError("Arquivo XLSX inválido") from exc
    if unzipped > MAX_UNZIPPED_BYTES:
        raise SpreadsheetError(TOO_BIG)


def _read_xlsx(data: bytes, aliases: dict[str, str]) -> list[dict[str, str]]:
    from openpyxl import load_workbook

    _check_zip(data)
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # arquivo corrompido ou não é XLSX
        raise SpreadsheetError("Arquivo XLSX inválido") from exc
    try:
        sheet = wb.worksheets[0]
        table = [
            list(r)
            for r in sheet.iter_rows(values_only=True, max_row=MAX_ROWS + 2, max_col=MAX_COLUMNS)
        ]
    except Exception as exc:
        raise SpreadsheetError("Arquivo XLSX inválido") from exc
    finally:
        wb.close()
    if not table:
        raise SpreadsheetError("Planilha vazia")
    return _rows(table[0], table[1:], aliases)


def read_table(
    filename: str, data: bytes, aliases: dict[str, str] | None = None
) -> list[dict[str, str]]:
    """Linhas da planilha como dicionários {coluna_normalizada: valor}."""
    if len(data) > MAX_BYTES:
        raise SpreadsheetError(TOO_BIG)
    aliases = aliases or {}
    if data[:4] == _OLE_HEADER:
        raise SpreadsheetError("Arquivo .xls antigo: no Excel, salve como .xlsx ou CSV")
    if data[:4] == b"PK\x03\x04" or filename.lower().endswith(".xlsx"):
        return _read_xlsx(data, aliases)
    return _read_csv(data, aliases)

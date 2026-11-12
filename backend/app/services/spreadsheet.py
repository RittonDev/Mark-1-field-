"""Leitura de planilhas de importação (CSV do Excel brasileiro ou XLSX).

CSV: aceita UTF-8 (com ou sem BOM) e Windows-1252, separado por ";" ou ",".
XLSX: primeira aba, cabeçalho na primeira linha. Os nomes das colunas são normalizados
(minúsculas, sem acento, espaços viram "_"), então "E-mail", "email" e "EMAIL" batem.
"""

import csv
import io
import unicodedata
from typing import Any

MAX_ROWS = 5000
MAX_BYTES = 5 * 1024 * 1024


class SpreadsheetError(Exception):
    pass


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
    keys = [aliases.get(normalize_header(h), normalize_header(h)) for h in header]
    out = []
    for raw in body:
        values = [_cell(v) for v in raw]
        if not any(values):
            continue
        out.append({k: (values[i] if i < len(values) else "") for i, k in enumerate(keys) if k})
    if len(out) > MAX_ROWS:
        raise SpreadsheetError(f"Planilha com mais de {MAX_ROWS} linhas: divida em partes")
    return out


def _read_csv(data: bytes, aliases: dict[str, str]) -> list[dict[str, str]]:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - cp1252 decodifica quase tudo
        raise SpreadsheetError("Não foi possível ler o arquivo (codificação desconhecida)")
    first_line = text.splitlines()[0] if text else ""
    delimiter = ";" if first_line.count(";") >= first_line.count(",") else ","
    table = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    if not table:
        raise SpreadsheetError("Planilha vazia")
    return _rows(table[0], table[1:], aliases)


def _read_xlsx(data: bytes, aliases: dict[str, str]) -> list[dict[str, str]]:
    from openpyxl import load_workbook

    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # arquivo corrompido ou não é XLSX
        raise SpreadsheetError("Arquivo XLSX inválido") from exc
    sheet = wb.worksheets[0]
    table = [list(r) for r in sheet.iter_rows(values_only=True, max_row=MAX_ROWS + 2)]
    wb.close()
    if not table:
        raise SpreadsheetError("Planilha vazia")
    return _rows(table[0], table[1:], aliases)


def read_table(
    filename: str, data: bytes, aliases: dict[str, str] | None = None
) -> list[dict[str, str]]:
    """Linhas da planilha como dicionários {coluna_normalizada: valor}."""
    if len(data) > MAX_BYTES:
        raise SpreadsheetError("Arquivo maior que 5 MB")
    aliases = aliases or {}
    if data[:4] == b"PK\x03\x04" or filename.lower().endswith(".xlsx"):
        return _read_xlsx(data, aliases)
    return _read_csv(data, aliases)

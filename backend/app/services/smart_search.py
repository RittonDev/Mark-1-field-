"""Busca inteligente da gestão: uma frase em português vira o recorte da lista de OS.

Exemplos: "16976", "OS-016976", um CNPJ, "boticario abertas", "agendadas amanhã", "técnico João
em novembro/2025", "sem técnico campinas", "pendente pgto", "criadas de 01/11 a 15/11".

O texto é normalizado sem acento e em minúsculas (fold_text; o banco não tem a extensão unaccent)
e lido em camadas. Cada camada consome o pedaço da frase que entendeu e vira um "chip": documento
(CPF/CNPJ), número da OS, período, etiquetas, status, prioridade e nomes (cliente, técnico,
cidade, loja). O que sobra é texto livre (q), procurado nos mesmos campos da busca da lista.

Na consulta das OS o texto livre usa expressão regular com as variantes acentuadas de cada letra
(ex.: "botic[aá...]rio"): o mesmo resultado de fold_words_sql, cerca de 10x mais rápido nas
descrições longas (traduzir letra a letra 15 mil descrições leva quase 1 s por palavra).
"""

import re
import uuid
from bisect import bisect_left
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlalchemy import ColumnElement, and_, case, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.documents import is_valid_cnpj
from app.core.enums import TicketEventType, TicketPriority, TicketStatus, UserRole
from app.db.base import utcnow
from app.models import Customer, Location, Ticket, TicketEvent, User
from app.models.ticket import ticket_helpers
from app.schemas.home import (
    ListFilters,
    SearchChip,
    SearchCustomer,
    SearchLocation,
    SearchTechnician,
    SearchTicket,
    SmartSearchResult,
    tags_out,
)
from app.schemas.ticket import TicketFilters, format_ticket_code
from app.services import search
from app.services.activities import local_today
from app.services.technician_regions import fold_text
from app.services.tickets import MAX_NUMBER, filter_conditions
from app.services.workflow import OPEN_STATUSES

S = TicketStatus
P = TicketPriority
MAX_QUERY = 200
MAX_LIMIT = 20
MAX_PHRASE = 4
LOCATION_CAP = 200
MIN_YEAR, MAX_YEAR = 2000, 2100

# Palavras que não dizem nada sozinhas (artigos, preposições, "chamado", "mostrar"...).
STOP = frozenset(
    """a o as os ao aos de da do das dos em no na nos nas num numa para pra pro pras pros com por
    pelo pela pelos pelas e ou que um uma uns umas todas todos toda todo me mostrar mostre mostra
    ver veja listar liste lista quais qual quero buscar busca procurar procure achar ache chamado
    chamados ordem ordens servico servicos ticket tickets dia dias ate entre desde durante mes
    semana ano sobre visita visitas""".split()
)
TECH_KW = frozenset({"tecnico", "tecnica", "tecnicos", "tecnicas", "tec"})
CUSTOMER_KW = frozenset({"cliente", "clientes", "empresa"})
LOCATION_KW = frozenset({"loja", "lojas", "filial", "filiais", "unidade", "local"})
CITY_KW = frozenset({"cidade", "municipio"})
KEYWORDS = TECH_KW | CUSTOMER_KW | LOCATION_KW | CITY_KW
# Palavra comum do dia a dia da OS: sozinha, só vira nome se for o nome inteiro.
DOMAIN_WORDS = frozenset(
    """rede redes impressora impressoras camera cameras cftv computador computadores notebook
    internet link servidor switch cabo cabos cabeamento manutencao instalacao preventiva corretiva
    troca sistema energia telefone telefonia wifi acesso senha shopping centro matriz sala andar
    visita visitas equipamento equipamentos rack nobreak tela monitor""".split()
)
# Palavras de etiqueta que não bastam sozinhas para escolher a etiqueta.
GENERIC_TAG_WORDS = frozenset({"ticket", "tickets", "tecnico", "nao", "cliente", "envio"})

_ACCENTS = {
    "a": "aáàâãäAÁÀÂÃÄ",
    "e": "eéèêëEÉÈÊË",
    "i": "iíìîïIÍÌÎÏ",
    "o": "oóòôõöOÓÒÔÕÖ",
    "u": "uúùûüUÚÙÛÜ",
    "c": "cçCÇ",
    "n": "nñNÑ",
}
_WORD = re.compile(r"[a-z0-9]+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

# --------------------------------------------------------------------------- texto


def accent_regex(word: str) -> str:
    """ "boticario" -> regex que casa "Boticário" (as palavras da busca só têm [a-z0-9])."""
    return "".join(f"[{_ACCENTS[ch]}]" if ch in _ACCENTS else ch for ch in word)


def _prefix_regex(word: str) -> str:
    """Começo de palavra: "botic" casa "O Boticário" e não "Abotica"; número só inteiro."""
    if word.isdigit():
        return rf"(^|[^0-9]){word}([^0-9]|$)"
    return rf"(^|[^[:alnum:]]){accent_regex(word)}"


def name_words(name: str | None) -> tuple[str, ...]:
    """Palavras de um nome sem acento, sem as que não dizem nada ("O Boticário" -> boticario)."""
    words = _WORD.findall(fold_text(name))
    useful = tuple(w for w in words if w not in STOP)
    return useful or tuple(words)


def close(a: str, b: str) -> bool:
    """No máximo uma letra de diferença (trocada, faltando, sobrando ou invertida)."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        diff = [i for i in range(la) if a[i] != b[i]]
        if len(diff) == 1:
            return True
        return (
            len(diff) == 2
            and diff[1] == diff[0] + 1
            and a[diff[0]] == b[diff[1]]
            and a[diff[1]] == b[diff[0]]
        )
    short, long_ = (a, b) if la < lb else (b, a)
    i = 0
    while i < len(short) and short[i] == long_[i]:
        i += 1
    return short[i:] == long_[i + 1 :]


def score(phrase: Sequence[str], words: tuple[str, ...]) -> int:
    """Quanto a frase casa com o nome: 3 = o nome inteiro, 2 = palavras exatas, 1 = começo de
    palavra (3+ letras; número só exato), 0 = não casa. Cada palavra usa uma palavra do nome."""
    used: set[int] = set()
    exact = True
    for w in phrase:
        hit = next((i for i, cw in enumerate(words) if i not in used and cw == w), None)
        if hit is None and len(w) >= 3 and not w.isdigit():
            hit = next(
                (i for i, cw in enumerate(words) if i not in used and cw.startswith(w)), None
            )
            exact = False
        if hit is None:
            return 0
        used.add(hit)
    if not exact:
        return 1
    return 3 if len(used) == len(words) else 2


# --------------------------------------------------------------------------- candidatos


@dataclass
class Cand:
    kind: str  # customer | technician | city | location
    id: Any
    name: str
    words: tuple[str, ...] = ()
    active: bool = True
    city: str | None = None
    document: str | None = None
    code: str | None = None
    customer_id: uuid.UUID | None = None
    customer: str | None = None
    hits: int = 0


class Pool:
    """Nomes de um tipo, indexados por palavra (exata e pelo começo)."""

    def __init__(self, cands: list[Cand]) -> None:
        self.cands = cands
        self.by_word: dict[str, set[int]] = defaultdict(set)
        for i, cand in enumerate(cands):
            for w in cand.words:
                self.by_word[w].add(i)
        self.vocab = sorted(self.by_word)
        self._having: dict[str, set[int]] = {}

    def having(self, word: str) -> set[int]:
        if word in self._having:
            return self._having[word]
        found = set(self.by_word.get(word, ()))
        if len(word) >= 3 and not word.isdigit():
            i = bisect_left(self.vocab, word)
            while i < len(self.vocab) and self.vocab[i].startswith(word):
                found |= self.by_word[self.vocab[i]]
                i += 1
        self._having[word] = found
        return found

    def match(self, phrase: Sequence[str]) -> list[tuple[int, Cand]]:
        ids: set[int] | None = None
        for w in phrase:
            ids = self.having(w) if ids is None else ids & self.having(w)
            if not ids:
                return []
        out = []
        for i in ids or ():
            s = score(phrase, self.cands[i].words)
            if s:
                out.append((s, self.cands[i]))
        return out

    def typo(self, word: str) -> list[tuple[int, Cand]]:
        """Nomes com uma palavra a uma letra de distância (palavras de 5+ letras)."""
        ids: set[int] = set()
        for w in self.vocab:
            if w[0] == word[0] and abs(len(w) - len(word)) <= 1 and close(w, word):
                ids |= self.by_word[w]
        return [(1, self.cands[i]) for i in ids]


def pick(matches: list[tuple[int, Cand]]) -> Cand | None:
    """O nome que vira filtro: só quando não há dúvida (homônimos: vale o único ativo)."""
    if not matches:
        return None
    best = max(s for s, _ in matches)
    top = [c for s, c in matches if s == best]
    if len(top) > 1:
        active = [c for c in top if c.active]
        if len(active) != 1:
            return None
        top = active
    chosen = top[0]
    if chosen.kind == "city" and best < 3:
        return None  # cidade só pelo nome inteiro ("paulo" não é "São Paulo")
    return chosen


# --------------------------------------------------------------------------- períodos

MONTHS = (
    "janeiro",
    "fevereiro",
    "marco",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)
MONTH_LABELS = (
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)
MONTH_ABBR = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")
_MONTH_NUMBER = {name: i + 1 for i, name in enumerate(MONTHS)} | {
    name: i + 1 for i, name in enumerate(MONTH_ABBR)
}
_FULL = "|".join(MONTHS)
_ANY_MONTH = "|".join((*MONTHS, *MONTH_ABBR))
# dd/mm, dd/mm/aa(aa), dd-mm-aaaa, dd.mm.aaaa (com ponto só a data inteira) e aaaa-mm-dd.
_D = r"(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\.\d{1,2}\.\d{2,4})"
_L = r"(?<![\w/.-])"
_R = r"(?![\w/.-])"

RANGE_RX = re.compile(
    rf"{_L}(?:(?:de|entre|desde|do dia)\s+)?({_D})"
    rf"(?:\s+(?:a|ate|e|ao)\s+|\s*-\s*|\s*~\s*)({_D}){_R}"
)
DATE_RX = re.compile(rf"{_L}({_D}){_R}")
MONTH_YEAR_NUM_RX = re.compile(rf"{_L}(\d{{1,2}})[/-](\d{{4}}){_R}")
DAY_MONTH_RX = re.compile(rf"\b(\d{{1,2}})\s+de\s+({_FULL})(?:\s+de\s+(\d{{4}}))?\b")
MONTH_YEAR_RX = re.compile(rf"\b({_ANY_MONTH})\b\.?\s*(?:de\s+|/|-)?\s*(\d{{4}})\b")
MONTH_YY_RX = re.compile(rf"\b({_ANY_MONTH})\.?\s*[/-]\s*(\d{{2}})\b")
MONTH_RX = re.compile(rf"\b({_FULL})\b")
YEAR_RANGE_RX = re.compile(r"\b(?:de|entre)\s+(\d{4})\s+(?:a|e|ate)\s+(\d{4})\b")
YEAR_RX = re.compile(r"(?<![\w/.-])(\d{4})(?![\w/.-])")
LAST_N_RX = re.compile(r"\bultim[oa]s\s+(\d{1,4})\s+(dias?|semanas?|mes|meses|anos?)\b")
NEXT_N_RX = re.compile(r"\bproxim[oa]s\s+(\d{1,3})\s+(dias?|semanas?)\b")
# "março" sozinho também é nome de gente: vale como mês depois de "em", "de", "mês de"...
_MONTH_CUE = re.compile(r"\b(?:em|de|mes|desde|durante|ate|no|criadas?|agendadas?)\s*$")
# "loja 2015", "OS 2024": o número não é ano.
_NOT_YEAR_CUE = re.compile(r"\b(?:loja|filial|unidade|codigo|cod|os|n[o.]?)\s*$")

CREATED_KW = re.compile(
    r"(?<!em )\b(?:criad[ao]s?|abert[ao]s?|abertura|registrad[ao]s?|recebid[ao]s?"
    r"|cadastrad[ao]s?)\b"
)
SCHEDULED_KW = re.compile(
    r"(?<!sem )\b(?:agendad[ao]s?|agenda|agendamentos?|para|pra|visitas?|marcad[ao]s?"
    r"|programad[ao]s?|previst[ao]s?)\b"
)


@dataclass
class Period:
    start: date
    end: date
    label: str
    default: str  # created | scheduled (quando a frase não diz)
    pos: int
    end_pos: int


def _add_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def _month(year: int, month: int) -> tuple[date, date]:
    start = date(year, month, 1)
    return start, _add_months(start, 1) - timedelta(days=1)


def _fmt(day: date) -> str:
    return day.strftime("%d/%m/%Y")


def _tense(start: date, today: date) -> str:
    """Sem palavra que diga: período futuro é agenda; passado, abertura."""
    return "scheduled" if start > today else "created"


def _year(value: str | None) -> int | None:
    if not value:
        return None
    year = int(value) + (2000 if len(value) == 2 else 0)
    return year if MIN_YEAR <= year <= MAX_YEAR else None


def parse_date(value: str, today: date, default_year: int | None = None) -> tuple[date, bool] | None:
    """ "12/11", "12/11/25", "12-11-2025", "2025-11-12" -> (data, se veio com ano)."""
    parts = re.split(r"[/.-]", value)
    try:
        if len(parts[0]) == 4:
            year, month, day = (int(p) for p in parts)
            has_year = True
        else:
            day, month = int(parts[0]), int(parts[1])
            has_year = len(parts) == 3
            found = _year(parts[2]) if has_year else (default_year or today.year)
            if found is None:
                return None
            year = found
        if not MIN_YEAR <= year <= MAX_YEAR:
            return None
        return date(year, month, day), has_year
    except (ValueError, IndexError):
        return None


def _relative(today: date) -> list[tuple[re.Pattern[str], tuple[date, date, str, str]]]:
    monday = today - timedelta(days=today.weekday())
    d = timedelta
    last = _add_months(today, -1)
    following = _add_months(today, 1)
    rules: list[tuple[str, tuple[date, date, str, str]]] = [
        (r"\bdepois de amanha\b", (today + d(2), today + d(2), "depois de amanhã", "scheduled")),
        (r"\banteontem\b", (today - d(2), today - d(2), "anteontem", "created")),
        (r"\bhoje\b", (today, today, "hoje", "scheduled")),
        (r"\bontem\b", (today - d(1), today - d(1), "ontem", "created")),
        (r"\bamanha\b", (today + d(1), today + d(1), "amanhã", "scheduled")),
        (
            r"\b(?:n|d)?(?:esta|essa)\s+semana\b|\bsemana\s+atual\b",
            (monday, monday + d(6), "esta semana", "scheduled"),
        ),
        (
            r"\bsemana\s+passada\b|\bultima\s+semana\b",
            (monday - d(7), monday - d(1), "semana passada", "created"),
        ),
        (
            r"\bproxima\s+semana\b|\bsemana\s+que\s+vem\b",
            (monday + d(7), monday + d(13), "próxima semana", "scheduled"),
        ),
        (
            r"\b(?:n|d)?(?:este|esse)\s+mes\b|\bmes\s+atual\b",
            (*_month(today.year, today.month), "este mês", "created"),
        ),
        (
            r"\bmes\s+passado\b|\bultimo\s+mes\b",
            (*_month(last.year, last.month), "mês passado", "created"),
        ),
        (
            r"\bproximo\s+mes\b|\bmes\s+que\s+vem\b",
            (*_month(following.year, following.month), "próximo mês", "scheduled"),
        ),
        (
            r"\b(?:n|d)?(?:este|esse)\s+ano\b|\bano\s+atual\b",
            (date(today.year, 1, 1), date(today.year, 12, 31), "este ano", "created"),
        ),
        (
            r"\bano\s+passado\b|\bultimo\s+ano\b",
            (date(today.year - 1, 1, 1), date(today.year - 1, 12, 31), "ano passado", "created"),
        ),
    ]
    return [(re.compile(rx), value) for rx, value in rules]


# --------------------------------------------------------------------------- status e prioridade

# (regex, rótulo, efeito). A ordem importa: as frases mais específicas primeiro.
STATUS_RULES: list[tuple[re.Pattern[str], str, dict[str, Any]]] = [
    (
        re.compile(r"\bsem (?:tecnicos?|responsavel|atribuicao)\b|\bnao atribuid[ao]s?\b"),
        "Sem técnico",
        {"unassigned": True, "open_only": True},
    ),
    (
        re.compile(
            r"\bsem data de visita\b|\bsem (?:agendamento|agenda|data|visita)\b"
            r"|\bnao agendad[ao]s?\b"
        ),
        "Sem agenda",
        {"unscheduled": True, "open_only": True},
    ),
    (
        re.compile(r"\bsem (?:analista|dono|fila)\b"),
        "Sem analista",
        {"no_owner": True, "open_only": True},
    ),
    (
        re.compile(
            r"\b(?:justificar sla|violacao pendente|justificativa pendente|sem justificativa)\b"
        ),
        "Justificar SLA",
        {"violation_pending": True},
    ),
    (
        re.compile(
            r"\b(?:com |de )?sla (?:estourad[ao]|vencid[ao]|violad[ao])\b|\bfora do sla\b"
            r"|\batrasad[ao]s?\b|\bvencid[ao]s?\b|\bestourad[ao]s?\b"
        ),
        "SLA estourado",
        {"sla_breached": True},
    ),
    (re.compile(r"\bimprodutiv[ao]s?\b"), "Improdutivas", {"unproductive": True}),
    (
        re.compile(r"\baguardando (?:o )?cliente\b|\bpendentes? (?:do |de )?cliente\b"),
        "Aguardando cliente",
        {"status": [S.ON_HOLD_CUSTOMER]},
    ),
    (
        re.compile(r"\baguardando (?:o |a )?(?:fornecedor|pecas?|terceiros?)\b"),
        "Aguardando fornecedor/peça",
        {"status": [S.ON_HOLD_VENDOR]},
    ),
    (
        re.compile(r"\bpendentes?\b|\baguardando\b|\bem espera\b|\bpausad[ao]s?\b"),
        "Pendentes",
        {"status": [S.ON_HOLD_CUSTOMER, S.ON_HOLD_VENDOR]},
    ),
    (re.compile(r"\bem campo\b"), "Em campo", {"status": [S.EN_ROUTE, S.IN_PROGRESS]}),
    (
        re.compile(r"\bem deslocamento\b|\ba caminho\b|\bdeslocamento\b"),
        "Em deslocamento",
        {"status": [S.EN_ROUTE]},
    ),
    (
        re.compile(r"\bem (?:atendimento|execucao)\b|\bexecutando\b|\biniciad[ao]s\b"),
        "Em atendimento",
        {"status": [S.IN_PROGRESS]},
    ),
    (
        re.compile(
            r"\bconcluid[ao]s?\b|\bencerrad[ao]s?\b|\bfechad[ao]s?\b|\bfinalizad[ao]s?\b"
            r"|\bresolvid[ao]s?\b"
        ),
        "Concluídas",
        {"status": [S.RESOLVED, S.CLOSED]},
    ),
    (re.compile(r"\bcancelad[ao]s?\b"), "Canceladas", {"status": [S.CANCELLED]}),
    (re.compile(r"\breabert[ao]s?\b"), "Reabertas", {"status": [S.REOPENED]}),
    (re.compile(r"\bem triagem\b|\btriagem\b"), "Em triagem", {"status": [S.TRIAGE]}),
    (re.compile(r"\bagendad[ao]s?\b"), "Agendadas", {"status": [S.SCHEDULED]}),
    (re.compile(r"\batribuid[ao]s?\b"), "Atribuídas", {"status": [S.ASSIGNED]}),
    (re.compile(r"\bnov[ao]s\b"), "Novas", {"status": [S.NEW]}),
    (
        re.compile(r"\bem aberto\b|\babert[ao]s?\b|\bem andamento\b"),
        "Em aberto",
        {"open_only": True},
    ),
]

PRIORITY_RULES: list[tuple[re.Pattern[str], str, list[TicketPriority]]] = [
    (
        re.compile(r"\bprioridade critica\b|\bp1\b|\bcritic[ao]s?\b"),
        "Prioridade crítica",
        [P.CRITICAL],
    ),
    (re.compile(r"\burgentes?\b"), "Urgentes (crítica e alta)", [P.CRITICAL, P.HIGH]),
    (re.compile(r"\bprioridade alta\b|\balta prioridade\b|\bp2\b"), "Prioridade alta", [P.HIGH]),
    (
        re.compile(r"\bprioridade media\b|\bmedia prioridade\b|\bp3\b"),
        "Prioridade média",
        [P.MEDIUM],
    ),
    (
        re.compile(r"\bprioridade baixa\b|\bbaixa prioridade\b|\bp4\b"),
        "Prioridade baixa",
        [P.LOW],
    ),
]

# Nº da OS como a pessoa digita: "OS 16976", "os-016976", "os016976", "#16976", "nº 16976".
OS_NUMBER_RX = re.compile(
    r"(?<![a-z0-9])(?:os|o\.s\.?|#|n[o.]|numero|chamado|ticket)[\s#.:-]*0*(\d{1,10})(?![\w/])"
)
LONE_NUMBER_RX = re.compile(r"\s*#?\s*0*(\d{1,10})\s*")
DOCUMENT_RX = re.compile(r"(?<![\w./-])[0-9a-z][0-9a-z./-]{9,19}(?![\w./-])")


# --------------------------------------------------------------------------- leitura da frase


@dataclass
class Word:
    pos: int
    text: str
    used: bool = False
    location_only: bool = False


@dataclass
class Parsed:
    query: str
    folded: str = ""
    chips: list[tuple[int, SearchChip]] = field(default_factory=list)
    status: list[TicketStatus] = field(default_factory=list)
    priority: list[TicketPriority] = field(default_factory=list)
    flags: dict[str, bool] = field(default_factory=dict)
    number: int | None = None
    number_explicit: bool = False
    document: str | None = None
    document_pos: int = 0
    created: Period | None = None
    scheduled: Period | None = None
    tags: list[str] = field(default_factory=list)
    customer: Cand | None = None
    location: Cand | None = None
    technician: Cand | None = None
    cities: list[Cand] = field(default_factory=list)
    city_words: list[Word] = field(default_factory=list)
    words: list[Word] = field(default_factory=list)
    seen: dict[str, dict[Any, tuple[int, int, Cand]]] = field(
        default_factory=lambda: defaultdict(dict)
    )

    def chip(self, pos: int, kind: str, label: str) -> None:
        self.chips.append((pos, SearchChip(kind=kind, label=label)))  # type: ignore[arg-type]

    def content(self) -> list[Word]:
        """Palavras ainda não entendidas (sem artigos, preposições...)."""
        return [w for w in self.words if not w.used and w.text not in STOP]

    def note(self, matches: Iterable[tuple[int, Cand]], size: int) -> None:
        """Guarda os nomes encontrados para as listas (clientes, lojas, técnicos)."""
        for s, cand in matches:
            if cand.kind == "city":
                continue
            best = self.seen[cand.kind].get(cand.id)
            if best is None or (s, size) > best[:2]:
                self.seen[cand.kind][cand.id] = (s, size, cand)


class Reader:
    """Texto da busca com os pedaços já entendidos apagados (trocados por espaços)."""

    def __init__(self, value: str) -> None:
        self.text = value

    def blank(self, start: int, end: int) -> None:
        self.text = self.text[:start] + " " * (end - start) + self.text[end:]

    def take(self, pattern: re.Pattern[str]) -> list[re.Match[str]]:
        found = list(pattern.finditer(self.text))
        for m in found:
            self.blank(m.start(), m.end())
        return found


def _documents(reader: Reader, parsed: Parsed) -> None:
    """CNPJ (também o alfanumérico) ou CPF, com ou sem pontuação."""
    for m in DOCUMENT_RX.finditer(reader.text):
        clean = re.sub(r"[^0-9a-z]", "", m.group()).upper()
        cnpj = len(clean) == 14 and re.fullmatch(r"[0-9A-Z]{12}[0-9]{2}", clean) is not None
        cnpj = cnpj and (clean.isdigit() or is_valid_cnpj(clean))
        cpf = len(clean) == 11 and clean.isdigit()
        if cnpj or cpf:
            parsed.document, parsed.document_pos = clean, m.start()
            reader.blank(m.start(), m.end())
            return


def _os_number(reader: Reader, parsed: Parsed) -> None:
    """Número da OS com prefixo ("OS 123", "#123") ou a busca só com um número."""
    lone = LONE_NUMBER_RX.fullmatch(reader.text)
    if lone is not None:
        number = int(lone.group(1))
        if 0 < number <= MAX_NUMBER:
            parsed.number = number
            reader.blank(0, len(reader.text))
        return
    for m in OS_NUMBER_RX.finditer(reader.text):
        number = int(m.group(1))
        if 0 < number <= MAX_NUMBER:
            parsed.number, parsed.number_explicit = number, True
            parsed.chip(m.start(), "number", format_ticket_code(number))
            reader.blank(m.start(), m.end())
            return


def read_periods(reader: Reader, today: date, *, alone: bool, wants_schedule: bool) -> list[Period]:
    """Datas, intervalos, meses, anos e "hoje", "semana passada", "últimos 30 dias"..."""
    found: list[Period] = []

    def add(m: re.Match[str], start: date, end: date, label: str, default: str) -> None:
        if start > end:
            start, end = end, start
        found.append(Period(start, end, label, default, m.start(), m.end()))
        reader.blank(m.start(), m.end())

    def month_label(year: int, month: int) -> str:
        return f"{MONTH_LABELS[month - 1]} de {year}"

    for m in list(RANGE_RX.finditer(reader.text)):
        second = parse_date(m.group(2), today)
        if second is None:
            continue
        first = parse_date(m.group(1), today, default_year=second[0].year if second[1] else None)
        if first is None:
            continue
        start, end = first[0], second[0]
        if start > end and not first[1]:
            start = start.replace(year=start.year - 1)
        add(m, start, end, f"{_fmt(start)} a {_fmt(end)}", _tense(start, today))
    for m in list(MONTH_YEAR_NUM_RX.finditer(reader.text)):
        month, year = int(m.group(1)), int(m.group(2))
        if 1 <= month <= 12 and MIN_YEAR <= year <= MAX_YEAR:
            start, end = _month(year, month)
            add(m, start, end, month_label(year, month), _tense(start, today))
    for m in list(DATE_RX.finditer(reader.text)):
        day = parse_date(m.group(1), today)
        if day is not None:
            add(m, day[0], day[0], _fmt(day[0]), _tense(day[0], today))
    for m in list(DAY_MONTH_RX.finditer(reader.text)):
        year = int(m.group(3)) if m.group(3) else today.year
        if not MIN_YEAR <= year <= MAX_YEAR:
            continue
        try:
            day = date(year, _MONTH_NUMBER[m.group(2)], int(m.group(1)))
        except ValueError:
            continue
        add(m, day, day, _fmt(day), _tense(day, today))
    for rx in (MONTH_YEAR_RX, MONTH_YY_RX):
        for m in list(rx.finditer(reader.text)):
            year = _year(m.group(2))
            if year is None:
                continue
            month = _MONTH_NUMBER[m.group(1)]
            start, end = _month(year, month)
            add(m, start, end, month_label(year, month), _tense(start, today))
    for m in list(MONTH_RX.finditer(reader.text)):
        name = m.group(1)
        if name == "marco" and not _MONTH_CUE.search(reader.text[: m.start()]):
            continue
        month = _MONTH_NUMBER[name]
        # Sem ano: o último que já começou (ou o próximo, para a agenda).
        year = today.year if month <= today.month or wants_schedule else today.year - 1
        start, end = _month(year, month)
        add(m, start, end, month_label(year, month), _tense(start, today))
    for m in list(YEAR_RANGE_RX.finditer(reader.text)):
        first, last = sorted((int(m.group(1)), int(m.group(2))))
        if MIN_YEAR <= first and last <= MAX_YEAR:
            add(m, date(first, 1, 1), date(last, 12, 31), f"{first} a {last}", "created")
    if not alone:
        for m in list(YEAR_RX.finditer(reader.text)):
            year = int(m.group(1))
            if not MIN_YEAR <= year <= today.year + 1:
                continue
            if _NOT_YEAR_CUE.search(reader.text[: m.start()]):
                continue
            start = date(year, 1, 1)
            add(m, start, date(year, 12, 31), str(year), _tense(start, today))
    for rx, (start, end, label, default) in _relative(today):
        for m in list(rx.finditer(reader.text)):
            add(m, start, end, label, default)
    for m in list(LAST_N_RX.finditer(reader.text)):
        n, unit = int(m.group(1)), m.group(2)
        if n < 1:
            continue
        if unit.startswith("dia"):
            days, label = n, f"últimos {n} dias"
        elif unit.startswith("semana"):
            days, label = 7 * n, f"últimas {n} semanas"
        elif unit.startswith("ano"):
            days, label = 365 * n, f"últimos {n} anos"
        else:
            days, label = 30 * n, f"últimos {n} meses"
        start = max(today - timedelta(days=days - 1), date(MIN_YEAR, 1, 1))
        add(m, start, today, label, "created")
    for m in list(NEXT_N_RX.finditer(reader.text)):
        n, unit = int(m.group(1)), m.group(2)
        if n < 1:
            continue
        days = n if unit.startswith("dia") else 7 * n
        label = f"próximos {n} dias" if unit.startswith("dia") else f"próximas {n} semanas"
        add(m, today, today + timedelta(days=days - 1), label, "scheduled")
    found.sort(key=lambda p: p.pos)
    return found


def assign_periods(reader: Reader, folded: str, periods: list[Period], parsed: Parsed) -> None:
    """Cada período vale para a abertura ("criadas", "abertas em") ou para a agenda ("agendadas",
    "para", "visita"): manda a palavra mais perto antes dele (ou logo depois). Sem palavra, o
    futuro (e hoje / esta semana) é agenda; o passado, abertura."""
    keywords = [(m.start(), m.end(), "created") for m in CREATED_KW.finditer(folded)]
    keywords += [(m.start(), m.end(), "scheduled") for m in SCHEDULED_KW.finditer(folded)]
    keywords.sort()
    previous_end = 0
    for i, period in enumerate(periods):
        next_start = periods[i + 1].pos if i + 1 < len(periods) else len(folded)
        before = [k for k in keywords if previous_end <= k[0] < period.pos]
        after = [k for k in keywords if period.end_pos <= k[0] < next_start]
        if before:
            target = before[-1][2]
            used = before
        elif after:
            target = after[0][2]
            used = after[:1]
        else:
            target, used = period.default, []
        for start, end, _ in used:
            reader.blank(start, end)
        previous_end = period.end_pos
        if target == "created" and parsed.created is None:
            parsed.created = period
            parsed.chip(period.pos, "period", f"Criadas: {period.label}")
        elif target == "scheduled" and parsed.scheduled is None:
            parsed.scheduled = period
            parsed.chip(period.pos, "period", f"Agendadas: {period.label}")


def read_statuses(reader: Reader, parsed: Parsed) -> None:
    for rx, label, effect in STATUS_RULES:
        found = reader.take(rx)
        if not found:
            continue
        parsed.chip(found[0].start(), "status", label)
        for key, value in effect.items():
            if key == "status":
                parsed.status.extend(s for s in value if s not in parsed.status)
            else:
                parsed.flags[key] = True
    for rx, label, levels in PRIORITY_RULES:
        found = reader.take(rx)
        if found:
            parsed.chip(found[0].start(), "priority", label)
            parsed.priority.extend(p for p in levels if p not in parsed.priority)


# --------------------------------------------------------------------------- etiquetas

# (nome, palavras sem acento, em quantas OS aparece)
Tags = list[tuple[str, tuple[str, ...], int]]
# Etiqueta rara (ex.: um teste) só pela frase inteira, não por uma palavra solta.
SINGLE_WORD_TAG_MIN_USES = 3


def _tag_match(phrase: Sequence[str], tag_words: tuple[str, ...]) -> bool:
    """Cada palavra casa (inteira ou pelo começo) uma palavra da etiqueta, na ordem; a frase pode
    pular palavras ("pendente pgto" -> "Pendente Envio PGTO")."""
    i = 0
    for w in phrase:
        while i < len(tag_words) and not (
            tag_words[i] == w or (len(w) >= 3 and tag_words[i].startswith(w))
        ):
            i += 1
        if i == len(tag_words):
            return False
        i += 1
    return True


def _add_tags(parsed: Parsed, names: Iterable[str], pos: int) -> None:
    for name in names:
        if name not in parsed.tags:
            parsed.tags.append(name)
            parsed.chip(pos, "tag", name)


def read_tag_phrases(reader: Reader, parsed: Parsed, tags: Tags) -> None:
    """Etiquetas de duas palavras ou mais, antes dos status ("pendente pgto" não é "pendentes")."""
    words = [Word(m.start(), m.group()) for m in _WORD.finditer(reader.text)]
    content = [w for w in words if w.text not in STOP]
    for size in range(min(MAX_PHRASE, len(content)), 1, -1):
        for start in range(len(content) - size + 1):
            span = content[start : start + size]
            if any(w.used for w in span):
                continue
            phrase = [w.text for w in span]
            hits = [name for name, tw, _ in tags if len(tw) >= 2 and _tag_match(phrase, tw)]
            if not hits or len(hits) > 3:
                continue
            _add_tags(parsed, hits, span[0].pos)
            for w in span:
                w.used = True
                reader.blank(w.pos, w.pos + len(w.text))


def read_single_tags(parsed: Parsed, tags: Tags) -> None:
    """Uma palavra só: "avulso" -> "Ticket Avulso", "projeto" -> "Projeto"."""
    for w in parsed.content():
        if w.text in GENERIC_TAG_WORDS or w.text in KEYWORDS or len(w.text) < 3:
            continue
        exact = [name for name, tw, _ in tags if tw == (w.text,)]
        hits = exact or [
            name
            for name, tw, uses in tags
            if uses >= SINGLE_WORD_TAG_MIN_USES
            and any(t == w.text or (len(w.text) >= 4 and t.startswith(w.text)) for t in tw)
        ]
        if hits and len(hits) <= 3:
            _add_tags(parsed, hits, w.pos)
            w.used = True


# --------------------------------------------------------------------------- nomes


def _set_entity(parsed: Parsed, cand: Cand, pos: int, span: Sequence[Word] = ()) -> bool:
    if cand.kind == "city":
        if any(c.id == cand.id for c in parsed.cities):
            return False
        parsed.cities.append(cand)
        parsed.city_words.extend(span)
        parsed.chip(pos, "city", cand.name)
        return True
    if getattr(parsed, cand.kind) is not None:
        return False
    setattr(parsed, cand.kind, cand)
    if cand.kind == "technician":
        parsed.chip(pos, "technician", f"Técnico: {cand.name}")
    elif cand.kind == "location":
        label = cand.name
        if cand.code and fold_text(cand.code) not in fold_text(cand.name):
            label = f"{cand.name} ({cand.code})"
        parsed.chip(pos, "location", label)
    else:
        parsed.chip(pos, "customer", cand.name)
    return True


def match_spans(parsed: Parsed, pools: Sequence[Pool], words: Sequence[Word]) -> None:
    """Frases de 4 palavras até 1, da esquerda para a direita: a mais longa que casa ganha."""
    for size in range(min(MAX_PHRASE, len(words)), 0, -1):
        for start in range(len(words) - size + 1):
            span = words[start : start + size]
            if any(w.used for w in span):
                continue
            phrase = [w.text for w in span]
            matches = [m for pool in pools for m in pool.match(phrase)]
            parsed.note(matches, size)
            if size == 1 and phrase[0] in DOMAIN_WORDS:
                matches = [m for m in matches if m[0] == 3]
            chosen = pick(matches)
            if chosen is not None and _set_entity(parsed, chosen, span[0].pos, span):
                for w in span:
                    w.used = True


def keyword_entities(parsed: Parsed, pools: dict[str, Pool]) -> None:
    """ "técnico João", "cliente Natura", "cidade Campinas", "loja 41": o nome logo depois."""
    words = [w for w in parsed.words if not w.used]
    for i, w in enumerate(words):
        if w.used or w.text not in KEYWORDS:
            continue
        w.used = True
        run: list[Word] = []
        for x in words[i + 1 :]:
            if x.text in STOP:
                continue
            if x.used or x.text in KEYWORDS or len(run) == MAX_PHRASE:
                break
            run.append(x)
        if w.text in LOCATION_KW:
            for x in run:
                x.location_only = True
            continue
        kind = "technician" if w.text in TECH_KW else "customer" if w.text in CUSTOMER_KW else "city"
        match_spans(parsed, [pools[kind]], run)


def typo_entities(parsed: Parsed, pools: Sequence[Pool]) -> None:
    """Palavra que não casou com nome nenhum: tenta os nomes com uma letra de diferença."""
    for w in parsed.content():
        if w.location_only or w.text in KEYWORDS or w.text in DOMAIN_WORDS:
            continue
        if len(w.text) < 5 or w.text.isdigit() or any(p.having(w.text) for p in pools):
            continue
        matches = [m for pool in pools for m in pool.typo(w.text)]
        parsed.note(matches, 1)
        named = [m for m in matches if m[1].kind != "city"]
        if len({c.kind for _, c in named}) != 1:
            continue
        chosen = pick(named)
        if chosen is not None and _set_entity(parsed, chosen, w.pos, [w]):
            w.used = True


# --------------------------------------------------------------------------- consultas


async def tag_names(db: AsyncSession) -> Tags:
    """Etiquetas usadas nas OS (as de mesmo nome, ignorando maiúsculas, juntas)."""
    rows = await db.execute(
        text(
            "SELECT min(btrim(t->>'name')) AS name, count(*) AS uses"
            " FROM tickets, jsonb_array_elements(tickets.tags) t"
            " WHERE coalesce(btrim(t->>'name'), '') <> ''"
            " GROUP BY lower(regexp_replace(btrim(t->>'name'), '\\s+', ' ', 'g'))"
        )
    )
    out: Tags = []
    for name, uses in rows:
        words = tuple(_WORD.findall(fold_text(name)))
        if words:
            out.append((name, words, int(uses)))
    out.sort(key=lambda item: (len(item[1]), item[0]))
    return out


async def load_pools(db: AsyncSession) -> dict[str, Pool]:
    customers = [
        Cand("customer", r.id, r.name, name_words(r.name), r.is_active, document=r.document)
        for r in await db.execute(
            select(Customer.id, Customer.name, Customer.document, Customer.is_active)
        )
    ]
    technicians = [
        Cand(
            "technician",
            r.id,
            r.name,
            name_words(r.name),
            r.is_active,
            city=r.base_city or r.home_city,
        )
        for r in await db.execute(
            select(User.id, User.name, User.is_active, User.base_city, User.home_city).where(
                User.role == UserRole.TECHNICIAN
            )
        )
    ]
    city_rows = await db.scalars(
        select(Location.city).where(Location.city.is_not(None), Location.city != "").distinct()
    )
    cities: dict[tuple[str, ...], str] = {}
    for city in city_rows:
        words = tuple(_WORD.findall(fold_text(city)))
        if words:
            cities.setdefault(words, " ".join(city.split()))
    return {
        "customer": Pool(customers),
        "technician": Pool(technicians),
        "city": Pool([Cand("city", name, name, words) for words, name in cities.items()]),
    }


def _code_digits() -> ColumnElement[str]:
    return func.ltrim(func.regexp_replace(Location.code, r"[^0-9]", "", "g"), "0")


def _location_word(word: str) -> ColumnElement[bool]:
    rx = _prefix_regex(word)
    if word.isdigit():
        return or_(_code_digits() == (word.lstrip("0") or "0"), Location.name.regexp_match(rx))
    return or_(
        Location.name.regexp_match(rx, flags="i"), Location.code.regexp_match(rx, flags="i")
    )


def _location_cand(row: Any, words: tuple[str, ...] = ()) -> Cand:
    return Cand(
        "location",
        row.id,
        row.name,
        words,
        row.is_active,
        city=row.city,
        code=row.code,
        customer_id=row.customer_id,
        customer=row.customer,
        hits=int(getattr(row, "hits", 0) or 0),
    )


_LOCATION_COLUMNS = (
    Location.id,
    Location.name,
    Location.code,
    Location.city,
    Location.customer_id,
    Location.is_active,
    Customer.name.label("customer"),
)


async def location_candidates(
    db: AsyncSession, words: Sequence[str], customer_id: uuid.UUID | None
) -> tuple[list[Cand], bool]:
    """Lojas com alguma das palavras (nome ou código), as que têm mais palavras primeiro (e as do
    cliente escolhido antes). Diz também se a lista foi cortada."""
    unique = list(dict.fromkeys(words))[:8]
    if not unique:
        return [], False
    conds = [_location_word(w) for w in unique]
    hits: Any = case((conds[0], 1), else_=0)
    for cond in conds[1:]:
        hits = hits + case((cond, 1), else_=0)
    order: list[Any] = []
    if customer_id is not None:
        order.append(case((Location.customer_id == customer_id, 0), else_=1))
    order += [hits.desc(), Location.is_active.desc(), Location.name]
    rows = (
        await db.execute(
            select(*_LOCATION_COLUMNS, hits.label("hits"))
            .outerjoin(Customer, Customer.id == Location.customer_id)
            .where(or_(*conds))
            .order_by(*order)
            .limit(LOCATION_CAP)
        )
    ).all()
    cands = [
        _location_cand(r, name_words(r.name) + tuple(_WORD.findall(fold_text(r.code))))
        for r in rows
    ]
    return cands, len(rows) == LOCATION_CAP


async def locations_step(db: AsyncSession, parsed: Parsed, entity_words: list[str]) -> None:
    """Loja pelas palavras que sobraram (dentro do cliente escolhido, se houver); a lista de
    lojas mostra as que casaram com as palavras de nome da busca."""
    remaining = [w for w in parsed.content() if w.text not in KEYWORDS]
    words = entity_words + [w.text for w in remaining]
    customer_id = parsed.customer.id if parsed.customer else None
    cands, truncated = await location_candidates(db, words, customer_id)
    if not cands:
        return
    if remaining and parsed.location is None:
        scoped = Pool([c for c in cands if customer_id is None or c.customer_id == customer_id])
        for size in range(min(MAX_PHRASE, len(remaining)), 0, -1):
            for start in range(len(remaining) - size + 1):
                span = remaining[start : start + size]
                if parsed.location is not None or any(w.used for w in span):
                    continue
                phrase = [w.text for w in span]
                if truncated and cands[-1].hits >= len(set(phrase)):
                    continue  # lista cortada: pode haver outra loja igual fora dela
                matches = scoped.match(phrase)
                if size == 1 and phrase[0] in DOMAIN_WORDS:
                    matches = [m for m in matches if m[0] == 3]
                chosen = pick(matches)
                if chosen is not None and _set_entity(parsed, chosen, span[0].pos, span):
                    for w in span:
                        w.used = True
    pool = Pool(cands)
    unique = list(dict.fromkeys(words))
    for size in range(min(MAX_PHRASE, len(unique)), 0, -1):
        for start in range(len(unique) - size + 1):
            parsed.note(pool.match(unique[start : start + size]), size)


async def document_step(db: AsyncSession, parsed: Parsed) -> None:
    """CPF/CNPJ: o cliente (matriz) ou a filial com esse documento."""
    doc = parsed.document
    if doc is None:
        return
    customers = [
        Cand("customer", r.id, r.name, (), r.is_active, document=r.document)
        for r in await db.execute(
            select(Customer.id, Customer.name, Customer.document, Customer.is_active).where(
                Customer.document == doc
            )
        )
    ]
    stores = [
        _location_cand(r)
        for r in await db.execute(
            select(*_LOCATION_COLUMNS)
            .outerjoin(Customer, Customer.id == Location.customer_id)
            .where(Location.document == doc)
            .order_by(Location.is_active.desc(), Location.name)
            .limit(MAX_LIMIT)
        )
    ]
    parsed.note([(3, c) for c in customers + stores], MAX_PHRASE + 1)
    owners = {c.customer_id for c in stores}
    if len(customers) == 1:
        _set_entity(parsed, customers[0], parsed.document_pos)
    elif len(stores) == 1:
        _set_entity(parsed, stores[0], parsed.document_pos)
    elif stores and len(owners) == 1 and stores[0].customer_id is not None:
        # O mesmo CNPJ em vários andares/salas de um prédio: o cliente deles.
        first = stores[0]
        owner = Cand("customer", first.customer_id, first.customer or first.name)
        _set_entity(parsed, owner, parsed.document_pos)
    else:
        # Documento que não está no cadastro: vira texto (pode estar na descrição da OS).
        parsed.words.append(Word(parsed.document_pos, doc.lower()))


async def lone_number_step(db: AsyncSession, parsed: Parsed) -> None:
    """Só um número: a OS com esse número; sem ela, a loja com esse código; senão, texto (nº do
    chamado do cliente, descrição...)."""
    number = parsed.number
    if number is None or parsed.number_explicit:
        return
    found = await db.scalar(select(Ticket.id).where(Ticket.number == number))
    stores = [
        _location_cand(r)
        for r in await db.execute(
            select(*_LOCATION_COLUMNS)
            .outerjoin(Customer, Customer.id == Location.customer_id)
            .where(_code_digits() == str(number))
            .order_by(Location.is_active.desc(), Location.name)
            .limit(MAX_LIMIT)
        )
    ]
    parsed.note([(3, c) for c in stores], 1)
    if found is not None:
        parsed.chip(0, "number", format_ticket_code(number))
        return
    parsed.number = None
    if len(stores) == 1:
        _set_entity(parsed, stores[0], 0)
    else:
        parsed.words.append(Word(0, str(number)))


# --------------------------------------------------------------------------- filtros e OS


def acted_clause(technician_id: uuid.UUID, name: str | None) -> ColumnElement[bool]:
    """ "Técnico que atuou": o responsável de agora, outro técnico da visita ou quem já foi
    responsável ou auxiliar (histórico). Nas atribuições feitas aqui o evento guarda os ids
    (to_value/from_value e added_ids); nas importadas do Field Control, o nome do técnico."""
    tid = str(technician_id)
    targets = [tid] + ([name[:64]] if name else [])
    assigned = select(TicketEvent.ticket_id).where(
        TicketEvent.event_type == TicketEventType.ASSIGNED,
        or_(TicketEvent.to_value.in_(targets), TicketEvent.from_value == tid),
    )
    helped = select(TicketEvent.ticket_id).where(
        TicketEvent.event_type == TicketEventType.HELPERS_CHANGED,
        TicketEvent.data["added_ids"].contains([tid]),
    )
    return or_(
        Ticket.assignee_id == technician_id,
        Ticket.id.in_(
            select(ticket_helpers.c.ticket_id).where(ticket_helpers.c.user_id == technician_id)
        ),
        Ticket.id.in_(assigned),
        Ticket.id.in_(helped),
    )


def text_clause(word: str) -> ColumnElement[bool]:
    """Uma palavra do texto livre nos campos da busca da lista (services/tickets.search_clause):
    loja (nome, código, cidade), cliente, técnicos, título, solicitante, nº do chamado do cliente
    e descrição; sem acento e sem diferença de maiúsculas."""
    rx = accent_regex(word)
    stores = select(Location.id).where(
        or_(
            Location.name.regexp_match(rx, flags="i"),
            Location.code.regexp_match(rx, flags="i"),
            Location.city.regexp_match(rx, flags="i"),
        )
    )
    customers = select(Customer.id).where(Customer.name.regexp_match(rx, flags="i"))
    people = select(User.id).where(User.name.regexp_match(rx, flags="i"))
    return or_(
        Ticket.location_id.in_(stores),
        Ticket.customer_id.in_(customers),
        Ticket.assignee_id.in_(people),
        Ticket.id.in_(
            select(ticket_helpers.c.ticket_id).where(ticket_helpers.c.user_id.in_(people))
        ),
        Ticket.title.regexp_match(rx, flags="i"),
        Ticket.requester_name.regexp_match(rx, flags="i"),
        Ticket.client_reference.regexp_match(rx, flags="i"),
        Ticket.description.regexp_match(rx, flags="i"),
    )


def _original_words(query: str) -> dict[str, str]:
    """Palavra sem acento -> como a pessoa digitou ("impressao" -> "impressão")."""
    out: dict[str, str] = {}
    for token in re.findall(r"\w+", query):
        for folded in _WORD.findall(fold_text(token)):
            out.setdefault(folded, token if fold_text(token) == folded else folded)
    return out


def free_text(parsed: Parsed) -> tuple[str | None, list[Word]]:
    """O texto livre (q): o que sobrou mais as cidades (procuradas na cidade da loja)."""
    free = [w for w in parsed.content() if w.text not in KEYWORDS]
    words = sorted(free + parsed.city_words, key=lambda w: w.pos)
    terms = search.words(" ".join(w.text for w in words))
    return (" ".join(terms) or None), free


def build_filters(parsed: Parsed, q: str | None) -> ListFilters | None:
    flags = parsed.flags
    filters = ListFilters(
        status=parsed.status or None,
        priority=parsed.priority or None,
        number=parsed.number,
        customer_id=parsed.customer.id if parsed.customer else None,
        location_id=parsed.location.id if parsed.location else None,
        technician_id=parsed.technician.id if parsed.technician else None,
        tag=parsed.tags or None,
        created_from=parsed.created.start if parsed.created else None,
        created_to=parsed.created.end if parsed.created else None,
        scheduled_from=parsed.scheduled.start if parsed.scheduled else None,
        scheduled_to=parsed.scheduled.end if parsed.scheduled else None,
        q=q,
        open_only=flags.get("open_only") or None,
        sla_breached=flags.get("sla_breached") or None,
        unassigned=flags.get("unassigned") or None,
        no_owner=flags.get("no_owner") or None,
        violation_pending=flags.get("violation_pending") or None,
    )
    extra = flags.get("unscheduled") or flags.get("unproductive")
    if not filters.model_dump() and not extra:
        return None
    return filters


def ticket_conditions(
    user: User, filters: ListFilters, parsed: Parsed
) -> list[ColumnElement[bool]]:
    """As condições da lista (filter_conditions) + técnico que atuou, o texto livre e os recortes
    que a lista ainda não tem (sem agenda, improdutivas)."""
    base = TicketFilters(
        status=filters.status,
        priority=filters.priority,
        number=filters.number,
        customer_id=filters.customer_id,
        location_id=filters.location_id,
        assignee_id=filters.assignee_id,
        tag=filters.tag,
        created_from=filters.created_from,
        created_to=filters.created_to,
        scheduled_from=filters.scheduled_from,
        scheduled_to=filters.scheduled_to,
        open_only=bool(filters.open_only),
        sla_breached=bool(filters.sla_breached),
        unassigned=bool(filters.unassigned),
        no_owner=bool(filters.no_owner),
        violation_pending=bool(filters.violation_pending),
    )
    conds = filter_conditions(user, base, utcnow())
    if parsed.technician is not None:
        conds.append(acted_clause(parsed.technician.id, parsed.technician.name))
    if filters.q:
        terms = search.words(filters.q)
        if terms:
            clause = and_(*(text_clause(t) for t in terms))
            # Como na lista: um número sozinho também é o nº da OS.
            if len(terms) == 1 and terms[0].isdigit() and 0 < int(terms[0]) <= MAX_NUMBER:
                clause = or_(Ticket.number == int(terms[0]), clause)
            conds.append(clause)
    if parsed.flags.get("unscheduled"):
        conds.append(Ticket.scheduled_start.is_(None))
    if parsed.flags.get("unproductive"):
        conds.append(Ticket.unproductive_count > 0)
    return conds


async def find_tickets(
    db: AsyncSession, user: User, filters: ListFilters, parsed: Parsed, limit: int
) -> tuple[int, list[SearchTicket]]:
    """As OS do recorte (o nº exato primeiro; depois a agenda ou o mais recente) e o total."""
    tech = aliased(User, name="search_technician")
    order: list[Any] = []
    if filters.number is not None:
        order.append(case((Ticket.number == filters.number, 0), else_=1))
    if filters.scheduled_from is not None:
        order.append(Ticket.scheduled_start.asc().nulls_last())
    else:
        order.append(func.greatest(Ticket.scheduled_start, Ticket.created_at).desc())
    order.append(Ticket.number.desc())
    rows = (
        await db.execute(
            select(
                Ticket.id,
                Ticket.number,
                Ticket.title,
                Ticket.status,
                Ticket.scheduled_start,
                Ticket.created_at,
                Ticket.tags,
                Customer.name.label("customer"),
                Location.name.label("location"),
                Location.city,
                tech.name.label("technician"),
                func.count().over().label("total"),
            )
            .outerjoin(Customer, Customer.id == Ticket.customer_id)
            .outerjoin(Location, Location.id == Ticket.location_id)
            .outerjoin(tech, tech.id == Ticket.assignee_id)
            .where(*ticket_conditions(user, filters, parsed))
            .order_by(*order)
            .limit(limit)
        )
    ).all()
    total = int(rows[0].total) if rows else 0
    return total, [
        SearchTicket(
            id=r.id,
            number=r.number,
            title=r.title,
            status=r.status,
            customer=r.customer,
            location=r.location,
            city=r.city,
            technician=r.technician,
            scheduled_start=r.scheduled_start,
            created_at=r.created_at,
            tags=tags_out(r.tags),
        )
        for r in rows
    ]


def _ranked(parsed: Parsed, kind: str, chosen: Cand | None, limit: int) -> list[Cand]:
    found = list(parsed.seen.get(kind, {}).values())
    found.sort(key=lambda i: (-i[0], -i[1], not i[2].active, -i[2].hits, i[2].name))
    out = [chosen] if chosen is not None else []
    out += [c for _, _, c in found if chosen is None or c.id != chosen.id]
    return out[:limit]


async def customers_out(db: AsyncSession, cands: list[Cand]) -> list[SearchCustomer]:
    if not cands:
        return []
    ids = [c.id for c in cands]
    rows = await db.execute(
        select(Customer.id, Customer.document, func.count(Ticket.id))
        .outerjoin(
            Ticket,
            and_(Ticket.customer_id == Customer.id, Ticket.status.in_(OPEN_STATUSES)),
        )
        .where(Customer.id.in_(ids))
        .group_by(Customer.id, Customer.document)
    )
    info = {r[0]: (r[1], int(r[2] or 0)) for r in rows}
    return [
        SearchCustomer(
            id=c.id,
            name=c.name,
            document=c.document or info.get(c.id, (None, 0))[0],
            open_count=info.get(c.id, (None, 0))[1],
        )
        for c in cands
    ]


# --------------------------------------------------------------------------- busca


def read_query(raw: str | None, today: date, tags: Tags | None = None) -> Parsed:
    """A parte da leitura que não precisa do banco: documento, nº da OS, período, etiquetas de
    várias palavras, status e prioridade. O resto da frase fica em `words`."""
    query = " ".join(_CONTROL.sub(" ", raw or "").split())[:MAX_QUERY]
    folded = fold_text(query)
    parsed = Parsed(query=query, folded=folded)
    reader = Reader(folded)
    _documents(reader, parsed)
    _os_number(reader, parsed)
    alone = not reader.text.strip()
    periods = read_periods(
        reader, today, alone=alone, wants_schedule=SCHEDULED_KW.search(folded) is not None
    )
    assign_periods(reader, folded, periods, parsed)
    if tags:
        read_tag_phrases(reader, parsed, tags)
    read_statuses(reader, parsed)
    parsed.words = [Word(m.start(), m.group()) for m in _WORD.finditer(reader.text)]
    return parsed


def _needs_names(raw: str | None) -> bool:
    """Tem alguma palavra que pode ser nome ou etiqueta (não só número ou documento)?"""
    return any(
        len(w) >= 3 and not w.isdigit() and w not in STOP
        for w in _WORD.findall(fold_text(raw or ""))
    )


async def smart_search(
    db: AsyncSession, user: User, raw: str | None, limit: int = 6
) -> SmartSearchResult:
    limit = max(1, min(limit, MAX_LIMIT))
    tags: Tags = await tag_names(db) if _needs_names(raw) else []
    parsed = read_query(raw, local_today(), tags)
    if not parsed.query or not parsed.folded:
        return SmartSearchResult(query=parsed.query)
    await lone_number_step(db, parsed)
    await document_step(db, parsed)

    if parsed.content():
        pools = await load_pools(db)
        keyword_entities(parsed, pools)
        read_single_tags(parsed, tags)
        entity_words = [w.text for w in parsed.content() if w.text not in KEYWORDS]
        names = [pools["customer"], pools["technician"], pools["city"]]
        match_spans(parsed, names, [w for w in parsed.content() if not w.location_only])
        typo_entities(parsed, names)
        await locations_step(db, parsed, entity_words)

    q, free = free_text(parsed)
    if free:
        original = _original_words(parsed.query)
        parsed.chip(free[0].pos, "text", " ".join(original.get(w.text, w.text) for w in free))
    filters = build_filters(parsed, q)
    total, tickets = 0, []
    if filters is not None:
        total, tickets = await find_tickets(db, user, filters, parsed, limit)

    owner = parsed.customer
    if owner is None and parsed.location is not None and parsed.location.customer_id:
        loc = parsed.location
        owner = Cand("customer", loc.customer_id, loc.customer or loc.name)
    parsed.chips.sort(key=lambda item: item[0])
    return SmartSearchResult(
        query=parsed.query,
        chips=[chip for _, chip in parsed.chips],
        filters=filters,
        total=total,
        tickets=tickets,
        customers=await customers_out(db, _ranked(parsed, "customer", owner, limit)),
        locations=[
            SearchLocation(id=c.id, name=c.name, code=c.code, city=c.city, customer=c.customer)
            for c in _ranked(parsed, "location", parsed.location, limit)
        ],
        technicians=[
            SearchTechnician(id=c.id, name=c.name, city=c.city, active=c.active)
            for c in _ranked(parsed, "technician", parsed.technician, limit)
        ],
    )

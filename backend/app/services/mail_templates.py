"""Textos dos e-mails transacionais: validar o e-mail, boas-vindas e nova senha.

Puro (sem banco): services/mail.py cria os links e chama estas funções na hora do envio, com o nome
da empresa de Configurações. Cada e-mail sai em texto simples e em HTML com o mesmo conteúdo (cartão
branco de até 560 px, título em negrito, botão do link e o link também por extenso, sem imagens) e
termina com a empresa e o rodapé de "não responda". O técnico é terceiro: nada de situação, pontos
ou números do Elo; a conversa sobre o trabalho é pelo WhatsApp.

Links: {WEB_URL}/validar-email#token={token} e {WEB_URL}/definir-senha#token={token} (o token no
fragmento não chega a servidor nem a log).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from html import escape
from typing import NamedTuple

from app.core.config import settings

FOOTER = (
    "Mensagem automática: este endereço não recebe respostas. Para falar com a central, use o "
    "WhatsApp."
)

VERIFY_SUBJECT = "Confirme seu e-mail"
VERIFY_BUTTON = "Confirmar e-mail"
VERIFY_INTRO = {
    "signup": (
        "Recebemos sua ficha de cadastro de técnico parceiro da {company}. Confirme que este "
        "e-mail é seu:"
    ),
    "change": (
        "Você pediu para trocar o e-mail de acesso ao app da {company}. Confirme o novo e-mail; "
        "até lá, você continua entrando com o e-mail atual:"
    ),
    "check": "Confirme que este e-mail é seu para o cadastro de técnico parceiro da {company}:",
}
VERIFY_NOTE = (
    "O link vale por 72 horas e só pode ser usado uma vez. Se não foi você, ignore este e-mail."
)

WELCOME_SUBJECT = "Cadastro aprovado: boas-vindas à {company}"
WELCOME_INTRO = (
    "Seu cadastro de técnico parceiro da {company} foi aprovado. A partir de agora, você pode "
    "receber atendimentos pelo app."
)
WELCOME_STEPS = (
    "Entre no app e confira seus dados em Perfil › Configurações.",
    "Cadastre como quer receber em Configurações › Formas de recebimento.",
    "Marque os dias e turnos em que você atende em Configurações › Dias e horários.",
    'As OS que a central mandar aparecem em Hoje e na Agenda. No dia, toque em "A caminho" ao '
    'sair, "Iniciar atendimento" ao chegar e "Concluir OS" no fim.',
)
# Sem números (pontos, prazos, metas): o Elo pela categoria.
WELCOME_ELO = (
    "O Elo é a sua categoria de técnico parceiro: Bronze, Prata, Ouro e Diamante. Atendimentos "
    "concluídos e chegada no horário combinado fazem o Elo subir; atrasos, faltas e retornos por "
    "falha fazem cair. Você acompanha em Perfil › Meu elo."
)
WELCOME_HELP = "Dúvidas sobre o trabalho? Fale com a central pelo WhatsApp."

RESET_SUBJECT = "Criar uma nova senha"
RESET_BUTTON = "Criar nova senha"
RESET_INTRO = {
    "self": "Recebemos um pedido para criar uma nova senha do app da {company}. Use este link:",
    "central": ("A central da {company} enviou este link para você criar uma nova senha do app:"),
}
RESET_NOTE = (
    "O link vale por 2 horas e só pode ser usado uma vez. Ao criar a nova senha, o app pede para "
    "você entrar de novo nos seus aparelhos."
)
RESET_IGNORE = "Se você não esperava este e-mail, ignore: sua senha continua a mesma."

# Cores do HTML (neutro; o azul só no botão e nos links).
_BACKGROUND = "#f0f2f5"
_TEXT = "#1f2430"
_BUTTON = "#2447ff"
_MUTED = "#687080"
_FONT = "Arial, Helvetica, sans-serif"


class Rendered(NamedTuple):
    subject: str
    text: str
    html: str


def _base_url() -> str:
    return settings.WEB_URL.rstrip("/")


def verify_url(raw: str) -> str:
    """A página que valida o e-mail (o token no fragmento)."""
    return f"{_base_url()}/validar-email#token={raw}"


def password_url(raw: str) -> str:
    """A página "Definir nova senha" (também a primeira senha, pela boas-vindas)."""
    return f"{_base_url()}/definir-senha#token={raw}"


def first_name(name: str | None) -> str:
    """A primeira palavra do nome ("" sem nome)."""
    parts = (name or "").split()
    return parts[0] if parts else ""


def _greeting(name: str | None) -> str:
    first = first_name(name)
    return f"Olá, {first}." if first else "Olá."


# ------------------------------------------------------------------ blocos
# O mesmo conteúdo vira o texto simples e o HTML.


@dataclass(frozen=True)
class _Paragraph:
    text: str
    link: str | None = None  # o link no fim do parágrafo ("…: {link}")


@dataclass(frozen=True)
class _Button:
    url: str
    label: str


@dataclass(frozen=True)
class _Section:
    title: str
    # (texto, link no fim ou None)
    items: tuple[tuple[str, str | None], ...] = ()
    ordered: bool = False
    paragraph: str | None = None


@dataclass(frozen=True)
class _Signature:
    company: str


_Block = _Paragraph | _Button | _Section | _Signature


def _joined(text: str, link: str | None) -> str:
    return f"{text} {link}" if link else text


def _as_text(blocks: Sequence[_Block]) -> str:
    parts: list[str] = []
    for block in blocks:
        if isinstance(block, _Paragraph):
            parts.append(_joined(block.text, block.link))
        elif isinstance(block, _Button):
            parts.append(block.url)
        elif isinstance(block, _Section):
            lines = [block.title]
            for index, (text, link) in enumerate(block.items, start=1):
                bullet = f"{index}." if block.ordered else "-"
                lines.append(f"{bullet} {_joined(text, link)}")
            if block.paragraph:
                lines.append(block.paragraph)
            parts.append("\n".join(lines))
        else:
            parts.append(f"{block.company}\n{FOOTER}")
    return "\n\n".join(parts) + "\n"


def _anchor(url: str) -> str:
    return (
        f'<a href="{escape(url, quote=True)}" style="color:{_BUTTON};word-break:break-all">'
        f"{escape(url)}</a>"
    )


def _html_inline(text: str, link: str | None) -> str:
    return f"{escape(text)} {_anchor(link)}" if link else escape(text)


_P = 'style="margin:0 0 16px;font-size:15px;line-height:1.5"'


def _as_html(subject: str, blocks: Sequence[_Block]) -> str:
    body: list[str] = [
        f'<h1 style="margin:0 0 16px;font-size:20px;font-weight:bold;line-height:1.3">'
        f"{escape(subject)}</h1>"
    ]
    for block in blocks:
        if isinstance(block, _Paragraph):
            body.append(f"<p {_P}>{_html_inline(block.text, block.link)}</p>")
        elif isinstance(block, _Button):
            body.append(
                '<p style="margin:0 0 8px">'
                f'<a href="{escape(block.url, quote=True)}" style="display:inline-block;'
                f"background:{_BUTTON};color:#ffffff;text-decoration:none;font-weight:bold;"
                f'font-size:15px;padding:12px 20px;border-radius:6px">{escape(block.label)}</a></p>'
                f'<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:{_MUTED}">'
                f"{_anchor(block.url)}</p>"
            )
        elif isinstance(block, _Section):
            title = escape(block.title)
            body.append(f'<p style="margin:0 0 8px;font-size:15px;font-weight:bold">{title}</p>')
            if block.items:
                tag = "ol" if block.ordered else "ul"
                items = "".join(
                    f'<li style="margin:0 0 4px">{_html_inline(text, link)}</li>'
                    for text, link in block.items
                )
                body.append(
                    f'<{tag} style="margin:0 0 16px;padding-left:20px;font-size:15px;'
                    f'line-height:1.5">{items}</{tag}>'
                )
            if block.paragraph:
                body.append(f"<p {_P}>{escape(block.paragraph)}</p>")
        else:
            body.append(f"<p {_P}>{escape(block.company)}</p>")
            body.append(
                f'<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:{_MUTED}">'
                f"{escape(FOOTER)}</p>"
            )
    content = "\n".join(body)
    return (
        '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{escape(subject)}</title>\n</head>\n"
        f'<body style="margin:0;padding:0;background:{_BACKGROUND}">\n'
        f'<div style="background:{_BACKGROUND};padding:24px 12px;font-family:{_FONT};'
        f'color:{_TEXT}">\n'
        '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;'
        'padding:24px">\n'
        f"{content}\n</div>\n</div>\n</body>\n</html>\n"
    )


def _render(subject: str, blocks: Sequence[_Block]) -> Rendered:
    return Rendered(subject=subject, text=_as_text(blocks), html=_as_html(subject, blocks))


# ------------------------------------------------------------------ e-mails


def verify_email(*, name: str | None, company: str, reason: str, link: str) -> Rendered:
    """Validar o e-mail. reason: "signup" (a ficha), "change" (o e-mail novo pedido no app) ou
    "check" (o login de sempre; também o padrão)."""
    intro = VERIFY_INTRO.get(reason, VERIFY_INTRO["check"]).format(company=company)
    return _render(
        VERIFY_SUBJECT,
        [
            _Paragraph(_greeting(name)),
            _Paragraph(intro),
            _Button(link, VERIFY_BUTTON),
            _Paragraph(VERIFY_NOTE),
            _Signature(company),
        ],
    )


def welcome(
    *,
    name: str | None,
    company: str,
    email: str,
    password_link: str | None = None,
    verify_link: str | None = None,
    app_url: str | None = None,
) -> Rendered:
    """Cadastro aprovado. `password_link`: o técnico ainda não tem senha (crie a sua neste link, 72
    h); `verify_link`: tem a senha e o e-mail não está validado (só sem `password_link`);
    `app_url`: o TECH_APP_URL (sem ele, pedir o link à central)."""
    if password_link:
        password: tuple[str, str | None] = (
            "Senha: crie a sua neste link, que vale por 72 horas:",
            password_link,
        )
    else:
        password = ("Senha: a que você criou na ficha de cadastro.", None)
    app: tuple[str, str | None] = (
        ("App:", app_url) if app_url else ("App: peça o link à central pelo WhatsApp.", None)
    )
    blocks: list[_Block] = [
        _Paragraph(_greeting(name)),
        _Paragraph(WELCOME_INTRO.format(company=company)),
        _Section("Como entrar", ((f"E-mail: {email}", None), password, app)),
    ]
    if verify_link and not password_link:
        blocks.append(_Paragraph("Confirme também o seu e-mail:", verify_link))
    blocks += [
        _Section("Primeiros passos", tuple((step, None) for step in WELCOME_STEPS), ordered=True),
        _Section("O Elo", paragraph=WELCOME_ELO),
        _Paragraph(WELCOME_HELP),
        _Signature(company),
    ]
    return _render(WELCOME_SUBJECT.format(company=company), blocks)


def password_reset(*, name: str | None, company: str, origin: str, link: str) -> Rendered:
    """Nova senha. origin: "self" (Esqueci minha senha; também o padrão) ou "central" (a central
    mandou o link)."""
    intro = RESET_INTRO.get(origin, RESET_INTRO["self"]).format(company=company)
    return _render(
        RESET_SUBJECT,
        [
            _Paragraph(_greeting(name)),
            _Paragraph(intro),
            _Button(link, RESET_BUTTON),
            _Paragraph(RESET_NOTE),
            _Paragraph(RESET_IGNORE),
            _Signature(company),
        ],
    )

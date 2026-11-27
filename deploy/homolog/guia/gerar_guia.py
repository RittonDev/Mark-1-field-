"""Guia de instalação do app Maxx Field (PWA de homologação) para os técnicos, em PDF A4.

Uso (num contêiner Python com reportlab): python gerar_guia.py <pasta de trabalho>
A pasta precisa ter icon.png (ícone do app) e as fontes Manrope (Manrope_400Regular.ttf, ..._700Bold.ttf,
..._800ExtraBold.ttf). Grava guia-instalacao-maxx-field.pdf na mesma pasta.
"""

import os
import sys

from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

WORK = sys.argv[1] if len(sys.argv) > 1 else "."
APP_URL = "https://tecnico-homolog.maxxsystem.net"
APP_HOST = "tecnico-homolog.maxxsystem.net"

NAVY = colors.HexColor("#111C30")
PRIMARY = colors.HexColor("#2447FF")
INK = colors.HexColor("#1B1F26")
MUTED = colors.HexColor("#525A68")
SOFT = colors.HexColor("#F4F5F7")
SOFT_BLUE = colors.HexColor("#EEF1FF")
LINE = colors.HexColor("#E5E7EB")
AMBER_BG = colors.HexColor("#FFF7E6")
AMBER_LINE = colors.HexColor("#F2C063")
TEAL = colors.HexColor("#2BD4AF")

for name, file in (
    ("Manrope", "Manrope_400Regular.ttf"),
    ("Manrope-SemiBold", "Manrope_600SemiBold.ttf"),
    ("Manrope-Bold", "Manrope_700Bold.ttf"),
    ("Manrope-ExtraBold", "Manrope_800ExtraBold.ttf"),
):
    pdfmetrics.registerFont(TTFont(name, os.path.join(WORK, file)))
pdfmetrics.registerFontFamily(
    "Manrope", normal="Manrope", bold="Manrope-Bold", italic="Manrope", boldItalic="Manrope-Bold"
)

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
HEADER_H = 40 * mm

body = ParagraphStyle("body", fontName="Manrope", fontSize=10.5, leading=15, textColor=INK, alignment=TA_LEFT)
small = ParagraphStyle("small", parent=body, fontSize=9, leading=13, textColor=MUTED)
h2 = ParagraphStyle("h2", parent=body, fontName="Manrope-ExtraBold", fontSize=14, leading=18, spaceBefore=6, spaceAfter=6)
card_title = ParagraphStyle("card_title", parent=body, fontName="Manrope-ExtraBold", fontSize=13, leading=17, textColor=INK)
step = ParagraphStyle("step", parent=body, fontSize=10.5, leading=15, leftIndent=0)
url_style = ParagraphStyle("url", parent=body, fontName="Manrope-ExtraBold", fontSize=15, leading=20, textColor=PRIMARY)


def P(text, style=body):
    return Paragraph(text, style)


class Rule(Flowable):
    def __init__(self, width, color=LINE, thickness=0.8):
        super().__init__()
        self.width, self.color, self.thickness = width, color, thickness

    def wrap(self, *_):
        return self.width, self.thickness + 2

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.thickness)
        self.canv.line(0, 1, self.width, 1)


class QR(Flowable):
    def __init__(self, value, size):
        super().__init__()
        self.value, self.size = value, size

    def wrap(self, *_):
        return self.size, self.size

    def draw(self):
        widget = QrCodeWidget(self.value)
        widget.barLevel = "M"
        x1, y1, x2, y2 = widget.getBounds()
        drawing = Drawing(self.size, self.size, transform=[self.size / (x2 - x1), 0, 0, self.size / (y2 - y1), 0, 0])
        drawing.add(widget)
        renderPDF.draw(drawing, self.canv, 0, 0)


def numbered(items):
    """Passos numerados com o número num círculo azul."""
    rows = []
    for i, text in enumerate(items, 1):
        rows.append([P(f'<font name="Manrope-ExtraBold" color="#FFFFFF">{i}</font>', ParagraphStyle(
            "n", parent=body, alignment=1, fontSize=10, leading=12)), P(text, step)])
    table = Table(rows, colWidths=[7 * mm, None])
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, -1), 0),
        ("LEFTPADDING", (1, 0), (1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    table.setStyle(TableStyle(style))
    table._circles = len(items)  # usado no desenho dos círculos

    original_draw = table.draw

    def draw_with_circles():
        canv = table.canv
        y = table._height
        for row_height in table._rowHeights:
            cy = y - 3 - 7.5
            canv.setFillColor(PRIMARY)
            canv.circle(3.5 * mm, cy, 3.2 * mm, stroke=0, fill=1)
            y -= row_height
        original_draw()

    table.draw = draw_with_circles
    return table


def card(title, subtitle, items, width):
    inner = [P(title, card_title), P(subtitle, small), Spacer(1, 6), numbered(items)]
    t = Table([[inner]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("BOX", (0, 0), (-1, -1), 0.8, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("ROUNDEDCORNERS", [8, 8, 8, 8]),
    ]))
    return t


def callout(flowables, width, bg=SOFT, line=LINE):
    t = Table([[flowables]], colWidths=[width])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.8, line),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("ROUNDEDCORNERS", [8, 8, 8, 8]),
    ]))
    return t


def on_first_page(canv, doc):
    canv.saveState()
    canv.setFillColor(NAVY)
    canv.rect(0, PAGE_H - HEADER_H, PAGE_W, HEADER_H, stroke=0, fill=1)
    # faixa fina com as cores da marca
    for i, color in enumerate(("#2447FF", "#00B7DF", "#2BD4AF", "#76F6C6")):
        canv.setFillColor(colors.HexColor(color))
        canv.rect(i * PAGE_W / 4, PAGE_H - HEADER_H - 1.6 * mm, PAGE_W / 4, 1.6 * mm, stroke=0, fill=1)
    icon = os.path.join(WORK, "icon.png")
    canv.drawImage(icon, MARGIN, PAGE_H - HEADER_H + 8 * mm, 24 * mm, 24 * mm, mask="auto")
    canv.setFillColor(colors.white)
    canv.setFont("Manrope-ExtraBold", 22)
    canv.drawString(MARGIN + 30 * mm, PAGE_H - 19 * mm, "Instale o app Maxx Field")
    canv.setFont("Manrope", 11)
    canv.setFillColor(colors.HexColor("#C9D3E6"))
    canv.drawString(MARGIN + 30 * mm, PAGE_H - 26.5 * mm, "Versão de teste para técnicos parceiros · Android e iPhone")
    footer(canv, doc)
    canv.restoreState()


def on_later_pages(canv, doc):
    canv.saveState()
    canv.setFillColor(NAVY)
    canv.rect(0, PAGE_H - 12 * mm, PAGE_W, 12 * mm, stroke=0, fill=1)
    canv.setFillColor(colors.white)
    canv.setFont("Manrope-Bold", 10)
    canv.drawString(MARGIN, PAGE_H - 7.6 * mm, "Maxx Field · como instalar e usar a versão de teste")
    footer(canv, doc)
    canv.restoreState()


def footer(canv, doc):
    canv.setFont("Manrope", 8.5)
    canv.setFillColor(MUTED)
    canv.drawString(MARGIN, 10 * mm, f"Endereço do app: {APP_HOST}")
    canv.drawRightString(PAGE_W - MARGIN, 10 * mm, f"Página {doc.page}")


def build(path):
    doc = BaseDocTemplate(
        path,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=16 * mm,
        title="Instale o app Maxx Field",
        author="Maxx Field",
        subject="Guia de instalação do app dos técnicos (versão de teste)",
    )
    width = PAGE_W - 2 * MARGIN
    first = Frame(MARGIN, 16 * mm, width, PAGE_H - HEADER_H - 16 * mm - 8 * mm, id="first", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    later = Frame(MARGIN, 16 * mm, width, PAGE_H - 12 * mm - 16 * mm - 8 * mm, id="later", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([
        PageTemplate(id="First", frames=[first], onPage=on_first_page),
        PageTemplate(id="Later", frames=[later], onPage=on_later_pages),
    ])

    story = []

    # Link e QR code
    qr_size = 36 * mm
    link_text = [
        P("Abra este endereço no celular:", ParagraphStyle("lbl", parent=body, fontName="Manrope-Bold")),
        Spacer(1, 3),
        P(APP_HOST, url_style),
        Spacer(1, 6),
        P("Ou aponte a câmera do celular para o código ao lado e toque no link que aparecer.", small),
        Spacer(1, 6),
        P("Não precisa baixar nada da Play Store nem da App Store: o app instala pelo navegador do celular.", body),
    ]
    link = Table([[link_text, QR(APP_URL, qr_size)]], colWidths=[width - qr_size - 26, qr_size + 26], hAlign="LEFT")
    link.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 0), (-1, -1), SOFT_BLUE),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ("ROUNDEDCORNERS", [10, 10, 10, 10]),
    ]))
    story += [link, Spacer(1, 10)]

    story += [
        P("Antes de começar", h2),
        P("• Internet ligada (Wi-Fi ou dados móveis) na primeira vez."),
        P("• <b>Android:</b> use o <b>Chrome</b>. <b>iPhone:</b> use o <b>Safari</b> (outros navegadores do iPhone não instalam)."),
        P("• Tenha em mãos o <b>e-mail</b> e a <b>senha</b> do seu acesso: os que você criou na ficha de cadastro ou os que a central mandou."),
        Spacer(1, 10),
    ]

    col = (width - 10) / 2
    android = card(
        "No Android",
        "Chrome",
        [
            "Abra o <b>Chrome</b> e entre no endereço acima.",
            "Toque em <b>Instalar</b> na faixa que aparece embaixo da tela. Se ela não aparecer, toque nos "
            "<b>três pontinhos</b> (canto de cima) e depois em <b>Instalar app</b> (em alguns celulares: "
            "<b>Adicionar à tela inicial</b>).",
            "Confirme em <b>Instalar</b>. O ícone do <b>Maxx Field</b> aparece na tela inicial.",
            "Abra o app sempre pelo ícone, não pelo Chrome.",
        ],
        col,
    )
    iphone = card(
        "No iPhone",
        "Safari",
        [
            "Abra o <b>Safari</b> e entre no endereço acima.",
            "Toque em <b>Compartilhar</b> (o quadrado com a seta para cima, na barra de baixo).",
            "Role a lista e toque em <b>Adicionar à Tela de Início</b>.",
            "Toque em <b>Adicionar</b> (canto de cima). O ícone do <b>Maxx Field</b> aparece na tela inicial.",
            "Abra o app sempre pelo ícone, não pelo Safari.",
        ],
        col,
    )
    two = Table([[android, iphone]], colWidths=[col + 10, col], hAlign="LEFT")
    two.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, -1), 10),
        ("RIGHTPADDING", (1, 0), (1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    story += [two]

    # Página 2 (cabeçalho fino a partir dela)
    story.insert(0, NextPageTemplate("Later"))
    story += [PageBreak()]

    story += [
        P("Primeiro acesso", h2),
        numbered([
            "Abra o <b>Maxx Field</b> pelo ícone e entre com o <b>e-mail</b> e a <b>senha</b> do seu acesso.",
            "Se a central mandou uma senha provisória, o app pede uma senha nova: crie a sua. Ela é só sua, ninguém da central vê.",
            "Pronto: na aba <b>Hoje</b> aparecem as suas OS do dia; na <b>Agenda</b>, as próximas.",
        ]),
        Spacer(1, 6),
        P("Permissões que o app pede", h2),
    ]
    perm = Table(
        [
            [P("<b>Localização</b>", body), P("Para o check-in na OS e para a jornada. Toque em <b>Permitir</b> quando o app pedir.", body)],
            [P("<b>Câmera e fotos</b>", body), P("Para as fotos do atendimento, dos formulários e da nota fiscal.", body)],
        ],
        colWidths=[38 * mm, width - 38 * mm],
    )
    perm.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -2), 0.6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story += [perm, Spacer(1, 4), P(
        "Se negou sem querer: Android, segure o ícone › <b>Informações do app</b> › Permissões. iPhone: "
        "<b>Ajustes</b> › Safari › Localização (ou Câmera) e escolha <b>Perguntar</b> ou <b>Permitir</b>.", small),
        Spacer(1, 10)]

    limits = [
        P("<b>Nesta versão de teste</b>", ParagraphStyle("lt", parent=body, fontName="Manrope-ExtraBold", fontSize=12)),
        Spacer(1, 4),
        P("• É um <b>ambiente de teste</b>: as OS, lojas e clientes são de exemplo. Não vá a um endereço por causa delas."),
        P("• O <b>GPS da jornada</b> só registra com o app <b>aberto na tela</b>. Com o celular bloqueado ou o app em "
          "segundo plano, a posição não é enviada."),
        P("• Os <b>lembretes da visita</b> (1 dia, 1h40 e 10 minutos antes) não tocam nesta versão: confira a "
          "<b>Agenda</b> no app."),
        P("• Depois do primeiro acesso, o app <b>abre sem internet</b>. O que você fizer sem sinal fica guardado e é "
          "enviado quando a conexão voltar (veja em <b>Perfil › Sincronização</b>)."),
        P("• O app se <b>atualiza sozinho</b>: basta abrir com internet."),
    ]
    story += [callout(limits, width, bg=AMBER_BG, line=AMBER_LINE), Spacer(1, 12)]

    story += [
        P("Dúvidas ou problemas", h2),
        P("Fale com a central pelo <b>grupo de WhatsApp</b> de sempre. Se puder, mande um print da tela e diga o "
          "modelo do celular (por exemplo, Samsung A54 ou iPhone 13)."),
        Spacer(1, 8),
        P("Para tirar o app do celular", h2),
        P("<b>Android:</b> segure o ícone do Maxx Field › <b>Desinstalar</b>. <b>iPhone:</b> segure o ícone › "
          "<b>Remover App</b> › <b>Remover da Tela de Início</b> (ou <b>Apagar</b>)."),
    ]

    doc.build(story)


if __name__ == "__main__":
    out = os.path.join(WORK, "guia-instalacao-maxx-field.pdf")
    build(out)
    print("ok", out)

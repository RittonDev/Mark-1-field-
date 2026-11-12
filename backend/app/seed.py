"""Carga de dados de exemplo para desenvolvimento local.

    SEED_PASSWORD=... python -m app.seed

Idempotente: se já existir o admin de exemplo, não faz nada. Recusa rodar em produção.
Todos os usuários de exemplo usam a senha de SEED_PASSWORD.
"""

import asyncio
import os
import sys
from datetime import timedelta

from sqlalchemy import select

from app.core.config import settings
from app.core.enums import (
    AssetType,
    Impact,
    TicketSource,
    TicketStatus,
    TicketType,
    Urgency,
    UserRole,
)
from app.core.security import hash_password
from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models import Asset, Category, Customer, Location, SlaPolicy, Team, User
from app.schemas.ticket import CommentCreate, TicketCreate, TicketTransition, WorklogCreate
from app.services import sla
from app.services import tickets as svc

ADMIN_EMAIL = "admin@exemplo.com.br"

CATEGORIES = {
    ("Impressoras", "campo"): [
        "Atolamento de papel",
        "Falha de impressão / qualidade",
        "Toner e suprimentos",
        "Instalação e configuração",
        "Scanner",
    ],
    ("Computadores e notebooks", "campo"): [
        "Não liga",
        "Lentidão",
        "Troca de peça / hardware",
        "Formatação / sistema operacional",
        "Periféricos",
    ],
    ("Redes", "redes"): [
        "Sem acesso à internet",
        "Wi-Fi",
        "Cabeamento estruturado",
        "Switch / roteador",
        "VPN",
    ],
    ("CFTV", "cftv"): [
        "Câmera offline",
        "DVR/NVR sem gravação",
        "Acesso remoto / app",
        "Instalação de câmera",
    ],
    ("Telefonia", "redes"): ["Ramal sem linha", "Aparelho IP"],
    ("Software e acessos", "n1"): ["E-mail", "Sistemas internos", "Senha / acesso"],
}


async def seed() -> None:
    if settings.is_production:
        sys.exit("Seed recusado: ENVIRONMENT=production")
    password = os.environ.get("SEED_PASSWORD")
    if not password or len(password) < 8:
        sys.exit("Defina SEED_PASSWORD (mínimo 8 caracteres) para criar os usuários de exemplo")

    async with SessionLocal() as db:
        if await db.scalar(select(User).where(User.email == ADMIN_EMAIL)):
            print("Seed já aplicado; nada a fazer.")
            return

        pw = hash_password(password)
        teams = {
            "n1": Team(name="Suporte N1 (remoto)", description="Atendimento remoto e acessos"),
            "campo": Team(name="Campo - Infraestrutura", description="Impressoras e computadores"),
            "redes": Team(name="Redes e Telecom", description="Rede, Wi-Fi, telefonia"),
            "cftv": Team(name="CFTV e Segurança", description="Câmeras, DVR/NVR"),
        }
        db.add_all(teams.values())
        await db.flush()

        def user(name: str, email: str, role: UserRole, team: str | None, job: str) -> User:
            return User(
                name=name,
                email=email,
                password_hash=pw,
                role=role,
                team_id=teams[team].id if team else None,
                job_title=job,
                phone="(11) 90000-0000",
                is_active=True,
            )

        admin = user("Administrador", ADMIN_EMAIL, UserRole.ADMIN, None, "Administrador do sistema")
        supervisor = user(
            "Mariana Costa",
            "supervisor@exemplo.com.br",
            UserRole.SUPERVISOR,
            None,
            "Coordenadora de Service Desk",
        )
        carlos = user(
            "Carlos Souza",
            "carlos@exemplo.com.br",
            UserRole.TECHNICIAN,
            "campo",
            "Técnico de campo",
        )
        rafael = user(
            "Rafael Lima", "rafael@exemplo.com.br", UserRole.TECHNICIAN, "redes", "Técnico de redes"
        )
        juliana = user(
            "Juliana Alves",
            "juliana@exemplo.com.br",
            UserRole.TECHNICIAN,
            "cftv",
            "Técnica de CFTV",
        )
        bruno = user(
            "Bruno Martins",
            "bruno@exemplo.com.br",
            UserRole.ANALYST,
            "n1",
            "Analista de service desk",
        )
        requester = user(
            "Paulo Mendes",
            "solicitante@exemplo.com.br",
            UserRole.REQUESTER,
            None,
            "Gerente administrativo",
        )
        db.add_all([admin, supervisor, carlos, rafael, juliana, bruno, requester])

        for priority, (response, resolution) in sla.DEFAULT_SLA_MINUTES.items():
            db.add(
                SlaPolicy(
                    priority=priority, response_minutes=response, resolution_minutes=resolution
                )
            )

        cats: dict[str, Category] = {}
        for (parent_name, team_key), children in CATEGORIES.items():
            parent = Category(name=parent_name, default_team_id=teams[team_key].id)
            db.add(parent)
            await db.flush()
            cats[parent_name] = parent
            for child in children:
                c = Category(name=child, parent_id=parent.id, default_team_id=teams[team_key].id)
                db.add(c)
                cats[f"{parent_name}/{child}"] = c

        matriz = Customer(
            name="Maxx Group - Matriz",
            document="00000000000100",
            email="ti@exemplo.com.br",
            phone="(11) 3000-0000",
        )
        clinica = Customer(
            name="Clínica Vida Saudável", document="00000000000200", phone="(19) 3200-0000"
        )
        escola = Customer(
            name="Colégio Horizonte", document="00000000000300", phone="(31) 3300-0000"
        )
        db.add_all([matriz, clinica, escola])
        await db.flush()

        sede = Location(
            customer_id=matriz.id,
            name="Sede - São Paulo",
            address_line="Av. Paulista, 1000 - 12º andar",
            district="Bela Vista",
            city="São Paulo",
            state="SP",
            zip_code="01310-100",
            latitude=-23.5614,
            longitude=-46.6559,
            contact_name="Recepção",
            contact_phone="(11) 3000-0001",
        )
        cd = Location(
            customer_id=matriz.id,
            name="Centro de Distribuição",
            address_line="Rod. Presidente Dutra, km 210",
            city="Guarulhos",
            state="SP",
            latitude=-23.4543,
            longitude=-46.5333,
            contact_name="Portaria",
            contact_phone="(11) 3000-0002",
        )
        unidade = Location(
            customer_id=clinica.id,
            name="Unidade Centro",
            address_line="Rua Barão de Jaguara, 500",
            city="Campinas",
            state="SP",
            latitude=-22.9056,
            longitude=-47.0608,
            contact_name="Ana (recepção)",
            contact_phone="(19) 3200-0001",
        )
        campus = Location(
            customer_id=escola.id,
            name="Campus Norte",
            address_line="Av. Cristiano Machado, 4000",
            city="Belo Horizonte",
            state="MG",
            latitude=-19.8530,
            longitude=-43.9300,
            contact_name="Secretaria",
            contact_phone="(31) 3300-0001",
        )
<<<<<<< Updated upstream
        db.add_all([sede, cd, unidade, campus])
=======
        # Lojas: a operação gira em torno do local (no Field Control, ~55 locais por cliente).
        lojas = [
            Location(
                customer_id=matriz.id,
                name=name,
                code=code,
                document=cnpj(f"11222333{branch}"),
                address_line=address,
                city=city,
                state="SP",
                latitude=lat,
                longitude=lng,
                contact_name="Gerente da loja",
            )
            for name, code, branch, address, city, lat, lng in (
                (
                    "Loja 12 - Shopping Ibirapuera",
                    "LJ-12",
                    "0012",
                    "Av. Ibirapuera, 3103",
                    "São Paulo",
                    -23.6106,
                    -46.6665,
                ),
                (
                    "Loja 27 - Shopping Morumbi",
                    "LJ-27",
                    "0027",
                    "Av. Roque Petroni Jr., 1089",
                    "São Paulo",
                    -23.6228,
                    -46.6993,
                ),
                (
                    "Loja 41 - Outlet Campinas",
                    "LJ-41",
                    "0041",
                    "Rod. Dom Pedro I, km 127",
                    "Campinas",
                    -22.8486,
                    -47.0596,
                ),
            )
        ]
        db.add_all([sede, cd, unidade, campus, *lojas])
>>>>>>> Stashed changes
        await db.flush()

        def asset(
            customer: Customer,
            loc: Location,
            kind: AssetType,
            name: str,
            brand: str,
            model: str,
            serial: str,
            tag: str,
            ip: str | None = None,
        ) -> Asset:
            return Asset(
                customer_id=customer.id,
                location_id=loc.id,
                asset_type=kind,
                name=name,
                brand=brand,
                model=model,
                serial_number=serial,
                asset_tag=tag,
                ip_address=ip,
                is_active=True,
            )

        a = {
            "imp_rh": asset(
                matriz,
                sede,
                AssetType.PRINTER,
                "Impressora RH - 12º andar",
                "HP",
                "LaserJet Pro M428fdw",
                "BRBSN12345",
                "PAT-0101",
                "10.0.12.50",
            ),
            "imp_cd": asset(
                matriz,
                cd,
                AssetType.PRINTER,
                "Impressora de etiquetas expedição",
                "Zebra",
                "ZT230",
                "ZBR998877",
                "PAT-0230",
                "10.0.30.21",
            ),
            "pc_fin": asset(
                matriz,
                sede,
                AssetType.DESKTOP,
                "Desktop Financeiro 03",
                "Dell",
                "OptiPlex 7010",
                "DL7010X03",
                "PAT-0412",
            ),
            "sw_core": asset(
                matriz,
                sede,
                AssetType.SWITCH,
                "Switch core 12º andar",
                "Cisco",
                "CBS350-24P",
                "CSCO24P001",
                "PAT-0900",
                "10.0.0.2",
            ),
            "ap_cd": asset(
                matriz,
                cd,
                AssetType.ACCESS_POINT,
                "AP galpão 2",
                "Ubiquiti",
                "UniFi U6 Pro",
                "UBQ6PRO02",
                "PAT-0911",
                "10.0.30.5",
            ),
            "cam_rec": asset(
                clinica,
                unidade,
                AssetType.CAMERA,
                "Câmera recepção",
                "Intelbras",
                "VIP 1230 B",
                "ITB1230R1",
                "CLN-CAM-01",
                "192.168.1.101",
            ),
            "nvr": asset(
                clinica,
                unidade,
                AssetType.DVR_NVR,
                "NVR principal",
                "Intelbras",
                "NVD 1404",
                "ITBNVD1404",
                "CLN-NVR-01",
                "192.168.1.100",
            ),
            "nb_dir": asset(
                escola,
                campus,
                AssetType.NOTEBOOK,
                "Notebook diretoria",
                "Lenovo",
                "ThinkPad E14",
                "LNVE14D01",
                "ESC-NB-07",
            ),
        }
        db.add_all(a.values())
        await db.commit()

        now = utcnow()

        async def ticket(actor: User, **kw):  # noqa: ANN202
            t = await svc.create_ticket(db, TicketCreate(**kw), actor)
            await db.commit()
            return await svc.get_ticket(db, t.id)

        async def move(t, actor: User, to: TicketStatus, **kw):  # noqa: ANN001, ANN202
            await svc.transition_ticket(db, t, TicketTransition(to_status=to, **kw), actor)
            await db.commit()
            return await svc.get_ticket(db, t.id)

        async def backdate(t, hours: float) -> None:  # noqa: ANN001
            t.created_at = now - timedelta(hours=hours)
            response, resolution = await sla.get_policy_minutes(db, t.priority)
            sla.set_due_dates(
                t, base=t.created_at, response_minutes=response, resolution_minutes=resolution
            )
            await db.commit()

        # 1. Nova, sem analista, crítica (rede caiu no CD)
        t1 = await ticket(
            supervisor,
            title="CD sem internet - expedição parada",
            description="Nenhum computador do galpão 2 acessa a internet desde 7h.",
            impact=Impact.HIGH,
            urgency=Urgency.HIGH,
            source=TicketSource.PHONE,
            category_id=cats["Redes/Sem acesso à internet"].id,
            customer_id=matriz.id,
            location_id=cd.id,
            asset_id=a["ap_cd"].id,
            requester_name="Luís (expedição)",
            requester_contact="(11) 3000-0002",
        )
        await backdate(t1, 1.5)

        # 2. Aberta pelo solicitante no portal
        await ticket(
            requester,
            title="Impressora do RH atolando papel",
            description="Atola na bandeja 2 em toda impressão frente e verso.",
            impact=Impact.MEDIUM,
            urgency=Urgency.MEDIUM,
            category_id=cats["Impressoras/Atolamento de papel"].id,
            asset_id=a["imp_rh"].id,
        )

        # 3. Atribuída e agendada (campo)
        t3 = await ticket(
            supervisor,
            title="Desktop do financeiro não liga",
            description="Luz laranja piscando na fonte.",
            impact=Impact.MEDIUM,
            urgency=Urgency.HIGH,
            category_id=cats["Computadores e notebooks/Não liga"].id,
            asset_id=a["pc_fin"].id,
            assignee_id=carlos.id,
            requester_id=requester.id,
        )
        await move(
            t3,
            carlos,
            TicketStatus.SCHEDULED,
            scheduled_start=now + timedelta(hours=3),
            scheduled_end=now + timedelta(hours=4),
            note="Levar fonte reserva",
        )

        # 4. Em deslocamento
        t4 = await ticket(
            supervisor,
            title="NVR da clínica parou de gravar",
            description="Gravações das câmeras 1 a 4 param às 2h.",
            impact=Impact.HIGH,
            urgency=Urgency.MEDIUM,
            category_id=cats["CFTV/DVR/NVR sem gravação"].id,
            asset_id=a["nvr"].id,
            assignee_id=juliana.id,
        )
        await move(t4, juliana, TicketStatus.EN_ROUTE, latitude=-22.91, longitude=-47.06)

        # 5. Em atendimento, com apontamento e comentário
        t5 = await ticket(
            supervisor,
            title="Switch core reiniciando sozinho",
            description="Logs mostram reboot a cada ~40 min.",
            impact=Impact.HIGH,
            urgency=Urgency.HIGH,
            category_id=cats["Redes/Switch / roteador"].id,
            asset_id=a["sw_core"].id,
            assignee_id=rafael.id,
        )
        await backdate(t5, 3)
        t5 = await move(t5, rafael, TicketStatus.IN_PROGRESS)
        await svc.add_worklog(
            db,
            t5,
            WorklogCreate(
                description="Coleta de logs e verificação de temperatura",
                started_at=now - timedelta(minutes=50),
                minutes=45,
            ),
            rafael,
        )
        await svc.add_comment(
            db,
            t5,
            CommentCreate(
                body="Fonte redundante com alarme. Abrindo RMA com o fabricante.", is_internal=True
            ),
            rafael,
        )
        await db.commit()

        # 6. Aguardando fornecedor (SLA pausado)
        t6 = await ticket(
            supervisor,
            title="Toner da impressora de etiquetas",
            description="Ribbon acabando; sem estoque local.",
            impact=Impact.LOW,
            urgency=Urgency.MEDIUM,
            type=TicketType.SERVICE_REQUEST,
            category_id=cats["Impressoras/Toner e suprimentos"].id,
            asset_id=a["imp_cd"].id,
            assignee_id=carlos.id,
        )
        t6 = await move(t6, carlos, TicketStatus.IN_PROGRESS)
        await move(t6, carlos, TicketStatus.ON_HOLD_VENDOR, note="Pedido de compra 4471")

        # 7. Aguardando cliente
        t7 = await ticket(
            supervisor,
            title="Acesso remoto às câmeras pelo celular",
            description="Diretora quer ver as câmeras pelo app.",
            type=TicketType.SERVICE_REQUEST,
            category_id=cats["CFTV/Acesso remoto / app"].id,
            customer_id=clinica.id,
            location_id=unidade.id,
            assignee_id=juliana.id,
        )
        await move(
            t7,
            juliana,
            TicketStatus.ON_HOLD_CUSTOMER,
            note="Aguardando a diretora informar o modelo do celular",
        )

        # 8. Resolvida (aguardando aceite do solicitante)
        t8 = await ticket(
            requester,
            title="Sem acesso ao e-mail no Outlook",
            description="Pede senha toda hora.",
            category_id=cats["Software e acessos/E-mail"].id,
        )
        await svc.assign_ticket(
            db,
            t8,
            assignee_id=bruno.id,
            team_id=None,
            note=None,
            expected_version=None,
            actor=supervisor,
        )
        await db.commit()
        t8 = await move(await svc.get_ticket(db, t8.id), bruno, TicketStatus.IN_PROGRESS)
        await move(
            t8,
            bruno,
            TicketStatus.RESOLVED,
            resolution_notes="Perfil do Outlook recriado e MFA reconfigurado.",
        )

        # 9. Fechada
        t9 = await ticket(
            supervisor,
            title="Instalar câmera na entrada de serviço",
            type=TicketType.INSTALLATION,
            impact=Impact.LOW,
            urgency=Urgency.LOW,
            category_id=cats["CFTV/Instalação de câmera"].id,
            customer_id=clinica.id,
            location_id=unidade.id,
            assignee_id=juliana.id,
        )
        t9 = await move(t9, juliana, TicketStatus.IN_PROGRESS)
        t9 = await move(
            t9,
            juliana,
            TicketStatus.RESOLVED,
            resolution_notes="Câmera instalada e adicionada ao NVR (canal 5).",
        )
        await move(t9, supervisor, TicketStatus.CLOSED)

        # 10. Preventiva atribuída ao grupo (sem analista)
        await ticket(
            supervisor,
            title="Preventiva trimestral - notebooks da diretoria",
            type=TicketType.PREVENTIVE,
            impact=Impact.LOW,
            urgency=Urgency.LOW,
            category_id=cats["Computadores e notebooks/Lentidão"].id,
            asset_id=a["nb_dir"].id,
        )

        # 11. SLA violado: atribuída há muito tempo e parada
        t11 = await ticket(
            supervisor,
            title="Wi-Fi caindo na sala de reunião",
            impact=Impact.MEDIUM,
            urgency=Urgency.HIGH,
            category_id=cats["Redes/Wi-Fi"].id,
            customer_id=matriz.id,
            location_id=sede.id,
            assignee_id=rafael.id,
        )
        await backdate(t11, 12)

        db.info.clear()  # sem bus/WebSocket no seed
        print("Seed aplicado. Usuários de exemplo (senha = SEED_PASSWORD):")
        for u in (admin, supervisor, carlos, rafael, juliana, bruno, requester):
            print(f"  {u.role.value:<10} {u.email}")


if __name__ == "__main__":
    asyncio.run(seed())

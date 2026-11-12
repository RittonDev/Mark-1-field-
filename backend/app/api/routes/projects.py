import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status

from app.api.deps import DB, TicketManagerUser
from app.core.enums import ProjectStatus
from app.schemas.project import ProjectIn, ProjectOut
from app.services import projects as svc

router = APIRouter(tags=["projects"])


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(
    db: DB,
    _: TicketManagerUser,
    status_: Annotated[ProjectStatus | None, Query(alias="status")] = None,
    q: str | None = None,
    customer_id: uuid.UUID | None = None,
) -> list[ProjectOut]:
    return await svc.list_projects(db, status_, q, customer_id)


@router.post("/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(body: ProjectIn, db: DB, user: TicketManagerUser) -> ProjectOut:
    project = await svc.create(db, body, user)
    await db.commit()
    return (await svc.to_out(db, [project]))[0]


@router.get("/projects/{project_id}", response_model=ProjectOut)
async def get_project(project_id: uuid.UUID, db: DB, _: TicketManagerUser) -> ProjectOut:
    return (await svc.to_out(db, [await svc.get(db, project_id)]))[0]


@router.put("/projects/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: uuid.UUID, body: ProjectIn, db: DB, _: TicketManagerUser
) -> ProjectOut:
    project = await svc.update(db, await svc.get(db, project_id), body)
    await db.commit()
    return (await svc.to_out(db, [project]))[0]

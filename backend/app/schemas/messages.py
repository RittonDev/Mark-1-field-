from pydantic import BaseModel, Field


class MessageTemplate(BaseModel):
    key: str | None = Field(default=None, max_length=40)
    name: str = Field(min_length=1, max_length=60)
    body: str = Field(min_length=1, max_length=2000)


class MessageTemplates(BaseModel):
    templates: list[MessageTemplate] = Field(min_length=1, max_length=30)


class MessageVariable(BaseModel):
    key: str
    description: str


class MessageTemplatesOut(BaseModel):
    templates: list[MessageTemplate]
    variables: list[MessageVariable]


class RenderedMessage(BaseModel):
    key: str
    name: str
    text: str

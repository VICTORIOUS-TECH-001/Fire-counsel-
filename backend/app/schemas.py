from typing import Literal
from pydantic import BaseModel, Field, HttpUrl


class AnswerSection(BaseModel):
    heading: str
    content: str


class CaseAnalysis(BaseModel):
    case_name: str
    citation: str | None = None
    court: str | None = None
    year: int | None = None
    facts: str | None = None
    issue: str | None = None
    rule: str | None = None
    application: str | None = None
    conclusion: str | None = None
    ratio: str | None = None
    status: str = "not_assessed"
    source_url: HttpUrl | None = None
    pinpoint: str | None = None


class StatutoryAuthority(BaseModel):
    title: str
    provision: str | None = None
    proposition: str
    jurisdiction: str = "Nigeria"
    source_url: HttpUrl | None = None
    verification_status: Literal["verified", "unverified", "not_assessed"] = "not_assessed"


class ResearchSource(BaseModel):
    title: str
    url: HttpUrl
    source_type: str = "web"
    publisher: str | None = None


class PracticeQuestion(BaseModel):
    question_type: Literal["essay", "problem", "short_note", "objective"] = "problem"
    question: str
    examiner_focus: list[str] = Field(default_factory=list)
    is_generated: bool = True


class LegalAnswer(BaseModel):
    response_type: Literal[
        "direct_answer", "topic_explanation", "case_analysis",
        "problem_question", "exam_practice", "research"
    ] = "topic_explanation"
    title: str
    jurisdiction: str = "Nigeria"
    direct_answer: str
    sections: list[AnswerSection] = Field(default_factory=list)
    cases: list[CaseAnalysis] = Field(default_factory=list)
    statutes: list[StatutoryAuthority] = Field(default_factory=list)
    exam_tips: list[str] = Field(default_factory=list)
    big_ideas: list[str] = Field(default_factory=list)
    mnemonics: list[str] = Field(default_factory=list)
    practice_questions: list[PracticeQuestion] = Field(default_factory=list)
    research_sources: list[ResearchSource] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)

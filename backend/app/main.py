import logging
from typing import Any

import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from .config import get_settings
from .prompts import SYSTEM_INSTRUCTIONS, PROMPT_VERSION, build_user_prompt
from .schemas import LegalAnswer
from .security import require_user

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("fire-counsel")
settings = get_settings()

app = FastAPI(title=settings.app_name, version="0.1.1")
if settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )


class AskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=6000)
    jurisdiction: str = Field(default="Nigeria", max_length=100)
    course: str | None = Field(default=None, max_length=160)
    topic: str | None = Field(default=None, max_length=200)


def _retrieve_context(question: str, jurisdiction: str,
                     course: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Retrieve legal evidence and course context from Neon full-text indexes."""
    empty = {"materials": [], "authorities": [], "statutes": [], "past_questions": []}
    if not settings.database_url:
        return empty

    query = """
    WITH q AS (SELECT websearch_to_tsquery('english', %s) AS term)
    SELECT kind, title, body, citation, court, year, source_url, verification_status,
           page_number, course_name
    FROM (
      SELECT 'material' AS kind, m.title, dc.chunk_text AS body,
             NULL::text AS citation, NULL::text AS court, NULL::integer AS year,
             NULL::text AS source_url, 'context_only'::text AS verification_status,
             dc.page_number, c.name AS course_name,
             ts_rank(dc.search_vector, q.term) AS rank
      FROM document_chunks dc
      JOIN materials m ON m.id = dc.material_id
      LEFT JOIN courses c ON c.id = dc.course_id
      CROSS JOIN q
      WHERE dc.search_vector @@ q.term
        AND m.processing_status = 'ready'
        AND (dc.jurisdiction = %s OR dc.jurisdiction = 'All')
      UNION ALL
      SELECT 'authority', la.case_name, concat_ws(' ', la.material_facts, la.issues,
             la.holding, la.ratio_decidendi), la.citation, la.court, la.year,
             la.source_url, la.verification_status, NULL::integer, NULL::text,
             ts_rank(la.search_vector, q.term)
      FROM legal_authorities la CROSS JOIN q
      WHERE la.search_vector @@ q.term
        AND (la.jurisdiction = %s OR la.jurisdiction = 'All')
      UNION ALL
      SELECT 'statute', s.title, concat_ws(' ', s.provision, s.text),
             NULL::text, NULL::text, s.year, s.source_url,
             s.verification_status, NULL::integer, NULL::text,
             ts_rank(s.search_vector, q.term)
      FROM statutes s CROSS JOIN q
      WHERE s.search_vector @@ q.term
        AND (s.jurisdiction = %s OR s.jurisdiction = 'All')
    ) results
    ORDER BY rank DESC
    LIMIT 24
    """
    try:
        with psycopg.connect(settings.database_url, connect_timeout=5) as conn:
            rows = conn.execute(
                query, (question, jurisdiction, jurisdiction, jurisdiction)
            ).fetchall()
            course_pattern = f"%{course}%" if course else f"%{question[:80]}%"
            past_rows = conn.execute(
                """
                SELECT pq.question_text, pq.exam_year, pq.section_label, c.name
                FROM past_questions pq
                LEFT JOIN courses c ON c.id = pq.course_id
                WHERE (c.name ILIKE %s OR pq.question_text ILIKE %s)
                  AND pq.jurisdiction = %s
                ORDER BY pq.exam_year DESC NULLS LAST
                LIMIT 12
                """,
                (course_pattern, f"%{question[:100]}%", jurisdiction),
            ).fetchall()
    except Exception:
        logger.exception("Knowledge-library retrieval failed")
        return empty

    result = {"materials": [], "authorities": [], "statutes": [], "past_questions": []}
    for row in rows:
        kind, title, body, citation, court, year, url, status, page, course_name = row
        if kind == "material":
            result["materials"].append({
                "title": title, "excerpt": body, "page_number": page,
                "course": course_name, "usage": "course context only; never cite as law"
            })
        elif kind == "authority":
            result["authorities"].append({
                "case_name": title, "proposition_context": body, "citation": citation,
                "court": court, "year": year, "source_url": url,
                "verification_status": status
            })
        elif kind == "statute":
            result["statutes"].append({
                "title": title, "provision_text": body, "year": year,
                "source_url": url, "verification_status": status
            })
    result["past_questions"] = [
        {"question": r[0], "year": r[1], "section": r[2], "course": r[3]}
        for r in past_rows
    ]
    return result


def _needs_online_research(question: str, evidence: dict) -> bool:
    """Search automatically when the internal authority base is weak or freshness matters."""
    verified = sum(
        item.get("verification_status") == "verified"
        for item in evidence.get("authorities", []) + evidence.get("statutes", [])
    )
    freshness_terms = (
        "latest", "current law", "recent decision", "recent case",
        "amendment", "as at", "2025", "2026", "overruled", "good law"
    )
    asks_for_research = any(term in question.lower() for term in freshness_terms)
    return verified < 2 or asks_for_research


def _grounded_sources(response: Any) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    try:
        candidate = response.candidates[0]
        metadata = candidate.grounding_metadata
        for chunk in (metadata.grounding_chunks if metadata else []) or []:
            web = getattr(chunk, "web", None)
            url = getattr(web, "uri", None) if web else None
            title = getattr(web, "title", None) if web else None
            if url and url.startswith("https://"):
                found[url] = {"title": title or url, "url": url, "source_type": "google_search"}
    except (AttributeError, IndexError, TypeError):
        pass
    return list(found.values())


def _run_online_research(client: Any, question: str, jurisdiction: str) -> tuple[str, list[dict[str, str]]]:
    """Run Google Search grounding separately from JSON formatting for API compatibility."""
    research_prompt = (
        f"Research this legal question in {jurisdiction}: {question}\n\n"
        "Find relevant primary legal authorities first: judgments, legislation and official "
        "court or government sources. Verify case names, citations, courts, dates and the "
        "specific propositions supported. Distinguish binding from persuasive decisions. "
        "Do not invent citations or treat snippets as judgments. Summarise the findings and "
        "state when a source or proposition cannot be verified. Return source titles and URLs."
    )
    response = client.models.generate_content(
        model=settings.gemini_model,
        contents=research_prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTIONS,
            tools=[types.Tool(google_search=types.GoogleSearch())],
            temperature=0.1,
        ),
    )
    return response.text or "", _grounded_sources(response)


@app.get("/health")
def health():
    return {"status": "ok", "service": "fire-counsel-api", "prompt_version": PROMPT_VERSION}


@app.post("/api/ask", response_model=LegalAnswer)
def ask(payload: AskRequest, user: dict = Depends(require_user)):
    if not settings.gemini_api_key:
        raise HTTPException(status_code=503, detail="Gemini API is not configured on the server.")
    evidence = _retrieve_context(payload.question, payload.jurisdiction, payload.course)
    try:
        client = genai.Client(api_key=settings.gemini_api_key)
        research_text = ""
        sources: list[dict[str, str]] = []
        research_error = False

        if _needs_online_research(payload.question, evidence):
            try:
                research_text, sources = _run_online_research(
                    client, payload.question, payload.jurisdiction
                )
            except Exception:
                research_error = True
                logger.exception("Automatic legal web research failed")

        prompt = build_user_prompt(
            payload.question, payload.jurisdiction, payload.course, payload.topic,
            evidence, research_text=research_text, research_sources=sources
        )
        response = client.models.generate_content(
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTIONS,
                response_mime_type="application/json",
                response_schema=LegalAnswer,
                temperature=0.2,
            ),
        )
        parsed = response.parsed
        if isinstance(parsed, LegalAnswer):
            answer = parsed
        elif parsed:
            answer = LegalAnswer.model_validate(parsed)
        elif response.text:
            answer = LegalAnswer.model_validate_json(response.text)
        else:
            raise ValueError("Gemini returned no structured answer.")

        existing = {str(source.url) for source in answer.research_sources}
        for source in sources:
            if source["url"] not in existing:
                answer.research_sources.append(source)
        if research_error:
            answer.limitations.append(
                "Automatic online research could not be completed for this request; "
                "verify current law against primary sources before relying on it."
            )
        return answer
    except Exception as exc:
        logger.exception("Legal answer generation failed for uid=%s", user.get("uid"))
        raise HTTPException(
            status_code=502,
            detail="FIRE COUNSEL could not complete the response. Please try again."
        ) from exc

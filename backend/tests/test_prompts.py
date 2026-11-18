from app.prompts import SYSTEM_INSTRUCTIONS, PROMPT_VERSION, build_user_prompt
from app.main import _needs_online_research


def test_prompt_forbids_textbook_citations():
    assert "NEVER cite an internal textbook" in SYSTEM_INSTRUCTIONS
    assert "actual cases, statutes" in SYSTEM_INSTRUCTIONS


def test_prompt_contains_irac_and_exam_rules():
    assert "I — Issue" in SYSTEM_INSTRUCTIONS
    assert "past questions" in SYSTEM_INSTRUCTIONS.lower()
    assert PROMPT_VERSION


def test_user_prompt_separates_course_materials_from_authorities():
    prompt = build_user_prompt(
        "Explain offer", "Nigeria", "Contract Law", "Offer",
        {"materials": [{"title": "Handout"}], "authorities": [], "statutes": [],
         "past_questions": []},
    )
    assert "course_material_context_only_not_citable" in prompt
    assert "internal_legal_authorities" in prompt


def test_automatic_research_runs_when_authorities_are_missing():
    assert _needs_online_research("Explain offer", {"authorities": [], "statutes": []})


def test_automatic_research_skips_when_sufficient_verified_sources_exist():
    evidence = {
        "authorities": [{"verification_status": "verified", "legal_status": "good_law"}],
        "statutes": [{"verification_status": "verified"}],
    }
    assert not _needs_online_research("Explain offer", evidence)


def test_current_law_question_triggers_research():
    evidence = {
        "authorities": [{"verification_status": "verified"}] * 3,
        "statutes": [{"verification_status": "verified"}],
    }
    assert _needs_online_research("What is the current law in 2026?", evidence)


def test_overruled_authorities_do_not_count_as_sufficient_current_evidence():
    from app.main import _needs_online_research

    evidence = {
        "authorities": [
            {"verification_status": "verified", "legal_status": "overruled"},
            {"verification_status": "verified", "legal_status": "overruled"},
        ],
        "statutes": [],
    }
    assert _needs_online_research("Explain this doctrine", evidence)

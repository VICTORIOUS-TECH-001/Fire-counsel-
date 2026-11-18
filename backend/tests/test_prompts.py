from app.prompts import SYSTEM_INSTRUCTIONS, PROMPT_VERSION, build_user_prompt


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

from app.schemas import LegalAnswer, CaseAnalysis


def test_legal_answer_has_stable_sections():
    answer = LegalAnswer(
        title="Offer",
        direct_answer="An offer is a definite promise capable of acceptance.",
    )
    payload = answer.model_dump()
    assert payload["jurisdiction"] == "Nigeria"
    assert payload["cases"] == []
    assert payload["practice_questions"] == []


def test_case_analysis_does_not_require_fabricated_citation():
    case = CaseAnalysis(case_name="Authority awaiting verification")
    assert case.citation is None
    assert case.status == "not_assessed"

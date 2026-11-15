const text = (name, label, options = {}) => ({ name, label, type: "text", maxLength: 500, ...options });
const textarea = (name, label, options = {}) => ({ name, label, type: "textarea", maxLength: 40_000, ...options });
const number = (name, label, options = {}) => ({ name, label, type: "number", ...options });
const boolean = (name, label, options = {}) => ({ name, label, type: "boolean", ...options });
const date = (name, label, options = {}) => ({ name, label, type: "date", ...options });
const reference = (name, label, resource, options = {}) => ({ name, label, type: "reference", resource, ...options });
const choice = (name, label, options, extras = {}) => ({ name, label, type: "select", options, ...extras });

// Explicit allowlist: only administrator-managed education/legal-content tables
// are exposed. Identity, role, private study and AI-derived tables are excluded.
export const ADMIN_DATABASE_CATALOG = Object.freeze({
  universities: {
    label: "Universities",
    table: "universities",
    searchColumns: ["name", "short_name", "slug", "country"],
    orderBy: "name",
    displayColumns: ["name", "short_name", "country", "is_active"],
    fields: [
      text("name", "University name", { required: true }),
      text("short_name", "Short name", { nullable: true }),
      text("slug", "URL slug", { required: true, maxLength: 180 }),
      text("country", "Country", { nullable: true, default: "Nigeria" }),
      text("website", "Website URL", { type: "url", nullable: true }),
      boolean("is_active", "Active", { nullable: true, default: true })
    ],
    softDelete: { column: "is_active", value: false, labelColumn: "name" },
    deleteWarning: "This university has dependent faculties, courses, memberships and content. Prefer deactivate; permanent deletion can cascade."
  },
  faculties: {
    label: "Faculties",
    table: "faculties",
    searchColumns: ["name"],
    orderBy: "name",
    displayColumns: ["name", "university_id"],
    fields: [reference("university_id", "University", "universities", { required: true }), text("name", "Faculty name", { required: true })],
    softDelete: { column: null, labelColumn: "name" },
    deleteWarning: "Deleting a faculty may set linked course faculty references to null and can cascade its departments."
  },
  departments: {
    label: "Departments",
    table: "departments",
    searchColumns: ["name"],
    orderBy: "name",
    displayColumns: ["name", "faculty_id"],
    fields: [reference("faculty_id", "Faculty", "faculties", { required: true }), text("name", "Department name", { required: true })],
    softDelete: { column: null, labelColumn: "name" },
    deleteWarning: "Deleting a department may clear the department link on related courses."
  },
  courses: {
    label: "Courses",
    table: "courses",
    searchColumns: ["course_code", "title", "academic_session"],
    orderBy: "title",
    displayColumns: ["course_code", "title", "university_id", "academic_session", "is_published"],
    fields: [
      reference("university_id", "University", "universities", { required: true }),
      reference("faculty_id", "Faculty", "faculties", { nullable: true }),
      reference("department_id", "Department", "departments", { nullable: true }),
      text("course_code", "Course code", { nullable: true }),
      text("title", "Course title", { required: true }),
      textarea("description", "Description", { nullable: true, maxLength: 12_000 }),
      text("academic_level", "Academic level", { nullable: true }),
      text("semester", "Semester", { nullable: true }),
      text("academic_session", "Academic session", { nullable: true }),
      boolean("is_published", "Published", { nullable: true, default: false })
    ],
    creatorColumn: "created_by",
    softDelete: { column: "is_published", value: false, labelColumn: "title" },
    deleteWarning: "Deleting a course cascades its topics and enrollments. Prefer unpublishing it."
  },
  course_topics: {
    label: "Course topics",
    table: "course_topics",
    searchColumns: ["title", "description"],
    orderBy: "topic_order",
    displayColumns: ["title", "course_id", "importance", "is_published"],
    fields: [
      reference("course_id", "Course", "courses", { required: true }),
      reference("parent_topic_id", "Parent topic", "course_topics", { nullable: true }),
      text("title", "Topic title", { required: true }),
      textarea("description", "Description", { nullable: true, maxLength: 12_000 }),
      number("topic_order", "Display order", { nullable: true, integer: true, min: 0, default: 0 }),
      choice("importance", "Importance", ["essential", "supporting", "advanced", "standard"], { nullable: true, default: "standard" }),
      boolean("is_published", "Published", { nullable: true, default: false })
    ],
    softDelete: { column: "is_published", value: false, labelColumn: "title" },
    deleteWarning: "Deleting a topic cascades its learning objectives and question links. Prefer unpublishing it."
  },
  topic_learning_objectives: {
    label: "Topic learning objectives",
    table: "topic_learning_objectives",
    searchColumns: ["objective"],
    orderBy: "objective_order",
    displayColumns: ["objective", "topic_id", "objective_order"],
    fields: [
      reference("topic_id", "Topic", "course_topics", { required: true }),
      textarea("objective", "Learning objective", { required: true, maxLength: 8_000 }),
      number("objective_order", "Display order", { nullable: true, integer: true, min: 0, default: 0 })
    ],
    softDelete: { column: null, labelColumn: "objective" },
    deleteWarning: "This permanently removes the selected learning objective."
  },
  materials: {
    label: "Learning materials",
    table: "materials",
    searchColumns: ["title", "description", "material_type"],
    orderBy: "created_at",
    displayColumns: ["title", "material_type", "approval_status", "publication_status", "access_scope"],
    fields: [
      reference("university_id", "University", "universities", { nullable: true }),
      reference("course_id", "Course", "courses", { nullable: true }),
      reference("topic_id", "Topic", "course_topics", { nullable: true }),
      text("title", "Material title", { required: true }),
      textarea("description", "Description", { nullable: true, maxLength: 8_000 }),
      choice("material_type", "Material type", ["lecture_note", "textbook", "handout", "case_material", "statute", "past_question", "marking_scheme", "course_outline", "model_answer", "other"], { required: true }),
      choice("source_category", "Source category", ["lecturer_material", "legal_authority", "external_research", "platform_resource"], { nullable: true, default: "lecturer_material" }),
      choice("access_scope", "Access scope", ["institution", "platform", "private"], { nullable: true, default: "institution" }),
      choice("approval_status", "Approval status", ["pending", "approved", "rejected", "archived"], { nullable: true, default: "pending" }),
      choice("publication_status", "Publication status", ["draft", "published", "unpublished"], { nullable: true, default: "draft" }),
      textarea("content_text", "Paste material text (optional)", { virtual: true, nullable: true, maxLength: 700_000 })
    ],
    creatorColumn: "uploaded_by",
    softDelete: { column: "publication_status", value: "unpublished", labelColumn: "title" },
    deleteWarning: "Permanent deletion cascades material versions, chunks and authority links. Unpublish/archive is safer."
  },
  legal_cases: {
    label: "Legal cases",
    table: "legal_cases",
    searchColumns: ["case_name", "citation", "ratio_decidendi", "jurisdiction"],
    orderBy: "case_name",
    displayColumns: ["case_name", "citation", "jurisdiction", "year", "verification_status"],
    fields: [
      text("case_name", "Case name", { required: true }),
      textarea("citation", "Citation", { nullable: true, maxLength: 4_000 }),
      text("court", "Court", { nullable: true }),
      text("jurisdiction", "Jurisdiction", { nullable: true, default: "Nigeria" }),
      number("year", "Year", { nullable: true, integer: true, min: 1000, max: 3000 }),
      text("subject_area", "Subject area", { nullable: true }),
      textarea("material_facts", "Material facts", { nullable: true, maxLength: 30_000 }),
      textarea("legal_issues", "Legal issues", { nullable: true, maxLength: 30_000 }),
      textarea("decision", "Decision", { nullable: true, maxLength: 30_000 }),
      textarea("ratio_decidendi", "Ratio decidendi", { nullable: true, maxLength: 30_000 }),
      textarea("obiter_dicta", "Obiter dicta", { nullable: true, maxLength: 30_000 }),
      text("full_judgment_url", "Full judgment URL", { type: "url", nullable: true, maxLength: 2_000 }),
      reference("source_material_id", "Source material", "materials", { nullable: true }),
      choice("verification_status", "Verification status", ["unverified", "verified", "disputed"], { nullable: true, default: "unverified" })
    ],
    softDelete: { column: null, labelColumn: "case_name" },
    deleteWarning: "Deleting a case cascades its case summaries, mnemonics and material-authority links."
  },
  case_mnemonics: {
    label: "Case mnemonics",
    table: "case_mnemonics",
    searchColumns: ["mnemonic", "explanation"],
    orderBy: "created_at",
    displayColumns: ["mnemonic", "case_id", "is_verified"],
    fields: [
      reference("case_id", "Legal case", "legal_cases", { required: true }),
      textarea("mnemonic", "Mnemonic", { required: true, maxLength: 8_000 }),
      textarea("explanation", "Explanation", { nullable: true, maxLength: 20_000 }),
      boolean("is_verified", "Verified by an editor", { nullable: true, default: false })
    ],
    creatorColumn: "created_by",
    softDelete: { column: null, labelColumn: "mnemonic" },
    deleteWarning: "This permanently removes the selected mnemonic."
  },
  statutes: {
    label: "Statutes and legislation",
    table: "statutes",
    searchColumns: ["title", "short_title", "jurisdiction", "statute_number"],
    orderBy: "title",
    displayColumns: ["title", "jurisdiction", "year", "verification_status"],
    fields: [
      text("title", "Statute title", { required: true }),
      text("short_title", "Short title", { nullable: true }),
      text("jurisdiction", "Jurisdiction", { nullable: true, default: "Nigeria" }),
      text("statute_number", "Statute number", { nullable: true }),
      number("year", "Year", { nullable: true, integer: true, min: 1000, max: 3000 }),
      date("commencement_date", "Commencement date", { nullable: true }),
      text("amendment_status", "Amendment status", { nullable: true }),
      text("source_url", "Source URL", { type: "url", nullable: true, maxLength: 2_000 }),
      reference("source_material_id", "Source material", "materials", { nullable: true }),
      choice("verification_status", "Verification status", ["unverified", "verified", "disputed"], { nullable: true, default: "unverified" })
    ],
    softDelete: { column: null, labelColumn: "title" },
    deleteWarning: "Deleting a statute cascades all its sections and authority links."
  },
  statute_sections: {
    label: "Statute sections",
    table: "statute_sections",
    searchColumns: ["section_number", "heading", "full_text"],
    orderBy: "section_number",
    displayColumns: ["section_number", "heading", "statute_id"],
    fields: [
      reference("statute_id", "Statute", "statutes", { required: true }),
      text("section_number", "Section number", { required: true }),
      textarea("heading", "Heading", { nullable: true, maxLength: 4_000 }),
      textarea("full_text", "Full text", { required: true, maxLength: 40_000 }),
      textarea("simplified_explanation", "Simplified explanation", { nullable: true, maxLength: 20_000 }),
      textarea("legal_effect", "Legal effect", { nullable: true, maxLength: 20_000 }),
      textarea("amendment_note", "Amendment note", { nullable: true, maxLength: 8_000 })
    ],
    softDelete: { column: null, labelColumn: "section_number" },
    deleteWarning: "Deleting a statute section also deletes material-authority links that reference it."
  },
  past_questions: {
    label: "Past questions",
    table: "past_questions",
    searchColumns: ["question_text", "question_number", "semester"],
    orderBy: "created_at",
    displayColumns: ["question_number", "examination_year", "semester", "course_id", "verification_status"],
    fields: [
      reference("university_id", "University", "universities", { nullable: true }),
      reference("course_id", "Course", "courses", { nullable: true }),
      number("examination_year", "Examination year", { nullable: true, integer: true, min: 1000, max: 3000 }),
      text("semester", "Semester", { nullable: true }),
      text("question_number", "Question number", { nullable: true }),
      textarea("question_text", "Question text", { required: true, maxLength: 30_000 }),
      number("marks", "Marks", { nullable: true, min: 0, max: 100_000 }),
      number("examination_duration_minutes", "Duration in minutes", { nullable: true, integer: true, min: 1, max: 2_000 }),
      reference("source_material_id", "Source material", "materials", { nullable: true }),
      choice("provenance", "Provenance", ["verified_past_question", "AI_practice", "AI_prediction", "lecturer_created"], { nullable: true, default: "verified_past_question" }),
      choice("verification_status", "Verification status", ["pending", "verified", "rejected"], { nullable: true, default: "pending" })
    ],
    creatorColumn: "uploaded_by",
    softDelete: { column: null, labelColumn: "question_number" },
    deleteWarning: "Deleting a past question cascades its topic links and marking rubrics."
  },
  marking_rubrics: {
    label: "Marking rubrics",
    table: "marking_rubrics",
    searchColumns: ["title", "instructions"],
    orderBy: "created_at",
    displayColumns: ["title", "course_id", "question_id", "total_marks"],
    fields: [
      reference("course_id", "Course", "courses", { nullable: true }),
      reference("question_id", "Past question", "past_questions", { nullable: true }),
      text("title", "Rubric title", { required: true }),
      number("total_marks", "Total marks", { nullable: true, min: 0, max: 100_000 }),
      textarea("instructions", "Instructions", { nullable: true, maxLength: 20_000 })
    ],
    creatorColumn: "created_by",
    softDelete: { column: null, labelColumn: "title" },
    deleteWarning: "Deleting a rubric cascades its marking criteria."
  },
  marking_criteria: {
    label: "Marking criteria",
    table: "marking_criteria",
    searchColumns: ["criterion", "description"],
    orderBy: "criterion_order",
    displayColumns: ["criterion", "rubric_id", "marks_available", "criterion_order"],
    fields: [
      reference("rubric_id", "Rubric", "marking_rubrics", { required: true }),
      text("criterion", "Criterion", { required: true }),
      textarea("description", "Description", { nullable: true, maxLength: 12_000 }),
      number("marks_available", "Marks available", { required: true, min: 0, max: 100_000 }),
      number("criterion_order", "Display order", { nullable: true, integer: true, min: 0, default: 0 })
    ],
    softDelete: { column: null, labelColumn: "criterion" },
    deleteWarning: "This permanently removes the selected rubric criterion."
  },
  material_authorities: {
    label: "Material authority links",
    table: "material_authorities",
    searchColumns: ["reference_note"],
    orderBy: "created_at",
    displayColumns: ["material_id", "case_id", "statute_section_id", "reference_note"],
    fields: [
      reference("material_id", "Material", "materials", { required: true }),
      reference("case_id", "Legal case (choose one authority type)", "legal_cases", { nullable: true }),
      reference("statute_section_id", "Statute section (choose one authority type)", "statute_sections", { nullable: true }),
      textarea("reference_note", "Reference note", { nullable: true, maxLength: 8_000 })
    ],
    softDelete: { column: null, labelColumn: "reference_note" },
    deleteWarning: "This removes only the material-authority relationship, not the material or legal authority."
  }
});

export function getAdminDatabaseCatalog() {
  return Object.entries(ADMIN_DATABASE_CATALOG).map(([key, definition]) => ({
    key,
    label: definition.label,
    displayColumns: definition.displayColumns,
    deleteWarning: definition.deleteWarning,
    deleteMode: definition.softDelete?.column ? "deactivate" : "delete",
    fields: definition.fields.map((field) => ({ ...field, options: field.options ? [...field.options] : undefined }))
  }));
}

export function getAdminDataset(key) {
  return ADMIN_DATABASE_CATALOG[key] || null;
}

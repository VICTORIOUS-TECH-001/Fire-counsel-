// Background instructions for FIRE COUNSEL AI.
//
// The instruction TEXT is private: an administrator imports the "Master
// Prompts and Guides" .txt file (or types each instruction) in the Admin
// Studio, and it is stored in Neon (ai_instructions) — never in this public
// repository. This module only knows the instruction NAMES, how to read them
// out of that file, and which ones to send to the AI for each question.

export const INSTRUCTION_KEYS = Object.freeze({
  // Sent with EVERY answer (chat, case analysis, notes, question setter).
  system_instructions: { label: "Master system instructions", group: "always", source: "SYSTEM_INSTRUCTIONS" },
  document_handling_rules: { label: "Document-handling rules", group: "always", source: "DOCUMENT_HANDLING_RULES" },
  response_formatting_rules: { label: "Response formatting rules", group: "always", source: "RESPONSE_FORMATTING_RULES" },
  default_configuration: { label: "Recommended default configuration", group: "always", source: "RECOMMENDED DEFAULT CONFIGURATION" },
  // Added only when the student's request needs them (chosen by the server).
  concept_explanation: { label: "Concept explanation", group: "specialist", source: "CONCEPT_EXPLANATION_PROMPT" },
  case_analysis: { label: "Case analysis", group: "specialist", source: "CASE_ANALYSIS_PROMPT" },
  legal_research: { label: "Legal research", group: "specialist", source: "LEGAL_RESEARCH_PROMPT" },
  statutory_interpretation: { label: "Statutory interpretation", group: "specialist", source: "STATUTORY_INTERPRETATION_PROMPT" },
  case_comparison: { label: "Case comparison", group: "specialist", source: "CASE_COMPARISON_PROMPT" },
  exam_generation: { label: "Exam question generator", group: "specialist", source: "EXAM_GENERATOR_PROMPT" },
  answer_marking: { label: "Answer marking", group: "specialist", source: "ANSWER_MARKING_PROMPT" },
  law_coach: { label: "Law exam coach", group: "specialist", source: "LAW_COACH_PROMPT" },
  legal_writing: { label: "Legal writing", group: "specialist", source: "LEGAL_WRITING_PROMPT" },
  socratic_tutoring: { label: "Socratic tutoring", group: "specialist", source: "SOCRATIC_TUTOR_PROMPT" },
  // Research step: guides which web searches the researcher runs.
  research_query: { label: "Research query planner", group: "research", source: "RESEARCH_QUERY_PROMPT" },
  // Kept for reference: the server routes questions itself (instant, and it
  // does not spend the free AI quota on an extra classification call).
  intent_classifier: { label: "Intent classifier (reference)", group: "reference", source: "INTENT_CLASSIFIER_PROMPT" }
});

export const SPECIALIST_INTENTS = Object.freeze(Object.keys(INSTRUCTION_KEYS).filter((key) => INSTRUCTION_KEYS[key].group === "specialist"));
const MAX_LENGTH = 50_000;
const MAX_SPECIALISTS = 3;

/**
 * Reads the instruction blocks out of the owner's prompt file. Accepts the
 * code-ready form `NAME = r'''...'''` (also """ quotes) and the plain section
 * "RECOMMENDED DEFAULT CONFIGURATION". Unknown blocks are ignored.
 */
export function parseInstructionFile(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const byName = new Map(Object.entries(INSTRUCTION_KEYS).map(([key, info]) => [info.source, key]));
  const found = {};
  const block = /^[ \t]*([A-Z][A-Z0-9_]{2,60})[ \t]*=[ \t]*[rRuU]?('''|""")\n?([\s\S]*?)\2/gm;
  for (const match of source.matchAll(block)) {
    const key = byName.get(match[1]);
    const content = match[3].trim();
    if (key && content.length >= 20) found[key] = content.slice(0, MAX_LENGTH);
  }
  const config = /^[ \t]*(?:\d+\.\s*)?RECOMMENDED DEFAULT CONFIGURATION[ \t]*\n(?:=+[ \t]*\n)?([\s\S]*?)(?:\n=+[ \t]*\n|\n[ \t]*\d+\.\s+[A-Z][A-Z ]{6,}\n|(?![\s\S]))/m.exec(source);
  if (config) {
    const content = config[1].replace(/^=+\s*$/gm, "").trim();
    if (content.length >= 20) found.default_configuration = content.slice(0, MAX_LENGTH);
  }
  return found;
}

export function validInstruction(key, content) {
  if (!INSTRUCTION_KEYS[key]) return "Unknown instruction.";
  const text = String(content ?? "").trim();
  if (text.length < 20 || text.length > MAX_LENGTH) return `Each instruction must be between 20 and ${MAX_LENGTH.toLocaleString("en")} characters.`;
  return null;
}

export async function ensureInstructionsTable(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ai_instructions (
    key text PRIMARY KEY CHECK (char_length(key) BETWEEN 2 AND 60),
    content text NOT NULL CHECK (char_length(content) BETWEEN 20 AND 50000),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    updated_by text
  )`);
}

let cache = null;
const CACHE_MS = 60_000;
export function clearInstructionCache() { cache = null; }

/** All saved instructions as { key: content }. Empty when none are saved yet. */
export async function loadInstructions(db) {
  if (cache && cache.expires > Date.now()) return cache.value;
  let value = {};
  try {
    const result = await db.query("SELECT key, content FROM ai_instructions");
    value = Object.fromEntries(result.rows.filter((row) => INSTRUCTION_KEYS[row.key]).map((row) => [row.key, row.content]));
  } catch (error) {
    if (error?.code !== "42P01") throw error; // table not created yet
  }
  cache = { value, expires: Date.now() + CACHE_MS };
  return value;
}

// ------------------------------------------------------------------ routing
// Deterministic, allow-listed intent routing (the guide's rule: the backend —
// not the model — decides which instructions apply). Several can apply at once.
const TASK_INTENTS = {
  mnemonics: ["concept_explanation"],
  summary: ["case_analysis"],
  irac: ["law_coach"],
  flashcards: ["concept_explanation"],
  compare: ["case_comparison"],
  statute: ["statutory_interpretation"],
  essay: ["legal_writing"],
  explain: ["concept_explanation"],
  marker: ["answer_marking"],
  library: ["legal_research"],
  mock: ["exam_generation"]
};

const RULES = [
  ["answer_marking", /\b(mark|grade|score|assess|evaluate|review)\s+(my|this|the)\s+(answer|script|essay|work)|\bhow (many|much) (marks|would i (get|score))|\bmark (it|this|me)\b/i],
  ["exam_generation", /\b(set|generate|create|give|make|prepare|draft)\b[^.?!]{0,40}\b(questions?|exam|quiz|test|past[- ]questions?|mcqs?)\b|\bpractice questions?\b|\bpossible (exam )?questions\b/i],
  ["socratic_tutoring", /\b(quiz me|test me|ask me (questions|one question)|socratic|step by step with me|guide me)\b/i],
  ["case_comparison", /\b(compare|comparison|contrast|distinguish|reconcile)\b|\bdifference between\b[^.?!]{0,80}\b(cases?|v\.?|vs\.?)\b/i],
  ["case_analysis", /\b[A-Z][\w.'&-]+(?:\s+[A-Z][\w.'&-]+)*\s+v\.?s?\.?\s+[A-Z][\w.'&-]+|\b(case (analysis|brief|note|summary)|analy[sz]e (the |this )?(case|judgment)|ratio decidendi|obiter|the holding|the judgment in)\b/i],
  ["statutory_interpretation", /\b(section|sections|s\.|ss\.|article|order|rule|schedule)\s*\d+|\b(interpret|interpretation|meaning of (the )?(section|provision|act))\b|\bconstitution of the federal republic\b/i],
  ["law_coach", /\b(problem question|irac|advise [A-Z]|advise the|exam technique|how (do|should|can) i (answer|approach|tackle|structure))\b/i],
  ["legal_writing", /\b(essay|write (a|an|my)|draft (a|an|my)|memo|legal opinion|letter|brief of argument|edit my|improve my (essay|answer|writing))\b/i],
  ["legal_research", /\b(research|authorities|leading (?:\w+ )?cases|cases on|case law on|current (law|position)|latest|recent|amend(ed|ment)s?|is it still|good law|which court)\b/i],
  ["concept_explanation", /\b(explain|what is|what are|what does|meaning|define|definition|concept|doctrine|principle|elements of|teach me|help me understand)\b/i]
];

/**
 * Picks the specialist instructions for a request (max 3, most specific first).
 * `task` is a chat tool (mnemonics, irac…); `mode` is case/notes/questions.
 */
export function detectIntents(text = "", { task = null, mode = "chat", attachments = [] } = {}) {
  const intents = [];
  const add = (intent) => { if (SPECIALIST_INTENTS.includes(intent) && !intents.includes(intent)) intents.push(intent); };
  if (mode === "case") add("case_analysis");
  if (mode === "questions") add("exam_generation");
  if (mode === "notes") add("concept_explanation");
  for (const intent of TASK_INTENTS[task] || []) add(intent);
  const sample = String(text || "").slice(0, 4000);
  for (const [intent, pattern] of RULES) if (pattern.test(sample)) add(intent);
  if (!intents.length && mode === "chat") add(attachments.length ? "concept_explanation" : sample.length > 400 ? "law_coach" : "concept_explanation");
  const picked = intents.slice(0, MAX_SPECIALISTS);
  return { intents: picked, document_analysis: attachments.length > 0 };
}

const FOREIGN = /\b(english|england|uk|united kingdom|british|american|usa|united states|ghana|kenya|south africa|india|canada|australia|french|eu law|european)\b/i;

/**
 * Builds the background block placed before the task prompt. Returns "" when
 * no instructions are saved (the short built-in rules are used instead).
 */
export function backgroundInstructions(saved = {}, { intents = [], text = "", json = false } = {}) {
  if (!saved || !Object.keys(saved).length) return "";
  const parts = [];
  if (saved.system_instructions) parts.push(saved.system_instructions);
  if (saved.document_handling_rules) parts.push(`DOCUMENT HANDLING\n${saved.document_handling_rules}`);
  if (!json && saved.response_formatting_rules) parts.push(`RESPONSE FORMATTING\n${saved.response_formatting_rules}`);
  if (saved.default_configuration) parts.push(`DEFAULT CONFIGURATION\n${saved.default_configuration}`);
  const specialists = intents.filter((intent) => saved[intent]);
  if (specialists.length) {
    parts.push(`TASK INSTRUCTIONS FOR THIS REQUEST (${specialists.map((i) => INSTRUCTION_KEYS[i].label).join(" + ")})\n` +
      specialists.map((intent) => `## ${INSTRUCTION_KEYS[intent].label}\n${saved[intent]}`).join("\n\n"));
  }
  if (!FOREIGN.test(String(text).slice(0, 4000))) parts.push("JURISDICTION FOR THIS REQUEST: Nigeria (assumed — the student did not name another jurisdiction). Mention this assumption briefly only where it matters.");
  return parts.filter(Boolean).join("\n\n");
}

/** Extra guidance for the web researcher, built from the saved query planner. */
export function researchGuidance(saved = {}) {
  if (!saved?.research_query) return "";
  return `QUERY PLANNING RULES (use them to decide which searches to run; do NOT output JSON — return research notes as instructed above):\n${saved.research_query}`;
}

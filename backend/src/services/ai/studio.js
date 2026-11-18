// FIRE COUNSEL AI studio pipelines.
//
// Free-tier design: a "researcher" Gemini model with Google Search collects
// real sources; the server opens every link; then a stronger "writer" model
// produces the document in the owner's prompt format using only those checked
// sources. If Gemini is unavailable, OpenRouter free models write the answer
// (without live web search — links are still checked and labelled).
import { AiError, generate as defaultGenerate, parseJsonReply } from "./providers.js";
import { extractUrls, termsFrom, verifySources as defaultVerify } from "./linkCheck.js";
import { composeSystem, loadPrompt } from "./prompts.js";

const RESEARCHER = `You are a meticulous legal research assistant with Google Search. Search the whole web (court and law-report websites, Nigerian legal databases, university repositories, law-firm notes, blogs and other secondary sources). Run several searches with different wording (party names, citation formats such as NWLR/SC/CA/LPELR, court, year, key phrases).
Return concise research notes:
1. Identity: correct name, full citation(s), court, date, judges if found.
2. Facts, procedural history, issues, decision/holding, ratio, exceptions, later treatment — only what the sources support.
3. For EVERY statement give the source URL you actually used.
4. Put anything from blogs, student notes, news or other secondary sources in a separate "SECONDARY SOURCES (unverified)" list.
5. Say clearly what you could NOT find. Never invent a citation, quotation or URL.`;

const EXTRACTOR = `You read uploaded law textbook pages, notes or photographs and list every case and authority cited, including those only in footnotes, tables or margins. Preserve spelling and citation exactly as printed. Respond with JSON only:
{"subject":"...","topic":"...","cases":[{"name":"as printed","citation":"as printed or empty","page":"page if visible","footnote":"number if any","proposition":"what the text cites it for","uncertain":false}]}`;

const DETECTOR = `You classify study material or an exam question into the correct course from a fixed list. Consider course code, title, level, topics and the legal subject matter (e.g. contract vs. tort vs. constitutional law). Respond with JSON only:
{"course_id":"<id from the list or null>","confidence":0.0,"reason":"one sentence","alternatives":["<id>","<id>"]}
Use confidence below 0.55 when the material could belong to more than one listed course.`;

// Quick study tools that run through the chat allowance. The student's text
// (or uploaded file) is the material; the instruction shapes the answer.
export const CHAT_TASKS = {
  mnemonics: { label: "Mnemonics", instruction: "TASK — MNEMONICS: Create memorable mnemonics (acronyms, rhymes or short stories) for the topic, list of elements or cases given. For each: the mnemonic in bold, what each letter/part stands for, the case or statutory authority for each element, and one line on how to use it in an exam answer. Finish with a 3-question self-test." },
  summary: { label: "Summary", instruction: "TASK — SUMMARY: Summarise the material or judgment for exam revision. For a case use: Citation · Court · Facts · Issues · Holding · Ratio decidendi · Obiter · Significance. For notes use short headed sections with the key rules and authorities. End with 5 key takeaways." },
  irac: { label: "IRAC answer", instruction: "TASK — PROBLEM QUESTION (IRAC): Answer the problem question like a top Nigerian law exam script: identify every Issue, state the Rule with authorities (cases and statutes), Apply them to the facts step by step (consider both sides), and Conclude for each issue. Add a short 'Marks boosters' list." },
  flashcards: { label: "Flashcards", instruction: "TASK — FLASHCARDS: Make 10–20 question-and-answer flashcards from the material. Format each as '**Q:** …' then '**A:** …' (answers short, with the case or section). Mix definitions, elements, case facts → principle, and exceptions." },
  compare: { label: "Compare cases", instruction: "TASK — COMPARE / DISTINGUISH: Compare the cases or doctrines given. Use a Markdown table (facts, issue, decision, ratio, court/year), then explain how they can be reconciled or distinguished and which binds a Nigerian court." },
  statute: { label: "Explain a section", instruction: "TASK — STATUTE EXPLAINER: Explain the statutory or constitutional provision in plain English: what it says (quote it if you are sure of the wording, otherwise say so), its elements, exceptions/limits, leading Nigerian cases interpreting it, and a short exam example." },
  essay: { label: "Essay plan", instruction: "TASK — ESSAY PLAN: Plan an essay answer: thesis, introduction points, 4–6 headed body sections each with the authorities to cite, counter-arguments, and a conclusion. Keep it in outline form the student can expand in the exam." },
  explain: { label: "Explain simply", instruction: "TASK — EXPLAIN SIMPLY: Explain the topic or the uploaded notes/photo step by step in simple language for a law student, with one everyday example, the leading authorities, and a 3-question quick check at the end." },
  marker: { label: "Mark my answer", instruction: "TASK — MARK MY ANSWER: You are a strict but encouraging Nigerian university law lecturer marking an exam script. The student's message (or attached photo of a handwritten script) contains the question and their answer; it may also include marking points. Respond with: 1) **Score: X / Y** — use the marks stated in the question, otherwise mark out of 20 — and the grade band (A–F); 2) **What you did well**; 3) **What was missing or wrong** — issues not spotted, rules misstated, and the cases and statutes that should have been cited; 4) **Structure and technique** (IRAC for problem questions, argument flow for essays, use of authority, time management); 5) **Model answer outline** the student can learn from; 6) **Three specific tips** for the next attempt. Be fair and specific. If no answer is given, say so and ask for it instead of inventing one." },
  mock: { label: "Mock exam", instruction: "TASK — MOCK EXAM (JSON)." },
  library: { label: "Course library", instruction: "TASK — COURSE LIBRARY ANSWER: Answer mainly from the FIRE COUNSEL LIBRARY passages supplied, citing each point as [Library: title, p. N]. If the library does not cover something, say so clearly before adding general knowledge." }
};

const MOCK_SETTER = `You set timed mock examinations for Nigerian law students. Use the student's notes, topic or uploaded pages (and any FIRE COUNSEL LIBRARY passages supplied) to set fair, exam-standard questions. Respond with JSON only:
{"title":"short exam title","instructions":"one or two lines of rubric","questions":[
 {"type":"mcq","question":"...","options":["...","...","...","..."],"answer":0,"explanation":"why this is right, citing the case or section","marks":1},
 {"type":"essay","question":"essay or problem question (with facts for problem questions)","marks":10,"guide":"marking points: issues, rules and authorities a strong answer must cover"}
]}
Rules: "answer" is the 0-based index of the single correct option; give exactly 4 options for MCQs, with plausible distractors; do not repeat questions; never invent case names or citations — use only well-known authorities you are sure of.`;

const clampInt = (value, min, max, fallback) => (Number.isFinite(Number(value)) ? Math.min(Math.max(Math.round(Number(value)), min), max) : fallback);

/** Validates an AI-made mock exam so the page can always render it safely. */
export function normalizeQuiz(raw, { type = "mcq", minutes = null, count = 10 } = {}) {
  if (!raw || !Array.isArray(raw.questions)) return null;
  const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const questions = [];
  for (const item of raw.questions.slice(0, 30)) {
    const question = text(item?.question, 3000);
    if (!question) continue;
    const options = Array.isArray(item?.options) ? item.options.map((o) => text(o, 500)).filter(Boolean).slice(0, 6) : [];
    const answer = Number.isInteger(item?.answer) ? item.answer : Number.isInteger(Number(item?.answer)) ? Number(item.answer) : -1;
    if (item?.type !== "essay" && options.length >= 2 && answer >= 0 && answer < options.length) {
      questions.push({ type: "mcq", question, options, answer, explanation: text(item.explanation, 1500), marks: clampInt(item.marks, 1, 10, 1) });
    } else if (item?.type === "essay" || type !== "mcq") {
      questions.push({ type: "essay", question, marks: clampInt(item?.marks, 1, 50, 10), guide: text(item?.guide, 3000) });
    }
  }
  if (!questions.length) return null;
  const limited = questions.slice(0, Math.max(count, 1));
  const essays = limited.filter((q) => q.type === "essay").length;
  const suggested = Math.round((limited.length - essays) * 1.5) + essays * 20;
  return {
    title: text(raw.title, 160) || "Mock exam",
    instructions: text(raw.instructions, 600) || "Answer all questions.",
    minutes: clampInt(minutes ?? suggested, 2, 180, 15),
    total_marks: limited.reduce((sum, q) => sum + q.marks, 0),
    questions: limited
  };
}

function quizMarkdown(quiz) {
  const letters = "ABCDEF";
  const body = quiz.questions.map((q, i) => q.type === "mcq"
    ? `**${i + 1}.** ${q.question} *(${q.marks} mark${q.marks === 1 ? "" : "s"})*\n\n${q.options.map((o, j) => `- ${letters[j]}. ${o}`).join("\n")}`
    : `**${i + 1}.** ${q.question} *(${q.marks} marks)*`).join("\n\n");
  const key = quiz.questions.map((q, i) => q.type === "mcq"
    ? `${i + 1}. **${letters[q.answer]}** — ${q.explanation || ""}`
    : `${i + 1}. Marking points: ${q.guide || "—"}`).join("\n");
  return `## ${quiz.title}\n\n> ⏱ Time allowed: **${quiz.minutes} minutes** · Total: **${quiz.total_marks} marks**. ${quiz.instructions}\n\nTap **Start timed exam** to sit it with a countdown.\n\n${body}\n\n---\n\n### Answer key\n\n${key}`;
}

const MAX_CASES = (env) => Math.min(Math.max(Number(env.AI_MAX_CASES_PER_RUN) || 5, 1), 12);
const truncate = (value, max) => (String(value || "").length > max ? `${String(value).slice(0, max)}…` : String(value || ""));

const STATUS_LABEL = {
  verified: "CHECKED — page opens and mentions the case/topic",
  reachable: "page opens; case name not confirmed on the page",
  restricted: "site blocks automated checks; open manually to confirm"
};

function sourceBlock(sources) {
  const usable = sources.filter((source) => source.status !== "broken");
  if (!usable.length) return "No checked web sources are available for this answer. Do not include any URL; state that verification links could not be obtained.";
  return usable.map((source, index) => `[${index + 1}] ${source.title || "Untitled"} — ${source.url} (${STATUS_LABEL[source.status] || source.status})`).join("\n");
}

function lengthNote(result) {
  return result.truncated ? "\n\n> ⚠ This answer reached the maximum length. Send **continue** in this conversation to get the rest." : "";
}

const STOP_WORDS = new Set("about above after again against also among another because been before being below between both cannot could does doing down during each explain from further have having here hers herself himself into itself just more most myself near once only other ought ourselves over same should some such than that their theirs them themselves then there these they this those through under until upon very what when where which while whom whose with within without would your yours yourself discuss answer question please tell give write case cases make note notes".split(" "));

/** Distinct, safe search words for Postgres to_tsquery (letters/digits only). */
export function librarySearchTerms(query, max = 12) {
  const words = String(query || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  const out = [];
  for (const word of words) {
    if (word.length < 4 || STOP_WORDS.has(word) || /^\d+$/.test(word) && word.length !== 4 || out.includes(word)) continue;
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/** Exact phrases worth searching on their own: case names, sections, quotes. */
export function libraryPhrases(query, max = 4) {
  const textValue = String(query || "");
  const phrases = [];
  const add = (value) => {
    const phrase = value.replace(/[^A-Za-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    if (phrase.split(" ").length >= 2 && phrase.length <= 120 && !phrases.includes(phrase)) phrases.push(phrase);
  };
  const name = "[A-Z][A-Za-z.&'’-]+(?:\\s+(?:[A-Z][A-Za-z.&'’-]+|of|and|&|for))*";
  const filler = /^(explain|discuss|what|whats|analyse|analyze|examine|compare|describe|consider|summarise|summarize|in|the|see|under|per|case|cases|and|of|for|&)$/i;
  for (const match of textValue.matchAll(new RegExp(`(${name})\\s+v\\.?\\s+(${name})`, "g"))) {
    const left = match[1].split(/\s+/).filter((word) => !filler.test(word)).slice(-3);
    const right = match[2].split(/\s+/).filter((word) => !filler.test(word)).slice(0, 3);
    if (left.length && right.length) add(`${left.join(" ")} ${right.join(" ")}`);
  }
  for (const match of textValue.matchAll(/\b(?:section|sections|s\.|article|art\.)\s*(\d+[A-Za-z]?)(?:\s+of\s+the\s+([A-Za-z0-9 ]{3,60}?))?(?=[,.;:)]|$|\s{2})/gi)) add(`section ${match[1]}${match[2] ? ` ${match[2]}` : ""}`);
  for (const match of textValue.matchAll(/["“]([^"”]{6,100})["”]/g)) add(match[1]);
  return phrases.slice(0, max);
}

/** Runs fn over items with at most `limit` running at the same time. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

// Recent web research (6 hours by default). Popular cases and questions are
// answered from here instantly and do not use Google Search quota again.
const RESEARCH_CACHE = new Map();
export function clearResearchCache() { RESEARCH_CACHE.clear(); }

export function createStudio({ db, env = process.env, generate = defaultGenerate, verify = defaultVerify, fetchImpl, researchCache = generate === defaultGenerate } = {}) {
  const gen = (request) => generate(request, { env, fetchImpl });
  const cacheMs = clampInt(env.AI_RESEARCH_CACHE_MINUTES, 0, 24 * 60, 360) * 60_000;
  const researchParallel = clampInt(env.AI_RESEARCH_PARALLEL, 1, 6, 3);

  async function research(query, attachments = [], { timeoutMs, searchQuery } = {}) {
    const key = researchCache && cacheMs && !attachments.length ? String(query).toLowerCase().replace(/\s+/g, " ").trim() : null;
    const hit = key ? RESEARCH_CACHE.get(key) : null;
    if (hit && hit.until > Date.now()) return { ...hit.value, cached: true };
    try {
      const result = await gen({ search: true, searchQuery, system: RESEARCHER, messages: [{ role: "user", text: query, attachments }], maxTokens: 6000, temperature: 0.2, timeoutMs });
      const value = { ok: true, notes: result.text, sources: result.sources, queries: result.searchQueries, model: result.model };
      if (key && value.sources.length) {
        if (RESEARCH_CACHE.size >= 300) RESEARCH_CACHE.delete(RESEARCH_CACHE.keys().next().value);
        RESEARCH_CACHE.set(key, { until: Date.now() + cacheMs, value });
      }
      return value;
    } catch (error) {
      return { ok: false, notes: "", sources: [], queries: [], error: error.message };
    }
  }

  async function finalSources(answerText, checked, terms) {
    const known = new Set(checked.map((source) => source.url));
    const extra = extractUrls(answerText).filter((url) => !known.has(url)).map((url) => ({ url, origin: "answer" }));
    const checkedExtra = extra.length ? await verify(extra, { terms, limit: 15 }) : [];
    // Only sources actually cited in the answer, plus all checked research sources.
    return [...checked, ...checkedExtra];
  }

  async function findCases(query) {
    const term = termsFrom(query)[0];
    if (!term) return [];
    try {
      const result = await db.query(
        "SELECT * FROM legal_cases WHERE case_name ILIKE $1 OR citation ILIKE $1 ORDER BY (case_name ILIKE $2) DESC, case_name LIMIT 3",
        [`%${term}%`, `%${query.slice(0, 200)}%`]);
      return result.rows;
    } catch {
      return [];
    }
  }

  function caseRecordText(row) {
    const skip = new Set(["id", "created_at", "updated_at", "created_by", "source_material_id"]);
    return Object.entries(row).filter(([key, value]) => !skip.has(key) && value != null && value !== "")
      .map(([key, value]) => `- ${key}: ${truncate(value, 4000)}`).join("\n");
  }

  async function listCourses() {
    try {
      const [courses, topics] = await Promise.all([
        db.query(`SELECT c.id, c.course_code, c.title, c.academic_level, c.semester, u.short_name, u.name AS university
                    FROM courses c LEFT JOIN universities u ON u.id = c.university_id
                   WHERE c.is_published = true ORDER BY c.title LIMIT 300`),
        db.query("SELECT course_id, string_agg(title, '; ' ORDER BY topic_order) AS topics FROM course_topics WHERE COALESCE(is_published, false) = true GROUP BY course_id")
      ]);
      const topicMap = new Map(topics.rows.map((row) => [row.course_id, row.topics]));
      return courses.rows.map((row) => ({ ...row, topics: truncate(topicMap.get(row.id), 400) }));
    } catch {
      return [];
    }
  }

  async function pastQuestions(courseId, limit = 30) {
    const result = await db.query(
      `SELECT examination_year, semester, question_number, question_text, marks, examination_duration_minutes
         FROM past_questions
        WHERE course_id = $1 AND COALESCE(verification_status, 'pending') <> 'rejected'
          AND COALESCE(provenance, 'verified_past_question') IN ('verified_past_question', 'lecturer_created')
        ORDER BY examination_year DESC NULLS LAST, semester, question_number LIMIT $2`, [courseId, limit]);
    return result.rows;
  }

  function formatProfile(questions) {
    if (!questions.length) return null;
    const papers = new Map();
    for (const question of questions) {
      const key = `${question.examination_year || "Unknown year"} ${question.semester || ""}`.trim();
      if (!papers.has(key)) papers.set(key, []);
      papers.get(key).push(question);
    }
    const marks = [...new Set(questions.map((q) => q.marks).filter((m) => m != null).map(Number))];
    const durations = [...new Set(questions.map((q) => q.examination_duration_minutes).filter(Boolean))];
    const perPaper = [...papers.values()].map((list) => list.length);
    return {
      papers: papers.size,
      questionsPerPaper: perPaper.length ? Math.round(perPaper.reduce((a, b) => a + b, 0) / perPaper.length) : null,
      marks, durations, years: [...papers.keys()],
      text: [...papers.entries()].map(([paper, list]) => `### Paper: ${paper}\n${list.map((q) => `Question ${q.question_number || "?"}${q.marks != null ? ` (${q.marks} marks)` : ""}${q.examination_duration_minutes ? ` [${q.examination_duration_minutes} min paper]` : ""}:\n${truncate(q.question_text, 2500)}`).join("\n\n")}`).join("\n\n")
    };
  }

  // ---------------- uploaded library (Neon material_chunks) ----------------

  const TYPE_LABEL = { lecture_note: "lecture note", textbook: "textbook", handout: "handout", case_material: "judgment / case material", statute: "statute", past_question: "past paper", marking_scheme: "marking scheme", course_outline: "course outline", model_answer: "model answer", other: "material" };

  async function librarySearch(fn, value, courseId, limit, boost) {
    try {
      const result = await db.query(
        `SELECT m.id AS material_id, m.title, m.material_type, chunk.page_number, chunk.content,
                ts_rank_cd(to_tsvector('english', chunk.content), q.query) + CASE WHEN $2::uuid IS NOT NULL AND m.course_id = $2::uuid THEN 0.5 ELSE 0 END + $4::float AS score
           FROM material_chunks chunk
           JOIN materials m ON m.id = chunk.material_id
           CROSS JOIN (SELECT ${fn === "plainto_tsquery" ? "plainto_tsquery" : "to_tsquery"}('english', $1) AS query) q
          WHERE m.approval_status = 'approved' AND m.publication_status = 'published' AND m.access_scope IN ('platform', 'institution')
            AND to_tsvector('english', chunk.content) @@ q.query
            AND chunk.version_id = (SELECT v.id FROM material_versions v WHERE v.material_id = m.id ORDER BY v.version_number DESC LIMIT 1)
          ORDER BY score DESC LIMIT $3`,
        [value, courseId, limit, boost]);
      return result.rows;
    } catch {
      return [];
    }
  }

  // The library is searched several ways at once: all keywords (broad) plus
  // each exact case name / section / quoted phrase (precise, ranked higher).
  async function libraryExcerpts(query, { courseId = null, limit = 6, maxChars = 14_000 } = {}) {
    const terms = librarySearchTerms(query);
    const phrases = libraryPhrases(query);
    if (!terms.length && !phrases.length) return [];
    const runs = [];
    if (terms.length) runs.push(librarySearch("to_tsquery", terms.join(" | "), courseId, limit, 0));
    for (const phrase of phrases) runs.push(librarySearch("plainto_tsquery", phrase, courseId, Math.min(limit, 4), 1));
    const merged = new Map();
    for (const row of (await Promise.all(runs)).flat()) {
      const key = `${row.material_id}|${row.page_number}|${String(row.content).slice(0, 120)}`;
      const previous = merged.get(key);
      if (!previous || Number(row.score) > Number(previous.score)) merged.set(key, row);
    }
    const picked = [];
    let used = 0;
    for (const row of [...merged.values()].sort((a, b) => Number(b.score) - Number(a.score)).slice(0, limit)) {
      const text = truncate(row.content, Math.max(0, Math.min(3_600, maxChars - used)));
      if (!text) break;
      used += text.length;
      picked.push({ ...row, content: text });
    }
    return picked;
  }

  async function materialText(materialId, maxChars = 12_000) {
    if (!materialId) return "";
    try {
      const result = await db.query(
        `SELECT chunk.page_number, chunk.content FROM material_chunks chunk
          WHERE chunk.material_id = $1
            AND chunk.version_id = (SELECT v.id FROM material_versions v WHERE v.material_id = $1 ORDER BY v.version_number DESC LIMIT 1)
          ORDER BY chunk.chunk_number LIMIT 8`, [materialId]);
      return truncate(result.rows.map((row) => `${row.page_number ? `[p. ${row.page_number}] ` : ""}${row.content}`).join("\n\n"), maxChars);
    } catch {
      return "";
    }
  }

  function libraryCite(row) {
    return `[Library: ${row.title}${row.page_number ? `, p. ${row.page_number}` : ""}]`;
  }

  function libraryBlock(excerpts) {
    if (!excerpts.length) return "";
    return `FIRE COUNSEL LIBRARY (course materials uploaded by the administrators). Use these where relevant and cite them as [Library: title, p. N]:\n${excerpts.map((row) => `#### ${libraryCite(row)} (${TYPE_LABEL[row.material_type] || "material"})\n${row.content}`).join("\n\n")}`;
  }

  function courseLabel(course) {
    return [course.course_code, course.title, course.short_name || course.university].filter(Boolean).join(" · ");
  }

  async function detectCourse(text, attachments, courses) {
    const catalogue = courses.map((c) => `- id=${c.id} | ${courseLabel(c)}${c.academic_level ? ` | level ${c.academic_level}` : ""}${c.semester ? ` | ${c.semester}` : ""}${c.topics ? ` | topics: ${c.topics}` : ""}`).join("\n");
    const result = await gen({ json: true, system: DETECTOR, messages: [{ role: "user", text: `COURSES:\n${catalogue}\n\nMATERIAL / QUESTION:\n${truncate(text, 20000) || "(see attached files)"}`, attachments }], maxTokens: 1024, temperature: 0 });
    const parsed = parseJsonReply(result.text) || {};
    const ids = new Set(courses.map((c) => c.id));
    const confidence = Math.min(Math.max(Number(parsed.confidence) || 0, 0), 1);
    return {
      course_id: ids.has(parsed.course_id) ? parsed.course_id : null,
      confidence,
      reason: truncate(parsed.reason, 300),
      alternatives: (Array.isArray(parsed.alternatives) ? parsed.alternatives : []).filter((id) => ids.has(id)).slice(0, 3)
    };
  }

  // ---------------- modes ----------------

  // Chat must feel quick: web research and each writer model get short time
  // limits (a slow model is skipped for the next student, see providers.js).
  const CHAT_RESEARCH_MS = Math.min(Math.max(Number(env.AI_CHAT_RESEARCH_TIMEOUT_MS) || 60_000, 10_000), 240_000);
  const CHAT_WRITER_MS = Math.min(Math.max(Number(env.AI_CHAT_WRITER_TIMEOUT_MS) || 100_000, 10_000), 300_000);

  async function mockExam({ text, attachments = [], options = {}, onProgress = () => {} }) {
    const quiz = options.quiz || {};
    const count = clampInt(quiz.count, 1, 30, 10);
    const type = ["mcq", "essay", "mixed"].includes(quiz.type) ? quiz.type : "mcq";
    onProgress("library");
    const library = await libraryExcerpts(text || attachments.map((a) => a.name).join(" "), { courseId: options.courseId || null, limit: 4, maxChars: 8_000 });
    const brief = [
      `SET A MOCK EXAM: ${count} question(s); type: ${type === "mcq" ? "multiple-choice only" : type === "essay" ? "essay and problem questions only" : "a mix of multiple-choice and essay/problem questions"}.`,
      `TOPIC / STUDENT MATERIAL:\n${truncate(text, 40000) || "(see the attached files)"}`,
      library.length ? libraryBlock(library) : ""
    ].filter(Boolean).join("\n\n");
    onProgress("writing");
    const answer = await gen({ json: true, system: MOCK_SETTER, messages: [{ role: "user", text: brief, attachments }], maxTokens: 12000, temperature: 0.5, timeoutMs: CHAT_WRITER_MS });
    const parsed = normalizeQuiz(parseJsonReply(answer.text), { type, count, minutes: quiz.minutes ?? null });
    if (!parsed) throw new AiError(502, "Fire Counsel AI could not build the mock exam this time. Please send it again — this was not counted.", "QUIZ_FAILED");
    return {
      content: quizMarkdown(parsed),
      sources: [],
      provider: answer.provider, model: answer.model,
      meta: { task: "mock", quiz: parsed, library_passages: library.length, fallback: Boolean(answer.fallback) }
    };
  }

  async function chat({ history = [], text, attachments = [], options = {}, onProgress = () => {}, onPartial }) {
    if (options.task === "mock") return mockExam({ text, attachments, options, onProgress });
    const custom = await loadPrompt(db, "chat");
    const task = CHAT_TASKS[options.task] || null;
    let researchResult = null;
    let checked = [];
    const terms = termsFrom(text);
    // Library and web search run at the same time.
    onProgress(options.webSearch !== false ? "searching" : "library");
    const [library, webResult] = await Promise.all([
      libraryExcerpts(text || attachments.map((a) => a.name).join(" "), { courseId: options.courseId || null }),
      options.webSearch !== false ? research(`Student question${task ? ` (${task.label})` : ""}: ${text}`, attachments, { timeoutMs: CHAT_RESEARCH_MS, searchQuery: `${truncate(text || attachments.map((a) => a.name).join(" "), 300)} Nigeria law` }) : null
    ]);
    if (webResult) {
      researchResult = webResult;
      if (researchResult.ok && researchResult.sources.length) {
        onProgress("checking", `${researchResult.sources.length} sources`);
        checked = await verify(researchResult.sources, { terms, limit: 12 });
      }
    }
    const context = researchResult?.ok
      ? `\n\n---\nLIVE WEB RESEARCH NOTES (Google Search):\n${truncate(researchResult.notes, 20000)}\n\nCHECKED SOURCES (cite only these, as Markdown links):\n${sourceBlock(checked)}`
      : options.webSearch !== false ? "\n\n---\nLive web search was unavailable for this answer. Do not include URLs; tell the student the answer is not web-verified." : "";
    const libraryContext = library.length ? `\n\n---\n${libraryBlock(library)}` : "";
    const messages = [...history.slice(-12), { role: "user", text: `${text || "(see the attached files)"}${libraryContext}${context}`, attachments }];
    onProgress("writing");
    const system = composeSystem("chat", custom) + (task ? `\n\n${task.instruction}` : "");
    const answer = await gen({ system, messages, maxTokens: 8192, timeoutMs: CHAT_WRITER_MS, onText: onPartial });
    onProgress("finishing");
    return {
      content: answer.text + lengthNote(answer),
      sources: await finalSources(answer.text, checked, terms),
      provider: answer.provider, model: answer.model,
      meta: { task: task ? options.task : null, web_search: Boolean(researchResult?.ok), search_queries: researchResult?.queries || [], library_passages: library.length, fallback: Boolean(answer.fallback) }
    };
  }

  async function caseAnalysis({ history = [], text, attachments = [], options = {}, onProgress = () => {}, onPartial }) {
    const query = String(options.caseQuery || text || "").trim();
    let register = [];
    let subject = "";
    if (attachments.length) {
      onProgress("reading");
      const extraction = await gen({ json: true, system: EXTRACTOR, messages: [{ role: "user", text: `Extract every case and authority from the attached pages.${query ? ` Student note: ${query}` : ""}`, attachments }], maxTokens: 6000, temperature: 0 });
      const parsed = parseJsonReply(extraction.text) || {};
      subject = [parsed.subject, parsed.topic].filter(Boolean).join(" — ");
      register = (Array.isArray(parsed.cases) ? parsed.cases : []).filter((item) => item && typeof item.name === "string" && item.name.trim()).slice(0, 60);
    }
    if (!register.length && query) register = [{ name: query, citation: "", proposition: "" }];
    if (!register.length) throw new AiError(400, "Type a case name or citation, or upload the textbook pages that cite the cases.", "VALIDATION_ERROR");

    const limit = MAX_CASES(env);
    const selected = register.slice(0, limit);
    const remaining = register.slice(limit);
    // Several cases are researched at the same time (database, web, library).
    let finished = 0;
    onProgress("researching_case", selected.length > 1 ? `${Math.min(selected.length, researchParallel)} at the same time` : truncate(selected[0].name, 80));
    const perCase = await mapLimit(selected, researchParallel, async (item) => {
      const [found, r, passages] = await Promise.all([
        findCases(item.name),
        research(`Research this case/authority for a Nigerian law student${subject ? ` (subject: ${subject})` : ""}: ${item.name}${item.citation ? ` — citation as printed: ${item.citation}` : ""}${item.proposition ? `. The textbook cites it for: ${item.proposition}` : ""}.`, [], { searchQuery: `${item.name}${item.citation ? ` ${item.citation}` : ""} case judgment ratio` }),
        libraryExcerpts(item.name, { limit: 3, maxChars: 6_000 })
      ]);
      finished += 1;
      if (selected.length > 1) onProgress("researching_case", `${finished} of ${selected.length} done`);
      return { item, found, research: r, passages };
    });
    const records = [];
    const researched = [];
    const library = [];
    for (const { item, found, research: r, passages } of perCase) {
      records.push(...found.filter((row) => !records.some((existing) => existing.id === row.id)));
      researched.push({ item, research: r });
      for (const row of passages) {
        if (!library.some((existing) => existing.material_id === row.material_id && existing.page_number === row.page_number && existing.content === row.content)) library.push(row);
      }
    }
    const judgments = (await Promise.all(records.filter((r) => r.source_material_id).slice(0, 3)
      .map(async (row) => ({ name: row.case_name, text: await materialText(row.source_material_id, 12_000) })))).filter((j) => j.text);
    const terms = termsFrom(...selected.map((item) => item.name));
    const allSources = researched.flatMap(({ research: r }) => r.sources);
    onProgress("checking", `${allSources.length} sources`);
    const checked = await verify(allSources, { terms, limit: 30 });
    const custom = await loadPrompt(db, "case_research");
    const brief = [
      `STUDENT REQUEST:\n${query || "Analyse every case and authority in the attached pages."}`,
      subject ? `SUBJECT / TOPIC (from the uploaded material): ${subject}` : "",
      `EXTRACTION REGISTER (${register.length} case(s)/authorities):\n${register.map((item, i) => `${i + 1}. ${item.name}${item.citation ? ` | ${item.citation}` : ""}${item.page ? ` | page ${item.page}` : ""}${item.footnote ? ` | fn ${item.footnote}` : ""}${item.proposition ? ` | cited for: ${item.proposition}` : ""}${item.uncertain ? " | UNCONFIRMED reading" : ""}`).join("\n")}`,
      records.length ? `FIRE COUNSEL DATABASE RECORDS (entered by administrators; respect their verification_status):\n${records.map((row) => `#### ${row.case_name}\n${caseRecordText(row)}`).join("\n\n")}` : "FIRE COUNSEL DATABASE RECORDS: none matched.",
      judgments.length ? `JUDGMENT TEXT FROM THE FIRE COUNSEL LIBRARY (uploaded by administrators; quote it with page numbers as [Library: case name, p. N]):\n${judgments.map((j) => `#### ${j.name}\n${j.text}`).join("\n\n")}` : "",
      library.length ? libraryBlock(library) : "",
      `LIVE WEB RESEARCH NOTES PER CASE (Google Search):\n${researched.map(({ item, research: r }) => `#### ${item.name}\n${r.ok ? truncate(r.notes, 12000) : `Live web search failed (${r.error}). Mark this case UNVERIFIED and say no web source was obtained in this run.`}`).join("\n\n")}`,
      `CHECKED SOURCE LIST (server opened each link; cite only these):\n${sourceBlock(checked)}`,
      remaining.length ? `NOT PROCESSED IN THIS RUN (daily processing limit of ${limit} cases per run): ${remaining.map((item) => item.name).join("; ")}. Keep them in the register marked "pending — run again" and tell the student to send "continue" to process them.` : ""
    ].filter(Boolean).join("\n\n");
    const messages = [...history.slice(-4), { role: "user", text: brief, attachments }];
    onProgress("writing");
    const answer = await gen({ system: composeSystem("case_research", custom), messages, maxTokens: 32768, temperature: 0.2, onText: onPartial });
    return {
      content: answer.text + lengthNote(answer),
      sources: await finalSources(answer.text, checked, terms),
      provider: answer.provider, model: answer.model,
      meta: { cases: selected.map((item) => item.name), pending_cases: remaining.map((item) => item.name), database_matches: records.length, library_passages: library.length + judgments.length, web_search: researched.some(({ research: r }) => r.ok), fallback: Boolean(answer.fallback) }
    };
  }

  async function notes({ history = [], text, attachments = [], options = {}, onProgress = () => {}, onPartial }) {
    if (!attachments.length && String(text || "").trim().length < 200) {
      throw new AiError(400, "Upload your notes, textbook pages or photos, or paste at least a full paragraph of notes.", "VALIDATION_ERROR");
    }
    const courses = options.courseId ? await listCourses() : [];
    const course = courses.find((c) => c.id === options.courseId) || null;
    const questions = course ? await pastQuestions(course.id, 25) : [];
    let researchResult = null;
    let checked = [];
    const terms = termsFrom(options.topic || text);
    let library = [];
    if (options.allowResearch) {
      onProgress("searching");
      [researchResult, library] = await Promise.all([
        research(`Find authoritative sources for these study notes${options.topic ? ` on ${options.topic}` : ""}: ${truncate(text, 3000)}`, attachments, { searchQuery: `${options.topic || truncate(text, 200)} Nigerian law` }),
        libraryExcerpts(options.topic || text, { courseId: course?.id || null, limit: 6, maxChars: 12_000 })
      ]);
      if (researchResult.ok) checked = await verify(researchResult.sources, { terms, limit: 15 });
    }
    const custom = await loadPrompt(db, "exam_note");
    const brief = [
      `STUDENT REQUEST: Build exam-ready notes${options.topic ? ` on: ${options.topic}` : ""} from the supplied material.`,
      course ? `COURSE: ${courseLabel(course)}` : "COURSE: not specified (do not invent a course code).",
      `QUESTION BANK REQUESTED: ${options.questionBank ? "YES — include it at the front" : "NO"}`,
      `EXTERNAL RESEARCH AUTHORISED: ${options.allowResearch ? "YES — research notes below; label anything not from the student's material" : "NO — use only the supplied material"}`,
      text ? `STUDENT'S TYPED NOTES / LECTURER MATERIAL:\n${truncate(text, 60000)}` : "",
      questions.length ? `PAST EXAMINATION QUESTIONS SUPPLIED (from the FIRE COUNSEL database for this course):\n${formatProfile(questions).text}` : "PAST EXAMINATION PAPERS: none supplied — say so in that section; do not invent questions.",
      library.length ? libraryBlock(library) : "",
      researchResult?.ok ? `RESEARCH NOTES:\n${truncate(researchResult.notes, 15000)}\n\nCHECKED SOURCES:\n${sourceBlock(checked)}` : ""
    ].filter(Boolean).join("\n\n");
    onProgress("writing");
    const answer = await gen({ system: composeSystem("exam_note", custom), messages: [...history.slice(-4), { role: "user", text: brief, attachments }], maxTokens: 32768, temperature: 0.2, onText: onPartial });
    return {
      content: answer.text + lengthNote(answer),
      sources: checked.length || extractUrls(answer.text).length ? await finalSources(answer.text, checked, terms) : [],
      provider: answer.provider, model: answer.model,
      meta: { course: course ? { id: course.id, label: courseLabel(course) } : null, past_questions: questions.length, research: Boolean(researchResult?.ok), library_passages: library.length, fallback: Boolean(answer.fallback) }
    };
  }

  async function questionSet({ history = [], text, attachments = [], options = {}, onProgress = () => {}, onPartial }) {
    if (!attachments.length && String(text || "").trim().length < 20) {
      throw new AiError(400, "Paste your notes or a sample question, or upload your notes, so the AI knows what to set questions on.", "VALIDATION_ERROR");
    }
    const courses = await listCourses();
    let course = null;
    let detection = null;
    if (options.courseId && options.courseId !== "auto") {
      course = courses.find((c) => c.id === options.courseId) || null;
      if (!course) throw new AiError(400, "The selected course was not found.", "VALIDATION_ERROR");
    } else if (courses.length) {
      onProgress("detecting_course");
      detection = await detectCourse(text, attachments, courses);
      course = detection.course_id && detection.confidence >= 0.55 ? courses.find((c) => c.id === detection.course_id) : null;
      if (!course) {
        const candidates = [detection.course_id, ...detection.alternatives].filter(Boolean).map((id) => courses.find((c) => c.id === id)).filter(Boolean).slice(0, 3);
        return {
          needsCourse: true,
          content: `I could not tell for certain which course this material belongs to${detection.reason ? ` (${detection.reason})` : ""}. To avoid copying the wrong exam format, please choose the course and send again.${candidates.length ? `\n\nMost likely:\n${candidates.map((c) => `- ${courseLabel(c)}`).join("\n")}` : ""}`,
          sources: [], provider: null, model: null,
          meta: { needs_course: true, detection, candidates: candidates.map((c) => ({ id: c.id, label: courseLabel(c) })) }
        };
      }
    }
    const [questions, library] = await Promise.all([
      course ? pastQuestions(course.id, 30) : [],
      course ? libraryExcerpts(text, { courseId: course.id, limit: 4, maxChars: 8_000 }) : []
    ]);
    const profile = formatProfile(questions);
    const count = Math.min(Math.max(Number(options.count) || 0, 0), 20);
    const custom = await loadPrompt(db, "question_setter");
    const brief = [
      course ? `COURSE: ${courseLabel(course)}${detection ? ` (auto-detected, confidence ${Math.round(detection.confidence * 100)}%: ${detection.reason})` : " (chosen by the student)"}` : "COURSE: none in the database yet.",
      profile
        ? `PAST-QUESTION FORMAT PROFILE for this course: ${profile.papers} paper(s) (${profile.years.join(", ")}); about ${profile.questionsPerPaper} question(s) per paper; marks used: ${profile.marks.join(", ") || "not recorded"}; paper duration: ${profile.durations.map((d) => `${d} min`).join(", ") || "not recorded"}.\nCopy this format exactly (rubric/instructions, numbering, marks, time, essay vs problem mix, style and length of facts).\n\nPAST QUESTIONS FOR THIS COURSE (verbatim):\n${profile.text}`
        : "PAST QUESTIONS: none are stored for this course yet. Say so at the top, then use a standard Nigerian university law examination format and label it as a generic format.",
      count ? `NUMBER OF QUESTIONS REQUESTED: ${count}` : "NUMBER OF QUESTIONS: same as a typical paper above.",
      `STUDENT'S NOTES / SOURCE MATERIAL TO SET QUESTIONS FROM:\n${truncate(text, 60000) || "(see attached files)"}`,
      library.length ? `${libraryBlock(library)}\n(Use these course passages only to keep the questions within this course's syllabus.)` : ""
    ].filter(Boolean).join("\n\n");
    onProgress("writing");
    const answer = await gen({ system: composeSystem("question_setter", custom), messages: [...history.slice(-4), { role: "user", text: brief, attachments }], maxTokens: 24576, temperature: 0.5, onText: onPartial });
    return {
      content: answer.text + lengthNote(answer),
      sources: [],
      provider: answer.provider, model: answer.model,
      meta: { course: course ? { id: course.id, label: courseLabel(course) } : null, detection, past_questions: questions.length, library_passages: library.length, fallback: Boolean(answer.fallback) }
    };
  }

  async function extractText(attachment) {
    const result = await gen({
      system: "Transcribe the attached document faithfully as plain text. Preserve headings, paragraph breaks, footnote numbers and footnote text, case names and citations exactly as printed. Mark illegible parts as [illegible]. Do not summarise or add anything.",
      messages: [{ role: "user", text: "Transcribe this document.", attachments: [attachment] }],
      maxTokens: 32768, temperature: 0
    });
    return { text: result.text, provider: result.provider, model: result.model, truncated: result.truncated };
  }

  const modes = { chat, case: caseAnalysis, notes, questions: questionSet };
  return {
    run(mode, input) {
      const handler = modes[mode];
      if (!handler) throw new AiError(400, "Unknown AI mode.", "VALIDATION_ERROR");
      return handler(input);
    },
    listCourses,
    extractText,
    libraryExcerpts
  };
}

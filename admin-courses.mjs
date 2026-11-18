// Admin Studio → Courses. Add a new course or edit an existing one. Courses
// are saved in Neon (through the server's admin database API, which checks the
// Firebase admin claim on every call). Published courses appear on every
// student's "My courses" page and in the AI studio course list.
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
const NEW_UNIVERSITY = "__new__";

let authClient = null;
let verified = false;
let session = 0;
let courses = [];
let universities = [];
let searchTimer = null;

function setText(selector, text, kind = "") {
  const node = $(selector);
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}

async function api(path, options = {}) {
  const response = await authClient.apiRequest(path, options);
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || ([502, 503, 504].includes(response.status) ? "The server is waking up. Wait a minute and try again." : `Request failed (${response.status}).`));
    error.status = response.status;
    throw error;
  }
  return body;
}

function setEnabled(on) {
  for (const id of ["#course-add", "#course-refresh", "#course-save", "#course-search"]) {
    const node = $(id);
    if (node) node.disabled = !on;
  }
  setText("#courses-panel-status", on ? "LIVE · SAVED IN NEON" : "SIGN IN AS ADMIN", "");
}

function universityName(id) {
  return universities.find((u) => u.id === id)?.label || "";
}

function renderList() {
  const rows = $("#course-rows");
  if (!rows) return;
  if (!courses.length) {
    rows.innerHTML = `<tr><td colspan="4">No courses yet. Press <b>＋ Add a course</b> to create the first one.</td></tr>`;
    return;
  }
  rows.innerHTML = courses.map((course) => `<tr>
    <td><b>${escapeHTML(course.course_code || "—")}</b></td>
    <td>${escapeHTML(course.title)}<br><small>${escapeHTML([universityName(course.university_id), course.academic_level, course.semester, course.academic_session].filter(Boolean).join(" · "))}</small></td>
    <td><span class="fc-state" data-ok="${course.is_published === true}">${course.is_published === true ? "VISIBLE TO STUDENTS" : "HIDDEN"}</span></td>
    <td><button class="button button-light" type="button" data-edit-course="${escapeHTML(course.id)}">Edit</button></td>
  </tr>`).join("");
}

async function loadUniversities() {
  const body = await api("/api/v1/admin/database/options/universities?limit=200");
  universities = body.data || [];
  const select = $("#course-university");
  const current = select.value;
  select.innerHTML = universities.map((u) => `<option value="${escapeHTML(u.id)}">${escapeHTML(u.label)}</option>`).join("") + `<option value="${NEW_UNIVERSITY}">＋ Add a new university…</option>`;
  if (universities.some((u) => u.id === current)) select.value = current;
  else if (universities.length) select.value = universities[0].id;
  else select.value = NEW_UNIVERSITY;
  toggleNewUniversity();
}

async function loadCourses(mySession = session) {
  setText("#course-list-status", "Loading courses…", "");
  try {
    if (!universities.length) await loadUniversities();
    const q = $("#course-search").value.trim();
    const body = await api(`/api/v1/admin/database/courses?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    if (mySession !== session) return;
    courses = body.data || [];
    renderList();
    const total = body.pagination?.total ?? courses.length;
    const visible = courses.filter((c) => c.is_published === true).length;
    setText("#course-list-status", `${total} course${total === 1 ? "" : "s"} · ${visible} visible to students on this list.`, "ok");
  } catch (error) {
    if (mySession === session) setText("#course-list-status", error.message, "error");
  }
}

function toggleNewUniversity() {
  const isNew = $("#course-university").value === NEW_UNIVERSITY;
  $("#course-new-university-field").hidden = !isNew;
  $("#course-new-university").required = isNew;
}

function openForm(course = null) {
  const form = $("#course-form");
  form.hidden = false;
  form.dataset.id = course?.id || "";
  $("#course-form-title").textContent = course ? `Edit ${course.course_code || course.title}` : "Add a new course";
  $("#course-code").value = course?.course_code || "";
  $("#course-title").value = course?.title || "";
  $("#course-description").value = course?.description || "";
  $("#course-level").value = course?.academic_level || "";
  $("#course-semester").value = course?.semester || "";
  $("#course-session").value = course?.academic_session || "";
  $("#course-published").checked = course ? course.is_published === true : true;
  if (course?.university_id && universities.some((u) => u.id === course.university_id)) $("#course-university").value = course.university_id;
  toggleNewUniversity();
  setText("#course-form-status", "", "");
  $("#course-title").focus();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function createUniversity(name) {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 150) || "university";
  try {
    const body = await api("/api/v1/admin/database/universities", { method: "POST", body: JSON.stringify({ name, slug, country: "Nigeria", is_active: true }) });
    return body.data.id;
  } catch (error) {
    // The slug may already exist: try once more with a short suffix.
    if (error.status !== 409 && error.status !== 400) throw error;
    const body = await api("/api/v1/admin/database/universities", { method: "POST", body: JSON.stringify({ name, slug: `${slug}-${Date.now().toString(36).slice(-4)}`, country: "Nigeria", is_active: true }) });
    return body.data.id;
  }
}

$("#course-add")?.addEventListener("click", () => openForm(null));
$("#course-refresh")?.addEventListener("click", () => { universities = []; loadCourses(); });
$("#course-search")?.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadCourses(), 350); });
$("#course-university")?.addEventListener("change", toggleNewUniversity);
$("#course-cancel")?.addEventListener("click", () => { $("#course-form").hidden = true; });
$("#course-rows")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-edit-course]");
  if (!button) return;
  try {
    const body = await api(`/api/v1/admin/database/courses/${encodeURIComponent(button.dataset.editCourse)}`);
    openForm(body.data);
  } catch (error) { setText("#course-list-status", error.message, "error"); }
});

$("#course-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!verified) return;
  const id = $("#course-form").dataset.id;
  const optional = (selector) => $(selector).value.trim() || null;
  const save = $("#course-save");
  save.disabled = true;
  setText("#course-form-status", "Saving to the database…", "");
  try {
    let universityId = $("#course-university").value;
    if (universityId === NEW_UNIVERSITY) {
      const name = $("#course-new-university").value.trim();
      if (!name) throw new Error("Type the university name.");
      universityId = await createUniversity(name);
      universities = [];
      await loadUniversities();
      $("#course-university").value = universityId;
      toggleNewUniversity();
    }
    const record = {
      university_id: universityId,
      course_code: optional("#course-code"),
      title: $("#course-title").value.trim(),
      description: optional("#course-description"),
      academic_level: optional("#course-level"),
      semester: optional("#course-semester"),
      academic_session: optional("#course-session"),
      is_published: $("#course-published").checked
    };
    if (!record.title) throw new Error("Type the course title.");
    const body = await api(id ? `/api/v1/admin/database/courses/${encodeURIComponent(id)}` : "/api/v1/admin/database/courses", { method: id ? "PATCH" : "POST", body: JSON.stringify(record) });
    $("#course-form").dataset.id = body.data?.id || id;
    $("#course-form-title").textContent = `Edit ${record.course_code || record.title}`;
    setText("#course-form-status", record.is_published
      ? "Saved. Every student now sees this course on their “My courses” page and in the AI studio (it appears the next time their page loads or refreshes)."
      : "Saved as HIDDEN. Students will not see it until you tick “Show to all students”.", "ok");
    loadCourses();
  } catch (error) {
    setText("#course-form-status", error.message, "error");
  } finally {
    save.disabled = !verified;
  }
});

function onAdminState(state) {
  session += 1;
  verified = state === "verified" && Boolean(authClient);
  setEnabled(verified);
  if (!verified) return;
  universities = [];
  loadCourses(session);
}

document.addEventListener("fire-counsel:admin-state", (event) => onAdminState(event.detail?.state));
try {
  authClient = await import("./firebase/auth-client.mjs");
  onAdminState($("#admin-auth-status")?.dataset.state);
} catch { /* sign-in not configured: the panel stays disabled */ }

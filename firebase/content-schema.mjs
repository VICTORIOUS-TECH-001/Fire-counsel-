// Shared, dependency-free validation for public Firestore content:
//   siteContent/public  — browser preflight AND enforced admin API validation
//   studentPages/{uid}  — student-owned writes, independently checked by rules
//
// Homepage browser writes are denied: full 12-slide validation exceeds the
// Firestore rule expression budget. The protected API uses this same module,
// owns metadata and writes with the Admin SDK. Keep student-page limits in
// sync with firebase/firestore.rules; schema, API and emulator tests cover both.

export const SITE_CONTENT_LIMITS = Object.freeze({
  MAX_SLIDES: 12,
  MAX_NAVIGATION: 8,
  SHORT_TEXT: 120,      // eyebrow, title, accent, brand name
  LABEL: 60,            // button and navigation labels
  LONG_TEXT: 600,       // slide body copy
  ALT_TEXT: 200,        // image alt text and credits
  LINK: 300,
  IMAGE: 2048,
  // Generic deep caps enforced by both browser preflight and the API
  // (learning, caseNotes, articles, resources, footer, quickFacts, workspace).
  DEEP_STRING: 2000,
  DEEP_LIST: 40,
  DEEP_DEPTH: 8,
  DOCUMENT_CHARS: 200000
});

export const STUDENT_PAGE_LIMITS = Object.freeze({
  DISPLAY_NAME: 120,
  HEADLINE: 160,
  BIO: 2000,
  MAX_LINKS: 5,
  LINK_URL: 300,
  MAX_FOCUS_AREAS: 8,
  FOCUS_AREA: 40
});

// The homepage renderer (site.js photo()) only draws images from these three
// origins: bundled assets, Neon-hosted admin uploads, and the reviewed
// Firebase Storage slides folder of the fire-counsel bucket.
// The object name is fully URL-encoded in a download URL: site/slides/x.jpg
// appears as site%2Fslides%2Fx.jpg. The filename itself must not carry %2F, but
// Google Cloud Storage object names are literal (never path-traversed), so the
// prefix match above is what confines images to the reviewed slides folder.
const IMAGE_PATTERN = /^(?:\.?\/)?assets\/[\w./-]+\.(?:png|jpe?g|webp)$|^\/media\/[0-9a-f-]{36}\.(?:png|jpg|webp)$|^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/fire-counsel\.firebasestorage\.app\/o\/site%2Fslides%2F[\w.%-]+\.(?:png|jpe?g|webp)(?:\?alt=media(?:&token=[\w-]+)?)?$/i;
const LINK_PATTERN = /^(?:\.\/|\/|#)[^\s"<>]*$|^https:\/\/[^\s"<>]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Multi-line fields (the bio textarea) keep tab, \n and \r.
const CONTROL_CHARS_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const SITE_CONTENT_KEYS = Object.freeze(["brand", "navigation", "hero", "quickFacts", "learning", "caseNotes", "articles", "resources", "footer"]);
export const SITE_CONTENT_OPTIONAL_KEYS = Object.freeze(["workspace"]);
export const SLIDE_KEYS = Object.freeze(["eyebrow", "title", "accent", "body", "image", "imageAlt", "imageCredit", "primaryLabel", "primaryHref", "secondaryLabel", "secondaryHref"]);
export const STUDENT_PAGE_KEYS = Object.freeze(["displayName", "headline", "bio", "links", "focusAreas", "published", "createdAt", "updatedAt"]);

const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isText = (value, max) => typeof value === "string" && value.length <= max && !CONTROL_CHARS.test(value);
const isSafeLink = value => isText(value, SITE_CONTENT_LIMITS.LINK) && LINK_PATTERN.test(value);
const isSafeImage = value => isText(value, SITE_CONTENT_LIMITS.IMAGE) && IMAGE_PATTERN.test(value);

function checkDeep(value, errors, path, depth) {
  if (depth > SITE_CONTENT_LIMITS.DEEP_DEPTH) { errors.push(`${path} is nested too deeply (max ${SITE_CONTENT_LIMITS.DEEP_DEPTH} levels).`); return; }
  if (typeof value === "string") {
    if (value.length > SITE_CONTENT_LIMITS.DEEP_STRING) errors.push(`${path} is longer than ${SITE_CONTENT_LIMITS.DEEP_STRING} characters.`);
    if (CONTROL_CHARS.test(value)) errors.push(`${path} contains control characters.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > SITE_CONTENT_LIMITS.DEEP_LIST) errors.push(`${path} has more than ${SITE_CONTENT_LIMITS.DEEP_LIST} entries.`);
    value.forEach((item, index) => checkDeep(item, errors, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) errors.push(`${path} has an unsupported property name "${key}".`);
      checkDeep(item, errors, `${path}.${key}`, depth + 1);
    }
  }
}

function checkSlide(slide, errors, path) {
  if (!isPlainObject(slide)) { errors.push(`${path} must be an object.`); return; }
  for (const key of Object.keys(slide)) {
    if (!SLIDE_KEYS.includes(key)) errors.push(`${path}.${key} is not a supported slide field.`);
  }
  for (const key of SLIDE_KEYS) {
    if (!(key in slide)) errors.push(`${path}.${key} is missing.`);
  }
  if (!isText(slide.eyebrow, SITE_CONTENT_LIMITS.SHORT_TEXT)) errors.push(`${path}.eyebrow must be text up to ${SITE_CONTENT_LIMITS.SHORT_TEXT} characters.`);
  if (!isText(slide.title, SITE_CONTENT_LIMITS.SHORT_TEXT) || !slide.title.trim()) errors.push(`${path}.title must be non-empty text up to ${SITE_CONTENT_LIMITS.SHORT_TEXT} characters.`);
  if (!isText(slide.accent, SITE_CONTENT_LIMITS.SHORT_TEXT)) errors.push(`${path}.accent must be text up to ${SITE_CONTENT_LIMITS.SHORT_TEXT} characters.`);
  if (!isText(slide.body, SITE_CONTENT_LIMITS.LONG_TEXT)) errors.push(`${path}.body must be text up to ${SITE_CONTENT_LIMITS.LONG_TEXT} characters.`);
  if (!isSafeImage(slide.image)) errors.push(`${path}.image must be a bundled asset, a /media/ upload, or a fire-counsel Storage slide URL.`);
  if (!isText(slide.imageAlt, SITE_CONTENT_LIMITS.ALT_TEXT)) errors.push(`${path}.imageAlt must be text up to ${SITE_CONTENT_LIMITS.ALT_TEXT} characters.`);
  if (!isText(slide.imageCredit, SITE_CONTENT_LIMITS.ALT_TEXT)) errors.push(`${path}.imageCredit must be text up to ${SITE_CONTENT_LIMITS.ALT_TEXT} characters.`);
  if (!isText(slide.primaryLabel, SITE_CONTENT_LIMITS.LABEL)) errors.push(`${path}.primaryLabel must be text up to ${SITE_CONTENT_LIMITS.LABEL} characters.`);
  if (!isSafeLink(slide.primaryHref)) errors.push(`${path}.primaryHref must be a site-relative or https link.`);
  if (!isText(slide.secondaryLabel, SITE_CONTENT_LIMITS.LABEL)) errors.push(`${path}.secondaryLabel must be text up to ${SITE_CONTENT_LIMITS.LABEL} characters.`);
  if (!isSafeLink(slide.secondaryHref)) errors.push(`${path}.secondaryHref must be a site-relative or https link.`);
}

// Validates the homepage content document (without its write metadata). The
// returned error list is complete and plain-language, so the admin editor can
// show the first failure directly.
export function validateSiteContent(content) {
  const errors = [];
  if (!isPlainObject(content)) return { ok: false, errors: ["Site content must be one JSON object."] };
  for (const key of Object.keys(content)) {
    if (!SITE_CONTENT_KEYS.includes(key) && !SITE_CONTENT_OPTIONAL_KEYS.includes(key)) errors.push(`"${key}" is not a supported top-level section.`);
  }
  for (const key of SITE_CONTENT_KEYS) {
    if (!(key in content)) errors.push(`The "${key}" section is missing.`);
  }
  if (errors.length) return { ok: false, errors };

  if (!isPlainObject(content.brand)) errors.push("brand must be an object.");
  else {
    const brandKeys = ["name", "tagline", "markImage", "markAlt"];
    for (const key of Object.keys(content.brand)) if (!brandKeys.includes(key)) errors.push(`brand.${key} is not a supported field.`);
    for (const key of brandKeys) if (!(key in content.brand)) errors.push(`brand.${key} is missing.`);
    if (!isText(content.brand.name, 80) || !content.brand.name.trim()) errors.push("brand.name must be non-empty text up to 80 characters.");
    if (!isText(content.brand.tagline, SITE_CONTENT_LIMITS.ALT_TEXT)) errors.push("brand.tagline must be text up to 200 characters.");
    if (!isSafeImage(content.brand.markImage)) errors.push("brand.markImage must be a bundled asset, a /media/ upload, or a fire-counsel Storage slide URL.");
    if (!isText(content.brand.markAlt, SITE_CONTENT_LIMITS.ALT_TEXT)) errors.push("brand.markAlt must be text up to 200 characters.");
  }

  if (!Array.isArray(content.navigation) || content.navigation.length < 1 || content.navigation.length > SITE_CONTENT_LIMITS.MAX_NAVIGATION) {
    errors.push(`navigation must be a list of 1 to ${SITE_CONTENT_LIMITS.MAX_NAVIGATION} items.`);
  } else {
    content.navigation.forEach((item, index) => {
      if (!isPlainObject(item) || Object.keys(item).some(key => !["label", "href"].includes(key)) || !isText(item.label, SITE_CONTENT_LIMITS.LABEL) || !item.label.trim() || !isSafeLink(item.href)) {
        errors.push(`navigation[${index}] needs a label up to ${SITE_CONTENT_LIMITS.LABEL} characters and a site-relative or https href.`);
      }
    });
  }

  if (!isPlainObject(content.hero)) errors.push("hero must be an object.");
  else {
    for (const key of Object.keys(content.hero)) if (!["slides", "autoplayMs", "copy"].includes(key)) errors.push(`hero.${key} is not a supported field.`);
    // Optional single-introduction copy, independent of the legacy slide
    // archive. Both the browser preflight and protected API enforce this shape.
    if ("copy" in content.hero) {
      const copy = content.hero.copy;
      if (!isPlainObject(copy) || Object.keys(copy).some(key => !["title", "tagline", "introduction"].includes(key))) {
        errors.push("hero.copy needs only title, tagline and introduction text.");
      } else {
        if (!isText(copy.title, SITE_CONTENT_LIMITS.SHORT_TEXT) || !copy.title.trim()) errors.push("hero.copy.title must be non-empty text up to 120 characters.");
        if (!isText(copy.tagline, SITE_CONTENT_LIMITS.SHORT_TEXT)) errors.push("hero.copy.tagline must be text up to 120 characters.");
        if (!isText(copy.introduction, SITE_CONTENT_LIMITS.LONG_TEXT)) errors.push("hero.copy.introduction must be text up to 600 characters.");
      }
    }
    if ("autoplayMs" in content.hero && !(Number.isFinite(content.hero.autoplayMs) && content.hero.autoplayMs >= 4000 && content.hero.autoplayMs <= 15000)) {
      errors.push("hero.autoplayMs must be a number between 4000 and 15000.");
    }
    if (!Array.isArray(content.hero.slides) || content.hero.slides.length < 1 || content.hero.slides.length > SITE_CONTENT_LIMITS.MAX_SLIDES) {
      errors.push(`Keep between 1 and ${SITE_CONTENT_LIMITS.MAX_SLIDES} homepage slides.`);
    } else {
      content.hero.slides.forEach((slide, index) => checkSlide(slide, errors, `hero.slides[${index}]`));
    }
  }

  if (!Array.isArray(content.quickFacts)) errors.push("quickFacts must be a list.");
  for (const key of ["learning", "caseNotes", "articles", "resources", "footer"]) {
    if (!isPlainObject(content[key])) errors.push(`${key} must be an object.`);
  }
  if ("workspace" in content && !isPlainObject(content.workspace)) errors.push("workspace must be an object.");
  // Deep safety caps for the shallowly-checked sections (text size, list size,
  // nesting depth) so a malformed editor import cannot create a huge document.
  for (const key of ["quickFacts", "learning", "caseNotes", "articles", "resources", "footer", ...SITE_CONTENT_OPTIONAL_KEYS]) {
    checkDeep(content[key], errors, key, 1);
    if (errors.length > 24) break;
  }
  try {
    if (JSON.stringify(content).length > SITE_CONTENT_LIMITS.DOCUMENT_CHARS) errors.push(`The whole document must stay under ${SITE_CONTENT_LIMITS.DOCUMENT_CHARS} characters.`);
  } catch { errors.push("Site content must be JSON-serializable."); }
  return { ok: errors.length === 0, errors };
}

// Firestore adds write metadata that the editor correctly cannot submit.
// Strip ONLY those two fields on reads; unknown sections must still fail.
export function siteContentFromDocument(document) {
  if (!isPlainObject(document)) return null;
  const { updatedAt: _updatedAt, updatedBy: _updatedBy, ...content } = document;
  return validateSiteContent(content).ok ? content : null;
}

// Normalizes editor input into the exact studentPages document shape. Hard
// failures (empty name, over-limit text, unsafe link) throw a plain-language
// Error; empty optional lines are dropped.
export function cleanStudentPage(input) {
  if (!isPlainObject(input)) throw new Error("The student page must be an object.");
  const displayName = String(input.displayName ?? "").trim().replace(/\s+/g, " ");
  if (!displayName || displayName.length > STUDENT_PAGE_LIMITS.DISPLAY_NAME || CONTROL_CHARS.test(displayName)) {
    throw new Error(`Add a display name from 1 to ${STUDENT_PAGE_LIMITS.DISPLAY_NAME} characters, without control characters.`);
  }
  const headline = String(input.headline ?? "").trim().replace(/\s+/g, " ");
  if (headline.length > STUDENT_PAGE_LIMITS.HEADLINE || CONTROL_CHARS.test(headline)) {
    throw new Error(`Keep the headline under ${STUDENT_PAGE_LIMITS.HEADLINE} characters.`);
  }
  const bio = String(input.bio ?? "").trim();
  if (bio.length > STUDENT_PAGE_LIMITS.BIO || CONTROL_CHARS_MULTILINE.test(bio)) {
    throw new Error(`Keep the bio under ${STUDENT_PAGE_LIMITS.BIO} characters, without control characters.`);
  }
  const links = (Array.isArray(input.links) ? input.links : [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)
    .map(value => {
      if (value.length > STUDENT_PAGE_LIMITS.LINK_URL) throw new Error(`Keep each link under ${STUDENT_PAGE_LIMITS.LINK_URL} characters.`);
      let url;
      try { url = new URL(value); } catch { throw new Error(`"${value.slice(0, 60)}" is not a valid link. Links must start with https://`); }
      if (url.protocol !== "https:" || url.username || url.password) throw new Error(`Only https:// links are allowed on a student page ("${url.hostname}" was not accepted).`);
      return url.href;
    });
  if (links.length > STUDENT_PAGE_LIMITS.MAX_LINKS) throw new Error(`Keep at most ${STUDENT_PAGE_LIMITS.MAX_LINKS} links.`);
  const focusAreas = (Array.isArray(input.focusAreas) ? input.focusAreas : [])
    .map(value => String(value ?? "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map(value => {
      if (value.length > STUDENT_PAGE_LIMITS.FOCUS_AREA || CONTROL_CHARS.test(value)) throw new Error(`Keep each focus area under ${STUDENT_PAGE_LIMITS.FOCUS_AREA} characters.`);
      return value;
    });
  if (focusAreas.length > STUDENT_PAGE_LIMITS.MAX_FOCUS_AREAS) throw new Error(`Keep at most ${STUDENT_PAGE_LIMITS.MAX_FOCUS_AREAS} focus areas.`);
  return {
    displayName,
    headline,
    bio,
    links,
    focusAreas,
    published: input.published === true
  };
}

// Read-side check for a stored page (the public viewer uses it before render).
// Accepts anything the security rules allow — unlike cleanStudentPage it does
// not require the normalized (trimmed) form.
export function validateStudentPage(page) {
  const errors = [];
  if (!isPlainObject(page)) return { ok: false, errors: ["The student page is not an object."] };
  if (!isText(page.displayName, STUDENT_PAGE_LIMITS.DISPLAY_NAME) || !page.displayName.trim()) errors.push("displayName must be non-empty text up to 120 characters.");
  if (!isText(page.headline ?? "", STUDENT_PAGE_LIMITS.HEADLINE)) errors.push(`headline must be text up to ${STUDENT_PAGE_LIMITS.HEADLINE} characters.`);
  if (typeof page.bio !== "string" || page.bio.length > STUDENT_PAGE_LIMITS.BIO || CONTROL_CHARS_MULTILINE.test(page.bio)) errors.push(`bio must be text up to ${STUDENT_PAGE_LIMITS.BIO} characters.`);
  if (typeof page.published !== "boolean") errors.push("published must be true or false.");
  if (!Array.isArray(page.links) || page.links.length > STUDENT_PAGE_LIMITS.MAX_LINKS) errors.push(`links must be a list of at most ${STUDENT_PAGE_LIMITS.MAX_LINKS}.`);
  else page.links.forEach((value, index) => {
    let https = false;
    try { https = typeof value === "string" && new URL(value).protocol === "https:"; } catch { /* invalid URL */ }
    if (!https || value.length > STUDENT_PAGE_LIMITS.LINK_URL || CONTROL_CHARS.test(value)) errors.push(`links[${index}] must be an https URL up to ${STUDENT_PAGE_LIMITS.LINK_URL} characters.`);
  });
  if (!Array.isArray(page.focusAreas) || page.focusAreas.length > STUDENT_PAGE_LIMITS.MAX_FOCUS_AREAS) errors.push(`focusAreas must be a list of at most ${STUDENT_PAGE_LIMITS.MAX_FOCUS_AREAS}.`);
  else page.focusAreas.forEach((value, index) => {
    if (!isText(value, STUDENT_PAGE_LIMITS.FOCUS_AREA) || !value.trim()) errors.push(`focusAreas[${index}] must be non-empty text up to ${STUDENT_PAGE_LIMITS.FOCUS_AREA} characters.`);
  });
  return { ok: errors.length === 0, errors };
}

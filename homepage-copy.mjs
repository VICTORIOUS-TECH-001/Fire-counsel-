// Shared plain-text homepage copy. Public rendering and the Admin Studio use
// the same static fallback; no slideshow, personal storage or network access.
import { DEFAULT_CASE_VIDEO_URL } from "./homepage-media.mjs";

export const DEFAULT_HERO_COPY = Object.freeze({
  title: "Fire Counsel",
  tagline: "Ignite your legal intelligence",
  introduction: "Fire Counsel is more than a place to learn the law. It is the intelligence behind your success, empowering you to master the law, unlock your potential and become one of tomorrow's great legal minds."
});
export const DEFAULT_AI_COPY = Object.freeze({
  title: "Study Smart with Fire Counsel AI",
  intro: "Your personal AI legal study companion. Understand complex legal principles, simplify difficult cases, test your knowledge, discover relevant authorities, and prepare confidently for your law theory examinations. Learn faster, think critically, and study with the intelligence you need to succeed.",
  closing: "Let Fire Counsel AI turn the way you study law into the way you master it.",
  buttonLabel: "Open Fire Counsel AI",
  chips: Object.freeze(["Hacks", "Clarity", "Legislation", "Statues", "Exam", "Cases"])
});
export { DEFAULT_CASE_VIDEO_URL };
const PREVIEWS = [
  { badge: "Your study, better organised.", labels: ["Your study", "Better organised", "Course choice", "Selected course", "Subjects", "One clear study space", "Personal notes", "Keep organised", "Exam practice", "A steady pace"] },
  { badge: "Your notes, on this device.", labels: ["PDFs", "Personal notes", "Saved on this device"] },
  { badge: "Build your own case cards.", labels: ["Case recall", "Your own question", "Your answer, ready to recall."] },
  { badge: "Practise at a steady pace.", labels: ["Focus timer", "Revision", "A steady pace"] }
];
const object = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function heroCopy(content) {
  // Older documents need no migration. Only the explicit single-introduction
  // fields can replace the owner's words; legacy slides are never rendered.
  const copy = object(content?.hero?.copy) ? content.hero.copy : DEFAULT_HERO_COPY;
  return {
    title: typeof copy.title === "string" && copy.title.trim() ? copy.title : DEFAULT_HERO_COPY.title,
    tagline: typeof copy.tagline === "string" ? copy.tagline : DEFAULT_HERO_COPY.tagline,
    introduction: typeof copy.introduction === "string" ? copy.introduction : DEFAULT_HERO_COPY.introduction
  };
}

export function aiCopy(content) {
  const copy = object(content?.aiSpotlight) ? content.aiSpotlight : {};
  return {
    ...Object.fromEntries(["title", "intro", "closing", "buttonLabel"].map(key => [key,
      typeof copy[key] === "string" && copy[key].trim() ? copy[key] : DEFAULT_AI_COPY[key]])),
    chips: DEFAULT_AI_COPY.chips.map((text, index) =>
      typeof copy.chips?.[index] === "string" && copy.chips[index].trim() ? copy.chips[index] : text)
  };
}

export function learningPreview(item, index) {
  const base = PREVIEWS[((index % 4) + 4) % 4];
  const preview = object(item?.preview) ? item.preview : {};
  const labels = Array.isArray(preview.labels) ? preview.labels : [];
  return {
    badge: typeof preview.badge === "string" ? preview.badge : base.badge,
    labels: base.labels.map((text, i) => typeof labels[i] === "string" ? labels[i] : text)
  };
}

// Known paths only: the structured editor cannot write prototype properties,
// brand artwork, auth settings or arbitrary other sections of the JSON draft.
export function updateHomepageCopy(content, path, value) {
  if (typeof value !== "string") throw new TypeError("Invalid copy value.");
  const result = structuredClone(content);
  if (path === "caseNotes.videoUrl" && object(result.caseNotes)) {
    // Preserve encoded object names exactly; validation runs on preview/publish.
    result.caseNotes.videoUrl = value.trim();
    return result;
  }
  const text = value.replace(/\s+/g, " ").trim();
  let match = /^hero\.copy\.(title|tagline|introduction)$/.exec(path);
  if (match) {
    result.hero.copy = { ...heroCopy(result), [match[1]]: text };
    return result;
  }
  match = /^aiSpotlight\.(title|intro|closing|buttonLabel|chips\.([0-5]))$/.exec(path);
  if (match) {
    const copy = aiCopy(result);
    if (match[2] !== undefined) copy.chips[Number(match[2])] = text;
    else copy[match[1]] = text;
    result.aiSpotlight = copy;
    return result;
  }
  match = /^learning\.(eyebrow|title|accent|intro|previewLabel)$/.exec(path);
  if (match && object(result.learning)) {
    result.learning[match[1]] = text;
    return result;
  }
  match = /^learning\.cards\.(\d+)\.(title|text|href|linkLabel|number|preview\.badge|preview\.labels\.(\d+))$/.exec(path);
  if (!match) throw new Error("Unsupported homepage copy field.");
  const index = Number(match[1]);
  const card = result.learning?.cards?.[index];
  if (!object(card) || index >= 40) throw new Error("Invalid study-tool index.");
  if (match[2].startsWith("preview.")) {
    const preview = object(card.preview) ? card.preview : {};
    if (match[2] === "preview.badge") preview.badge = text;
    else {
      const labels = learningPreview(card, index).labels;
      const label = Number(match[3]);
      if (label >= labels.length) throw new Error("Invalid preview-label index.");
      labels[label] = text;
      // Preserve any other existing draft properties and extra labels.
      preview.labels = labels.concat(Array.isArray(preview.labels) ? preview.labels.slice(labels.length) : []);
    }
    card.preview = preview;
  } else card[match[2]] = text;
  return result;
}

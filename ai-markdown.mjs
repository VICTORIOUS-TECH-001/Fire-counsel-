// Small, safe Markdown renderer for FIRE COUNSEL AI answers.
// All text is HTML-escaped first; only http(s)/mailto links are kept and they
// open in a new tab without referrer. No raw HTML from the AI is ever inserted.

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
}

export function safeHref(raw) {
  try {
    const url = new URL(String(raw || "").replace(/&amp;/g, "&"));
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function inline(text) {
  const codes = [];
  let out = escapeHTML(text).replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  // [label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, href) => {
    const safe = safeHref(href);
    return safe ? `<a href="${escapeHTML(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  // bare URLs not already inside a link
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (all, lead, url) => {
    const safe = safeHref(url);
    return safe ? `${lead}<a href="${escapeHTML(safe)}" target="_blank" rel="noopener noreferrer">${url}</a>` : all;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[\^([^\]\s]{1,24})\]/g, "<sup>[$1]</sup>")
    .replace(/\bTESTED\b:?[^<.;\n)]*/g, (match) => `<span class="ai-tested">${match}</span>`);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHTML(codes[Number(i)]).replace(/&amp;(?=[a-z#0-9]+;)/g, "&")}</code>`);
}

const isTableDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

export function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  const listStack = [];
  const closeLists = (depth = 0) => {
    while (listStack.length > depth) html.push(`</${listStack.pop().type}>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { closeLists(); i += 1; continue; }
    const fence = line.match(/^\s*```/);
    if (fence) {
      closeLists();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      html.push(`<pre><code>${escapeHTML(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeLists();
      const level = Math.min(heading[1].length + 1, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeLists(); html.push("<hr>"); i += 1; continue; }
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      closeLists();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      html.push(`<div class="ai-table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${head.map((_, c) => `<td>${inline(row[c] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      closeLists();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }
    const footnote = line.match(/^\[\^([^\]\s]{1,24})\]:\s*(.*)$/);
    if (footnote) {
      closeLists();
      html.push(`<p class="ai-footnote"><sup>[${escapeHTML(footnote[1])}]</sup> ${inline(footnote[2])}</p>`);
      i += 1;
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
    if (item) {
      const depth = Math.min(Math.floor(item[1].replace(/\t/g, "    ").length / 2), 4) + 1;
      const type = /\d/.test(item[2]) ? "ol" : "ul";
      while (listStack.length > depth) html.push(`</${listStack.pop().type}>`);
      if (listStack.length === depth && listStack[depth - 1].type !== type) html.push(`</${listStack.pop().type}>`);
      while (listStack.length < depth) {
        const start = type === "ol" ? Number.parseInt(item[2], 10) : 1;
        html.push(type === "ol" && start !== 1 ? `<ol start="${start}">` : `<${type}>`);
        listStack.push({ type });
      }
      const task = item[3].match(/^\[( |x|X)\]\s+(.*)$/);
      html.push(`<li>${task ? `${task[1] === " " ? "☐" : "☑"} ${inline(task[2])}` : inline(item[3])}</li>`);
      i += 1;
      continue;
    }
    closeLists();
    const paragraph = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*```|\s*([-*+]|\d{1,3}[.)])\s)/.test(lines[i]) && !(lines[i].includes("|") && isTableDivider(lines[i + 1] || ""))) paragraph.push(lines[i++]);
    html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
  }
  closeLists();
  return html.join("");
}

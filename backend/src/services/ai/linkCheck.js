// Verification-link checker. Every source link the AI returns is opened by the
// server before it is shown: broken or invented links are labelled, never
// presented as verified. Private/internal addresses are refused (SSRF guard).
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 600_000;
const URL_RE = /https?:\/\/[^\s<>()"'\]\[]+[^\s<>()"'\]\[.,;:!?]/gi;

export function extractUrls(text) {
  const found = new Set();
  for (const match of String(text || "").matchAll(URL_RE)) {
    const url = match[0].replace(/[)*_]+$/, "");
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") found.add(parsed.href);
    } catch { /* ignore */ }
  }
  return [...found];
}

function ipv4Private(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return ipv4Private(address);
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return ipv4Private(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

export async function assertPublicUrl(raw, lookup = dnsLookup) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
  if (url.username || url.password) throw new Error("credentials in URL");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("non-standard port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("internal host");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("private address");
  return url;
}

function pageText(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").toLowerCase();
}

async function readLimited(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (size < MAX_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return text;
}

// Words that identify a case/topic on a page (e.g. party names).
export function termsFrom(...values) {
  const stop = new Set(["the", "and", "of", "in", "re", "ltd", "limited", "plc", "nigeria", "state", "attorney", "general", "federal", "republic", "company", "case", "law", "court", "v", "vs"]);
  const terms = new Set();
  for (const value of values) {
    for (const part of String(value || "").split(/\s+(?:v\.?|vs\.?|versus|&|and)\s+/i)) {
      const words = part.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w.length > 3 && !stop.has(w.toLowerCase()));
      words.sort((a, b) => b.length - a.length);
      if (words[0]) terms.add(words[0].toLowerCase());
    }
  }
  return [...terms].slice(0, 8);
}

export async function checkLink(raw, { terms = [], fetchImpl = fetch, lookup = dnsLookup, timeoutMs = 9000 } = {}) {
  const result = { url: raw, final_url: null, status: "broken", http_status: null, page_title: null, mentions: false };
  let current = raw;
  try {
    for (let hop = 0; hop < 6; hop += 1) {
      const url = await assertPublicUrl(current, lookup);
      const response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; FIRE-COUNSEL-LinkCheck/1.0)", Accept: "text/html,application/pdf;q=0.9,*/*;q=0.5" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      result.http_status = response.status;
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        current = new URL(response.headers.get("location"), url).href;
        try { await response.body?.cancel(); } catch { /* ignore */ }
        continue;
      }
      result.final_url = url.href;
      if (response.status >= 400) {
        // Many legal sites block automated checks (401/403/429) but exist.
        result.status = [401, 403, 429].includes(response.status) ? "restricted" : "broken";
        try { await response.body?.cancel(); } catch { /* ignore */ }
        return result;
      }
      const type = response.headers.get("content-type") || "";
      if (type.includes("pdf")) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        result.status = "reachable";
        return result;
      }
      const html = await readLimited(response);
      const title = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i)?.[1];
      if (title) result.page_title = title.replace(/\s+/g, " ").trim();
      const text = pageText(html);
      result.mentions = terms.length > 0 && terms.some((term) => text.includes(term));
      result.status = result.mentions ? "verified" : "reachable";
      return result;
    }
    result.status = "broken";
    return result;
  } catch {
    return result;
  }
}

/** Check up to `limit` links in parallel batches. */
// Recently checked links (1 hour). Popular cases share the same sources, so a
// second student asking about the same case does not wait for the checks again.
const LINK_CACHE = new Map();
const LINK_CACHE_MS = 60 * 60_000;
export function clearLinkCache() { LINK_CACHE.clear(); }

export async function verifySources(sources, { terms = [], limit = 20, fetchImpl = fetch, lookup = dnsLookup, concurrency = 8, cache = fetchImpl === fetch } = {}) {
  const unique = [];
  const seen = new Set();
  for (const source of sources) {
    if (!source?.url || seen.has(source.url)) continue;
    seen.add(source.url);
    unique.push(source);
    if (unique.length >= limit) break;
  }
  const termsKey = terms.map((term) => String(term).toLowerCase()).sort().join(",");
  const checked = new Array(unique.length);
  let next = 0;
  // A small worker pool: a slow site no longer holds up a whole batch.
  async function worker() {
    while (next < unique.length) {
      const index = next++;
      const source = unique[index];
      const key = `${source.url}|${termsKey}`;
      const hit = cache ? LINK_CACHE.get(key) : null;
      let result;
      if (hit && hit.until > Date.now()) result = hit.result;
      else {
        result = await checkLink(source.url, { terms, fetchImpl, lookup });
        if (cache && result.status !== "broken") {
          if (LINK_CACHE.size > 2000) LINK_CACHE.delete(LINK_CACHE.keys().next().value);
          LINK_CACHE.set(key, { until: Date.now() + LINK_CACHE_MS, result });
        }
      }
      checked[index] = {
        url: result.final_url || source.url,
        title: (source.title || result.page_title || "").slice(0, 300),
        origin: source.origin || "answer",
        status: result.status,
        http_status: result.http_status
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return checked;
}

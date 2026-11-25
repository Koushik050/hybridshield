import { detectorModel } from "./firebase";

export type Finding = { start: number; end: number; value: string; type: string; source: "rules" | "nano" };
export type VaultEntry = { placeholder: string; value: string; type: string; source: "rules" | "nano" };
/** A piece of the original message; hidden pieces carry their placeholder. */
export type Segment = { text: string; placeholder?: string; type?: string };

// Deterministic rules for details with a fixed shape. Order matters: earlier rules win overlaps.
const RULES: { type: string; re: RegExp }[] = [
  { type: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: "CARD", re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?:[ -]?\d{1,3})?\b/g },
  { type: "AADHAAR", re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { type: "PHONE", re: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g },
  { type: "PHONE", re: /\+\d{1,3}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}\b/g },
  { type: "PAN", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { type: "CARD", re: /(?<=\b(?:ending(?: in| with)?|ends in|last (?:4|four)(?: digits)?)[:\s]*)\d{4}\b/gi },
];

const ALLOWED_TYPES = ["PERSON", "ADDRESS", "HEALTH", "DOB", "ID", "EMAIL", "PHONE", "ACCOUNT"];

export function detectWithRules(text: string): Finding[] {
  const out: Finding[] = [];
  for (const { type, re } of RULES) {
    for (const m of text.matchAll(re)) {
      out.push({ start: m.index!, end: m.index! + m[0].length, value: m[0], type, source: "rules" });
    }
  }
  return out;
}

const DETECT_PROMPT = `Find personal or sensitive information about people in the text below.
Include: people's names, street addresses, health or medical details, dates of birth, ID or account numbers, emails, phone numbers.
Do NOT include: order numbers, prices, amounts, product names, company names, dates of events.
Copy each item exactly as it appears in the text, character for character.
Use one of these types: ${ALLOWED_TYPES.join(", ")}.

Text:
"""
`;

/** Runs Gemini Nano on-device. Throws if on-device AI is unavailable. */
export async function detectWithNano(text: string): Promise<Finding[]> {
  const result = await detectorModel.generateContent(DETECT_PROMPT + text + '\n"""');
  const raw = result.response.text();
  let items: { text?: string; type?: string }[] = [];
  try {
    items = JSON.parse(raw).items ?? [];
  } catch {
    console.warn("Could not parse Nano output", raw);
    return [];
  }
  const out: Finding[] = [];
  for (const item of items) {
    const value = (item.text ?? "").trim();
    if (value.length < 2) continue;
    const type = ALLOWED_TYPES.includes((item.type ?? "").toUpperCase()) ? item.type!.toUpperCase() : "PRIVATE";
    // Only trust items that really appear in the text (guards against made-up output).
    let from = 0;
    let idx: number;
    while ((idx = text.indexOf(value, from)) !== -1) {
      out.push({ start: idx, end: idx + value.length, value, type, source: "nano" });
      from = idx + value.length;
    }
  }
  return out;
}

/** Removes overlapping findings. Rules win over Nano; longer wins over shorter. */
function resolveOverlaps(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort(
    (a, b) =>
      (a.source === b.source ? 0 : a.source === "rules" ? -1 : 1) ||
      b.end - b.start - (a.end - a.start),
  );
  const kept: Finding[] = [];
  for (const f of sorted) {
    if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Replaces findings with placeholders like [PERSON_1]. The same value always gets the same placeholder. */
export function redact(text: string, findings: Finding[]) {
  const kept = resolveOverlaps(findings);
  const byValue = new Map<string, VaultEntry>();
  const counters: Record<string, number> = {};
  for (const f of kept) {
    if (byValue.has(f.value)) continue;
    counters[f.type] = (counters[f.type] ?? 0) + 1;
    byValue.set(f.value, {
      placeholder: `[${f.type}_${counters[f.type]}]`,
      value: f.value,
      type: f.type,
      source: f.source,
    });
  }
  let redacted = "";
  let cursor = 0;
  const segments: Segment[] = [];
  for (const f of kept) {
    const entry = byValue.get(f.value)!;
    if (f.start > cursor) segments.push({ text: text.slice(cursor, f.start) });
    segments.push({ text: f.value, placeholder: entry.placeholder, type: f.type });
    redacted += text.slice(cursor, f.start) + entry.placeholder;
    cursor = f.end;
  }
  redacted += text.slice(cursor);
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return { redacted, vault: [...byValue.values()], segments };
}

/** Same as restore(), but returns pieces so restored details can be shown differently. */
export function restoreToSegments(text: string, vault: VaultEntry[]): Segment[] {
  const map = new Map(vault.map((v) => [v.placeholder, v]));
  const cleaned = text
    .replace(/\[[A-Z]+_\d+\]/g, (ph) => (map.has(ph) ? ph : ""))
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
  const out: Segment[] = [];
  let last = 0;
  for (const m of cleaned.matchAll(/\[[A-Z]+_\d+\]/g)) {
    const v = map.get(m[0])!;
    if (m.index! > last) out.push({ text: cleaned.slice(last, m.index) });
    out.push({ text: v.value, placeholder: m[0], type: v.type });
    last = m.index! + m[0].length;
  }
  if (last < cleaned.length) out.push({ text: cleaned.slice(last) });
  return out;
}

/** Puts the real details back. Runs only in the browser. */
export function restore(text: string, vault: VaultEntry[]) {
  const map = new Map(vault.map((v) => [v.placeholder, v.value]));
  // Placeholders the AI made up (not in the vault) are removed, then spacing is tidied.
  return text
    .replace(/\[[A-Z]+_\d+\]/g, (ph) => map.get(ph) ?? "")
    .replace(/[ \t]+([,.!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

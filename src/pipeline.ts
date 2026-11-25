import { heavyWriter, lightWriter } from "./firebase";
import { detectWithNano, detectWithRules, redact, restore, restoreToSegments, type Segment, type VaultEntry } from "./redact";

export type Task = { id: string; label: string; weight: "light" | "heavy"; instruction: string };

export const TASKS: Task[] = [
  {
    id: "reply",
    label: "Draft a reply to the customer",
    weight: "heavy",
    instruction:
      "Write a warm, professional reply to the customer described in the text. Apologise where appropriate and state the next steps clearly.",
  },
  {
    id: "summary",
    label: "Summarize for my team",
    weight: "heavy",
    instruction: "Summarize the text in 3 short bullet points for a support team handover.",
  },
  {
    id: "grammar",
    label: "Fix grammar and spelling",
    weight: "light",
    instruction: "Fix grammar and spelling. Keep the meaning and tone. Return only the corrected text.",
  },
  {
    id: "polite",
    label: "Make it more polite",
    weight: "light",
    instruction: "Rewrite the text to sound more polite and friendly. Return only the rewritten text.",
  },
];

/** Light tasks on short text stay on-device; everything else prefers the cloud. */
export const SHORT_TEXT_LIMIT = 1200;

export type RunResult = {
  detection: "nano+rules" | "rules";
  detectionNote?: string;
  vault: VaultEntry[];
  segments: Segment[];
  redacted: string;
  route: { preferred: "device" | "cloud"; reason: string };
  ranOn: "device" | "cloud" | "unknown";
  modelOutput: string;
  finalText: string;
  replySegments: Segment[];
  ms: { detect: number; generate: number };
};

const WRITER_RULES = `Personal details in the text were replaced with placeholders such as [PERSON_1], [EMAIL_1] or [PHONE_1].
Keep every placeholder exactly as written, including the square brackets and number.
Only use placeholders that already appear in the text. Never create new placeholders.
If no name placeholder is given, use a neutral greeting such as "Hello".
Never invent names, emails, phone numbers or other personal details.
The placeholders describe the customer, not the company. Never present them as the company's own contact details.
Write plain text only: no Markdown, no asterisks, no # headings.
Reply with the result only.`;

/** Removes Markdown the model may still add, so the result can be pasted anywhere. */
function toPlainText(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*]\s+/gm, "- ");
}

export type Phase = "scanning" | "writing";

export type Preview = Pick<RunResult, "segments" | "vault" | "redacted" | "detection" | "detectionNote"> & {
  preferred: "device" | "cloud";
  detectMs: number;
};

export type Hooks = {
  onPhase?: (p: Phase) => void;
  /** Called as soon as details are hidden, before the AI writes. */
  onRedacted?: (p: Preview) => void;
};

export async function runPipeline(text: string, task: Task, useNano: boolean, hooks: Hooks = {}): Promise<RunResult> {
  const onPhase = hooks.onPhase ?? (() => {});
  // Step 1-2: find and hide personal details, on this computer.
  onPhase("scanning");
  const t0 = performance.now();
  let findings = detectWithRules(text);
  let detection: RunResult["detection"] = "rules";
  let detectionNote: string | undefined;
  if (useNano) {
    try {
      findings = findings.concat(await detectWithNano(text));
      detection = "nano+rules";
    } catch (e) {
      detectionNote = "Gemini Nano was not available, so only pattern rules were used.";
      console.warn("On-device detection failed", e);
    }
  } else {
    detectionNote = "Gemini Nano is not ready on this computer, so only pattern rules were used.";
  }
  const { redacted, vault, segments } = redact(text, findings);
  const t1 = performance.now();
  onPhase("writing");

  // Step 3: choose where to run.
  const short = redacted.length <= SHORT_TEXT_LIMIT;
  const preferred: "device" | "cloud" = task.weight === "light" && short ? "device" : "cloud";
  const reason =
    preferred === "device"
      ? "Light task on short text, so it stays on your computer."
      : task.weight === "heavy"
        ? "This task needs the stronger cloud model. Only the redacted text is sent."
        : `Text is longer than ${SHORT_TEXT_LIMIT} characters, so the cloud model handles it. Only the redacted text is sent.`;
  hooks.onRedacted?.({
    segments, vault, redacted, detection, detectionNote, preferred, detectMs: Math.round(t1 - t0),
  });

  // Step 4: run the task on the redacted text.
  const prompt = `${WRITER_RULES}\n\nTask: ${task.instruction}\n\nText:\n"""\n${redacted}\n"""`;
  const model = preferred === "device" ? lightWriter : heavyWriter;
  const result = await model.generateContent(prompt);
  const modelOutput = toPlainText(result.response.text().trim());
  const src = String((result.response as any).inferenceSource ?? "").toLowerCase();
  const ranOn = src.includes("device") ? "device" : src.includes("cloud") ? "cloud" : "unknown";
  const t2 = performance.now();

  // Step 5: put the real details back, on this computer.
  const finalText = restore(modelOutput, vault);
  const replySegments = restoreToSegments(modelOutput, vault);

  return {
    detection,
    detectionNote,
    vault,
    segments,
    redacted,
    route: { preferred, reason },
    ranOn,
    modelOutput,
    finalText,
    replySegments,
    ms: { detect: Math.round(t1 - t0), generate: Math.round(t2 - t1) },
  };
}

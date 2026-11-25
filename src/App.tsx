import { useEffect, useMemo, useState } from "react";
import { getDeviceStatus, startDeviceModel, type DeviceStatus } from "./firebase";
import { runPipeline, TASKS, type Preview, type RunResult } from "./pipeline";
import type { Segment } from "./redact";

const SAMPLE = `Hi team, can someone reply to Priya Sharma? Her email is priya.s@gmail.com and phone +91 98480 12345. Her card ending 4421 was charged twice for ₹2,499 on order #A7781. She lives at 14 Lake View Road, Hyderabad and mentioned she is diabetic, so the refund for the glucose monitor is urgent.`;

const TYPE_LABEL: Record<string, string> = {
  PERSON: "Name", EMAIL: "Email", PHONE: "Phone", CARD: "Card", ADDRESS: "Address",
  HEALTH: "Health", AADHAAR: "Aadhaar", PAN: "PAN", IFSC: "IFSC", DOB: "Birth date",
  ID: "ID number", ACCOUNT: "Account", PRIVATE: "Private",
};

const SHORT_TASK: Record<string, string> = {
  reply: "Draft reply", summary: "Summarize", grammar: "Fix grammar", polite: "Make polite",
};

type Stage = "idle" | "scanning" | "writing" | "done";

export default function App() {
  const [text, setText] = useState(SAMPLE);
  const [taskId, setTaskId] = useState(TASKS[0].id);
  const [status, setStatus] = useState<DeviceStatus>("unavailable");
  const [progress, setProgress] = useState<number | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(true);
  const [copied, setCopied] = useState(false);
  const busy = stage === "scanning" || stage === "writing";
  const task = TASKS.find((t) => t.id === taskId)!;

  useEffect(() => {
    getDeviceStatus().then(setStatus);
  }, []);

  async function run() {
    if (busy || !text.trim()) return;
    setError(null);
    setCopied(false);
    setResult(null);
    setPreview(null);
    setEditing(false);
    setStage("scanning");
    startDeviceModel((pct) => {
      setProgress(pct);
      if (pct >= 100) getDeviceStatus().then(setStatus);
    });
    try {
      const current = await getDeviceStatus();
      setStatus(current);
      const r = await runPipeline(text, task, current === "available", {
        onRedacted: (p) => {
          setPreview(p);
          setStage("writing");
        },
      });
      setResult(r);
      setStage("done");
    } catch (e: any) {
      console.error(e);
      setError(explain(e));
      setStage("idle");
      setEditing(true);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.finalText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: text is still selectable */
    }
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of preview?.vault ?? []) m.set(v.type, (m.get(v.type) ?? 0) + 1);
    return [...m.entries()];
  }, [preview]);

  const ranOn = result?.ranOn ?? (preview ? preview.preferred : null);

  return (
    <div className="shell">
      {/* ---------- Top bar ---------- */}
      <header className="topbar">
        <div className="brand">
          <span className="logo"><IconShield /></span>
          <span className="brand-name">HybridShield</span>
          <span className="brand-sep" />
          <span className="brand-sub">Support workspace</span>
        </div>
        <DeviceChip status={status} progress={progress} />
      </header>

      <main className="layout">
        {/* ---------- Composer ---------- */}
        <div className="col-main">
          <section className="card composer">
            <div className="card-head">
              <div>
                <h1>New message</h1>
                <p className="sub">Paste a customer message. Personal details are protected on this device before any AI sees them.</p>
              </div>
            </div>

            <div className="segmented" role="radiogroup" aria-label="Task">
              {TASKS.map((t) => (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={t.id === taskId}
                  className={t.id === taskId ? "seg on" : "seg"}
                  onClick={() => setTaskId(t.id)}
                  disabled={busy}
                >
                  {SHORT_TASK[t.id] ?? t.label}
                  <span className={`seg-tag ${t.weight === "light" ? "tag-device" : "tag-cloud"}`}>
                    {t.weight === "light" ? "Device" : "Cloud"}
                  </span>
                </button>
              ))}
            </div>

            <div className={`editor ${stage === "scanning" ? "is-scanning" : ""}`}>
              {editing ? (
                <textarea
                  aria-label="Customer message"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && run()}
                  placeholder="Paste a customer message, ticket or internal note…"
                />
              ) : (
                <div className="doc" onDoubleClick={() => !busy && setEditing(true)}>
                  {preview ? <Protected segments={preview.segments} /> : text}
                </div>
              )}
            </div>

            <div className="composer-foot">
              <div className="foot-left">
                {preview ? (
                  <span className="protected-count">
                    <IconShieldCheck />
                    <b>{preview.vault.length}</b> {preview.vault.length === 1 ? "detail" : "details"} protected
                  </span>
                ) : (
                  <span className="muted small">
                    {task.weight === "light" ? "Runs on this device for short text." : "Uses the cloud model with details hidden."}
                    <kbd>Ctrl</kbd><kbd>Enter</kbd>
                  </span>
                )}
              </div>
              <div className="foot-right">
                {!editing && !busy && (
                  <button className="btn btn-secondary" onClick={() => setEditing(true)}>
                    <IconEdit /> Edit
                  </button>
                )}
                <button className="btn btn-primary" onClick={run} disabled={busy || !text.trim()}>
                  {busy ? <span className="spinner" /> : <IconShieldCheck />}
                  {stage === "scanning" ? "Protecting…" : stage === "writing" ? "Generating…" : "Protect & generate"}
                </button>
              </div>
            </div>
          </section>

          {error && (
            <div className="alert alert-error" role="alert">
              <b>Something went wrong.</b> {error}
            </div>
          )}

          {/* ---------- Result ---------- */}
          {(stage === "writing" || result) && (
            <section className="card result" aria-live="polite">
              <div className="card-head">
                <div>
                  <h2>{task.id === "summary" ? "Summary" : task.id === "reply" ? "Draft reply" : "Result"}</h2>
                  <p className="sub">
                    {result ? "Real details restored on this device. Ready to use." : "Writing with personal details hidden…"}
                  </p>
                </div>
                {result && (
                  <button className="btn btn-secondary" onClick={copy}>
                    {copied ? <IconCheck /> : <IconCopy />} {copied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
              {result ? (
                <div className="reply"><Restored segments={result.replySegments} /></div>
              ) : (
                <div className="skeleton" aria-hidden="true">
                  <span style={{ width: "92%" }} /><span style={{ width: "84%" }} /><span style={{ width: "88%" }} /><span style={{ width: "56%" }} />
                </div>
              )}
            </section>
          )}
        </div>

        {/* ---------- Privacy panel ---------- */}
        <aside className="col-side">
          <section className="card panel">
            <h3 className="panel-title">Privacy summary</h3>
            {preview ? (
              <>
                <div className="metric">
                  <span className="metric-num">{preview.vault.length}</span>
                  <span className="metric-label">personal details kept on this device</span>
                </div>
                {counts.length > 0 && (
                  <ul className="chips">
                    {counts.map(([type, n]) => (
                      <li key={type} className="chip">{TYPE_LABEL[type] ?? type}<span>{n}</span></li>
                    ))}
                  </ul>
                )}
                {preview.detectionNote && (
                  <div className="alert alert-warn small">
                    Gemini Nano isn't available here, so only pattern rules ran. Names and addresses may not be caught.
                  </div>
                )}
              </>
            ) : (
              <p className="muted small">Run a message to see what was protected.</p>
            )}
          </section>

          <section className="card panel">
            <h3 className="panel-title">Processing route</h3>
            <ol className="timeline">
              <Step
                state={stage === "scanning" ? "active" : preview ? "done" : "idle"}
                icon={<IconDevice />}
                title="Detect & protect"
                where="On this device"
                tone="device"
                meta={preview ? `${preview.detection === "nano+rules" ? "Gemini Nano + rules" : "Pattern rules"} · ${preview.detectMs} ms` : undefined}
              />
              <Step
                state={stage === "writing" ? "active" : result ? "done" : "idle"}
                icon={ranOn === "device" ? <IconDevice /> : <IconCloud />}
                title="Generate"
                where={ranOn === "device" ? "On this device · Gemini Nano" : ranOn ? "Cloud · Gemini" : "Device or cloud"}
                tone={ranOn === "device" ? "device" : "cloud"}
                meta={result ? `${result.ms.generate} ms` : undefined}
              />
              <Step
                state={result ? "done" : "idle"}
                icon={<IconDevice />}
                title="Restore details"
                where="On this device"
                tone="device"
              />
            </ol>
          </section>

          <section className="card panel">
            <h3 className="panel-title">
              What the cloud received
              {ranOn === "device" && result && <span className="pill pill-device">Nothing sent</span>}
              {ranOn === "cloud" && <span className="pill pill-cloud">Hidden text only</span>}
            </h3>
            {preview && ranOn !== "device" ? (
              <div className="sent"><Placeholders text={preview.redacted} /></div>
            ) : ranOn === "device" && result ? (
              <p className="muted small">This task ran entirely on your device. No text was sent to the cloud.</p>
            ) : (
              <p className="muted small">The cloud only ever receives placeholders like <span className="ph">[PERSON_1]</span>, never the real details.</p>
            )}
          </section>
        </aside>
      </main>

      <footer className="footer">
        Real details are held only in this tab's memory and are never stored or sent. Powered by Firebase AI Logic hybrid inference.
      </footer>
    </div>
  );
}

/* ---------- pieces ---------- */

function DeviceChip({ status, progress }: { status: DeviceStatus; progress: number | null }) {
  const map: Record<DeviceStatus, [string, string]> = {
    available: ["ok", "On-device AI ready"],
    downloadable: ["warn", "On-device AI not downloaded"],
    downloading: ["warn", "Downloading on-device AI"],
    unavailable: ["off", "On-device AI unavailable"],
  };
  const [tone, label] = map[status];
  return (
    <span className={`status status-${tone}`} title="Gemini Nano in Chrome">
      <span className="status-dot" />
      {label}
      {progress !== null && progress < 100 && <span className="tabular"> · {progress}%</span>}
    </span>
  );
}

function Protected({ segments }: { segments: Segment[] }) {
  let i = 0;
  return (
    <>
      {segments.map((s, k) =>
        s.placeholder ? (
          <span key={k} className="pii" style={{ ["--i" as any]: i++ }} title={`Sent to the AI as ${s.placeholder}`}>
            {s.text}
            <span className="pii-type">{TYPE_LABEL[s.type ?? ""] ?? "Private"}</span>
          </span>
        ) : (
          <span key={k}>{s.text}</span>
        ),
      )}
    </>
  );
}

function Restored({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, k) =>
        s.placeholder ? (
          <span key={k} className="restored" title={`Restored from ${s.placeholder}`}>{s.text}</span>
        ) : (
          <span key={k}>{s.text}</span>
        ),
      )}
    </>
  );
}

function Placeholders({ text }: { text: string }) {
  const parts = text.split(/(\[[A-Z]+_\d+\])/g);
  return <>{parts.map((p, i) => (/^\[[A-Z]+_\d+\]$/.test(p) ? <span key={i} className="ph">{p}</span> : <span key={i}>{p}</span>))}</>;
}

function Step(props: {
  state: "idle" | "active" | "done";
  icon: React.ReactNode;
  title: string;
  where: string;
  tone: "device" | "cloud";
  meta?: string;
}) {
  return (
    <li className={`step step-${props.state} tone-${props.tone}`}>
      <span className="step-icon">{props.state === "done" ? <IconCheck /> : props.state === "active" ? <span className="spinner" /> : props.icon}</span>
      <div className="step-body">
        <div className="step-title">{props.title}</div>
        <div className="step-where">{props.where}</div>
        {props.meta && <div className="step-meta">{props.meta}</div>}
      </div>
    </li>
  );
}

/* ---------- icons (inline, 16px, stroke) ---------- */
const I = (d: React.ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const IconShield = () => I(<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z" />);
const IconShieldCheck = () => I(<><path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>);
const IconCheck = () => I(<path d="m5 12 5 5L20 7" />);
const IconCopy = () => I(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>);
const IconEdit = () => I(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>);
const IconDevice = () => I(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>);
const IconCloud = () => I(<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 7 19h10.5Z" />);

function explain(e: any): string {
  const msg = String(e?.message ?? e);
  if (/app.?check/i.test(msg))
    return "This browser isn't verified yet. Add its App Check debug token in the Firebase console (App Check → Manage debug tokens), then try again.";
  if (/api key|permission|403|PERMISSION_DENIED/i.test(msg))
    return "Firebase refused the request. Check that AI Logic is turned on with the Gemini Developer API.";
  if (/network|fetch|offline/i.test(msg))
    return "Couldn't reach the cloud and no on-device model was available. Check your connection or turn on Gemini Nano in Chrome.";
  return msg;
}

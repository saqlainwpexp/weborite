import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, X, ArrowUp, Loader2, Play, AlertTriangle, SquarePen } from "lucide-react";
import { api } from "../lib/api";

/** One protocol step exchanged with /api/agent (mirrors the server's Step). */
type Step = { role: "user" | "assistant" | "observation"; text: string };
/** One bubble/card shown in the panel. */
type Msg =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "note"; text: string }
  | { kind: "did"; text: string };

interface Pending { tool: string; args: Record<string, unknown>; summary: string; danger: boolean }
interface AgentResponse { steps: Step[]; done: boolean; reply?: string; pending?: Pending; navigate?: string; error?: string }

const GREETING = "Hi! Tell me what to do and I'll handle it — for example “check the speed of example.com”, “add a mockup lead for acme.com”, or “find plumbers in Berlin”.";

export function AgentDock({ onOverlay }: { onOverlay?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<Msg[]>([{ kind: "note", text: GREETING }]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  useEffect(() => onOverlay?.(open), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [log, pending, busy]);

  function apply(res: AgentResponse) {
    setSteps(res.steps);
    if (res.pending) {
      setPending(res.pending);
      return;
    }
    setPending(null);
    if (res.reply) setLog((l) => [...l, { kind: "agent", text: res.reply! }]);
    if (res.navigate) {
      nav(res.navigate);
      setOpen(false);
    }
  }

  async function call(body: { steps: Step[]; approve?: boolean }) {
    setBusy(true);
    try {
      apply(await api<AgentResponse>("/api/agent", { method: "POST", json: body }));
    } catch (e) {
      setLog((l) => [...l, { kind: "note", text: (e as Error).message }]);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setLog((l) => [...l, { kind: "you", text }]);
    const next: Step[] = [...steps, { role: "user", text }];
    setSteps(next);
    void call({ steps: next });
  }

  function decide(approve: boolean) {
    if (!pending) return;
    setLog((l) => [...l, { kind: approve ? "did" : "note", text: approve ? pending.summary : `Skipped: ${pending.summary}` }]);
    setPending(null);
    void call({ steps, approve });
  }

  function reset() {
    setLog([{ kind: "note", text: GREETING }]);
    setSteps([]);
    setPending(null);
  }

  return (
    <>
      <button
        className={`agent-fab ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close assistant" : "Open assistant"}
        title="Assistant"
      >
        {open ? <X /> : <Bot />}
      </button>

      {open && (
        <div className="agent-panel" role="dialog" aria-label="Assistant">
          <header className="agent-head">
            <span className="agent-title"><Bot /> Assistant</span>
            <div className="agent-head-actions">
              <button type="button" onClick={reset} title="New conversation" aria-label="New conversation"><SquarePen /></button>
              <button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close"><X /></button>
            </div>
          </header>

          <div className="agent-log" ref={scroller}>
            {log.map((m, i) => (
              <div key={i} className={`agent-msg ${m.kind}`}>{m.text}</div>
            ))}

            {pending && (
              <div className={`agent-confirm ${pending.danger ? "danger" : ""}`}>
                {pending.danger && <div className="agent-warn"><AlertTriangle /> This affects a live site or deletes data.</div>}
                <p>{pending.summary}?</p>
                <div className="agent-confirm-actions">
                  <button className="btn btn-ink btn-sm" disabled={busy} onClick={() => decide(true)}><Play /> Run</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => decide(false)}>Skip</button>
                </div>
              </div>
            )}

            {busy && <div className="agent-msg agent"><Loader2 className="spin" /> Working…</div>}
          </div>

          <form
            className="agent-input"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Ask the assistant to do something…"
              disabled={busy}
            />
            <button type="submit" className="agent-send" disabled={busy || !input.trim()} aria-label="Send"><ArrowUp /></button>
          </form>
        </div>
      )}
    </>
  );
}

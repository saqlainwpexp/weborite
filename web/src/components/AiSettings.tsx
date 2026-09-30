import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Cpu, ExternalLink, KeyRound, Layers, Link2, Loader2, LogIn, Play, Save, Sparkles, Terminal, XCircle, Zap } from "lucide-react";
import type { AiModelKey, AiProvider, Settings as S } from "../../../shared/types";
import { api } from "../lib/api";

type Status = { claude: string | null; codex: string | null; gemini: string | null };
type Draft = Partial<S> & { openaiKey?: string; geminiKey?: string; openrouterKey?: string; compatibleKey?: string };

const PROVIDERS: { key: AiProvider; name: string; sub: string; icon: ReactNode }[] = [
  { key: "claude", name: "Claude", sub: "Claude plan, API key or cloud", icon: <Sparkles /> },
  { key: "openai", name: "ChatGPT / OpenAI", sub: "Sign in with ChatGPT, or API key", icon: <Zap /> },
  { key: "gemini", name: "Gemini", sub: "Sign in with Google, or API key", icon: <Sparkles /> },
  { key: "openrouter", name: "OpenRouter", sub: "One key, hundreds of models", icon: <Layers /> },
  { key: "compatible", name: "Other API", sub: "Groq, DeepSeek, Mistral, Ollama…", icon: <Link2 /> },
  { key: "custom", name: "Custom command", sub: "Any agent's command line", icon: <Terminal /> },
];

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="ai-field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

/** Settings → AI: which AI does the work, and how it signs in. Claude's own options stay below this (in Settings). */
export function AiProviderSettings({ settings, onSaved, children }: { settings: S; onSaved: () => void; children: ReactNode }) {
  const [d, setD] = useState<Draft>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loadStatus = () => api<Status>("/api/ai/status").then(setStatus).catch(() => undefined);
  useEffect(() => {
    void loadStatus();
  }, []);

  const v = <K extends keyof S>(k: K) => (d[k] ?? settings[k]) as S[K];
  const provider = settings.aiProvider ?? "claude";
  const models = (k: AiModelKey) => d.aiModels?.[k] ?? settings.aiModels?.[k] ?? { heavy: "", fast: "" };
  const setModel = (k: AiModelKey, which: "heavy" | "fast", val: string) =>
    setD({ ...d, aiModels: { ...settings.aiModels, ...d.aiModels, [k]: { ...models(k), [which]: val } } as S["aiModels"] });

  async function save(patch: Draft = d, note = "Saved") {
    setBusy("save");
    setMsg(null);
    try {
      await api("/api/settings", { method: "PUT", json: patch });
      setD({});
      setMsg({ ok: true, text: note });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  async function test() {
    setBusy("test");
    setMsg(null);
    try {
      if (Object.keys(d).length) await api("/api/settings", { method: "PUT", json: d });
      setD({});
      onSaved();
      const r = await api<{ ok: boolean; text: string; ms: number }>("/api/ai/test", { method: "POST" });
      setMsg({ ok: r.ok, text: r.ok ? `Connected: answered in ${(r.ms / 1000).toFixed(1)}s` : r.text });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }
  async function signIn(tool: "codex" | "gemini" | "claude") {
    setBusy("login");
    setMsg(null);
    try {
      const r = await api<{ command: string }>("/api/ai/login", { method: "POST", json: { tool } });
      setMsg({ ok: true, text: `A terminal opened running “${r.command}”. Finish signing in there (your browser opens), then press Test.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  const keyInput = (k: "openaiKey" | "geminiKey" | "openrouterKey" | "compatibleKey", set: boolean, ph: string) => (
    <input className="input mono" type="password" autoComplete="off" placeholder={set ? "•••••••• saved" : ph} value={d[k] ?? ""} onChange={(e) => setD({ ...d, [k]: e.target.value })} />
  );
  const modelFields = (k: AiModelKey, hint: string, ph: [string, string]) => (
    <div className="ai-grid">
      <Field label="Model for mockups and builds" hint={hint}><input className="input mono" value={models(k).heavy} placeholder={ph[0]} onChange={(e) => setModel(k, "heavy", e.target.value)} /></Field>
      <Field label="Model for diagnosis, QA and the rest"><input className="input mono" value={models(k).fast} placeholder={ph[1]} onChange={(e) => setModel(k, "fast", e.target.value)} /></Field>
    </div>
  );
  const cliState = (ver: string | null | undefined, name: string, install: string) => (
    <p className={`ai-state ${ver ? "ok" : "bad"}`}>{ver ? <CheckCircle2 /> : <XCircle />}{ver ? `${name} ${ver}` : <>{name} isn't installed. In a terminal: <code>{install}</code>, then restart the app.</>}</p>
  );
  const access = (k: "openaiAccess" | "geminiAccess", login: string) => (
    <div className="ai-access" role="radiogroup">
      {(["login", "api"] as const).map((a) => (
        <button key={a} type="button" role="radio" aria-checked={v(k) === a} className={`ai-chip${v(k) === a ? " on" : ""}`} onClick={() => void save({ [k]: a } as Draft, a === "login" ? `Using ${login}` : "Using an API key")}>
          {a === "login" ? <LogIn /> : <KeyRound />}{a === "login" ? login : "API key"}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <section className="set-section">
        <h3 className="set-title"><Cpu />AI provider</h3>
        <div className="set-body">
          <p className="muted" style={{ fontSize: 14, margin: 0 }}>Every AI step (mockups, diagnosis, builds, WordPress, SEO copy, proofreading) runs on the provider you pick. Mockup quality is tuned on Claude; others work, and results vary by model.</p>
          <div className="ai-providers" role="radiogroup" aria-label="AI provider">
            {PROVIDERS.map((p) => (
              <button key={p.key} type="button" role="radio" aria-checked={provider === p.key} className={`ai-provider${provider === p.key ? " on" : ""}`} onClick={() => void save({ aiProvider: p.key }, `Now using ${p.name}`)}>
                {p.icon}<b>{p.name}</b><small>{p.sub}</small>
              </button>
            ))}
          </div>
          {msg && <p className={`ai-state ${msg.ok ? "ok" : "bad"}`}>{msg.ok ? <CheckCircle2 /> : <XCircle />}{msg.text}</p>}
        </div>
      </section>

      {provider === "claude" && children}

      {provider === "openai" && (
        <section className="set-section">
          <h3 className="set-title"><Zap />ChatGPT / OpenAI</h3>
          <div className="set-body">
            {access("openaiAccess", "Sign in with ChatGPT")}
            {v("openaiAccess") === "login" ? (
              <>
                <p className="muted ai-p">Uses your ChatGPT plan (Plus, Pro, Business) through OpenAI's Codex command line, like Claude's session mode. Nothing is billed per token.</p>
                {cliState(status?.codex, "Codex CLI", "npm i -g @openai/codex")}
                <div className="ai-actions"><button type="button" className="btn btn-white btn-sm" disabled={!!busy || !status?.codex} onClick={() => void signIn("codex")}><LogIn />Sign in with ChatGPT</button></div>
                <div className="ai-grid"><Field label="Codex command" hint="Leave as codex unless it's installed somewhere custom"><input className="input mono" value={v("codexPath")} onChange={(e) => setD({ ...d, codexPath: e.target.value })} /></Field></div>
                {modelFields("openai-login", "Leave blank for Codex's default model", ["default", "default"])}
              </>
            ) : (
              <>
                <div className="ai-grid"><Field label="OpenAI API key" hint={<>From <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com <ExternalLink size={12} /></a>. Stored encrypted on this PC</>}>{keyInput("openaiKey", settings.openaiKeySet, "sk-…")}</Field></div>
                {modelFields("openai-api", "Any model your key can use", ["gpt-5", "gpt-5-mini"])}
              </>
            )}
          </div>
        </section>
      )}

      {provider === "gemini" && (
        <section className="set-section">
          <h3 className="set-title"><Sparkles />Gemini</h3>
          <div className="set-body">
            {access("geminiAccess", "Sign in with Google")}
            {v("geminiAccess") === "login" ? (
              <>
                <p className="muted ai-p">Uses your Google account (and Gemini plan) through Google's Gemini CLI. Antigravity has no command line the app can drive; its Gemini models are available here the same way.</p>
                {cliState(status?.gemini, "Gemini CLI", "npm i -g @google/gemini-cli")}
                <div className="ai-actions"><button type="button" className="btn btn-white btn-sm" disabled={!!busy || !status?.gemini} onClick={() => void signIn("gemini")}><LogIn />Sign in with Google</button><span className="muted">In the terminal, choose “Login with Google”.</span></div>
                <div className="ai-grid"><Field label="Gemini command" hint="Leave as gemini unless it's installed somewhere custom"><input className="input mono" value={v("geminiPath")} onChange={(e) => setD({ ...d, geminiPath: e.target.value })} /></Field></div>
                {modelFields("gemini-login", "Leave blank for Gemini CLI's default model", ["default", "default"])}
              </>
            ) : (
              <>
                <div className="ai-grid"><Field label="Gemini API key" hint={<>From <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio <ExternalLink size={12} /></a>. Stored encrypted on this PC</>}>{keyInput("geminiKey", settings.geminiKeySet, "AIza…")}</Field></div>
                {modelFields("gemini-api", "Any Gemini model your key can use", ["gemini-2.5-pro", "gemini-2.5-flash"])}
              </>
            )}
          </div>
        </section>
      )}

      {provider === "openrouter" && (
        <section className="set-section">
          <h3 className="set-title"><Layers />OpenRouter</h3>
          <div className="set-body">
            <p className="muted ai-p">One key for Claude, GPT, Gemini, Llama, DeepSeek, Qwen and more, billed by OpenRouter. Model names look like <code>openai/gpt-5</code>: see <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">openrouter.ai/models</a>. Web research uses OpenRouter's :online search.</p>
            <div className="ai-grid"><Field label="OpenRouter API key" hint="Stored encrypted on this PC">{keyInput("openrouterKey", settings.openrouterKeySet, "sk-or-…")}</Field></div>
            {modelFields("openrouter", "Pick models that accept images", ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"])}
          </div>
        </section>
      )}

      {provider === "compatible" && (
        <section className="set-section">
          <h3 className="set-title"><Link2 />OpenAI-compatible API</h3>
          <div className="set-body">
            <p className="muted ai-p">Any service with an OpenAI-style chat API. Examples: Groq <code>https://api.groq.com/openai/v1</code>, DeepSeek <code>https://api.deepseek.com/v1</code>, Mistral <code>https://api.mistral.ai/v1</code>, Together <code>https://api.together.xyz/v1</code>, Ollama on this PC <code>http://localhost:11434/v1</code>, LM Studio <code>http://localhost:1234/v1</code>. Web research isn't available here, and images need a vision model.</p>
            <div className="ai-grid">
              <Field label="API address"><input className="input mono" value={v("compatibleBaseUrl")} placeholder="https://api.example.com/v1" onChange={(e) => setD({ ...d, compatibleBaseUrl: e.target.value })} /></Field>
              <Field label="API key" hint="Leave empty for local models">{keyInput("compatibleKey", settings.compatibleKeySet, "optional")}</Field>
            </div>
            {modelFields("compatible", "The model names that service uses", ["e.g. llama-3.3-70b", "e.g. llama-3.1-8b"])}
          </div>
        </section>
      )}

      {provider === "custom" && (
        <section className="set-section">
          <h3 className="set-title"><Terminal />Custom command</h3>
          <div className="set-body">
            <p className="muted ai-p">For any other agent with a command line (signed in with its own account). The app runs the command in the lead's folder, sends the instructions on standard input and reads the answer from standard output. Image files are listed by path. <code>{"{model}"}</code> is replaced with the model below.</p>
            <div className="ai-grid"><Field label="Command" hint={<>For example <code>cursor-agent -p --output-format text</code> or <code>opencode run</code></>}><input className="input mono" value={v("customCommand")} placeholder="agent -p" onChange={(e) => setD({ ...d, customCommand: e.target.value })} /></Field></div>
            {modelFields("custom", "Optional: used where {model} appears", ["", ""])}
          </div>
        </section>
      )}

      <section className="set-section">
        <h3 className="set-title"><Layers />Parallel jobs</h3>
        <div className="set-body">
          <div className="ai-grid">
            <Field label="AI jobs at once" hint="Mockups, builds, WordPress pages and SEO jobs. More is faster, and uses your plan's limits sooner. 1–8.">
              <input className="input" type="number" min={1} max={8} value={String(v("parallelJobs") ?? 3)} onChange={(e) => setD({ ...d, parallelJobs: Number(e.target.value) })} />
            </Field>
            <Field label="Lead Finder searches at once" hint="Google Maps may start blocking with too many at once. 1–4.">
              <input className="input" type="number" min={1} max={4} value={String(v("parallelSearches") ?? 2)} onChange={(e) => setD({ ...d, parallelSearches: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="ai-actions">
            <button type="button" className="btn btn-ink btn-sm" disabled={!!busy || !Object.keys(d).length} onClick={() => void save()}>{busy === "save" ? <Loader2 className="spin" /> : <Save />}Save</button>
            <button type="button" className="btn btn-white btn-sm" disabled={!!busy} onClick={() => void test()}>{busy === "test" ? <Loader2 className="spin" /> : <Play />}Test the AI</button>
            <span className="muted">Test sends a one-line request to the provider above.</span>
          </div>
        </div>
      </section>
    </>
  );
}

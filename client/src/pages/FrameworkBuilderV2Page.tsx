import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, Loader2, CheckCircle2, XCircle, AlertTriangle, Save, Play, RotateCcw } from "lucide-react";
import { api } from "../lib/api";

type Stage = "intake" | "drafting" | "review" | "test-drive" | "saved";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChecklistItem {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

interface RobustnessGate {
  totalItems: number;
  passedItems: number;
  items: ChecklistItem[];
  ready: boolean;
  summaryForUser: string;
}

interface IntakeArtefact {
  topic?: string;
  topicTerm?: string;
  topicSynonyms?: string[];
  purpose?: string;
  subAreaStructure?: { type: "tcfd" | "custom"; categories: string[] };
  adjacentTopics?: Array<{ name: string; example_phrases?: string[] }>;
  anchorFrameworks?: Array<{ name: string; source?: string }>;
  sensitivityPreference?: "precision" | "recall" | "balanced";
  confirmed?: boolean;
}

interface Violation {
  measureId?: string;
  rule: string;
  severity: "error" | "warning";
  message: string;
  suggestion?: string;
}

interface Validation {
  passed: boolean;
  violations: Violation[];
}

interface TestDriveCandidate {
  name: string;
  ticker?: string;
  sector?: string;
  country?: string;
  rationale: string;
  isKnownDiscloser: boolean;
}

export default function FrameworkBuilderV2Page() {
  const [stage, setStage] = useState<Stage>("intake");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [intake, setIntake] = useState<IntakeArtefact | null>(null);
  const [robustnessGate, setRobustnessGate] = useState<RobustnessGate | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testDriveCompanies, setTestDriveCompanies] = useState<TestDriveCandidate[] | null>(null);
  const [savedFrameworkId, setSavedFrameworkId] = useState<number | null>(null);
  const [lastFailedUserMessage, setLastFailedUserMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Wrap the chat request in a manual fetch with an AbortController so we can
  // give a friendly timeout error, and let the user retry the same turn.
  async function callChatEndpoint(nextMessages: Message[], timeoutMs = 180_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("/api/framework-builder/v2/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({ messages: nextMessages, intake }),
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json();
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        throw new Error(
          "Request timed out after " + Math.round(timeoutMs / 1000) + "s. The model provider is slow right now; please retry.",
        );
      }
      if (typeof err?.message === "string" && err.message.toLowerCase().includes("failed to fetch")) {
        throw new Error(
          "Network error before response. Your connection may have dropped or the request was interrupted. Please retry \u2014 your conversation history is preserved.",
        );
      }
      throw err;
    }
  }

  async function sendMessage(text: string, isRetry = false) {
    if (!text.trim() || loading) return;
    setError(null);
    setLastFailedUserMessage(null);
    // On retry we do not append a fresh user turn — the message is already in state.
    const nextMessages: Message[] = isRetry
      ? messages
      : [...messages, { role: "user", content: text }];
    if (!isRetry) {
      setMessages(nextMessages);
      setInput("");
    }
    setLoading(true);
    try {
      const res = await callChatEndpoint(nextMessages);
      setMessages([...nextMessages, { role: "assistant", content: res.assistantMessage }]);
      if (res.intake) setIntake(res.intake);
      if (res.robustnessGate) setRobustnessGate(res.robustnessGate);
    } catch (err: any) {
      setError(err?.message || String(err));
      setLastFailedUserMessage(text);
    } finally {
      setLoading(false);
    }
  }

  function retryLast() {
    if (lastFailedUserMessage) {
      void sendMessage(lastFailedUserMessage, true);
    }
  }

  const [draftJobId, setDraftJobId] = useState<string | null>(null);
  const [draftJobStartTime, setDraftJobStartTime] = useState<number | null>(null);
  const [repairAttempts, setRepairAttempts] = useState<number>(0);
  const [truncationRecovered, setTruncationRecovered] = useState<boolean>(false);

  async function draftFramework() {
    if (!intake?.topicTerm) {
      setError("Intake not ready");
      return;
    }
    setError(null);
    setLoading(true);
    setStage("drafting");
    try {
      const confirmedIntake = { ...intake, confirmed: true };
      // Start an async draft job — the LLM call takes several minutes and
      // mobile browsers drop long-running fetch sockets. We poll instead.
      const startRes = await api.request("/framework-builder/v2/draft/start", {
        method: "POST",
        body: JSON.stringify({ intake: confirmedIntake }),
      });
      const jobId = startRes.jobId;
      setDraftJobId(jobId);
      setDraftJobStartTime(Date.now());
      // Poll every 5s for up to 15 minutes. Each poll is a fresh short-lived
      // request that survives socket drops.
      const deadline = Date.now() + 15 * 60_000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 5000));
        if (Date.now() > deadline) {
          throw new Error(
            "Draft still not finished after 15 minutes. You can try again \u2014 your intake is preserved. If this keeps happening the LLM provider may be down.",
          );
        }
        let status: any = null;
        try {
          status = await api.request(`/framework-builder/v2/draft/status/${jobId}`);
        } catch (pollErr: any) {
          // Transient poll error — do not abort; try again next tick.
          console.warn("draft-status poll transient error:", pollErr?.message || pollErr);
          continue;
        }
        if (status?.status === "succeeded" && status?.result) {
          setDraft(status.result.draft);
          setValidation(status.result.validation);
          if (typeof status.result.repairAttempts === "number") {
            setRepairAttempts(status.result.repairAttempts);
          }
          setTruncationRecovered(Boolean(status.result.truncationRecovered));
          setStage("review");
          setDraftJobId(null);
          break;
        }
        if (status?.status === "failed") {
          throw new Error(status.errorMessage || "Draft job failed");
        }
        // status === "running" or "pending": keep polling
      }
    } catch (err: any) {
      setError(err?.message || String(err));
      setStage("intake");
      setDraftJobId(null);
    } finally {
      setLoading(false);
    }
  }

  async function selectTestDriveSample() {
    if (!draft?.framework) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.request("/framework-builder/v2/test-drive/select", {
        method: "POST",
        body: JSON.stringify({
          frameworkName: draft.framework.name,
          topicTerm: draft.framework.topicTerm,
          topicSynonyms: draft.framework.topicSynonyms,
          sectorScope: draft.framework.sensitivityPreference || "agnostic",
        }),
      });
      setTestDriveCompanies(res.companies || []);
      setStage("test-drive");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function saveFramework(productionReady: boolean) {
    if (!draft || !intake) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.request("/framework-builder/v2/save", {
        method: "POST",
        body: JSON.stringify({
          draft,
          intake,
          testDriveSummary: null,
          testDriveWarnings: [],
          productionReady,
        }),
      });
      setSavedFrameworkId(res.frameworkId);
      setStage("saved");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStage("intake");
    setMessages([]);
    setInput("");
    setIntake(null);
    setRobustnessGate(null);
    setDraft(null);
    setValidation(null);
    setError(null);
    setTestDriveCompanies(null);
    setSavedFrameworkId(null);
  }

  const errorCount = validation?.violations.filter((v) => v.severity === "error").length || 0;
  const warningCount = validation?.violations.filter((v) => v.severity === "warning").length || 0;
  const measureCount = draft ? (draft.categories || []).reduce((sum: number, c: any) => sum + (c.measures?.length || 0), 0) : 0;

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Sparkles className="w-8 h-8 text-purple-500" />
            Framework Builder v2
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Correct-by-construction frameworks with C1–C10 rules, intake pushback, and test-drive validation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StageBadge current={stage} />
          {stage !== "intake" && (
            <button onClick={reset} className="px-3 py-2 text-sm bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg flex items-center gap-1">
              <RotateCcw className="w-4 h-4" /> Restart
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 flex items-start justify-between gap-3">
          <div>
            <strong>Error:</strong> {error}
          </div>
          {lastFailedUserMessage && (
            <button
              onClick={retryLast}
              disabled={loading}
              className="flex-shrink-0 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
            >
              Retry last turn
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Chat or draft review */}
        <div className="lg:col-span-2">
          {(stage === "intake" || stage === "drafting") && (
            <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm h-[70vh] flex flex-col">
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 && (
                  <div className="text-center text-gray-500 py-8">
                    <MessageBubble
                      role="assistant"
                      content={
                        "Welcome. Describe the framework you want to build. Include at minimum a topic sentence. If you have thought about the initial-input template (sections 1–5), paste that in your first message and I'll adapt the intake conversation to what you've already covered."
                      }
                    />
                  </div>
                )}
                {messages.map((m, i) => {
                  const isLastAssistant =
                    m.role === "assistant" && i === messages.length - 1 && !loading;
                  return (
                    <MessageBubble
                      key={i}
                      role={m.role}
                      content={m.content}
                      showOptions={isLastAssistant}
                      onSelectOption={(label) => sendMessage(label)}
                    />
                  );
                })}
                {loading && stage === "intake" && (
                  <div className="flex items-center gap-2 text-gray-500 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
                  </div>
                )}
                {loading && stage === "drafting" && (
                  <DraftingProgress startTime={draftJobStartTime} jobId={draftJobId} />
                )}
                <div ref={messagesEndRef} />
              </div>
              {stage === "intake" && (
                <div className="p-4 border-t dark:border-gray-700">
                  <div className="flex gap-2">
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          sendMessage(input);
                        }
                      }}
                      placeholder="Type your answer, or start with the topic and initial-input template contents…"
                      className="flex-1 p-3 border rounded-lg dark:bg-gray-700 dark:border-gray-600 resize-none"
                      rows={3}
                      disabled={loading}
                    />
                    <button
                      onClick={() => sendMessage(input)}
                      disabled={loading || !input.trim()}
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white rounded-lg self-end flex items-center gap-1"
                    >
                      <Send className="w-4 h-4" /> Send
                    </button>
                  </div>
                  {robustnessGate?.ready && (
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={draftFramework}
                        disabled={loading}
                        className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-1"
                      >
                        <Play className="w-4 h-4" /> Draft framework
                      </button>
                    </div>
                  )}
                  {!robustnessGate?.ready && robustnessGate && robustnessGate.passedItems >= 6 && (
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={draftFramework}
                        disabled={loading}
                        className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg flex items-center gap-1"
                        title="Proceed with residual warnings"
                      >
                        <AlertTriangle className="w-4 h-4" /> Proceed with warnings
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {stage === "review" && draft && (
            <DraftReview
              draft={draft}
              validation={validation}
              onSelectTestDrive={selectTestDriveSample}
              onSave={saveFramework}
              loading={loading}
              measureCount={measureCount}
              errorCount={errorCount}
              warningCount={warningCount}
              repairAttempts={repairAttempts}
              truncationRecovered={truncationRecovered}
            />
          )}

          {stage === "test-drive" && (
            <TestDriveReview
              companies={testDriveCompanies || []}
              onBack={() => setStage("review")}
              onSaveWithoutTestDrive={() => saveFramework(false)}
              loading={loading}
            />
          )}

          {stage === "saved" && savedFrameworkId && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-800 rounded-lg p-6">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
                <h2 className="text-xl font-semibold">Framework saved</h2>
              </div>
              <p>
                Framework ID <code>{savedFrameworkId}</code> saved to your workspace with <code>builder_version=v2</code>.
                It appears in your Frameworks list and can be used to score companies through the existing pipeline.
              </p>
              <div className="mt-4 flex gap-2">
                <button onClick={reset} className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg">
                  Build another
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right column: Robustness gate + intake summary */}
        <div className="lg:col-span-1">
          <RobustnessPanel gate={robustnessGate} intake={intake} />
        </div>
      </div>
    </div>
  );
}

function StageBadge({ current }: { current: Stage }) {
  const map: Record<Stage, { label: string; color: string }> = {
    intake: { label: "Stage: Intake", color: "bg-blue-100 text-blue-800" },
    drafting: { label: "Stage: Drafting", color: "bg-purple-100 text-purple-800" },
    review: { label: "Stage: Review", color: "bg-yellow-100 text-yellow-800" },
    "test-drive": { label: "Stage: Test-drive", color: "bg-orange-100 text-orange-800" },
    saved: { label: "Stage: Saved", color: "bg-green-100 text-green-800" },
  };
  const s = map[current];
  return <span className={`px-3 py-1 rounded-full text-xs font-medium ${s.color}`}>{s.label}</span>;
}

// Parse [[option:label]] markers out of assistant content.
// Returns { proseWithoutOptions, options }.
function parseOptions(content: string): { prose: string; options: string[] } {
  const re = /\[\[option:\s*([\s\S]*?)\]\]/g;
  const options: string[] = [];
  const prose = content.replace(re, (_m, label) => {
    const trimmed = String(label || "").trim();
    if (trimmed) options.push(trimmed);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { prose, options };
}

function MessageBubble({
  role,
  content,
  showOptions = false,
  onSelectOption,
}: {
  role: "user" | "assistant";
  content: string;
  showOptions?: boolean;
  onSelectOption?: (label: string) => void;
}) {
  const isUser = role === "user";
  const { prose, options } = isUser ? { prose: content, options: [] } : parseOptions(content);
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] p-3 rounded-lg whitespace-pre-wrap ${
          isUser
            ? "bg-purple-600 text-white"
            : "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        }`}
      >
        {prose}
        {showOptions && options.length > 0 && onSelectOption && (
          <div className="mt-3 flex flex-wrap gap-2 not-prose">
            {options.map((opt, i) => (
              <button
                key={i}
                onClick={() => onSelectOption(opt)}
                className="px-3 py-1.5 bg-white dark:bg-gray-800 border border-purple-300 dark:border-purple-700 text-purple-800 dark:text-purple-200 rounded-full text-sm hover:bg-purple-50 dark:hover:bg-purple-900/30 transition"
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RobustnessPanel({ gate, intake }: { gate: RobustnessGate | null; intake: IntakeArtefact | null }) {
  if (!gate) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm p-4">
        <h3 className="font-semibold mb-2">Robustness gate</h3>
        <p className="text-sm text-gray-500">Not yet evaluated. Send your first message to begin.</p>
      </div>
    );
  }
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Robustness gate</h3>
        <span className={`text-sm font-bold ${gate.ready ? "text-green-600" : "text-yellow-600"}`}>
          {gate.passedItems}/{gate.totalItems}
        </span>
      </div>
      <ul className="text-sm space-y-1.5">
        {gate.items.map((it) => (
          <li key={it.id} className="flex items-start gap-2">
            {it.passed ? (
              <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0 mt-0.5" />
            ) : (
              <XCircle className="w-4 h-4 text-gray-300 flex-shrink-0 mt-0.5" />
            )}
            <span className={it.passed ? "text-gray-700 dark:text-gray-300" : "text-gray-500"}>
              {it.label}
              {it.detail && <span className="text-xs text-gray-500 ml-1">({it.detail})</span>}
            </span>
          </li>
        ))}
      </ul>
      {intake && (
        <div className="mt-4 pt-4 border-t dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400 space-y-1">
          {intake.topicTerm && <div><strong>Topic:</strong> {intake.topicTerm}</div>}
          {intake.topicSynonyms && intake.topicSynonyms.length > 0 && (
            <div><strong>Synonyms:</strong> {intake.topicSynonyms.join(", ")}</div>
          )}
          {intake.adjacentTopics && intake.adjacentTopics.length > 0 && (
            <div><strong>Adjacent topics:</strong> {intake.adjacentTopics.map((a) => a.name).join(", ")}</div>
          )}
          {intake.sensitivityPreference && (
            <div><strong>Sensitivity:</strong> {intake.sensitivityPreference}</div>
          )}
        </div>
      )}
    </div>
  );
}

function DraftReview({
  draft,
  validation,
  onSelectTestDrive,
  onSave,
  loading,
  measureCount,
  errorCount,
  warningCount,
  repairAttempts,
  truncationRecovered,
}: {
  draft: any;
  validation: Validation | null;
  onSelectTestDrive: () => void;
  onSave: (productionReady: boolean) => void;
  loading: boolean;
  measureCount: number;
  repairAttempts?: number;
  truncationRecovered?: boolean;
  errorCount: number;
  warningCount: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">{draft.framework?.name}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {measureCount} measures across {draft.categories?.length || 0} categories · topicTerm: <code>{draft.framework?.topicTerm}</code>
            {typeof repairAttempts === "number" && repairAttempts > 0 && (
              <span className="ml-2 text-orange-600 dark:text-orange-400">
                · auto-repair passes: {repairAttempts}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-4 text-sm">
          <div className={`px-3 py-1 rounded ${errorCount === 0 ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
            {errorCount} errors
          </div>
          <div className={`px-3 py-1 rounded ${warningCount === 0 ? "bg-gray-100" : "bg-yellow-100 text-yellow-800"}`}>
            {warningCount} warnings
          </div>
        </div>
      </div>

      {validation && validation.violations.length > 0 && (
        <div className="mb-4 max-h-40 overflow-y-auto border rounded p-3 text-sm dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
          <h4 className="font-semibold mb-2">Validation issues</h4>
          {validation.violations.slice(0, 10).map((v, i) => (
            <div key={i} className="mb-1">
              <span className={v.severity === "error" ? "text-red-600" : "text-yellow-600"}>
                [{v.severity.toUpperCase()}][{v.rule}]
              </span>{" "}
              {v.measureId ? <code>{v.measureId}</code> : ""} {v.message}
            </div>
          ))}
          {validation.violations.length > 10 && (
            <div className="text-gray-500">…and {validation.violations.length - 10} more</div>
          )}
        </div>
      )}

      <div className="space-y-2 max-h-[45vh] overflow-y-auto">
        {(draft.categories || []).map((cat: any) => (
          <div key={cat.name} className="border rounded dark:border-gray-700">
            <div className="p-3 bg-gray-50 dark:bg-gray-700/50 font-medium">
              {cat.name}{" "}
              <span className="text-xs text-gray-500 ml-2">
                ({cat.measures?.length || 0} measures)
              </span>
            </div>
            <div>
              {(cat.measures || []).map((m: any) => (
                <div
                  key={m.measureId}
                  className="p-3 border-t dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/30"
                  onClick={() => setExpanded(expanded === m.measureId ? null : m.measureId)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm">
                      <code className="text-xs text-gray-500">{m.measureId}</code>{" "}
                      <span>{m.title}</span>
                    </div>
                    {typeof m.expected_yes_rate === "number" && (
                      <span className="text-xs text-gray-500 flex-shrink-0">
                        expected Yes rate: {(m.expected_yes_rate * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  {expanded === m.measureId && (
                    <div className="mt-3 text-xs space-y-2 text-gray-700 dark:text-gray-300 pl-2">
                      {m.substantive_definition && (
                        <div>
                          <strong>Substantive definition:</strong> {m.substantive_definition}
                        </div>
                      )}
                      {m.positive_examples && m.positive_examples.length > 0 && (
                        <div>
                          <strong>Positive examples:</strong>
                          <ul className="list-disc list-inside">
                            {m.positive_examples.map((e: string, i: number) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {m.negative_examples && m.negative_examples.length > 0 && (
                        <div>
                          <strong>Negative examples (adversarial):</strong>
                          <ul className="list-disc list-inside">
                            {m.negative_examples.map((e: string, i: number) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {m.fallback_yes_criterion && (
                        <div>
                          <strong>Fallback criterion:</strong>
                          <pre className="whitespace-pre-wrap text-xs bg-gray-100 dark:bg-gray-900/50 p-2 rounded mt-1">{m.fallback_yes_criterion}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {truncationRecovered && (
        <div className="mt-4 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-300 dark:border-orange-800 rounded text-sm text-orange-800 dark:text-orange-200">
          <strong>Truncation recovered:</strong> The model's response was cut off before all measures were generated. We salvaged the {measureCount} measures that completed. To get a fuller framework, restart with a smaller target measure count (Compact or Balanced).
        </div>
      )}
      {errorCount > 0 && (
        <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-800 rounded text-sm text-yellow-800 dark:text-yellow-200">
          <strong>Note:</strong> {errorCount} validation error{errorCount === 1 ? "" : "s"} remain after the auto-repair passes. You can still save this framework as a draft and run a test-drive to see how it behaves — the errors are LLM compliance gaps in specific measures, not blocking issues. "Save as production-ready" is disabled until errors are cleared or manually reviewed.
        </div>
      )}
      <div className="mt-6 flex gap-2 flex-wrap justify-end">
        <button
          onClick={() => onSave(false)}
          disabled={loading}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg flex items-center gap-1 disabled:opacity-50"
        >
          <Save className="w-4 h-4" /> Save as draft
        </button>
        <button
          onClick={onSelectTestDrive}
          disabled={loading}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
        >
          <Play className="w-4 h-4" /> Propose test-drive companies
        </button>
        <button
          onClick={() => onSave(true)}
          disabled={loading || errorCount > 0}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title={errorCount > 0 ? "Cannot save as production-ready while errors remain" : ""}
        >
          <CheckCircle2 className="w-4 h-4" /> Save as production-ready
        </button>
      </div>
    </div>
  );
}

function TestDriveReview({
  companies,
  onBack,
  onSaveWithoutTestDrive,
  loading,
}: {
  companies: TestDriveCandidate[];
  onBack: () => void;
  onSaveWithoutTestDrive: () => void;
  loading: boolean;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm p-6">
      <h2 className="text-xl font-semibold mb-4">Proposed test-drive sample</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        The LLM has proposed 10 companies for a test-drive scoring run. Review, then either save
        as draft to run the scoring separately, or proceed to save as production-ready without
        test-drive (not recommended for new frameworks).
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {companies.map((c, i) => (
          <div
            key={i}
            className={`p-3 border rounded ${c.isKnownDiscloser ? "bg-green-50 dark:bg-green-900/10 border-green-300 dark:border-green-800" : "dark:border-gray-700"}`}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-gray-500">
                  {c.ticker && <>{c.ticker} · </>}
                  {c.sector && <>{c.sector} · </>}
                  {c.country}
                </div>
              </div>
              {c.isKnownDiscloser && (
                <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">signal</span>
              )}
            </div>
            <div className="text-xs mt-2 text-gray-600 dark:text-gray-400">{c.rationale}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex gap-2 justify-end">
        <button onClick={onBack} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg">
          Back to draft review
        </button>
        <button
          onClick={onSaveWithoutTestDrive}
          disabled={loading}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg"
        >
          Save framework (skip scoring)
        </button>
      </div>
      <div className="mt-4 text-xs text-gray-500">
        Note: this initial UI shows the sample but does not automatically run the 10-company
        scoring. To run test-drive scoring, save the framework as draft first, then use the
        existing scoring interface with the proposed company list. Full automated test-drive
        orchestration is a follow-up.
      </div>
    </div>
  );
}

function DraftingProgress({ startTime, jobId }: { startTime: number | null; jobId: string | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startTime) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startTime]);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg space-y-2">
      <div className="flex items-center gap-2 text-purple-800 dark:text-purple-200 font-medium text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Drafting framework… {mm}:{ss} elapsed
      </div>
      <div className="text-xs text-purple-700 dark:text-purple-300">
        The LLM is generating ~30–40 measures with C1–C10 guidance, then runs up to two
        auto-repair passes if any measure violates a construction rule. Total time is
        typically 4–12 minutes. You can safely leave this tab open. If you close it, come
        back to the same page and the draft will still be waiting.
        {jobId && <div className="mt-1 text-xs text-purple-600 opacity-70">Job {jobId.slice(0, 8)}</div>}
      </div>
    </div>
  );
}

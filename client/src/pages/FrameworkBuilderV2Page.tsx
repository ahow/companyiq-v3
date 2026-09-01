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
  const [savedFrameworkId, setSavedFrameworkId] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem("fw-builder-v2-savedFrameworkId");
      return stored ? Number(stored) : null;
    } catch { return null; }
  });
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
  const [testDriveListId, setTestDriveListId] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem("fw-builder-v2-testDriveListId");
      return stored ? Number(stored) : null;
    } catch { return null; }
  });
  const [testDriveListName, setTestDriveListName] = useState<string | null>(() => {
    try { return localStorage.getItem("fw-builder-v2-testDriveListName"); } catch { return null; }
  });

  // Persist test-drive identifiers across refreshes so users can return to the
  // improvement panel without losing state. Cleared by the "Build another" button.
  // Placed AFTER all useState declarations so closures see the current values.
  useEffect(() => {
    try {
      if (savedFrameworkId != null) localStorage.setItem("fw-builder-v2-savedFrameworkId", String(savedFrameworkId));
      else localStorage.removeItem("fw-builder-v2-savedFrameworkId");
    } catch {}
  }, [savedFrameworkId]);
  useEffect(() => {
    try {
      if (testDriveListId != null) localStorage.setItem("fw-builder-v2-testDriveListId", String(testDriveListId));
      else localStorage.removeItem("fw-builder-v2-testDriveListId");
    } catch {}
  }, [testDriveListId]);
  useEffect(() => {
    try {
      if (testDriveListName) localStorage.setItem("fw-builder-v2-testDriveListName", testDriveListName);
      else localStorage.removeItem("fw-builder-v2-testDriveListName");
    } catch {}
  }, [testDriveListName]);

  // Persist state SERVER-side too, so switching browser or clearing local storage
  // still lets the user resume via the Framework page's 'Continue in v2 builder' link.
  useEffect(() => {
    if (savedFrameworkId == null) return;
    (async () => {
      try {
        await api.request("/framework-builder/v2/state/save", {
          method: "POST",
          body: JSON.stringify({ frameworkId: savedFrameworkId, stage, testDriveListId, testDriveListName }),
        });
      } catch (e) { /* non-fatal; localStorage still works */ }
    })();
  }, [savedFrameworkId, stage, testDriveListId, testDriveListName]);

  // On mount: check URL params for ?frameworkId= (deep-link from Framework page's
  // 'Continue in v2 builder' action). If present, load server-side state.
  // Otherwise if we restored saved-framework state from localStorage but the
  // stage is still "intake", jump the user straight to the results view.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fwId = params.get("frameworkId");
    if (fwId) {
      (async () => {
        try {
          const r = await api.request(`/framework-builder/v2/state/load?frameworkId=${fwId}`);
          setSavedFrameworkId(r.frameworkId);
          if (r.state) {
            if (r.state.testDriveListId) setTestDriveListId(r.state.testDriveListId);
            if (r.state.testDriveListName) setTestDriveListName(r.state.testDriveListName);
            if (r.state.stage) setStage(r.state.stage as any);
            else setStage("saved");
          } else {
            setStage("saved");
          }
        } catch (e: any) {
          setError(`Failed to restore framework ${fwId}: ${e?.message || e}`);
        }
      })();
    } else if (savedFrameworkId && testDriveListId && stage === "intake") {
      setStage("saved");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // 25 minutes: chunked drafts of 25–50 measures with an auto-repair pass
      // legitimately take 15–20 minutes. Below this we saw false timeouts.
      const deadline = Date.now() + 25 * 60_000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 5000));
        if (Date.now() > deadline) {
          throw new Error(
            "Draft still not finished after 25 minutes. You can try again \u2014 your intake is preserved. If this keeps happening the LLM provider may be down.",
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

  async function redraftWithCorrections() {
    if (!draft || !intake) return;
    setError(null);
    setLoading(true);
    setStage("drafting");
    setRepairAttempts(0);
    setTruncationRecovered(false);
    try {
      // Start a refine job and poll to completion (same pattern as draftFramework).
      const startRes = await api.request("/framework-builder/v2/draft/refine", {
        method: "POST",
        body: JSON.stringify({ draft, intake }),
      });
      const jobId = startRes.jobId;
      setDraftJobId(jobId);
      setDraftJobStartTime(Date.now());
      const deadline = Date.now() + 15 * 60_000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 5000));
        if (Date.now() > deadline) {
          throw new Error("Refine still not finished after 15 minutes.");
        }
        let status: any = null;
        try {
          status = await api.request(`/framework-builder/v2/draft/status/${jobId}`);
        } catch (pollErr: any) {
          console.warn("refine poll transient:", pollErr?.message || pollErr);
          continue;
        }
        if (status?.status === "succeeded" && status?.result) {
          setDraft(status.result.draft);
          setValidation(status.result.validation);
          if (typeof status.result.repairAttempts === "number") setRepairAttempts(status.result.repairAttempts);
          setStage("review");
          setDraftJobId(null);
          break;
        }
        if (status?.status === "failed") {
          throw new Error(status.errorMessage || "Refine job failed");
        }
      }
    } catch (err: any) {
      setError(err?.message || String(err));
      setStage("review");
      setDraftJobId(null);
    } finally {
      setLoading(false);
    }
  }

  async function saveFramework(productionReady: boolean): Promise<number | null> {
    if (!draft || !intake) return null;
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
      return res.frameworkId as number;
    } catch (err: any) {
      setError(err?.message || String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function runTestDriveScoring() {
    if (!draft || !intake || !testDriveCompanies || testDriveCompanies.length === 0) return;
    setError(null);
    setLoading(true);
    try {
      // 1. Save framework as draft first so we have a frameworkId.
      let fwId = savedFrameworkId;
      if (!fwId) {
        const save = await api.request("/framework-builder/v2/save", {
          method: "POST",
          body: JSON.stringify({ draft, intake, productionReady: false }),
        });
        fwId = save.frameworkId as number;
        setSavedFrameworkId(fwId);
      }
      // 2. Create companies + list.
      const run = await api.request("/framework-builder/v2/test-drive/run", {
        method: "POST",
        body: JSON.stringify({
          frameworkId: fwId,
          frameworkName: draft.framework?.name,
          companies: testDriveCompanies,
        }),
      });
      // 3. Kick off /api/analyze against the new list + framework.
      await api.request("/analyze", {
        method: "POST",
        body: JSON.stringify({
          frameworkId: fwId,
          listId: run.listId,
        }),
      });
      // 4. Advance UI to the saved stage; user can go watch progress on Results.
      setTestDriveListId(run.listId);
      setTestDriveListName(run.listName);
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
              onRedraft={redraftWithCorrections}
            />
          )}

          {stage === "test-drive" && (
            <TestDriveReview
              companies={testDriveCompanies || []}
              onBack={() => setStage("review")}
              onSaveWithoutTestDrive={() => saveFramework(false)}
              onRunTestDrive={runTestDriveScoring}
              loading={loading}
            />
          )}

          {stage === "saved" && savedFrameworkId && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-800 rounded-lg p-6">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
                <h2 className="text-xl font-semibold">Framework saved{testDriveListId ? " and test-drive started" : ""}</h2>
              </div>
              <p>
                Framework ID <code>{savedFrameworkId}</code> saved to your workspace with <code>builder_version=v2</code>.
                It appears in your Frameworks list and can be used to score companies through the existing pipeline.
              </p>
              {testDriveListId && savedFrameworkId && (
                <TestDriveResultsPanel frameworkId={savedFrameworkId} listId={testDriveListId} listName={testDriveListName} />
              )}
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
  onRedraft,
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
  onRedraft?: () => void;
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
      {(errorCount > 0 || warningCount > 0) && (
        <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-800 rounded text-sm text-yellow-800 dark:text-yellow-200">
          <strong>Note:</strong> {errorCount} error{errorCount === 1 ? "" : "s"} and {warningCount} warning{warningCount === 1 ? "" : "s"} remain after the auto-repair passes.
          {" "}To proceed to test-drive or save as production-ready, resolve them by clicking
          <strong className="mx-1">Re-draft with corrections</strong> (re-runs the LLM with the exact
          violation list), or use
          <strong className="mx-1">Save as draft</strong> to park this framework and edit measures manually later.
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
        {(errorCount > 0 || warningCount > 0) && onRedraft && (
          <button
            onClick={onRedraft}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
            title="Re-run the LLM with the exact violation list so it can produce a clean version."
          >
            <RotateCcw className="w-4 h-4" /> Re-draft with corrections
          </button>
        )}
        <button
          onClick={onSelectTestDrive}
          disabled={loading || errorCount > 0 || warningCount > 0}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title={
            errorCount > 0 || warningCount > 0
              ? "Resolve all errors and warnings before test-driving."
              : ""
          }
        >
          <Play className="w-4 h-4" /> Propose test-drive companies
        </button>
        <button
          onClick={() => onSave(true)}
          disabled={loading || errorCount > 0 || warningCount > 0}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title={
            errorCount > 0 || warningCount > 0
              ? "Resolve all errors and warnings before saving as production-ready."
              : ""
          }
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
  onRunTestDrive,
  loading,
}: {
  companies: TestDriveCandidate[];
  onBack: () => void;
  onSaveWithoutTestDrive: () => void;
  onRunTestDrive: () => void;
  loading: boolean;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm p-6">
      <h2 className="text-xl font-semibold mb-4">Proposed test-drive sample</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        The LLM proposed 10 companies for a test-drive scoring run — a mix of
        <strong className="mx-1">signal companies</strong> (companies the LLM expects to score high because they
        are known to disclose on this topic) and
        <strong className="mx-1">edge cases</strong> (companies where the topic is peripheral, expected to
        score low). A balanced mix helps you calibrate: signal companies test that the framework doesn't
        under-fire on real disclosures; edge cases test that the framework doesn't over-fire on
        unrelated language.
      </p>
      <div className="flex items-center gap-3 text-xs text-gray-500 mb-3">
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-green-100 border border-green-300" />
          <span>Signal (known discloser — expected to score high)</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded border border-gray-300 dark:border-gray-700" />
          <span>Edge case (topic peripheral — expected to score low)</span>
        </div>
      </div>
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
              <span
                className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                  c.isKnownDiscloser
                    ? "bg-green-100 text-green-800 border border-green-300"
                    : "bg-gray-100 text-gray-700 border border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
                }`}
                title={
                  c.isKnownDiscloser
                    ? "Signal: LLM expects this company to score high because it is a known discloser on this topic. Use this to check the framework doesn't under-fire on real disclosures."
                    : "Edge case: LLM expects this company to score low because the topic is peripheral to its business. Use this to check the framework doesn't over-fire on unrelated language."
                }
              >
                {c.isKnownDiscloser ? "signal" : "edge case"}
              </span>
            </div>
            <div className="text-xs mt-2 text-gray-600 dark:text-gray-400">{c.rationale}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-2 justify-end">
        <button onClick={onBack} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg">
          Back to draft review
        </button>
        <button
          onClick={onSaveWithoutTestDrive}
          disabled={loading}
          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg"
        >
          Save framework (skip scoring)
        </button>
        <button
          onClick={onRunTestDrive}
          disabled={loading}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-1"
        >
          <Play className="w-4 h-4" /> Save framework and run test-drive
        </button>
      </div>
      <div className="mt-4 text-xs text-gray-500">
        “Save framework and run test-drive” creates any missing companies, groups them in a new
        list, and dispatches scoring against the newly-saved framework. Scoring runs
        asynchronously — you can leave this page and return to Results later.
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

interface PerCompanyResult {
  companyId: number;
  companyName: string;
  yesCount: number;
  noCount: number;
  partialCount: number;
  insufficientCount: number;
  totalMeasures: number;
  yesRate: number;
}

interface FlagItem {
  measureId: string;
  rule: string;
  severity: "error" | "warning";
  message: string;
  suggestedFix: string;
  observedRate?: number;
  expectedRate?: number;
}

interface RobustnessCriterion {
  id: string;
  label: string;
  passed: boolean;
  observed: string;
  threshold: string;
  detail: string;
}

interface EditProposal {
  measureId: string;
  flagRule: string;
  cause: string;
  action: string;
  fieldPath: string;
  currentValueSummary: string;
  proposedValueSummary: string;
  rationale: string;
  expectedImpact: string;
}

interface MeasureDrillRow {
  companyName: string;
  verdict: string;
  confidence: string;
  quotes: string[];
  nuance: string;
}

interface CompanyDiagnostic {
  companyId: number;
  companyName: string;
  classification: "healthy" | "doc-collection-failure" | "framework-issue" | "ambiguous";
  yesCount: number;
  yesRate: number;
  corpusSummary: string;
  reasoning: string;
  suggestedAction: string;
}

interface MeasureRootCauseDiag {
  measureId: string;
  classification: "healthy" | "measure-definition-issue" | "collection-attributable" | "over-broad" | "ambiguous";
  yesCount: number;
  yesRateOnTopicRichCompanies: number;
  reasoning: string;
  suggestedAction: string;
}

interface RootCauseReport {
  companies: CompanyDiagnostic[];
  measures: MeasureRootCauseDiag[];
  summary: {
    docCollectionFailures: number;
    frameworkIssues: number;
    healthy: number;
    ambiguous: number;
    deadMeasuresLikelyFrameworkFault: number;
    deadMeasuresLikelyCorpusFault: number;
  };
  headline: string;
}

function TestDriveResultsPanel({ frameworkId, listId, listName }: { frameworkId: number; listId: number; listName: string | null }) {
  const [batch, setBatch] = useState<{ status: string; completedJobs: number; totalJobs: number; failedJobs: number } | null>(null);
  const [perCompany, setPerCompany] = useState<PerCompanyResult[]>([]);
  const [report, setReport] = useState<{ flags: FlagItem[]; summary: string; passedGracefully: boolean; totalCompanies: number; totalMeasures: number } | null>(null);
  const [robustness, setRobustness] = useState<{ criteria: RobustnessCriterion[]; passedCount: number; totalCount: number; allPassed: boolean } | null>(null);
  const [edits, setEdits] = useState<{ proposals: EditProposal[]; causeBreakdown: Record<string, number>; totalFlags: number; totalWithProposals: number } | null>(null);
  const [rootCauses, setRootCauses] = useState<RootCauseReport | null>(null);
  const [labelsInferred, setLabelsInferred] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [expandedMeasure, setExpandedMeasure] = useState<string | null>(null);
  const [drillRows, setDrillRows] = useState<Record<string, MeasureDrillRow[]>>({});
  const [drillLoading, setDrillLoading] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const r = await api.request(`/framework-builder/v2/test-drive/results?frameworkId=${frameworkId}&listId=${listId}`);
      setBatch(r.batch);
      setPerCompany(r.perCompany || []);
      setReport(r.report || null);
      setRobustness(r.robustness || null);
      setEdits(r.edits || null);
      setRootCauses(r.rootCauses || null);
      setLabelsInferred(!!r.labelsInferred);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const loadDrill = async (measureId: string) => {
    if (drillRows[measureId] || drillLoading === measureId) return;
    setDrillLoading(measureId);
    try {
      const r = await api.request(`/framework-builder/v2/test-drive/measure-drill?frameworkId=${frameworkId}&listId=${listId}&measureId=${encodeURIComponent(measureId)}`);
      setDrillRows((prev) => ({ ...prev, [measureId]: r.rows || [] }));
    } catch (e: any) {
      setError(`Failed to load drill-down for ${measureId}: ${e?.message || e}`);
    } finally {
      setDrillLoading(null);
    }
  };

  const acceptedCount = Object.values(decisions).filter((d) => d === "accept").length;
  const rejectedCount = Object.values(decisions).filter((d) => d === "reject").length;

  useEffect(() => {
    // Poll every 30 seconds while scoring is in progress; poll once at mount.
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    (async () => {
      setLoading(true);
      await fetchStatus();
      setLoading(false);
      if (cancelled) return;
      intervalId = setInterval(async () => {
        if (cancelled) return;
        await fetchStatus();
        if (batch?.status === "completed") {
          if (intervalId) clearInterval(intervalId);
        }
      }, 30_000);
    })();
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameworkId, listId]);

  const isRunning = batch && batch.status !== "completed" && batch.status !== "failed";
  const isComplete = batch?.status === "completed";

  return (
    <div className="mt-3 p-4 bg-white dark:bg-gray-800 rounded border border-green-300 dark:border-green-700 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">
            {isRunning ? "Test-drive scoring in progress" : isComplete ? "Test-drive scoring complete" : "Test-drive scoring status"}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            List: <code>{listName}</code> · framework id {frameworkId}
          </div>
        </div>
        {batch && (
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {batch.completedJobs}/{batch.totalJobs} companies scored
            {batch.failedJobs > 0 && <span className="text-red-600 ml-2">({batch.failedJobs} failed)</span>}
          </div>
        )}
      </div>

      {error && <div className="text-sm text-red-600">Poll error: {error}</div>}

      {loading && !batch && (
        <div className="text-sm text-gray-500 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading test-drive status…
        </div>
      )}

      {batch && isRunning && (
        <div className="text-sm text-gray-600 dark:text-gray-400">
          Scoring runs asynchronously. Progress updates every 30 seconds. Typical time for 10 companies × 25 measures: 15–30 minutes.
        </div>
      )}

      {perCompany.length > 0 && (
        <div className="border rounded dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/40">
              <tr>
                <th className="text-left px-3 py-2">Company</th>
                <th className="text-right px-3 py-2">Yes</th>
                <th className="text-right px-3 py-2">No</th>
                <th className="text-right px-3 py-2">Partial</th>
                <th className="text-right px-3 py-2">Yes rate</th>
              </tr>
            </thead>
            <tbody>
              {perCompany.map((c) => (
                <tr key={c.companyId} className="border-t dark:border-gray-700">
                  <td className="px-3 py-1.5">{c.companyName}</td>
                  <td className="px-3 py-1.5 text-right text-green-700 dark:text-green-400">{c.yesCount}</td>
                  <td className="px-3 py-1.5 text-right text-gray-500">{c.noCount}</td>
                  <td className="px-3 py-1.5 text-right text-yellow-700 dark:text-yellow-400">{c.partialCount}</td>
                  <td className="px-3 py-1.5 text-right">{(c.yesRate * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── Robustness Criteria Scorecard ─── */}
      {isComplete && robustness && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Robustness scorecard
              <span className={`ml-2 text-xs font-normal ${robustness.allPassed ? "text-green-700" : "text-yellow-700"}`}>
                {robustness.passedCount}/{robustness.totalCount} criteria passed
                {robustness.allPassed ? " — framework is robust enough for wider use" : " — iteration recommended"}
              </span>
            </div>
            {labelsInferred && (
              <span className="text-xs text-gray-500 italic">
                Signal/edge labels inferred from result distribution; discrimination criterion is not reliable for legacy batches.
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {robustness.criteria.map((c) => (
              <div
                key={c.id}
                className={`p-2.5 border rounded text-sm ${c.passed ? "border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700" : "border-yellow-300 bg-yellow-50 dark:bg-yellow-900/20 dark:border-yellow-700"}`}
              >
                <div className="flex items-center gap-2">
                  {c.passed ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <AlertTriangle className="w-4 h-4 text-yellow-600" />}
                  <span className="font-medium text-gray-900 dark:text-gray-100">{c.label}</span>
                </div>
                <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-medium">Observed:</span> {c.observed}
                  <span className="mx-1.5 text-gray-400">|</span>
                  <span className="font-medium">Target:</span> {c.threshold}
                </div>
                <div className="mt-1 text-xs text-gray-500">{c.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Root-cause diagnostic (doc-collection vs framework issues) ─── */}
      {isComplete && rootCauses && (
        <div className="space-y-3">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Root-cause analysis
            <span className="ml-2 text-xs font-normal text-gray-500">
              separates document-collection failures from framework issues
            </span>
          </div>
          <div className={`p-3 rounded border text-sm ${rootCauses.summary.docCollectionFailures > 0 ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700" : "border-blue-300 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-700"}`}>
            <div className="font-medium mb-1">Overall: {rootCauses.headline}</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2 text-xs">
              <div><span className="font-medium text-green-700">Healthy companies:</span> {rootCauses.summary.healthy}</div>
              <div><span className="font-medium text-amber-700">Doc-collection failures:</span> {rootCauses.summary.docCollectionFailures}</div>
              <div><span className="font-medium text-red-700">Framework issues:</span> {rootCauses.summary.frameworkIssues}</div>
              <div><span className="font-medium text-gray-600">Ambiguous:</span> {rootCauses.summary.ambiguous}</div>
              <div><span className="font-medium text-red-700">Dead measures (framework):</span> {rootCauses.summary.deadMeasuresLikelyFrameworkFault}</div>
              <div><span className="font-medium text-amber-700">Dead measures (corpus):</span> {rootCauses.summary.deadMeasuresLikelyCorpusFault}</div>
            </div>
          </div>

          {/* Per-company classification table */}
          <div className="border rounded dark:border-gray-700 overflow-hidden text-sm">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-900/40">
                <tr>
                  <th className="text-left px-3 py-2">Company</th>
                  <th className="text-left px-3 py-2">Classification</th>
                  <th className="text-left px-3 py-2">Yes</th>
                  <th className="text-left px-3 py-2">Corpus summary</th>
                  <th className="text-left px-3 py-2">Suggested action</th>
                </tr>
              </thead>
              <tbody>
                {rootCauses.companies.map((c) => (
                  <tr key={c.companyId} className="border-t dark:border-gray-700 align-top">
                    <td className="px-3 py-2 whitespace-nowrap font-medium">{c.companyName}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${
                        c.classification === "healthy" ? "bg-green-100 text-green-800" :
                        c.classification === "doc-collection-failure" ? "bg-amber-100 text-amber-800" :
                        c.classification === "framework-issue" ? "bg-red-100 text-red-800" :
                        "bg-gray-100 text-gray-700"
                      }`}>{c.classification}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{c.yesCount} <span className="text-gray-500">({(c.yesRate * 100).toFixed(0)}%)</span></td>
                    <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">{c.corpusSummary}</td>
                    <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-300">{c.suggestedAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── Cause breakdown + edit proposals ─── */}
      {isComplete && edits && edits.proposals.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Proposed measure edits
              <span className="ml-2 text-xs font-normal text-gray-500">
                {edits.proposals.length} proposal{edits.proposals.length === 1 ? "" : "s"} — {acceptedCount} accepted, {rejectedCount} rejected
              </span>
            </div>
            <div className="flex gap-1 text-xs text-gray-500">
              {Object.entries(edits.causeBreakdown).map(([cause, n]) => (
                <span key={cause} className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700">{cause}: {n}</span>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {edits.proposals.map((p, i) => {
              const key = `${p.measureId}::${p.flagRule}`;
              const dec = decisions[key];
              const isExpanded = expandedMeasure === p.measureId;
              return (
                <div
                  key={i}
                  className={`p-3 border rounded text-sm ${dec === "accept" ? "border-green-300 bg-green-50/50 dark:bg-green-900/10 dark:border-green-700" : dec === "reject" ? "border-gray-300 bg-gray-50 dark:bg-gray-900/30 opacity-60" : "border-gray-300 dark:border-gray-600"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-gray-500">{p.measureId}</code>
                        <span className="px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">{p.cause}</span>
                        <span className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">{p.action}</span>
                      </div>
                      <div className="mt-1 text-gray-800 dark:text-gray-200">{p.rationale}</div>
                      <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                        <span className="font-medium">Field:</span> <code>{p.fieldPath}</code>
                      </div>
                      <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
                        <div><span className="text-gray-500">Current:</span> {p.currentValueSummary || <span className="italic text-gray-400">empty</span>}</div>
                        <div><span className="text-gray-500">Proposed:</span> {p.proposedValueSummary}</div>
                      </div>
                      <div className="mt-1 text-xs italic text-gray-500">Expected impact: {p.expectedImpact}</div>
                    </div>
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        onClick={() => setDecisions((prev) => ({ ...prev, [key]: prev[key] === "accept" ? undefined : "accept" as any }))}
                        className={`px-2 py-1 rounded text-xs font-medium ${dec === "accept" ? "bg-green-600 text-white" : "bg-white dark:bg-gray-700 border border-green-300 text-green-700 dark:text-green-400 hover:bg-green-50"}`}
                      >
                        {dec === "accept" ? "✓ Accepted" : "Accept"}
                      </button>
                      <button
                        onClick={() => setDecisions((prev) => ({ ...prev, [key]: prev[key] === "reject" ? undefined : "reject" as any }))}
                        className={`px-2 py-1 rounded text-xs font-medium ${dec === "reject" ? "bg-gray-600 text-white" : "bg-white dark:bg-gray-700 border border-gray-300 text-gray-700 dark:text-gray-400 hover:bg-gray-50"}`}
                      >
                        {dec === "reject" ? "✗ Rejected" : "Reject"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 pt-2 border-t border-dashed border-gray-200 dark:border-gray-700">
                    <button
                      onClick={() => {
                        const next = isExpanded ? null : p.measureId;
                        setExpandedMeasure(next);
                        if (next) void loadDrill(p.measureId);
                      }}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {isExpanded ? "▾ Hide evidence" : "▸ Show evidence (per-company quotes)"}
                    </button>
                    {isExpanded && (
                      <div className="mt-2">
                        {drillLoading === p.measureId && (
                          <div className="text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading quotes…</div>
                        )}
                        {drillRows[p.measureId] && (
                          <div className="space-y-1.5 text-xs">
                            {drillRows[p.measureId].map((row, ri) => (
                              <div key={ri} className="pl-3 border-l-2 border-gray-200 dark:border-gray-600">
                                <div className="font-medium">
                                  {row.companyName}
                                  <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] ${row.verdict === "Yes" ? "bg-green-100 text-green-800" : row.verdict === "Partial" ? "bg-yellow-100 text-yellow-800" : "bg-gray-100 text-gray-700"}`}>{row.verdict}</span>
                                  <span className="ml-2 text-gray-500">confidence: {row.confidence}</span>
                                </div>
                                {row.quotes.length === 0 ? (
                                  <div className="italic text-gray-500">no quotes returned</div>
                                ) : (
                                  <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
                                    {row.quotes.slice(0, 3).map((q, qi) => (<li key={qi}>"{q.length > 300 ? q.slice(0, 300) + "…" : q}"</li>))}
                                    {row.quotes.length > 3 && (<li className="italic text-gray-500">+ {row.quotes.length - 3} more</li>)}
                                  </ul>
                                )}
                                {row.nuance && (
                                  <div className="mt-0.5 italic text-gray-500">nuance: {row.nuance.length > 200 ? row.nuance.slice(0, 200) + "…" : row.nuance}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isComplete && report && report.flags.length === 0 && (
        <div className="text-sm text-green-700 dark:text-green-400">
          No calibration flags. The framework's observed Yes rates are within the expected envelope for every measure. Ready for wider testing.
        </div>
      )}

      {isComplete && edits && edits.proposals.length > 0 && (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            When ready, apply {acceptedCount} accepted edit{acceptedCount === 1 ? "" : "s"} to regenerate affected measures and re-score. Rejected edits are dropped.
          </div>
          <button
            disabled={acceptedCount === 0}
            className={`px-3 py-1.5 rounded text-sm font-medium ${acceptedCount === 0 ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-purple-600 text-white hover:bg-purple-700"}`}
            title={acceptedCount === 0 ? "Accept at least one edit to enable iteration" : "Regenerate affected measures and start iteration N+1"}
          >
            Apply {acceptedCount} edit{acceptedCount === 1 ? "" : "s"} → iterate
          </button>
        </div>
      )}

      {/* ─── Improvement chat (Stage 2) ─── */}
      {isComplete && (
        <ImprovementChat frameworkId={frameworkId} listId={listId} />
      )}

      <div className="text-xs text-gray-500">
        Full per-measure quotes and evidence available on the Results page for the framework.
      </div>
    </div>
  );
}

// ─── Improvement chat component (Stage 2) ───
interface ChatAction { type: string; attrs: Record<string, string> }
interface ChatTurn { role: "user" | "assistant"; content: string; actions?: ChatAction[] }

function ImprovementChat({ frameworkId, listId }: { frameworkId: number; listId: number }) {
  const [turns, setTurns] = useState<ChatTurn[]>([
    { role: "assistant", content: "I've analysed your test-drive results. Ask me anything about the framework issues, doc-collection failures, or specific proposals — or type 'summarise findings' for an overview." },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const send = async () => {
    if (!input.trim() || sending) return;
    const userTurn: ChatTurn = { role: "user", content: input.trim() };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    setInput("");
    setSending(true);
    try {
      const resp = await api.request("/framework-builder/v2/improvement/chat", {
        method: "POST",
        body: JSON.stringify({ frameworkId, listId, messages: nextTurns.map((t) => ({ role: t.role, content: t.content })) }),
      });
      setTurns([...nextTurns, { role: "assistant", content: resp.reply || "(empty reply)", actions: resp.actions || [] }]);
    } catch (e: any) {
      setTurns([...nextTurns, { role: "assistant", content: `Error: ${e?.message || e}` }]);
    } finally {
      setSending(false);
    }
  };

  const applyAction = async (action: ChatAction) => {
    if (applying) return;
    setApplying(true);
    setApplyResult(null);
    try {
      const resp = await api.request("/framework-builder/v2/improvement/apply", {
        method: "POST",
        body: JSON.stringify({ frameworkId, listId, actions: [action] }),
      });
      setApplyResult(`Applied ${resp.appliedCount} action${resp.appliedCount === 1 ? "" : "s"}, ${resp.skippedCount} skipped.`);
    } catch (e: any) {
      setApplyResult(`Failed: ${e?.message || e}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="mt-3 border rounded dark:border-gray-700 p-3 space-y-2 bg-gray-50 dark:bg-gray-900/40">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-purple-600" />
        <div className="text-sm font-medium">Chat with framework consultant</div>
      </div>
      <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
        {turns.map((t, i) => (
          <div key={i} className={`text-sm ${t.role === "user" ? "text-gray-900 dark:text-gray-100 font-medium" : "text-gray-700 dark:text-gray-300"}`}>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-0.5">{t.role === "user" ? "You" : "Consultant"}</div>
            <div className="whitespace-pre-wrap">{t.content}</div>
            {t.actions && t.actions.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {t.actions.map((a, ai) => (
                  <button
                    key={ai}
                    onClick={() => applyAction(a)}
                    disabled={applying}
                    className={`px-2 py-1 rounded text-xs font-medium border ${applying ? "bg-gray-200 text-gray-400 cursor-not-allowed border-gray-300" : "bg-white dark:bg-gray-800 hover:bg-purple-50 border-purple-300 text-purple-700 dark:text-purple-300"}`}
                  >
                    {a.type === "apply_edit" && `Apply ${a.attrs.proposal}`}
                    {a.type === "apply_all_by_cause" && `Apply all: ${a.attrs.cause}`}
                    {a.type === "escalate_to_corpus" && `Fix corpus for ${a.attrs.company}`}
                    {a.type === "ignore_measure" && `Ignore ${a.attrs.measure}`}
                    {a.type === "rescore_now" && `Re-score now`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {sending && (
          <div className="text-xs text-gray-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Thinking…</div>
        )}
        {applyResult && (
          <div className="text-xs text-green-700 dark:text-green-400 italic">{applyResult}</div>
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Ask about a company or measure, or 'summarise findings'…"
          className="flex-1 px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
          disabled={sending}
        />
        <button
          onClick={() => void send()}
          disabled={sending || !input.trim()}
          className={`px-3 py-1.5 rounded text-sm font-medium ${sending || !input.trim() ? "bg-gray-200 text-gray-400" : "bg-purple-600 text-white hover:bg-purple-700"}`}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

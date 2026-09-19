import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, Loader2, CheckCircle2, XCircle, AlertTriangle, Save, Play, RotateCcw, ClipboardList, Paperclip, X, FileText } from "lucide-react";
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

// Structured design issue emitted by the save acceptance gate (server:
// rules.ts StructuredIssue). Rendered as a four-part accept-or-fix card.
interface StructuredIssue {
  id: string;
  ruleCode: string;
  severity: "error" | "warning";
  measureId: string;
  field: string;
  issue: string;
  reason: string;
  solution: string;
  implication: string;
}

// State captured when POST /v2/save returns a blocked 400.
interface SaveGate {
  issues: StructuredIssue[];
  issuesReadable?: string;
  blockingIssueIds: string[];
  summary?: string;
  productionReady: boolean;
}

interface TestDriveCandidate {
  name: string;
  ticker?: string;
  sector?: string;
  country?: string;
  rationale: string;
  isKnownDiscloser: boolean;
}

export default function FrameworkBuilderV2Page({ onGoToFrameworks }: { onGoToFrameworks?: () => void }) {
  const [stage, setStage] = useState<Stage>("intake");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [intake, setIntake] = useState<IntakeArtefact | null>(null);
  const [robustnessGate, setRobustnessGate] = useState<RobustnessGate | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  // PRE-DRAFT design diagnostic (static, LLM-free) attached to every draft
  // result. Surfaced for REVIEW in the builder before the draft is proposed as
  // ready. Advisory only — never auto-applied.
  const [designDiagnostic, setDesignDiagnostic] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [testDriveCompanies, setTestDriveCompanies] = useState<TestDriveCandidate[] | null>(null);
  const [savedFrameworkId, setSavedFrameworkId] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem("fw-builder-v2-savedFrameworkId");
      return stored ? Number(stored) : null;
    } catch { return null; }
  });
  const [lastFailedUserMessage, setLastFailedUserMessage] = useState<string | null>(null);
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Chat file attachments ────────────────────────────────────────────────
  // The user can attach reference files (CSV/TXT/MD/JSON read client-side; PDF
  // extracted server-side via /v2/extract-pdf). On send, the extracted text is
  // folded into the outgoing message under labelled delimiters, capped so a
  // huge file can't blow the intake token budget. Attachments clear after send.
  interface ChatAttachment { name: string; text: string; chars: number; truncated: boolean }
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ATTACH_PER_FILE_CAP = 100_000; // chars per file folded into the message

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error("file read failed"));
      reader.readAsDataURL(file);
    });

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setAttachError(null);
    setAttaching(true);
    try {
      const next: ChatAttachment[] = [];
      for (const file of Array.from(fileList)) {
        const lower = file.name.toLowerCase();
        const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
        const isTextLike = /\.(csv|txt|md|markdown|json|tsv|log)$/.test(lower)
          || file.type.startsWith("text/")
          || file.type === "application/json";
        let raw = "";
        if (isPdf) {
          const base64 = await readFileAsBase64(file);
          const res = await fetch("/api/framework-builder/v2/extract-pdf", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ base64, filename: file.name }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(`${file.name}: ${body.error || `HTTP ${res.status}`}`);
          }
          const body = await res.json();
          raw = String(body.text || "");
        } else if (isTextLike) {
          raw = await file.text();
        } else {
          throw new Error(`${file.name}: unsupported type. Attach CSV, TXT, MD, JSON, or PDF.`);
        }
        const truncated = raw.length > ATTACH_PER_FILE_CAP;
        next.push({
          name: file.name,
          text: truncated ? raw.slice(0, ATTACH_PER_FILE_CAP) : raw,
          chars: raw.length,
          truncated,
        });
      }
      setAttachments((prev) => [...prev, ...next]);
    } catch (err: any) {
      setAttachError(err?.message || String(err));
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // Fold attachments into the outgoing message text under labelled delimiters.
  function foldAttachments(text: string): string {
    if (attachments.length === 0) return text;
    const blocks = attachments.map((a) => {
      const note = a.truncated
        ? ` (truncated to ${ATTACH_PER_FILE_CAP.toLocaleString()} of ${a.chars.toLocaleString()} chars)`
        : "";
      return `--- Attached file: ${a.name}${note} ---\n${a.text}`;
    });
    return `${text}\n\n${blocks.join("\n\n")}`.trim();
  }

  // Send handler for the intake box: folds attachments in, sends, then clears
  // them. Option-select and retry call sendMessage directly (no attachments).
  function handleUserSend() {
    if (loading || attaching) return;
    const typed = input.trim();
    if (!typed && attachments.length === 0) return;
    const outgoing = foldAttachments(typed || "Please review the attached file(s).");
    setAttachments([]);
    setAttachError(null);
    void sendMessage(outgoing);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Wrap the chat request in a manual fetch with an AbortController so we can
  // give a friendly timeout error, and let the user retry the same turn.
  //
  // The chat turn is IDEMPOTENT server-side (it takes the full messages[] + the
  // current intake and has no side effects — no job is created here), so a
  // dropped socket can be retried safely. Mobile browsers routinely drop a
  // long-idle fetch socket while the server buffers a large LLM response, which
  // surfaced as "Network error before response" at the intake-emission turn. We
  // now auto-retry that transient "failed to fetch" case a couple of times with
  // a short backoff before giving up and surfacing the manual-retry message.
  async function callChatEndpoint(nextMessages: Message[], timeoutMs = 300_000) {
    const MAX_SOCKET_RETRIES = 2;
    let lastSocketErr: any = null;
    for (let attempt = 0; attempt <= MAX_SOCKET_RETRIES; attempt++) {
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
          // Deterministic timeout — retrying regenerates the same slow response,
          // so surface immediately.
          throw new Error(
            "Request timed out after " + Math.round(timeoutMs / 1000) + "s. The model provider is slow right now; please retry.",
          );
        }
        const isSocketDrop =
          typeof err?.message === "string" && err.message.toLowerCase().includes("failed to fetch");
        if (isSocketDrop && attempt < MAX_SOCKET_RETRIES) {
          // Transient socket drop — wait briefly and retry the same idempotent turn.
          lastSocketErr = err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (isSocketDrop) {
          throw new Error(
            "Network error before response. Your connection may have dropped or the request was interrupted. Please retry \u2014 your conversation history is preserved.",
          );
        }
        throw err;
      }
    }
    // Unreachable in practice; satisfies the type checker.
    throw lastSocketErr ?? new Error("Network error before response.");
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
      // Always reset on a new LLM turn: if the user accepted warnings and then kept
      // chatting, re-show the (updated) warnings card if the gate is still not ready.
      setWarningsAcknowledged(false);
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
  // ISSUE 2: honest, human-readable outcome of a user-initiated "Re-draft with
  // corrections" run (how many warnings were resolved vs remain, and why).
  const [refineMessage, setRefineMessage] = useState<string | null>(null);
  const [truncationRecovered, setTruncationRecovered] = useState<boolean>(false);
  // Honest shortfall reporting: the resolved target the drafter aimed for and
  // how many category batches (if any) failed to complete.
  const [targetMeasureCount, setTargetMeasureCount] = useState<number | null>(null);
  const [failedCategories, setFailedCategories] = useState<number>(0);
  const [failedCategoryNames, setFailedCategoryNames] = useState<string[]>([]);
  const [testDriveListId, setTestDriveListId] = useState<number | null>(() => {
    try {
      const stored = localStorage.getItem("fw-builder-v2-testDriveListId");
      return stored ? Number(stored) : null;
    } catch { return null; }
  });
  const [testDriveListName, setTestDriveListName] = useState<string | null>(() => {
    try { return localStorage.getItem("fw-builder-v2-testDriveListName"); } catch { return null; }
  });
  // Design-issue acceptance gate (populated when POST /v2/save returns blocked:true).
  const [saveGate, setSaveGate] = useState<SaveGate | null>(null);
  const [acceptedIssueIds, setAcceptedIssueIds] = useState<string[]>([]);
  // Multi-run test-drive: how many scoring batches the flip detector expects.
  const [scoringRunsTarget, setScoringRunsTarget] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("fw-builder-v2-scoringRuns");
      return stored ? Math.max(1, Number(stored) || 1) : 1;
    } catch { return 1; }
  });
  const [scoringProgress, setScoringProgress] = useState<string | null>(null);
  // ISSUE 3: when /api/analyze is rejected (HTTP 409) because a previous batch is
  // awaiting review, surface an actionable inline resolver instead of a dead-end
  // error. We stash the framework/list so the retry can re-run analyze verbatim
  // once the old batch is finalised. `alreadyRunning` is a wait-only state (no button).
  const [testDrivePendingReview, setTestDrivePendingReview] = useState<
    { batchId: number; failed: number; completed: number; total: number; frameworkId: number; listId: number; listName: string } | null
  >(null);
  const [testDriveAlreadyRunning, setTestDriveAlreadyRunning] = useState<
    { batchId: number; completed: number; total: number } | null
  >(null);
  const [resolvingBatch, setResolvingBatch] = useState(false);

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
  //
  // GUARD: skip the save until the initial deep-link load has completed. Without
  // this guard, mount fires the effect once with default stage='intake' BEFORE
  // the /v2/state/load response arrives, and we would clobber the DB with
  // stage='intake' every time the user opens a resume URL.
  const [hasHydrated, setHasHydrated] = useState(false);
  useEffect(() => {
    if (!hasHydrated) return;
    if (savedFrameworkId == null) return;
    (async () => {
      try {
        await api.request("/framework-builder/v2/state/save", {
          method: "POST",
          body: JSON.stringify({
            frameworkId: savedFrameworkId,
            stage,
            testDriveListId,
            testDriveListName,
            draft: draft ?? undefined,          // only include when non-null
            validation: validation ?? undefined,
          }),
        });
      } catch (e) { /* non-fatal; localStorage still works */ }
    })();
  }, [savedFrameworkId, stage, testDriveListId, testDriveListName, draft, validation, hasHydrated]);

  // On mount: check URL params for ?frameworkId= (deep-link from Framework page's
  // 'Continue in v2 builder' action). If present, load server-side state.
  // Otherwise if we restored saved-framework state from localStorage but the
  // stage is still "intake", jump the user straight to the results view.
  //
  // Order matters: we set hasHydrated=true only AFTER the initial state read
  // completes, so the persistence effect above can't clobber the DB before
  // we know what state to persist.
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
            if (r.state.draft) {
              setDraft(r.state.draft);
              if (r.state.validation) setValidation(r.state.validation);
              if (r.state.designDiagnostic) setDesignDiagnostic(r.state.designDiagnostic);
              // If the user already ran a test-drive (there is a saved results
              // panel to return to), honor the stored 'saved' stage so the
              // deep-link lands them on their proposals/results instead of the
              // review panel. Only fall back to 'review' when there is a draft
              // but no saved test-drive results to return to (avoids the
              // dead-end 'Framework saved' card while keeping proposals
              // reachable). The draft stays loaded either way, so re-draft and
              // the review panel remain available via the nav button.
              if (r.state.testDriveListId && r.state.stage === "saved") {
                setStage("saved");
              } else {
                setStage("review");
              }
            } else if (r.state.stage) {
              setStage(r.state.stage as any);
            } else {
              setStage("saved");
            }
          } else {
            setStage("saved");
          }
        } catch (e: any) {
          setError(`Failed to restore framework ${fwId}: ${e?.message || e}`);
        } finally {
          setHasHydrated(true);
        }
      })();
    } else {
      if (savedFrameworkId && testDriveListId && stage === "intake") {
        setStage("saved");
      }
      setHasHydrated(true);
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
          setDesignDiagnostic(status.result.designDiagnostic || null);
          if (typeof status.result.repairAttempts === "number") {
            setRepairAttempts(status.result.repairAttempts);
          }
          setTruncationRecovered(Boolean(status.result.truncationRecovered));
          setTargetMeasureCount(
            typeof status.result.targetMeasureCount === "number" ? status.result.targetMeasureCount : null,
          );
          setFailedCategories(Number(status.result.failedCategories || 0));
          setFailedCategoryNames(
            Array.isArray(status.result.failedCategoryNames) ? status.result.failedCategoryNames : [],
          );
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
    setRefineMessage(null);
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
          setDesignDiagnostic(status.result.designDiagnostic || null);
          if (typeof status.result.repairAttempts === "number") setRepairAttempts(status.result.repairAttempts);
          // ISSUE 2: surface the honest server-computed outcome of the refine run.
          if (typeof status.result.refineMessage === "string") setRefineMessage(status.result.refineMessage);
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

  // Toggle explicit acceptance of a single outstanding design issue.
  function toggleAcceptIssue(id: string) {
    setAcceptedIssueIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function saveFramework(
    productionReady: boolean,
    gateOpts?: { acceptedIssueIds?: string[]; proceedWithWarnings?: boolean },
  ): Promise<number | null> {
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
          // Design-issue acceptance gate: resubmit accepted ids or a
          // proceed-with-warnings override so the server lets the save through.
          ...(gateOpts?.acceptedIssueIds ? { acceptedIssueIds: gateOpts.acceptedIssueIds } : {}),
          ...(gateOpts?.proceedWithWarnings ? { proceedWithWarnings: true } : {}),
        }),
      });
      setSaveGate(null);
      setAcceptedIssueIds([]);
      setSavedFrameworkId(res.frameworkId);
      setStage("saved");
      return res.frameworkId as number;
    } catch (err: any) {
      // A blocked 400 carries the structured design issues; surface the accept /
      // proceed gate instead of a raw error message.
      const body = err?.body ?? err;
      if (err?.blocked || body?.blocked) {
        setSaveGate({
          issues: body?.issues ?? [],
          issuesReadable: body?.issuesReadable,
          blockingIssueIds: body?.blockingIssueIds ?? [],
          summary: body?.summary,
          productionReady: false,
        });
      } else {
        setError(err?.message || String(err));
      }
      return null;
    } finally {
      setLoading(false);
    }
  }

  // ISSUE 3: kick off /api/analyze and advance the UI. Extracted so it can be
  // retried verbatim after a previous pending-review batch is resolved. On a 409
  // conflict it records the actionable state (pending-review → resolver button;
  // already-running → wait message) rather than throwing a generic error.
  // Returns true on success, false if a 409 conflict was surfaced.
  async function startTestDriveAnalyze(fwId: number, listId: number, listName: string): Promise<boolean> {
    try {
      // Analyze is async and single-active-batch; runs 2..N are driven by the
      // results panel via /v2/rescore once each prior batch completes.
      await api.request("/analyze", {
        method: "POST",
        body: JSON.stringify({ frameworkId: fwId, listId }),
      });
      // Advance UI to the saved stage; user can go watch progress on Results.
      setTestDrivePendingReview(null);
      setTestDriveAlreadyRunning(null);
      setTestDriveListId(listId);
      setTestDriveListName(listName);
      setStage("saved");
      return true;
    } catch (err: any) {
      const body = err?.body || {};
      if (err?.status === 409 && body.pendingReview) {
        // A previous batch in this workspace is awaiting review and blocks a new
        // analysis. Offer to finalise it (safely saves completed results) and retry.
        setTestDriveAlreadyRunning(null);
        setTestDrivePendingReview({
          batchId: Number(body.batchId),
          failed: Number(body.failed) || 0,
          completed: Number(body.completed) || 0,
          total: Number(body.total) || 0,
          frameworkId: fwId,
          listId,
          listName,
        });
        return false;
      }
      if (err?.status === 409 && body.alreadyRunning) {
        // Another analysis is actively running — no safe resolve action; the user
        // must wait for it to finish, then retry.
        setTestDrivePendingReview(null);
        setTestDriveAlreadyRunning({
          batchId: Number(body.batchId),
          completed: Number(body.completed) || 0,
          total: Number(body.total) || 0,
        });
        return false;
      }
      throw err;
    }
  }

  async function runTestDriveScoring() {
    if (!draft || !intake || !testDriveCompanies || testDriveCompanies.length === 0) return;
    setError(null);
    setTestDrivePendingReview(null);
    setTestDriveAlreadyRunning(null);
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
      // 2. Create companies + list. Request multiple scoring runs so the flip
      //    detector has run-to-run data (design-time only; live scoring is
      //    single-shot and untouched). Server clamps `runs` to [1, maxRuns].
      const run = await api.request("/framework-builder/v2/test-drive/run", {
        method: "POST",
        body: JSON.stringify({
          frameworkId: fwId,
          frameworkName: draft.framework?.name,
          companies: testDriveCompanies,
          runs: 3,
        }),
      });
      // Persist the server-clamped run target; the results panel auto-continues
      // (rescore) until this many iterations are recorded. See scoringRunsTarget.
      const scoringRuns = Math.max(1, Number(run.scoringRuns) || 1);
      setScoringRunsTarget(scoringRuns);
      try { localStorage.setItem("fw-builder-v2-scoringRuns", String(scoringRuns)); } catch { /* ignore */ }
      setScoringProgress(scoringRuns > 1 ? `Multi-run scoring: iteration 1 of ${scoringRuns} starting…` : null);
      // 3. Kick off /api/analyze against the new list + framework (batch 1 of N).
      await startTestDriveAnalyze(fwId, run.listId, run.listName);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  // ISSUE 3: finalise the previous pending-review batch (safely saves its completed
  // results and clears the review alert), then retry the blocked analyze verbatim.
  async function resolvePreviousBatchAndContinue() {
    const pending = testDrivePendingReview;
    if (!pending) return;
    setError(null);
    setResolvingBatch(true);
    try {
      await api.request("/batch/review/finalize", { method: "POST" });
      setTestDrivePendingReview(null);
      setLoading(true);
      try {
        await startTestDriveAnalyze(pending.frameworkId, pending.listId, pending.listName);
      } finally {
        setLoading(false);
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setResolvingBatch(false);
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
    setDesignDiagnostic(null);
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
                {intake?.confirmed && robustnessGate && !robustnessGate.ready && !warningsAcknowledged && !loading && (() => {
                  const unresolved = robustnessGate.items.filter((i) => !i.passed);
                  return (
                    <div className="border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <h3 className="font-semibold text-yellow-800 dark:text-yellow-200">
                            {unresolved.length} intake item{unresolved.length === 1 ? "" : "s"} not fully resolved
                          </h3>
                          <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                            The framework will still be drafted, but the following items were not addressed
                            during intake. Please review and choose how to proceed:
                          </p>
                          <ul className="mt-2 space-y-1 text-sm text-yellow-800 dark:text-yellow-200 list-disc list-inside">
                            {unresolved.map((item) => (
                              <li key={item.id}>
                                <span className="font-medium">{item.label}</span>
                                {item.detail ? <span className="text-yellow-700 dark:text-yellow-300"> ({item.detail})</span> : null}
                              </li>
                            ))}
                          </ul>
                          <div className="mt-4 flex justify-end gap-2">
                            <button
                              onClick={() => {
                                setWarningsAcknowledged(false);
                                textareaRef.current?.focus();
                              }}
                              className="px-3 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-sm"
                            >
                              Make changes
                            </button>
                            <button
                              onClick={() => setWarningsAcknowledged(true)}
                              className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm flex items-center gap-1"
                            >
                              <CheckCircle2 className="w-4 h-4" /> Accept and proceed
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
                <div ref={messagesEndRef} />
              </div>
              {stage === "intake" && (
                <div className="p-4 border-t dark:border-gray-700">
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {attachments.map((att, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 border dark:border-gray-600 rounded text-xs"
                        >
                          <FileText className="w-3 h-3 text-purple-600" />
                          <span className="max-w-[160px] truncate" title={att.name}>
                            {att.name}
                          </span>
                          <span className="text-gray-400">
                            ({Math.round(att.chars / 1000)}k)
                          </span>
                          <button
                            onClick={() => removeAttachment(i)}
                            className="ml-1 text-gray-400 hover:text-red-500"
                            title="Remove attachment"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {attachError && (
                    <div className="mb-2 text-xs text-red-500">{attachError}</div>
                  )}
                  <div className="flex gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept=".csv,.txt,.md,.json,.pdf,text/plain,text/csv,text/markdown,application/json,application/pdf"
                      className="hidden"
                      onChange={(e) => {
                        handleFilesSelected(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={loading || attaching}
                      className="px-3 py-2 border rounded-lg dark:border-gray-600 self-end flex items-center gap-1 disabled:opacity-50"
                      title="Attach files (CSV, TXT, MD, JSON, PDF)"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                    <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleUserSend();
                        }
                      }}
                      placeholder="Type your answer, or start with the topic and initial-input template contents…"
                      className="flex-1 p-3 border rounded-lg dark:bg-gray-700 dark:border-gray-600 resize-none"
                      rows={3}
                      disabled={loading}
                    />
                    <button
                      onClick={() => handleUserSend()}
                      disabled={loading || attaching || (!input.trim() && attachments.length === 0)}
                      className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white rounded-lg self-end flex items-center gap-1"
                    >
                      <Send className="w-4 h-4" /> Send
                    </button>
                  </div>
                  {(robustnessGate?.ready || warningsAcknowledged) && (
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
                </div>
              )}
            </div>
          )}

          {stage === "review" && draft && (
            <>
              <DraftReview
                draft={draft}
                validation={validation}
                designDiagnostic={designDiagnostic}
                onSelectTestDrive={selectTestDriveSample}
                onSave={saveFramework}
                loading={loading}
                measureCount={measureCount}
                errorCount={errorCount}
                warningCount={warningCount}
                repairAttempts={repairAttempts}
                refineMessage={refineMessage}
                truncationRecovered={truncationRecovered}
                targetMeasureCount={targetMeasureCount}
                failedCategories={failedCategories}
                failedCategoryNames={failedCategoryNames}
                onRedraft={redraftWithCorrections}
                onRetryDraft={draftFramework}
                hasTestDriveResults={!!(savedFrameworkId && testDriveListId)}
                onViewResults={() => setStage("saved")}
              />
              {saveGate && (
                <SaveGatePanel
                  gate={saveGate}
                  acceptedIssueIds={acceptedIssueIds}
                  onToggleAccept={toggleAcceptIssue}
                  onSaveAccepted={() => saveFramework(false, { acceptedIssueIds })}
                  onProceed={() => saveFramework(false, { proceedWithWarnings: true })}
                  onRedraft={() => { setSaveGate(null); void redraftWithCorrections(); }}
                  onDismiss={() => { setSaveGate(null); setAcceptedIssueIds([]); }}
                  loading={loading}
                />
              )}
            </>
          )}

          {stage === "test-drive" && (
            <>
              <TestDriveReview
                companies={testDriveCompanies || []}
                onBack={() => setStage("review")}
                onSaveWithoutTestDrive={() => saveFramework(false)}
                onRunTestDrive={runTestDriveScoring}
                loading={loading}
              />
              {/* ISSUE 3: a previous batch is awaiting review and is blocking analyze.
                  Offer an in-place resolver that finalises it then retries. */}
              {testDrivePendingReview && (
                <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-800 rounded-lg text-sm text-amber-900 dark:text-amber-100">
                  <div className="font-semibold mb-1">A previous batch is awaiting review</div>
                  <p className="mb-3">
                    Analysis batch #{testDrivePendingReview.batchId} finished but was never reviewed
                    ({testDrivePendingReview.completed} of {testDrivePendingReview.total} companies completed
                    {testDrivePendingReview.failed > 0 ? `, ${testDrivePendingReview.failed} failed` : ""}).
                    Only one active analysis is allowed per workspace, so it must be resolved before this
                    test-drive can start. Resolving it saves the completed results to the Results page and
                    clears the review — then this test-drive starts automatically.
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={resolvePreviousBatchAndContinue}
                      disabled={resolvingBatch || loading}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
                    >
                      {resolvingBatch ? "Resolving…" : "Resolve previous batch & continue"}
                    </button>
                    <button
                      onClick={() => setTestDrivePendingReview(null)}
                      disabled={resolvingBatch}
                      className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded-lg disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              {/* ISSUE 3: another analysis is actively running — wait, no resolve action. */}
              {testDriveAlreadyRunning && (
                <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-800 rounded-lg text-sm text-blue-900 dark:text-blue-100">
                  <div className="font-semibold mb-1">An analysis is already running</div>
                  <p>
                    Batch #{testDriveAlreadyRunning.batchId} is currently in progress
                    ({testDriveAlreadyRunning.completed} of {testDriveAlreadyRunning.total} companies done).
                    Only one analysis can run at a time in this workspace — wait for it to finish, then
                    click <strong>Save framework and run test-drive</strong> again.
                  </p>
                </div>
              )}
              {saveGate && (
                <SaveGatePanel
                  gate={saveGate}
                  acceptedIssueIds={acceptedIssueIds}
                  onToggleAccept={toggleAcceptIssue}
                  onSaveAccepted={() => saveFramework(false, { acceptedIssueIds })}
                  onProceed={() => saveFramework(false, { proceedWithWarnings: true })}
                  onRedraft={() => { setSaveGate(null); setStage("review"); void redraftWithCorrections(); }}
                  onDismiss={() => { setSaveGate(null); setAcceptedIssueIds([]); }}
                  loading={loading}
                />
              )}
            </>
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
                <TestDriveResultsPanel frameworkId={savedFrameworkId} listId={testDriveListId} listName={testDriveListName} scoringRunsTarget={scoringRunsTarget} />
              )}
              <div className="mt-4 flex gap-2">
                {onGoToFrameworks && (
                  <button
                    onClick={onGoToFrameworks}
                    className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                  >
                    ← Back to Frameworks
                  </button>
                )}
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
  // ISSUE 1 — Accept-default UX. On any assistant turn that presents options,
  // show a single PROMINENT primary "Accept the proposal" action first, and keep
  // the remaining chips as secondary buttons beneath it. If the LLM's first chip
  // is already an acceptance-style label, promote THAT chip (so its exact text is
  // sent) rather than adding a duplicate; otherwise synthesize a primary button
  // that sends a canonical acceptance message through the same path. The user can
  // always type a normal message instead.
  const isAcceptLabel = (label: string): boolean => {
    const l = label.trim().toLowerCase();
    return (
      l.startsWith("accept") ||
      l.startsWith("yes, proceed") ||
      l.startsWith("yes proceed") ||
      l === "proceed" ||
      l === "yes" ||
      l.startsWith("proceed with") ||
      l.startsWith("looks good")
    );
  };
  const firstIsAccept = options.length > 0 && isAcceptLabel(options[0]);
  // Primary button label + the message it sends. When the first chip is an accept
  // chip, reuse its verbatim label/message; otherwise synthesize a generic one.
  const primaryLabel = firstIsAccept ? options[0] : "Accept the proposal";
  const primaryMessage = firstIsAccept ? options[0] : "Accept the proposal as stated.";
  // Secondary chips: every option except the promoted accept chip (if any).
  const secondaryOptions = firstIsAccept ? options.slice(1) : options;
  const hasOptions = showOptions && options.length > 0 && !!onSelectOption;
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
        {hasOptions && (
          <div className="mt-3 not-prose">
            {/* Primary: accept the proposal exactly as the assistant stated it. */}
            <button
              onClick={() => onSelectOption!(primaryMessage)}
              className="w-full sm:w-auto px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg text-sm transition shadow-sm"
            >
              ✓ {primaryLabel}
            </button>
            {secondaryOptions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {secondaryOptions.map((opt, i) => (
                  <button
                    key={i}
                    onClick={() => onSelectOption!(opt)}
                    className="px-3 py-1 bg-white dark:bg-gray-800 border border-purple-300 dark:border-purple-700 text-purple-800 dark:text-purple-200 rounded-full text-xs hover:bg-purple-50 dark:hover:bg-purple-900/30 transition"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
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

// ─── Design diagnostic (measure-design defect review) ─────────────────────
// Renders the read-only, advisory design diagnostic in the builder. Used at
// TWO points: PRE-DRAFT (static pre-test only, before a draft is proposed as
// ready) and POST-TEST (pre-test + stored-result signals + run-to-run flip
// rate). Findings are REVIEW items only — never auto-applied.
function DesignDiagnosticPanel({ report, mode }: { report: any; mode: "pre-draft" | "post-test" }) {
  if (!report) return null;
  const flagged: any[] = Array.isArray(report.flaggedMeasures) ? report.flaggedMeasures : [];
  const preTest: any[] = Array.isArray(report.preTest) ? report.preTest : [];
  const postTest: any[] = Array.isArray(report.postTest) ? report.postTest : [];
  const multiRun: any[] = Array.isArray(report.multiRun) ? report.multiRun : [];
  const heading = mode === "pre-draft" ? "Design review — before you accept this draft" : "Design review — post-test signals";
  const subtitle =
    mode === "pre-draft"
      ? "Static checks over the drafted measure definitions. Advisory only — nothing is changed automatically. Resolve these before proposing the framework as ready."
      : "Read-only signals over the stored test-drive results. Advisory only — nothing is changed automatically.";
  const flippedRanking = [...multiRun].filter((m) => (m.flipRate || 0) > 0).sort((a, b) => (b.flipRate || 0) - (a.flipRate || 0));
  const nothing = flagged.length === 0 && preTest.length === 0 && postTest.length === 0 && multiRun.length === 0;
  return (
    <div className="mb-4 border rounded-lg dark:border-gray-700 bg-indigo-50/60 dark:bg-indigo-900/10 p-4">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
        <h4 className="font-semibold text-indigo-900 dark:text-indigo-200">{heading}</h4>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">{subtitle}</p>
      {report.humanSummary && (
        <pre className="text-xs whitespace-pre-wrap text-gray-700 dark:text-gray-300 mb-3 font-sans">{report.humanSummary}</pre>
      )}
      {nothing && (
        <div className="text-sm text-green-700 dark:text-green-400">No design defects detected.</div>
      )}
      {flagged.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Flagged measures (ranked by instability){mode === "pre-draft" ? "" : " — including run-to-run signals"}:
          </div>
          {flagged.map((f) => (
            <div key={f.measureId} className="border rounded p-2.5 text-sm bg-white dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center gap-2 flex-wrap">
                <code className="text-xs font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded">{f.measureId}</code>
                <span className="font-medium">{f.title || ""}</span>
                {typeof f.instabilityScore === "number" && (
                  <span className="ml-auto text-xs text-gray-500">instability {(f.instabilityScore * 100).toFixed(0)}%</span>
                )}
              </div>
              {Array.isArray(f.patterns) && f.patterns.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {f.patterns.map((p: string) => (
                    <span key={p} className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{p}</span>
                  ))}
                </div>
              )}
              {Array.isArray(f.suggestedClarifications) && f.suggestedClarifications.length > 0 && (
                <ul className="mt-1.5 list-disc list-inside text-xs text-gray-700 dark:text-gray-300 space-y-0.5">
                  {f.suggestedClarifications.map((c: string, i: number) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              {mode === "post-test" && f.evidence?.postTest && (
                <div className="mt-1.5 text-[11px] text-gray-500">
                  verdicts: {JSON.stringify(f.evidence.postTest.verdictDistribution || {})}
                  {typeof f.evidence.postTest.rationaleInconsistentRate === "number" && (
                    <> · rationale↔score inconsistent {(f.evidence.postTest.rationaleInconsistentRate * 100).toFixed(0)}%</>
                  )}
                  {typeof f.evidence.postTest.lowConfidenceRate === "number" && (
                    <> · low-confidence {(f.evidence.postTest.lowConfidenceRate * 100).toFixed(0)}%</>
                  )}
                </div>
              )}
              {mode === "post-test" && f.evidence?.multiRun && typeof f.evidence.multiRun.flipRate === "number" && (
                <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                  run-to-run flip rate {(f.evidence.multiRun.flipRate * 100).toFixed(0)}% across {f.evidence.multiRun.companiesCompared} companies
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {mode === "post-test" && flippedRanking.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Run-to-run flip ranking:</div>
          <ol className="list-decimal list-inside text-xs text-gray-700 dark:text-gray-300 space-y-0.5">
            {flippedRanking.map((m) => (
              <li key={m.measureId}>
                <code className="font-mono">{m.measureId}</code> {m.title ? `— ${m.title} ` : ""}
                <span className="text-red-600 dark:text-red-400">{((m.flipRate || 0) * 100).toFixed(0)}% flip</span>
                {typeof m.companiesCompared === "number" && <> ({m.companiesCompared} companies)</>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function DraftReview({
  draft,
  validation,
  designDiagnostic,
  onSelectTestDrive,
  onSave,
  onRedraft,
  onRetryDraft,
  onViewResults,
  hasTestDriveResults,
  loading,
  measureCount,
  errorCount,
  warningCount,
  repairAttempts,
  refineMessage,
  truncationRecovered,
  targetMeasureCount,
  failedCategories,
  failedCategoryNames,
}: {
  draft: any;
  validation: Validation | null;
  designDiagnostic?: any;
  onSelectTestDrive: () => void;
  onSave: (productionReady: boolean) => void;
  onRedraft?: () => void;
  onRetryDraft?: () => void;
  onViewResults?: () => void;
  hasTestDriveResults?: boolean;
  loading: boolean;
  measureCount: number;
  repairAttempts?: number;
  refineMessage?: string | null;
  truncationRecovered?: boolean;
  targetMeasureCount?: number | null;
  failedCategories?: number;
  failedCategoryNames?: string[];
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

      {/* PRE-DRAFT design diagnostic — surfaced for REVIEW before the draft is
          proposed as ready. Static, LLM-free, advisory only. */}
      <DesignDiagnosticPanel report={designDiagnostic} mode="pre-draft" />

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

      {(() => {
        const target = typeof targetMeasureCount === "number" ? targetMeasureCount : null;
        const failed = failedCategories || 0;
        // Only flag a shortfall if we KNOW the target and landed >15% below it,
        // or a category batch failed / the response was truncated. A draft that
        // lands within ~15% of the requested size is treated as on-target and
        // shows no warning at all.
        const materiallyShort = target != null && measureCount < Math.floor(target * 0.85);
        if (!truncationRecovered && failed === 0 && !materiallyShort) return null;
        const reason =
          failed > 0
            ? ` because ${failed} categor${failed === 1 ? "y" : "ies"} did not finish generating${
                failedCategoryNames && failedCategoryNames.length ? ` (${failedCategoryNames.join(", ")})` : ""
              }.`
            : truncationRecovered
            ? " because the model's response was cut off before every measure completed."
            : ".";
        return (
          <div className="mt-4 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-300 dark:border-orange-800 rounded text-sm text-orange-800 dark:text-orange-200">
            <strong>Fewer measures than requested:</strong>{" "}
            {target != null
              ? `${measureCount} of the ~${target} measures you asked for were generated`
              : `${measureCount} measures were generated`}
            {reason}{" "}
            This is a transient generation issue — your chosen framework size is fully supported, so you do
            not need to pick a smaller one. Re-running the draft almost always produces the complete set.
            {onRetryDraft && (
              <div className="mt-2">
                <button
                  onClick={onRetryDraft}
                  disabled={loading}
                  className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
                  title="Re-run the full draft from the same intake. Category drafting runs in parallel batches, so a re-run usually completes every category."
                >
                  <RotateCcw className="w-4 h-4" /> Retry draft
                </button>
              </div>
            )}
          </div>
        );
      })()}
      {(errorCount > 0 || warningCount > 0) && (
        <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-800 rounded text-sm text-yellow-800 dark:text-yellow-200">
          <strong>Note:</strong> {errorCount} error{errorCount === 1 ? "" : "s"} and {warningCount} warning{warningCount === 1 ? "" : "s"}{" "}
          {typeof repairAttempts === "number" && repairAttempts > 0
            ? `remain after ${repairAttempts} auto-repair pass${repairAttempts === 1 ? "" : "es"}.`
            : "are present in the initial draft (auto-repair did not run or could not address them)."}
          {errorCount > 0
            ? " Errors must be resolved before you can test-drive or save as production-ready."
            : " Warnings are advisory — you can proceed to test-drive or save as production-ready with them present."}
          {" "}To reduce them, click
          <strong className="mx-1">Re-draft with corrections</strong> (re-runs the LLM with the exact
          violation list), or use
          <strong className="mx-1">Save as draft</strong> to park this framework and edit measures manually later.
          {refineMessage && (
            <div className="mt-2 pt-2 border-t border-yellow-300 dark:border-yellow-800">
              <strong>Last re-draft:</strong> {refineMessage}
            </div>
          )}
        </div>
      )}
      {refineMessage && errorCount === 0 && warningCount === 0 && (
        <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-800 rounded text-sm text-green-800 dark:text-green-200">
          <strong>Last re-draft:</strong> {refineMessage}
        </div>
      )}
      <div className="mt-6 flex gap-2 flex-wrap justify-end">
        {hasTestDriveResults && onViewResults && (
          <button
            onClick={onViewResults}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg flex items-center gap-1 mr-auto"
            title="This framework already has a test-drive run. Open its results and edit proposals (accept / dismiss)."
          >
            <ClipboardList className="w-4 h-4" /> View test-drive results
          </button>
        )}
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
          disabled={loading || errorCount > 0}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title={
            errorCount > 0
              ? "Resolve all errors before test-driving. Warnings are advisory and do not block."
              : warningCount > 0
              ? "Warnings are advisory — you can proceed to test-drive. Re-draft with corrections if you want to reduce them first."
              : ""
          }
        >
          <Play className="w-4 h-4" /> Propose test-drive companies
        </button>
        <button
          onClick={() => onSave(true)}
          disabled={loading || errorCount > 0}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title={
            errorCount > 0
              ? "Resolve all errors before saving as production-ready. Warnings are advisory and do not block."
              : warningCount > 0
              ? "Warnings are advisory — you can save as production-ready. Any remaining acceptance items are confirmed on the next step."
              : ""
          }
        >
          <CheckCircle2 className="w-4 h-4" /> Save as production-ready
        </button>
      </div>
    </div>
  );
}

// Acceptance gate shown when POST /v2/save returns blocked:true. Each structured
// issue is rendered four-part (issue / reason / solution / implication) with an
// Accept toggle for error-severity items; warnings are shown but never block.
// Saving is allowed once every blocking id is accepted, or via "Save anyway".
function SaveGatePanel({
  gate,
  acceptedIssueIds,
  onToggleAccept,
  onSaveAccepted,
  onProceed,
  onRedraft,
  onDismiss,
  loading,
}: {
  gate: SaveGate;
  acceptedIssueIds: string[];
  onToggleAccept: (id: string) => void;
  onSaveAccepted: () => void;
  onProceed: () => void;
  onRedraft: () => void;
  onDismiss: () => void;
  loading: boolean;
}) {
  const errors = gate.issues.filter((i) => i.severity === "error");
  const warnings = gate.issues.filter((i) => i.severity === "warning");
  const blockingSet = new Set(gate.blockingIssueIds);
  const acceptedSet = new Set(acceptedIssueIds);
  const remainingBlocking = gate.blockingIssueIds.filter((id) => !acceptedSet.has(id));
  const allAccepted = remainingBlocking.length === 0 && gate.blockingIssueIds.length > 0;

  return (
    <div className="mt-4 bg-white dark:bg-gray-800 rounded-lg border border-red-300 dark:border-red-800 shadow-sm p-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
          <h2 className="text-xl font-semibold">Save blocked — outstanding design issues</h2>
        </div>
        <button
          onClick={onDismiss}
          className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          title="Dismiss the gate without saving"
        >
          Dismiss
        </button>
      </div>
      {gate.summary && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{gate.summary}</p>
      )}
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {gate.blockingIssueIds.length} error-severity issue(s) block this save. Accept each one
        explicitly (acknowledging the flip risk), re-draft to fix them, or save anyway with all
        warnings knowingly accepted.
      </p>

      {errors.length > 0 && (
        <div className="space-y-3 mb-4">
          <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">
            Errors ({errors.length})
          </h3>
          {errors.map((issue) => {
            const isBlocking = blockingSet.has(issue.id);
            const accepted = acceptedSet.has(issue.id);
            return (
              <div
                key={issue.id}
                className={`rounded-lg border p-4 ${
                  accepted
                    ? "border-green-300 dark:border-green-800 bg-green-50/50 dark:bg-green-900/10"
                    : "border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-900/10"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs font-mono text-gray-500">
                    {issue.ruleCode}
                    {issue.measureId && issue.measureId !== "framework-level" && (
                      <span className="ml-1">· {issue.measureId}</span>
                    )}
                    {issue.field && <span className="ml-1">· {issue.field}</span>}
                  </div>
                  {isBlocking && (
                    <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none flex-shrink-0">
                      <input
                        type="checkbox"
                        checked={accepted}
                        onChange={() => onToggleAccept(issue.id)}
                        className="w-4 h-4"
                      />
                      <span className={accepted ? "text-green-700 dark:text-green-400 font-medium" : "text-gray-700 dark:text-gray-300"}>
                        {accepted ? "Accepted" : "Accept"}
                      </span>
                    </label>
                  )}
                </div>
                <dl className="mt-2 text-sm space-y-1.5">
                  <div><dt className="inline font-semibold">Issue: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.issue}</dd></div>
                  <div><dt className="inline font-semibold">Reason: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.reason}</dd></div>
                  <div><dt className="inline font-semibold">Solution: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.solution}</dd></div>
                  <div><dt className="inline font-semibold">Implication: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.implication}</dd></div>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="space-y-3 mb-4">
          <h3 className="text-sm font-semibold text-yellow-700 dark:text-yellow-400">
            Warnings ({warnings.length}) — non-blocking
          </h3>
          {warnings.map((issue) => (
            <div
              key={issue.id}
              className="rounded-lg border border-yellow-200 dark:border-yellow-900 bg-yellow-50/40 dark:bg-yellow-900/10 p-4"
            >
              <div className="text-xs font-mono text-gray-500">
                {issue.ruleCode}
                {issue.measureId && issue.measureId !== "framework-level" && (
                  <span className="ml-1">· {issue.measureId}</span>
                )}
                {issue.field && <span className="ml-1">· {issue.field}</span>}
              </div>
              <dl className="mt-2 text-sm space-y-1.5">
                <div><dt className="inline font-semibold">Issue: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.issue}</dd></div>
                <div><dt className="inline font-semibold">Reason: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.reason}</dd></div>
                <div><dt className="inline font-semibold">Solution: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.solution}</dd></div>
                <div><dt className="inline font-semibold">Implication: </dt><dd className="inline text-gray-700 dark:text-gray-300">{issue.implication}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2 border-t dark:border-gray-700">
        <button
          onClick={onSaveAccepted}
          disabled={loading || !allAccepted}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title={
            allAccepted
              ? "Save as draft with the accepted issues acknowledged"
              : `Accept all ${gate.blockingIssueIds.length} blocking issue(s) first (${remainingBlocking.length} remaining)`
          }
        >
          <Save className="w-4 h-4" />
          {allAccepted
            ? "Save with accepted issues"
            : `Accept all to save (${remainingBlocking.length} left)`}
        </button>
        <button
          onClick={onProceed}
          disabled={loading}
          className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title="Save as draft, accepting all outstanding issues at once"
        >
          <AlertTriangle className="w-4 h-4" /> Save anyway (proceed with warnings)
        </button>
        <button
          onClick={onRedraft}
          disabled={loading}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg flex items-center gap-1 disabled:opacity-50"
          title="Re-draft the framework to fix every outstanding issue"
        >
          <RotateCcw className="w-4 h-4" /> Re-draft to fix all
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
        The LLM proposed 50 companies for a test-drive scoring run — a mix of
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
  flipRate?: number; // ITEM 2: fraction of companies whose verdict differs across runs
  flippedCompanies?: Array<{ companyId: string; verdicts: string[] }>;
}

// ITEM 2: per-measure run-to-run flip statistics (server: test-drive.ts
// MeasureFlipStat). Populated once >=2 scoring iterations have been recorded.
interface MeasureFlipStat {
  measureId: string;
  runs: number;
  companiesCompared: number;
  flippedCount: number;
  flipRate: number;
  flippedCompanies: Array<{ companyId: string; verdicts: string[] }>;
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
  patch?: { op?: string; path?: string; value?: unknown };
}

interface TruthFinding {
  verdict: string;
  confidence: string;
  reasoning: string;
  quotes: string[];
  sources: Array<{ url: string; title?: string }>;
  checkedAt?: string;
}

// Quotes returned by the server can be plain strings (truth-check output) OR
// objects {text, source} (measure_scores.quotes JSONB shape). Normalise in the
// UI so we never call .length/.slice on undefined.
type QuoteLike = string | { text?: string; source?: string; sourceUrl?: string } | any;

function quoteText(q: QuoteLike): string {
  if (typeof q === "string") return q;
  if (q && typeof q === "object") return String(q.text ?? q.quote ?? "");
  return String(q ?? "");
}
function quoteSource(q: QuoteLike): string | undefined {
  if (q && typeof q === "object" && typeof q.source === "string") return q.source;
  return undefined;
}

interface RetrievalDiagnostic {
  chunks: number;
  chars: number;
  topicHits: number;
  topChunks: Array<{ url: string; title: string; score: number }>;
  docBreakdown: Array<{ docUrl: string; chunkCount: number }>;
}

// If a quote is a retrieval-diagnostic pack (stored when the scorer returned
// No), parse the embedded JSON string and return a structured summary.
function parseRetrievalDiagnostic(q: QuoteLike): RetrievalDiagnostic | null {
  if (!q || typeof q !== "object") return null;
  if (q.source !== "retrieval-diagnostic") return null;
  try {
    const data = JSON.parse(String(q.text || ""));
    return {
      chunks: Number(data.chunks || 0),
      chars: Number(data.chars || 0),
      topicHits: Number(data.topicHits || 0),
      topChunks: (data.topChunks || []).map((c: any) => ({
        url: String(c.u || ""),
        title: String(c.t || ""),
        score: Number(c.s || 0),
      })),
      docBreakdown: (data.docBreakdown || []).map((d: any) => ({
        docUrl: String(d.docUrl || ""),
        chunkCount: Number(d.chunkCount || 0),
      })),
    };
  } catch { return null; }
}

interface MeasureDrillRow {
  companyId: number;
  companyName: string;
  verdict: string;
  confidence: string;
  quotes: QuoteLike[];
  nuance: string;
  truth?: TruthFinding | null;
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

interface IterationSnapshot {
  id: number;
  iterationNumber: number;
  batchId: number | null;
  scoredAt: string;
  perCompany: Array<{ companyId: number; companyName: string; yesCount: number; noCount: number; partialCount: number; yesRate: number }>;
  perMeasure: Record<string, { yesCount: number; totalCount: number; verdictsByCompany: Record<string, string> }>;
  robustness: { criteria: RobustnessCriterion[]; passedCount: number; totalCount: number; allPassed: boolean } | null;
  rootCauses: RootCauseReport | null;
}

// One row of the measure edit-audit log (server: measure-audit.ts / GET
// /v2/measure-edits). applied=false rows carry a skipReason.
interface MeasureEditRow {
  id: number;
  measureId: string;
  field: string;
  op: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  source: string;
  applied: boolean;
  skipReason: string | null;
  createdAt: string;
}

// ─── Tier-1 design-time quality metrics (server: quality-metrics.ts) ────────
// These mirror the QualityMetricsReport shapes. MAXIMISE metrics are reported to
// steer improvement; GATE metrics are judged against DEFERRED placeholder
// thresholds (thresholdsAreDeferred=true) so the UI shows the observed value and
// a "threshold deferred" note rather than a hard pass/fail.
interface QGateMetric {
  id: string;
  label: string;
  role: "GATE";
  value: number | null;
  threshold: number | null;
  thresholdDirection: "min" | "max" | "band";
  passed: boolean | null;
  observed: string;
  detail: string;
  status?: string;
}
interface QMaximiseMetric {
  id: string;
  label: string;
  role: "MAXIMISE";
  value: number | null;
  observed: string;
  detail: string;
  status?: string;
}
interface QNearDuplicatePair {
  measureIdA: string;
  measureIdB: string;
  labelA: string;
  labelB: string;
  agreement: number;
  kappa: number;
  n: number;
  recommendation: "merge-or-differentiate";
}
interface QPerIndicatorMetric {
  measureId: string;
  label: string;
  passRate: number;
  inInformationBand: boolean;
  answerability: number;
  cellStability: number | null;
  kappa: number | null;
  specCompleteness: number | null;
}
interface QDimensionScore {
  dimension: "reliability" | "coherenceRedundancy" | "accuracy";
  weight: number;
  S_d: number | null;
  meanRho: number | null;
  indicatorCount: number;
  status?: string;
}
interface QWeightSensitivityGuard {
  stable: boolean;
  qBaseline: number | null;
  qRange: [number, number] | null;
  dimensionRankStable: boolean;
  note: string;
}
interface QualityMetricsReport {
  n: number;
  runs: number;
  reliability: QMaximiseMetric[];
  coherenceRedundancy: QMaximiseMetric[];
  discrimination: QGateMetric[];
  coverage: QGateMetric[];
  auditability: QGateMetric[];
  robustness: QGateMetric[];
  transparency: QGateMetric[];
  coherenceGates?: QGateMetric[];
  nearDuplicatePairs: QNearDuplicatePair[];
  perIndicator: QPerIndicatorMetric[];
  q: {
    Q: number | null;
    dimensions: QDimensionScore[];
    weightSensitivity: QWeightSensitivityGuard;
    note: string;
  };
  thresholdsAreDeferred: true;
}

function TestDriveResultsPanel({ frameworkId, listId, listName, scoringRunsTarget = 1 }: { frameworkId: number; listId: number; listName: string | null; scoringRunsTarget?: number }) {
  const [batch, setBatch] = useState<{ status: string; completedJobs: number; totalJobs: number; failedJobs: number } | null>(null);
  const [perCompany, setPerCompany] = useState<PerCompanyResult[]>([]);
  const [report, setReport] = useState<{ flags: FlagItem[]; summary: string; passedGracefully: boolean; totalCompanies: number; totalMeasures: number } | null>(null);
  const [robustness, setRobustness] = useState<{ criteria: RobustnessCriterion[]; passedCount: number; totalCount: number; allPassed: boolean } | null>(null);
  const [edits, setEdits] = useState<{ proposals: EditProposal[]; causeBreakdown: Record<string, number>; totalFlags: number; totalWithProposals: number } | null>(null);
  const [rootCauses, setRootCauses] = useState<RootCauseReport | null>(null);
  const [qualityMetrics, setQualityMetrics] = useState<QualityMetricsReport | null>(null);
  // POST-TEST measure-design diagnostic (read-only, advisory) — populated once
  // scoring completes. Multi-run flip section auto-appears after a re-test.
  const [postTestDiagnostic, setPostTestDiagnostic] = useState<any>(null);
  // Near-duplicate accept/dismiss selections, keyed by "<measureIdA>::<measureIdB>".
  const [nearDupDecisions, setNearDupDecisions] = useState<Record<string, "accept" | "dismiss">>({});
  const [labelsInferred, setLabelsInferred] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [expandedMeasure, setExpandedMeasure] = useState<string | null>(null);
  const [drillRows, setDrillRows] = useState<Record<string, MeasureDrillRow[]>>({});
  const [drillLoading, setDrillLoading] = useState<string | null>(null);
  // Truth-check state, keyed by "<measureId>::<companyId>"
  const [truthLoading, setTruthLoading] = useState<Record<string, boolean>>({});
  const [truthResults, setTruthResults] = useState<Record<string, TruthFinding & { cached?: boolean }>>({});
  const [truthErrors, setTruthErrors] = useState<Record<string, string>>({});

  const runTruthCheck = async (measureId: string, companyId: number, force = false) => {
    const key = `${measureId}::${companyId}`;
    if (truthLoading[key]) return;
    setTruthLoading((s) => ({ ...s, [key]: true }));
    setTruthErrors((s) => { const c = { ...s }; delete c[key]; return c; });
    try {
      const r = await api.request("/framework-builder/v2/truth-check", {
        method: "POST",
        body: JSON.stringify({ frameworkId, companyId, measureId, force }),
      });
      setTruthResults((s) => ({ ...s, [key]: r as TruthFinding & { cached?: boolean } }));
    } catch (e: any) {
      setTruthErrors((s) => ({ ...s, [key]: e?.message || String(e) }));
    } finally {
      setTruthLoading((s) => ({ ...s, [key]: false }));
    }
  };

  // Bulk-run truth checks for every company shown in one measure's drill-down.
  // Fires up to 3 in parallel to keep provider rate limits comfortable; the
  // per-row loading indicator surfaces progress as each finishes.
  const [bulkTruthBusy, setBulkTruthBusy] = useState<string | null>(null);
  const runTruthCheckAll = async (measureId: string, rows: MeasureDrillRow[], force = false) => {
    if (bulkTruthBusy) return;
    setBulkTruthBusy(measureId);
    // Skip rows that already have a cached truth finding unless force=true.
    const targets = rows.filter((r) => force || !(truthResults[`${measureId}::${r.companyId}`] || r.truth));
    const CONCURRENCY = 3;
    let i = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push((async () => {
        while (true) {
          const idx = i++;
          if (idx >= targets.length) return;
          await runTruthCheck(measureId, targets[idx].companyId, force);
        }
      })());
    }
    await Promise.all(workers);
    setBulkTruthBusy(null);
  };
  const [iterations, setIterations] = useState<IterationSnapshot[]>([]);
  const [rescoring, setRescoring] = useState(false);
  const [rescoreError, setRescoreError] = useState<string | null>(null);
  // ITEM 2: per-measure run-to-run flip stats + auto-continue guard. The guard
  // counts how many auto-rescores we have KICKED OFF. Batches ever started =
  // 1 (initial) + this counter, so we cap it at scoringRunsTarget - 1 to
  // guarantee exactly scoringRunsTarget batches are scored (no overshoot). We
  // count started batches rather than iterations.length because the snapshot of
  // a completed batch lands asynchronously and lags the isComplete transition —
  // gating on iterations.length alone let the last rescore start one extra batch.
  const [flipStats, setFlipStats] = useState<MeasureFlipStat[]>([]);
  const autoRescoreGuard = useRef(0);
  const [applyingIterate, setApplyingIterate] = useState(false);
  const [applyIterateResult, setApplyIterateResult] = useState<string | null>(null);
  const [applyIterateError, setApplyIterateError] = useState<string | null>(null);
  // Recent edit-audit rows for this framework/list (observability). Refreshed
  // after every apply so silently-skipped accepts become visible.
  const [measureEdits, setMeasureEdits] = useState<MeasureEditRow[]>([]);
  const [measureEditsOpen, setMeasureEditsOpen] = useState(false);
  // Server-computed gate: true when proposals/robustness were computed from the
  // latest COMPLETED batch — even if the newest batch (shown in live progress) is
  // cancelled/failed/running. Lets the dashboard render the last good results and
  // the "Run scoring again" control while the newest run is not completed.
  const [scoringCompleteSrv, setScoringCompleteSrv] = useState(false);
  const [latestBatchStatus, setLatestBatchStatus] = useState<string | null>(null);

  const fetchMeasureEdits = async () => {
    try {
      const r = await api.request(`/framework-builder/v2/measure-edits?frameworkId=${frameworkId}&listId=${listId}&limit=200`);
      setMeasureEdits(r.edits || []);
    } catch { /* non-fatal — audit is observability-only */ }
  };

  const applyAcceptedAndIterate = async () => {
    if (applyingIterate || acceptedCount === 0) return;
    setApplyingIterate(true);
    setApplyIterateResult(null);
    setApplyIterateError(null);
    try {
      // Build one apply_edit action per accepted proposal. Send the stable
      // identity tuple (measure + flagRule + patch op/path) so the server can
      // resolve the proposal against its freshly re-derived bundle regardless of
      // position. Keep the positional "P<n>" label as a fallback for old servers
      // and as a human-readable audit label.
      const actions: Array<{ type: string; attrs: Record<string, string> }> = [];
      (edits?.proposals || []).forEach((p, idx) => {
        const key = `${p.measureId}::${p.flagRule}`;
        if (decisions[key] === "accept") {
          actions.push({
            type: "apply_edit",
            attrs: {
              measure: p.measureId,
              flagRule: p.flagRule,
              op: p.patch?.op ?? "",
              path: p.patch?.path ?? "",
              proposal: `P${idx + 1}`,
            },
          });
        }
      });
      const applyResp = await api.request("/framework-builder/v2/improvement/apply", {
        method: "POST",
        body: JSON.stringify({ frameworkId, listId, actions }),
      });
      const summary = summariseApplyResult(applyResp);
      setApplyIterateResult(`${summary} Now starting a fresh test-drive…`);
      // Refresh the edit-audit so any silently-skipped accepts are visible.
      void fetchMeasureEdits();
      // Kick off a re-score against the updated framework
      await triggerRescore();
      setApplyIterateResult(`${summary} Started a fresh iteration — watch the counter above.`);
    } catch (e: any) {
      setApplyIterateError(e?.message || String(e));
    } finally {
      setApplyingIterate(false);
    }
  };

  const fetchIterations = async () => {
    try {
      const r = await api.request(`/framework-builder/v2/iterations?frameworkId=${frameworkId}&listId=${listId}`);
      setIterations(r.iterations || []);
    } catch { /* non-fatal */ }
  };

  const triggerRescore = async () => {
    if (rescoring) return;
    setRescoring(true);
    setRescoreError(null);
    try {
      const r = await api.request("/framework-builder/v2/rescore", {
        method: "POST",
        body: JSON.stringify({ frameworkId, listId }),
      });
      // Reset batch to running so polling picks up the new run.
      setBatch({ status: "running", completedJobs: 0, totalJobs: r.totalJobs || 10, failedJobs: 0 });
      await fetchIterations();
    } catch (e: any) {
      setRescoreError(e?.message || String(e));
    } finally {
      setRescoring(false);
    }
  };

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
      setFlipStats(r.flipStats || []);
      setQualityMetrics(r.qualityMetrics || null);
      setPostTestDiagnostic(r.designDiagnostic || null);
      setScoringCompleteSrv(!!r.scoringComplete);
      setLatestBatchStatus(r.latestBatchStatus ?? null);
      if (r.scoringComplete) void fetchIterations();
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
      void fetchMeasureEdits();
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

  const isRunning = batch && batch.status !== "completed" && batch.status !== "failed" && batch.status !== "cancelled";
  const isComplete = batch?.status === "completed";
  // Results are ready to render whenever EITHER the newest batch is completed OR
  // the server computed proposals from the latest completed batch (newest run
  // cancelled/failed/running). Backward-compatible: old servers omit
  // scoringComplete → resultsReady collapses to isComplete (unchanged behavior).
  const resultsReady = isComplete || scoringCompleteSrv;
  // The newest batch is present but not the source of the shown results (e.g. a
  // cancelled auto-rescore) — surface a hint and always offer a manual re-score.
  const staleNewestBatch = resultsReady && !isComplete;

  // ITEM 2: auto-continue the multi-run test-drive. Analyze is async and
  // single-active-batch, so we cannot fire N batches at once — instead, each
  // time a batch completes we kick one rescore, which starts a fresh batch (the
  // completed batch is snapshotted server-side when polling observes it).
  //
  // Overshoot fix: cap on batches STARTED, not on iterations.length. Batches
  // ever started = 1 (initial) + autoRescoreGuard.current (rescores kicked off),
  // so we stop once autoRescoreGuard.current reaches scoringRunsTarget - 1 —
  // giving exactly scoringRunsTarget batches. The second guard
  // (autoRescoreGuard.current >= iterations.length) makes us fire at most once
  // per recorded snapshot, so remounts / extra polls do not double-fire.
  useEffect(() => {
    if (scoringRunsTarget <= 1) return;
    if (!isComplete || rescoring) return;
    if (autoRescoreGuard.current >= scoringRunsTarget - 1) return;
    if (autoRescoreGuard.current >= iterations.length) return;
    autoRescoreGuard.current += 1;
    void triggerRescore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComplete, iterations.length, rescoring, scoringRunsTarget]);

  const multiRunActive = scoringRunsTarget > 1;
  const iterationsRecorded = iterations.length;
  const multiRunDone = multiRunActive && iterationsRecorded >= scoringRunsTarget;

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
        <div className="flex items-center gap-3">
          {batch && (
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {batch.completedJobs}/{batch.totalJobs} companies scored
              {batch.failedJobs > 0 && <span className="text-red-600 ml-2">({batch.failedJobs} failed)</span>}
            </div>
          )}
          {resultsReady && (
            <button
              onClick={() => void triggerRescore()}
              disabled={rescoring}
              className={`px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1 ${rescoring ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-purple-600 text-white hover:bg-purple-700"}`}
              title="Runs a fresh scoring pass on the same companies (use this if the last run was cancelled or you want fresh proposals). Snapshots the current results as an iteration first, then re-scores with the current framework definition."
            >
              {rescoring ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scoring started…</> : <><Play className="w-3.5 h-3.5" /> Run scoring again</>}
            </button>
          )}
        </div>
      </div>
      {staleNewestBatch && !rescoring && (
        <div className="text-xs rounded px-3 py-2 border bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300">
          Showing proposals from the last completed scoring run{latestBatchStatus ? ` (newest run: ${latestBatchStatus})` : ""}. Use “Run scoring again” for a fresh pass.
        </div>
      )}
      {rescoreError && <div className="text-sm text-red-600">Rescore error: {rescoreError}</div>}

      {multiRunActive && (
        <div className={`text-sm rounded px-3 py-2 border ${multiRunDone ? "bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800 text-green-800 dark:text-green-300" : "bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-300"}`}>
          {multiRunDone ? (
            <>Multi-run test-drive complete: {iterationsRecorded} scoring iteration{iterationsRecorded === 1 ? "" : "s"} recorded (target {scoringRunsTarget}). Per-measure flip stats below.</>
          ) : (
            <>
              Multi-run test-drive: {iterationsRecorded} scoring iteration{iterationsRecorded === 1 ? "" : "s"} recorded (target {scoringRunsTarget})
              {(rescoring || isRunning) && " — next iteration scoring…"}
              . The same sample is scored repeatedly so the flip detector can measure run-to-run stability. This runs automatically; you can leave and return to this page.
            </>
          )}
        </div>
      )}

      {error && <div className="text-sm text-red-600">Poll error: {error}</div>}

      {loading && !batch && (
        <div className="text-sm text-gray-500 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading test-drive status…
        </div>
      )}

      {batch && isRunning && (
        <div className="text-sm text-gray-600 dark:text-gray-400">
          Scoring runs asynchronously. Progress updates every 30 seconds. Typical time for 50 companies × 25 measures: 1–2.5 hours.
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

      {/* ─── Test-drive flags (incl. multi-run flip diagnostics) ─── */}
      {resultsReady && report && report.flags.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Test-drive flags ({report.flags.length})
          </div>
          <div className="space-y-2">
            {report.flags.map((f, idx) => (
              <div
                key={`${f.measureId}-${f.rule}-${idx}`}
                className={`rounded border p-3 ${f.severity === "error" ? "border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-900/10" : "border-yellow-200 dark:border-yellow-900 bg-yellow-50/40 dark:bg-yellow-900/10"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-mono text-gray-500">
                    <span className={f.severity === "error" ? "text-red-700 dark:text-red-400" : "text-yellow-700 dark:text-yellow-400"}>{f.severity}</span>
                    {" · "}{f.rule}
                    {f.measureId && <span className="ml-1">· {f.measureId}</span>}
                  </div>
                  {typeof f.flipRate === "number" && (
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      flip rate {(f.flipRate * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <div className="text-sm text-gray-800 dark:text-gray-200 mt-1">{f.message}</div>
                {f.suggestedFix && (
                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    <strong>Suggested fix:</strong> {f.suggestedFix}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── POST-TEST design diagnostic (read-only, advisory) ─── */}
      {resultsReady && postTestDiagnostic && (
        <DesignDiagnosticPanel report={postTestDiagnostic} mode="post-test" />
      )}

      {/* ─── Per-measure run-to-run flip stats (multi-run test-drive) ─── */}
      {resultsReady && flipStats.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Run-to-run flip stats <span className="text-xs font-normal text-gray-500">(across {Math.max(...flipStats.map((s) => s.runs))} scoring iterations)</span>
          </div>
          <div className="border rounded dark:border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/40">
                <tr>
                  <th className="text-left px-3 py-2">Measure</th>
                  <th className="text-right px-3 py-2">Runs</th>
                  <th className="text-right px-3 py-2">Companies compared</th>
                  <th className="text-right px-3 py-2">Flipped</th>
                  <th className="text-right px-3 py-2">Flip rate</th>
                </tr>
              </thead>
              <tbody>
                {flipStats.map((s) => (
                  <tr key={s.measureId} className="border-t dark:border-gray-700">
                    <td className="px-3 py-1.5 font-mono text-xs">{s.measureId}</td>
                    <td className="px-3 py-1.5 text-right">{s.runs}</td>
                    <td className="px-3 py-1.5 text-right">{s.companiesCompared}</td>
                    <td className="px-3 py-1.5 text-right">{s.flippedCount}</td>
                    <td className={`px-3 py-1.5 text-right ${s.flipRate > 0 ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
                      {(s.flipRate * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-xs text-gray-500">
            A non-zero flip rate means a measure gave different verdicts to the same company across identical re-runs — a residual-instability signal that the measure's criteria are ambiguous.
          </div>
        </div>
      )}

      {/* ─── Robustness Criteria Scorecard ─── */}
      {resultsReady && robustness && (
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

      {/* ─── Tier-1 design-time quality metrics ─── */}
      {resultsReady && qualityMetrics && (
        <QualityMetricsPanel
          qm={qualityMetrics}
          nearDupDecisions={nearDupDecisions}
          setNearDupDecisions={setNearDupDecisions}
          frameworkId={frameworkId}
          listId={listId}
        />
      )}

      {/* ─── Iteration history ─── */}
      {resultsReady && iterations.length > 0 && (
        <IterationHistoryView iterations={iterations} />
      )}

      {/* ─── Root-cause diagnostic (doc-collection vs framework issues) ─── */}
      {resultsReady && rootCauses && (
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
      {resultsReady && edits && edits.proposals.length > 0 && (
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
                        {p.measureId === "(framework)" ? (
                          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">Framework-level</span>
                        ) : (
                          <code className="text-xs text-gray-500">{p.measureId}</code>
                        )}
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
                  {/* Framework-level proposals carry mined VALUES (chips) instead of
                      the per-measure evidence drill-down: their target is a jsonb
                      column on `frameworks`, so there are no per-company quotes. */}
                  {p.measureId === "(framework)" && Array.isArray(p.patch?.value) && (p.patch!.value as unknown[]).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-dashed border-gray-200 dark:border-gray-700">
                      <div className="text-xs text-gray-500 mb-1">Values to add to <code>{p.fieldPath}</code>:</div>
                      <div className="flex flex-wrap gap-1">
                        {(p.patch!.value as unknown[]).map((v, vi) => (
                          <span key={vi} className="px-2 py-0.5 rounded-full text-xs bg-purple-50 text-purple-700 border border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800">{String(v)}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {p.measureId !== "(framework)" && (
                  <div className="mt-2 pt-2 border-t border-dashed border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-3 flex-wrap">
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
                      {isExpanded && drillRows[p.measureId] && drillRows[p.measureId].length > 0 && (
                        <button
                          onClick={() => void runTruthCheckAll(p.measureId, drillRows[p.measureId])}
                          disabled={bulkTruthBusy === p.measureId}
                          className={`px-2 py-1 rounded text-[11px] font-medium border ${bulkTruthBusy === p.measureId ? "bg-gray-100 text-gray-400 border-gray-300" : "bg-white hover:bg-blue-50 border-blue-300 text-blue-700"} flex items-center gap-1`}
                          title="Run an independent Perplexity truth-check for every company in this measure. Cached rows are skipped unless you re-check individually."
                        >
                          {bulkTruthBusy === p.measureId ? <><Loader2 className="w-3 h-3 animate-spin" /> Checking all…</> : "🔎 Explore truth for all companies"}
                        </button>
                      )}
                    </div>
                    {isExpanded && (
                      <div className="mt-2">
                        {drillLoading === p.measureId && (
                          <div className="text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading quotes…</div>
                        )}
                        {drillRows[p.measureId] && (
                          <div className="space-y-2 mt-2">
                            {drillRows[p.measureId].map((row, ri) => {
                              const truthKey = `${p.measureId}::${row.companyId}`;
                              const truth = truthResults[truthKey] || row.truth || null;
                              const truthErr = truthErrors[truthKey];
                              const truthBusy = truthLoading[truthKey];
                              // Agreement logic: normalise the four-level truth verdict
                              // (Yes / Partial / No / Evidence absent) to the app's schema
                              // before comparing. Partial and No both mean "not a Yes";
                              // Evidence absent is closer to No than to Partial for user
                              // interpretation. Only flag disagreement when the two land
                              // on materially different sides of the Yes/No divide.
                              const normalise = (v: string): "yes" | "partial" | "no" => {
                                const lc = String(v || "").toLowerCase();
                                if (lc.startsWith("yes")) return "yes";
                                if (lc.startsWith("partial")) return "partial";
                                return "no"; // covers 'No', 'Evidence absent', anything else
                              };
                              const appN = normalise(row.verdict);
                              const truthN = truth ? normalise(truth.verdict) : null;
                              let agreementLabel: null | "agree" | "disagree" | "partial-diff" = null;
                              if (truth) {
                                if (appN === truthN) agreementLabel = "agree";
                                else if ((appN === "no" && truthN === "partial") || (appN === "partial" && truthN === "no")) agreementLabel = "partial-diff";
                                else agreementLabel = "disagree";
                              }
                              const firstDiag = row.quotes.map(parseRetrievalDiagnostic).find(Boolean) || null;
                              const realQuotes = row.quotes.filter((q) => !parseRetrievalDiagnostic(q));
                              return (
                                <div key={ri} className="p-3 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                                  {/* Header row — company + app verdict + Explore truth button */}
                                  <div className="flex items-start justify-between gap-3 pb-2 border-b border-gray-100 dark:border-gray-700">
                                    <div className="flex items-baseline gap-2 flex-wrap">
                                      <span className="font-medium text-gray-900 dark:text-gray-100">{row.companyName}</span>
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${row.verdict === "Yes" ? "bg-green-100 text-green-800" : row.verdict === "Partial" ? "bg-yellow-100 text-yellow-800" : "bg-gray-100 text-gray-700"}`}>app: {row.verdict}</span>
                                      <span className="text-[11px] text-gray-500">confidence {row.confidence}</span>
                                    </div>
                                    <button
                                      onClick={() => void runTruthCheck(p.measureId, row.companyId, !!truth)}
                                      disabled={truthBusy}
                                      className={`px-2 py-1 rounded text-[11px] font-medium border ${truthBusy ? "bg-gray-100 text-gray-400 border-gray-300" : "bg-white hover:bg-blue-50 border-blue-300 text-blue-700"} flex items-center gap-1 whitespace-nowrap`}
                                      title={truth ? "Re-run independent Perplexity search for this cell" : "Run independent Perplexity search against the company's primary reports"}
                                    >
                                      {truthBusy ? <><Loader2 className="w-3 h-3 animate-spin" /> Checking…</> : truth ? "↻ Re-check truth" : "🔎 Explore truth"}
                                    </button>
                                  </div>

                                  {/* Nuance from app scorer, if any */}
                                  {row.nuance && (
                                    <div className="mt-2 text-[11px] text-gray-600 dark:text-gray-400">
                                      <span className="font-medium">Scorer note:</span> {row.nuance.length > 400 ? row.nuance.slice(0, 400) + "…" : row.nuance}
                                    </div>
                                  )}

                                  {/* Real quotes (if the measure surfaced any) */}
                                  {realQuotes.length > 0 && (
                                    <div className="mt-2">
                                      <div className="text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-1">Passages the app used</div>
                                      <ul className="space-y-1.5">
                                        {realQuotes.slice(0, 3).map((q, qi) => {
                                          const t = quoteText(q);
                                          const src = quoteSource(q);
                                          return (
                                            <li key={qi} className="pl-3 border-l-2 border-blue-200 dark:border-blue-800 text-[11px]">
                                              <div className="text-gray-700 dark:text-gray-300">"{t.length > 300 ? t.slice(0, 300) + "…" : t}"</div>
                                              {src && <div className="text-[10px] text-gray-500 italic mt-0.5">source: {src}</div>}
                                            </li>
                                          );
                                        })}
                                        {realQuotes.length > 3 && (<li className="italic text-[11px] text-gray-500">+ {realQuotes.length - 3} more</li>)}
                                      </ul>
                                    </div>
                                  )}

                                  {/* Retrieval diagnostic (when scorer returned No without evidence) */}
                                  {firstDiag && (
                                    <details className="mt-2 text-[11px]">
                                      <summary className="cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-800">
                                        ▸ Retrieval diagnostic: no supporting evidence found
                                        <span className="ml-1 text-gray-400">({firstDiag.chunks} chunks scanned, {firstDiag.topicHits} topic hits across {firstDiag.docBreakdown.length} docs)</span>
                                      </summary>
                                      <div className="mt-1.5 pl-3 border-l-2 border-gray-200 dark:border-gray-600 space-y-1.5">
                                        {firstDiag.docBreakdown.length > 0 && (
                                          <div>
                                            <div className="font-medium text-gray-600">Documents scanned:</div>
                                            <ul className="list-disc pl-5">
                                              {firstDiag.docBreakdown.slice(0, 8).map((d, di) => (
                                                <li key={di}>
                                                  <a href={d.docUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">{d.docUrl.length > 90 ? d.docUrl.slice(0, 90) + "…" : d.docUrl}</a>
                                                  <span className="ml-1 text-gray-500">({d.chunkCount} chunks)</span>
                                                </li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}
                                        {firstDiag.topChunks.length > 0 && (
                                          <div>
                                            <div className="font-medium text-gray-600">Top-scored chunks retriever considered:</div>
                                            <ul className="list-disc pl-5">
                                              {firstDiag.topChunks.slice(0, 5).map((c, ci) => (
                                                <li key={ci}>
                                                  <span className="text-gray-700 dark:text-gray-300">{c.title || "(untitled)"}</span>
                                                  <span className="ml-1 text-gray-500">(score {c.score.toFixed(1)})</span>
                                                </li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}
                                      </div>
                                    </details>
                                  )}
                                  {truthErr && (
                                    <div className="mt-1 text-red-600 text-xs">Truth-check error: {truthErr}</div>
                                  )}
                                  {truth && (
                                    <div className={`mt-2 p-2 rounded border ${agreementLabel === "agree" ? "border-green-300 bg-green-50 dark:bg-green-900/20" : agreementLabel === "partial-diff" ? "border-blue-300 bg-blue-50 dark:bg-blue-900/20" : "border-amber-300 bg-amber-50 dark:bg-amber-900/20"}`}>
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-medium text-gray-800 dark:text-gray-200">Independent truth check</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${truth.verdict === "Yes" ? "bg-green-200 text-green-900" : truth.verdict === "Partial" ? "bg-yellow-200 text-yellow-900" : truth.verdict === "Evidence absent" ? "bg-gray-200 text-gray-700" : "bg-red-200 text-red-900"}`}>truth: {truth.verdict}</span>
                                        <span className="text-gray-500">confidence: {truth.confidence}</span>
                                        {agreementLabel === "agree" && <span className="text-green-700">✓ agrees with app</span>}
                                        {agreementLabel === "partial-diff" && (
                                          <span className="text-blue-700" title="Both agree it isn't a clear Yes; one calls it 'Partial' the other 'No/Evidence absent'">◐ aligned within ‘not Yes’</span>
                                        )}
                                        {agreementLabel === "disagree" && <span className="text-amber-700">⚠ disagrees with app</span>}
                                      </div>
                                      {truth.reasoning && (
                                        <div className="mt-1 text-gray-700 dark:text-gray-300">{truth.reasoning}</div>
                                      )}
                                      {truth.quotes && truth.quotes.length > 0 && (
                                        <div className="mt-1">
                                          <div className="text-gray-600 dark:text-gray-400 font-medium">Primary-source quotes:</div>
                                          <ul className="list-disc pl-5">
                                            {truth.quotes.slice(0, 3).map((q, qi) => {
                                              const t = quoteText(q);
                                              return (<li key={qi} className="text-gray-700 dark:text-gray-300">"{t.length > 400 ? t.slice(0, 400) + "…" : t}"</li>);
                                            })}
                                          </ul>
                                        </div>
                                      )}
                                      {truth.sources && truth.sources.length > 0 && (
                                        <div className="mt-1">
                                          <div className="text-gray-600 dark:text-gray-400 font-medium">Sources:</div>
                                          <ol className="list-decimal pl-5">
                                            {truth.sources.slice(0, 8).map((s, si) => (<li key={si}><a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">{s.title || s.url}</a></li>))}
                                            {truth.sources.length > 8 && (<li className="italic text-gray-500">+ {truth.sources.length - 8} more</li>)}
                                          </ol>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {resultsReady && report && report.flags.length === 0 && (
        <div className="text-sm text-green-700 dark:text-green-400">
          No calibration flags. The framework's observed Yes rates are within the expected envelope for every measure. Ready for wider testing.
        </div>
      )}

      {resultsReady && edits && edits.proposals.length > 0 && (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-gray-500">
              When ready, apply {acceptedCount} accepted edit{acceptedCount === 1 ? "" : "s"} to regenerate affected measures and re-score. Rejected edits are dropped. LLM regenerations run in one batched call per patch type.
            </div>
            <button
              onClick={() => void applyAcceptedAndIterate()}
              disabled={acceptedCount === 0 || applyingIterate}
              className={`px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1 ${(acceptedCount === 0 || applyingIterate) ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-purple-600 text-white hover:bg-purple-700"}`}
              title={acceptedCount === 0 ? "Accept at least one edit to enable iteration" : "Apply accepted edits and immediately re-score"}
            >
              {applyingIterate ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying…</> : `Apply ${acceptedCount} edit${acceptedCount === 1 ? "" : "s"} → iterate`}
            </button>
          </div>
          {applyIterateResult && <div className="text-xs text-green-700 dark:text-green-400">{applyIterateResult}</div>}
          {applyIterateError && <div className="text-xs text-red-600">{applyIterateError}</div>}
        </div>
      )}

      {/* ─── Recent edits (edit-audit) ─── */}
      {measureEdits.length > 0 && (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
            <button onClick={() => setMeasureEditsOpen((o) => !o)} className="flex items-center gap-2">
              <span>{measureEditsOpen ? "▾" : "▸"}</span>
              Recent edits
              <span className="text-xs font-normal text-gray-500">
                ({measureEdits.length} logged
                {(() => {
                  const skippedN = measureEdits.filter((e) => !e.applied).length;
                  return skippedN > 0 ? `, ${skippedN} skipped` : "";
                })()})
              </span>
            </button>
            <button
              onClick={() => void fetchMeasureEdits()}
              className="text-xs font-normal text-purple-600 hover:underline"
              title="Refresh the edit-audit log"
            >
              refresh
            </button>
          </div>
          {measureEditsOpen && (
            <div className="mt-2 max-h-72 overflow-auto rounded border border-gray-200 dark:border-gray-700">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-900 text-gray-500 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1 font-medium">Measure</th>
                    <th className="text-left px-2 py-1 font-medium">Field</th>
                    <th className="text-left px-2 py-1 font-medium">Op</th>
                    <th className="text-left px-2 py-1 font-medium">Outcome</th>
                    <th className="text-left px-2 py-1 font-medium">Source</th>
                    <th className="text-left px-2 py-1 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {measureEdits.map((e) => (
                    <tr
                      key={e.id}
                      className={`border-t border-gray-100 dark:border-gray-800 ${e.applied ? "" : "bg-amber-50 dark:bg-amber-950/30"}`}
                    >
                      <td className="px-2 py-1 font-mono">{e.measureId}</td>
                      <td className="px-2 py-1">{e.field}</td>
                      <td className="px-2 py-1 text-gray-500">{e.op || "—"}</td>
                      <td className="px-2 py-1">
                        {e.applied ? (
                          <span className="text-green-700 dark:text-green-400">applied</span>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400" title={e.skipReason || "skipped"}>
                            skipped{e.skipReason ? `: ${e.skipReason}` : ""}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-gray-500 font-mono">{e.source}</td>
                      <td className="px-2 py-1 text-gray-500 whitespace-nowrap">
                        {e.createdAt ? new Date(e.createdAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─── Improvement chat (Stage 2) ─── */}
      {resultsReady && (
        <ImprovementChat frameworkId={frameworkId} listId={listId} onApplied={() => void fetchMeasureEdits()} />
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

// Turn an /improvement/apply response into a single user-legible line that
// always states what was applied AND why anything was skipped (requirement D:
// no silent no-ops — every action reports a definite outcome).
function summariseApplyResult(resp: any): string {
  const applied = resp?.appliedCount ?? (resp?.applied?.length || 0);
  const skipped = resp?.skippedCount ?? (resp?.skipped?.length || 0);
  let s = `Applied ${applied} change${applied === 1 ? "" : "s"}, ${skipped} skipped.`;
  const reasons: string[] = (resp?.skipped || []).map((k: any) => k?.reason).filter(Boolean);
  if (reasons.length) {
    s += " Skipped: " + reasons.slice(0, 5).join("; ") + (reasons.length > 5 ? ` (+${reasons.length - 5} more)` : "");
  }
  return s;
}

// ─── Tier-1 design-time quality metrics panel ───
// Renders the MAXIMISE metrics (reliability, coherence redundancy), the GATE
// metrics (discrimination, coverage, auditability, robustness, transparency,
// coherence gates), the per-dimension Q composite with its weight-sensitivity
// guard, the per-indicator table, and the selectable near-duplicate list.
// GATE thresholds are DEFERRED placeholders, so gates render as observed values
// with a "threshold deferred" note rather than hard pass/fail.
function QualityMetricsPanel({
  qm,
  nearDupDecisions,
  setNearDupDecisions,
  frameworkId,
  listId,
}: {
  qm: QualityMetricsReport;
  nearDupDecisions: Record<string, "accept" | "dismiss">;
  setNearDupDecisions: React.Dispatch<React.SetStateAction<Record<string, "accept" | "dismiss">>>;
  frameworkId: number;
  listId: number;
}) {
  // Per-pair apply status (requirement D: every merge/differentiate reports a
  // definite, user-legible outcome — never a silent selection).
  const [nearDupResult, setNearDupResult] = useState<Record<string, string>>({});
  const [nearDupBusy, setNearDupBusy] = useState<Record<string, boolean>>({});
  const applyNearDup = async (key: string, measureA: string, measureB: string, mode: "merge" | "differentiate") => {
    setNearDupBusy((s) => ({ ...s, [key]: true }));
    setNearDupResult((s) => ({ ...s, [key]: "" }));
    try {
      const resp = await api.request("/framework-builder/v2/improvement/apply", {
        method: "POST",
        body: JSON.stringify({ frameworkId, listId, actions: [{ type: "merge_or_differentiate", attrs: { measureA, measureB, mode } }] }),
      });
      setNearDupResult((s) => ({ ...s, [key]: summariseApplyResult(resp) }));
      setNearDupDecisions((s) => ({ ...s, [key]: "accept" }));
    } catch (e: any) {
      setNearDupResult((s) => ({ ...s, [key]: `Failed: ${e?.message || "error"}` }));
    } finally {
      setNearDupBusy((s) => ({ ...s, [key]: false }));
    }
  };
  const fmt = (v: number | null, digits = 2): string => (v == null ? "—" : v.toFixed(digits));
  const dimLabel: Record<string, string> = {
    reliability: "Reliability",
    coherenceRedundancy: "Coherence (non-redundancy)",
    accuracy: "Accuracy / discrimination",
  };

  const maximiseCards = (metrics: QMaximiseMetric[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {metrics.map((m) => (
        <div key={m.id} className="p-2.5 border rounded text-sm border-blue-200 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-800">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-900 dark:text-gray-100">{m.label}</span>
            <span className="text-[10px] uppercase tracking-wide text-blue-700 dark:text-blue-300 font-semibold">maximise</span>
          </div>
          <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium">Observed:</span> {m.observed}
            {m.status && <span className="ml-1.5 italic text-gray-500">({m.status})</span>}
          </div>
          <div className="mt-1 text-xs text-gray-500">{m.detail}</div>
        </div>
      ))}
    </div>
  );

  const gateCards = (metrics: QGateMetric[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {metrics.map((m) => (
        <div key={m.id} className="p-2.5 border rounded text-sm border-gray-300 bg-gray-50 dark:bg-gray-800/40 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <span className="font-medium text-gray-900 dark:text-gray-100">{m.label}</span>
            <span className="text-[10px] uppercase tracking-wide text-gray-600 dark:text-gray-400 font-semibold">gate</span>
          </div>
          <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium">Observed:</span> {m.observed}
            {m.status && <span className="ml-1.5 italic text-gray-500">({m.status})</span>}
          </div>
          <div className="mt-1 text-xs text-gray-500">{m.detail}</div>
          <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400 italic">
            Threshold deferred — value reported, not gated ({m.thresholdDirection})
          </div>
        </div>
      ))}
    </div>
  );

  const allGates: QGateMetric[] = [
    ...(qm.discrimination || []),
    ...(qm.coverage || []),
    ...(qm.auditability || []),
    ...(qm.robustness || []),
    ...(qm.transparency || []),
    ...(qm.coherenceGates || []),
  ];

  return (
    <div className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Design-time quality metrics (Tier-1)
          <span className="ml-2 text-xs font-normal text-gray-500">
            N = {qm.n} companies · {qm.runs} run{qm.runs === 1 ? "" : "s"}
          </span>
        </div>
        <span className="text-xs text-amber-700 dark:text-amber-400 italic">
          Thresholds deferred — metrics reported for calibration, not enforced as pass/fail
        </span>
      </div>

      {/* Q composite by dimension */}
      <div className="space-y-2">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
          Composite quality Q
          <span className="ml-2 text-base font-semibold text-indigo-700 dark:text-indigo-300">{fmt(qm.q.Q)}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {qm.q.dimensions.map((d) => (
            <div key={d.dimension} className="p-2.5 border rounded text-sm border-indigo-200 bg-indigo-50 dark:bg-indigo-900/20 dark:border-indigo-800">
              <div className="font-medium text-gray-900 dark:text-gray-100">{dimLabel[d.dimension] || d.dimension}</div>
              <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                S<sub>d</sub> = <span className="font-medium">{fmt(d.S_d)}</span>
                <span className="mx-1.5 text-gray-400">|</span>
                w<sub>d</sub> = {fmt(d.weight)}
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                mean ρ = {fmt(d.meanRho)} · {d.indicatorCount} indicator{d.indicatorCount === 1 ? "" : "s"}
                {d.status && <span className="ml-1 italic">({d.status})</span>}
              </div>
            </div>
          ))}
        </div>
        <div className={`text-xs ${qm.q.weightSensitivity.stable ? "text-gray-500" : "text-amber-700 dark:text-amber-400"}`}>
          {qm.q.weightSensitivity.stable ? "✓ " : "⚠ "}
          {qm.q.weightSensitivity.note}
        </div>
        <div className="text-[11px] text-gray-500 italic">{qm.q.note}</div>
      </div>

      {/* MAXIMISE metrics */}
      {qm.reliability.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Reliability (maximise)</div>
          {maximiseCards(qm.reliability)}
        </div>
      )}
      {qm.coherenceRedundancy.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Coherence — non-redundancy (maximise)</div>
          {maximiseCards(qm.coherenceRedundancy)}
        </div>
      )}

      {/* GATE metrics */}
      {allGates.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Gate metrics <span className="text-xs font-normal text-gray-500">(discrimination · coverage · auditability · robustness · transparency · coherence)</span>
          </div>
          {gateCards(allGates)}
        </div>
      )}

      {/* Near-duplicate pairs — selectable merge/differentiate */}
      {qm.nearDuplicatePairs.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Near-duplicate indicator pairs <span className="text-xs font-normal text-gray-500">(select to merge or differentiate — nothing is auto-applied)</span>
          </div>
          <div className="space-y-1.5">
            {qm.nearDuplicatePairs.map((p) => {
              const key = `${p.measureIdA}::${p.measureIdB}`;
              const decision = nearDupDecisions[key];
              const busy = nearDupBusy[key];
              const result = nearDupResult[key];
              return (
                <div key={key} className="p-2.5 border rounded text-sm border-orange-200 bg-orange-50 dark:bg-orange-900/20 dark:border-orange-800">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-gray-900 dark:text-gray-100">
                      <span className="font-medium">{p.labelA}</span> ↔ <span className="font-medium">{p.labelB}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => applyNearDup(key, p.measureIdA, p.measureIdB, "merge")}
                        className="px-2 py-0.5 rounded text-xs border border-orange-400 text-orange-700 dark:text-orange-300 disabled:opacity-50"
                      >
                        {busy ? "…" : "Merge"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => applyNearDup(key, p.measureIdA, p.measureIdB, "differentiate")}
                        className="px-2 py-0.5 rounded text-xs border border-orange-400 text-orange-700 dark:text-orange-300 disabled:opacity-50"
                      >
                        {busy ? "…" : "Differentiate"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setNearDupDecisions((s) => ({ ...s, [key]: "dismiss" }))}
                        className={`px-2 py-0.5 rounded text-xs border ${decision === "dismiss" ? "bg-gray-600 text-white border-gray-600" : "border-gray-400 text-gray-600 dark:text-gray-300"}`}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    agreement {(p.agreement * 100).toFixed(0)}% · κ = {p.kappa.toFixed(2)} · n = {p.n}
                  </div>
                  {result && <div className="mt-1 text-xs font-medium text-orange-800 dark:text-orange-300">{result}</div>}
                  {decision === "dismiss" && !result && <div className="mt-1 text-xs text-gray-500">Dismissed — no change applied.</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-indicator table */}
      {qm.perIndicator.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Per-indicator metrics</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs border border-gray-200 dark:border-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-600 dark:text-gray-400">
                <tr>
                  <th className="px-2 py-1.5 text-left">Indicator</th>
                  <th className="px-2 py-1.5 text-right">Pass rate</th>
                  <th className="px-2 py-1.5 text-center">In band</th>
                  <th className="px-2 py-1.5 text-right">Answerability</th>
                  <th className="px-2 py-1.5 text-right">Cell stability</th>
                  <th className="px-2 py-1.5 text-right">κ (run-pair)</th>
                  <th className="px-2 py-1.5 text-right">Spec completeness</th>
                </tr>
              </thead>
              <tbody>
                {qm.perIndicator.map((m) => (
                  <tr key={m.measureId} className="border-t border-gray-200 dark:border-gray-700">
                    <td className="px-2 py-1.5 text-gray-900 dark:text-gray-100">{m.label}</td>
                    <td className="px-2 py-1.5 text-right">{(m.passRate * 100).toFixed(0)}%</td>
                    <td className="px-2 py-1.5 text-center">{m.inInformationBand ? "✓" : "—"}</td>
                    <td className="px-2 py-1.5 text-right">{(m.answerability * 100).toFixed(0)}%</td>
                    <td className="px-2 py-1.5 text-right">{fmt(m.cellStability)}</td>
                    <td className="px-2 py-1.5 text-right">{fmt(m.kappa)}</td>
                    <td className="px-2 py-1.5 text-right">{fmt(m.specCompleteness)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Iteration history view (Q3) ───
// Shows how Yes-rate per company changed across iterations, and how many
// robustness criteria passed each iteration. Latest iteration is on the right.
// Delta arrows highlight companies moving up or down between iterations.
function IterationHistoryView({ iterations }: { iterations: IterationSnapshot[] }) {
  if (!iterations.length) return null;

  // Union of all company IDs across iterations, ordered by latest yes-count desc
  const allCompanyIds = new Set<number>();
  for (const it of iterations) for (const c of it.perCompany) allCompanyIds.add(c.companyId);
  const latest = iterations[iterations.length - 1];
  const orderedCompanyIds = Array.from(allCompanyIds).sort((a, b) => {
    const av = latest.perCompany.find((c) => c.companyId === a)?.yesCount ?? -1;
    const bv = latest.perCompany.find((c) => c.companyId === b)?.yesCount ?? -1;
    return bv - av;
  });
  const companyName = (cid: number): string => {
    for (let i = iterations.length - 1; i >= 0; i--) {
      const c = iterations[i].perCompany.find((x) => x.companyId === cid);
      if (c) return c.companyName;
    }
    return "?";
  };

  const yesRate = (it: IterationSnapshot, cid: number): number | null => {
    const c = it.perCompany.find((x) => x.companyId === cid);
    return c ? c.yesRate : null;
  };

  const passedCount = (it: IterationSnapshot): string => {
    if (!it.robustness) return "n/a";
    return `${it.robustness.passedCount}/${it.robustness.totalCount}`;
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
        Iteration history
        <span className="ml-2 text-xs font-normal text-gray-500">
          {iterations.length} iteration{iterations.length === 1 ? "" : "s"} recorded; latest on the right
        </span>
      </div>
      <div className="border rounded dark:border-gray-700 overflow-x-auto text-sm">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-900/40">
            <tr>
              <th className="text-left px-3 py-2 sticky left-0 bg-gray-50 dark:bg-gray-900/40">Company</th>
              {iterations.map((it) => (
                <th key={it.id} className="text-right px-3 py-2">
                  <div className="whitespace-nowrap">Iter {it.iterationNumber}</div>
                  <div className="text-[10px] font-normal text-gray-500">{new Date(it.scoredAt).toLocaleString()}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orderedCompanyIds.map((cid) => (
              <tr key={cid} className="border-t dark:border-gray-700">
                <td className="px-3 py-1.5 whitespace-nowrap sticky left-0 bg-white dark:bg-gray-800">{companyName(cid)}</td>
                {iterations.map((it, idx) => {
                  const rate = yesRate(it, cid);
                  const prevRate = idx > 0 ? yesRate(iterations[idx - 1], cid) : null;
                  const delta = rate != null && prevRate != null ? rate - prevRate : null;
                  return (
                    <td key={it.id} className="px-3 py-1.5 text-right">
                      {rate == null ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <>
                          <span>{(rate * 100).toFixed(0)}%</span>
                          {delta != null && Math.abs(delta) >= 0.05 && (
                            <span className={`ml-1 text-xs ${delta > 0 ? "text-green-600" : "text-red-600"}`}>
                              {delta > 0 ? "▲" : "▼"}{Math.abs(delta * 100).toFixed(0)}pp
                            </span>
                          )}
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t-2 border-gray-300 dark:border-gray-500 bg-gray-50 dark:bg-gray-900/40 font-medium">
              <td className="px-3 py-1.5 sticky left-0 bg-gray-50 dark:bg-gray-900/40">Robustness criteria passed</td>
              {iterations.map((it) => (
                <td key={it.id} className="px-3 py-1.5 text-right">{passedCount(it)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImprovementChat({ frameworkId, listId, onApplied }: { frameworkId: number; listId: number; onApplied?: () => void }) {
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
      const summary = summariseApplyResult(resp);
      setApplyResult(summary);
      // Echo the definite outcome back into the transcript (requirement D).
      setTurns((t) => [...t, { role: "assistant", content: `✓ ${summary}` }]);
      // Refresh the edit-audit so any silently-skipped accepts become visible.
      onApplied?.();
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
                    {a.type === "apply_custom_edit" && `Apply edit: ${a.attrs.measure} · ${a.attrs.field}`}
                    {a.type === "merge_or_differentiate" && `${a.attrs.mode === "merge" ? "Merge" : "Differentiate"}: ${a.attrs.measureA} ↔ ${a.attrs.measureB}`}
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

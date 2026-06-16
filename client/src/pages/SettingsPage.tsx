import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Plus, Trash2, Key, Globe, Settings, Activity, Shield, Ban, Edit2, Check, X, ToggleLeft, ToggleRight, Users, Server, Search, Sparkles, RotateCcw } from "lucide-react";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"pipeline" | "trusted" | "excluded" | "platform" | "queue" | "users">("pipeline");

  const tabs = [
    { id: "pipeline" as const, label: "Pipeline Settings", icon: Settings },
    { id: "trusted" as const, label: "Trusted Sources", icon: Shield },
    { id: "excluded" as const, label: "Excluded Sources", icon: Ban },
    { id: "platform" as const, label: "Platform Sources", icon: Server },
    { id: "users" as const, label: "Users", icon: Users },
    { id: "queue" as const, label: "Queue & API Keys", icon: Activity },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition ${
              activeTab === tab.id
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "pipeline" && <PipelineSettings />}
      {activeTab === "trusted" && <TrustedSourcesPanel />}
      {activeTab === "excluded" && <ExcludedSourcesPanel />}
      {activeTab === "platform" && <PlatformSourcesPanel />}
      {activeTab === "users" && <UsersPanel />}
      {activeTab === "queue" && <QueuePanel />}
    </div>
  );
}

// ─── Pipeline Settings ────────────────────────────────────────────────────────

function PipelineSettings() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const setSettingMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.setSetting(key, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  if (isLoading) return <div className="text-gray-400 text-sm">Loading settings...</div>;

  const toggleSetting = (key: string, currentValue: string) => {
    const newValue = currentValue === "true" ? "false" : "true";
    setSettingMutation.mutate({ key, value: newValue });
  };

  const updateSetting = (key: string, value: string) => {
    setSettingMutation.mutate({ key, value });
  };

  return (
    <div className="space-y-6">
      {/* Scoring Configuration */}
      <div className="bg-white rounded-lg border p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Scoring Configuration</h2>
        <div className="space-y-4">
          {/* Ensemble Scoring Toggle */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Ensemble Scoring</div>
              <div className="text-sm text-gray-500">Use multiple LLMs and aggregate results (any-pass-wins)</div>
            </div>
            <button
              onClick={() => toggleSetting("ensemble_scoring", settings?.ensemble_scoring || "false")}
              className="flex items-center"
            >
              {settings?.ensemble_scoring === "true" ? (
                <ToggleRight className="w-8 h-8 text-green-600" />
              ) : (
                <ToggleLeft className="w-8 h-8 text-gray-400" />
              )}
            </button>
          </div>

          {/* Ensemble Iterations */}
          {settings?.ensemble_scoring === "true" && (
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
              <div>
                <div className="font-medium text-gray-900">Ensemble Iterations</div>
                <div className="text-sm text-gray-500">Number of LLMs to use for scoring</div>
              </div>
              <select
                value={settings?.ensemble_iterations || "3"}
                onChange={(e) => updateSetting("ensemble_iterations", e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-sm"
              >
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="5">5</option>
              </select>
            </div>
          )}

          {/* Scoring Mode */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Scoring Mode</div>
              <div className="text-sm text-gray-500">How measures are scored (binary = 0 or 1)</div>
            </div>
            <select
              value={settings?.scoring_mode || "binary"}
              onChange={(e) => updateSetting("scoring_mode", e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              <option value="binary">Binary (0/1)</option>
              <option value="partial">Partial (0-1)</option>
            </select>
          </div>

          {/* Low-Confidence Handling */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Low-Confidence Positive Handling</div>
              <div className="text-sm text-gray-500">What to do when a positive score has Low confidence (e.g. unverified quotes)</div>
            </div>
            <select
              value={settings?.low_confidence_handling || "downgrade"}
              onChange={(e) => updateSetting("low_confidence_handling", e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              <option value="downgrade">Downgrade to Partial</option>
              <option value="flag">Flag for Review</option>
              <option value="keep">Keep as-is</option>
            </select>
          </div>

          {/* Primary Scoring Provider */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Primary Scoring Provider</div>
              <div className="text-sm text-gray-500">Main LLM used for scoring</div>
            </div>
            <select
              value={settings?.scoring_provider || "deepseek"}
              onChange={(e) => updateSetting("scoring_provider", e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              <option value="deepseek">DeepSeek</option>
              <option value="claude">Claude</option>
              <option value="openai">OpenAI (GPT-4o)</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>
        </div>
      </div>

      {/* Ensemble LLM Configuration */}
      {settings?.ensemble_scoring === "true" && (
        <div className="bg-white rounded-lg border p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Ensemble LLM Providers</h2>
          <p className="text-sm text-gray-500 mb-4">
            Configure which LLMs are used in ensemble scoring. Each measure is scored by all providers, and the result passes if any provider finds evidence.
          </p>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <span className="text-sm font-medium text-gray-600 w-20">Provider {i}</span>
                <select
                  value={settings?.[`pipeline_llm_${i}`] || (i === 1 ? "deepseek" : i === 2 ? "claude" : "gemini")}
                  onChange={(e) => updateSetting(`pipeline_llm_${i}`, e.target.value)}
                  className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
                >
                  <option value="deepseek">DeepSeek</option>
                  <option value="claude">Claude (Sonnet)</option>
                  <option value="openai">OpenAI (GPT-4o)</option>
                  <option value="gemini">Gemini</option>
                  <option value="claude-haiku">Claude Haiku</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Discovery Settings */}
      <div className="bg-white rounded-lg border p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Discovery & Retrieval</h2>
        <div className="space-y-4">
          {/* Search Depth */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Search Depth</div>
              <div className="text-sm text-gray-500">Number of results per search query (higher = more documents found, slower)</div>
            </div>
            <select
              value={settings?.search_depth || "10"}
              onChange={(e) => updateSetting("search_depth", e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              <option value="5">5 (fast)</option>
              <option value="10">10 (standard)</option>
              <option value="15">15</option>
              <option value="20">20 (thorough)</option>
              <option value="30">30 (comprehensive)</option>
            </select>
          </div>

          {/* Query Variants */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Discovery Query Variants</div>
              <div className="text-sm text-gray-500">Number of LLM-generated alternative search queries per company (improves coverage)</div>
            </div>
            <select
              value={settings?.discovery_query_variants || "3"}
              onChange={(e) => updateSetting("discovery_query_variants", e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              <option value="0">Disabled</option>
              <option value="2">2 variants</option>
              <option value="3">3 variants</option>
              <option value="5">5 variants</option>
              <option value="8">8 variants (slow)</option>
            </select>
          </div>

          {/* Auto-Pin Sources */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Auto-Pin Evidence Sources</div>
              <div className="text-sm text-gray-500">Automatically pin URLs that provide evidence, ensuring they are always re-checked in future runs</div>
            </div>
            <button
              onClick={() => toggleSetting("auto_pin_sources", settings?.auto_pin_sources || "false")}
              className="flex items-center"
            >
              {settings?.auto_pin_sources === "true" ? (
                <ToggleRight className="w-8 h-8 text-green-600" />
              ) : (
                <ToggleLeft className="w-8 h-8 text-gray-400" />
              )}
            </button>
          </div>

          {/* BM25 Retrieval */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">BM25 Passage Retrieval</div>
              <div className="text-sm text-gray-500">Use BM25 to find relevant passages before scoring</div>
            </div>
            <button
              onClick={() => toggleSetting("use_bm25_retrieval", settings?.use_bm25_retrieval || "false")}
              className="flex items-center"
            >
              {settings?.use_bm25_retrieval === "true" ? (
                <ToggleRight className="w-8 h-8 text-green-600" />
              ) : (
                <ToggleLeft className="w-8 h-8 text-gray-400" />
              )}
            </button>
          </div>

          {/* Terminology Discovery */}
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div>
              <div className="font-medium text-gray-900">Terminology Discovery</div>
              <div className="text-sm text-gray-500">Discover company-specific terminology before scoring</div>
            </div>
            <button
              onClick={() => toggleSetting("terminology_discovery_enabled", settings?.terminology_discovery_enabled || "false")}
              className="flex items-center"
            >
              {settings?.terminology_discovery_enabled === "true" ? (
                <ToggleRight className="w-8 h-8 text-green-600" />
              ) : (
                <ToggleLeft className="w-8 h-8 text-gray-400" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Trusted Sources Panel ────────────────────────────────────────────────────

function TrustedSourcesPanel() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: "", domain: "", description: "" });

  const { data: sources } = useQuery({
    queryKey: ["trustedSources"],
    queryFn: api.getTrustedSources,
  });

  const addMutation = useMutation({
    mutationFn: () => api.addTrustedSource(newName, newDomain, newDescription),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trustedSources"] });
      setNewName("");
      setNewDomain("");
      setNewDescription("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => api.updateTrustedSource(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trustedSources"] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteTrustedSource(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["trustedSources"] }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api.updateTrustedSource(id, { isActive: !isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["trustedSources"] }),
  });

  const startEdit = (source: any) => {
    setEditingId(source.id);
    setEditForm({ name: source.name, domain: source.domain, description: source.description || "" });
  };

  return (
    <div className="bg-white rounded-lg border p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900 mb-2">Trusted Sources</h2>
        <p className="text-sm text-gray-500 mb-4">
          Documents from these domains receive priority in discovery. The system searches these domains for each company during analysis. Toggle sources on/off, or edit their details.
        </p>
      </div>

      {/* Add Source Form */}
      <div className="p-4 bg-blue-50 rounded-lg border border-blue-100 space-y-2">
        <div className="text-sm font-medium text-blue-900 mb-2">Add New Trusted Source</div>
        <div className="grid grid-cols-3 gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (e.g., CDP)"
            className="px-3 py-2 border rounded-lg text-sm"
          />
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="Domain (e.g., cdp.net)"
            className="px-3 py-2 border rounded-lg text-sm"
          />
          <input
            type="text"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Description (optional)"
            className="px-3 py-2 border rounded-lg text-sm"
          />
        </div>
        <button
          onClick={() => addMutation.mutate()}
          disabled={!newName || !newDomain}
          className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" /> Add Source
        </button>
      </div>

      {/* Source List */}
      <div className="border rounded-lg divide-y">
        <div className="px-4 py-2 bg-gray-50 grid grid-cols-12 gap-2 text-xs font-medium text-gray-500 uppercase">
          <div className="col-span-1">Active</div>
          <div className="col-span-2">Name</div>
          <div className="col-span-3">Domain</div>
          <div className="col-span-4">Description</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>
        {sources?.map((source: any) => (
          <div key={source.id} className="px-4 py-3 grid grid-cols-12 gap-2 items-center group">
            {editingId === source.id ? (
              <>
                <div className="col-span-1" />
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="col-span-2 px-2 py-1 border rounded text-sm"
                />
                <input
                  value={editForm.domain}
                  onChange={(e) => setEditForm({ ...editForm, domain: e.target.value })}
                  className="col-span-3 px-2 py-1 border rounded text-sm"
                />
                <input
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  className="col-span-4 px-2 py-1 border rounded text-sm"
                />
                <div className="col-span-2 flex justify-end gap-1">
                  <button
                    onClick={() => updateMutation.mutate({ id: source.id, data: editForm })}
                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="p-1 text-gray-400 hover:bg-gray-100 rounded"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="col-span-1">
                  <button
                    onClick={() => toggleActiveMutation.mutate({ id: source.id, isActive: source.isActive })}
                  >
                    {source.isActive ? (
                      <ToggleRight className="w-5 h-5 text-green-600" />
                    ) : (
                      <ToggleLeft className="w-5 h-5 text-gray-400" />
                    )}
                  </button>
                </div>
                <div className={`col-span-2 text-sm font-medium ${source.isActive ? "text-gray-900" : "text-gray-400"}`}>
                  {source.name}
                </div>
                <div className={`col-span-3 text-sm font-mono ${source.isActive ? "text-gray-600" : "text-gray-400"}`}>
                  {source.domain}
                </div>
                <div className={`col-span-4 text-xs ${source.isActive ? "text-gray-500" : "text-gray-400"}`}>
                  {source.description || "—"}
                </div>
                <div className="col-span-2 flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(source)}
                    className="p-1 text-blue-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => deleteMutation.mutate(source.id)}
                    className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {(!sources || sources.length === 0) && (
          <div className="p-6 text-center text-gray-400 text-sm">
            No trusted sources configured. Add sources above to prioritize specific domains during discovery.
          </div>
        )}
      </div>
      <div className="text-xs text-gray-400">
        {sources?.length || 0} trusted sources configured. Active sources are searched during document discovery for each company.
      </div>
    </div>
  );
}

// ─── Excluded Sources Panel ───────────────────────────────────────────────────

function ExcludedSourcesPanel() {
  const queryClient = useQueryClient();
  const [newDomain, setNewDomain] = useState("");
  const [newReason, setNewReason] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ domain: "", reason: "" });

  const { data: sources } = useQuery({
    queryKey: ["excludedSources"],
    queryFn: api.getExcludedSources,
  });

  const addMutation = useMutation({
    mutationFn: () => api.addExcludedSource(newDomain, newReason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["excludedSources"] });
      setNewDomain("");
      setNewReason("");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => api.updateExcludedSource(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["excludedSources"] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteExcludedSource(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["excludedSources"] }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api.updateExcludedSource(id, { isActive: !isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["excludedSources"] }),
  });

  const startEdit = (source: any) => {
    setEditingId(source.id);
    setEditForm({ domain: source.domain, reason: source.reason || "" });
  };

  return (
    <div className="bg-white rounded-lg border p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900 mb-2">Excluded Sources</h2>
        <p className="text-sm text-gray-500 mb-4">
          Documents from these domains will be filtered out during discovery. Use this to block irrelevant or noisy sources that pollute results.
        </p>
      </div>

      {/* Add Excluded Source Form */}
      <div className="p-4 bg-red-50 rounded-lg border border-red-100 space-y-2">
        <div className="text-sm font-medium text-red-900 mb-2">Add Excluded Domain</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="Domain to exclude (e.g., linkedin.com)"
            className="px-3 py-2 border rounded-lg text-sm"
          />
          <input
            type="text"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            placeholder="Reason (optional)"
            className="px-3 py-2 border rounded-lg text-sm"
          />
        </div>
        <button
          onClick={() => addMutation.mutate()}
          disabled={!newDomain}
          className="flex items-center gap-1 px-3 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 disabled:opacity-50"
        >
          <Ban className="w-4 h-4" /> Exclude Domain
        </button>
      </div>

      {/* Excluded List */}
      <div className="border rounded-lg divide-y">
        <div className="px-4 py-2 bg-gray-50 grid grid-cols-12 gap-2 text-xs font-medium text-gray-500 uppercase">
          <div className="col-span-1">Active</div>
          <div className="col-span-4">Domain</div>
          <div className="col-span-5">Reason</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>
        {sources?.map((source: any) => (
          <div key={source.id} className="px-4 py-3 grid grid-cols-12 gap-2 items-center group">
            {editingId === source.id ? (
              <>
                <div className="col-span-1" />
                <input
                  value={editForm.domain}
                  onChange={(e) => setEditForm({ ...editForm, domain: e.target.value })}
                  className="col-span-4 px-2 py-1 border rounded text-sm"
                />
                <input
                  value={editForm.reason}
                  onChange={(e) => setEditForm({ ...editForm, reason: e.target.value })}
                  className="col-span-5 px-2 py-1 border rounded text-sm"
                />
                <div className="col-span-2 flex justify-end gap-1">
                  <button
                    onClick={() => updateMutation.mutate({ id: source.id, data: editForm })}
                    className="p-1 text-green-600 hover:bg-green-50 rounded"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="p-1 text-gray-400 hover:bg-gray-100 rounded"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="col-span-1">
                  <button
                    onClick={() => toggleActiveMutation.mutate({ id: source.id, isActive: source.isActive })}
                  >
                    {source.isActive ? (
                      <ToggleRight className="w-5 h-5 text-red-600" />
                    ) : (
                      <ToggleLeft className="w-5 h-5 text-gray-400" />
                    )}
                  </button>
                </div>
                <div className={`col-span-4 text-sm font-mono ${source.isActive ? "text-gray-900" : "text-gray-400"}`}>
                  {source.domain}
                </div>
                <div className={`col-span-5 text-xs ${source.isActive ? "text-gray-500" : "text-gray-400"}`}>
                  {source.reason || "—"}
                </div>
                <div className="col-span-2 flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(source)}
                    className="p-1 text-blue-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => deleteMutation.mutate(source.id)}
                    className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {(!sources || sources.length === 0) && (
          <div className="p-6 text-center text-gray-400 text-sm">
            No excluded sources configured. Add domains above to filter them out during discovery.
          </div>
        )}
      </div>
      <div className="text-xs text-gray-400">
        {sources?.length || 0} excluded sources configured. Active exclusions will filter out documents from these domains.
      </div>
    </div>
  );
}

// ─── Platform Sources Panel (GLOBAL) ──────────────────────────────────────────

function PlatformSourcesPanel() {
  const queryClient = useQueryClient();
  const [newDomain, setNewDomain] = useState("");
  const [newReason, setNewReason] = useState("");
  const [detectResult, setDetectResult] = useState<string | null>(null);

  const { data: sources } = useQuery({
    queryKey: ["platformSources"],
    queryFn: api.getPlatformSources,
  });

  const addMutation = useMutation({
    mutationFn: () => api.addPlatformSource(newDomain, newReason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["platformSources"] });
      setNewDomain("");
      setNewReason("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deletePlatformSource(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platformSources"] }),
  });

  const suppressMutation = useMutation({
    mutationFn: (id: number) => api.suppressPlatformSource(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platformSources"] }),
  });

  const unsuppressMutation = useMutation({
    mutationFn: (id: number) => api.unsuppressPlatformSource(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platformSources"] }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api.updatePlatformSource(id, { isActive: !isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platformSources"] }),
  });

  const detectMutation = useMutation({
    mutationFn: () => api.detectPlatformSources(3),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ["platformSources"] });
      setDetectResult(`Scan complete: ${res.added} new host(s) auto-added, ${res.total} qualifying (≥3 companies).`);
    },
  });

  return (
    <div className="bg-white rounded-lg border p-6 space-y-4">
      <div>
        <h2 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
          <Server className="w-4 h-4 text-indigo-600" /> Platform Sources
        </h2>
        <p className="text-sm text-gray-500 mb-1">
          Shared, multi-tenant hosts (investor-relations CDNs, blogs, aggregators) that serve documents for <strong>many different companies</strong> &mdash; e.g. <span className="font-mono">q4cdn.com</span>.
        </p>
        <p className="text-sm text-gray-500">
          Any document on these hosts is <strong>always</strong> issuer-verified by the LLM against the company under analysis, even if it would otherwise match the company&rsquo;s own domain. This prevents one company&rsquo;s filing (e.g. a Pfizer 10-K) from being wrongly attached to another. This list is <strong>global</strong> across all workspaces.
        </p>
      </div>

      <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-100 flex items-center justify-between gap-4">
        <div className="text-sm text-indigo-900">
          <div className="font-medium flex items-center gap-1.5"><Sparkles className="w-4 h-4" /> Auto-enforce the ≥3-companies rule</div>
          <div className="text-xs text-indigo-700 mt-0.5">Scan all fetched documents and automatically add any host that appears across 3 or more companies.</div>
        </div>
        <button
          onClick={() => detectMutation.mutate()}
          disabled={detectMutation.isPending}
          className="flex items-center gap-1 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
        >
          <Search className="w-4 h-4" /> {detectMutation.isPending ? "Scanning…" : "Scan now"}
        </button>
      </div>
      {detectResult && <div className="text-xs text-indigo-700">{detectResult}</div>}

      <div className="p-4 bg-gray-50 rounded-lg border space-y-2">
        <div className="text-sm font-medium text-gray-900 mb-2">Add Platform Host</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="Shared host (e.g., q4cdn.com)"
            className="px-3 py-2 border rounded-lg text-sm"
          />
          <input
            type="text"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            placeholder="Reason (optional)"
            className="px-3 py-2 border rounded-lg text-sm"
          />
        </div>
        <button
          onClick={() => addMutation.mutate()}
          disabled={!newDomain}
          className="flex items-center gap-1 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" /> Add Platform Host
        </button>
      </div>

      <div className="border rounded-lg divide-y">
        <div className="px-4 py-2 bg-gray-50 grid grid-cols-12 gap-2 text-xs font-medium text-gray-500 uppercase">
          <div className="col-span-1">Active</div>
          <div className="col-span-4">Host</div>
          <div className="col-span-4">Reason</div>
          <div className="col-span-3 text-right">Actions</div>
        </div>
        {sources?.filter((s: any) => !s.suppressed).map((source: any) => (
          <div key={source.id} className="px-4 py-3 grid grid-cols-12 gap-2 items-center group">
            <div className="col-span-1">
              <button onClick={() => toggleActiveMutation.mutate({ id: source.id, isActive: source.isActive })}>
                {source.isActive ? (
                  <ToggleRight className="w-5 h-5 text-indigo-600" />
                ) : (
                  <ToggleLeft className="w-5 h-5 text-gray-400" />
                )}
              </button>
            </div>
            <div className={`col-span-4 text-sm font-mono flex items-center gap-2 ${source.isActive ? "text-gray-900" : "text-gray-400"}`}>
              {source.domain}
              {source.autoDetected && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-sans bg-amber-100 text-amber-700" title={source.companyCount ? `Seen on ${source.companyCount} companies` : ""}>
                  auto{source.companyCount ? ` · ${source.companyCount}` : ""}
                </span>
              )}
            </div>
            <div className={`col-span-4 text-xs ${source.isActive ? "text-gray-500" : "text-gray-400"}`}>
              {source.reason || "—"}
            </div>
            <div className="col-span-3 flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => deleteMutation.mutate(source.id)}
                title="Delete (auto-detection may re-add it later)"
                className="px-2 py-1 text-[11px] text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
              <button
                onClick={() => suppressMutation.mutate(source.id)}
                title="Delete and never auto-re-add (until restored)"
                className="px-2 py-1 text-[11px] text-red-500 hover:text-red-700 hover:bg-red-50 rounded flex items-center gap-1 whitespace-nowrap"
              >
                <Ban className="w-3.5 h-3.5" /> Don&rsquo;t re-add
              </button>
            </div>
          </div>
        ))}
        {(!sources || sources.filter((s: any) => !s.suppressed).length === 0) && (
          <div className="p-6 text-center text-gray-400 text-sm">
            No active platform sources. Add shared hosts above or run a scan.
          </div>
        )}
      </div>

      {sources?.some((s: any) => s.suppressed) && (
        <div className="border rounded-lg divide-y border-red-100">
          <div className="px-4 py-2 bg-red-50 text-xs font-medium text-red-700 uppercase flex items-center gap-1.5">
            <Ban className="w-3.5 h-3.5" /> Suppressed domains &mdash; will not be auto-re-added
          </div>
          {sources.filter((s: any) => s.suppressed).map((source: any) => (
            <div key={source.id} className="px-4 py-3 grid grid-cols-12 gap-2 items-center group bg-red-50/30">
              <div className="col-span-5 text-sm font-mono text-gray-400 line-through flex items-center gap-2">
                {source.domain}
                {source.autoDetected && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-sans bg-gray-100 text-gray-500 no-underline">
                    auto{source.companyCount ? ` · ${source.companyCount}` : ""}
                  </span>
                )}
              </div>
              <div className="col-span-4 text-xs text-gray-400">{source.reason || "—"}</div>
              <div className="col-span-3 flex justify-end">
                <button
                  onClick={() => unsuppressMutation.mutate(source.id)}
                  title="Lift suppression so this domain can be detected/added again"
                  className="px-2 py-1 text-[11px] text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded flex items-center gap-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Restore
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-gray-400">
        {sources?.filter((s: any) => !s.suppressed).length || 0} active platform host(s). Active hosts force LLM issuer-verification on every document, overriding the own-domain fast-path. &ldquo;Don&rsquo;t re-add&rdquo; removes a host and blocks the ≥3-companies auto-detection from re-adding it.
      </div>
    </div>
  );
}

// ─── Users / Members Panel ───────────────────────────────────────────────────

const ROLE_BADGES: Record<string, string> = {
  owner: "bg-purple-100 text-purple-700",
  admin: "bg-blue-100 text-blue-700",
  member: "bg-gray-100 text-gray-600",
};

function UsersPanel() {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "member" });
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editRole, setEditRole] = useState("member");

  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: api.getUsers,
  });

  const members: any[] = data?.members || [];
  const currentUserId: number | undefined = data?.currentUserId;
  const currentUserRole: string | undefined = data?.currentUserRole;
  const canManage = currentUserRole === "owner" || currentUserRole === "admin";

  const addMutation = useMutation({
    mutationFn: () => api.addUser(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setShowAdd(false);
      setForm({ email: "", name: "", password: "", role: "member" });
      setError(null);
    },
    onError: (e: any) => setError(e.message || "Failed to add user"),
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: string }) => api.updateUserRole(userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setEditingId(null);
      setError(null);
    },
    onError: (e: any) => setError(e.message || "Failed to update role"),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: number) => api.removeUser(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setError(null);
    },
    onError: (e: any) => setError(e.message || "Failed to remove user"),
  });

  if (isLoading) return <div className="text-gray-400 text-sm">Loading users...</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-semibold text-gray-900">Workspace Members</h2>
          {canManage && (
            <button
              onClick={() => { setShowAdd((v) => !v); setError(null); }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              <Plus className="w-4 h-4" /> Add Member
            </button>
          )}
        </div>
        <p className="text-sm text-gray-500 mb-4">
          People with access to this workspace. Roles control who can manage members and settings
          (<span className="font-medium">owner</span> &amp; <span className="font-medium">admin</span> can manage; <span className="font-medium">member</span> cannot).
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">{error}</div>
        )}

        {showAdd && canManage && (
          <div className="mb-4 p-4 bg-gray-50 rounded-lg space-y-3">
            <div className="text-sm font-medium text-gray-700">Add a member</div>
            <p className="text-xs text-gray-500">
              Enter the email of an existing user to add them, or fill in name + password to create a new account.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="email"
                placeholder="Email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="px-3 py-2 border rounded-lg text-sm"
              />
              <input
                type="text"
                placeholder="Name (new users only)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="px-3 py-2 border rounded-lg text-sm"
              />
              <input
                type="password"
                placeholder="Initial password (new users, min 8 chars)"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="px-3 py-2 border rounded-lg text-sm"
              />
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="px-3 py-2 border rounded-lg text-sm"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => addMutation.mutate()}
                disabled={!form.email || addMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {addMutation.isPending ? "Adding..." : "Add"}
              </button>
              <button
                onClick={() => { setShowAdd(false); setError(null); }}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="divide-y border rounded-lg">
          {members.map((m) => (
            <div key={m.userId} className="group grid grid-cols-12 gap-2 items-center px-4 py-3">
              <div className="col-span-5">
                <div className="text-sm font-medium text-gray-900">
                  {m.name}{m.userId === currentUserId && <span className="ml-2 text-xs text-gray-400">(you)</span>}
                </div>
                <div className="text-xs text-gray-500">{m.email}</div>
              </div>
              <div className="col-span-4">
                {editingId === m.userId ? (
                  <div className="flex items-center gap-1.5">
                    <select
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value)}
                      className="px-2 py-1 border rounded text-sm"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button
                      onClick={() => roleMutation.mutate({ userId: m.userId, role: editRole })}
                      className="p-1 text-green-600 hover:bg-green-50 rounded"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={() => setEditingId(null)} className="p-1 text-gray-400 hover:bg-gray-100 rounded">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${ROLE_BADGES[m.role] || ROLE_BADGES.member}`}>
                    {m.role}
                  </span>
                )}
              </div>
              <div className="col-span-3 flex justify-end gap-1">
                {canManage && editingId !== m.userId && (
                  <>
                    <button
                      onClick={() => { setEditingId(m.userId); setEditRole(m.role); setError(null); }}
                      className="p-1 text-blue-400 hover:text-blue-600 hover:bg-blue-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Change role"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    {m.userId !== currentUserId && (
                      <button
                        onClick={() => { if (confirm(`Remove ${m.name} from the workspace?`)) removeMutation.mutate(m.userId); }}
                        className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Remove member"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
          {members.length === 0 && (
            <div className="p-6 text-center text-gray-400 text-sm">No members found.</div>
          )}
        </div>

        {!canManage && (
          <div className="mt-3 text-xs text-gray-400">
            You have <span className="font-medium">member</span> access. Contact an owner or admin to manage users.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Queue & API Keys Panel ──────────────────────────────────────────────────

function QueuePanel() {
  const { data: queueStats } = useQuery({
    queryKey: ["queueStats"],
    queryFn: api.getQueueStats,
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Processing Queue Status</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-yellow-50 rounded-lg p-4 text-center border border-yellow-100">
            <div className="text-2xl font-bold text-yellow-600">{queueStats?.waiting || 0}</div>
            <div className="text-xs text-yellow-700 font-medium mt-1">Waiting</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4 text-center border border-blue-100">
            <div className="text-2xl font-bold text-blue-600">{queueStats?.active || 0}</div>
            <div className="text-xs text-blue-700 font-medium mt-1">Active</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4 text-center border border-green-100">
            <div className="text-2xl font-bold text-green-600">{queueStats?.completed || 0}</div>
            <div className="text-xs text-green-700 font-medium mt-1">Completed</div>
          </div>
          <div className="bg-red-50 rounded-lg p-4 text-center border border-red-100">
            <div className="text-2xl font-bold text-red-600">{queueStats?.failed || 0}</div>
            <div className="text-xs text-red-700 font-medium mt-1">Failed</div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border p-6">
        <h3 className="font-semibold text-gray-900 mb-4">API Keys</h3>
        <p className="text-sm text-gray-500 mb-3">
          API keys are configured as environment variables on the server.
        </p>
        <div className="space-y-2">
          {["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SERP_API_KEY", "GEMINI_API_KEY"].map((key) => (
            <div key={key} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <Key className="w-4 h-4 text-gray-400" />
              <span className="text-sm font-mono text-gray-700">{key}</span>
              <span className="text-xs text-green-600 ml-auto font-medium">configured</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

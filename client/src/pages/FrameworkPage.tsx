import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useRef, useEffect } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Star, MessageSquare, Send, X, Bot, User, Settings, Globe, Search, Ban, Link2 } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function FrameworkPage() {
  const queryClient = useQueryClient();
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [showAIEditor, setShowAIEditor] = useState(false);
  const [showDiscoverySettings, setShowDiscoverySettings] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Discovery settings local state
  const [searchTemplatesText, setSearchTemplatesText] = useState("");
  const [negativeKeywordsText, setNegativeKeywordsText] = useState("");
  const [negativeDomainsText, setNegativeDomainsText] = useState("");
  const [knownDisclosureUrlsText, setKnownDisclosureUrlsText] = useState("");
  const [discoverySaving, setDiscoverySaving] = useState(false);

  const { data: frameworks } = useQuery({
    queryKey: ["frameworks"],
    queryFn: api.getFrameworks,
  });

  const { data: trustedSources } = useQuery({
    queryKey: ["trustedSources"],
    queryFn: api.getTrustedSources,
  });

  const [selectedFrameworkId, setSelectedFrameworkId] = useState<number | null>(null);
  const activeFrameworkId = selectedFrameworkId || frameworks?.[0]?.id;

  const { data: frameworkDetail } = useQuery({
    queryKey: ["framework", activeFrameworkId],
    queryFn: () => api.getFramework(activeFrameworkId!),
    enabled: !!activeFrameworkId,
  });

  const activateMutation = useMutation({
    mutationFn: (id: number) => api.activateFramework(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["frameworks"] }),
  });

  const framework = frameworkDetail?.framework;
  const measures = frameworkDetail?.measures || [];

  // Sync discovery settings when framework changes
  useEffect(() => {
    if (framework) {
      setSearchTemplatesText((framework.searchTemplates || []).join("\n"));
      setNegativeKeywordsText((framework.negativeKeywords || []).join("\n"));
      setNegativeDomainsText((framework.negativeDomains || []).join("\n"));
      setKnownDisclosureUrlsText((framework.knownDisclosureUrls || []).join("\n"));
    }
  }, [framework?.id, framework?.searchTemplates, framework?.negativeKeywords, framework?.negativeDomains, framework?.knownDisclosureUrls]);

  // Group measures by category
  const categories: Record<string, any[]> = {};
  for (const m of measures) {
    const cat = m.categoryName || m.category || "Uncategorized";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(m);
  }

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await api.request("/frameworks", {
        method: "POST",
        body: JSON.stringify({ name: newName }),
      });
      setNewName("");
      setShowCreateModal(false);
      queryClient.invalidateQueries({ queryKey: ["frameworks"] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteFramework = async (id: number) => {
    if (!confirm("Delete this framework? This cannot be undone.")) return;
    try {
      await api.deleteFramework(id);
      queryClient.invalidateQueries({ queryKey: ["frameworks"] });
      if (selectedFrameworkId === id) setSelectedFrameworkId(null);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAddMeasure = async (categoryName: string) => {
    const title = prompt("Measure title:");
    if (!title) return;
    const definition = prompt("Definition (optional):") || "";
    try {
      await api.request(`/frameworks/${activeFrameworkId}/measures`, {
        method: "POST",
        body: JSON.stringify({
          title,
          definition,
          categoryName,
          scoringGuidance: "",
          evidenceKeywords: [],
        }),
      });
      queryClient.invalidateQueries({ queryKey: ["framework", activeFrameworkId] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteMeasure = async (measureId: number) => {
    if (!confirm("Delete this measure?")) return;
    try {
      await api.request(`/frameworks/${activeFrameworkId}/measures/${measureId}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["framework", activeFrameworkId] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Save discovery settings
  const handleSaveDiscoverySettings = async () => {
    if (!activeFrameworkId) return;
    setDiscoverySaving(true);
    try {
      const parseLines = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);
      await api.updateFramework(activeFrameworkId, {
        searchTemplates: parseLines(searchTemplatesText),
        negativeKeywords: parseLines(negativeKeywordsText),
        negativeDomains: parseLines(negativeDomainsText),
        knownDisclosureUrls: parseLines(knownDisclosureUrlsText),
      });
      queryClient.invalidateQueries({ queryKey: ["framework", activeFrameworkId] });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setDiscoverySaving(false);
    }
  };

  // Link/unlink trusted source to framework
  const handleToggleTrustedSource = async (sourceId: number) => {
    if (!activeFrameworkId || !framework) return;
    const currentIds: number[] = (framework.trustedSourceIds as number[]) || [];
    let newIds: number[];
    if (currentIds.includes(sourceId)) {
      newIds = currentIds.filter((id: number) => id !== sourceId);
    } else {
      newIds = [...currentIds, sourceId];
    }
    try {
      await api.updateFramework(activeFrameworkId, { trustedSourceIds: newIds });
      queryClient.invalidateQueries({ queryKey: ["framework", activeFrameworkId] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  // AI Editor functions
  const openAIEditor = () => {
    setShowAIEditor(true);
    if (chatMessages.length === 0) {
      setChatMessages([{
        role: "assistant",
        content: `I'm ready to help you edit the **${framework?.name}** framework (${measures.length} measures). You can ask me to:\n\n- Add new measures or categories\n- Remove specific measures\n- Edit measure titles, definitions, or scoring guidance\n- Rename the framework\n- Add or remove trusted sources\n- Configure search templates and negative keywords\n\nWhat would you like to change?`
      }]);
    }
  };

  const sendChatMessage = async () => {
    if (!chatInput.trim() || chatLoading || !activeFrameworkId) return;

    const userMessage: ChatMessage = { role: "user", content: chatInput.trim() };
    const newMessages = [...chatMessages, userMessage];
    setChatMessages(newMessages);
    setChatInput("");
    setChatLoading(true);

    try {
      const response = await api.request("/framework-builder/edit", {
        method: "POST",
        body: JSON.stringify({
          messages: newMessages,
          frameworkId: activeFrameworkId,
        }),
      });

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.message,
      };
      setChatMessages([...newMessages, assistantMessage]);

      if (response.hasChanges) {
        queryClient.invalidateQueries({ queryKey: ["framework", activeFrameworkId] });
        queryClient.invalidateQueries({ queryKey: ["frameworks"] });
      }
    } catch (err: any) {
      setChatMessages([
        ...newMessages,
        { role: "assistant", content: `Error: ${err.message}. Please try again.` },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  // Reset chat when switching frameworks
  useEffect(() => {
    setChatMessages([]);
    setShowAIEditor(false);
  }, [activeFrameworkId]);

  // Format chat message content
  const formatMessage = (content: string) => {
    const cleaned = content.replace(/```action[\s\S]*?```/g, "").trim();
    return cleaned.split("\n").map((line, i) => {
      if (line.startsWith("- ")) {
        return <li key={i} className="ml-4 list-disc">{formatInline(line.slice(2))}</li>;
      }
      if (line.startsWith("# ")) {
        return <h3 key={i} className="font-bold text-base mt-2">{line.slice(2)}</h3>;
      }
      if (line.startsWith("## ")) {
        return <h4 key={i} className="font-semibold text-sm mt-2">{line.slice(3)}</h4>;
      }
      if (line.trim() === "") return <br key={i} />;
      return <p key={i} className="mt-1">{formatInline(line)}</p>;
    });
  };

  const formatInline = (text: string) => {
    const parts = text.split(/(\*\*.*?\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
  };

  const linkedSourceIds: number[] = (framework?.trustedSourceIds as number[]) || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Framework Templates</h1>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" /> New Framework
        </button>
      </div>

      {/* Framework List */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-gray-700">Available Frameworks</h2>
        </div>
        <div className="divide-y">
          {frameworks?.map((f: any) => (
            <div
              key={f.id}
              className={`px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 ${
                activeFrameworkId === f.id ? "bg-blue-50 border-l-2 border-l-blue-600" : ""
              }`}
              onClick={() => setSelectedFrameworkId(f.id)}
            >
              <div>
                <span className="font-medium text-gray-900">{f.name}</span>
                {f.isActive && (
                  <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                    active
                  </span>
                )}
                {f.isShared && (
                  <span className="ml-2 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                    shared
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!f.isActive && (
                  <button
                    onClick={(e) => { e.stopPropagation(); activateMutation.mutate(f.id); }}
                    className="text-xs text-green-600 hover:text-green-800 font-medium flex items-center gap-1"
                  >
                    <Star className="w-3 h-3" /> Activate
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteFramework(f.id); }}
                  className="text-xs text-red-400 hover:text-red-600"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {(!frameworks || frameworks.length === 0) && (
            <div className="p-8 text-center text-gray-400 text-sm">
              No frameworks yet. Create one manually or use the AI Builder.
            </div>
          )}
        </div>
      </div>

      {/* Framework Detail with Measures */}
      {framework && (
        <div className="bg-white rounded-lg border">
          <div className="p-4 border-b flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-gray-900">{framework.name}</h2>
              <p className="text-sm text-gray-500 mt-1">
                {measures.length} measures in {Object.keys(categories).length} categories
              </p>
              {framework.topicDescription && (
                <p className="text-sm text-gray-600 mt-1">{framework.topicDescription}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer" title="Share this framework across all workspaces">
                <Globe className="w-3.5 h-3.5 text-gray-400" />
                <span className="text-xs text-gray-500">Shared</span>
                <input
                  type="checkbox"
                  checked={!!framework.isShared}
                  onChange={async (e) => {
                    await api.updateFramework(activeFrameworkId!, { isShared: e.target.checked });
                    queryClient.invalidateQueries({ queryKey: ["frameworks"] });
                    queryClient.invalidateQueries({ queryKey: ["framework", activeFrameworkId] });
                  }}
                  className="w-3.5 h-3.5 rounded text-purple-600"
                />
              </label>
              <button
                onClick={() => setShowDiscoverySettings(!showDiscoverySettings)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
                  showDiscoverySettings
                    ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                <Settings className="w-4 h-4" /> Discovery Settings
              </button>
              <button
                onClick={openAIEditor}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition-colors"
              >
                <MessageSquare className="w-4 h-4" /> AI Editor
              </button>
            </div>
          </div>

          {/* Discovery Settings Panel */}
          {showDiscoverySettings && (
            <div className="p-4 border-b bg-amber-50/50 space-y-5">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                  <Search className="w-4 h-4" /> Document Discovery Configuration
                </h3>
                <button
                  onClick={handleSaveDiscoverySettings}
                  disabled={discoverySaving}
                  className="px-4 py-1.5 bg-amber-600 text-white rounded-lg text-sm hover:bg-amber-700 disabled:opacity-50"
                >
                  {discoverySaving ? "Saving..." : "Save Settings"}
                </button>
              </div>
              <p className="text-xs text-gray-600">
                Configure how the system discovers and filters documents during analysis. These settings control what gets searched, what gets excluded, and which sources are prioritised.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Search Templates */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                    <Search className="w-3.5 h-3.5 text-blue-500" /> Search Templates
                  </label>
                  <p className="text-[11px] text-gray-500 mb-1">
                    Custom search queries used during discovery. Use <code className="bg-gray-100 px-1 rounded">{"{company}"}</code> as a placeholder for the company name. One per line.
                  </p>
                  <textarea
                    value={searchTemplatesText}
                    onChange={(e) => setSearchTemplatesText(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border rounded-lg text-sm font-mono resize-y"
                    placeholder={`{company} sustainability report 2024\n{company} ESG disclosure\n{company} climate risk TCFD`}
                  />
                </div>

                {/* Negative Keywords */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                    <Ban className="w-3.5 h-3.5 text-red-500" /> Negative Keywords
                  </label>
                  <p className="text-[11px] text-gray-500 mb-1">
                    Documents containing these terms in their title/URL will be penalised or excluded. One per line.
                  </p>
                  <textarea
                    value={negativeKeywordsText}
                    onChange={(e) => setNegativeKeywordsText(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border rounded-lg text-sm font-mono resize-y"
                    placeholder={`job posting\ncareers\nmarketing brochure\npress release`}
                  />
                </div>

                {/* Negative Domains */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                    <Globe className="w-3.5 h-3.5 text-red-500" /> Negative Domains
                  </label>
                  <p className="text-[11px] text-gray-500 mb-1">
                    Domains to exclude from results. Documents from these sites will be demoted or rejected. One per line.
                  </p>
                  <textarea
                    value={negativeDomainsText}
                    onChange={(e) => setNegativeDomainsText(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border rounded-lg text-sm font-mono resize-y"
                    placeholder={`linkedin.com\nglassdoor.com\nindeed.com\nfacebook.com`}
                  />
                </div>

                {/* Known Disclosure URLs */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-1">
                    <Link2 className="w-3.5 h-3.5 text-green-500" /> Known Disclosure URLs
                  </label>
                  <p className="text-[11px] text-gray-500 mb-1">
                    Specific URLs that are always included in analysis (e.g., industry databases, regulatory filings). One per line.
                  </p>
                  <textarea
                    value={knownDisclosureUrlsText}
                    onChange={(e) => setKnownDisclosureUrlsText(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border rounded-lg text-sm font-mono resize-y"
                    placeholder={`https://www.cdp.net/en/responses\nhttps://sciencebasedtargets.org/companies-taking-action`}
                  />
                </div>
              </div>

              {/* Trusted Sources linked to this framework */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1">
                  <Globe className="w-3.5 h-3.5 text-blue-500" /> Linked Trusted Sources
                </label>
                <p className="text-[11px] text-gray-500 mb-2">
                  Select <strong>only topic-relevant</strong> trusted sources for this framework. Only link sources where searching the domain would plausibly return documents with evidence for this framework's measures. Generic filing repositories (SEC, Companies House) are always useful. Topic-specific sources (e.g., CDP for climate, OECD AI for AI governance) should only be linked when relevant to this framework's topic.
                </p>
                {trustedSources && trustedSources.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {trustedSources.map((source: any) => {
                      const isLinked = linkedSourceIds.includes(source.id);
                      return (
                        <div
                          key={source.id}
                          onClick={() => handleToggleTrustedSource(source.id)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                            isLinked
                              ? "bg-blue-50 border-blue-300 text-blue-800"
                              : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isLinked}
                            readOnly
                            className="w-3.5 h-3.5 rounded text-blue-600"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{source.name}</div>
                            <div className="text-[10px] text-gray-500 truncate">{source.domain}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 italic">
                    No trusted sources configured. Add them in Settings &gt; Trusted Sources.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Measures by Category */}
          <div className="divide-y">
            {Object.entries(categories).map(([category, catMeasures]) => (
              <div key={category}>
                <div
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 cursor-pointer"
                  onClick={() => toggleCategory(category)}
                >
                  <div className="flex items-center gap-2">
                    {expandedCategories[category] ? (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    )}
                    <span className="font-medium text-gray-800">{category}</span>
                    <span className="text-xs text-gray-400">({catMeasures.length} measures)</span>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleAddMeasure(category); }}
                    className="text-blue-600 hover:text-blue-800 text-xs flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add
                  </button>
                </div>
                {expandedCategories[category] && (
                  <div className="px-4 pb-3 space-y-2">
                    {catMeasures.sort((a: any, b: any) => (a.displayOrder || 0) - (b.displayOrder || 0)).map((m: any) => (
                      <div key={m.id} className="p-3 bg-gray-50 rounded-lg group flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400 font-mono">{m.measureId}</span>
                            <span className="font-medium text-sm text-gray-900">{m.title}</span>
                          </div>
                          {m.definition && (
                            <p className="text-xs text-gray-600 mt-1">{m.definition}</p>
                          )}
                          {m.scoringGuidance && (
                            <p className="text-xs text-gray-500 mt-1 italic">
                              Scoring: {typeof m.scoringGuidance === 'string' && m.scoringGuidance.startsWith('{')
                                ? (() => { try { const sg = JSON.parse(m.scoringGuidance); return `Yes: ${sg.yes?.slice(0, 60)}...`; } catch { return m.scoringGuidance.slice(0, 100); } })()
                                : String(m.scoringGuidance).slice(0, 100)
                              }
                            </p>
                          )}
                          {m.evidenceKeywords && m.evidenceKeywords.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {m.evidenceKeywords.slice(0, 8).map((kw: string, i: number) => (
                                <span key={i} className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">{kw}</span>
                              ))}
                              {m.evidenceKeywords.length > 8 && (
                                <span className="text-[10px] text-gray-400">+{m.evidenceKeywords.length - 8} more</span>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => handleDeleteMeasure(m.id)}
                          className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity p-1 ml-2"
                          title="Delete measure"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add New Category */}
          <div className="p-4 border-t">
            <button
              onClick={() => {
                const name = prompt("New category name:");
                if (name) handleAddMeasure(name);
              }}
              className="w-full border-2 border-dashed rounded-lg p-3 text-center text-sm text-gray-400 hover:text-gray-600 hover:border-gray-400"
            >
              <Plus className="w-4 h-4 inline mr-1" /> Add New Category
            </button>
          </div>
        </div>
      )}

      {/* AI Editor Slide-over Panel */}
      {showAIEditor && framework && (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div className="flex-1 bg-black/30" onClick={() => setShowAIEditor(false)} />
          
          {/* Panel */}
          <div className="w-[500px] bg-white shadow-2xl flex flex-col h-full">
            {/* Header */}
            <div className="p-4 border-b flex items-center justify-between bg-purple-50">
              <div>
                <h3 className="font-semibold text-purple-900 flex items-center gap-2">
                  <Bot className="w-5 h-5" /> AI Editor
                </h3>
                <p className="text-xs text-purple-700 mt-0.5">Editing: {framework.name}</p>
              </div>
              <button
                onClick={() => setShowAIEditor(false)}
                className="text-gray-500 hover:text-gray-700 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
                  {msg.role === "assistant" && (
                    <div className="w-7 h-7 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                      <Bot className="w-4 h-4 text-purple-600" />
                    </div>
                  )}
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-blue-600 text-white"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <div className="prose prose-sm max-w-none">{formatMessage(msg.content)}</div>
                    ) : (
                      msg.content
                    )}
                  </div>
                  {msg.role === "user" && (
                    <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-blue-600" />
                    </div>
                  )}
                </div>
              ))}
              {chatLoading && (
                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                    <Bot className="w-4 h-4 text-purple-600" />
                  </div>
                  <div className="bg-gray-100 rounded-lg px-3 py-2">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat Input */}
            <div className="p-4 border-t bg-white">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendChatMessage()}
                  placeholder="e.g., Remove measure 3.2 and add a new one about..."
                  className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  disabled={chatLoading}
                />
                <button
                  onClick={sendChatMessage}
                  disabled={chatLoading || !chatInput.trim()}
                  className="px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-2">
                Try: "Add a measure about board-level AI oversight" or "Add cdp.net as a trusted source"
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Create New Framework</h3>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="Framework name..."
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

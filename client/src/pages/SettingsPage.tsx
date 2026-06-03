import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Plus, Trash2, Save, Key, Globe, Users, Settings, Activity } from "lucide-react";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"queue" | "sources" | "workspace">("queue");
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceDomain, setNewSourceDomain] = useState("");

  const { data: sources } = useQuery({
    queryKey: ["trustedSources"],
    queryFn: api.getTrustedSources,
  });

  const { data: queueStats } = useQuery({
    queryKey: ["queueStats"],
    queryFn: api.getQueueStats,
    refetchInterval: 5000,
  });

  const addSourceMutation = useMutation({
    mutationFn: () => api.addTrustedSource(newSourceName, newSourceDomain),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trustedSources"] });
      setNewSourceName("");
      setNewSourceDomain("");
    },
  });

  const deleteSourceMutation = useMutation({
    mutationFn: (id: number) => api.deleteTrustedSource(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["trustedSources"] }),
  });

  const tabs = [
    { id: "queue" as const, label: "Processing Queue", icon: Activity },
    { id: "sources" as const, label: "Trusted Sources", icon: Globe },
    { id: "workspace" as const, label: "Workspace", icon: Users },
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

      {/* Queue Stats */}
      {activeTab === "queue" && (
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
              {["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "SERPER_API_KEY", "GEMINI_API_KEY"].map((key) => (
                <div key={key} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <Key className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-mono text-gray-700">{key}</span>
                  <span className="text-xs text-green-600 ml-auto font-medium">configured</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Trusted Sources */}
      {activeTab === "sources" && (
        <div className="bg-white rounded-lg border p-6 space-y-4">
          <div>
            <h2 className="font-semibold text-gray-900 mb-2">Trusted Sources</h2>
            <p className="text-sm text-gray-500 mb-4">
              Documents from these sources receive priority in discovery and scoring. The system will search these domains first when looking for company disclosures.
            </p>
          </div>

          {/* Add Source Form */}
          <div className="flex gap-2">
            <input
              type="text"
              value={newSourceName}
              onChange={(e) => setNewSourceName(e.target.value)}
              placeholder="Source name (e.g., CDP)"
              className="flex-1 px-3 py-2 border rounded-lg text-sm"
            />
            <input
              type="text"
              value={newSourceDomain}
              onChange={(e) => setNewSourceDomain(e.target.value)}
              placeholder="Domain (e.g., cdp.net)"
              className="flex-1 px-3 py-2 border rounded-lg text-sm"
            />
            <button
              onClick={() => addSourceMutation.mutate()}
              disabled={!newSourceName || !newSourceDomain}
              className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>

          {/* Source List */}
          <div className="border rounded-lg divide-y">
            {sources?.map((source: any) => (
              <div key={source.id} className="px-4 py-3 flex items-center justify-between group">
                <div className="flex items-center gap-3">
                  <Globe className="w-4 h-4 text-gray-400" />
                  <div>
                    <span className="text-sm font-medium text-gray-900">{source.name}</span>
                    <span className="text-xs text-gray-400 ml-3">{source.domain}</span>
                  </div>
                </div>
                <button
                  onClick={() => deleteSourceMutation.mutate(source.id)}
                  className="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {(!sources || sources.length === 0) && (
              <div className="p-6 text-center text-gray-400 text-sm">
                No trusted sources configured yet.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Workspace Settings */}
      {activeTab === "workspace" && (
        <div className="bg-white rounded-lg border p-6 space-y-4">
          <div>
            <h2 className="font-semibold text-gray-900 mb-2">Workspace</h2>
            <p className="text-sm text-gray-500 mb-4">
              Each user has their own isolated workspace with separate companies, frameworks, and analysis results.
            </p>
          </div>

          <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-blue-600" />
              <span className="font-medium text-blue-900">Multi-User Workspace Isolation</span>
            </div>
            <p className="text-sm text-blue-700">
              This application supports multiple simultaneous users. Each user's data (companies, frameworks, analyses) is completely isolated from other users. The fair-share job scheduler ensures that all users' analyses are processed equitably regardless of batch size.
            </p>
          </div>

          <div className="border-t pt-4">
            <h4 className="font-medium text-gray-700 mb-3">Concurrency Settings</h4>
            <p className="text-sm text-gray-500 mb-2">
              The system processes up to 5 companies concurrently per workspace, with fair-share scheduling across all active workspaces.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

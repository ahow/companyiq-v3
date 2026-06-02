import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceDomain, setNewSourceDomain] = useState("");

  const { data: sources } = useQuery({
    queryKey: ["trustedSources"],
    queryFn: api.getTrustedSources,
  });

  const { data: queueStats } = useQuery({
    queryKey: ["queueStats"],
    queryFn: api.getQueueStats,
    refetchInterval: 10000,
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

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">Settings</h1>

      {/* Queue Stats */}
      <div className="bg-white rounded-lg border p-4">
        <h2 className="font-semibold text-gray-700 mb-3">Processing Queue</h2>
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-yellow-600">{queueStats?.waiting || 0}</div>
            <div className="text-xs text-gray-500">Waiting</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-blue-600">{queueStats?.active || 0}</div>
            <div className="text-xs text-gray-500">Active</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-green-600">{queueStats?.completed || 0}</div>
            <div className="text-xs text-gray-500">Completed</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-red-600">{queueStats?.failed || 0}</div>
            <div className="text-xs text-gray-500">Failed</div>
          </div>
        </div>
      </div>

      {/* Trusted Sources */}
      <div className="bg-white rounded-lg border p-4">
        <h2 className="font-semibold text-gray-700 mb-3">Trusted Sources</h2>
        <p className="text-sm text-gray-500 mb-4">
          Documents from these sources receive priority in discovery and scoring.
        </p>

        <div className="flex items-center gap-2 mb-4">
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

        <div className="divide-y border rounded-lg">
          {sources?.map((source: any) => (
            <div key={source.id} className="px-4 py-2 flex items-center justify-between">
              <div>
                <span className="font-medium text-sm text-gray-900">{source.name}</span>
                <span className="text-xs text-gray-400 ml-2">{source.domain}</span>
              </div>
              <button
                onClick={() => deleteSourceMutation.mutate(source.id)}
                className="text-red-500 hover:text-red-700"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {(!sources || sources.length === 0) && (
            <div className="p-4 text-center text-sm text-gray-500">No trusted sources configured.</div>
          )}
        </div>
      </div>
    </div>
  );
}

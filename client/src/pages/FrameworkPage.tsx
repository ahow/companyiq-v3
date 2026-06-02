import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Star } from "lucide-react";

export default function FrameworkPage() {
  const queryClient = useQueryClient();
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState("");

  const { data: frameworks } = useQuery({
    queryKey: ["frameworks"],
    queryFn: api.getFrameworks,
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
      await api.request(`/frameworks/${id}`, { method: "DELETE" });
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
          </div>
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
                          <div className="font-medium text-sm text-gray-900">{m.title}</div>
                          {m.definition && (
                            <p className="text-xs text-gray-600 mt-1">{m.definition}</p>
                          )}
                          {m.scoringGuidance && (
                            <p className="text-xs text-gray-500 mt-1 italic">Scoring: {m.scoringGuidance}</p>
                          )}
                          {m.evidenceKeywords && m.evidenceKeywords.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {m.evidenceKeywords.map((kw: string, i: number) => (
                                <span key={i} className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">{kw}</span>
                              ))}
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

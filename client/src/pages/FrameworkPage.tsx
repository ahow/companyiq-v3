import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Plus, Check, ChevronDown, ChevronRight } from "lucide-react";

export default function FrameworkPage() {
  const queryClient = useQueryClient();
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  const { data: frameworks } = useQuery({
    queryKey: ["frameworks"],
    queryFn: api.getFrameworks,
  });

  const [selectedFrameworkId, setSelectedFrameworkId] = useState<number | null>(null);

  const { data: frameworkDetail } = useQuery({
    queryKey: ["framework", selectedFrameworkId],
    queryFn: () => api.getFramework(selectedFrameworkId!),
    enabled: !!selectedFrameworkId,
  });

  const activateMutation = useMutation({
    mutationFn: (id: number) => api.activateFramework(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["frameworks"] }),
  });

  const activeFramework = frameworks?.find((f: any) => f.isActive);
  const measures = frameworkDetail?.measures || [];

  // Group measures by category
  const categories: Record<string, any[]> = {};
  for (const m of measures) {
    const cat = m.category || "Uncategorized";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(m);
  }

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Framework Templates</h1>
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
                selectedFrameworkId === f.id ? "bg-blue-50" : ""
              }`}
              onClick={() => setSelectedFrameworkId(f.id)}
            >
              <div>
                <span className="font-medium text-gray-900">{f.name}</span>
                {f.isActive && (
                  <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                    active
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!f.isActive && (
                  <button
                    onClick={(e) => { e.stopPropagation(); activateMutation.mutate(f.id); }}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    Activate
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Framework Detail */}
      {frameworkDetail && (
        <div className="bg-white rounded-lg border">
          <div className="p-4 border-b">
            <h2 className="font-semibold text-gray-900">{frameworkDetail.framework.name}</h2>
            <p className="text-sm text-gray-500 mt-1">
              {measures.length} measures in {Object.keys(categories).length} categories
            </p>
          </div>
          <div className="divide-y">
            {Object.entries(categories).map(([category, catMeasures]) => (
              <div key={category}>
                <button
                  onClick={() => toggleCategory(category)}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50"
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
                </button>
                {expandedCategories[category] && (
                  <div className="px-4 pb-3 space-y-2">
                    {catMeasures.sort((a, b) => a.displayOrder - b.displayOrder).map((m: any) => (
                      <div key={m.id} className="p-3 bg-gray-50 rounded-lg">
                        <div className="font-medium text-sm text-gray-900">{m.title}</div>
                        {m.definition && (
                          <p className="text-xs text-gray-600 mt-1">{m.definition}</p>
                        )}
                        {m.scoringGuidance && (
                          <p className="text-xs text-gray-500 mt-1 italic">{m.scoringGuidance}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

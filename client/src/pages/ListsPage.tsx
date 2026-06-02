import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Plus, Upload, Download } from "lucide-react";

export default function ListsPage() {
  const queryClient = useQueryClient();
  const [newListName, setNewListName] = useState("");
  const [importData, setImportData] = useState("");
  const [showImport, setShowImport] = useState(false);

  const { data: lists } = useQuery({
    queryKey: ["lists"],
    queryFn: api.getLists,
  });

  const createListMutation = useMutation({
    mutationFn: (name: string) => api.createList(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lists"] });
      setNewListName("");
    },
  });

  const handleImport = async () => {
    try {
      const lines = importData.trim().split("\n");
      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const companies = lines.slice(1).map((line) => {
        const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
        const obj: any = {};
        headers.forEach((h, i) => { obj[h] = values[i] || undefined; });
        return obj;
      });

      await api.importCompanies({ companies: JSON.stringify(companies), listName: newListName || "Imported List" });
      queryClient.invalidateQueries({ queryKey: ["lists"] });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      setShowImport(false);
      setImportData("");
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Company Lists</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(!showImport)}
            className="flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
          >
            <Upload className="w-4 h-4" /> Import
          </button>
        </div>
      </div>

      {/* Import Panel */}
      {showImport && (
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="font-medium text-gray-900">Import Companies (CSV)</h3>
          <p className="text-sm text-gray-500">
            Paste CSV data with headers: name, isin, domain, sector, country, ticker
          </p>
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="List name for imported companies"
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
          <textarea
            value={importData}
            onChange={(e) => setImportData(e.target.value)}
            placeholder="name,isin,sector,country&#10;Apple Inc,US0378331005,Technology,US&#10;..."
            className="w-full px-3 py-2 border rounded-lg text-sm h-40 font-mono"
          />
          <button
            onClick={handleImport}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            Import
          </button>
        </div>
      )}

      {/* Create List */}
      <div className="bg-white rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="New list name..."
            className="flex-1 px-3 py-2 border rounded-lg text-sm"
          />
          <button
            onClick={() => newListName && createListMutation.mutate(newListName)}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> Create List
          </button>
        </div>
      </div>

      {/* Lists */}
      <div className="bg-white rounded-lg border">
        <div className="divide-y">
          {lists?.map((list: any) => (
            <div key={list.id} className="px-4 py-3 flex items-center justify-between">
              <div>
                <span className="font-medium text-gray-900">{list.name}</span>
                {list.description && (
                  <span className="text-sm text-gray-500 ml-2">{list.description}</span>
                )}
              </div>
              <span className="text-xs text-gray-400">{list.companyCount || 0} companies</span>
            </div>
          ))}
          {(!lists || lists.length === 0) && (
            <div className="p-8 text-center text-gray-500">
              No lists yet. Create one or import companies.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

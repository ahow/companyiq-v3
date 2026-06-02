import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState } from "react";
import { Plus, Trash2, Upload, Download, Users, X } from "lucide-react";

export default function ListsPage() {
  const queryClient = useQueryClient();
  const [selectedListId, setSelectedListId] = useState<number | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [showAddCompanyModal, setShowAddCompanyModal] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importData, setImportData] = useState("");

  const { data: lists } = useQuery({
    queryKey: ["lists"],
    queryFn: api.getLists,
  });

  const { data: listDetail } = useQuery({
    queryKey: ["list", selectedListId],
    queryFn: () => selectedListId ? api.request(`/lists/${selectedListId}`) : null,
    enabled: !!selectedListId,
  });

  const { data: companiesData } = useQuery({
    queryKey: ["companies"],
    queryFn: api.getCompanies,
  });

  const allCompanies = companiesData?.companies || [];
  const listMembers = listDetail?.members || [];
  const listMemberIds = new Set(listMembers.map((m: any) => m.id));

  const filteredCompanies = allCompanies.filter(
    (c: any) => !listMemberIds.has(c.id) && c.name.toLowerCase().includes(companySearch.toLowerCase())
  );

  const handleCreateList = async () => {
    if (!newListName.trim()) return;
    try {
      const result = await api.request("/lists", {
        method: "POST",
        body: JSON.stringify({ name: newListName }),
      });
      setNewListName("");
      setShowCreateModal(false);
      queryClient.invalidateQueries({ queryKey: ["lists"] });
      setSelectedListId(result.id);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteList = async (id: number) => {
    if (!confirm("Delete this list?")) return;
    try {
      await api.request(`/lists/${id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["lists"] });
      if (selectedListId === id) setSelectedListId(null);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleAddToList = async (companyId: number) => {
    if (!selectedListId) return;
    try {
      await api.request(`/lists/${selectedListId}/members`, {
        method: "POST",
        body: JSON.stringify({ companyId }),
      });
      queryClient.invalidateQueries({ queryKey: ["list", selectedListId] });
      queryClient.invalidateQueries({ queryKey: ["lists"] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleRemoveFromList = async (companyId: number) => {
    if (!selectedListId) return;
    try {
      await api.request(`/lists/${selectedListId}/members/${companyId}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["list", selectedListId] });
      queryClient.invalidateQueries({ queryKey: ["lists"] });
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleImport = async () => {
    if (!importData.trim()) return;
    try {
      const lines = importData.trim().split("\n").filter((l) => l.trim());
      const header = lines[0].toLowerCase();
      const hasHeader = header.includes("name") || header.includes("isin");
      const dataLines = hasHeader ? lines.slice(1) : lines;

      const companies = dataLines.map((line) => {
        const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
        return { name: parts[0], isin: parts[1] || undefined, sector: parts[2] || undefined, country: parts[3] || undefined };
      });

      await api.importCompanies({ companies: JSON.stringify(companies), listName: newListName || "Imported List" });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["lists"] });
      queryClient.invalidateQueries({ queryKey: ["list", selectedListId] });
      setShowImport(false);
      setImportData("");
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleExportList = () => {
    if (!listMembers.length) return;
    const csv = [
      "Name,ISIN,Sector,Score,Status",
      ...listMembers.map((c: any) =>
        `"${c.name}","${c.isin || ""}","${c.sector || ""}",${c.totalScore ?? ""},${c.analysisStatus || "pending"}`
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${listDetail?.list?.name || "list"}_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Company Lists</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-1 px-3 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700"
          >
            <Upload className="w-4 h-4" /> Import
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> New List
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Lists Panel */}
        <div className="col-span-1">
          <div className="bg-white rounded-lg border">
            <div className="p-4 border-b">
              <h2 className="font-semibold text-gray-700 text-sm">Your Lists</h2>
            </div>
            <div className="divide-y">
              {lists?.map((l: any) => (
                <div
                  key={l.id}
                  className={`px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 ${
                    selectedListId === l.id ? "bg-blue-50 border-l-2 border-l-blue-600" : ""
                  }`}
                  onClick={() => setSelectedListId(l.id)}
                >
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-gray-400" />
                    <div>
                      <span className="text-sm font-medium text-gray-900">{l.name}</span>
                      <span className="text-xs text-gray-400 ml-2">({l.companyCount || l.memberCount || 0})</span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteList(l.id); }}
                    className="text-red-400 hover:text-red-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              {(!lists || lists.length === 0) && (
                <div className="p-6 text-center text-gray-400 text-sm">
                  No lists created yet.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* List Members Panel */}
        <div className="col-span-2">
          {selectedListId && listDetail ? (
            <div className="bg-white rounded-lg border">
              <div className="p-4 border-b flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-gray-900">{listDetail.list?.name}</h2>
                  <p className="text-xs text-gray-500">{listMembers.length} companies</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowAddCompanyModal(true)}
                    className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs hover:bg-gray-50"
                  >
                    <Plus className="w-3 h-3" /> Add
                  </button>
                  <button
                    onClick={handleExportList}
                    className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs hover:bg-gray-50"
                  >
                    <Download className="w-3 h-3" /> Export
                  </button>
                </div>
              </div>
              {listMembers.length > 0 ? (
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-gray-50">
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase">Company</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase">ISIN</th>
                      <th className="text-center px-4 py-2 text-xs font-medium text-gray-500 uppercase">Score</th>
                      <th className="text-center px-4 py-2 text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {listMembers.map((c: any) => (
                      <tr key={c.id} className="border-b hover:bg-gray-50">
                        <td className="px-4 py-2 text-sm font-medium text-gray-900">{c.name}</td>
                        <td className="px-4 py-2 text-sm text-gray-500">{c.isin || "-"}</td>
                        <td className="px-4 py-2 text-center text-sm font-semibold">
                          {c.totalScore !== null && c.totalScore !== undefined ? `${c.totalScore}%` : "-"}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            c.analysisStatus === "completed" ? "bg-green-100 text-green-700" :
                            c.analysisStatus === "failed" ? "bg-red-100 text-red-700" :
                            c.analysisStatus === "analyzing" ? "bg-blue-100 text-blue-700" :
                            "bg-gray-100 text-gray-600"
                          }`}>
                            {c.analysisStatus || "pending"}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <button
                            onClick={() => handleRemoveFromList(c.id)}
                            className="text-red-400 hover:text-red-600"
                            title="Remove from list"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-8 text-center text-gray-400 text-sm">
                  No companies in this list yet. Add companies or import a CSV.
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-lg border p-8 text-center text-gray-400">
              Select a list to view its members.
            </div>
          )}
        </div>
      </div>

      {/* Add Company Modal */}
      {showAddCompanyModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-[500px] shadow-xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Add Companies to List</h3>
              <button onClick={() => setShowAddCompanyModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm mb-3"
              placeholder="Search companies..."
              autoFocus
            />
            <div className="flex-1 overflow-y-auto divide-y border rounded-lg max-h-[400px]">
              {filteredCompanies.slice(0, 50).map((c: any) => (
                <div key={c.id} className="px-3 py-2 flex items-center justify-between hover:bg-gray-50">
                  <div>
                    <span className="text-sm font-medium text-gray-900">{c.name}</span>
                    {c.isin && <span className="text-xs text-gray-400 ml-2">{c.isin}</span>}
                  </div>
                  <button
                    onClick={() => handleAddToList(c.id)}
                    className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
                  >
                    Add
                  </button>
                </div>
              ))}
              {filteredCompanies.length === 0 && (
                <div className="p-4 text-center text-gray-400 text-sm">
                  No companies available to add.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-[600px] shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Import Companies (CSV)</h3>
              <button onClick={() => setShowImport(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-3">
              Paste CSV data with headers: name, isin, sector, country
            </p>
            <input
              type="text"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="List name for imported companies"
              className="w-full px-3 py-2 border rounded-lg text-sm mb-3"
            />
            <textarea
              value={importData}
              onChange={(e) => setImportData(e.target.value)}
              placeholder={"name,isin,sector,country\nApple Inc,US0378331005,Technology,US\n..."}
              className="w-full px-3 py-2 border rounded-lg text-sm h-40 font-mono"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowImport(false)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create List Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl">
            <h3 className="text-lg font-semibold mb-4">Create New List</h3>
            <input
              type="text"
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
              placeholder="List name..."
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreateList()}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateList}
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

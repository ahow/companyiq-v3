import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useState, useRef } from "react";
import { Plus, Trash2, Upload, Download, Users, X, FileSpreadsheet, Type } from "lucide-react";

export default function ListsPage() {
  const queryClient = useQueryClient();
  const [selectedListId, setSelectedListId] = useState<number | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [showAddCompanyModal, setShowAddCompanyModal] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importMode, setImportMode] = useState<"file" | "paste">("file");
  const [importData, setImportData] = useState("");
  const [importListName, setImportListName] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    if (importMode === "file" && !importFile) {
      alert("Please select a file to upload.");
      return;
    }
    if (importMode === "paste" && !importData.trim()) {
      alert("Please paste some company data.");
      return;
    }
    if (!importListName.trim()) {
      alert("Please enter a list name.");
      return;
    }

    setImporting(true);
    setImportResult(null);

    try {
      const formData = new FormData();
      formData.append("listName", importListName);

      if (importMode === "file" && importFile) {
        formData.append("file", importFile);
      } else if (importMode === "paste") {
        formData.append("pastedText", importData);
      }

      const res = await fetch("/api/companies/import", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }

      const result = await res.json();
      setImportResult(result);
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      queryClient.invalidateQueries({ queryKey: ["lists"] });
    } catch (err: any) {
      alert(`Import failed: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleExportList = () => {
    if (!listMembers.length) return;
    const csv = [
      "Name,ISIN,Sector,Country,Score,Status",
      ...listMembers.map((c: any) =>
        `"${c.name}","${c.isin || ""}","${c.sector || ""}","${c.country || ""}",${c.total_score ?? c.totalScore ?? ""},${c.analysis_status || c.analysisStatus || "pending"}`
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${listDetail?.name || "list"}_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetImportModal = () => {
    setShowImport(false);
    setImportFile(null);
    setImportData("");
    setImportListName("");
    setImportResult(null);
    setImportMode("file");
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
                  <h2 className="font-semibold text-gray-900">{listDetail.name}</h2>
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
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase">Sector</th>
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
                        <td className="px-4 py-2 text-sm text-gray-500">{c.sector || "-"}</td>
                        <td className="px-4 py-2 text-center text-sm font-semibold">
                          {c.total_score !== null && c.total_score !== undefined ? `${c.total_score}%` : "-"}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            (c.analysis_status || c.analysisStatus) === "completed" ? "bg-green-100 text-green-700" :
                            (c.analysis_status || c.analysisStatus) === "failed" ? "bg-red-100 text-red-700" :
                            (c.analysis_status || c.analysisStatus) === "analyzing" ? "bg-blue-100 text-blue-700" :
                            "bg-gray-100 text-gray-600"
                          }`}>
                            {c.analysis_status || c.analysisStatus || "pending"}
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
                  No companies in this list yet. Add companies or import a CSV/XLSX file.
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
          <div className="bg-white rounded-lg p-6 w-[650px] shadow-xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Import Companies</h3>
              <button onClick={resetImportModal} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Import Mode Tabs */}
            <div className="flex border-b mb-4">
              <button
                onClick={() => setImportMode("file")}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  importMode === "file"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                <FileSpreadsheet className="w-4 h-4" /> Upload File (CSV / XLSX)
              </button>
              <button
                onClick={() => setImportMode("paste")}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  importMode === "paste"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                <Type className="w-4 h-4" /> Paste Text
              </button>
            </div>

            {/* List Name */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">List Name</label>
              <input
                type="text"
                value={importListName}
                onChange={(e) => setImportListName(e.target.value)}
                placeholder="e.g., FTSE 100, My Portfolio, Q4 Review"
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>

            {/* File Upload Mode */}
            {importMode === "file" && (
              <div className="space-y-3">
                <div
                  className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {importFile ? (
                    <div>
                      <FileSpreadsheet className="w-8 h-8 text-green-600 mx-auto mb-2" />
                      <p className="text-sm font-medium text-gray-900">{importFile.name}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {(importFile.size / 1024).toFixed(1)} KB — Click to change
                      </p>
                    </div>
                  ) : (
                    <div>
                      <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                      <p className="text-sm text-gray-600">Click to select a CSV or XLSX file</p>
                      <p className="text-xs text-gray-400 mt-1">Supports .csv, .xlsx, .xls (up to 50MB)</p>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                />
                <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600">
                  <p className="font-medium mb-1">Supported formats:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    <li>CSV with headers: name, isin, sector, country, domain</li>
                    <li>Excel (.xlsx) with a header row in the first sheet</li>
                    <li>MSCI-style exports (LEVEL2 SECTOR NAME, GEOGRAPHIC DESCR., etc.)</li>
                  </ul>
                  <p className="mt-2 text-gray-500">Column names are matched flexibly — "Company", "NAME", "company_name" all work.</p>
                </div>
              </div>
            )}

            {/* Paste Text Mode */}
            {importMode === "paste" && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Paste company names or CSV data
                  </label>
                  <textarea
                    value={importData}
                    onChange={(e) => setImportData(e.target.value)}
                    placeholder={"Option 1 — One company per line:\nApple Inc\nMicrosoft Corporation\nAmazon.com Inc\n\nOption 2 — CSV format:\nname,isin,sector,country\nApple Inc,US0378331005,Technology,US\nMicrosoft,US5949181045,Technology,US"}
                    className="w-full px-3 py-2 border rounded-lg text-sm h-48 font-mono"
                  />
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600">
                  <p className="font-medium mb-1">Accepted formats:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    <li><strong>Plain list:</strong> One company name per line</li>
                    <li><strong>CSV data:</strong> Comma-separated with optional headers (name, isin, sector, country, domain)</li>
                  </ul>
                  <p className="mt-2 text-gray-500">Existing companies will be skipped (no duplicates) but still added to the list.</p>
                </div>
              </div>
            )}

            {/* Import Result */}
            {importResult && (
              <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-sm font-medium text-green-800">Import successful!</p>
                <p className="text-xs text-green-700 mt-1">
                  {importResult.imported} new companies imported, {importResult.existing || 0} already existed.
                  List "{importResult.listName}" created with {importResult.imported + (importResult.existing || 0)} companies.
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={resetImportModal}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                {importResult ? "Close" : "Cancel"}
              </button>
              {!importResult && (
                <button
                  onClick={handleImport}
                  disabled={importing}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {importing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" /> Import
                    </>
                  )}
                </button>
              )}
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

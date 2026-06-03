import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { AlertCircle, Clock, Activity } from "lucide-react";

export default function DiagnosticsPage() {
  const { data: errors = [] } = useQuery({
    queryKey: ["recentErrors"],
    queryFn: api.getRecentErrors,
    refetchInterval: 10000,
  });

  const { data: batchRuns = [] } = useQuery({
    queryKey: ["batchRuns"],
    queryFn: api.getBatchRuns,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Activity className="w-5 h-5 text-blue-600" />
        <h1 className="text-xl font-bold text-gray-900">Diagnostics</h1>
      </div>

      {/* Batch History */}
      <div className="bg-white rounded-lg border">
        <div className="px-4 py-3 border-b">
          <h2 className="font-semibold text-gray-900">Batch Run History</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">ID</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Status</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Progress</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Started</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {batchRuns.map((run: any) => (
                <tr key={run.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-sm">{run.id}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      run.status === "completed" ? "bg-green-100 text-green-700" :
                      run.status === "running" ? "bg-blue-100 text-blue-700" :
                      run.status === "cancelled" ? "bg-yellow-100 text-yellow-700" :
                      "bg-gray-100 text-gray-600"
                    }`}>
                      {run.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600">
                    {run.completedJobs}/{run.totalJobs} done, {run.failedJobs} failed
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {new Date(run.startedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
              {batchRuns.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-500">No batch runs yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Errors */}
      <div className="bg-white rounded-lg border">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-500" />
          <h2 className="font-semibold text-gray-900">Recent Errors</h2>
          <span className="text-xs text-gray-400">({errors.length})</span>
        </div>
        <div className="divide-y max-h-96 overflow-y-auto">
          {errors.map((err: any) => (
            <div key={err.id} className="px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 bg-red-50 text-red-600 rounded">{err.stage || "unknown"}</span>
                  {err.companyName && <span className="text-xs text-gray-500">{err.companyName}</span>}
                </div>
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {new Date(err.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-sm text-red-700 mt-1">{err.error}</p>
            </div>
          ))}
          {errors.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-500">No errors recorded.</div>
          )}
        </div>
      </div>
    </div>
  );
}

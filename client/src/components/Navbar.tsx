import { useAuth } from "../App";
import { BarChart3, List, FileText, Sparkles, Settings, LogOut, FlaskConical } from "lucide-react";

interface NavbarProps {
  currentPage: string;
  onNavigate: (page: any) => void;
}

export default function Navbar({ currentPage, onNavigate }: NavbarProps) {
  const { user, workspace, logout } = useAuth();

  const links = [
    { id: "dashboard", label: "Dashboard", icon: BarChart3 },
    { id: "lists", label: "Lists", icon: List },
    { id: "framework", label: "Framework", icon: FileText },
    { id: "ai-builder", label: "AI Builder", icon: Sparkles },
    { id: "results", label: "Results", icon: FlaskConical },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => onNavigate("dashboard")}>
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">IQ</span>
              </div>
              <span className="font-semibold text-gray-900">CompanyIQ</span>
              <span className="text-xs text-gray-400 ml-1">v3.0</span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {links.map((link) => {
              const Icon = link.icon;
              const isActive = currentPage === link.id;
              return (
                <button
                  key={link.id}
                  onClick={() => onNavigate(link.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {link.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            {workspace && (
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                {workspace.name}
              </span>
            )}
            <span className="text-sm text-gray-600">{user?.name || user?.email}</span>
            <button
              onClick={logout}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-red-600 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}

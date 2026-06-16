import { useAuth } from "../App";
import { BarChart3, List, FileText, Sparkles, Settings, LogOut, FlaskConical, Activity, BookOpen, Globe } from "lucide-react";
import ThemeToggle from "./ThemeToggle";

interface NavbarProps {
  currentPage: string;
  onNavigate: (page: any) => void;
}

export default function Navbar({ currentPage, onNavigate }: NavbarProps) {
  const { user, workspace, logout } = useAuth();

  const links = [
    { id: "dashboard", label: "Dashboard", icon: BarChart3 },
    { id: "lists", label: "Lists", icon: List },
    { id: "domains", label: "Domains", icon: Globe },
    { id: "framework", label: "Framework", icon: FileText },
    { id: "ai-builder", label: "AI Builder", icon: Sparkles },
    { id: "results", label: "Results", icon: FlaskConical },
    { id: "diagnostics", label: "Diagnostics", icon: Activity },
    { id: "settings", label: "Settings", icon: Settings },
    { id: "guide", label: "Guide", icon: BookOpen },
  ];

  return (
    <nav className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shadow-sm">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => onNavigate("dashboard")}>
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">IQ</span>
              </div>
              <span className="font-semibold text-gray-900 dark:text-white">CompanyIQ</span>
              <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">v3.0</span>
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
                      ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      : "text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
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
              <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                {workspace.name}
              </span>
            )}
            <span className="text-sm text-gray-600 dark:text-gray-300">{user?.name || user?.email}</span>
            <ThemeToggle />
            <button
              onClick={logout}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}

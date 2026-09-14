import { useState, useRef, useEffect } from "react";
import { useAuth } from "../App";
import {
  BarChart3,
  List,
  FileText,
  Settings,
  LogOut,
  FlaskConical,
  Activity,
  BookOpen,
  Globe,
  Layers,
  MoreHorizontal,
  ChevronDown,
  HelpCircle,
} from "lucide-react";
import ThemeToggle from "./ThemeToggle";

interface NavbarProps {
  currentPage: string;
  onNavigate: (page: any) => void;
}

type NavItem = { id: string; label: string; icon: typeof BarChart3 };

// Presentational grouping only — every page below is still reachable, just
// organised into primary tabs + two dropdown menus + corner icons so the bar
// stays uncluttered as the app grows.
const PRIMARY: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: BarChart3 },
  { id: "lists", label: "Lists", icon: List },
  { id: "results", label: "Results", icon: FlaskConical },
];

const FRAMEWORKS_GROUP: NavItem[] = [
  { id: "framework", label: "Framework", icon: FileText },
  { id: "framework-builder-v2", label: "Framework Builder v2", icon: Layers },
];

const MORE_GROUP: NavItem[] = [
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "domains", label: "Domains", icon: Globe },
];

// Lightweight dropdown: click to toggle, closes on outside click or Escape, and
// closes after a selection. No external dropdown library required.
function NavDropdown({
  label,
  triggerIcon: TriggerIcon,
  items,
  currentPage,
  onNavigate,
}: {
  label: string;
  triggerIcon: typeof BarChart3;
  items: NavItem[];
  currentPage: string;
  onNavigate: (page: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const groupActive = items.some((i) => i.id === currentPage);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          groupActive
            ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
            : "text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
        }`}
      >
        <TriggerIcon className="w-4 h-4" />
        {label}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 mt-1 min-w-[13rem] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg py-1 z-50"
        >
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = currentPage === item.id;
            return (
              <button
                key={item.id}
                role="menuitem"
                onClick={() => {
                  onNavigate(item.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  isActive
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                    : "text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Navbar({ currentPage, onNavigate }: NavbarProps) {
  const { user, workspace, logout } = useAuth();

  const cornerBtn = (active: boolean) =>
    `flex items-center justify-center w-9 h-9 rounded-md transition-colors ${
      active
        ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
        : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
    }`;

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
            {PRIMARY.map((link) => {
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

            <NavDropdown
              label="Frameworks"
              triggerIcon={FileText}
              items={FRAMEWORKS_GROUP}
              currentPage={currentPage}
              onNavigate={onNavigate}
            />
            <NavDropdown
              label="More"
              triggerIcon={MoreHorizontal}
              items={MORE_GROUP}
              currentPage={currentPage}
              onNavigate={onNavigate}
            />
          </div>

          <div className="flex items-center gap-2">
            {workspace && (
              <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                {workspace.name}
              </span>
            )}
            <span className="text-sm text-gray-600 dark:text-gray-300 hidden md:inline">{user?.name || user?.email}</span>
            <button
              type="button"
              onClick={() => onNavigate("guide")}
              title="Guide"
              aria-label="Guide"
              className={cornerBtn(currentPage === "guide")}
            >
              <HelpCircle className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate("settings")}
              title="Settings"
              aria-label="Settings"
              className={cornerBtn(currentPage === "settings")}
            >
              <Settings className="w-5 h-5" />
            </button>
            <ThemeToggle />
            <button
              onClick={logout}
              title="Log out"
              aria-label="Log out"
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

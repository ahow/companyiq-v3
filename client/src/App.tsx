import { useState, useEffect, createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import CompanyDetailPage from "./pages/CompanyDetailPage";
import FrameworkPage from "./pages/FrameworkPage";
import ListsPage from "./pages/ListsPage";
import ResultsPage from "./pages/ResultsPage";
import SettingsPage from "./pages/SettingsPage";
import AIBuilderPage from "./pages/AIBuilderPage";
import DiagnosticsPage from "./pages/DiagnosticsPage";
import GuidePage from "./pages/GuidePage";
import Navbar from "./components/Navbar";

interface User {
  id: number;
  email: string;
  name: string;
}

interface AuthContextType {
  user: User | null;
  workspace: { id: number; name: string } | null;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  workspace: null,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

type Page =
  | "dashboard"
  | "company"
  | "framework"
  | "lists"
  | "results"
  | "settings"
  | "ai-builder"
  | "diagnostics"
  | "guide";

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);

  const { data: session, isLoading, refetch: refetchSession } = useQuery({
    queryKey: ["session"],
    queryFn: api.getSession,
    retry: false,
  });

  const handleLogout = async () => {
    await api.logout();
    refetchSession();
  };

  const navigate = (p: Page, companyId?: number) => {
    setPage(p);
    if (companyId) setSelectedCompanyId(companyId);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!session?.user) {
    return <LoginPage onSuccess={() => refetchSession()} />;
  }

  const authValue: AuthContextType = {
    user: session.user,
    workspace: session.workspace,
    logout: handleLogout,
  };

  return (
    <AuthContext.Provider value={authValue}>
      <div className="min-h-screen bg-gray-50">
        <Navbar currentPage={page} onNavigate={navigate} />
        <main className="max-w-7xl mx-auto px-4 py-6">
          {page === "dashboard" && (
            <DashboardPage onViewCompany={(id) => navigate("company", id)} />
          )}
          {page === "company" && selectedCompanyId && (
            <CompanyDetailPage
              companyId={selectedCompanyId}
              onBack={() => navigate("dashboard")}
            />
          )}
          {page === "framework" && <FrameworkPage />}
          {page === "lists" && <ListsPage />}
          {page === "results" && <ResultsPage />}
          {page === "settings" && <SettingsPage />}
          {page === "ai-builder" && <AIBuilderPage />}
          {page === "diagnostics" && <DiagnosticsPage />}
          {page === "guide" && <GuidePage />}
        </main>
      </div>
    </AuthContext.Provider>
  );
}

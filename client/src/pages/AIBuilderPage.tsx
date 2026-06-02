import { useState, useRef, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Sparkles, Save } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function AIBuilderPage() {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [frameworkDraft, setFrameworkDraft] = useState<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    try {
      const res = await fetch("/api/framework-builder/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          messages: [...messages, { role: "user", content: userMessage }],
        }),
      });

      const data = await res.json();

      if (data.message) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
      }
      if (data.frameworkDraft) {
        setFrameworkDraft(data.frameworkDraft);
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!frameworkDraft) return;

    try {
      const res = await fetch("/api/framework-builder/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ framework: frameworkDraft }),
      });

      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["frameworks"] });
        alert("Framework saved and activated!");
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-600" /> AI Framework Builder
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Have a conversation to design a rigorous assessment framework.
          </p>
        </div>
        {frameworkDraft && (
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
          >
            <Save className="w-4 h-4" /> Save & Activate
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto bg-white rounded-lg border p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <Sparkles className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p>Start a conversation to build your assessment framework.</p>
            <p className="text-sm mt-1">Try: "Build a framework for assessing climate risk disclosure"</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-4 py-3 ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg px-4 py-3">
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                Thinking...
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Framework Draft Banner */}
      {frameworkDraft && (
        <div className="mt-2 bg-green-50 border border-green-200 rounded-lg p-3 flex items-center justify-between">
          <div>
            <span className="text-green-800 font-medium text-sm">
              Framework draft ready: {frameworkDraft.name}
            </span>
            <span className="text-green-600 text-xs ml-2">
              {frameworkDraft.categories?.length || 0} categories, {frameworkDraft.categories?.reduce((sum: number, c: any) => sum + (c.measures?.length || 0), 0) || 0} measures
            </span>
          </div>
          <button
            onClick={handleSave}
            className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700"
          >
            <Save className="w-3.5 h-3.5" /> Save & Activate
          </button>
        </div>
      )}

      {/* Input */}
      <div className="mt-3 flex items-center gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your response... (Enter to send, Shift+Enter for new line)"
          className="flex-1 px-4 py-3 border rounded-lg text-sm resize-none h-12 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          rows={1}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || loading}
          className="p-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

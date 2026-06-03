import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Send, Sparkles, Save, Loader2, RotateCcw, Paperclip, X, FileText, Check, MessageSquare } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{ filename: string; charCount: number }>;
}

interface UploadedFile {
  filename: string;
  content: string;
  charCount: number;
  truncated: boolean;
}

export default function AIBuilderPage() {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [frameworkDraft, setFrameworkDraft] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMessage = input.trim();
    setInput("");

    const userMsg: Message = {
      role: "user",
      content: userMessage,
      attachments: uploadedFiles.length > 0
        ? uploadedFiles.map((f) => ({ filename: f.filename, charCount: f.charCount }))
        : undefined,
    };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setLoading(true);

    try {
      // Build fileContext from uploaded files
      const fileContext = uploadedFiles.length > 0
        ? uploadedFiles.map((f) => ({ filename: f.filename, content: f.content }))
        : undefined;

      const res = await fetch("/api/framework-builder/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
          currentDraft: frameworkDraft,
          fileContext,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }

      const data = await res.json();
      if (data.message) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.message }]);
      }
      if (data.frameworkDraft) {
        setFrameworkDraft(data.frameworkDraft);
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message}. Please try again.` }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!frameworkDraft || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/framework-builder/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ framework: frameworkDraft }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["frameworks"] });
        setSaved(true);
      } else {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        alert(err.error || "Save failed");
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setFrameworkDraft(null);
    setSaved(false);
    setUploadedFiles([]);
    setInput("");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/api/framework-builder/upload", {
          method: "POST",
          credentials: "include",
          body: formData,
        });

        if (res.ok) {
          const result = await res.json();
          setUploadedFiles((prev) => [
            ...prev,
            {
              filename: result.filename,
              content: result.content,
              charCount: result.charCount,
              truncated: result.truncated,
            },
          ]);
        } else {
          const err = await res.json().catch(() => ({ error: "Upload failed" }));
          alert(`Upload failed for ${file.name}: ${err.error}`);
        }
      }
    } catch (err: any) {
      alert(`Upload error: ${err.message}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeFile = (index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Render markdown-like content for assistant messages
  const renderContent = (content: string) => {
    // Remove JSON blocks from display (they're captured in the draft)
    const cleaned = content.replace(/```json\s*[\s\S]*?```/g, "").trim();
    if (!cleaned) return <p className="text-sm text-gray-500 italic">Framework JSON generated (see draft below).</p>;

    const lines = cleaned.split("\n");
    const elements: JSX.Element[] = [];
    let listItems: JSX.Element[] = [];

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(<ul key={`list-${elements.length}`} className="list-disc ml-5 space-y-1 my-2">{listItems}</ul>);
        listItems = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip code fences
      if (line.startsWith("```")) continue;

      // Headers
      if (line.startsWith("### ")) {
        flushList();
        elements.push(<h4 key={i} className="font-semibold text-sm mt-3 mb-1">{renderInline(line.slice(4))}</h4>);
        continue;
      }
      if (line.startsWith("## ")) {
        flushList();
        elements.push(<h3 key={i} className="font-bold text-base mt-3 mb-1">{renderInline(line.slice(3))}</h3>);
        continue;
      }
      if (line.startsWith("# ")) {
        flushList();
        elements.push(<h2 key={i} className="font-bold text-lg mt-3 mb-1">{renderInline(line.slice(2))}</h2>);
        continue;
      }

      // Numbered list
      if (/^\d+\.\s/.test(line)) {
        flushList();
        const match = line.match(/^\d+\.\s(.*)/);
        if (match) {
          elements.push(
            <div key={i} className="flex gap-2 my-1">
              <span className="text-gray-400 font-mono text-xs mt-0.5">{line.match(/^\d+/)?.[0]}.</span>
              <span className="text-sm">{renderInline(match[1])}</span>
            </div>
          );
        }
        continue;
      }

      // Bullet list
      if (line.startsWith("- ") || line.startsWith("* ")) {
        listItems.push(<li key={i} className="text-sm">{renderInline(line.slice(2))}</li>);
        continue;
      }

      // Checkbox items
      if (line.startsWith("- [ ] ") || line.startsWith("- [x] ")) {
        flushList();
        const checked = line.startsWith("- [x] ");
        elements.push(
          <div key={i} className="flex items-start gap-2 my-0.5">
            <input type="checkbox" checked={checked} readOnly className="mt-1 w-3.5 h-3.5 rounded" />
            <span className="text-sm">{renderInline(line.slice(6))}</span>
          </div>
        );
        continue;
      }

      // Empty line
      if (line.trim() === "") {
        flushList();
        continue;
      }

      // Regular paragraph
      flushList();
      elements.push(<p key={i} className="text-sm my-1">{renderInline(line)}</p>);
    }

    flushList();
    return <div className="space-y-0.5">{elements}</div>;
  };

  const renderInline = (text: string): (string | JSX.Element)[] => {
    const parts: (string | JSX.Element)[] = [];
    const regex = /(\*\*.*?\*\*)|(\*.*?\*)|(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }

      if (match[1]) {
        parts.push(<strong key={match.index}>{match[1].slice(2, -2)}</strong>);
      } else if (match[2]) {
        parts.push(<em key={match.index}>{match[2].slice(1, -1)}</em>);
      } else if (match[3]) {
        parts.push(
          <code key={match.index} className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono text-purple-700">
            {match[3].slice(1, -1)}
          </code>
        );
      } else if (match[4]) {
        parts.push(
          <a key={match.index} href={match[6]} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
            {match[5]}
          </a>
        );
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return parts.length > 0 ? parts : [text];
  };

  const suggestionChips = [
    "I want to assess corporate AI governance practices",
    "Help me build a climate risk disclosure framework",
    "I need to evaluate cybersecurity governance",
    "Suggest topics for a supply chain transparency assessment",
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-600" /> AI Framework Builder
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Have a conversation to design a rigorous assessment framework. Upload reference files to inform the design.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {frameworkDraft && !saved && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save & Activate
            </button>
          )}
          {saved && (
            <span className="flex items-center gap-2 px-3 py-2 bg-green-50 text-green-700 rounded-lg text-sm border border-green-200">
              <Check className="w-4 h-4" />
              Framework Saved
            </span>
          )}
          <button
            onClick={handleNewChat}
            className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50 text-gray-600"
          >
            <RotateCcw className="w-4 h-4" />
            New Chat
          </button>
        </div>
      </div>

      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto bg-white rounded-lg border mb-4 p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center py-12 space-y-4">
            <MessageSquare className="w-12 h-12 text-gray-300 mx-auto" />
            <div>
              <h3 className="text-lg font-medium text-gray-700">Start designing your framework</h3>
              <p className="text-sm text-gray-500 mt-2 max-w-lg mx-auto">
                Describe what you want to assess companies on. You can also upload reference files (PDFs, documents, spreadsheets) to help inform the template design.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center mt-4">
              {suggestionChips.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-full text-xs hover:bg-blue-100 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-4 py-3 ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-50 border border-gray-200"
              }`}
            >
              {msg.role === "user" ? (
                <div>
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {msg.attachments.map((att, i) => (
                        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/30 rounded text-[10px]">
                          <FileText className="w-3 h-3" />
                          {att.filename}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="prose prose-sm max-w-none">{renderContent(msg.content)}</div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Thinking...
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Draft Preview Banner */}
      {frameworkDraft && !saved && (
        <div className="mb-3 bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-green-800">
                Framework draft ready: <strong>{frameworkDraft.name}</strong>
              </p>
              <p className="text-xs text-green-600 mt-0.5">
                {frameworkDraft.categories?.length || 0} categories,{" "}
                {frameworkDraft.categories?.reduce((sum: number, c: any) => sum + (c.measures?.length || 0), 0) || 0} measures
                {frameworkDraft.trustedSources?.length ? `, ${frameworkDraft.trustedSources.length} trusted sources` : ""}
                {frameworkDraft.searchTemplates?.length ? `, ${frameworkDraft.searchTemplates.length} search templates` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 text-xs"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save & Activate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Uploaded Files Display */}
      {uploadedFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {uploadedFiles.map((file, idx) => (
            <div
              key={idx}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700"
            >
              <FileText className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="max-w-[150px] truncate" title={file.filename}>{file.filename}</span>
              <span className="text-blue-400">
                ({file.truncated ? "100k+" : `${Math.round(file.charCount / 1000)}k`} chars)
              </span>
              <button
                onClick={() => removeFile(idx)}
                className="ml-0.5 p-0.5 hover:bg-blue-100 rounded"
                title="Remove file"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input Area */}
      <div className="bg-white rounded-lg border p-3 flex gap-2 items-end">
        {/* File upload button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="flex items-center justify-center w-10 h-10 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
          title="Upload reference files (PDF, DOCX, TXT, CSV, XLSX)"
        >
          {isUploading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Paperclip className="w-5 h-5" />
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.csv,.json,.md,.xlsx,.xls"
          multiple
          className="hidden"
          onChange={handleFileUpload}
        />

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            messages.length === 0
              ? "Describe what you want to assess companies on..."
              : "Type your response... (Enter to send, Shift+Enter for new line)"
          }
          className="flex-1 resize-none px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-h-[40px] max-h-[200px]"
          rows={1}
        />

        <button
          onClick={sendMessage}
          disabled={!input.trim() || loading}
          className="flex items-center justify-center w-10 h-10 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

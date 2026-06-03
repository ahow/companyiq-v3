import { BookOpen, BarChart3, FolderOpen, Building2, Sparkles, ClipboardCheck, Settings, Activity, ArrowRight, Lightbulb } from "lucide-react";

export default function GuidePage() {
  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      {/* Header */}
      <div className="border-b border-gray-200 pb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">How to Use CompanyIQ</h1>
        </div>
        <p className="text-gray-600 mt-2">
          CompanyIQ is an AI-powered platform for assessing corporate disclosures against customisable frameworks.
          It automates the process of discovering, fetching, and analysing public documents to score companies
          on their transparency and governance practices.
        </p>
      </div>

      {/* Quick Start */}
      <section className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h2 className="text-xl font-semibold text-blue-900 flex items-center gap-2 mb-4">
          <Lightbulb className="w-5 h-5" />
          Quick Start Guide
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {[
            { step: "1", title: "Create a List", desc: "Add companies to assess" },
            { step: "2", title: "Build a Framework", desc: "Define what to measure" },
            { step: "3", title: "Run Analysis", desc: "Click Analyse on Dashboard" },
            { step: "4", title: "Review Scores", desc: "Check company details" },
            { step: "5", title: "Export Results", desc: "Download CSV or share" },
          ].map((item, i) => (
            <div key={i} className="flex flex-col items-center text-center">
              <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold mb-2">
                {item.step}
              </div>
              <p className="text-sm font-medium text-blue-900">{item.title}</p>
              <p className="text-xs text-blue-700">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Table of Contents */}
      <section className="bg-white border border-gray-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Contents</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {[
            { href: "#dashboard", label: "Dashboard", icon: BarChart3 },
            { href: "#lists", label: "Company Lists", icon: FolderOpen },
            { href: "#framework", label: "Framework Management", icon: Building2 },
            { href: "#ai-builder", label: "AI Framework Builder", icon: Sparkles },
            { href: "#results", label: "Results & Export", icon: ClipboardCheck },
            { href: "#settings", label: "Settings", icon: Settings },
            { href: "#diagnostics", label: "Diagnostics", icon: Activity },
            { href: "#workflow", label: "Analysis Workflow", icon: ArrowRight },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <a
                key={item.href}
                href={item.href}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-gray-700 hover:bg-gray-50 hover:text-blue-600 transition-colors"
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </a>
            );
          })}
        </div>
      </section>

      {/* Dashboard */}
      <section id="dashboard" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-blue-600" />
          Dashboard
        </h2>
        <p className="text-gray-700">
          The Dashboard is the main control centre for running and monitoring analyses. It provides an overview
          of your portfolio and allows you to trigger batch analysis across all companies in a selected list.
        </p>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Key Elements</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Element</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Description</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Summary Cards</td>
                <td className="px-4 py-2 text-gray-600">Shows total companies, number analysed, average score, and batch status (Idle/Running)</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Analysis Configuration</td>
                <td className="px-4 py-2 text-gray-600">Select which Company List and Framework Template to use for the next analysis run</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Score Distribution</td>
                <td className="px-4 py-2 text-gray-600">Histogram showing how scores are spread across the portfolio in 10% buckets</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Company Table</td>
                <td className="px-4 py-2 text-gray-600">Lists all companies with their sector, country, current score, and analysis status</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">Analyse / Reset List</td>
                <td className="px-4 py-2 text-gray-600">Buttons to start batch analysis or reset all company scores in the selected list</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Running an Analysis</h3>
        <ol className="list-decimal list-inside space-y-2 text-gray-700">
          <li>Select a <strong>Company List</strong> from the dropdown (e.g., "ACWI 100")</li>
          <li>Select a <strong>Framework Template</strong> — this determines what measures are assessed</li>
          <li>Click <strong>Analyse</strong> to start the batch. The system will process each company through the full pipeline: discovery, fetching, and AI-powered scoring</li>
          <li>Monitor progress via the Batch Status card and the Status column in the company table</li>
          <li>Once complete, scores appear in the Score column and the histogram updates</li>
        </ol>

        <div className="bg-amber-50 border border-amber-200 rounded p-3 mt-3">
          <p className="text-sm text-amber-800">
            <strong>Note:</strong> Analysis typically takes 3-8 minutes per company depending on the number of documents
            found and the complexity of the framework. A 100-company batch may take several hours.
          </p>
        </div>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Additional Actions</h3>
        <ul className="list-disc list-inside space-y-1 text-gray-700">
          <li><strong>+ Add</strong> — Manually add a company to the current list</li>
          <li><strong>Import</strong> — Upload a CSV file with company names, sectors, countries, and domains</li>
          <li><strong>Export</strong> — Download the current company list as a CSV file</li>
          <li><strong>Search</strong> — Filter companies by name using the search box</li>
          <li>Click any company row to view its detailed analysis results</li>
        </ul>
      </section>

      {/* Company Lists */}
      <section id="lists" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <FolderOpen className="w-5 h-5 text-blue-600" />
          Company Lists
        </h2>
        <p className="text-gray-700">
          Company Lists allow you to organise companies into groups for analysis. You might create separate lists
          for different portfolios, indices, or research projects.
        </p>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Managing Lists</h3>
        <ul className="list-disc list-inside space-y-2 text-gray-700">
          <li><strong>Create a new list</strong> — Enter a name and click Create. Lists start empty.</li>
          <li><strong>Import companies</strong> — Upload a CSV file with columns: name, sector, country, domain (optional). The system will auto-detect company websites if domains are not provided.</li>
          <li><strong>Delete a list</strong> — Removes the list and all associated company data.</li>
        </ul>

        <h3 className="text-lg font-medium text-gray-800 mt-4">CSV Import Format</h3>
        <div className="bg-gray-50 border rounded p-3 font-mono text-xs">
          <p>name,sector,country,domain</p>
          <p>Apple Inc,Technology,United States,apple.com</p>
          <p>Samsung Electronics,Technology,South Korea,samsung.com</p>
          <p>Nestlé,Consumer Staples,Switzerland,nestle.com</p>
        </div>
        <p className="text-sm text-gray-600 mt-2">
          The <code className="bg-gray-100 px-1 rounded">domain</code> column is optional but recommended — it significantly improves
          document discovery by enabling site-specific searches.
        </p>
      </section>

      {/* Framework Management */}
      <section id="framework" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Building2 className="w-5 h-5 text-blue-600" />
          Framework Management
        </h2>
        <p className="text-gray-700">
          Frameworks define <em>what</em> you are assessing. Each framework contains a set of measures (questions)
          grouped into categories. During analysis, the AI evaluates each company against every measure in the
          active framework.
        </p>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Framework Structure</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Component</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Description</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Example</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Category</td>
                <td className="px-4 py-2 text-gray-600">Logical grouping of related measures</td>
                <td className="px-4 py-2 text-gray-500 italic">"AI Governance & Ethics"</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Measure ID</td>
                <td className="px-4 py-2 text-gray-600">Unique identifier (category.number format)</td>
                <td className="px-4 py-2 text-gray-500 italic">"1.1-ai-ethics-policy"</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Title</td>
                <td className="px-4 py-2 text-gray-600">The question being assessed (Yes/No format)</td>
                <td className="px-4 py-2 text-gray-500 italic">"Does the company have a published AI ethics policy?"</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Definition</td>
                <td className="px-4 py-2 text-gray-600">Detailed explanation of what constitutes evidence</td>
                <td className="px-4 py-2 text-gray-500 italic">"A formal document outlining principles..."</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Scoring Guidance</td>
                <td className="px-4 py-2 text-gray-600">Criteria for Yes, No, and Partial verdicts</td>
                <td className="px-4 py-2 text-gray-500 italic">"Yes: Standalone policy published..."</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">Evidence Keywords</td>
                <td className="px-4 py-2 text-gray-600">Terms used by the search engine to find relevant passages</td>
                <td className="px-4 py-2 text-gray-500 italic">"responsible AI, ethics board, bias testing"</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="text-lg font-medium text-gray-800 mt-4">AI Editor</h3>
        <p className="text-gray-700">
          Each framework has an <strong>AI Editor</strong> button that opens a chat panel. You can use natural language
          to modify the framework:
        </p>
        <ul className="list-disc list-inside space-y-1 text-gray-700">
          <li>"Remove measures 3.1 and 3.2"</li>
          <li>"Add a new measure about supply chain AI risk"</li>
          <li>"Edit measure 1.1 to focus on board-level oversight"</li>
          <li>"Rename this framework to 'AI Governance v2'"</li>
          <li>"Add CDP and SBTi as trusted sources"</li>
        </ul>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Trusted Sources</h3>
        <p className="text-gray-700">
          Each framework can have <strong>trusted sources</strong> assigned — these are specific disclosure platforms
          (e.g., CDP, SEC EDGAR, NIST) that the system will actively search during document discovery. Trusted sources
          are queried with site-specific searches to find relevant company filings and disclosures.
        </p>
      </section>

      {/* AI Framework Builder */}
      <section id="ai-builder" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-blue-600" />
          AI Framework Builder
        </h2>
        <p className="text-gray-700">
          The AI Builder provides a conversational interface for creating entirely new assessment frameworks from scratch.
          Describe what you want to assess, and the AI will generate a complete framework with categories, measures,
          scoring guidance, search templates, and trusted source suggestions.
        </p>

        <h3 className="text-lg font-medium text-gray-800 mt-4">How to Use</h3>
        <ol className="list-decimal list-inside space-y-2 text-gray-700">
          <li>Navigate to the <strong>AI Builder</strong> page</li>
          <li>Describe your assessment topic (e.g., "I want to assess companies on their financed emissions and portfolio carbon footprint")</li>
          <li>Optionally <strong>upload reference files</strong> (PDF, DOCX, XLSX, TXT) using the paperclip button — the AI will use these to inform the framework design</li>
          <li>The AI may ask clarifying questions about scope, industry focus, or specific areas of interest</li>
          <li>Once it has enough information, it generates the complete framework as a JSON draft</li>
          <li>Review the draft in the preview panel — it shows categories, measures, and suggested trusted sources</li>
          <li>Click <strong>Save & Activate</strong> to create the framework and make it available for analysis</li>
        </ol>

        <h3 className="text-lg font-medium text-gray-800 mt-4">File Upload</h3>
        <p className="text-gray-700">
          You can upload reference documents to help the AI design a more targeted framework. Supported formats:
        </p>
        <ul className="list-disc list-inside space-y-1 text-gray-700">
          <li><strong>PDF</strong> — Annual reports, regulatory guidance, existing questionnaires</li>
          <li><strong>Word (.docx)</strong> — Draft frameworks, policy documents</li>
          <li><strong>Excel (.xlsx, .csv)</strong> — Lists of questions, scoring criteria</li>
          <li><strong>Text (.txt, .md, .json)</strong> — Any structured or unstructured reference material</li>
        </ul>
        <p className="text-sm text-gray-600 mt-2">
          Files are text-extracted server-side and included as context for the AI. Maximum 100K characters per file.
        </p>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Trusted Source Suggestions</h3>
        <p className="text-gray-700">
          The AI automatically suggests relevant trusted sources based on the framework topic. These are drawn from a
          catalog of 120+ disclosure platforms across categories including regulatory filings, ESG ratings, voluntary
          reporting frameworks, and industry-specific databases. When you save the framework, any new sources are added
          to the global trusted sources list for future use.
        </p>
      </section>

      {/* Results */}
      <section id="results" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <ClipboardCheck className="w-5 h-5 text-blue-600" />
          Results & Export
        </h2>
        <p className="text-gray-700">
          The Results page stores snapshots of completed analyses. Each time a batch analysis completes,
          a result is automatically saved with the date, framework used, company list, number of companies scored,
          and the average score.
        </p>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Available Actions</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Action</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Description</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">CSV Export</td>
                <td className="px-4 py-2 text-gray-600">Download a spreadsheet with all companies, their scores, and per-measure verdicts (Yes/No/Partial)</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Share</td>
                <td className="px-4 py-2 text-gray-600">Generate a public JSON link that can be shared with others or consumed by external tools</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">Delete</td>
                <td className="px-4 py-2 text-gray-600">Remove a saved result permanently</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Company Detail View</h3>
        <p className="text-gray-700">
          Click any company in the Dashboard table to view its detailed analysis. The detail page shows:
        </p>
        <ul className="list-disc list-inside space-y-1 text-gray-700">
          <li><strong>Overall score</strong> — Percentage of measures answered "Yes"</li>
          <li><strong>Per-measure verdicts</strong> — Yes, No, or Partial for each measure with confidence level</li>
          <li><strong>Evidence summaries</strong> — The AI's reasoning and source passages for each verdict</li>
          <li><strong>Source documents</strong> — List of all documents discovered and fetched, with URLs and fetch status</li>
          <li><strong>Re-analyse button</strong> — Trigger a fresh analysis for this specific company</li>
        </ul>
      </section>

      {/* Settings */}
      <section id="settings" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Settings className="w-5 h-5 text-blue-600" />
          Settings
        </h2>
        <p className="text-gray-700">
          The Settings page allows you to configure the analysis pipeline behaviour.
        </p>

        <h3 className="text-lg font-medium text-gray-800 mt-4">Configuration Options</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Setting</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Description</th>
                <th className="text-left px-4 py-2 font-medium text-gray-700 border-b">Default</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Max Documents per Company</td>
                <td className="px-4 py-2 text-gray-600">Maximum number of documents to fetch and analyse per company</td>
                <td className="px-4 py-2 text-gray-500">60</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">Concurrent Workers</td>
                <td className="px-4 py-2 text-gray-600">Number of companies processed simultaneously in a batch</td>
                <td className="px-4 py-2 text-gray-500">3</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">BM25 Skip Summarisation Threshold</td>
                <td className="px-4 py-2 text-gray-600">Document corpus size (chars) below which BM25 retrieval is used directly without summarisation</td>
                <td className="px-4 py-2 text-gray-500">10,000,000</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2 font-medium">AI Provider</td>
                <td className="px-4 py-2 text-gray-600">Which LLM provider to use for analysis (DeepSeek, OpenAI, Anthropic)</td>
                <td className="px-4 py-2 text-gray-500">DeepSeek</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">Trusted Sources</td>
                <td className="px-4 py-2 text-gray-600">Global list of disclosure platforms searched during document discovery</td>
                <td className="px-4 py-2 text-gray-500">—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Diagnostics */}
      <section id="diagnostics" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Activity className="w-5 h-5 text-blue-600" />
          Diagnostics
        </h2>
        <p className="text-gray-700">
          The Diagnostics page provides visibility into the analysis pipeline's internal operations.
          Use it to troubleshoot issues or understand why a company received a particular score.
        </p>
        <ul className="list-disc list-inside space-y-1 text-gray-700">
          <li><strong>Batch Run History</strong> — Shows all batch analysis runs with their status (completed, running, cancelled), progress, and timing</li>
          <li><strong>Error Logs</strong> — Displays any errors encountered during discovery, fetching, or analysis with timestamps and affected companies</li>
          <li><strong>Pipeline Metrics</strong> — Timing data for each pipeline phase (discovery, fetch, analyse)</li>
        </ul>
      </section>

      {/* Analysis Workflow */}
      <section id="workflow" className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <ArrowRight className="w-5 h-5 text-blue-600" />
          How the Analysis Pipeline Works
        </h2>
        <p className="text-gray-700">
          When you trigger an analysis, each company goes through a multi-stage pipeline:
        </p>

        <div className="space-y-4 mt-4">
          <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-bold">1</div>
            <div>
              <h4 className="font-medium text-gray-900">Discovery</h4>
              <p className="text-sm text-gray-600">
                The system searches the web using multiple strategies: general framework-specific queries,
                domain-anchored searches (site:company.com), trusted source searches (site:cdp.net "Company"),
                and localised queries for non-English companies. Results are ranked by relevance and priority,
                with known disclosure platforms receiving a ranking boost.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-bold">2</div>
            <div>
              <h4 className="font-medium text-gray-900">Relevance Filtering</h4>
              <p className="text-sm text-gray-600">
                An AI model reviews each discovered URL and its snippet to determine if it is
                likely to contain relevant disclosure content. Irrelevant results (e.g., job postings, product pages)
                are filtered out before fetching.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-bold">3</div>
            <div>
              <h4 className="font-medium text-gray-900">Document Fetching</h4>
              <p className="text-sm text-gray-600">
                The top documents (up to 60) are fetched via HTTP. If a page is blocked by a Web Application Firewall
                (WAF) or bot protection, the system automatically retries using a headless browser to
                render JavaScript-heavy pages.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-bold">4</div>
            <div>
              <h4 className="font-medium text-gray-900">Passage Retrieval (BM25)</h4>
              <p className="text-sm text-gray-600">
                For each measure in the framework, the system uses BM25 (a text retrieval algorithm) to find the
                most relevant passages from the fetched documents. Evidence keywords defined in the framework guide
                the retrieval toward the right content.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-bold">5</div>
            <div>
              <h4 className="font-medium text-gray-900">AI Scoring</h4>
              <p className="text-sm text-gray-600">
                An LLM (DeepSeek or OpenAI) evaluates the retrieved passages against each measure's scoring guidance.
                It produces a verdict (Yes, No, or Partial), a confidence level (High, Medium, Low), and an evidence
                summary explaining its reasoning.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-bold">6</div>
            <div>
              <h4 className="font-medium text-gray-900">Score Aggregation</h4>
              <p className="text-sm text-gray-600">
                The company's overall score is calculated as the percentage of measures with a "Yes" verdict.
                Partial verdicts count as 0 (binary scoring). Results are saved and the company status is updated.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Tips & Best Practices */}
      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-blue-600" />
          Tips & Best Practices
        </h2>

        <div className="space-y-3">
          <div className="bg-green-50 border border-green-200 rounded p-3">
            <p className="text-sm text-green-800">
              <strong>Always include company domains</strong> — When importing companies, providing their website domain
              (e.g., "apple.com") dramatically improves discovery accuracy by enabling site-specific searches.
            </p>
          </div>

          <div className="bg-green-50 border border-green-200 rounded p-3">
            <p className="text-sm text-green-800">
              <strong>Use specific evidence keywords</strong> — When building frameworks, include specific terms that
              companies would use in their disclosures. Generic terms produce noisy results.
            </p>
          </div>

          <div className="bg-green-50 border border-green-200 rounded p-3">
            <p className="text-sm text-green-800">
              <strong>Assign trusted sources to frameworks</strong> — Linking relevant disclosure platforms (e.g., CDP for
              climate, SEC EDGAR for governance) to your framework ensures the system searches the right places.
            </p>
          </div>

          <div className="bg-green-50 border border-green-200 rounded p-3">
            <p className="text-sm text-green-800">
              <strong>Review low-confidence verdicts</strong> — In the company detail view, pay attention to measures
              scored with "Low" confidence — these may benefit from manual review or additional source documents.
            </p>
          </div>

          <div className="bg-green-50 border border-green-200 rounded p-3">
            <p className="text-sm text-green-800">
              <strong>Upload reference documents to the AI Builder</strong> — If you have an existing questionnaire or
              regulatory guidance document, upload it when creating a framework. The AI will use it to generate more
              accurate and relevant measures.
            </p>
          </div>

          <div className="bg-green-50 border border-green-200 rounded p-3">
            <p className="text-sm text-green-800">
              <strong>Start with a small test batch</strong> — Before running analysis on 100+ companies, test with
              5-10 companies first to verify the framework produces meaningful scores, then adjust if needed.
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <div className="text-center text-sm text-gray-400 pt-4">
        CompanyIQ v3.0 — AI-Powered Corporate Disclosure Assessment
      </div>
    </div>
  );
}

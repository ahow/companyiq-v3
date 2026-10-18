import {
  Search,
  FileText,
  ListChecks,
  ScanSearch,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  BookOpen,
  ArrowLeft,
  ExternalLink,
} from "lucide-react";

// Public, no-login information page. It is rendered by App.tsx *before* the auth
// gate when window.location.pathname === "/how-it-works", so a layperson can open
// it without an account. It is intentionally self-contained (its own lightweight
// branded top bar) and does not use Navbar, which requires an authenticated session.

const GITHUB_DOCS_URL =
  "https://github.com/ahow/companyiq-v3/blob/main/docs/how-it-works.md";

const STEPS = [
  {
    icon: Search,
    title: "1. It finds the company's own documents",
    body:
      "CompanyIQ starts by searching the web for a company's public, primary documents — things like its annual report, sustainability report, board/proxy statements and any published AI or responsible-AI policies. It prefers the company's own filings over second-hand summaries.",
  },
  {
    icon: FileText,
    title: "2. It reads them and keeps the words",
    body:
      "Each document is downloaded and converted to clean text, whether it is a web page or a PDF (including scanned PDFs, using text-recovery and OCR). If a document could only be read in part, CompanyIQ marks it as 'partial' rather than pretending it read the whole thing.",
  },
  {
    icon: ScanSearch,
    title: "3. It pulls out the most relevant passages",
    body:
      "For each question it needs to answer, CompanyIQ picks the passages most likely to contain the answer — first by matching words, then by asking an AI to judge which passages are genuinely about the topic (even when they use different wording). The strongest, most authoritative sources are kept.",
  },
  {
    icon: CheckCircle2,
    title: "4. It decides Yes or No — with the quote to prove it",
    body:
      "An AI reads those passages and answers one clear question at a time (for example, 'Does the company disclose board-level oversight of AI?'). Every Yes or No comes with a short reason, a word-for-word quote, and a link to the exact document it came from — so you can check it yourself.",
  },
];

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Lightweight public top bar (no login required) */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2 group">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">IQ</span>
            </div>
            <span className="font-semibold text-gray-900 group-hover:text-blue-700 transition-colors">
              CompanyIQ
            </span>
            <span className="text-xs text-gray-400 ml-1">v3.0</span>
          </a>
          <a
            href="/"
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-blue-700 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to app
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10 space-y-8 pb-16">
        {/* Hero */}
        <div className="border-b border-gray-200 pb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900">
            How CompanyIQ works
          </h1>
          <p className="text-lg text-gray-600 mt-3 leading-relaxed">
            CompanyIQ reads a company's own public documents to answer a simple
            question: <strong className="text-gray-800">how well does this company manage,
            govern and disclose its use of artificial intelligence?</strong> Here is how it
            reaches its answers — in plain language.
          </p>
        </div>

        {/* The question it answers */}
        <section className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h2 className="text-xl font-semibold text-blue-900 flex items-center gap-2 mb-3">
            <ListChecks className="w-5 h-5" />
            What question it answers
          </h2>
          <p className="text-blue-900/90 leading-relaxed">
            CompanyIQ checks a company against a structured list of specific, yes-or-no
            questions called <strong>measures</strong> — for example, "Does it disclose a named
            AI strategy?" or "Does it disclose who is accountable for AI at board level?" The
            current <strong>AI Management</strong> framework has <strong>36 such measures</strong>,
            covering strategy, governance and accountability, how AI is used, outcomes, and
            responsible-AI and risk. Each company gets a Yes or No on every measure, and those
            add up to an overall score.
          </p>
        </section>

        {/* How it works — steps */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">
            How it reaches an answer
          </h2>
          <div className="grid grid-cols-1 gap-4">
            {STEPS.map((s) => {
              const Icon = s.icon;
              return (
                <div
                  key={s.title}
                  className="bg-white border border-gray-200 rounded-lg p-6 flex gap-4"
                >
                  <div className="shrink-0 w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                    <Icon className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-1">{s.title}</h3>
                    <p className="text-gray-600 leading-relaxed">{s.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Why answers are checked for consistency */}
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-3">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <RefreshCw className="w-5 h-5 text-blue-600" />
            Why answers are double-checked
          </h2>
          <p className="text-gray-600 leading-relaxed">
            AI models can give slightly different answers to the same question on different days.
            CompanyIQ reduces this in several ways: it asks each question at the most consistent
            setting and answers it more than once, then reconciles the results. When those
            attempts <em>disagree</em> — the borderline cases — it sends just those to a second,
            independent AI for a tie-break, while the clear-cut cases stay on the fast path. It
            also remembers the answer for a given set of evidence, so the same evidence gives the
            same answer next time.
          </p>
          <p className="text-gray-600 leading-relaxed">
            We are honest about the limits: a small share of answers (around 2%) can still change
            between runs. That is a known property of today's AI models, so each fragile ("borderline")
            answer is flagged rather than hidden, and every result shows whether the underlying
            research was complete.
          </p>
        </section>

        {/* How accuracy is guarded over time */}
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-3">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-blue-600" />
            How we guard accuracy over time
          </h2>
          <p className="text-gray-600 leading-relaxed">
            To make sure changes to the system improve it rather than quietly make it worse, we
            built a fixed <strong>answer key</strong>: a set of around 280 company-and-measure
            cases, chosen to include the tricky and borderline ones (and some non-English filers).
            The plan is for human analysts to decide the correct Yes/No for each of these, working
            independently of the AI. After that, every future change to the scoring is checked
            against this answer key before it can ship — so accuracy is measured against human
            judgement, not against the AI grading its own homework.
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-sm text-amber-900 leading-relaxed">
              <strong>Being straight with you:</strong> this answer key is built and wired in, but
              the human labelling has not been done yet. Until it is, the accuracy gate reports
              "ground truth pending" and does not invent precision or accuracy figures. This is a
              one-time exercise on a fixed set of cases — not a manual review of thousands of
              companies.
            </p>
          </div>
        </section>

        {/* Link to full technical docs */}
        <section className="bg-gray-900 rounded-lg p-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <BookOpen className="w-5 h-5 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">Want the full technical detail?</h2>
          </div>
          <p className="text-gray-300 text-sm mb-4 max-w-2xl mx-auto">
            Everything above is explained end-to-end — data sources, evidence ranking, the
            multi-model scoring cascade, and the stability and ground-truth program — in our
            technical documentation, kept up to date in our code repository.
          </p>
          <a
            href={GITHUB_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors"
          >
            Read the technical documentation
            <ExternalLink className="w-4 h-4" />
          </a>
        </section>

        <footer className="text-center text-sm text-gray-400 pt-4">
          <a href="/" className="hover:text-blue-600 transition-colors">
            ← Back to CompanyIQ
          </a>
        </footer>
      </main>
    </div>
  );
}

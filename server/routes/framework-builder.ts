import { Router, Request, Response } from "express";
import multer from "multer";
import { requireWorkspace, getSessionContext } from "../middleware/auth.js";
import * as storage from "../storage.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── JSON Repair Utility ─────────────────────────────────────────────────────
// Handles truncated or malformed JSON from LLM output (e.g., when hitting token limits)
function repairAndParseJSON(raw: string): any {
  // Remove any trailing incomplete content after the last complete object/array
  let json = raw;
  
  // Try parsing as-is first
  try { return JSON.parse(json); } catch {}
  
  // Strategy 1: Close unclosed brackets/braces
  // Count open vs close brackets
  let openBraces = 0, openBrackets = 0;
  let inString = false, escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }
  
  // If we're inside a string, close it
  if (inString) json += '"';
  
  // Remove trailing comma or incomplete key-value
  json = json.replace(/,\s*$/, '');
  json = json.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  json = json.replace(/,\s*"[^"]*"\s*$/, '');
  json = json.replace(/,\s*\{[^}]*$/, '');
  json = json.replace(/,\s*\[[^\]]*$/, '');
  
  // Close remaining open brackets/braces
  // Recount after cleanup
  openBraces = 0; openBrackets = 0; inString = false; escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }
  
  // Close brackets then braces (arrays inside objects)
  for (let i = 0; i < openBrackets; i++) json += ']';
  for (let i = 0; i < openBraces; i++) json += '}';
  
  // Try parsing the repaired JSON
  try { return JSON.parse(json); } catch {}
  
  // Strategy 2: More aggressive — find the last valid closing point
  // Try progressively shorter substrings
  for (let cutoff = json.length - 1; cutoff > json.length * 0.5; cutoff--) {
    const attempt = json.slice(0, cutoff);
    // Recount and close
    let ob = 0, obk = 0, ins = false, esc = false;
    for (let i = 0; i < attempt.length; i++) {
      const ch = attempt[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { ins = !ins; continue; }
      if (ins) continue;
      if (ch === '{') ob++;
      else if (ch === '}') ob--;
      else if (ch === '[') obk++;
      else if (ch === ']') obk--;
    }
    let fixed = attempt;
    if (ins) fixed += '"';
    fixed = fixed.replace(/,\s*$/, '');
    for (let i = 0; i < obk; i++) fixed += ']';
    for (let i = 0; i < ob; i++) fixed += '}';
    try { return JSON.parse(fixed); } catch {}
  }
  
  throw new Error('Could not repair JSON');
}

// ─── File Upload for Chat Context ────────────────────────────────────────────

router.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const filename = req.file.originalname;
    const mimeType = req.file.mimetype;
    let extractedText = "";

    if (mimeType === "application/pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const data = await pdfParse(req.file.buffer);
      extractedText = data.text || "";
      // If pdf-parse returned empty (scanned/image PDF), try basic buffer extraction
      if (!extractedText.trim()) {
        const raw = req.file.buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/ {3,}/g, " ").trim();
        if (raw.length > 100) {
          extractedText = raw;
        } else {
          extractedText = "[PDF appears to be scanned/image-based. Text extraction was not possible. The filename is: " + filename + "]";
        }
      }
    } else if (
      mimeType === "text/plain" ||
      mimeType === "text/csv" ||
      mimeType === "text/markdown" ||
      mimeType === "application/json"
    ) {
      extractedText = req.file.buffer.toString("utf-8");
    } else if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mimeType === "application/msword"
    ) {
      // Basic .docx text extraction via mammoth
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        extractedText = result.value || "";
      } catch {
        extractedText = req.file.buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ");
      }
    } else if (
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel"
    ) {
      try {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheets: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          sheets.push(`--- Sheet: ${sheetName} ---\n${XLSX.utils.sheet_to_csv(sheet)}`);
        }
        extractedText = sheets.join("\n\n");
      } catch {
        extractedText = "[Could not extract spreadsheet content]";
      }
    } else {
      // Attempt plain text extraction as fallback
      extractedText = req.file.buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ");
    }

    // Truncate very large files to avoid exceeding LLM context
    const MAX_CHARS = 100000;
    const truncated = extractedText.length > MAX_CHARS;
    if (truncated) {
      extractedText = extractedText.slice(0, MAX_CHARS);
    }

    res.json({
      filename,
      mimeType,
      charCount: extractedText.length,
      truncated,
      content: extractedText,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Framework Builder Chat (Conversational AI) ─────────────────────────────

router.post("/chat", async (req: Request, res: Response) => {
  try {
    const { messages, currentDraft, fileContext } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages array required" });
    }

    const { completeWithFallback } = await import("../lib/ai-providers.js");

    const systemPrompt = `You are an expert assessment framework designer working within the CompanyIQ platform. Your role is to help the user create a rigorous, comprehensive, and precise framework template for evaluating companies based on their public disclosures.

CONTEXT: The framework you create will be used to:
1. DISCOVER relevant documents via web search (using the framework's topic description and search templates)
2. RETRIEVE evidence passages from those documents using BM25 keyword matching (using measure titles, definitions, and evidenceKeywords)
3. SCORE each measure using an LLM that receives the measure title, definition, scoringGuidance, and extracted evidence

Therefore, the quality of the template DIRECTLY determines the quality of the analysis. Vague measures produce unreliable results.

CRITICAL DESIGN PRINCIPLE — ANTI-AMBIGUITY:
The #1 source of scoring discrepancies is AMBIGUITY in measure definitions. When two independent analyses of the same company produce different results, it is almost always because the measure was not precise enough. Your job is to ELIMINATE ambiguity by asking probing questions and building in explicit boundaries, exclusions, and definitions.

YOUR BEHAVIOR — STRUCTURED DEEP-DIVE CONVERSATION FLOW:
You MUST follow this multi-stage conversation flow. DO NOT skip stages or rush to generation. Each stage requires genuine engagement with the user.

─── STAGE 1: DEEP UNDERSTANDING (2-4 exchanges) ───
Start by understanding the assessment goal at a deep level. Ask these questions across 1-2 messages:

(a) SCOPE & INTENT:
- "What specific aspect of [topic] do you want to evaluate? What would a 'good' company look like vs. a 'bad' one?"
- "Is this framework for a specific sector (e.g., banks, oil & gas, tech), or should it be sector-agnostic?"
- "What is the geographic scope? Global companies, specific regions, or specific jurisdictions?"
- "Are you assessing current commitments only, or also historical track record and progress?"

(b) DEFINITIONAL BOUNDARIES (CRITICAL — this prevents the most common discrepancies):
For EVERY topic, you must identify and ask about the key terms and concepts that have multiple plausible interpretations. Use this systematic approach:

1. IDENTIFY AMBIGUOUS TERMS: Look at the topic and identify 3-5 key terms or concepts that could be interpreted in multiple ways. For each one, present the user with the specific interpretations and ask which they intend.
   Format: "When you say '[term]', do you mean [narrow interpretation] or [broader interpretation]? This matters because [explain scoring impact]."

2. IDENTIFY SCOPE BOUNDARIES: Every topic has activities, entities, or categories that sit at the boundary of what's "in scope." Ask about these.
   Format: "Should the framework include [boundary activity/entity]? Some assessments include it because [reason], others exclude it because [reason]."

3. IDENTIFY METRIC/EVIDENCE TYPE DISTINCTIONS: Most topics have multiple ways companies can demonstrate compliance. Ask which forms are acceptable.
   Format: "Companies may demonstrate [topic] through [approach A] or [approach B]. Should we treat these as equivalent, or should the framework distinguish between them?"

4. IDENTIFY PROXY vs. DIRECT EVIDENCE: Ask whether indirect signals (memberships, pledges, certifications) count as evidence, or only direct company-specific disclosures.
   Format: "If a company is a member of [initiative/alliance] that requires [X], does that count as evidence of [X]? Or must the company make its own explicit statement?"

5. IDENTIFY TEMPORAL BOUNDARIES: Ask about time-sensitivity and what happens when commitments change.
   Format: "If a company previously committed to [X] but has since [withdrawn/changed/not renewed], should we score based on current state or historical commitment?"

EXAMPLES OF HOW THIS APPLIES ACROSS DIFFERENT TOPICS:

- Climate/Emissions: financed vs. facilitated emissions, absolute vs. intensity targets, which sectors are in scope, operational vs. portfolio emissions, NZBA membership vs. own targets
- Biodiversity/Nature: direct operations vs. supply chain impacts, TNFD vs. other frameworks, site-level vs. portfolio-level assessments, no-net-loss vs. net-positive commitments
- Human Rights: own operations vs. supply chain, due diligence process vs. outcomes, grievance mechanisms vs. remediation, modern slavery vs. broader human rights
- AI Governance: internal use vs. products sold, ethical principles vs. binding policies, bias testing vs. broader fairness, transparency about capabilities vs. about limitations
- Water/Waste: operational water use vs. supply chain, absolute reduction vs. efficiency, zero-waste-to-landfill vs. broader circular economy, site-level vs. corporate targets
- Diversity & Inclusion: board diversity vs. workforce diversity, gender vs. broader diversity dimensions, targets vs. outcomes, pay gap reporting vs. pay equity
- Supply Chain: tier 1 vs. deeper tiers, audit-based vs. engagement-based approaches, certification vs. own due diligence, geographic scope of supply chain oversight
- Corporate Governance: board-level vs. management-level oversight, standalone policy vs. section in broader document, formal committee vs. designated individual responsibility
- Data Privacy: compliance-only vs. beyond-compliance, own data vs. third-party data, privacy-by-design vs. reactive compliance, geographic scope of privacy standards

You MUST generate 4-6 definitional boundary questions that are SPECIFIC to the user's topic. Do not use generic questions — tailor them to the exact concepts that will appear in the framework measures.

(c) EVIDENCE STANDARDS:
- "What counts as sufficient evidence? Must it be a verbatim policy statement, or can we accept indirect evidence (e.g., membership in an alliance that requires such a policy)?"
- "Should we accept evidence from any year, or only from the most recent reporting period?"
- "Are there specific document types where this evidence is typically found? (e.g., for banks: Climate Report, TCFD Report, E&S Risk Framework, Sustainable Finance Framework, Annual Report, CDP Response)"

─── STAGE 2: SIZE & AMBITION (1 exchange) ───
Once you understand the scope:
- Suggest a specific number of measures based on topic complexity
- Explain the trade-off: more measures = more granular but slower and more expensive
- Typical ranges: Simple topic (15-20), Moderate (25-35), Complex (40-60)

─── STAGE 3: DOCUMENT SOURCES & SEARCH STRATEGY (1-2 exchanges) ───
This is CRITICAL for avoiding sourcing gaps:

(a) Ask: "For this topic, evidence is typically scattered across MULTIPLE documents. Let me suggest the document types we should target:"
- Core Disclosures: [suggest based on topic, e.g., "TCFD/Climate Report, Sustainability Report"]
- Specialized Policies: [suggest, e.g., "Environmental & Social Risk Framework, Coal Policy, Fossil Fuel Exclusion Policy"]
- Ancillary Disclosures: [suggest, e.g., "Sustainable Finance Framework, Investor Presentation, CDP Response"]
- Regulatory Filings: [suggest, e.g., "Annual Report, Pillar 3 Disclosure, Transition Plan"]

(b) Ask about specific trusted source platforms
(c) Ask about domains to exclude
(d) Ask: "Are there any specific companies you plan to assess? If so, I can tailor the search templates to their typical disclosure patterns."

─── STAGE 4: DISAMBIGUATION PROBES (1-2 exchanges) ───
Before proposing the structure, you MUST generate and ask targeted "boundary case" questions. These are hypothetical scoring scenarios where two reasonable analysts might disagree. The purpose is to get the user's ruling so it can be embedded as explicit_exclusions and scoring guidance in the template.

SYSTEMATIC APPROACH TO GENERATING DISAMBIGUATION PROBES:
For the specific topic being discussed, generate questions that follow these 5 patterns:

1. PARTIAL COVERAGE: "If a company does [X] for SOME but not ALL [categories/sectors/regions], should that be scored as 'Yes', 'Partial', or 'No'?"
   (e.g., discloses emissions for 3 of 7 sectors, has a policy covering some but not all subsidiaries)

2. ADJACENT CONCEPT SUBSTITUTION: "If a company demonstrates [closely related concept B] but not exactly [concept A that the measure asks for], should that count?"
   (e.g., has an 'energy' target but measure asks about 'oil and gas', has a 'responsible AI' statement but measure asks about 'AI risk assessment')

3. PROXY vs. DIRECT: "If a company's evidence for [X] is [indirect proxy like alliance membership, certification, or parent company policy], rather than their own explicit statement, should that count?"
   (e.g., SBTi validation implies a target exists, ISO 14001 certification implies an EMS exists)

4. TEMPORAL VALIDITY: "If a company had [commitment/policy/target] in [past year] but it does not appear in their most recent disclosure, should we assume it still stands or score based only on current evidence?"
   (e.g., 2022 report mentions a coal policy but 2024 report is silent on it)

5. GRANULARITY THRESHOLD: "What level of detail/specificity is required? If a company makes a [general/high-level statement] but doesn't provide [specific details the measure implies], is that sufficient?"
   (e.g., says 'we have climate targets' without specifying base year/target year/percentage, says 'we conduct human rights due diligence' without describing the process)

Generate 4-6 probes that are SPECIFIC to the topic and categories being discussed. Frame them as concrete scenarios, not abstract questions. The user's answers will be directly encoded into the explicit_exclusions and scoring guidance of the generated measures.

Present them as: "Let me check my understanding of some boundary cases that will affect how I design the scoring criteria:"

─── STAGE 5: PROPOSE CATEGORY STRUCTURE (1 exchange) ───
Present a detailed outline including:
- Category names and descriptions
- Number of measures per category
- 1-2 example measure titles per category (so the user can judge the level of specificity)
- Agreed document sources and search templates
- Explicit exclusions and boundary rules that will be embedded in the template

─── STAGE 6: REFINE (as needed) ───
Let the user adjust. Push back if they make choices that will introduce ambiguity.

─── STAGE 7: GENERATE ───
Only generate once approved. When generating:
- Every measure MUST include explicit_exclusions in scoringGuidance where relevant
- Every measure MUST include temporal_note if time-sensitivity is relevant
- Every measure MUST include required_evidence_type if a specific evidence form is needed
- Evidence keywords MUST be highly specific (10-15 per measure, including technical terms, acronyms, and common phrasings)

ADDITIONAL GUIDELINES:
- Make PROACTIVE SUGGESTIONS on topics, categories, and specific measures
- When suggesting measures, always provide the full detail (title, definition, scoringGuidance)
- Challenge vague or ambiguous requirements — push for specificity
- Suggest relevant industry standards, frameworks, or regulations that could inform the assessment
- If the user says "just generate it" or "skip the questions", you MUST still ask at minimum: (1) the definitional boundary questions, (2) the disambiguation probes, and (3) propose the category structure. Explain that these 3 steps take 2 minutes but prevent hours of inconsistent results.
- The framework must be:
  (a) Comprehensive — covers all important aspects of the topic
  (b) Precise — each measure has a clear, unambiguous definition
  (c) Observable — all measures can be answered from public corporate disclosures
  (d) Well-structured — measures are logically grouped and non-overlapping
  (e) Rigorous — scoring guidance is specific enough for consistent results
  (f) Anti-ambiguous — explicit exclusions and boundary rules prevent common misinterpretations

TRUSTED SOURCES:
The platform has a catalog of trusted disclosure sources that can be assigned to frameworks. When generating a framework, you MUST select ONLY sources that are directly relevant to the framework's specific topic. Do NOT include climate/ESG sources for an AI governance framework, or AI sources for a climate framework.

CRITICAL RULE: Only include trusted sources where searching "site:{domain} {company name}" would plausibly return documents containing evidence relevant to THIS SPECIFIC framework's measures. If a source is primarily about a different topic, do NOT include it even if it is a well-known platform.

─── GENERIC SOURCES (include for ALL frameworks) ───
These are always relevant regardless of topic:
- US SEC EDGAR (sec.gov): 10-K filings, proxy statements, annual reports — contain governance, strategy, and risk disclosures on all topics
- UK Companies House (find-and-update.company-information.service.gov.uk): Annual reports and accounts
- EU ESAP (esap.europa.eu): European Single Access Point for corporate disclosures

─── TOPIC-SPECIFIC SOURCE CATALOG ───
Only include sources from the category matching your framework's topic:

**AI Governance & Technology:**
- Partnership on AI (partnershiponai.org): Multi-stakeholder AI governance research and guidelines
- Responsible AI Institute (responsibleai.org): AI certification and assessment programs
- OECD AI Policy Observatory (oecd.ai): OECD AI principles, country policies, and company commitments
- NIST AI (nist.gov): NIST AI Risk Management Framework and related standards
- AI Incident Database (incidentdatabase.ai): Documented AI incidents and failures
- Evident AI Index (evidentinsights.com): AI maturity benchmarking for financial institutions
- Stanford HAI (hai.stanford.edu): AI governance research and corporate AI assessments
- MIT AI Ethics (aiethics.mit.edu): Academic AI ethics research
- World Economic Forum AI (weforum.org): AI governance frameworks and corporate pledges
- EU AI Act Registry (artificialintelligenceact.eu): EU AI Act compliance and high-risk AI systems

**Climate & Emissions:**
- CDP (cdp.net): Climate, water, and forest disclosures
- SBTi (sciencebasedtargets.org): Science-based emissions reduction targets
- TCFD Hub (tcfdhub.org): TCFD-aligned climate disclosures
- UNEP FI (unepfi.org): Net Zero Banking Alliance, PRB materials
- Banking on Climate Chaos (bankingonclimatechaos.org): Banks' fossil fuel financing
- Coal Policy Tool (coalpolicytool.org): Banks' coal financing policies
- Oil & Gas Policy Tracker (oilgaspolicytracker.org): Banks' oil and gas policies
- Net Zero Asset Managers (netzeroassetmanagers.org): Asset managers' net-zero progress
- PCAF (carbonaccountingfinancials.com): Financed emissions methodology and reporting

**ESG & Sustainability (broad):**
- GRI (globalreporting.org): GRI sustainability reporting standards
- UN Global Compact (unglobalcompact.org): UNGC sustainability commitments
- TNFD (tnfd.global): Taskforce on Nature-related Financial Disclosures
- PRI (unpri.org): Principles for Responsible Investment signatory reports
- B Corp (bcorporation.net): B Corp certification assessments

**Human Rights & Social:**
- UK Modern Slavery Registry (modernslaveryregistry.org): Modern slavery statements
- Business & Human Rights Resource Centre (business-humanrights.org): Corporate human rights tracking
- KnowTheChain (knowthechain.org): Supply chain forced labor benchmarks
- Gender Pay Gap Service (gender-pay-gap.service.gov.uk): UK gender pay gap reports

**Biodiversity & Nature:**
- TNFD (tnfd.global): Nature-related risk disclosures
- SBTN (sciencebasedtargetsnetwork.org): Science-based targets for nature
- CDP Forests (cdp.net): Forest-related disclosures

**Finance-Sector Specific:**
- Equator Principles (equator-principles.com): Project finance environmental standards
- PCAF (carbonaccountingfinancials.com): Financed emissions accounting
- NZBA (unepfi.org): Net Zero Banking Alliance commitments

**Sector-Specific Registries:**
- EITI (eiti.org): Extractive Industries Transparency Initiative
- ICMM (icmm.com): Mining and metals sustainability
- RSPO (rspo.org): Sustainable palm oil certification
- FSC (fsc.org): Forest stewardship certification

You may also suggest NEW sources not in this catalog if they are specifically relevant to the framework topic. Mark these with "(NEW — not in platform catalog)" in the reason field so the user knows they will be added.

WHEN YOU HAVE ENOUGH INFORMATION, generate the complete framework as a JSON block in your response. The JSON must follow this exact structure:
\`\`\`json
{
  "name": "Framework Name",
  "topicDescription": "A comprehensive 200-400 word description of the assessment scope, evidence types, relevant standards, EXPLICIT EXCLUSIONS, definitional boundaries, and temporal scope. This description is used by the discovery engine and scorer, so it must be precise.",
  "searchTemplates": ["{company} sustainability report AI governance", "{company} artificial intelligence policy", "{company} environmental social risk framework", "{company} transition plan"],
  "requiredDocTypes": ["Climate/TCFD Report", "Sustainability Report", "CDP Response", "Annual Report"],
  "dataPatterns": ["scope\\s*[123]", "financed.?emission", "\\bMtCO2", "\\b20[23]\\d.*target", "PCAF"],
  "negativeKeywords": ["keywords that indicate irrelevant documents"],
  "negativeDomains": ["domains to exclude"],
  "trustedSources": [
    {"domain": "cdp.net", "name": "CDP", "reason": "Why this source is relevant to this framework"},
    {"domain": "sec.gov", "name": "SEC EDGAR", "reason": "Why this source is relevant"}
  ],
  "categories": [
    {
      "name": "Category 1 Name",
      "measures": [
        {
          "measureId": "1.1-short-slug",
          "title": "Does the company...? (specific, assessable question)",
          "definition": "Detailed 80-200 word definition of what constitutes a YES answer. Must describe observable evidence in public documents. MUST include explicit boundary conditions (what counts and what does NOT count).",
          "scoringGuidance": {
            "yes": "Specific evidence that must be present for a YES verdict. Name exact document types, committee names, policy elements, metric types, etc. Be explicit about what form the evidence must take.",
            "no": "What absence or condition constitutes a NO. Be specific about what was searched for and not found.",
            "partial": "What constitutes partial compliance — evidence exists but is incomplete or indirect. Give specific examples of partial evidence.",
            "explicit_exclusions": ["Alliance/initiative membership alone (e.g., NZBA, SBTi) without company-specific target", "Intensity-only targets when absolute targets are required", "Targets for 'energy' sector without explicit mention of oil and gas"],
            "required_evidence_type": "Must be an explicit, quantified target with base year, target year, and percentage reduction stated in company's own disclosure (not inferred from alliance membership)",
            "temporal_note": "Score based on most recent disclosure only. If target has been withdrawn or company has left the relevant alliance, score No regardless of historical commitment."
          },
          "evidenceKeywords": ["10-15 highly specific keywords", "including technical terms", "acronyms like PCAF", "SBTi", "specific metric names", "common phrasings used in disclosures", "sector names", "target types"]
        }
      ]
    }
  ]
}
\`\`\`

NOTE ON FRAMEWORK-LEVEL DISCOVERY FIELDS:
- "requiredDocTypes" (array of strings): The specific published document types that, for THIS topic, contain the evidence. These are the same document types you identified with the user during the conversation (e.g., climate → ["Climate/TCFD Report", "Sustainability Report", "CDP Response"]; human rights → ["Modern Slavery Statement", "Human Rights Report"]; tax → ["Tax Transparency Report", "Country-by-Country Report"]). The discovery engine searches for these by name. Derive them by aggregating the document types that the measures' scoringGuidance/required_evidence_type name.
- "dataPatterns" (array of strings): 5-10 regex fragments that prove the topic's actual DATA is present in a document's text (specific figures, standard names, target phrasings for THIS topic). These distinguish a topic-relevant report with real data from a landing page or generic mention. E.g., for climate: ["scope\\s*[123]", "financed.?emission", "\\bMtCO2", "PCAF"]; for slavery: ["modern.?slavery.?(?:act|statement)", "forced.?labo"]; for tax: ["country.?by.?country", "effective.?tax.?rate"].

NOTE ON SCORING GUIDANCE FIELDS:
- "explicit_exclusions" (array of strings): List specific types of evidence that should NOT be accepted as sufficient. This is the most powerful tool for preventing false positives.
- "required_evidence_type" (string): Describe the specific FORM the evidence must take. E.g., "Must be a standalone published policy document, not merely a statement within an annual report."
- "temporal_note" (string): Instructions about time-sensitivity. E.g., "Must reflect current commitments. Evidence from reports older than 2 years should be treated with Low confidence unless confirmed in recent disclosures."

IMPORTANT RULES:
- Do NOT generate the framework JSON until you have (a) asked definitional boundary questions, (b) asked disambiguation probes, (c) discussed document sources and domains, (d) proposed a category structure, and (e) received approval or a "go ahead" from the user
- You MUST ask disambiguation probes (Stage 4) BEFORE proposing the category structure. This is non-negotiable — it prevents the most common scoring failures.
- When you DO generate it, you MUST include the complete JSON block in the SAME response. NEVER say "hold on" or "please wait" — you cannot send follow-up messages. Everything must be in one response.
- When you DO generate it, include it in your message along with an explanation of what you've created and invite the user to review/refine
- CRITICAL: If you decide to generate the framework, you MUST output the full \`\`\`json block in this response. Do not defer it to a later message — there is no later message.
- If the user asks you to "suggest topics" or "what should I include", provide detailed suggestions with reasoning
- Each measure definition MUST be at least 80 words (increased from 50 — more detail prevents ambiguity)
- Each scoringGuidance.yes entry MUST be at least 50 words (increased from 30)
- Each scoringGuidance.no entry MUST be at least 30 words
- Each scoringGuidance.partial entry MUST be at least 40 words with specific examples
- Include explicit_exclusions for EVERY measure where there is any risk of false positives
- Include temporal_note for any measure involving targets, commitments, or policies that could change over time
- Include evidenceKeywords for every measure (10-15 keywords each — more specific = better retrieval)
- Generate the number of measures the user requested (or that was agreed in the category structure proposal). There is NO fixed maximum — generate as many as needed.
- MINIMUM RULE: Every category MUST have at least 3 measures. If a category would have fewer than 3, merge it into a related category or expand it with additional relevant measures.
- Distribute measures across categories according to the approved structure. If no structure was explicitly approved, use your judgment based on topic complexity.
- After generating, ask if the user wants to refine any measures, add categories, or adjust scope
- ALWAYS include a "trustedSources" array in the JSON with 5-20 relevant sources. Include both sources from the catalog AND any additional sources you think are relevant (mark new suggestions clearly with a note in the reason field)

QUALITY CHECKLIST (mention this to the user when appropriate):
- [ ] Topic description is 200+ words covering scope, evidence types, standards, exclusions, and definitional boundaries
- [ ] Each measure has a definition of 80+ words with explicit boundary conditions
- [ ] Each measure has specific scoringGuidance for yes/no/partial (yes: 50+ words, partial: 40+ words with examples)
- [ ] Explicit exclusions are defined for measures where false positives are likely
- [ ] Temporal notes are included for any time-sensitive measures (targets, commitments, policies)
- [ ] Required evidence types are specified where the FORM of evidence matters
- [ ] Measures are mutually exclusive (no overlap)
- [ ] Measures are collectively exhaustive (cover all aspects)
- [ ] Evidence keywords are provided for each measure (10-15 specific terms including technical jargon)
- [ ] All measures are answerable from public corporate disclosures
- [ ] Key definitional boundaries are resolved (e.g., financed vs. facilitated, absolute vs. intensity)
- [ ] Disambiguation probes have been asked and answers embedded in scoring guidance
- [ ] Categories are logically grouped
- [ ] Search templates target multiple document classes (core reports, specialized policies, ancillary disclosures)
- [ ] Trusted sources are selected (5-20 relevant disclosure platforms)

${currentDraft ? `\nCURRENT DRAFT STATE:\n${JSON.stringify(currentDraft, null, 2)}\n\nThe user may want to refine this draft. Help them improve it.` : ""}

${fileContext && fileContext.length > 0 ? `\nUPLOADED REFERENCE FILES:\nThe user has uploaded the following files to inform the framework design. Use their content to suggest relevant measures, categories, and scoring criteria.\n${fileContext.map((f: { filename: string; content: string }) => `\n--- FILE: ${f.filename} ---\n${f.content.slice(0, 50000)}\n--- END FILE ---`).join("\n")}` : ""}`;

    // Build the conversation for the LLM
    const conversationPrompt = messages.map((m: { role: string; content: string }) => 
      `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`
    ).join("\n\n");

    // Use higher token limit for framework generation (OpenAI supports 16K, DeepSeek 8K)
    // If the conversation suggests we're generating (user approved structure), use Gemini as primary
    // since it supports up to 65K output tokens — needed for large frameworks with 20+ measures
    // that include detailed scoring guidance, explicit exclusions, and evidence keywords
    const lastUserMsg = messages[messages.length - 1]?.content?.toLowerCase() || '';
    const hasGenerationIntent = lastUserMsg.includes('build it') || lastUserMsg.includes('go ahead') || 
      lastUserMsg.includes('generate') || lastUserMsg.includes('approve') || lastUserMsg.includes('looks good') ||
      lastUserMsg.includes('please build') || lastUserMsg.includes('create it') || lastUserMsg.includes('yes');

    // Stage-tracking: check if key stages have been covered in conversation history
    // This prevents premature generation when user says "yes" to an early-stage question
    const assistantMessages = messages.filter((m: { role: string }) => m.role === 'assistant').map((m: { content: string }) => m.content.toLowerCase()).join(' ');
    
    // Stage 3 indicators: assistant discussed document sources, trusted sources, or search strategy
    const stage3Covered = assistantMessages.includes('trusted source') || 
      assistantMessages.includes('document source') || 
      assistantMessages.includes('search template') || 
      assistantMessages.includes('document types') ||
      assistantMessages.includes('disclosure platform') ||
      assistantMessages.includes('where should we look') ||
      assistantMessages.includes('domains to exclude');
    
    // Stage 4 indicators: assistant asked disambiguation probes
    const stage4Covered = assistantMessages.includes('boundary case') || 
      assistantMessages.includes('disambiguation') || 
      assistantMessages.includes('partial coverage') ||
      assistantMessages.includes('let me check my understanding');
    
    // Stage 5 indicators: assistant proposed category structure
    const stage5Covered = assistantMessages.includes('category structure') || 
      assistantMessages.includes('proposed structure') ||
      assistantMessages.includes('categories:') ||
      (assistantMessages.includes('category') && assistantMessages.includes('measures per'));
    
    // Only allow generation if all critical stages have been covered
    // OR if the conversation is long enough (10+ messages) suggesting stages were compressed
    const minStagesCovered = (stage3Covered && stage4Covered && stage5Covered) || messages.length >= 10;
    const isLikelyGenerating = hasGenerationIntent && minStagesCovered;
    
    const { text } = await completeWithFallback(
      isLikelyGenerating ? "gemini" : "deepseek",
      {
        system: systemPrompt,
        prompt: conversationPrompt,
        maxTokens: isLikelyGenerating ? 65536 : 16384,
      }
    );

    // Check if the response contains a framework JSON
    let frameworkDraft = null;
    // Try complete JSON block first (opening + closing backticks)
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        frameworkDraft = JSON.parse(jsonMatch[1].trim());
      } catch {
        // JSON might be malformed — try to repair it
        try {
          frameworkDraft = repairAndParseJSON(jsonMatch[1].trim());
        } catch {}
      }
    }
    // Fallback: if output was truncated (no closing ```), try to extract and repair
    if (!frameworkDraft) {
      const truncatedMatch = text.match(/```json\s*([\s\S]+)$/);
      if (truncatedMatch) {
        try {
          frameworkDraft = repairAndParseJSON(truncatedMatch[1].trim());
          console.warn(`[FrameworkBuilder] Recovered truncated JSON (output likely hit token limit)`);
        } catch {}
      }
    }

    res.json({
      message: text,
      frameworkDraft,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Framework Editor Chat (Edit existing frameworks via AI) ─────────────────

router.post("/edit", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { messages, frameworkId } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages array required" });
    }
    if (!frameworkId) {
      return res.status(400).json({ error: "frameworkId required" });
    }

    const { workspaceId } = getSessionContext(req);
    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return res.status(404).json({ error: "Framework not found" });

    const measures = await storage.getFrameworkMeasures(frameworkId);

    const { completeWithFallback } = await import("../lib/ai-providers.js");

    const systemPrompt = `You are an AI assistant that helps edit assessment frameworks in the CompanyIQ platform. You can modify existing frameworks by adding, removing, or editing measures.

CURRENT FRAMEWORK:
Name: ${framework.name}
ID: ${frameworkId}
Measures (${measures.length} total):
${measures.map((m: any, i: number) => `  ${i + 1}. [${m.measureId}] ${m.title} (Category: ${m.category || "Uncategorized"})`).join("\n")}

You can perform the following ACTIONS by including a JSON action block in your response:

1. DELETE measures:
\`\`\`action
{"type": "delete", "measureIds": ["measure-id-1", "measure-id-2"]}
\`\`\`

2. ADD measures:
\`\`\`action
{"type": "add", "measures": [{"measureId": "new-id", "title": "Question?", "definition": "...", "category": "Category Name", "scoringGuidance": {"yes": "...", "no": "...", "partial": "..."}, "evidenceKeywords": ["..."]}]}
\`\`\`

3. EDIT measures:
\`\`\`action
{"type": "edit", "edits": [{"measureId": "existing-id", "updates": {"title": "New title?", "definition": "New definition"}}]}
\`\`\`

4. RENAME framework:
\`\`\`action
{"type": "rename", "name": "New Framework Name"}
\`\`\`

5. ADD TRUSTED SOURCES (these are disclosure platforms searched during analysis):
\`\`\`action
{"type": "add_sources", "sources": [{"domain": "cdp.net", "name": "CDP", "description": "Climate disclosure platform"}]}
\`\`\`

6. REMOVE TRUSTED SOURCES:
\`\`\`action
{"type": "remove_sources", "domains": ["cdp.net"]}
\`\`\`

7. UPDATE DISCOVERY SETTINGS (search templates, negative keywords, negative domains, known URLs):
\`\`\`action
{"type": "update_discovery", "settings": {"searchTemplates": ["{company} sustainability report"], "negativeKeywords": ["job posting"], "negativeDomains": ["linkedin.com"], "knownDisclosureUrls": ["https://example.com/disclosures"]}}
\`\`\`
Note: Only include the fields you want to change. Arrays will REPLACE existing values (not append).

Current trusted sources for this framework: ${framework.trustedSourceIds ? `IDs: ${JSON.stringify(framework.trustedSourceIds)}` : "None configured"}
Current discovery settings:
- Search templates: ${JSON.stringify((framework as any).searchTemplates || [])}
- Negative keywords: ${JSON.stringify((framework as any).negativeKeywords || [])}
- Negative domains: ${JSON.stringify((framework as any).negativeDomains || [])}
- Known disclosure URLs: ${JSON.stringify((framework as any).knownDisclosureUrls || [])}

IMPORTANT RULES:
- Always confirm what you're about to do before including the action block
- If the user says to go ahead or confirms, include the action block in your response
- If the user's intent is clear and unambiguous (e.g., "remove questions 5 and 6"), you MAY include the action block immediately
- You can include MULTIPLE action blocks in one response if needed
- After performing actions, summarize what was changed
- When referencing measures, use their number from the list above or their measureId
- Be helpful and suggest improvements when appropriate`;

    const conversationPrompt = messages.map((m: { role: string; content: string }) =>
      `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`
    ).join("\n\n");

    const { text } = await completeWithFallback("deepseek", {
      system: systemPrompt,
      prompt: conversationPrompt,
      maxTokens: 8000,
    });

    // Parse and execute any action blocks
    const actions: any[] = [];
    const actionRegex = /```action\s*([\s\S]*?)```/g;
    let match;
    while ((match = actionRegex.exec(text)) !== null) {
      try {
        actions.push(JSON.parse(match[1].trim()));
      } catch {}
    }

    const executedActions: string[] = [];

    for (const action of actions) {
      try {
        if (action.type === "delete" && Array.isArray(action.measureIds)) {
          for (const measureId of action.measureIds) {
            await storage.deleteMeasure(frameworkId, measureId);
            executedActions.push(`Deleted measure: ${measureId}`);
          }
        } else if (action.type === "add" && Array.isArray(action.measures)) {
          // Get existing measures to determine categoryNumber and displayOrder
          const existingMeasures = await storage.getFrameworkMeasures(frameworkId);
          for (const m of action.measures) {
            // Determine categoryNumber: find existing category or assign next number
            const categoryName = m.category || "Uncategorized";
            const existingInCategory = existingMeasures.filter((em: any) => em.category === categoryName);
            let categoryNumber: number;
            if (existingInCategory.length > 0) {
              categoryNumber = existingInCategory[0].categoryNumber;
            } else {
              // New category — assign next category number
              const maxCatNum = existingMeasures.reduce((max: number, em: any) => Math.max(max, em.categoryNumber || 0), 0);
              categoryNumber = maxCatNum + 1;
            }
            // Determine displayOrder: next in that category
            const maxDisplayOrder = existingInCategory.reduce((max: number, em: any) => Math.max(max, em.displayOrder || 0), 0);
            const displayOrder = maxDisplayOrder + 1;

            await storage.createMeasure({
              ...m,
              frameworkId,
              category: categoryName,
              categoryNumber,
              displayOrder,
            });
            // Add to existingMeasures so subsequent adds in the same batch are aware
            existingMeasures.push({ ...m, frameworkId, category: categoryName, categoryNumber, displayOrder } as any);
            executedActions.push(`Added measure: ${m.measureId} - ${m.title}`);
          }
        } else if (action.type === "edit" && Array.isArray(action.edits)) {
          for (const edit of action.edits) {
            await storage.updateMeasure(frameworkId, edit.measureId, edit.updates);
            executedActions.push(`Updated measure: ${edit.measureId}`);
          }
        } else if (action.type === "rename" && action.name) {
          await storage.updateFramework(frameworkId, { name: action.name });
          executedActions.push(`Renamed framework to: ${action.name}`);
        } else if (action.type === "add_sources" && Array.isArray(action.sources)) {
          const existingSources = await storage.getTrustedSources(workspaceId);
          const existingDomains = new Map(existingSources.map((s: any) => [s.domain.toLowerCase(), s.id]));
          const currentIds: number[] = (framework.trustedSourceIds as number[]) || [];
          for (const src of action.sources) {
            const domain = src.domain.toLowerCase().replace(/^www\./, '');
            let sourceId: number;
            if (existingDomains.has(domain)) {
              sourceId = existingDomains.get(domain)!;
            } else {
              const newSource = await storage.createTrustedSource({ domain, description: src.description || src.name });
              sourceId = newSource.id;
            }
            if (!currentIds.includes(sourceId)) {
              currentIds.push(sourceId);
            }
          }
          await storage.updateFramework(frameworkId, { trustedSourceIds: currentIds });
          executedActions.push(`Added ${action.sources.length} trusted sources to framework`);
        } else if (action.type === "remove_sources" && Array.isArray(action.domains)) {
          const existingSources = await storage.getTrustedSources(workspaceId);
          const domainToId = new Map(existingSources.map((s: any) => [s.domain.toLowerCase(), s.id]));
          const currentIds: number[] = (framework.trustedSourceIds as number[]) || [];
          const removeIds = action.domains.map((d: string) => domainToId.get(d.toLowerCase())).filter(Boolean);
          const newIds = currentIds.filter((id: number) => !removeIds.includes(id));
          await storage.updateFramework(frameworkId, { trustedSourceIds: newIds });
          executedActions.push(`Removed ${action.domains.length} trusted sources from framework`);
        } else if (action.type === "update_discovery" && action.settings) {
          const discoveryUpdates: any = {};
          if (action.settings.searchTemplates) discoveryUpdates.searchTemplates = action.settings.searchTemplates;
          if (action.settings.negativeKeywords) discoveryUpdates.negativeKeywords = action.settings.negativeKeywords;
          if (action.settings.negativeDomains) discoveryUpdates.negativeDomains = action.settings.negativeDomains;
          if (action.settings.knownDisclosureUrls) discoveryUpdates.knownDisclosureUrls = action.settings.knownDisclosureUrls;
          if (Object.keys(discoveryUpdates).length > 0) {
            await storage.updateFramework(frameworkId, discoveryUpdates);
            executedActions.push(`Updated discovery settings: ${Object.keys(discoveryUpdates).join(", ")}`);
          }
        }
      } catch (err: any) {
        executedActions.push(`Error: ${err.message}`);
      }
    }

    res.json({
      message: text,
      actions: executedActions,
      hasChanges: executedActions.length > 0,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy endpoint (kept for backward compat)
router.post("/draft", async (req: Request, res: Response) => {
  try {
    const { topicDescription, measureCount } = req.body;
    if (!topicDescription) return res.status(400).json({ error: "Topic description required" });

    const { completeWithFallback } = await import("../lib/ai-providers.js");
    const { text } = await completeWithFallback("deepseek", {
      system: "You are an ESG framework designer. Create assessment measures for corporate disclosure analysis.",
      prompt: `Design an assessment framework for the following topic:\n\n${topicDescription}\n\nCreate ${measureCount || 25} specific, measurable questions grouped into 4-6 categories. Each measure should be answerable as Yes/No from public corporate disclosures.\n\nReturn JSON:\n{\n  "name": "Framework Name",\n  "categories": [\n    {\n      "name": "Category Name",\n      "measures": [\n        {\n          "measureId": "1.1-short-slug",\n          "title": "Does the company...?",\n          "definition": "Detailed definition",\n          "scoringGuidance": {"yes": "Evidence of...", "no": "No evidence of..."}\n        }\n      ]\n    }\n  ]\n}`,
      json: true,
      maxTokens: 8000,
    });

    res.json(JSON.parse(text));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Save Framework Draft ──────────────────────────────────────────────────

router.post("/save", requireWorkspace, async (req: Request, res: Response) => {
  try {
    const { workspaceId } = getSessionContext(req);
    const { framework } = req.body;

    if (!framework || !framework.name || !framework.categories) {
      return res.status(400).json({ error: "Invalid framework data" });
    }

    // Create the framework with discovery configuration
    const created = await storage.createFramework({
      workspaceId,
      name: framework.name,
      topicDescription: framework.description || framework.topicDescription || "",
      isActive: false,
      searchTemplates: framework.searchTemplates || null,
      negativeKeywords: framework.negativeKeywords || null,
      negativeDomains: framework.negativeDomains || null,
      knownDisclosureUrls: framework.knownDisclosureUrls || null,
      requiredDocTypes: framework.requiredDocTypes || null,
      dataPatterns: framework.dataPatterns || null,
    });

    // Create measures from categories
    let categoryNumber = 1;
    for (const category of framework.categories) {
      let displayOrder = 1;
      for (const measure of category.measures || []) {
        await storage.createFrameworkMeasure({
          frameworkId: created.id,
          measureId: measure.measureId || `${categoryNumber}.${displayOrder}`,
          title: measure.title,
          definition: measure.definition || "",
          scoringGuidance: typeof measure.scoringGuidance === "string" ? measure.scoringGuidance : JSON.stringify(measure.scoringGuidance || {}),
          evidenceKeywords: measure.evidenceKeywords || [],
          category: category.name,
          categoryNumber,
          displayOrder,
        });
        displayOrder++;
      }
      categoryNumber++;
    }

    // Activate the new framework
    await storage.setActiveFramework(created.id, workspaceId);

    // Save trusted sources if provided and link them to the framework
    const trustedSourceIds: number[] = [];
    if (framework.trustedSources && Array.isArray(framework.trustedSources)) {
      const existingSources = await storage.getTrustedSources(workspaceId);
      const existingDomains = new Map(existingSources.map((s: any) => [s.domain.toLowerCase().replace(/^www\./, ''), s.id]));

      for (const source of framework.trustedSources) {
        if (source.name && source.domain) {
          const domain = source.domain.toLowerCase().replace(/^www\./, '');
          let sourceId: number;
          if (existingDomains.has(domain)) {
            sourceId = existingDomains.get(domain)!;
          } else {
            const newSource = await storage.addTrustedSource(workspaceId, source.name, domain, source.reason || source.description || null);
            sourceId = newSource.id;
            existingDomains.set(domain, sourceId);
          }
          trustedSourceIds.push(sourceId);
        }
      }

      // Link trusted sources to the framework
      if (trustedSourceIds.length > 0) {
        await storage.updateFramework(created.id, { trustedSourceIds });
      }
    }

    res.json({ success: true, frameworkId: created.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

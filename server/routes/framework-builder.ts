import { Router, Request, Response } from "express";
import multer from "multer";
import { requireWorkspace, getSessionContext } from "../middleware/auth.js";
import * as storage from "../storage.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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
- "Let me clarify some key terms that often cause confusion in assessments like this. When you say [X], do you mean [specific interpretation A] or [broader interpretation B]?"
- For climate/emissions topics, ALWAYS ask:
  * "Should we distinguish between FINANCED emissions (on-balance-sheet lending, PCAF Part A) and FACILITATED emissions (capital markets underwriting, PCAF Part B)? Or treat them together?"
  * "Should we distinguish between ABSOLUTE targets (reduce total emissions by X%) and INTENSITY targets (reduce emissions per unit of output)? Some frameworks require absolute targets specifically."
  * "When we say 'sector coverage', which specific sectors should we evaluate? (e.g., Oil & Gas, Power Generation, Coal Mining, Automotive, Real Estate, Agriculture, Steel, Cement, Aviation)"
  * "Should we assess the company's OWN operational emissions (Scope 1 & 2) separately from their portfolio/financed emissions (Scope 3 Category 15)?"
- For governance topics, ALWAYS ask:
  * "Should board-level oversight be distinguished from management-level oversight?"
  * "Does 'policy' mean a standalone published document, or can it be a section within a broader report?"
- For target-setting topics, ALWAYS ask:
  * "What time horizons matter? Short-term (2025-2030), medium-term (2030-2040), or long-term (2050+)?"
  * "Must targets be validated by a third party (e.g., SBTi), or are self-declared targets sufficient?"
  * "Should we assess whether targets have been MAINTAINED or could have been withdrawn/rolled back?"

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
Before proposing the structure, ask targeted disambiguation questions based on what you've learned. These should address the MOST LIKELY sources of scoring confusion:

- "Let me check my understanding of some boundary cases:"
  * "If a company has a target for 'energy sector' but doesn't explicitly name 'oil and gas' — should that count?"
  * "If a company was a member of NZBA but has since withdrawn — should we score based on current state or historical commitment?"
  * "If a company has an intensity target but not an absolute target — is that a 'Yes', 'Partial', or 'No'?"
  * "If evidence exists in a 2022 report but not in the 2024 report — should we assume the commitment still stands?"
  * "If a company discloses financed emissions for some sectors but not all — is that 'Yes' or 'Partial'?"

These questions should be SPECIFIC to the topic. Generate 3-5 boundary-case questions that are most likely to cause inconsistent scoring.

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
The platform has a catalog of trusted disclosure sources that can be assigned to frameworks. When generating a framework, you MUST suggest 5-20 relevant trusted sources from this catalog AND/OR suggest new ones. These sources will be searched specifically during company analysis.

Available source categories:
- Statutory/securities filing repositories: SEC EDGAR, UK FCA NSM, Companies House, SEDAR+, EDINET, HKEXnews, ASX, etc.
- UK-specific statutory: Modern Slavery Registry, Gender Pay Gap Service, FCA SDR
- Country-specific ESG registries: Australia Modern Slavery Register, Canada Bill S-211, US EPA TRI, EU E-PRTR, French Devoir de Vigilance, etc.
- Voluntary global frameworks: CDP, TNFD, SBTi, SBTN, UN Global Compact
- Finance-sector pledges: NZAM, NZAOA, PRI, UNEP FI PRB/PSI, Equator Principles, PCAF, etc.
- UN-backed campaigns: Race to Zero, Race to Resilience, RE100, EV100, EP100, UN WEPs
- Sector-specific registries: EITI, ICMM, RSPO, FSC, PEFC, IRMA, ASI, Bonsucro, etc.
- Certification registries: B Corp, IAF CertSearch, LEED, BREEAM, WELL, ResponsibleSteel, etc.
- National companies registers: EU BRIS, Handelsregister, data.inpi.fr, KvK, etc.

WHEN YOU HAVE ENOUGH INFORMATION, generate the complete framework as a JSON block in your response. The JSON must follow this exact structure:
\`\`\`json
{
  "name": "Framework Name",
  "topicDescription": "A comprehensive 200-400 word description of the assessment scope, evidence types, relevant standards, EXPLICIT EXCLUSIONS, definitional boundaries, and temporal scope. This description is used by the discovery engine and scorer, so it must be precise.",
  "searchTemplates": ["{company} sustainability report AI governance", "{company} artificial intelligence policy", "{company} environmental social risk framework", "{company} transition plan"],
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
    // If the conversation suggests we're generating (user approved structure), use OpenAI as primary
    // to get the full 16K output capacity for large frameworks
    const lastUserMsg = messages[messages.length - 1]?.content?.toLowerCase() || '';
    const isLikelyGenerating = lastUserMsg.includes('build it') || lastUserMsg.includes('go ahead') || 
      lastUserMsg.includes('generate') || lastUserMsg.includes('approve') || lastUserMsg.includes('looks good') ||
      lastUserMsg.includes('please build') || lastUserMsg.includes('create it');
    
    const { text } = await completeWithFallback(
      isLikelyGenerating ? "openai" : "deepseek",
      {
        system: systemPrompt,
        prompt: conversationPrompt,
        maxTokens: 16384,
      }
    );

    // Check if the response contains a framework JSON
    let frameworkDraft = null;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        frameworkDraft = JSON.parse(jsonMatch[1].trim());
      } catch {}
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

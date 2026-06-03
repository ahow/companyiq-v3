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

YOUR BEHAVIOR — STRUCTURED CONVERSATION FLOW:
Follow this conversation flow (adapt as needed based on user responses):

1. UNDERSTAND: Start by understanding what the user wants to assess. Ask about scope, boundaries, and evidence types.

2. ASK ABOUT SIZE: Early in the conversation, ask the user approximately how many measures (questions) they want in the framework. Explain that more measures = more comprehensive but slower analysis, and suggest a range based on the topic complexity (e.g., "For this topic, I'd suggest 20-35 measures — enough to be thorough without being redundant. How many would you like?").

3. PROPOSE CATEGORY STRUCTURE: Once you understand the topic and desired size, propose a category structure BEFORE generating the full framework. Present it as a clear outline, e.g.:
   "Here's my proposed structure:
   - Category A (6 measures) — covering X, Y, Z
   - Category B (5 measures) — covering P, Q, R
   - Category C (4 measures) — covering M, N
   - Category D (5 measures) — covering S, T, U
   Total: ~20 measures
   
   Would you like to adjust any categories, add/remove topics, or change the number of measures?"

4. REFINE: Let the user approve, modify, or reject the structure. They may want to add categories, merge categories, change measure counts, or adjust scope.

5. GENERATE: Only generate the full framework JSON once the user approves the structure (or says "go ahead", "looks good", "generate it", etc.).

ADDITIONAL GUIDELINES:
- Make PROACTIVE SUGGESTIONS on topics, categories, and specific measures
- When suggesting measures, always provide the full detail (title, definition, scoringGuidance)
- Challenge vague or ambiguous requirements — push for specificity
- Suggest relevant industry standards, frameworks, or regulations that could inform the assessment
- If the user says "just generate it" or "skip the questions", propose the category structure in the same response and ask for quick approval before generating
- The framework must be:
  (a) Comprehensive — covers all important aspects of the topic
  (b) Precise — each measure has a clear, unambiguous definition
  (c) Observable — all measures can be answered from public corporate disclosures
  (d) Well-structured — measures are logically grouped and non-overlapping
  (e) Rigorous — scoring guidance is specific enough for consistent results

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
  "topicDescription": "A comprehensive 150-300 word description of the assessment scope, evidence types, relevant standards, and exclusions",
  "searchTemplates": ["{company} sustainability report AI governance", "{company} artificial intelligence policy"],
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
          "definition": "Detailed 50-150 word definition of what constitutes a YES answer. Must describe observable evidence in public documents.",
          "scoringGuidance": {
            "yes": "Specific evidence that must be present for a YES verdict. Name exact document types, committee names, policy elements, etc.",
            "no": "What absence or condition constitutes a NO. Be specific about what was searched for and not found.",
            "partial": "What constitutes partial compliance — evidence exists but is incomplete or indirect."
          },
          "evidenceKeywords": ["keywords", "that help", "find relevant", "passages in documents"]
        },
        {"measureId": "1.2-...", "title": "...", "definition": "...", "scoringGuidance": {"yes": "...", "no": "...", "partial": "..."}, "evidenceKeywords": ["..."]},
        {"measureId": "1.3-...", "title": "...", "definition": "...", "scoringGuidance": {"yes": "...", "no": "...", "partial": "..."}, "evidenceKeywords": ["..."]}
      ]
    },
    {
      "name": "Category 2 Name (include as many categories and measures as agreed with the user)",
      "measures": [
        {"measureId": "2.1-...", "title": "...", "definition": "...", "scoringGuidance": {"yes": "...", "no": "...", "partial": "..."}, "evidenceKeywords": ["..."]},
        {"measureId": "2.2-...", "title": "...", "definition": "...", "scoringGuidance": {"yes": "...", "no": "...", "partial": "..."}, "evidenceKeywords": ["..."]},
        {"measureId": "2.3-...", "title": "...", "definition": "...", "scoringGuidance": {"yes": "...", "no": "...", "partial": "..."}, "evidenceKeywords": ["..."]},
        {"measureId": "2.4-...", "title": "...", "definition": "...", "scoringGuidance": {"yes": "...", "no": "...", "partial": "..."}, "evidenceKeywords": ["..."]}
      ]
    }
  ]
}
\`\`\`

IMPORTANT RULES:
- Do NOT generate the framework JSON until you have (a) asked the user how many measures they want, (b) proposed a category structure, and (c) received approval or a "go ahead" from the user
- When you DO generate it, you MUST include the complete JSON block in the SAME response. NEVER say "hold on" or "please wait" — you cannot send follow-up messages. Everything must be in one response.
- When you DO generate it, include it in your message along with an explanation of what you've created and invite the user to review/refine
- CRITICAL: If you decide to generate the framework, you MUST output the full \`\`\`json block in this response. Do not defer it to a later message — there is no later message.
- If the user asks you to "suggest topics" or "what should I include", provide detailed suggestions with reasoning
- Each measure definition MUST be at least 50 words
- Each scoringGuidance entry MUST be at least 30 words
- Include evidenceKeywords for every measure (5-10 keywords each)
- Generate the number of measures the user requested (or that was agreed in the category structure proposal). There is NO fixed maximum — generate as many as needed.
- MINIMUM RULE: Every category MUST have at least 3 measures. If a category would have fewer than 3, merge it into a related category or expand it with additional relevant measures.
- Distribute measures across categories according to the approved structure. If no structure was explicitly approved, use your judgment based on topic complexity.
- After generating, ask if the user wants to refine any measures, add categories, or adjust scope
- ALWAYS include a "trustedSources" array in the JSON with 5-20 relevant sources. Include both sources from the catalog AND any additional sources you think are relevant (mark new suggestions clearly with a note in the reason field)

QUALITY CHECKLIST (mention this to the user when appropriate):
- [ ] Topic description is 150+ words covering scope, evidence types, standards, and exclusions
- [ ] Each measure has a definition of 50+ words
- [ ] Each measure has specific scoringGuidance for yes/no/partial
- [ ] Measures are mutually exclusive (no overlap)
- [ ] Measures are collectively exhaustive (cover all aspects)
- [ ] Evidence keywords are provided for each measure
- [ ] All measures are answerable from public corporate disclosures
- [ ] Categories are logically grouped
- [ ] Search templates are targeted and effective
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

Current trusted sources for this framework: ${framework.trustedSourceIds ? `IDs: ${JSON.stringify(framework.trustedSourceIds)}` : "None configured"}

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

    // Create the framework
    const created = await storage.createFramework({
      workspaceId,
      name: framework.name,
      topicDescription: framework.description || framework.topicDescription || "",
      isActive: false,
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

    // Save trusted sources if provided
    if (framework.trustedSources && Array.isArray(framework.trustedSources)) {
      for (const source of framework.trustedSources) {
        if (source.name && source.domain) {
          await storage.addTrustedSource(workspaceId, source.name, source.domain);
        }
      }
    }

    res.json({ success: true, frameworkId: created.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

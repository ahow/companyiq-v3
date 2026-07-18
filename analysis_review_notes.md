# Analysis Review Notes — Round 12 Disagreements vs Pipeline

## Key Findings from the Disagreement File (Round12_Management_Score_Changes.md)

### 5 Categories of Pipeline Weakness Identified by Reviewers:

1. **Systematic Under-grading of Hyperscalers (Amazon 9→14.5)**
   - Missed: published AI strategy (aboutamazon.com/ai), $200bn AI R&D, Rufus/Alexa+/robotics, responsible AI reports, $2.5bn workforce training
   - Root cause: discovery phase didn't search for company-specific AI strategy/governance pages
   - Recommendation: add targeted web searches for `[company] responsible AI report`, `[company] AI strategy`, `[company] AI workforce training`

2. **Empty vs "No" Distinction (M07, M09, M10)**
   - Some measures return empty strings instead of explicit "No" with rationale
   - Root cause: passage retrieval finds no relevant text → measure gets score 0 with no evidence, but no explicit "No" reasoning
   - Recommendation: validation step to flag empty-evidence measures for review

3. **Hardware/Infrastructure Company Calibration (Vertiv 15→14.5)**
   - M04 (AI Ethics Framework) scored "Yes" for general corporate ESG governance, not AI-specific ethics
   - Root cause: analyzer prompt doesn't distinguish between general corporate governance and AI-specific frameworks
   - Recommendation: M04 scoring guidance should explicitly require AI-focused ethics docs (model cards, AI principles, algorithmic fairness)

4. **Semi-Cap Equipment Makers Under-scored (Applied Materials 2→4.5)**
   - Missed AI-driven products (AIxA, eBeam metrology) deployed at scale
   - Root cause: discovery doesn't search for AI in process control / computational lithography for equipment makers
   - Recommendation: for semi-cap companies, search for AI/ML in process control, computational lithography, equipment calibration

5. **IP Portfolio and Supply Chain Measures (M09, M10) Systematically Missed**
   - Broadcom, AMD, ASML, Meta, Palantir all had M09/M10 upgraded
   - Root cause: these require patent/IP searches and supply chain analysis that standard discovery doesn't cover
   - Recommendation: add patent/IP search queries and supply chain position analysis

## Pipeline Code Architecture (from server/lib/analyzer.ts):

- Measures are scored individually via LLM against evidence text
- Evidence text comes from passage-retrieval.ts which extracts relevant passages from fetched documents
- If no relevant evidence is found, measure gets score 0 with "[No relevant evidence found in the document corpus]"
- The system prompt uses `measure.definition` field from the framework_measures table
- Scoring modes: Binary (Yes/No) or Partial Credit (Yes/Partial/No)
- Topic lexicon is derived from framework description + measure titles (LLM-backed, cached per framework)

## Discovery Phase (from server/lib/discovery.ts):

- Uses Serper.dev for web search (primary) with SerpAPI fallback
- Searches use query variants generated for each company
- Key gap: no evidence of targeted searches for AI strategy pages, responsible AI reports, workforce training programs
- The discovery generates query variants but may not include the specific governance/strategy search patterns the reviewers recommend

## What Needs Checking:
- [ ] The actual query variant generation logic (how discovery builds search queries)
- [ ] The framework_measures table definitions for the AI Governance framework (measure definitions/scoring guidance)
- [ ] Whether passage retrieval has topic-specific boosting that might miss hardware/infra AI deployments

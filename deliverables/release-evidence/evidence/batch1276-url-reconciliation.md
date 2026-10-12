# Batch 1276 — failed source URLs vs recovered content (12 completed companies)

Generated read-only: `documents` rows (SELECT in a `readonly` transaction) for the 12 completed company ids, joined by URL to the saved worker logs `/tmp/wklogs_{w1,w2,cf79e5a7,w4}.json` (merged, de-duplicated on (timestamp,message), clipped to the batch window 01:24:46–02:18:04 UTC). Scripts: `recon_db2.py` (DB snapshot), `recon_analyze.py` (join). No writes.

Definitions: **failed URL (log)** = URL with ≥1 browser-launch failure / browser-unavailable / fetch-timeout / HTTP-failure line in the window. **Recovered via fallback** = a failed URL that also has a Firecrawl, deferred-retry or browser-PDF recovery line. **ok in DB w/o logged recovery** = failed in logs, `fetch_status='ok'` with content now (recovered by a path that does not log a recovery line, e.g. later strategy in the same fetch chain). **Remaining gap** = failed URL with no recovery and not ok in DB. **dead (DB)** = `fetch_status='dead'` rows created/fetched in the batch window. `ok` = rows with `fetch_status='ok'` — equals the corpus counts in deliverable 36 for every company.

| Company (id) | doc rows | ok (corpus) | dead (DB) | dead, first-party & not gate-rejected | failed URLs (log) | of which browser launch/unavailable | recovered via fallback (by) | ok in DB w/o logged recovery | remaining gap (URLs) |
|---|---|---|---|---|---|---|---|---|---|
| CSX (9) | 32 | 27 | 2 (timeout 2) | 2 | 8 | 1 | 5 (firecrawl 5) | 1 | 2 |
| MAGNA (10) | 61 | 53 | 2 (transient 1, timeout 1) | 1 | 1 | 1 | 0 (—) | 0 | 1 |
| Southern (11) | 31 | 17 | 11 (timeout 8, budget_exceeded 3) | 10 | 11 | 11 | 1 (firecrawl 1) | 0 | 10 |
| DARDEN (14) | 42 | 34 | 2 (timeout 1, recovery:session_setup_failed 1) | 1 | 11 | 4 | 4 (firecrawl 4, deferred-retry 2) | 4 | 3 |
| BCE (15) | 38 | 29 | 7 (timeout 7) | 4 | 9 | 8 | 4 (firecrawl 4, deferred-retry 1) | 1 | 4 |
| CELESTICA (19) | 49 | 41 | 7 (recovery:session_setup_failed 3, budget_exceeded 4) | 5 | 14 | 10 | 5 (browser-pdf 1, firecrawl 4) | 7 | 2 |
| Dominion (20) | 29 | 24 | 2 (timeout 2) | 2 | 3 | 1 | 2 (browser-pdf 1, firecrawl 1) | 0 | 1 |
| Power Assets (21) | 61 | 34 | 1 (fetch_returned_empty 1) | 0 | 4 | 4 | 0 (—) | 0 | 4 |
| AXA (24) | 27 | 22 | 5 (timeout 3, recovery:session_setup_failed 2) | 3 | 6 | 6 | 0 (—) | 1 | 5 |
| OTSUKA (25) | 16 | 11 | 4 (timeout 4) | 3 | 4 | 1 | 1 (browser-pdf 1) | 0 | 3 |
| Idemitsu (29) | 35 | 26 | 7 (timeout 4, budget_exceeded 3) | 4 | 11 | 11 | 0 (—) | 4 | 7 |
| BARRATT (30) | 34 | 26 | 7 (timeout 6, budget_exceeded 1) | 6 | 13 | 11 | 4 (deferred-retry 3, firecrawl 2) | 2 | 7 |
| **Total** | 455 | 344 | 57 | 41 | 95 | 69 | 26 | 20 | 49 |

## Per-company reconciliation: failed → recovered → residual gap

Arithmetic per row: **failed URLs (log) = recovered via logged fallback + ok in DB without a logged recovery + residual gap.** Re-run on 2026-10-12 from the saved inputs (`recon_analyze.py` over `/tmp/recon_docs.json` + saved worker logs; 12,134 log lines in the window, 5 browser-launch lines not attributable to a company URL). The output matched the table above exactly.

| Company (id) | failed URLs | recovered via fallback | ok in DB, no logged recovery | **residual gap** | of which issuer-domain (first-party) | gap share of attempted corpus = gap / (ok + gap) |
|---|---|---|---|---|---|---|
| CSX (9) | 8 | 5 | 1 | **2** | 2 | 2 / 29 (6.9%) |
| MAGNA (10) | 1 | 0 | 0 | **1** | 0 | 1 / 54 (1.9%) |
| Southern (11) | 11 | 1 | 0 | **10** | 9 | 10 / 27 (37.0%) |
| DARDEN (14) | 11 | 4 | 4 | **3** | 2 (both gate-`rejected` annual reports, not fetch losses) | 3 / 37 (8.1%) |
| BCE (15) | 9 | 4 | 1 | **4** | 4 (incl. 2025 integrated + financial annual reports) | 4 / 33 (12.1%) |
| CELESTICA (19) | 14 | 5 | 7 | **2** | 2 | 2 / 43 (4.7%) |
| Dominion (20) | 3 | 2 | 0 | **1** | 1 | 1 / 25 (4.0%) |
| Power Assets (21) | 4 | 0 | 0 | **4** | 4 (sustainability reports + annual results) | 4 / 38 (10.5%) |
| AXA (24) | 6 | 0 | 1 | **5** | 3 (incl. 2024 integrated report) | 5 / 27 (18.5%) |
| OTSUKA (25) | 4 | 1 | 0 | **3** | 2 | 3 / 14 (21.4%) |
| Idemitsu (29) | 11 | 0 | 4 | **7** | 4 (sustainability databook PDFs) | 7 / 33 (21.2%) |
| BARRATT (30) | 13 | 4 | 2 | **7** | 6 (incl. 2022/2023/2026 annual reports) | 7 / 33 (21.2%) |
| **Total** | **95** | **26** | **20** | **49** | **39** | 49 / 393 (12.5%) |

### How to read this table: what it does NOT show
- **Fallback recovery does not mean full coverage.** 26 of the 95 failed URLs (27%) were recovered by a logged fallback (Firecrawl, deferred retry or browser-PDF). Another 20 ended `ok` in the DB through a path that logs no recovery line. **49 URLs (52%) were never recovered**, and 39 of those are on the issuer's own domains. Several are core disclosures (BCE 2025 annual reports, AXA 2024 integrated report, Barratt annual reports, Power Assets sustainability reports, Idemitsu databook).
- **36 score rows per company does not mean coverage.** Every company has exactly 36 `measure_scores` rows for batch 1276 (36 distinct measures). The pipeline writes one row per measure whatever evidence it had, so a complete score set says nothing about missing source documents. Scores for these 12 companies were produced on a corpus with the residual gaps listed here.
- **A recovered URL may hold less content than the browser would have produced.** Firecrawl or deferred-retry text for a PDF/viewer URL can be partial. This analysis checks that content exists (`content_length > 0`), not that it is equivalent.
- **Attribution is heuristic.** Failures and recoveries are matched to companies by URL; truncated URLs in logs are matched by prefix if longer than 40 characters. URLs that failed without any matching log line are not counted as "failed" here. They appear only in the `dead` list below: 57 dead rows in total, which overlap with but are not the same set as the 49 residual-gap URLs.
- **Southern (37% gap) is the clearest coverage loss.** All 11 of its failed URLs hit browser launch failures. The residual gap is the likely mechanism by which the browser-lifetime defect (fixed on `fix/browser-lifetime-and-stop-rule`) reduced corpus quality even for jobs that "completed". This is an inference from the log tags, not a measured causal link.

## Remaining-gap URLs per company (failed in batch window, no recovery, not ok in DB)

### CSX (9) — 2 gap URL(s)
- `https://www.csx.com/index.cfm/about-us/media/press-releases/csx-releases-2020-environmental-social-and-governance-report/` — DB `dead`/timeout; log: timeout-marked-dead
- `https://investors.csx.com/news-and-events/news/news-details/2026/CSX-Corp--Announces-Second-Quarter-2026-Results/default.aspx` — DB `dead`/timeout; log: timeout-marked-dead

### MAGNA (10) — 1 gap URL(s)
- `https://seekingalpha.com/article/4928727-magna-international-inc-mg-ca-q2-2026-earnings-call-transcript` — DB `dead`/timeout; log: browser-launch-failed, http-fetch-failed, timeout-marked-dead

### Southern (11) — 10 gap URL(s)
- `https://investor.southerncompany.com/financials-and-sec-filings/sec-filings/sec-filings-details/default.aspx?FilingId=16564943` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.southerncompany.com/newsroom/business-leadership/southern-company-joins-president-trumps-ratepayer-protection-pledge-reinforcing-customer-first-appr` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://investor.southerncompany.com/financials-and-sec-filings/sec-filings/sec-filings-details/default.aspx?FilingId=16411172` — DB `dead`/timeout; log: browser-launch-failed
- `https://southerncompany.com/about/intelligence` — DB `dead`/timeout; log: browser-launch-failed, http-fetch-failed, timeout-marked-dead
- `https://southerncompany.com/about/artificial` — DB `dead`/timeout; log: browser-launch-failed, http-fetch-failed, timeout-marked-dead
- `https://southerncompany.com/intelligence` — DB `dead`/timeout; log: browser-launch-failed, http-fetch-failed, timeout-marked-dead
- `https://www.southerncompany.com/intelligence` — DB `dead`/timeout; log: browser-launch-failed, http-fetch-failed, timeout-marked-dead
- `https://southerncompany.com/about/ai` — DB `dead`/budget_exceeded; log: browser-launch-failed, http-fetch-failed
- `https://www.southerncompany.com/ai` — DB `dead`/budget_exceeded; log: browser-launch-failed, http-fetch-failed
- `https://docs.publicnow.com/viewDoc?filename=40936%5CEXT%5CA20C44394FD40BA92182D95E44565F5B32C47574_336EEBC167AB4681DDA36F063F282CE12E13A855.PDF` — DB `dead`/budget_exceeded; log: browser-unavailable-left-retryable, http-fetch-failed

### DARDEN (14) — 3 gap URL(s)
- `https://s2.q4cdn.com/890585342/files/doc_financials/2024/ar/2024-annual-report-4.pdf` — DB `rejected`/unspecified; log: http-fetch-failed
- `https://s2.q4cdn.com/890585342/files/doc_financials/2021/ar/2021-annual-report.pdf` — DB `rejected`/unspecified; log: http-fetch-failed
- `https://www.liptonfinancialservices.com/wp-content/uploads/Darden-Restaurants-Inc.-2026-Q1-Results-Earnings-Call-Presentation-NYSE-_-DRI-2025-09-18-_-Seeking-Al` — DB `dead`/recovery:session_setup_failed; log: browser-unavailable-left-retryable, http-fetch-failed, timeout-marked-dead

### BCE (15) — 4 gap URL(s)
- `https://www.bce.ca/cs-assets/2025-bce-integrated-annual-report.pdf-blt14a3fcac20d37443` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.bce.ca/cs-assets/2025-bce-annual-financial-report.pdf-blt5d552f866d8a58a3` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.bce.ca/news-and-media/newsroom?article=Bell-AI-Fabric-Cohere-Hypertec-and-BUZZ-HPC-announce-landmark-deal-to-advance-sovereign-AI-in-Canada` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.bce.ca/news-and-media/newsroom?article=bell-cyber-and-cohere-deploy-sovereign-ai-for-canadian-cybersecurity-operations` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead

### CELESTICA (19) — 2 gap URL(s)
- `https://www.celestica.com/uploadedFiles/Site/About_Us/Sustainability/Sustainability_Overview/CEL_SustainabilityReport2017_FINAL-online.pdf` — DB `dead`/recovery:session_setup_failed; log: browser-launch-failed, http-fetch-failed, timeout-marked-dead
- `https://www.celestica.com.sg/uploadedFiles/Site/About_Us/Corporate_Governance/Overview_Corporate_Governance/2026_Board_of_Directors_Mandate_F.pdf` — DB `dead`/recovery:session_setup_failed; log: browser-unavailable-left-retryable, http-fetch-failed, timeout-marked-dead

### Dominion (20) — 1 gap URL(s)
- `https://investors.dominionenergy.com/events-and-presentations/event-details/2026/special-meeting/default.aspx` — DB `dead`/timeout; log: timeout-marked-dead

### Power Assets (21) — 4 gap URL(s)
- `https://www.powerassets.com/zh/sustainability/sustainability-reports/year-2025` — DB `inaccessible`/fetch_returned_empty; log: browser-launch-failed
- `https://www.powerassets.com/investor-information/announcements-and-circulars/2025/20250319_2024%20Annual%20Results` — DB `inaccessible`/fetch_returned_empty; log: browser-launch-failed
- `https://www.powerassets.com/sc/sustainability/sustainability-reports/year-2024` — DB `inaccessible`/fetch_returned_empty; log: browser-launch-failed
- `https://www.powerassets.com/sustainability/sustainability-reports/year-2024` — DB `inaccessible`/fetch_returned_empty; log: browser-launch-failed

### AXA (24) — 5 gap URL(s)
- `https://www.axa.com/en/press/publications/2024-integrated-report` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://webcast.axa.com/f/telecharger_document.php?id_Document=264` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://docs.publicnow.com/viewDoc.aspx?filename=173409%5CEXT%5C0E3AF68EF600CB4AD282EB3DCEAE9DB77D3FCD4E_26CCF918C928B90DC5AF6117539A98F6CF5C3DB0.PDF` — DB `dead`/recovery:session_setup_failed; log: browser-launch-failed, browser-unavailable-left-retryable, http-fetch-failed
- `https://docs.publicnow.com/viewDoc?filename=10005%5CEXT%5C6C48E6C7C0B92C29CDA94FB273170F4C938D0DDA_057D17D6E7426BBFE0607DC46802F25C76892AA7.PDF` — DB `dead`/recovery:session_setup_failed; log: browser-launch-failed, browser-unavailable-left-retryable, http-fetch-failed
- `https://www.axa.com/en/page/ai-frequently-asked-questions` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead

### OTSUKA (25) — 3 gap URL(s)
- `https://sp.otsuka-shokai.co.jp/english/corporate/ir/media/intege2026v.pdf` — DB `dead`/timeout; log: timeout-marked-dead
- `https://www.otsuka-shokai.co.jp/corporate/release/2025/250128.html` — DB `dead`/timeout; log: timeout-marked-dead
- `https://www.ir-tracker.com/en/articles/4768-2026-Q1` — DB `dead`/timeout; log: browser-launch-failed, http-fetch-failed, timeout-marked-dead

### Idemitsu (29) — 7 gap URL(s)
- `https://www.idemitsu.com/jp/sustainability/databook/p34ccn0000004d1f-att/trh49s0000002l3b.pdf` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.idemitsu.com/jp/sustainability/databook/p34ccn0000004d1f-att/trh49s0000002l2r.pdf` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.idemitsu.com/jp/sustainability/databook/p34ccn0000004d1f-att/trh49s0000002l3k.pdf` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.idemitsu.com/jp/sustainability/databook/report2018_web_all.pdf` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.stoxx.com/document/News/2026/September/STOXX_Components_Changes_STOXX_Strategy_Indices_20260915.pdf` — DB `dead`/budget_exceeded; log: browser-unavailable-left-retryable, http-fetch-failed
- `https://www.fasttrack.govt.nz/__data/assets/pdf_file/0017/30392/Appendix-47-Data-Centre-Draft-Environmental-Management-Plan.pdf` — DB `dead`/budget_exceeded; log: browser-unavailable-left-retryable, http-fetch-failed
- `https://docs.publicnow.com/viewDoc?filename=33680%5CEXT%5C3672A4F5956FC46B0449F51DFCEBAC5B5B5E6909_2403377EA24D389F29BC7E045AB065474B59FC9D.PDF` — DB `dead`/budget_exceeded; log: browser-unavailable-left-retryable, http-fetch-failed

### BARRATT (30) — 7 gap URL(s)
- `https://www.barrattredrow.co.uk/pdf-viewer.aspx?gid=461640836&src=/~/media/Files/B/Barratt-Developments-V2/documents/annual-report-2026/barratt-redrow-plc-annua` — DB `dead`/timeout; log: browser-unavailable-left-retryable, timeout-marked-dead
- `https://www.barrattredrow.co.uk/~/media/Files/B/Barratt-Developments-V2/documents/reports-and-presentation/2023/report/barratt-developments-plc-annual-report-an` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.barrattredrow.co.uk/~/media/Files/B/Barratt-Developments-V2/documents/reports-and-presentation/2022/reports/barratt-ar2022-single.pdf` — DB `dead`/timeout; log: browser-launch-failed
- `https://www.barrattredrow.co.uk/~/media/Files/B/Barratt-Developments-V2/documents/media-releases/2026/barratt-redrow-trading-update-april-2026.pdf` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://www.barrattredrow.co.uk/investors/annual-report-2026` — DB `dead`/timeout; log: browser-launch-failed, timeout-marked-dead
- `https://buckinghamshire.moderngov.co.uk/documents/g19787/Public%20reports%20pack%2015th-Jul-2026%2016.00%20Council.pdf?T=10` — DB `dead`/budget_exceeded; log: browser-launch-failed, browser-unavailable-left-retryable, http-fetch-failed
- `https://www.barrattredrow.co.uk/pdf-viewer.aspx?gid=461640836&src=/~/media/Files/B/Barratt-Developments-V2/documents/reports-and-presentation/2025/barratt-devel` — DB `dead`/timeout; log: browser-unavailable-left-retryable

## All `dead` document rows per company (DB)

### CSX (9)
- `https://www.csx.com/index.cfm/about-us/media/press-releases/csx-releases-2020-environmental-social-and-governance-report/` — reason=timeout failures=3 source=first_party gate=accept
- `https://investors.csx.com/news-and-events/news/news-details/2026/CSX-Corp--Announces-Second-Quarter-2026-Results/default.aspx` — reason=timeout failures=3 source=first_party gate=accept

### MAGNA (10)
- `https://www.magna.com/docs/default-source/corporate-governance/disclosure-documents---2023/magna-aif_cda.pdf?sfvrsn=3ce56dc1_11` — reason=transient failures=3 source=first_party gate=accept
- `https://seekingalpha.com/article/4928727-magna-international-inc-mg-ca-q2-2026-earnings-call-transcript` — reason=timeout failures=3 source=third_party gate=accept

### Southern (11)
- `https://www.southerncompany.com/miscellaneous-pages/2025-year-in-review.html` — reason=timeout failures=3 source=first_party gate=accept
- `https://investor.southerncompany.com/financials-and-sec-filings/sec-filings/sec-filings-details/default.aspx?FilingId=16564943` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.southerncompany.com/newsroom/business-leadership/southern-company-joins-president-trumps-ratepayer-protection-pledge-reinforcing-customer-first-appr` — reason=timeout failures=3 source=first_party gate=accept
- `https://investor.southerncompany.com/financials-and-sec-filings/sec-filings/sec-filings-details/default.aspx?FilingId=16411172` — reason=timeout failures=3 source=first_party gate=accept
- `https://southerncompany.com/about/intelligence` — reason=timeout failures=3 source=first_party gate=accept
- `https://southerncompany.com/about/artificial` — reason=timeout failures=3 source=first_party gate=accept
- `https://southerncompany.com/intelligence` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.southerncompany.com/intelligence` — reason=timeout failures=3 source=first_party gate=accept
- `https://southerncompany.com/about/ai` — reason=budget_exceeded failures=3 source=first_party gate=accept
- `https://www.southerncompany.com/ai` — reason=budget_exceeded failures=3 source=first_party gate=accept
- `https://docs.publicnow.com/viewDoc?filename=40936%5CEXT%5CA20C44394FD40BA92182D95E44565F5B32C47574_336EEBC167AB4681DDA36F063F282CE12E13A855.PDF` — reason=budget_exceeded failures=3 source=third_party gate=accept

### DARDEN (14)
- `https://investor.darden.com/financials/sec-filings/sec-filings-details/default.aspx?FilingId=19643942` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.liptonfinancialservices.com/wp-content/uploads/Darden-Restaurants-Inc.-2026-Q1-Results-Earnings-Call-Presentation-NYSE-_-DRI-2025-09-18-_-Seeking-Al` — reason=recovery:session_setup_failed failures=3 source=third_party gate=accept

### BCE (15)
- `https://www.bce.ca/cs-assets/2025-bce-integrated-annual-report.pdf-blt14a3fcac20d37443` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.bce.ca/cs-assets/2025-bce-annual-financial-report.pdf-blt5d552f866d8a58a3` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.bce.ca/news-and-media/newsroom?article=Bell-AI-Fabric-Cohere-Hypertec-and-BUZZ-HPC-announce-landmark-deal-to-advance-sovereign-AI-in-Canada` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.bce.ca/news-and-media/newsroom?article=bell-cyber-and-cohere-deploy-sovereign-ai-for-canadian-cybersecurity-operations` — reason=timeout failures=3 source=first_party gate=accept
- `https://ca.finance.yahoo.com/sec-filing/BRK-A/0001193125-26-106263_1067983` — reason=timeout failures=3 source=third_party gate=accept
- `https://halifax.citynews.ca/2026/06/16/shopify-shareholders-shoot-down-proposal-to-create-ai-policy-22-2026/` — reason=timeout failures=3 source=third_party gate=accept
- `https://finance.yahoo.com/technology/articles/bce-inc-bce-q2-2026-190501108.html?fr=sycsrp_catchall` — reason=timeout failures=3 source=third_party gate=accept

### CELESTICA (19)
- `https://www.celestica.com/uploadedFiles/Site/about-us/sustainabilityv2/sustainability-reporting/2025_Celestica_CDP_Response_Questionnaire.pdf` — reason=recovery:session_setup_failed failures=3 source=first_party gate=accept
- `https://www.celestica.com/uploadedFiles/Site/About_Us/Sustainability/Sustainability_Overview/CEL_SustainabilityReport2017_FINAL-online.pdf` — reason=recovery:session_setup_failed failures=3 source=first_party gate=accept
- `https://corporate.celestica.com/static-files/e274f433-1f4f-43c5-b20e-e98c863deb45` — reason=budget_exceeded failures=3 source=first_party gate=accept
- `https://celestica.gcs-web.com/static-files/462c0e16-4fd0-4486-bf1d-4449f7d96006` — reason=budget_exceeded failures=3 source=first_party gate=accept
- `https://www.celestica.com.sg/uploadedFiles/Site/About_Us/Corporate_Governance/Overview_Corporate_Governance/2026_Board_of_Directors_Mandate_F.pdf` — reason=recovery:session_setup_failed failures=3 source=first_party gate=accept
- `https://docs.publicnow.com/viewDoc?filename=34683%5CEXT%5C9AB9C370DBAAB4E13EA13879BA2E42629F313B73_3081D8211DD2ACFBA8CE5E0024F4F94E5F25439F.PDF` — reason=budget_exceeded failures=3 source=third_party gate=accept
- `https://ca.finance.yahoo.com/news/vertex-group-ltd-reports-second-233000921.html` — reason=budget_exceeded failures=3 source=third_party gate=accept

### Dominion (20)
- `https://www.dominionenergy.com/-/media/content/about/leadership-and-governance/pdfs/code-of-ethics-and-business-conduct.pdf?rev=aa5a25ea15bb44e4999151b9b7b8c17c` — reason=timeout failures=3 source=first_party gate=accept
- `https://investors.dominionenergy.com/events-and-presentations/event-details/2026/special-meeting/default.aspx` — reason=timeout failures=3 source=first_party gate=accept

### Power Assets (21)
- `https://www.hkelectric.com/zh/investor-information/announcements-and-circulars/year-2026/20260508_Announcement` — reason=fetch_returned_empty failures=3 source=third_party gate=accept

### AXA (24)
- `https://www.axa.com/en/press/publications/2024-integrated-report` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.axa.com/en/page/ai-frequently-asked-questions` — reason=timeout failures=3 source=first_party gate=accept
- `https://docs.publicnow.com/viewDoc?filename=10005%5CEXT%5C6C48E6C7C0B92C29CDA94FB273170F4C938D0DDA_057D17D6E7426BBFE0607DC46802F25C76892AA7.PDF` — reason=recovery:session_setup_failed failures=3 source=third_party gate=accept
- `https://webcast.axa.com/f/telecharger_document.php?id_Document=264` — reason=timeout failures=3 source=first_party gate=accept
- `https://docs.publicnow.com/viewDoc.aspx?filename=173409%5CEXT%5C0E3AF68EF600CB4AD282EB3DCEAE9DB77D3FCD4E_26CCF918C928B90DC5AF6117539A98F6CF5C3DB0.PDF` — reason=recovery:session_setup_failed failures=3 source=third_party gate=accept

### OTSUKA (25)
- `https://www.otsuka-shokai.co.jp/english/corporate/ir/media/202604br.pdf` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.otsuka-shokai.co.jp/corporate/release/2025/250128.html` — reason=timeout failures=3 source=first_party gate=accept
- `https://sp.otsuka-shokai.co.jp/english/corporate/ir/media/intege2026v.pdf` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.ir-tracker.com/en/articles/4768-2026-Q1` — reason=timeout failures=3 source=third_party gate=accept

### Idemitsu (29)
- `https://www.idemitsu.com/jp/sustainability/databook/p34ccn0000004d1f-att/trh49s0000002l3b.pdf` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.idemitsu.com/jp/sustainability/databook/p34ccn0000004d1f-att/trh49s0000002l2r.pdf` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.idemitsu.com/jp/sustainability/databook/p34ccn0000004d1f-att/trh49s0000002l3k.pdf` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.idemitsu.com/jp/sustainability/databook/report2018_web_all.pdf` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.stoxx.com/document/News/2026/September/STOXX_Components_Changes_STOXX_Strategy_Indices_20260915.pdf` — reason=budget_exceeded failures=3 source=third_party gate=accept
- `https://www.fasttrack.govt.nz/__data/assets/pdf_file/0017/30392/Appendix-47-Data-Centre-Draft-Environmental-Management-Plan.pdf` — reason=budget_exceeded failures=3 source=third_party gate=accept
- `https://docs.publicnow.com/viewDoc?filename=33680%5CEXT%5C3672A4F5956FC46B0449F51DFCEBAC5B5B5E6909_2403377EA24D389F29BC7E045AB065474B59FC9D.PDF` — reason=budget_exceeded failures=3 source=third_party gate=accept

### BARRATT (30)
- `https://www.barrattredrow.co.uk/pdf-viewer.aspx?gid=461640836&src=/~/media/Files/B/Barratt-Developments-V2/documents/annual-report-2026/barratt-redrow-plc-annua` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.barrattredrow.co.uk/pdf-viewer.aspx?gid=461640836&src=/~/media/Files/B/Barratt-Developments-V2/documents/reports-and-presentation/2025/barratt-devel` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.barrattredrow.co.uk/~/media/Files/B/Barratt-Developments-V2/documents/reports-and-presentation/2023/report/barratt-developments-plc-annual-report-an` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.barrattredrow.co.uk/~/media/Files/B/Barratt-Developments-V2/documents/reports-and-presentation/2022/reports/barratt-ar2022-single.pdf` — reason=timeout failures=3 source=first_party gate=accept
- `https://www.barrattredrow.co.uk/investors/annual-report-2026` — reason=timeout failures=3 source=first_party gate=accept
- `https://buckinghamshire.moderngov.co.uk/documents/g19787/Public%20reports%20pack%2015th-Jul-2026%2016.00%20Council.pdf?T=10` — reason=budget_exceeded failures=3 source=third_party gate=accept
- `https://www.barrattredrow.co.uk/~/media/Files/B/Barratt-Developments-V2/documents/media-releases/2026/barratt-redrow-trading-update-april-2026.pdf` — reason=timeout failures=3 source=first_party gate=accept

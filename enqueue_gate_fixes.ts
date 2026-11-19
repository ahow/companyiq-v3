import * as storage from "./server/storage.js";
import { addBatchJobs } from "./server/queue.js";

const WORKSPACE_ID = 3;
const FRAMEWORK_ID = 21;
const companyIds = [100,1005,1007,1016,1025,1026,1056,1063,107,1077,1086,1089,1094,1102,1106,1119,1120,1123,1135,1152,1154,1165,1185,1216,1221,124,1241,1243,1277,1287,1291,1295,130,1300,1308,131,1311,1323,1334,1338,134,1342,1346,1354,1364,1365,1386,139,1391,1392,1404,1417,1419,1436,1438,1441,1456,1468,1485,1493,1506,152,1526,1552,1558,1560,1581,1583,1590,160,1612,1628,1669,1672,168,1681,1685,1690,1694,1700,1707,1708,1709,1710,1725,1733,1744,1745,1759,1768,1774,1793,1802,1805,1823,1824,1826,1838,1853,1856,1871,1873,1879,1881,1882,1883,1902,1911,1914,1918,1922,1923,1933,1949,1954,1965,1971,1984,199,1997,2007,203,2038,2047,205,2059,2062,2068,2069,2087,2107,2108,2119,2131,2135,2144,2158,2188,2196,2201,2216,2225,2228,2250,2258,2260,2268,2312,2321,233,2331,2345,2347,2349,236,2368,2378,2381,2386,2396,2439,2451,246,252,2569,2571,2572,2578,2591,2593,2599,2619,2636,264,2644,265,2657,266,2667,27,28,292,295,299,308,327,333,353,368,379,382,383,394,398,40,414,42,422,430,442,446,451,456,481,494,498,531,555,563,57,58,589,590,602,616,621,624,628,629,631,64,654,657,67,675,677,680,685,689,690,707,721,722,734,745,752,755,760,773,774,778,786,804,807,825,832,84,846,852,863,864,873,899,901,905,906,908,910,911,913,924,936,944,954,960,961,962,964,974,976,981,989];

async function main() {
  const companies = [];
  for (const id of companyIds) {
    const c = await storage.getCompanyById(id, WORKSPACE_ID);
    if (c) companies.push(c);
  }
  
  if (companies.length === 0) {
    console.log("No companies found");
    process.exit(0);
  }

  for (const c of companies) {
    await storage.updateCompany(c.id, WORKSPACE_ID, {
      analysisStatus: "idle", totalScore: null, summary: null,
      measuresMetCount: null, measuresTotalCount: null,
    });
  }
  
  const batch = await storage.createBatchRun(WORKSPACE_ID, FRAMEWORK_ID, companies.length);
  console.log(`Created batch ${batch.id} for ${companies.length} gate-refinement companies`);

  const dbJobs = await storage.createAnalysisJobs(
    companies.map((c) => ({ workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: FRAMEWORK_ID })),
  );

  await addBatchJobs(
    dbJobs.map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: batch.id, workspaceId: WORKSPACE_ID })),
    WORKSPACE_ID,
    batch.id,
  );
  
  console.log("Enqueued. DONE");
  process.exit(0);
}

main().catch(console.error);

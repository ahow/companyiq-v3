import { tokenize } from "../lib/passage-retrieval.js";
const kws = ['nature-related opportunities','biodiversity opportunities','nature-positive','natural capital opportunities','ecosystem restoration','nature-based solutions','bio-inspired','biomimicry','biodiversity markets','nature-positive products','ecosystem services markets','TNFD opportunities','nature leadership'];
const all: string[] = [];
for (const k of kws) { const t = tokenize(k); all.push(...t); console.log(`${k.padEnd(32)} -> [${t.join(', ')}]`); }
const freq: Record<string,number> = {};
for (const t of all) freq[t]=(freq[t]||0)+1;
console.log('\nToken frequency across 2.4 evidenceKeywords:');
Object.entries(freq).sort((a,b)=>b[1]-a[1]).forEach(([t,c])=>console.log(`  ${t}: ${c}`));

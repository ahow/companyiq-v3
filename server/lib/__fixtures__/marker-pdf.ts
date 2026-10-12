// Minimal single-page PDF whose extractable text is `lines` (test-only; used to
// assert that each synthetic document's own marker survives the real browser →
// pdftotext extraction path, not just that "some text" came back).
export function markerPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  // Pad past PDF_TEXT_MIN_CHARS (100) so extraction stays on the primary
  // pdf-parse path instead of falling through to OCR.
  lines = [...lines, "Synthetic filing body text used only by local tests.", "No provider is called and no network leaves 127.0.0.1."];
  const content = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL", ...lines.map((l) => `(${esc(l)}) '`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** Marker a given synthetic document must yield after extraction. */
export const markerFor = (key: string) => `CIQMARKER-${key.replace(/[^A-Za-z0-9]/g, "")}`;

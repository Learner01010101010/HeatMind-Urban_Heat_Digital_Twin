/**
 * A very small PDF writer.
 *
 * The proposal has to leave this app as something a planning office can file or
 * email, which means PDF rather than JSON. A PDF library would be the obvious
 * answer, but the smallest of them is still a megabyte of dependency for what is,
 * for a text-only document, a few hundred bytes of syntax: a catalogue, a page
 * tree, one font resource and a content stream of positioned strings.
 *
 * Scope: Helvetica in WinAnsi, left-aligned lines, simple word wrap, multiple
 * pages. No images, no tables, no Unicode beyond Latin-1 — which is why callers
 * pass "Rs." rather than the rupee sign, since the base-14 fonts have no glyph
 * for it.
 */

const PAGE_W = 595.28; // A4 at 72 dpi
const PAGE_H = 841.89;
const MARGIN = 56;
const BODY_W = PAGE_W - MARGIN * 2;

export type Line =
  | { text: string; size?: number; bold?: boolean; gap?: number; indent?: number }
  | { rule: true }
  | { spacer: number };

/**
 * Helvetica advance widths, in 1/1000 em, for the printable WinAnsi range.
 *
 * Wrapping has to know how wide a string is, and a viewer lays text out with the
 * font's real metrics whatever we assume here. Guessing a monospace average put
 * long street names past the right margin, so these are the actual AFM widths.
 */
const W_REG = "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584".split(" ").map(Number);
const W_BOLD = "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584".split(" ").map(Number);

function widthOf(s: string, size: number, bold: boolean): number {
  const table = bold ? W_BOLD : W_REG;
  let total = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 32;
    // Outside the measured range, assume the width of "n" rather than zero.
    total += code >= 32 && code <= 126 ? table[code - 32] : table[78];
  }
  return (total * size) / 1000;
}

/** Break a paragraph to the body width, splitting any word too long to fit. */
function wrap(text: string, size: number, bold: boolean, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, bold) <= width) { line = next; continue; }
      if (line) out.push(line);
      if (widthOf(word, size, bold) <= width) { line = word; continue; }
      let chunk = "";
      for (const ch of word) {
        if (widthOf(chunk + ch, size, bold) > width) { out.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

/**
 * Escape for a PDF literal string and drop anything WinAnsi cannot carry.
 *
 * An unescaped bracket or backslash ends the string early and corrupts every
 * object offset after it, so this runs on all text without exception.
 */
const esc = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/·/g, "-").replace(/₹/g, "Rs.")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Render lines to a PDF and return it as a Blob. */
export function renderPdf(lines: Line[]): Blob {
  const pages: string[] = [];
  let body = "";
  let y = PAGE_H - MARGIN;

  const newPage = () => { pages.push(body); body = ""; y = PAGE_H - MARGIN; };

  for (const item of lines) {
    if ("spacer" in item) { y -= item.spacer; continue; }
    if ("rule" in item) {
      if (y < MARGIN + 24) newPage();
      body += `0.85 w 0.80 0.80 0.80 RG ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S\n`;
      y -= 12;
      continue;
    }
    const size = item.size ?? 10;
    const bold = item.bold ?? false;
    const indent = item.indent ?? 0;
    const leading = size * 1.35;
    for (const line of wrap(item.text, size, bold, BODY_W - indent)) {
      if (y < MARGIN + leading) newPage();
      body += `BT /${bold ? "F2" : "F1"} ${size} Tf 0.09 0.09 0.09 rg 1 0 0 1 ${(MARGIN + indent).toFixed(2)} ${y.toFixed(2)} Tm (${esc(line)}) Tj ET\n`;
      y -= leading;
    }
    y -= item.gap ?? 0;
  }
  pages.push(body);

  // Object table. Ids: 1 catalogue, 2 page tree, 3 regular font, 4 bold font,
  // then a page and a content stream for each page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((content, i) => {
    const id = pageIds[i];
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;
  });

  // Byte offsets must be exact, so the file is assembled once and measured as it
  // goes rather than reconstructed for the xref table.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  const count = objects.length;
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    out += offsets[i] === undefined ? "0000000000 65535 f \n" : `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  // latin1: every byte written above is a single byte, and the offsets counted
  // characters. Encoding as UTF-8 would shift them and break the xref table.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: "application/pdf" });
}

export function downloadPdf(name: string, lines: Line[]) {
  const url = URL.createObjectURL(renderPdf(lines));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

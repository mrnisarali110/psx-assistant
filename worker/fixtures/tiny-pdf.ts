/** A one-page PDF holding `text`, so tests can read a filing's text the way the worker does (unpdf). */
export function tinyPdf(text: string): Uint8Array {
  // Short lines: text running off the page is not extracted.
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    if (lines.length && (lines.at(-1) as string).length + word.length < 80) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  const esc = (s: string) => s.replace(/[()\\]/g, (c) => `\\${c}`);
  const stream = `BT /F1 10 Tf 12 TL 20 760 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

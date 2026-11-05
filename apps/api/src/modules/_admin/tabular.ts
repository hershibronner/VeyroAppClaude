// Minimal, dependency-free tabular readers: RFC 4180 CSV and the first worksheet of an .xlsx workbook.
import zlib from 'node:zlib';

/** Parses CSV text (quoted fields, escaped quotes, CRLF/LF, BOM, auto-detects ; or tab delimiters). */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = { ',': (firstLine.match(/,/g) ?? []).length, ';': (firstLine.match(/;/g) ?? []).length, '\t': (firstLine.match(/\t/g) ?? []).length };
  const delim = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',') as string;
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQ = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

// ── XLSX (Office Open XML) — reads the zip central directory, inflates sharedStrings + first sheet ──
function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    if (/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml|workbook\.xml)$/.test(name)) files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
function colIndex(ref: string) { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function excelDate(serial: number) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000)); return d.toISOString().slice(0, 10); }

export function parseXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const shared: string[] = [];
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) ?? []) shared.push(unescapeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map(t => t.replace(/<t[^>]*>|<\/t>/g, '')).join('')));
  const sheetName = [...files.keys()].filter(k => k.startsWith('xl/worksheets/')).sort()[0];
  if (!sheetName) throw new Error('The workbook has no worksheets');
  const xml = files.get(sheetName)!.toString('utf8');
  const rows: string[][] = [];
  for (const r of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = [];
    for (const c of r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = c.match(/ r="([A-Z]+\d+)"/)?.[1]; const t = c.match(/ t="(\w+)"/)?.[1]; const s = c.match(/ s="(\d+)"/)?.[1];
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1]; const is = c.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      let val = '';
      if (t === 's' && v !== undefined) val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = unescapeXml(is ?? '');
      else if (t === 'b') val = v === '1' ? 'true' : 'false';
      else if (v !== undefined) { val = unescapeXml(v); if (s && /^\d+(\.\d+)?$/.test(val) && Number(val) > 20000 && Number(val) < 80000 && !val.includes('.')) val = excelDate(Number(val)); }
      row[ref ? colIndex(ref) : row.length] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    if (row.some(x => x.trim() !== '')) rows.push(row);
  }
  return rows;
}

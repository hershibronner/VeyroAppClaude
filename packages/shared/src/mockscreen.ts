// Generates realistic-looking mock desktop screenshots (SVG) for demo mode.
export const MOCK_APPS = [
  { kind: 'email', app: 'Mail — Inbox', url: 'mail.brightline.example' },
  { kind: 'sheet', app: 'Sheets — Weekly Report', url: 'sheets.example/weekly' },
  { kind: 'crm', app: 'CRM — Patient Records', url: 'crm.example/records' },
  { kind: 'browser', app: 'Chrome — Scheduling Portal', url: 'portal.example/schedule' },
  { kind: 'docs', app: 'Docs — SOP Draft', url: 'docs.example/sop' },
  { kind: 'chat', app: 'Chat — #front-desk', url: 'chat.example/front-desk' },
] as const;

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function mockDesktopSvg(seed: number, kindIndex?: number, opts: { clock?: string; user?: string } = {}): { svg: string; app: string; url: string } {
  const r = rng(seed);
  const a = MOCK_APPS[(kindIndex ?? Math.floor(r() * MOCK_APPS.length)) % MOCK_APPS.length];
  const W = 1280, H = 800;
  const wallpapers = [['#1e3a8a', '#7c3aed'], ['#0f766e', '#1e40af'], ['#334155', '#0f172a'], ['#7c2d12', '#be185d']];
  const [w1, w2] = wallpapers[Math.floor(r() * wallpapers.length)];
  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`);
  p.push(`<defs><linearGradient id="wp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${w1}"/><stop offset="1" stop-color="${w2}"/></linearGradient></defs>`);
  p.push(`<rect width="${W}" height="${H}" fill="url(#wp)"/>`);
  p.push(`<rect width="${W}" height="26" fill="#000" opacity=".35"/><text x="14" y="18" fill="#fff" font-size="13" font-weight="bold"></text><text x="40" y="18" fill="#fff" font-size="13">${esc(a.app.split(' — ')[0])}</text><text x="${W - 14}" y="18" fill="#fff" font-size="13" text-anchor="end">${esc(opts.clock ?? '')}</text>`);
  const x0 = 60 + Math.floor(r() * 30), y0 = 50, ww = W - 120, wh = H - 120;
  p.push(`<rect x="${x0}" y="${y0}" width="${ww}" height="${wh}" rx="10" fill="#fff"/>`);
  p.push(`<rect x="${x0}" y="${y0}" width="${ww}" height="38" rx="10" fill="#f1f3f5"/><rect x="${x0}" y="${y0 + 28}" width="${ww}" height="10" fill="#f1f3f5"/>`);
  p.push(`<circle cx="${x0 + 18}" cy="${y0 + 19}" r="6" fill="#ff5f57"/><circle cx="${x0 + 38}" cy="${y0 + 19}" r="6" fill="#febc2e"/><circle cx="${x0 + 58}" cy="${y0 + 19}" r="6" fill="#28c840"/>`);
  p.push(`<rect x="${x0 + 90}" y="${y0 + 8}" width="${ww - 180}" height="22" rx="11" fill="#fff" stroke="#dee2e6"/><text x="${x0 + 104}" y="${y0 + 23}" font-size="12" fill="#495057">${esc(a.url)}</text>`);
  const cx = x0, cy = y0 + 38, cw = ww, ch = wh - 38;
  const line = (x: number, y: number, w: number, c = '#dee2e6', h = 9) => p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${c}"/>`);
  const names = ['Appointment request', 'Re: insurance verification', 'Invoice #1042', 'Schedule change', 'New patient intake', 'Follow-up call', 'Weekly summary', 'Claims update', 'Vendor quote', 'Team standup notes'];
  if (a.kind === 'email' || a.kind === 'chat') {
    p.push(`<rect x="${cx}" y="${cy}" width="220" height="${ch}" fill="#f8f9fa"/>`);
    for (let i = 0; i < 8; i++) line(cx + 20, cy + 24 + i * 34, 120 + r() * 70, i === 1 ? '#c7d2fe' : '#dee2e6');
    for (let i = 0; i < 9; i++) {
      const y = cy + 14 + i * 62;
      p.push(`<rect x="${cx + 230}" y="${y}" width="360" height="56" rx="6" fill="${i === 2 ? '#eef2ff' : '#fff'}" stroke="#f1f3f5"/>`);
      p.push(`<text x="${cx + 244}" y="${y + 22}" font-size="13" font-weight="bold" fill="#212529">${esc(names[Math.floor(r() * names.length)])}</text>`);
      line(cx + 244, y + 32, 280 * (0.5 + r() / 2));
    }
    p.push(`<text x="${cx + 620}" y="${cy + 40}" font-size="20" font-weight="bold" fill="#212529">${esc(names[Math.floor(r() * names.length)])}</text>`);
    for (let i = 0; i < 14; i++) line(cx + 620, cy + 70 + i * 24, (cw - 660) * (0.6 + r() * 0.4));
  } else if (a.kind === 'sheet') {
    const cols = 9, rows = 22, colW = (cw - 40) / cols;
    for (let c = 0; c <= cols; c++) p.push(`<line x1="${cx + 40 + c * colW}" y1="${cy + 30}" x2="${cx + 40 + c * colW}" y2="${cy + ch}" stroke="#e9ecef"/>`);
    for (let rr = 0; rr <= rows; rr++) {
      const y = cy + 30 + rr * 28;
      p.push(`<line x1="${cx}" y1="${y}" x2="${cx + cw}" y2="${y}" stroke="#e9ecef"/>`);
      if (rr < rows) {
        p.push(`<text x="${cx + 14}" y="${y + 19}" font-size="11" fill="#868e96">${rr + 1}</text>`);
        for (let c = 0; c < cols; c++) {
          const v = c === 0 ? esc(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Region A', 'Region B', 'Total'][rr % 8]) : (r() * 9000).toFixed(c % 3 === 0 ? 2 : 0);
          p.push(`<text x="${cx + 48 + c * colW}" y="${y + 19}" font-size="12" fill="${rr === 0 ? '#1c7ed6' : '#343a40'}" ${rr === 0 ? 'font-weight="bold"' : ''}>${rr === 0 ? 'Col ' + String.fromCharCode(65 + c) : v}</text>`);
        }
      }
    }
  } else if (a.kind === 'crm') {
    p.push(`<rect x="${cx}" y="${cy}" width="200" height="${ch}" fill="#1f2937"/>`);
    for (let i = 0; i < 9; i++) line(cx + 20, cy + 30 + i * 36, 110 + r() * 40, i === 2 ? '#6366f1' : '#4b5563');
    p.push(`<text x="${cx + 230}" y="${cy + 44}" font-size="20" font-weight="bold" fill="#111827">Records</text>`);
    for (let i = 0; i < 13; i++) {
      const y = cy + 70 + i * 44;
      p.push(`<rect x="${cx + 230}" y="${y}" width="${cw - 260}" height="38" fill="${i % 2 ? '#fff' : '#f9fafb'}"/>`);
      p.push(`<circle cx="${cx + 250}" cy="${y + 19}" r="11" fill="hsl(${Math.floor(r() * 360)},60%,70%)"/>`);
      line(cx + 274, y + 14, 140 + r() * 60, '#9ca3af');
      line(cx + 520, y + 14, 90 + r() * 60);
      p.push(`<rect x="${cx + 760}" y="${y + 9}" width="70" height="20" rx="10" fill="${['#dcfce7', '#fef3c7', '#dbeafe'][i % 3]}"/>`);
      line(cx + 880, y + 14, 60 + r() * 40);
    }
  } else {
    // browser / docs
    p.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="56" fill="${a.kind === 'docs' ? '#f8f9fa' : '#4f46e5'}"/>`);
    p.push(`<text x="${cx + 30}" y="${cy + 36}" font-size="18" font-weight="bold" fill="${a.kind === 'docs' ? '#212529' : '#fff'}">${esc(a.app.split(' — ')[1] ?? a.app)}</text>`);
    const left = a.kind === 'docs' ? cx + 220 : cx + 40, width = a.kind === 'docs' ? cw - 440 : cw - 80;
    for (let i = 0; i < 18; i++) {
      if (i % 6 === 0) { p.push(`<text x="${left}" y="${cy + 100 + i * 28}" font-size="16" font-weight="bold" fill="#212529">${esc(names[Math.floor(r() * names.length)])}</text>`); continue; }
      line(left, cy + 90 + i * 28, width * (0.55 + r() * 0.45));
    }
    if (a.kind === 'browser') for (let i = 0; i < 3; i++) p.push(`<rect x="${cx + 40 + i * ((cw - 80) / 3)}" y="${cy + ch - 170}" width="${(cw - 120) / 3}" height="140" rx="8" fill="#eef2ff"/>`);
  }
  p.push(`<rect x="${W / 2 - 220}" y="${H - 56}" width="440" height="46" rx="14" fill="#fff" opacity=".28"/>`);
  for (let i = 0; i < 8; i++) p.push(`<rect x="${W / 2 - 200 + i * 52}" y="${H - 50}" width="34" height="34" rx="8" fill="hsl(${i * 45},70%,60%)"/>`);
  p.push('</svg>');
  return { svg: p.join(''), app: a.app, url: a.url };
}

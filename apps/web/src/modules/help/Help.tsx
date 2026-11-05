import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, LifeBuoy, MessageSquarePlus, Search } from 'lucide-react';
import { useApi, useDebounced } from '../../lib/hooks';
import { Banner, Button, Card, CardHeader, EmptyState, PageHeader, Segmented } from '../../components/ui';
import { ARTICLES, CATEGORIES, type Article } from './articles';
import '../settings/settings.css';

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((p, i) => p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith('*') && p.length > 2 ? <i key={i}>{p.slice(1, -1)}</i> : <Fragment key={i}>{p}</Fragment>);
}
export function Markup({ text }: { text: string }) {
  const out: ReactNode[] = []; let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => { if (list) { const L = list; out.push(L.ordered ? <ol key={out.length}>{L.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</ol> : <ul key={out.length}>{L.items.map((x, i) => <li key={i}>{inline(x)}</li>)}</ul>); list = null; } };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('## ')) { flush(); out.push(<h3 key={out.length}>{t.slice(3)}</h3>); }
    else if (/^- /.test(t)) { if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; } list.items.push(t.slice(2)); }
    else if (/^\d+\. /.test(t)) { if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] }; } list.items.push(t.replace(/^\d+\. /, '')); }
    else if (t) { flush(); out.push(<p key={out.length}>{inline(t)}</p>); }
  }
  flush();
  return <div className="st-article">{out}</div>;
}

export default function HelpCenter() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q, 150).trim().toLowerCase();
  const cat = sp.get('category') ?? 'all';
  const slug = sp.get('a');
  const tickets = useApi<any>('/api/v1/support/summary');
  const platformInfo = useApi<any>('/api/v1/platform/public-settings');
  const results = useMemo(() => ARTICLES.filter(a => (cat === 'all' || a.category === cat) && (!dq || dq.split(/\s+/).every(w => `${a.title} ${a.summary} ${a.body} ${a.keywords ?? ''} ${a.category}`.toLowerCase().includes(w)))), [dq, cat]);
  const article = slug ? ARTICLES.find(a => a.slug === slug) : null;
  if (article) return <ArticleView a={article} onBack={() => setSp(cat !== 'all' ? { category: cat } : {})} />;
  const t = tickets.data;
  return (
    <div className="stack">
      <PageHeader title="Help Center" sub="Guides for every part of VeyroApp, and direct access to the VeyroApp support team."
        actions={<><Button icon={<LifeBuoy size={16} />} onClick={() => nav('/help/tickets')}>My tickets{t?.open + t?.pending ? ` (${t.open + t.pending} open)` : ''}</Button><Button variant="primary" icon={<MessageSquarePlus size={16} />} onClick={() => nav('/help/tickets?new=1')}>Contact support</Button></>} />
      {platformInfo.data?.maintenance_banner && <Banner tone="warn">{platformInfo.data.maintenance_banner}</Banner>}
      {t && t.pending > 0 && <Banner>VeyroApp Support replied to {t.pending} of your tickets. <Link to="/help/tickets?status=pending">Read the replies</Link>.</Banner>}
      <Card>
        <div className="card-b stack" style={{ gap: 14 }}>
          <div className="search-input" style={{ width: '100%' }}><Search size={18} /><input className="input" style={{ height: 48, fontSize: 16, paddingLeft: 40 }} aria-label="Search help articles" placeholder="Search for help — e.g. “invite”, “overtime”, “webhook”" value={q} onChange={e => { setQ(e.target.value); }} autoFocus /></div>
          <div style={{ overflowX: 'auto' }}><Segmented value={cat} onChange={k => setSp(k === 'all' ? {} : { category: k })} options={[{ key: 'all', label: 'All' }, ...CATEGORIES.map(c => ({ key: c, label: c }))]} /></div>
        </div>
      </Card>
      {results.length === 0 ? <Card><EmptyState icon={<BookOpen size={22} />} title="No articles match" text={<>Try other words, or <Link to="/help/tickets?new=1">ask the support team</Link>.</>} /></Card> : (
        <div className="st-help-grid">
          {results.map(a => (
            <button key={a.slug} className="st-help-card" onClick={() => setSp({ a: a.slug, ...(cat !== 'all' ? { category: cat } : {}) })}>
              <span className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>{a.category}</span>
              <b>{a.title}</b>
              <span className="small muted">{a.summary}</span>
            </button>
          ))}
        </div>
      )}
      <div className="small muted">{results.length} of {ARTICLES.length} articles</div>
    </div>
  );
}

function ArticleView({ a, onBack }: { a: Article; onBack: () => void }) {
  const nav = useNavigate();
  const related = ARTICLES.filter(x => x.category === a.category && x.slug !== a.slug).slice(0, 4);
  return (
    <div className="stack">
      <PageHeader title={a.title} sub={a.category} back="/help" actions={<Button onClick={onBack}>All articles</Button>} />
      <div className="grid-main-side">
        <Card>
          <div className="card-b"><p className="muted" style={{ marginTop: 0 }}>{a.summary}</p><Markup text={a.body} />
            {a.links && <div className="row mt-3">{a.links.map(l => <Link key={l.to} to={l.to} className="btn btn-sm">{l.label}</Link>)}</div>}
          </div>
        </Card>
        <div className="stack">
          <Card><CardHeader title="Still stuck?" /><div className="card-b stack" style={{ gap: 10 }}><span className="small muted">Our support team answers tickets during business hours. Include what you tried and any record names.</span><Button variant="primary" icon={<MessageSquarePlus size={16} />} onClick={() => nav(`/help/tickets?new=1&subject=${encodeURIComponent(`Question about: ${a.title}`)}`)}>Contact support</Button></div></Card>
          {related.length > 0 && <Card><CardHeader title="Related articles" /><div className="card-b stack" style={{ gap: 8 }}>{related.map(r => <Link key={r.slug} to={`/help?a=${r.slug}`} className="small">{r.title}</Link>)}</div></Card>}
        </div>
      </div>
    </div>
  );
}

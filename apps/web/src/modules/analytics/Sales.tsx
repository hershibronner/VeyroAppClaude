import { useNavigate, useSearchParams } from 'react-router-dom';
import { Target, Briefcase, Users, DollarSign } from 'lucide-react';
import { Boundary, Card, CardHeader, KpiRow, Segmented } from '../../components/ui';
import { ChartCard, Funnel, TrackBars, fmtNum, fmtMoney } from '../../components/charts';
import { AnalyticsPage, BreakdownTable, useAnalytics, fmtValue } from './frame';

const GROUPS = [{ key: 'source', label: 'Lead source' }, { key: 'owner', label: 'Owner' }, { key: 'campaign', label: 'Campaign' }, { key: 'industry', label: 'Industry' }] as const;
type G = (typeof GROUPS)[number]['key'];

export default function Sales() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const group = (sp.get('group') as G) || 'source';
  const a = useAnalytics('/api/v1/analytics/sales', 365, `&group=${group}`);
  const label = GROUPS.find(g => g.key === group)!.label;
  return (
    <AnalyticsPage title="Sales analytics" sub="From lead source to opportunity, placement, revenue and gross profit." {...a} exportName={`sales-by-${group}`}
      exportRows={() => a.st.data ? { rows: a.st.data.rows, cols: [{ key: 'label', label }, { key: 'leads', label: 'Leads' }, { key: 'qualified', label: 'Qualified' }, { key: 'opportunities', label: 'Opportunities' }, { key: 'won', label: 'Won' }, { key: 'clients', label: 'Clients' }, { key: 'placements', label: 'Placements' }, { key: 'revenue', label: 'Revenue (USD)', value: (r: any) => r.revenue === null ? '' : (r.revenue / 100).toFixed(2) }, { key: 'profit', label: 'Gross profit (USD)', value: (r: any) => r.profit === null ? '' : (r.profit / 100).toFixed(2) }] } : null}>
      {d => <>
        <KpiRow items={[
          { label: 'Leads', icon: <Target size={16} />, value: fmtNum(d.totals.leads), deltaText: <span className="muted">{d.totals.qualified} qualified</span>, suffix: '', to: `/crm/leads?from=${d.range.from}&to=${d.range.to}` },
          { label: 'Opportunities won', icon: <Briefcase size={16} />, value: `${d.totals.won} / ${d.totals.opportunities}`, deltaText: <span className="muted">{d.totals.opportunities ? ((d.totals.won / d.totals.opportunities) * 100).toFixed(1) : '0.0'}% win rate</span>, suffix: '', to: '/crm/opportunities?stage=won' },
          { label: 'Placements', icon: <Users size={16} />, value: fmtNum(d.totals.placements), deltaText: <span className="muted">from {d.totals.clients} clients</span>, suffix: '', to: '/workforce/placements' },
          ...(d.showMoney ? [{ label: 'Revenue → profit', icon: <DollarSign size={16} />, value: fmtValue(d.totals.revenue, 'money'), deltaText: <span className="muted">{fmtValue(d.totals.profit, 'money')} gross profit</span>, suffix: '', to: `/finance/invoices?from=${d.range.from}&to=${d.range.to}` }] : []),
        ]} />
        <div className="ins-charts mb-3">
          <Boundary label="Sales funnel">
            <ChartCard title="Lead → placement funnel" big={fmtNum(d.totals.leads)} delta={<span className="muted">leads in range</span>}>
              <Funnel steps={d.funnel} onStepClick={(s: any) => { const f = d.funnel.find((x: any) => x.key === s.key); if (f) nav(f.link); }} />
            </ChartCard>
          </Boundary>
          <Boundary label="Revenue by group">
            <ChartCard title={d.showMoney ? `Revenue by ${label.toLowerCase()}` : `Leads by ${label.toLowerCase()}`} big={d.rows[0]?.label ?? '—'} delta={<span className="muted">top {label.toLowerCase()}</span>}>
              {d.rows.length ? <TrackBars data={d.rows.slice(0, 8).map((r: any) => ({ ...r, value: d.showMoney ? r.revenue : r.leads }))} fmt={d.showMoney ? fmtMoney : fmtNum} valueName={d.showMoney ? 'Revenue' : 'Leads'} onBarClick={(r: any) => nav(r.link)} /> : <div className="ins-empty-chart">No leads in range</div>}
            </ChartCard>
          </Boundary>
        </div>
        <Card>
          <CardHeader title={`By ${label.toLowerCase()}`} right={<Segmented options={GROUPS.map(g => ({ key: g.key, label: g.label }))} value={group} onChange={k => { const n = new URLSearchParams(sp); n.set('group', k); setSp(n, { replace: true }); }} />} />
          <BreakdownTable rows={d.rows} onRow={r => nav(r.link)} cols={[
            { key: 'label', label }, { key: 'leads', label: 'Leads', format: 'num' }, { key: 'qualified', label: 'Qualified', format: 'num' }, { key: 'opportunities', label: 'Opps', format: 'num' },
            { key: 'won', label: 'Won', format: 'num' }, { key: 'win_rate', label: 'Win rate', format: 'pct' }, { key: 'placements', label: 'Placements', format: 'num' },
            ...(d.showMoney ? [{ key: 'revenue', label: 'Revenue', format: 'money' as const }, { key: 'profit', label: 'Gross profit', format: 'money' as const }] : []),
          ]} />
        </Card>
      </>}
    </AnalyticsPage>
  );
}

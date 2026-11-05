import { useNavigate, useSearchParams } from 'react-router-dom';
import { Boundary, Card, CardHeader, Segmented } from '../../components/ui';
import { ChartCard, Funnel, SimpleBars, fmtNum } from '../../components/charts';
import { AnalyticsPage, BreakdownTable, Kpis, useAnalytics } from './frame';

const GROUPS = [{ key: 'recruiter', label: 'Recruiter' }, { key: 'source', label: 'Source' }, { key: 'position', label: 'Position' }, { key: 'client', label: 'Client' }, { key: 'country', label: 'Country' }] as const;
type G = (typeof GROUPS)[number]['key'];

export default function Recruiting() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const group = (sp.get('group') as G) || 'recruiter';
  const a = useAnalytics('/api/v1/analytics/recruiting', 182, `&group=${group}`);
  const label = GROUPS.find(g => g.key === group)!.label;
  return (
    <AnalyticsPage title="Recruiting analytics" sub="Pipeline volume and conversion by recruiter, source, position, client and country." {...a} exportName={`recruiting-by-${group}`}
      exportRows={() => a.st.data ? { rows: a.st.data.rows, cols: [{ key: 'label', label }, { key: 'applied', label: 'Applied' }, { key: 'submitted', label: 'Submitted' }, { key: 'interviewed', label: 'Interviewed' }, { key: 'offered', label: 'Offered' }, { key: 'hired', label: 'Hired' }, { key: 'conversion', label: 'Apply→Hire %' }] } : null}>
      {d => <>
        <Kpis kpis={d.kpis} />
        <div className="ins-charts mb-3">
          <Boundary label="Funnel">
            <ChartCard title="Funnel conversion" big={fmtNum(d.funnel[0].value)} delta={<span className="muted">applications · click a stage to open it</span>}>
              <Funnel steps={d.funnel} onStepClick={(s: any) => { const f = d.funnel.find((x: any) => x.key === s.key); if (f) nav(f.link); }} />
            </ChartCard>
          </Boundary>
          <Boundary label="Applications trend">
            <ChartCard title="Applications over time" big={fmtNum(d.trend.reduce((s: number, x: any) => s + x.value, 0))} delta={<span className="muted">received in range</span>}>
              <SimpleBars data={d.trend} onBarClick={(r: any) => nav(r.link)} />
            </ChartCard>
          </Boundary>
        </div>
        <Card>
          <CardHeader title={`By ${label.toLowerCase()}`} right={<Segmented options={GROUPS.map(g => ({ key: g.key, label: g.label }))} value={group} onChange={k => { const n = new URLSearchParams(sp); n.set('group', k); setSp(n, { replace: true }); }} />} />
          <BreakdownTable rows={d.rows} onRow={r => nav(r.link)} cols={[
            { key: 'label', label },
            { key: 'applied', label: 'Applied', format: 'num' }, { key: 'submitted', label: 'Submitted', format: 'num' }, { key: 'interviewed', label: 'Interviewed', format: 'num' },
            { key: 'offered', label: 'Offered', format: 'num' }, { key: 'hired', label: 'Hired', format: 'num' }, { key: 'conversion', label: 'Apply → hire', format: 'pct' },
          ]} />
        </Card>
      </>}
    </AnalyticsPage>
  );
}

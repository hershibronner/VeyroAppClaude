import { useNavigate } from 'react-router-dom';
import { Boundary } from '../../components/ui';
import { ChartCard, TrendLine, TrackBars, SimpleBars, fmtMoney, fmtMoneyCompact, fmtNum } from '../../components/charts';
import { AnalyticsPage, Kpis, useAnalytics } from './frame';

export default function Executive() {
  const nav = useNavigate();
  const a = useAnalytics('/api/v1/analytics/executive');
  return (
    <AnalyticsPage title="Executive" sub="Revenue, payroll, margin and growth for the selected period — click any point or bar to open the records behind it." {...a} exportName="executive"
      exportRows={() => a.st.data ? { rows: a.st.data.series, cols: [{ key: 'label', label: 'Period' }, { key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'revenue', label: 'Revenue (USD)', value: (r: any) => (r.revenue / 100).toFixed(2) }, { key: 'payroll', label: 'Payroll (USD)', value: (r: any) => r.payroll === null ? '' : (r.payroll / 100).toFixed(2) }, { key: 'profit', label: 'Gross profit (USD)', value: (r: any) => (r.profit / 100).toFixed(2) }, { key: 'margin', label: 'Margin %' }] } : null}>
      {d => <>
        <Kpis kpis={d.kpis} />
        {d.showMoney && (
          <div className="ins-charts mb-3">
            <Boundary label="Revenue trend">
              <ChartCard title="Revenue, payroll & gross profit" big={fmtMoney(d.series.reduce((s: number, x: any) => s + x.revenue, 0))} delta={<span className="muted">invoiced in range</span>}>
                {d.series.some((x: any) => x.revenue || x.profit) ? <TrendLine data={d.series} fmt={fmtMoneyCompact} series={[{ key: 'revenue', name: 'Revenue' }, ...(d.showPayroll ? [{ key: 'payroll', name: 'Payroll', color: '#A78BFA' }] : []), { key: 'profit', name: 'Gross profit', color: '#14B8A6' }]} onPointClick={(p: any) => nav(p.link)} /> : <div className="ins-empty-chart">No revenue in this range</div>}
              </ChartCard>
            </Boundary>
            <Boundary label="Top clients">
              <ChartCard title="Top clients by revenue" big={d.topClients[0] ? d.topClients[0].label : '—'} delta={<span className="muted">largest client in range</span>}>
                {d.topClients.length ? <TrackBars data={d.topClients} fmt={fmtMoney} valueName="Revenue" onBarClick={(r: any) => nav(r.link)} /> : <div className="ins-empty-chart">No invoices in this range</div>}
              </ChartCard>
            </Boundary>
          </div>
        )}
        {d.headcount.length > 0 && (
          <Boundary label="Headcount">
            <ChartCard title="Active placements (headcount)" big={fmtNum(d.headcount[d.headcount.length - 1]?.value ?? 0)} delta={<span className="muted">at the end of the range</span>}>
              <SimpleBars data={d.headcount} onBarClick={(r: any) => nav(r.link)} />
            </ChartCard>
          </Boundary>
        )}
      </>}
    </AnalyticsPage>
  );
}

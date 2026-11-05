import { useNavigate } from 'react-router-dom';
import { Boundary, Card, CardHeader, Meter } from '../../components/ui';
import { ChartCard, TrendLine, SimpleBars, fmtMoney, fmtMoneyCompact } from '../../components/charts';
import { hours } from '../../lib/format';
import { AnalyticsPage, BreakdownTable, Kpis, useAnalytics } from './frame';

export default function Finance() {
  const nav = useNavigate();
  const a = useAnalytics('/api/v1/analytics/finance');
  return (
    <AnalyticsPage title="Finance analytics" sub="Revenue, payroll, margin, receivables and commissions. Margin uses approved hours × effective bill and pay rates." {...a} exportName="finance-by-client"
      exportRows={() => a.st.data ? { rows: a.st.data.byClient, cols: [{ key: 'label', label: 'Client' }, { key: 'minutes', label: 'Approved hours', value: (r: any) => (r.minutes / 60).toFixed(2) }, { key: 'revenue', label: 'Revenue (USD)', value: (r: any) => (r.revenue / 100).toFixed(2) }, { key: 'cost', label: 'Pay cost (USD)', value: (r: any) => (r.cost / 100).toFixed(2) }, { key: 'profit', label: 'Gross profit (USD)', value: (r: any) => (r.profit / 100).toFixed(2) }, { key: 'margin', label: 'Margin %' }] } : null}>
      {d => <>
        <Kpis kpis={d.kpis} />
        <div className="ins-charts mb-3">
          <Boundary label="Revenue trend">
            <ChartCard title="Revenue vs payroll vs profit" big={fmtMoney(d.series.reduce((s: number, x: any) => s + x.profit, 0))} delta={<span className="muted">gross profit on approved hours</span>}>
              {d.series.some((x: any) => x.revenue || x.profit) ? <TrendLine data={d.series} fmt={fmtMoneyCompact} series={[{ key: 'revenue', name: 'Revenue' }, ...(d.showPayroll ? [{ key: 'payroll', name: 'Payroll', color: '#A78BFA' }] : []), { key: 'profit', name: 'Gross profit', color: '#14B8A6' }]} onPointClick={(p: any) => nav(p.link)} /> : <div className="ins-empty-chart">No financial activity in range</div>}
            </ChartCard>
          </Boundary>
          <Boundary label="AR aging">
            <ChartCard title="Accounts receivable aging" big={fmtMoney(d.arTotal)} delta={<span className="muted">outstanding today</span>}>
              <SimpleBars data={d.ar} fmt={fmtMoney} onBarClick={(r: any) => nav(r.link)} />
            </ChartCard>
          </Boundary>
        </div>
        <Card className="mb-3">
          <CardHeader title="Margin by client" sub="Click a client to open it" />
          <BreakdownTable rows={d.byClient} onRow={r => nav(r.link)} cols={[
            { key: 'label', label: 'Client' }, { key: 'minutes', label: 'Approved hours', align: 'right', render: r => hours(r.minutes, 1) },
            { key: 'revenue', label: 'Revenue', format: 'money' }, { key: 'cost', label: 'Pay cost', format: 'money' }, { key: 'profit', label: 'Gross profit', format: 'money' },
            { key: 'margin', label: 'Margin', align: 'right', render: r => <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}><span style={{ width: 70 }}><Meter value={r.margin ?? 0} /></span>{r.margin === null ? '—' : `${r.margin.toFixed(1)}%`}</div> },
          ]} />
        </Card>
        <div className="ins-charts">
          {d.byWorker && <Card>
            <CardHeader title="Margin by worker" sub="Top 15 by revenue" />
            <BreakdownTable rows={d.byWorker} onRow={r => nav(r.link)} cols={[
              { key: 'label', label: 'Worker', render: r => <div><div className="bold">{r.label}</div><div className="small muted">{r.sub}</div></div> },
              { key: 'revenue', label: 'Revenue', format: 'money' }, { key: 'profit', label: 'Profit', format: 'money' }, { key: 'margin', label: 'Margin', format: 'pct' },
            ]} />
          </Card>}
          {d.commissions && <Card>
            <CardHeader title="Commissions by person" sub="Entitlements overlapping the range" />
            <BreakdownTable rows={d.commissions} onRow={r => nav(r.link)} empty="No commission entitlements in this range" cols={[
              { key: 'label', label: 'Person' }, { key: 'entitlements', label: 'Items', format: 'num' }, { key: 'calculated', label: 'Calculated', format: 'money' },
              { key: 'approved', label: 'Approved', format: 'money' }, { key: 'settled', label: 'Settled', format: 'money' },
            ]} />
          </Card>}
        </div>
      </>}
    </AnalyticsPage>
  );
}

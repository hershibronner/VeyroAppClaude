import { useNavigate } from 'react-router-dom';
import { Boundary, Card, CardHeader, Meter } from '../../components/ui';
import { ChartCard, TrendLine, TrackBars, fmtHours, fmtNum } from '../../components/charts';
import { hours } from '../../lib/format';
import { AnalyticsPage, BreakdownTable, Kpis, useAnalytics } from './frame';

export default function Workforce() {
  const nav = useNavigate();
  const a = useAnalytics('/api/v1/analytics/workforce', 91);
  return (
    <AnalyticsPage title="Workforce analytics" sub="Attendance, tracked vs approved hours, utilization against schedule, and turnover." {...a} exportName="workforce-utilization"
      exportRows={() => a.st.data ? { rows: a.st.data.utilization, cols: [{ key: 'label', label: 'Client' }, { key: 'placements', label: 'Placements' }, { key: 'scheduled', label: 'Scheduled hours', value: (r: any) => (r.scheduled / 60).toFixed(1) }, { key: 'tracked', label: 'Tracked hours', value: (r: any) => (r.tracked / 60).toFixed(1) }, { key: 'value', label: 'Utilization %' }] } : null}>
      {d => <>
        <Kpis kpis={d.kpis} />
        <div className="ins-charts mb-3">
          <Boundary label="Hours">
            <ChartCard title="Tracked vs approved hours" big={fmtHours(d.series.reduce((s: number, x: any) => s + x.tracked, 0))} delta={<span className="muted">tracked by {d.unit}</span>}>
              <TrendLine data={d.series} fmt={fmtHours} series={[{ key: 'tracked', name: 'Tracked' }, { key: 'approved', name: 'Approved', color: '#14B8A6' }]} onPointClick={(p: any) => nav(`/time/timesheets?from=${p.from}&to=${p.to}`)} />
            </ChartCard>
          </Boundary>
          <Boundary label="Attendance">
            <ChartCard title="Late arrivals & absences" big={fmtNum(d.series.reduce((s: number, x: any) => s + x.late + x.absent, 0))} delta={<span className="ins-legend"><span><i style={{ background: 'var(--primary)' }} />Late</span><span><i style={{ background: '#DCE3FF' }} />Absent</span></span>}>
              <TrackBars data={d.series.map((x: any) => ({ ...x, value: x.late }))} stackKey="absent" stackName="Absent" valueName="Late" fmt={fmtNum} onBarClick={(r: any) => nav(r.link)} />
            </ChartCard>
          </Boundary>
        </div>
        <Card className="mb-3">
          <CardHeader title="Utilization by client" sub="Tracked hours ÷ scheduled hours (weekly hours prorated over days live in range)" />
          <BreakdownTable rows={d.utilization} onRow={r => nav(r.link)} cols={[
            { key: 'label', label: 'Client' }, { key: 'placements', label: 'Placements', format: 'num' },
            { key: 'scheduled', label: 'Scheduled', align: 'right', render: r => hours(r.scheduled, 0) }, { key: 'tracked', label: 'Tracked', align: 'right', render: r => hours(r.tracked, 0) },
            { key: 'value', label: 'Utilization', align: 'right', render: r => <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}><span style={{ width: 80 }}><Meter value={Math.min(100, r.value)} /></span>{r.value.toFixed(1)}%</div> },
          ]} />
        </Card>
        <div className="ins-charts">
          <Card>
            <CardHeader title="Most late / absent workers" />
            <BreakdownTable rows={d.lateWorkers} onRow={r => nav(r.link)} empty="No late arrivals or absences in range" cols={[{ key: 'name', label: 'Worker' }, { key: 'late', label: 'Late', format: 'num' }, { key: 'avg_late', label: 'Avg minutes late', format: 'num' }, { key: 'absent', label: 'Absent', format: 'num' }]} />
          </Card>
          <Card>
            <CardHeader title="Turnover" sub={`${d.turnover.ended} ended · ${d.turnover.started} started · avg headcount ${d.turnover.avgHeadcount.toFixed(1)}`} />
            <BreakdownTable rows={d.turnover.reasons.map((r: any) => ({ ...r, link: `/workforce/placements?status=ended&from=${d.range.from}&to=${d.range.to}` }))} onRow={r => nav(r.link)} empty="No placements ended in this range" cols={[{ key: 'label', label: 'End reason' }, { key: 'value', label: 'Placements', format: 'num' }]} />
          </Card>
        </div>
      </>}
    </AnalyticsPage>
  );
}

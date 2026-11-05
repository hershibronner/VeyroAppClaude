import type { ReactNode } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell, ReferenceLine, Legend, AreaChart, Area } from 'recharts';
import { ThumbsUp } from 'lucide-react';
import { money } from '../lib/format';

const BLUE = 'var(--primary)';
const TRACK = '#E9EDFE';
const AXIS = { fontSize: 12, fill: '#8B92A0' };

export type Fmt = (v: number) => string;
export const fmtMoney: Fmt = v => money(v, 'USD', { noCents: true });
export const fmtMoneyCompact: Fmt = v => money(v, 'USD', { compact: true });
export const fmtNum: Fmt = v => v.toLocaleString('en-US');
export const fmtHours: Fmt = v => `${(v / 60).toFixed(0)}h`;

/** API values may arrive as numeric strings; charts need numbers. */
function toNumbers(rows: any[], keys: string[]) {
  return (rows ?? []).map(r => { const o = { ...r }; for (const k of keys) if (o[k] !== null && o[k] !== undefined) o[k] = Number(o[k]); return o; });
}

function DarkTip({ active, payload, label, fmt, prevKey }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const prev = prevKey ? p.payload[prevKey] : null;
  const d = prev ? ((p.value - prev) / Math.abs(prev)) * 100 : null;
  return (
    <div className="chart-tip" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {payload.length === 1 && <span style={{ width: 30, height: 30, borderRadius: '50%', background: '#232a3b', display: 'grid', placeItems: 'center' }}><ThumbsUp size={14} /></span>}
      <div>
        {payload.length === 1 ? <div className="v">{fmt(p.value)}</div> : payload.map((x: any) => <div key={x.dataKey} style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}><span style={{ color: x.color === BLUE ? '#9db0ff' : x.color }}>{x.name}</span><b>{fmt(x.value)}</b></div>)}
        {d !== null && <div style={{ fontSize: 12.5 }}><span style={{ color: d >= 0 ? '#4ADE80' : '#F87171' }}>{d >= 0 ? '+' : ''}{d.toFixed(1)}%</span> from previous</div>}
        {payload.length === 1 && d === null && <div style={{ fontSize: 12, color: '#9CA3AF' }}>{label}</div>}
      </div>
    </div>
  );
}

/** Line chart with dots and a dark tooltip pill (Humaine style). data: [{label, value, prev?}] */
export function TrendLine({ data: raw, fmt = fmtMoney, height = 260, onPointClick, series }: { data: any[]; fmt?: Fmt; height?: number; onPointClick?: (d: any) => void; series?: { key: string; name: string; color?: string }[] }) {
  const keys = series ? series.map(s => s.key) : ['value'];
  const data = toNumbers(raw, keys);
  const withPrev = data.map((d, i) => ({ ...d, prev: i > 0 ? data[i - 1].value : null }));
  const vals = data.flatMap(d => keys.map(k => d[k])).filter((v): v is number => Number.isFinite(v));
  const lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
  const pad = (hi - lo) * 0.6 || Math.abs(hi) * 0.2 || 1;
  const domain: [number, number] = [Math.max(lo >= 0 ? 0 : -Infinity, lo - pad), hi + pad];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={withPrev} margin={{ top: 20, right: 12, left: 12, bottom: 0 }} onClick={(e: any) => e?.activePayload && onPointClick?.(e.activePayload[0].payload)} style={{ cursor: onPointClick ? 'pointer' : undefined }}>
        <CartesianGrid vertical horizontal={false} strokeDasharray="3 4" stroke="#EEF0F3" />
        <XAxis dataKey="label" axisLine={{ stroke: '#E5E7EB' }} tickLine={false} tick={AXIS} dy={10} />
        <YAxis hide domain={domain} />
        <Tooltip content={<DarkTip fmt={fmt} prevKey={series ? undefined : 'prev'} />} cursor={{ stroke: '#C7D2FE', strokeWidth: 44, strokeOpacity: 0.25 }} />
        {series ? series.map((s, i) => <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color ?? (i === 0 ? BLUE : '#A78BFA')} strokeWidth={2} dot={{ r: 4, fill: s.color ?? (i === 0 ? BLUE : '#A78BFA'), stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 6 }} />)
          : <Line type="linear" dataKey="value" stroke={BLUE} strokeWidth={2} dot={{ r: 4, fill: BLUE, stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 6, fill: BLUE, stroke: '#fff', strokeWidth: 2 }} />}
        {series && <Legend verticalAlign="top" height={28} iconType="circle" wrapperStyle={{ fontSize: 13 }} />}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Rounded vertical bars with a light "track" behind each. data: [{label, value, value2?}] */
export function TrackBars({ data: raw, fmt = fmtMoney, height = 280, onBarClick, stackKey, stackName, valueName = 'Value', highlight }: { data: any[]; fmt?: Fmt; height?: number; onBarClick?: (d: any) => void; stackKey?: string; stackName?: string; valueName?: string; highlight?: string }) {
  const data = toNumbers(raw, stackKey ? ['value', stackKey] : ['value']);
  const max = Math.max(1, ...data.map(d => (d.value ?? 0) + (stackKey ? d[stackKey] ?? 0 : 0)));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 10, right: 6, left: 6, bottom: 0 }} barCategoryGap="34%">
        <XAxis dataKey="label" axisLine={{ stroke: '#E5E7EB' }} tickLine={false} tick={{ ...AXIS, fontSize: 12.5 }} interval={0} dy={8} tickFormatter={(v: string) => { const max = data.length > 6 ? 7 : data.length > 4 ? 10 : 14; return v.length > max ? v.slice(0, max - 1).trimEnd() + '…' : v; }} />
        <YAxis hide domain={[0, max * 1.05]} />
        <Tooltip content={<DarkTip fmt={fmt} />} cursor={false} />
        <Bar dataKey="value" name={valueName} stackId={stackKey ? 's' : undefined} radius={stackKey ? [0, 0, 10, 10] : [10, 10, 10, 10]} background={stackKey ? undefined : { fill: TRACK, radius: 10 } as any} onClick={(d: any) => onBarClick?.(d.payload ?? d)} style={{ cursor: onBarClick ? 'pointer' : undefined }}>
          {data.map((d, i) => <Cell key={i} fill={highlight && d.label !== highlight ? '#A5B4FC' : BLUE} />)}
        </Bar>
        {stackKey && <Bar dataKey={stackKey} name={stackName} stackId="s" fill="#DCE3FF" radius={[10, 10, 0, 0]} onClick={(d: any) => onBarClick?.(d.payload ?? d)} />}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal funnel bars with counts and conversion %. Each step clickable. */
export function Funnel({ steps, onStepClick }: { steps: { label: string; value: number; key?: string }[]; onStepClick?: (s: { label: string; value: number; key?: string }) => void }) {
  const max = Math.max(1, ...steps.map(s => s.value));
  return (
    <div className="stack" style={{ gap: 10 }}>
      {steps.map((s, i) => (
        <button key={s.label} onClick={() => onStepClick?.(s)} style={{ all: 'unset', cursor: onStepClick ? 'pointer' : 'default', display: 'grid', gridTemplateColumns: '130px 1fr 90px', gap: 12, alignItems: 'center' }}>
          <span className="small bold">{s.label}</span>
          <span style={{ background: TRACK, borderRadius: 8, height: 26, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${(s.value / max) * 100}%`, background: BLUE, borderRadius: 8, opacity: 1 - i * 0.08, minWidth: s.value ? 6 : 0 }} /></span>
          <span className="small num right"><b>{s.value.toLocaleString()}</b>{i > 0 && steps[i - 1].value > 0 && <span className="muted"> · {Math.round((s.value / steps[i - 1].value) * 100)}%</span>}</span>
        </button>
      ))}
    </div>
  );
}

/** Grouped/simple vertical bars for counts (e.g. hours by day). */
export function SimpleBars({ data: raw, fmt = fmtNum, height = 220, color = BLUE, onBarClick }: { data: { label: string; value: number }[]; fmt?: Fmt; height?: number; color?: string; onBarClick?: (d: any) => void }) {
  const data = toNumbers(raw, ['value']);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 6, left: 6, bottom: 0 }} barCategoryGap="30%">
        <XAxis dataKey="label" axisLine={{ stroke: '#E5E7EB' }} tickLine={false} tick={{ ...AXIS, fontSize: 12 }} dy={6} />
        <YAxis hide />
        <Tooltip content={<DarkTip fmt={fmt} />} cursor={{ fill: '#F3F4F7' }} />
        <ReferenceLine y={0} stroke="#E5E7EB" />
        <Bar dataKey="value" fill={color} radius={[8, 8, 8, 8]} background={{ fill: TRACK, radius: 8 } as any} onClick={(d: any) => onBarClick?.(d.payload ?? d)} style={{ cursor: onBarClick ? 'pointer' : undefined }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Soft area chart (e.g. activity %). */
export function SoftArea({ data, fmt = fmtNum, height = 160 }: { data: { label: string; value: number }[]; fmt?: Fmt; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
        <defs><linearGradient id="soft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#345CFF" stopOpacity={0.25} /><stop offset="1" stopColor="#345CFF" stopOpacity={0} /></linearGradient></defs>
        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ ...AXIS, fontSize: 11 }} />
        <YAxis hide />
        <Tooltip content={<DarkTip fmt={fmt} />} />
        <Area dataKey="value" stroke={BLUE} strokeWidth={2} fill="url(#soft)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Chart card header: title, big number, delta, and a right-side control. */
export function ChartCard({ title, big, delta, control, children, legend }: { title: string; big?: ReactNode; delta?: ReactNode; control?: ReactNode; children: ReactNode; legend?: ReactNode }) {
  return (
    <div className="card card-pad" style={{ minWidth: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="card-title-lg">{title}</div>
        {control}
      </div>
      {big !== undefined && <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 18 }}><div><div className="chart-big">{big}</div>{delta && <div className="kpi-delta">{delta}</div>}</div>{legend}</div>}
      <div style={{ marginTop: 16 }}>{children}</div>
    </div>
  );
}

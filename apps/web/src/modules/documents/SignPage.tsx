import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, FileText, PenLine, XCircle, Download, Eraser, Clock } from 'lucide-react';
import { useApi } from '../../lib/hooks';
import { api, ApiError } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Button, Card, Dialog, EmptyState, ErrorState, Field, LoadingBlock } from '../../components/ui';
import '../home/insights.css';

/** Drawn signature (mouse, pen or touch) exported as PNG. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio; c.height = c.offsetHeight * ratio;
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0A0E16';
  }, []);
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => { e.preventDefault(); ref.current!.setPointerCapture(e.pointerId); drawing.current = true; const p = pos(e); const ctx = ref.current!.getContext('2d')!; ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const p = pos(e); const ctx = ref.current!.getContext('2d')!; ctx.lineTo(p.x, p.y); ctx.stroke(); dirty.current = true; };
  const up = () => { if (!drawing.current) return; drawing.current = false; if (dirty.current) onChange(ref.current!.toDataURL('image/png')); };
  const clear = () => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); dirty.current = false; onChange(null); };
  return (
    <div>
      <canvas ref={ref} className="ins-sigpad" aria-label="Draw your signature" role="img" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
      <div className="row mt-1" style={{ justifyContent: 'space-between' }}><span className="tiny muted">Draw with your mouse, finger or pen</span><Button size="xs" variant="ghost" icon={<Eraser size={13} />} onClick={clear}>Clear</Button></div>
    </div>
  );
}

export default function SignPage() {
  const { token } = useParams();
  const st = useApi<any>(`/api/v1/public/sign/${token}`);
  const [typed, setTyped] = useState('');
  const [sig, setSig] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [declined, setDeclined] = useState(false);
  const d = st.data;
  useEffect(() => { document.title = d ? `Sign: ${d.title}` : 'Sign document'; }, [d?.title]);
  useEffect(() => { if (d?.org?.primary_color) document.documentElement.style.setProperty('--primary', d.org.primary_color); }, [d?.org?.primary_color]);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (typed.trim().length < 2) e.typed_name = 'Type your full name';
    if (!sig) e.signature_data = 'Draw your signature';
    if (!agree) e.agree = 'You must agree to sign electronically';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try { setDone(await api.post(`/api/v1/public/sign/${token}`, { typed_name: typed.trim(), signature_data: sig, agree: true })); }
    catch (err) { if (err instanceof ApiError && err.fields) setErrors(err.fields); else setErrors({ _: (err as Error).message }); } finally { setBusy(false); }
  };
  const decline = async () => {
    try { await api.post(`/api/v1/public/sign/${token}/decline`, { reason }); setDeclineOpen(false); setDeclined(true); } catch (err) { setErrors({ reason: err instanceof ApiError && err.fields?.reason ? err.fields.reason : (err as Error).message }); }
  };
  const shell = (children: React.ReactNode) => (
    <div className="ins-public">
      <div className="ins-public-inner">
        <div className="row mb-3" style={{ gap: 10 }}><span className="ws-logo" style={{ width: 34, height: 34, borderRadius: 10, background: d?.org?.primary_color ?? 'var(--primary)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{(d?.org?.logo_text ?? d?.org?.name ?? 'V').slice(0, 1)}</span><b style={{ fontSize: 17 }}>{d?.org?.logo_text ?? d?.org?.name ?? 'VeyroApp'}</b></div>
        {children}
        {!d?.org?.hide_powered_by && <div className="tiny muted mt-3" style={{ textAlign: 'center' }}>Secure e-signature powered by VeyroApp</div>}
      </div>
    </div>
  );
  if (st.error && !d) return shell(<Card><ErrorState error={st.error} /></Card>);
  if (!d) return shell(<Card><LoadingBlock rows={8} /></Card>);
  if (done || d.status === 'signed') return shell(
    <Card pad><EmptyState icon={<CheckCircle2 size={24} style={{ color: 'var(--success)' }} />} title="Document signed" text={<>“{d.title}” was signed{d.signed_name || typed ? ` by ${d.signed_name ?? typed}` : ''} on {dateTime(done?.signed_at ?? d.signed_at)}. A signature certificate is attached to the signed PDF.</>}
      action={(done?.signed_url ?? d.signed_url) && <a className="btn btn-primary" href={done?.signed_url ?? d.signed_url}><Download size={16} /> Download signed copy</a>} /></Card>);
  if (declined || d.status === 'declined') return shell(<Card pad><EmptyState icon={<XCircle size={24} />} title="You declined to sign" text={`${d.org.name} has been notified.`} /></Card>);
  if (d.status === 'expired') return shell(<Card pad><EmptyState icon={<Clock size={24} />} title="This signing link is no longer active" text={`It expired or was cancelled. Ask ${d.org.name} to send a new one.`} /></Card>);
  return shell(<>
    <Card pad className="mb-3">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div><div className="small muted">{d.org.name} asks {d.signer_name} ({d.signer_email}) to sign</div><h1 style={{ margin: '4px 0 0', fontSize: 24, letterSpacing: '-0.02em' }}>{d.title}</h1></div>
        {d.document_url && <a className="btn btn-sm" href={d.document_url} target="_blank" rel="noreferrer"><FileText size={14} /> Open original file</a>}
      </div>
      {d.message && <div className="banner mt-2" style={{ marginBottom: 0 }}><div>{d.message}</div></div>}
      {d.expires_at && <div className="tiny muted mt-2">This link expires {dateTime(d.expires_at)}.</div>}
    </Card>
    <div className="ins-doc mb-3">{d.body}</div>
    {d.document_url && d.document_mime === 'application/pdf' && /^Please review/.test(d.body) && <iframe title="Document" src={d.document_url} className="ins-frame mb-3" />}
    <Card pad>
      <h2 style={{ margin: '0 0 14px', fontSize: 18 }}><PenLine size={17} style={{ verticalAlign: -2 }} /> Sign</h2>
      <Field label="Type your full name *" htmlFor="sg-typed" error={errors.typed_name}><input id="sg-typed" className="input" autoComplete="name" value={typed} onChange={e => setTyped(e.target.value)} placeholder={d.signer_name} /></Field>
      <Field label="Draw your signature *" error={errors.signature_data}><SignaturePad onChange={setSig} /></Field>
      <label className="check mt-2"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I agree that my typed name and drawn signature are my legal electronic signature for this document.</label>
      {errors.agree && <div className="err">{errors.agree}</div>}
      {errors._ && <div className="errorbox mt-2"><div>{errors._}</div></div>}
      <div className="row mt-3" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <Button variant="ghost" onClick={() => setDeclineOpen(true)}>Decline to sign</Button>
        <Button variant="primary" icon={<PenLine size={16} />} loading={busy} onClick={submit}>Sign document</Button>
      </div>
      <div className="tiny muted mt-2">We record the date, time, IP address and browser with your signature.</div>
    </Card>
    <Dialog open={declineOpen} onClose={() => setDeclineOpen(false)} title="Decline to sign" footer={<><Button onClick={() => setDeclineOpen(false)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={decline}>Decline</Button></>}>
      <Field label="Tell the sender why *" htmlFor="sg-reason" error={errors.reason}><textarea id="sg-reason" className="textarea" value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Dialog>
  </>);
}

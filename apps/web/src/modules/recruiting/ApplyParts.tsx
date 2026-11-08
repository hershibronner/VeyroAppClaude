// Pieces of the public application reused by the one-question-per-screen flow: in-browser intro video capture
// (MediaRecorder with upload fallback) and the post-submit confirmation with optional portal account creation.
import { useEffect, useRef, useState } from 'react';
import { Upload, Video, Square, Circle, RotateCcw, CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Banner, Button } from '../../components/ui';
import './recruiting.css';

/** In-browser recording with MediaRecorder, with an upload fallback. */
export function VideoCapture({ video, onUploaded, upload }: { video: { upload: string; filename: string; url?: string } | null; onUploaded: (v: { upload: string; filename: string; url?: string } | null) => void; upload: (b: Blob, name: string) => Promise<any> }) {
  const live = useRef<HTMLVideoElement>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [state, setState] = useState<'idle' | 'preview' | 'recording' | 'uploading'>('idle');
  const [secs, setSecs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => () => { stream.current?.getTracks().forEach(t => t.stop()); }, []);
  useEffect(() => { if (state !== 'recording') return; const t = setInterval(() => setSecs(s => { if (s + 1 >= 120) rec.current?.stop(); return s + 1; }), 1000); return () => clearInterval(t); }, [state]);
  const start = async () => {
    setErr(null);
    try { stream.current = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true }); if (live.current) { live.current.srcObject = stream.current; live.current.muted = true; await live.current.play().catch(() => {}); } setState('preview'); }
    catch { setErr('We could not access your camera or microphone. Allow access in your browser, or upload a video file instead.'); }
  };
  const record = () => {
    if (!stream.current) return;
    chunks.current = [];
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) ?? '';
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      stream.current?.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks.current, { type: r.mimeType || 'video/webm' });
      setState('uploading');
      try { const res = await upload(blob, `intro-video.${(r.mimeType || '').includes('mp4') ? 'mp4' : 'webm'}`); onUploaded({ upload: res.upload, filename: res.filename, url: URL.createObjectURL(blob) }); setState('idle'); }
      catch (e) { setErr(e instanceof ApiError ? e.message : 'Upload failed — try again'); setState('idle'); }
    };
    rec.current = r; r.start(1000); setSecs(0); setState('recording');
  };
  const onFile = async (f: File) => { setState('uploading'); setErr(null); try { const res = await upload(f, f.name); onUploaded({ upload: res.upload, filename: res.filename, url: URL.createObjectURL(f) }); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Upload failed'); } finally { setState('idle'); } };
  if (video && state === 'idle') return <div className="stack" style={{ gap: 8 }}>{video.url && <video className="rec-video" src={video.url} controls style={{ maxWidth: 420 }} />}<div className="row" style={{ gap: 8 }}><CheckCircle2 size={18} color="var(--success)" /> Intro video added <Button size="xs" icon={<RotateCcw size={13} />} onClick={() => onUploaded(null)}>Redo</Button></div></div>;
  return <div className="stack" style={{ gap: 10 }}>
    {err && <Banner tone="warn">{err}</Banner>}
    <video ref={live} className="rec-video" style={{ display: state === 'preview' || state === 'recording' ? 'block' : 'none', maxWidth: 420 }} playsInline aria-label="Camera preview" />
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {supported && state === 'idle' && <Button icon={<Video size={16} />} onClick={start}>Record in browser</Button>}
      {state === 'preview' && <Button variant="danger" icon={<Circle size={16} />} onClick={record}>Start recording</Button>}
      {state === 'recording' && <><span className="rec-rec">Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span><Button icon={<Square size={16} />} onClick={() => rec.current?.stop()}>Stop</Button></>}
      {state === 'uploading' && <span className="small"><span className="spinner" /> Uploading video…</span>}
      {state === 'idle' && <label className="btn"><Upload size={16} /> Upload a video file<input type="file" hidden accept="video/*" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} /></label>}
    </div>
    <div className="small muted">Say hello, share your experience and why you'd be great for remote work. Max 2 minutes.</div>
  </div>;
}

/** `compact`: used inside the animated flow's finish screen, which already shows its own check mark and heading. */
export function Confirmation({ done, org, slug, onAccount, compact }: { done: any; org: any; slug: string; onAccount: (redirect: string) => void; compact?: boolean }) {
  const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const create = async (withPassword: boolean) => {
    setBusy(true); setErr(null);
    try { const r = await api.post(`/api/v1/public/apply/${slug}/account`, { applicant_token: done.applicant_token, password: withPassword ? pw : undefined }); if (r.mode === 'created') onAccount(r.redirect); else setMsg(r.message); }
    catch (e) { setErr(e instanceof ApiError ? (e.fields?.password ?? e.message) : String(e)); } finally { setBusy(false); }
  };
  return <div className="card card-pad" style={{ textAlign: compact ? 'left' : 'center' }}>
    {!compact && <CheckCircle2 size={44} color="var(--success)" />}
    {!compact && <h2>Thanks, {done.first_name}! Your application is in.</h2>}
    <div className="muted">{done.position_title ? `We received your application for ${done.position_title}.` : `You're now in the ${org.name} talent pool.`} {done.returning ? 'We found your existing profile and added this application to it.' : ''} A recruiter will review it shortly — check your email for a confirmation.</div>
    {!done.has_account && <div className="card card-pad mt-3" style={{ textAlign: 'left', background: 'var(--bg-2)' }}>
      <b>Create an account to track your application</b> <span className="small muted">(optional)</span>
      <div className="small muted mt-1">See your status, complete assessments, join interviews and sign offers.</div>
      {msg ? <Banner tone="success">{msg}</Banner> : done.email_has_login ? <div className="mt-2"><div className="small">This email already has a VeyroApp login.</div><Button className="mt-1" loading={busy} onClick={() => create(false)}>Email me an access link</Button></div> :
        <form className="row mt-2" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); create(true); }}><input className="input" type="password" autoComplete="new-password" aria-label="Choose a password" placeholder="Choose a password (8+ characters)" value={pw} onChange={e => setPw(e.target.value)} style={{ flex: 1, minWidth: 220 }} /><Button type="submit" variant="primary" loading={busy} disabled={pw.length < 8}>Create account</Button></form>}
      {err && <div className="small mt-1" style={{ color: 'var(--danger)' }}>{err}</div>}
    </div>}
    {done.has_account && <div className="mt-3"><a className="btn btn-primary" href="/login?next=/portal/candidate/applications">Sign in to track it</a></div>}
  </div>;
}

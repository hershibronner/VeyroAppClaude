import { Copy, ExternalLink, Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { Button } from './ui';

/** A shareable URL with copy / open / QR — used by the Generate link dialogs. */
export function ShareLinkBox({ url, label }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); toast.success('Link copied'); setTimeout(() => setCopied(false), 1800); } catch { toast.error('Could not copy — select the link and copy it manually'); } };
  return (
    <div className="row" style={{ alignItems: 'center', flexWrap: 'nowrap', gap: 14 }}>
      <img src={`/api/v1/qr?text=${encodeURIComponent(url)}`} alt={`QR code for ${label ?? 'the link'}`} width={92} height={92} style={{ borderRadius: 10, border: '1px solid var(--border)', flex: 'none', background: '#fff' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {label && <div className="small bold mb-2">{label}</div>}
        <input className="input" readOnly value={url} onFocus={e => e.currentTarget.select()} aria-label="Shareable link" />
        <div className="row mt-2" style={{ gap: 8 }}>
          <Button size="sm" variant="primary" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
          <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Preview</a>
        </div>
      </div>
    </div>
  );
}

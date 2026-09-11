import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import { apiCreateHandoff, apiPlatformSession } from '../platform-api.js';
import '../platform.css';

function detectChannel() {
  const params = new URLSearchParams(location.search);
  const explicit = params.get('channel');
  if (explicit) return explicit.toLowerCase();
  const ref = document.referrer || '';
  if (/tindie\.com/i.test(ref)) return 'tindie';
  if (/eetree\.cn/i.test(ref)) return 'eetree';
  if (/eehub\.io/i.test(ref)) return 'eehub';
  if (/ezplm\.cn/i.test(ref)) return 'ezplm';
  return 'direct';
}

function detectLocale(channel) {
  const params = new URLSearchParams(location.search);
  const explicit = params.get('lang') || params.get('locale');
  if (explicit) return /^zh/i.test(explicit) ? 'zh-CN' : 'en-US';
  if (channel === 'eetree' || channel === 'ezplm') return 'zh-CN';
  if (channel === 'tindie' || channel === 'eehub') return 'en-US';
  return /^zh/i.test(navigator.language || '') ? 'zh-CN' : 'en-US';
}

function currentMode() {
  return (new URLSearchParams(location.search).get('mode') || 'library').toLowerCase() === 'schematic' ? 'schematic' : 'library';
}
function modeHref(mode) {
  const p = new URLSearchParams(location.search); p.set('mode', mode); return `${location.pathname}?${p.toString()}`;
}

async function imageFileToPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await PDFDocument.create();
  let image;
  if (/png/i.test(file.type) || /\.png$/i.test(file.name)) image = await pdf.embedPng(buf);
  else image = await pdf.embedJpg(buf);

  const portrait = image.height >= image.width;
  const pageSize = portrait ? [595.28, 841.89] : [841.89, 595.28];
  const [pw, ph] = pageSize;
  const margin = 18;
  const scale = Math.min((pw - margin * 2) / image.width, (ph - margin * 2) / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const page = pdf.addPage(pageSize);
  page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  const bytes = await pdf.save({ useObjectStreams: true });
  const base = file.name.replace(/\.[^.]+$/, '') || 'schematic';
  return new File([bytes], `${base}.pdf`, { type: 'application/pdf' });
}

function feedExistingUploader(file) {
  const input = document.querySelector('.upload-row input[type="file"]');
  if (!input) throw new Error('DS2KiCad 上传控件尚未加载，请稍后重试');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const copy = {
  'zh-CN': {
    guest: '免费体验', registered: '会员', direct: '直接访问',
    upload: '上传 PDF / 图片', used: '可用', unit: 'Credits',
    signup: '注册并保存到 ezPLM', account: '进入 ezPLM',
    exhausted: '免费体验已用完，注册后可保存个人库并继续生成。',
    converting: '正在把图片转换为 PDF…',
    badType: '目前支持 PDF、PNG、JPG/JPEG 图片。',
    tooLarge: '文件转换后超过 3MB，请压缩图片或改用 PDF URL。',
    library: '元器件库生成', schematic: '原理图转换'
  },
  'en-US': {
    guest: 'Free trial', registered: 'Member', direct: 'Direct',
    upload: 'Upload PDF / image', used: 'Available', unit: 'Credits',
    signup: 'Sign up & save to eeHub', account: 'Open eeHub',
    exhausted: 'Your free trial is used up. Sign up to save your library and keep generating.',
    converting: 'Converting image to PDF…',
    badType: 'PDF, PNG and JPG/JPEG are supported in this MVP.',
    tooLarge: 'The converted file is over 3MB. Compress the image or use a PDF URL.',
    library: 'Library generator', schematic: 'Schematic converter'
  }
};

export default function PlatformShell({ children }) {
  const channel = useMemo(detectChannel, []);
  const locale = useMemo(() => detectLocale(channel), [channel]);
  const mode = useMemo(currentMode, []);
  const t = copy[locale] || copy['en-US'];
  const [platform, setPlatform] = useState(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiPlatformSession({ channel, locale, landing: location.href, referrer: document.referrer || '' });
      setPlatform(data); setError('');
    } catch (e) { setError(e.message); }
  }, [channel, locale]);

  useEffect(() => {
    refresh();
    const onUsage = () => refresh();
    window.addEventListener('ds2k:usage-changed', onUsage);
    return () => window.removeEventListener('ds2k:usage-changed', onUsage);
  }, [refresh]);

  const openAccount = async () => {
    try {
      const r = await apiCreateHandoff({ returnTo: location.href });
      location.assign(r.url || platform?.signupUrl || '#');
    } catch (e) {
      if (platform?.signupUrl) location.assign(platform.signupUrl); else setError(e.message);
    }
  };

  const onFile = async (e) => {
    const selected = e.target.files?.[0]; e.target.value = '';
    if (!selected) return;
    setError(''); setUploading(true);
    try {
      let file = selected;
      if (selected.type === 'application/pdf' || /\.pdf$/i.test(selected.name)) {
        // pass through
      } else if (/image\/(png|jpeg)/i.test(selected.type) || /\.(png|jpe?g)$/i.test(selected.name)) {
        file = await imageFileToPdf(selected);
      } else throw new Error(t.badType);
      if (file.size > 3 * 1024 * 1024) throw new Error(t.tooLarge);
      feedExistingUploader(file);
    } catch (e2) { setError(e2.message); }
    finally { setUploading(false); }
  };

  const wallet = platform?.wallet;
  const exhausted = wallet && Number(wallet.balance) <= 0;
  const isGuest = platform?.guest !== false;
  const brand = locale === 'zh-CN' ? 'ezPLM' : 'eeHub';
  const channelLabel = channel === 'direct' ? t.direct : channel;

  return <>
    <div className={`platform-bar ${exhausted ? 'platform-bar-warn' : ''}`}>
      <div className="platform-left">
        <span className="platform-brand">AI EDA Agent</span>
        <span className="platform-channel">{channelLabel}</span>
        <nav className="platform-mode-switch" aria-label="Agent mode">
          <a className={mode === 'library' ? 'active' : ''} href={modeHref('library')}>{t.library}</a>
          <a className={mode === 'schematic' ? 'active' : ''} href={modeHref('schematic')}>{t.schematic}</a>
        </nav>
        {platform && <span className="platform-credit">{isGuest ? t.guest : t.registered} · {t.used} <b>{wallet?.balance ?? '—'}</b> {t.unit}</span>}
      </div>
      <div className="platform-actions">
        <button className="platform-upload" onClick={() => inputRef.current?.click()} disabled={!platform || uploading}>{uploading ? t.converting : t.upload}</button>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf,image/png,image/jpeg,.png,.jpg,.jpeg" hidden onChange={onFile} />
        <button className="platform-account" onClick={openAccount} disabled={!platform}>{isGuest ? t.signup : `${t.account} · ${brand}`}</button>
      </div>
    </div>
    {exhausted && <div className="platform-exhausted">{t.exhausted}</div>}
    {error && <div className="platform-error">{error}</div>}
    {children}
  </>;
}

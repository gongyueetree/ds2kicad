import { useEffect, useState } from 'react';

export default function PreviewAccess({ children }) {
  const [state,setState] = useState(null), [code,setCode] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  useEffect(() => {
    fetch('/api/preview-access').then(r => r.json()).then(setState).catch(() => setState({enabled:false}));
  }, []);
  const login = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await fetch('/api/preview-access', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.trim()})});
      const data = await r.json(); if (!r.ok) throw new Error(data.error || '登录失败');
      sessionStorage.removeItem('ds2k_guest_token'); setCode(''); setState({...state,authenticated:true});
    } catch(e) { setError(e.message); } finally { setBusy(false); }
  };
  if (!state) return <p style={{padding:24}}>正在加载…</p>;
  if (!state.enabled) return children;
  const banner = <div style={{padding:'12px 20px',background:'#eaf2ff',color:'#193e77',lineHeight:1.6}}>DS2KiCad v1.3 测试环境 · 文件保存在数据库，无需 S3 · 测试文件空间 250MB · 发布结果仅用于验收</div>;
  if (state.authenticated) return <>{banner}{children}</>;
  return <>{banner}<form onSubmit={login} style={{maxWidth:460,margin:'60px auto',padding:24}}>
    <h1>开始测试 DS2KiCad</h1><p>输入测试访问码，即可体验提取、人工审核、发布及下载。</p>
    <label htmlFor="preview-code">测试访问码</label><input id="preview-code" type="password" autoComplete="current-password" value={code} onChange={e=>setCode(e.target.value)} required style={{display:'block',width:'100%',boxSizing:'border-box',margin:'12px 0',padding:12}} />
    <button disabled={busy}>{busy?'正在登录…':'进入测试'}</button>{error&&<p role="alert">{error}</p>}
  </form></>;
}

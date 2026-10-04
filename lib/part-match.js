// A conservative guard against attaching another component's facts to a typed MPN.
export function checkRequestedPart({ requested, detected, pages = [] }) {
  if (!requested || !detected || detected === 'UNKNOWN' || !pages.length) return null;
  const normalize = s => String(s).toUpperCase().replace(/[\s\u00ad]/g, '');
  const wanted = normalize(requested), found = normalize(detected);
  if (!/[A-Z]/.test(found) || !/\d/.test(found)) return null;
  const tokens = pages.flatMap(p => (p.lines || []).flatMap(l => String(l.text).toUpperCase().match(/[A-Z0-9][A-Z0-9_+./-]*/g) || []));
  // Require positive document evidence for the detected base; a filename alone is insufficient.
  if (!tokens.some(t => normalize(t) === found)) return null;
  if (wanted === found || tokens.some(t => normalize(t) === wanted)) return null;
  // Ordering suffixes are checked later against the package's orderableParts.
  if (wanted.startsWith(found) && /^[A-Z/-]/.test(wanted.slice(found.length))) return null;
  return { code:'mpn_document_mismatch', detectedMpn:detected, requestedMpn:requested,
    error:`目标型号 ${requested} 与手册中的 ${detected} 不匹配。请更换对应的 PDF，或清空目标型号后按手册提取。` };
}

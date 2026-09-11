// Rebuild KiCad files from user-edited Connectivity IR. No AI call and no Credit charge.
import { setCors } from './extract.js';
import { authenticate } from '../lib/auth.js';
import { sanitizeSchematicIR, summarizeSchematicIR } from '../lib/schematic/ir.js';
import { buildSchematicFiles } from '../lib/schematic/kicad.js';
import { applyConnectivityQuality, qualitySummary } from '../lib/connectivity/quality.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error });
  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  if (!body?.ir || typeof body.ir !== 'object') return res.status(422).json({ error: 'missing ir' });
  try {
    const census = body.ir?.source?.census || null;
    const base = sanitizeSchematicIR(body.ir, body.ir.source || {});
    const ir = applyConnectivityQuality(base, census);
    const generated = buildSchematicFiles(ir);
    const exportAllowed = ir.qualityGate?.exportAllowed !== false;
    return res.status(200).json({
      ok: true,
      ir,
      summary: { ...summarizeSchematicIR(ir), ...qualitySummary(ir) },
      files: exportAllowed ? generated.files : generated.files.filter((x)=>/\.json$/i.test(x.path)),
      previewSvg: exportAllowed ? generated.previewSvg : null,
      report: { ...generated.report, exportBlocked:!exportAllowed, qualityGate:ir.qualityGate }
    });
  } catch (e) {
    return res.status(422).json({ error: e.message || 'schematic rebuild failed' });
  }
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

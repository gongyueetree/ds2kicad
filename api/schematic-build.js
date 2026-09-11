// Rebuild KiCad files from user-edited Schematic IR. No AI call and no Credit charge.
import { setCors } from './extract.js';
import { authenticate } from '../lib/auth.js';
import { sanitizeSchematicIR, summarizeSchematicIR } from '../lib/schematic/ir.js';
import { buildSchematicFiles } from '../lib/schematic/kicad.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = authenticate(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ error: auth.error });
  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  if (!body?.ir || typeof body.ir !== 'object') return res.status(422).json({ error: 'missing ir' });
  try {
    const ir = sanitizeSchematicIR(body.ir, body.ir.source || {});
    const generated = buildSchematicFiles(ir);
    return res.status(200).json({
      ok: true, ir, summary: summarizeSchematicIR(ir),
      files: generated.files, previewSvg: generated.previewSvg, report: generated.report
    });
  } catch (e) {
    return res.status(422).json({ error: e.message || 'schematic rebuild failed' });
  }
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

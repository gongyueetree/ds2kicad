// src/components/PackageForm.jsx — 封装参数确认表单（确定性封装引擎的输入）
import { PACKAGE_TYPES } from '../../lib/validate.js';

const FAMILY_LABEL = { dual: '双列贴片（SOIC/TSSOP/MSOP…）', qfn: 'QFN/DFN（含 EP）', dip: 'DIP 通孔', sot23: 'SOT-23（3 脚）', bga: 'BGA/DSBGA（暂仅符号）' };

const FIELDS = [
  ['pinCount', '引脚数', ''],
  ['pitch', '间距 Pitch', 'mm'],
  ['bodyLength', '本体长（沿引脚排布）', 'mm'],
  ['bodyWidth', '本体宽', 'mm'],
  ['height', '高度', 'mm'],
  ['leadSpan', '引脚外沿跨距 Lead Span', 'mm'],
  ['leadLength', '引脚/焊端长', 'mm'],
  ['leadWidth', '引脚宽（0=自动）', 'mm'],
  ['epLength', 'EP 长（QFN，空=无）', 'mm'],
  ['epWidth', 'EP 宽（QFN，空=无）', 'mm'],
  ['rowSpan', '孔距（DIP）', 'mm']
];

export default function PackageForm({ packages, selectedIndex, pkg, pinsets = [], onSelect, onChange }) {
  const upd = (key, raw) => {
    const value = raw === '' ? null : Number(raw);
    onChange({ ...pkg, [key]: Number.isFinite(value) ? value : (raw === '' ? null : pkg[key]) });
  };
  return (
    <div className="pkg-form">
      {packages.length > 1 && (
        <label className="pkg-select">
          数据手册中的封装候选：
          <select value={selectedIndex} onChange={(e) => onSelect(Number(e.target.value))}>
            {packages.map((p, i) => (
              <option key={i} value={i}>{p.include === false ? '✗ ' : '✓ '}{p.name}{p.tiCode ? `（${p.tiCode}）` : ''} · {p.pinCount} 脚</option>
            ))}
          </select>
        </label>
      )}
      <label className="pkg-include">
        <input
          type="checkbox"
          checked={pkg.include !== false}
          onChange={(e) => onChange({ ...pkg, include: e.target.checked })}
        />
        将此封装包含在生成中（每个勾选的封装各生成一套 .kicad_mod + .wrl）
      </label>
      {pinsets.length > 1 && (
        <label className="pkg-select">
          管脚定义集（pinset）：
          <select value={pkg.pinsetId} onChange={(e) => onChange({ ...pkg, pinsetId: e.target.value })}>
            {pinsets.map((s) => (
              <option key={s.id} value={s.id}>{s.id}{s.label ? ` — ${s.label}` : ''} · {s.pins.length} 脚</option>
            ))}
          </select>
          <span className="hint" style={{ marginLeft: 8 }}>管脚编号不同的封装（如 DSBGA）会生成独立符号变体</span>
        </label>
      )}
      <label className="pkg-select">
        封装家族（决定焊盘算法）：
        <select value={pkg.family} onChange={(e) => onChange({ ...pkg, family: e.target.value })}>
          {PACKAGE_TYPES.map((f) => <option key={f} value={f}>{FAMILY_LABEL[f]}</option>)}
        </select>
      </label>
      <div className="pkg-grid">
        <label>封装名称<input value={pkg.name} onChange={(e) => onChange({ ...pkg, name: e.target.value })} /></label>
        {FIELDS.map(([key, label, unit]) => (
          <label key={key}>
            {label}{unit && <span className="unit">{unit}</span>}
            <input
              type="number" step="0.01"
              value={pkg[key] ?? ''}
              onChange={(e) => upd(key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <p className="hint">封装/3D 由上述参数经确定性规则引擎生成（非 AI 绘制）；投产前请对照数据手册末尾机械图核对公称尺寸。</p>
    </div>
  );
}

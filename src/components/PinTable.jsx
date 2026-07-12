// src/components/PinTable.jsx — 管脚确认表（可编辑：编号/名称/属性/功能描述）
import { PIN_TYPES } from '../../lib/validate.js';

const TYPE_LABEL = {
  input: '输入 Input', output: '输出 Output', bidirectional: '双向 Bidir',
  power_in: '电源输入 PwrIn', power_out: '电源输出 PwrOut', passive: '无源 Passive',
  tri_state: '三态 TriState', open_collector: '开集 OC',
  no_connect: '悬空 NC', unspecified: '未指定'
};

export default function PinTable({ pins, onChange }) {
  const update = (i, key, value) => {
    const next = pins.slice();
    next[i] = { ...next[i], [key]: value };
    onChange(next);
  };
  const remove = (i) => onChange(pins.filter((_, j) => j !== i));
  const add = () => onChange([...pins, { number: String(pins.length + 1), name: '', type: 'passive', description: '' }]);

  return (
    <div className="pin-table-wrap">
      <table className="pin-table">
        <thead>
          <tr><th style={{ width: 64 }}>编号</th><th style={{ width: 130 }}>名称</th><th style={{ width: 170 }}>电气属性</th><th>功能描述</th><th style={{ width: 44 }} /></tr>
        </thead>
        <tbody>
          {pins.map((p, i) => (
            <tr key={i}>
              <td><input value={p.number} onChange={(e) => update(i, 'number', e.target.value)} /></td>
              <td><input value={p.name} onChange={(e) => update(i, 'name', e.target.value)} /></td>
              <td>
                <select value={p.type} onChange={(e) => update(i, 'type', e.target.value)}>
                  {PIN_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
                </select>
              </td>
              <td><input value={p.description} onChange={(e) => update(i, 'description', e.target.value)} /></td>
              <td><button className="btn-ghost" title="删除" onClick={() => remove(i)}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn-secondary" onClick={add}>＋ 添加管脚</button>
    </div>
  );
}

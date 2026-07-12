// lib/mock/tmuxl27518.js — 演示模式样例数据
// 注意：这是【演示数据】，管脚定义参照 TI 6 通道 2:1 模拟开关家族（TS3A27518E/TMUXL27518）
// 的典型结构人工构造，仅用于打通 UI / ezPLM 集成链路，不代表真实提取结果。
// 真实使用时由 Gemini 从数据手册在线提取，前端以品红条纹徽标区分 mock 数据。

export const MOCK_TMUXL27518 = {
  mock: true,
  part: {
    mpn: 'TMUXL27518',
    manufacturer: 'Texas Instruments',
    title: '3.3-V, 2:1 (SPDT), 6-channel analog multiplexer with 1.0-V compatible control inputs',
    description_zh: '3.3V 六通道 2:1（SPDT）模拟多路复用器，控制端兼容 1.0V 逻辑，适用于 qSPI/SDIO 双主机切换。'
  },
  packages: [
    {
      name: 'WQFN-24',
      tiCode: 'RSM',
      type: 'WQFN',
      pinCount: 24,
      pitch: 0.5,
      bodyLength: 4.0,
      bodyWidth: 4.0,
      height: 0.8,
      leadSpan: 4.0,
      leadLength: 0.4,
      leadWidth: 0.25,
      epLength: 2.6,
      epWidth: 2.6,
      pinsetId: 'default'
    },
    {
      name: 'TSSOP-24',
      tiCode: 'PW',
      type: 'TSSOP',
      pinCount: 24,
      pitch: 0.65,
      bodyLength: 7.8,
      bodyWidth: 4.4,
      height: 1.1,
      leadSpan: 6.4,
      leadLength: 0.75,
      leadWidth: 0.25,
      epLength: null,
      epWidth: null,
      pinsetId: 'pw'
    }
  ],
  recommendedPackageIndex: 0,
  pins: [
    { number: '1',  name: 'NO1',  type: 'passive',  description: 'Channel 1 normally-open signal path' },
    { number: '2',  name: 'COM1', type: 'passive',  description: 'Channel 1 common signal path' },
    { number: '3',  name: 'NC1',  type: 'passive',  description: 'Channel 1 normally-closed signal path' },
    { number: '4',  name: 'NO2',  type: 'passive',  description: 'Channel 2 normally-open signal path' },
    { number: '5',  name: 'COM2', type: 'passive',  description: 'Channel 2 common signal path' },
    { number: '6',  name: 'NC2',  type: 'passive',  description: 'Channel 2 normally-closed signal path' },
    { number: '7',  name: 'NO3',  type: 'passive',  description: 'Channel 3 normally-open signal path' },
    { number: '8',  name: 'COM3', type: 'passive',  description: 'Channel 3 common signal path' },
    { number: '9',  name: 'NC3',  type: 'passive',  description: 'Channel 3 normally-closed signal path' },
    { number: '10', name: 'GND',  type: 'power_in', description: 'Ground' },
    { number: '11', name: 'IN1',  type: 'input',    description: 'Control input for channels 1–3 (1.0-V logic compatible)' },
    { number: '12', name: 'EN',   type: 'input',    description: 'Active-low enable; high = all switches off (Hi-Z)' },
    { number: '13', name: 'IN2',  type: 'input',    description: 'Control input for channels 4–6 (1.0-V logic compatible)' },
    { number: '14', name: 'VCC',  type: 'power_in', description: 'Positive supply, 1.65 V – 3.6 V; decouple 0.1 µF to GND' },
    { number: '15', name: 'NC4',  type: 'passive',  description: 'Channel 4 normally-closed signal path' },
    { number: '16', name: 'COM4', type: 'passive',  description: 'Channel 4 common signal path' },
    { number: '17', name: 'NO4',  type: 'passive',  description: 'Channel 4 normally-open signal path' },
    { number: '18', name: 'NC5',  type: 'passive',  description: 'Channel 5 normally-closed signal path' },
    { number: '19', name: 'COM5', type: 'passive',  description: 'Channel 5 common signal path' },
    { number: '20', name: 'NO5',  type: 'passive',  description: 'Channel 5 normally-open signal path' },
    { number: '21', name: 'NC6',  type: 'passive',  description: 'Channel 6 normally-closed signal path' },
    { number: '22', name: 'COM6', type: 'passive',  description: 'Channel 6 common signal path' },
    { number: '23', name: 'NO6',  type: 'passive',  description: 'Channel 6 normally-open signal path' },
    { number: '24', name: 'NC',   type: 'no_connect', description: 'No internal connection' },
    { number: '25', name: 'EP',   type: 'passive',  description: 'Exposed thermal pad; connect to GND plane' }
  ],
  get pinsets() {
    return [
      { id: 'default', label: 'RSM (WQFN)', pins: this.pins },
      { id: 'pw', label: 'PW (TSSOP)', pins: this.pins.slice(0, 24) } // TSSOP-24 无裸露焊盘
    ];
  },
  figures: [
    { kind: 'block_diagram', title: 'Functional Block Diagram', page: 1, bbox: [0.12, 0.35, 0.88, 0.82] },
    { kind: 'pin_configuration', title: 'RSM Package, 24-Pin WQFN (Top View)', page: 1, bbox: [0.30, 0.30, 0.70, 0.60] },
    { kind: 'pin_configuration', title: 'PW Package, 24-Pin TSSOP (Top View)', page: 1, bbox: [0.30, 0.55, 0.70, 0.85] },
    { kind: 'application',   title: 'Typical Application — qSPI Host Switching', page: 1, bbox: [0.10, 0.08, 0.90, 0.34] }
  ]
};

// Deterministic connectivity analysis for Connectivity Intelligence Engine.
// No model calls: derives ERC-style issues, interface groups and power rails from Connectivity IR.

const POWER_NAMES = /^(GND|AGND|DGND|PGND|VSS|VEE|VBAT|VBUS|VIN|VCC|VDD|AVDD|DVDD|\+?[0-9.]+V[0-9A-Z_+-]*)$/i;
const GROUND_NAMES = /^(GND|AGND|DGND|PGND|VSS|0V)$/i;
const CONNECTOR_REF = /^J\d+|^P\d+|^CN\d+/i;

function pinKey(ref, pin) { return `${ref}:${pin}`; }
function upper(v) { return String(v || '').toUpperCase(); }
function hasAny(text, patterns) { return patterns.some((p) => p.test(text)); }

function endpointContext(ir, ep) {
  const comp = ir.components.find((c) => c.ref === ep.ref);
  const pin = comp?.pins.find((p) => String(p.number) === String(ep.pin));
  return comp && pin ? { comp, pin } : null;
}

function issue(id, severity, code, title, detail, refs = [], nets = []) {
  return { id, severity, code, title, detail, refs: [...new Set(refs)], nets: [...new Set(nets)] };
}

function inferInterfaceType(net, contexts) {
  const names = [net.name, ...contexts.flatMap((x) => [x.pin.name, x.pin.description])].map(upper).join(' ');
  if (hasAny(names, [/\bSDA\b/, /\bSCL\b/, /I2C|I²C/])) return 'I2C';
  if (hasAny(names, [/\bMOSI\b/, /\bMISO\b/, /\bSCK\b/, /\bSCLK\b/, /\bSS\b/, /\bCSN?\b/, /SPI/])) return 'SPI';
  if (hasAny(names, [/\bTXD?\b/, /\bRXD?\b/, /UART/, /USART/])) return 'UART';
  if (hasAny(names, [/USB[_ -]?(D\+|DP|D-|DM)/, /\bD\+\b/, /\bD-\b/, /VBUS/, /CC1/, /CC2/])) return 'USB';
  if (hasAny(names, [/SWDIO/, /SWCLK/, /SWO/, /NRST/, /\bSWD\b/])) return 'SWD';
  if (hasAny(names, [/TCK/, /TMS/, /TDI/, /TDO/, /\bJTAG\b/])) return 'JTAG';
  if (POWER_NAMES.test(upper(net.name)) || contexts.some((x) => ['power_in', 'power_out'].includes(x.pin.type))) return 'POWER';
  return null;
}

function interfaceRole(type, net, contexts) {
  const text = [net.name, ...contexts.map((x) => x.pin.name)].map(upper).join(' ');
  const patterns = {
    I2C: [['SDA', /SDA/], ['SCL', /SCL/]],
    SPI: [['MOSI', /MOSI|SDI/], ['MISO', /MISO|SDO/], ['SCK', /SCK|SCLK|CLK/], ['CS', /(^|[_ -])(CS|SS|NSS)(\b|[_ -])/]],
    UART: [['TX', /(^|[_ -])TXD?(\b|[_ -])/], ['RX', /(^|[_ -])RXD?(\b|[_ -])/]],
    USB: [['D+', /D\+|(^|[_ -])DP(\b|[_ -])/], ['D-', /D-|(^|[_ -])DM(\b|[_ -])/], ['VBUS', /VBUS/], ['CC1', /CC1/], ['CC2', /CC2/]],
    SWD: [['SWDIO', /SWDIO/], ['SWCLK', /SWCLK/], ['SWO', /SWO/], ['NRST', /NRST|RESET/]],
    JTAG: [['TCK', /TCK/], ['TMS', /TMS/], ['TDI', /TDI/], ['TDO', /TDO/]]
  };
  for (const [role, re] of patterns[type] || []) if (re.test(text)) return role;
  return net.name;
}

function buildInterfaces(ir) {
  const groups = new Map();
  for (const net of ir.nets) {
    const contexts = net.endpoints.map((ep) => endpointContext(ir, ep)).filter(Boolean);
    const type = inferInterfaceType(net, contexts);
    if (!type || type === 'POWER') continue;
    const memberRefs = [...new Set(contexts.map((x) => x.comp.ref))].sort();
    const key = `${type}:${memberRefs.join(',')}`;
    if (!groups.has(key)) groups.set(key, { id: key, type, members: memberRefs, nets: [], confidence: 1 });
    const g = groups.get(key);
    g.nets.push({ name: net.name, role: interfaceRole(type, net, contexts), endpoints: net.endpoints });
    g.confidence = Math.min(g.confidence, Number(net.confidence ?? 0.7));
  }
  return [...groups.values()].map((g) => ({ ...g, complete: interfaceCompleteness(g) }));
}

function interfaceCompleteness(g) {
  const roles = new Set(g.nets.map((n) => n.role));
  const expected = {
    I2C: ['SDA', 'SCL'], SPI: ['MOSI', 'MISO', 'SCK'], UART: ['TX', 'RX'],
    USB: ['D+', 'D-'], SWD: ['SWDIO', 'SWCLK'], JTAG: ['TCK', 'TMS', 'TDI', 'TDO']
  }[g.type] || [];
  const missing = expected.filter((r) => !roles.has(r));
  return { ok: missing.length === 0, expected, missing };
}

function buildPowerRails(ir) {
  return ir.nets.flatMap((net) => {
    const contexts = net.endpoints.map((ep) => endpointContext(ir, ep)).filter(Boolean);
    const isPower = POWER_NAMES.test(upper(net.name)) || contexts.some((x) => ['power_in', 'power_out'].includes(x.pin.type));
    if (!isPower) return [];
    return [{
      id: `rail:${net.id || net.name}`,
      name: net.name,
      ground: GROUND_NAMES.test(upper(net.name)),
      sources: contexts.filter((x) => x.pin.type === 'power_out').map((x) => ({ ref: x.comp.ref, pin: x.pin.number, name: x.pin.name })),
      loads: contexts.filter((x) => x.pin.type === 'power_in').map((x) => ({ ref: x.comp.ref, pin: x.pin.number, name: x.pin.name })),
      connectors: contexts.filter((x) => CONNECTOR_REF.test(x.comp.ref)).map((x) => ({ ref: x.comp.ref, pin: x.pin.number, name: x.pin.name })),
      endpoints: net.endpoints,
      confidence: net.confidence
    }];
  });
}

function runErc(ir, interfaces, powerRails) {
  const issues = [];
  let seq = 1;
  const push = (severity, code, title, detail, refs = [], nets = []) => issues.push(issue(`erc-${seq++}`, severity, code, title, detail, refs, nets));
  const pinToNets = new Map();
  const noConnect = new Set((ir.noConnects || []).map((x) => pinKey(x.ref, x.pin)));

  for (const net of ir.nets) {
    const contexts = net.endpoints.map((ep) => ({ ep, ctx: endpointContext(ir, ep) })).filter((x) => x.ctx);
    for (const { ep } of contexts) {
      const key = pinKey(ep.ref, ep.pin);
      if (!pinToNets.has(key)) pinToNets.set(key, []);
      pinToNets.get(key).push(net.name);
      if (noConnect.has(key)) push('error', 'NC_CONNECTED', 'No-connect pin is connected', `${ep.ref}.${ep.pin} is marked NC but appears on ${net.name}.`, [ep.ref], [net.name]);
    }
    const outputs = contexts.filter(({ ctx }) => ['output', 'power_out'].includes(ctx.pin.type));
    if (outputs.length > 1) push('error', 'MULTIPLE_DRIVERS', 'Multiple active drivers', `${net.name} has ${outputs.length} output/power drivers: ${outputs.map((x) => `${x.ctx.comp.ref}.${x.ctx.pin.number}`).join(', ')}.`, outputs.map((x) => x.ctx.comp.ref), [net.name]);
    if (Number(net.confidence ?? 1) < 0.65) push('review', 'LOW_CONFIDENCE_NET', 'Low-confidence connectivity', `${net.name} was reconstructed with ${Math.round(Number(net.confidence || 0) * 100)}% confidence.`, contexts.map((x) => x.ctx.comp.ref), [net.name]);
  }

  for (const [key, nets] of pinToNets) {
    if (nets.length > 1) {
      const [ref, pin] = key.split(':');
      push('error', 'PIN_MULTI_NET', 'Pin belongs to multiple nets', `${ref}.${pin} appears on ${nets.join(', ')}. A physical pin can belong to only one electrical net.`, [ref], nets);
    }
  }

  const connected = new Set(pinToNets.keys());
  for (const comp of ir.components) {
    for (const pin of comp.pins) {
      const key = pinKey(comp.ref, pin.number);
      if (connected.has(key) || noConnect.has(key) || pin.type === 'no_connect') continue;
      if (pin.type === 'power_in') push('warning', 'POWER_INPUT_UNCONNECTED', 'Power input is unconnected', `${comp.ref}.${pin.number} ${pin.name} is a power input with no reconstructed net.`, [comp.ref]);
      else if (pin.type === 'input' && Number(pin.confidence ?? 1) >= 0.6) push('warning', 'INPUT_UNCONNECTED', 'Input pin is unconnected', `${comp.ref}.${pin.number} ${pin.name} is an input with no reconstructed net.`, [comp.ref]);
      else if (Number(pin.confidence ?? 1) < 0.5) push('review', 'PIN_LOW_CONFIDENCE', 'Low-confidence unconnected pin', `${comp.ref}.${pin.number} ${pin.name} is both unconnected and low-confidence.`, [comp.ref]);
    }
  }

  for (const rail of powerRails) {
    if (rail.ground) continue;
    if (rail.loads.length && !rail.sources.length && !rail.connectors.length) push('warning', 'POWER_SOURCE_MISSING', 'Power rail has loads but no source', `${rail.name} feeds ${rail.loads.length} power input(s), but no power-output pin or connector source was reconstructed.`, rail.loads.map((x) => x.ref), [rail.name]);
  }

  for (const iface of interfaces) {
    if (!iface.complete.ok) push('warning', 'INTERFACE_INCOMPLETE', `${iface.type} interface appears incomplete`, `${iface.type} among ${iface.members.join(', ')} is missing ${iface.complete.missing.join(', ')}.`, iface.members, iface.nets.map((n) => n.name));
    if (iface.type === 'UART') {
      for (const n of iface.nets) {
        const contexts = n.endpoints.map((ep) => endpointContext(ir, ep)).filter(Boolean);
        if (contexts.length >= 2 && contexts.every((x) => /TX/i.test(x.pin.name))) push('warning', 'UART_TX_TX', 'UART TX appears connected to TX', `${n.name} joins TX-labelled pins on both ends.`, contexts.map((x) => x.comp.ref), [n.name]);
        if (contexts.length >= 2 && contexts.every((x) => /RX/i.test(x.pin.name))) push('warning', 'UART_RX_RX', 'UART RX appears connected to RX', `${n.name} joins RX-labelled pins on both ends.`, contexts.map((x) => x.comp.ref), [n.name]);
      }
    }
    if (iface.type === 'I2C') {
      for (const role of ['SDA', 'SCL']) {
        const n = iface.nets.find((x) => x.role === role);
        if (!n) continue;
        const hasResistor = n.endpoints.some((ep) => /^R\d+/i.test(ep.ref));
        if (!hasResistor) push('review', 'I2C_PULLUP_NOT_SEEN', `${role} pull-up not detected`, `${n.name} has no resistor endpoint in the reconstructed graph. Verify that an external/internal pull-up exists.`, iface.members, [n.name]);
      }
    }
  }

  return issues;
}

export function analyzeConnectivity(ir) {
  const interfaces = buildInterfaces(ir);
  const powerRails = buildPowerRails(ir);
  const issues = runErc(ir, interfaces, powerRails);
  const counts = { error: 0, warning: 0, review: 0, passed: 0 };
  for (const item of issues) counts[item.severity] = (counts[item.severity] || 0) + 1;
  counts.passed = Math.max(0, ir.nets.length + ir.components.length - issues.filter((x) => x.severity === 'error').length);
  return {
    issues,
    interfaces,
    powerRails,
    health: {
      ...counts,
      score: Math.max(0, Math.round(100 - counts.error * 18 - counts.warning * 6 - counts.review * 2)),
      deterministic: true,
      tokenCost: 0
    }
  };
}

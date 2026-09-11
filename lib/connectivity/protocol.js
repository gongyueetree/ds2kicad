// Protocol-aware ERC for Connectivity Intelligence Engine.
// This layer is deterministic and consumes zero model tokens.

const PASSIVE_REF = /^(R|C|L|D|F|FB|TP)\d+/i;
const RESISTOR_REF = /^R\d+/i;
const CONNECTOR_REF = /^(J|P|CN)\d+/i;
const POWER_NAME = /^(VCC|VDD|AVDD|DVDD|VIN|VBUS|VBAT|VTREF|VREF|\+?[0-9.]+V[0-9A-Z_+-]*)$/i;
const GROUND_NAME = /^(GND|AGND|DGND|PGND|VSS|0V)$/i;

const sevRank = { pass: 0, review: 1, warning: 2, error: 3 };
const pinKey = (ref, pin) => `${ref}:${pin}`;
const upper = (v) => String(v || '').toUpperCase();

function endpointContext(ir, ep) {
  const comp = ir.components.find((c) => c.ref === ep.ref);
  const pin = comp?.pins.find((p) => String(p.number) === String(ep.pin));
  return comp && pin ? { comp, pin, ep } : null;
}

function netContexts(ir, net) {
  return (net?.endpoints || []).map((ep) => endpointContext(ir, ep)).filter(Boolean);
}

function activeRefs(ir, net) {
  return [...new Set(netContexts(ir, net).filter((x) => !PASSIVE_REF.test(x.comp.ref)).map((x) => x.comp.ref))].sort();
}

function check(protocol, status, code, title, detail, refs = [], nets = []) {
  return {
    id: `protocol:${protocol}:${code}:${nets.join(',') || refs.join(',') || 'design'}`,
    layer: 'protocol', protocol, status, severity: status === 'pass' ? 'pass' : status,
    code, title, detail,
    refs: [...new Set(refs)], nets: [...new Set(nets)]
  };
}

function issueFromCheck(c) {
  if (c.status === 'pass') return null;
  return {
    id: c.id,
    layer: 'protocol',
    severity: c.status,
    code: c.code,
    title: c.title,
    detail: c.detail,
    refs: c.refs,
    nets: c.nets
  };
}

function roleNet(iface, role) {
  return (iface.nets || []).find((n) => n.role === role);
}

function netByName(ir, name) {
  return ir.nets.find((n) => n.name === name);
}

function otherNetForPin(ir, ref, pin) {
  return ir.nets.find((n) => n.endpoints.some((ep) => ep.ref === ref && String(ep.pin) === String(pin)));
}

function resistorBias(ir, netSummary) {
  const net = netByName(ir, netSummary?.name);
  if (!net) return { kind: 'none' };
  const contexts = netContexts(ir, net);
  const resistors = contexts.filter((x) => RESISTOR_REF.test(x.comp.ref));
  if (!resistors.length) return { kind: 'none' };

  let unresolved = false;
  for (const r of resistors) {
    const otherPins = r.comp.pins.filter((p) => String(p.number) !== String(r.pin.number));
    for (const p of otherPins) {
      const other = otherNetForPin(ir, r.comp.ref, p.number);
      if (!other) { unresolved = true; continue; }
      if (GROUND_NAME.test(upper(other.name))) return { kind: 'pulldown', resistor: r.comp.ref, rail: other.name };
      if (POWER_NAME.test(upper(other.name))) return { kind: 'pullup', resistor: r.comp.ref, rail: other.name };
      unresolved = true;
    }
  }
  return { kind: unresolved ? 'resistor_unresolved' : 'resistor_unresolved', resistor: resistors[0].comp.ref };
}

function drivers(ir, netSummary) {
  const net = netByName(ir, netSummary?.name);
  if (!net) return [];
  return netContexts(ir, net).filter((x) => ['output', 'power_out'].includes(x.pin.type));
}

function pinTypes(ir, netSummary) {
  const net = netByName(ir, netSummary?.name);
  if (!net) return [];
  return netContexts(ir, net).map((x) => ({ ref: x.comp.ref, pin: x.pin.number, name: x.pin.name, type: x.pin.type }));
}

function sharedNamedNet(ir, members, regex) {
  const wanted = new Set(members);
  return ir.nets.find((net) => {
    if (!regex.test(upper(net.name))) return false;
    const refs = new Set(activeRefs(ir, net));
    let hits = 0;
    for (const ref of wanted) if (refs.has(ref)) hits++;
    return hits >= Math.min(2, wanted.size);
  });
}

function memberSet(ir, netSummary) {
  const net = netByName(ir, netSummary?.name);
  return new Set(net ? activeRefs(ir, net) : []);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function analyzeI2C(ir, iface) {
  const out = [];
  for (const role of ['SDA', 'SCL']) {
    const n = roleNet(iface, role);
    if (!n) continue;
    const bias = resistorBias(ir, n);
    if (bias.kind === 'pullup') {
      out.push(check('I2C', 'pass', `I2C_${role}_PULLUP_OK`, `${role} pull-up detected`, `${n.name} is biased through ${bias.resistor} to ${bias.rail}.`, iface.members, [n.name]));
    } else if (bias.kind === 'pulldown') {
      out.push(check('I2C', 'error', `I2C_${role}_PULLDOWN`, `${role} appears pulled down`, `${n.name} is biased through ${bias.resistor} to ${bias.rail}; I²C normally requires pull-up bias.`, iface.members, [n.name]));
    } else if (bias.kind === 'resistor_unresolved') {
      out.push(check('I2C', 'review', `I2C_${role}_BIAS_UNVERIFIED`, `${role} bias rail could not be verified`, `${n.name} includes ${bias.resistor}, but the resistor's opposite rail was not reconstructed. Verify that it is a pull-up to the correct logic rail.`, iface.members, [n.name]));
    } else {
      out.push(check('I2C', 'warning', `I2C_${role}_PULLUP_MISSING`, `${role} pull-up not detected`, `${n.name} has no resistor endpoint in Connectivity IR. Verify external or internal pull-ups.`, iface.members, [n.name]));
    }

    const pins = pinTypes(ir, n);
    const hardOutputs = pins.filter((p) => p.type === 'output');
    if (hardOutputs.length) {
      out.push(check('I2C', 'review', `I2C_${role}_DRIVE_TYPE`, `${role} has push-pull output metadata`, `${hardOutputs.map((p) => `${p.ref}.${p.pin}`).join(', ')} are typed as output. Verify open-drain/bidirectional behavior for I²C.`, hardOutputs.map((p) => p.ref), [n.name]));
    }
  }
  return out;
}

function analyzeSPI(ir, iface) {
  const out = [];
  const sck = roleNet(iface, 'SCK');
  const mosi = roleNet(iface, 'MOSI');
  const miso = roleNet(iface, 'MISO');
  const cs = (iface.nets || []).filter((n) => n.role === 'CS');

  for (const [role, n] of [['SCK', sck], ['MOSI', mosi]]) {
    if (!n) continue;
    const d = drivers(ir, n);
    if (d.length === 1) out.push(check('SPI', 'pass', `SPI_${role}_DRIVER_OK`, `${role} has one active driver`, `${n.name} is driven by ${d[0].comp.ref}.${d[0].pin.number}.`, iface.members, [n.name]));
    else if (!d.length) out.push(check('SPI', 'review', `SPI_${role}_NO_DRIVER`, `${role} driver not identified`, `${n.name} has no pin typed as output. Verify pin electrical types or master direction.`, iface.members, [n.name]));
    else out.push(check('SPI', 'error', `SPI_${role}_MULTI_DRIVER`, `${role} has multiple active drivers`, `${n.name} is driven by ${d.map((x) => `${x.comp.ref}.${x.pin.number}`).join(', ')}.`, d.map((x) => x.comp.ref), [n.name]));
  }

  if (miso) {
    const d = drivers(ir, miso);
    if (d.length > 1) {
      out.push(check('SPI', cs.length ? 'review' : 'warning', 'SPI_MISO_SHARED_DRIVERS', 'MISO has multiple slave outputs', `${miso.name} has ${d.length} output drivers. This is valid only when chip-select/tri-state behavior guarantees that one slave drives MISO at a time.${cs.length ? ` ${cs.length} CS net(s) were detected.` : ' No CS net was detected in this interface.'}`, d.map((x) => x.comp.ref), [miso.name, ...cs.map((x) => x.name)]));
    } else if (d.length === 1) {
      out.push(check('SPI', 'pass', 'SPI_MISO_DRIVER_OK', 'MISO driver topology looks simple', `${miso.name} has one currently identified output driver.`, iface.members, [miso.name]));
    }
  }

  if (iface.members.length > 2) {
    const covered = new Set();
    for (const n of cs) {
      const net = netByName(ir, n.name);
      for (const ref of activeRefs(ir, net || { endpoints: [] })) covered.add(ref);
    }
    const busDrivers = new Set([...(sck ? drivers(ir, sck) : []), ...(mosi ? drivers(ir, mosi) : [])].map((x) => x.comp.ref));
    const slaves = iface.members.filter((r) => !busDrivers.has(r) && !CONNECTOR_REF.test(r));
    const missing = slaves.filter((r) => !covered.has(r));
    if (missing.length) out.push(check('SPI', 'review', 'SPI_CS_COVERAGE', 'Some SPI devices have no detected chip-select', `No CS/SS/NSS net was associated with ${missing.join(', ')}. Verify dedicated selection or daisy-chain topology.`, missing, cs.map((x) => x.name)));
  }
  return out;
}

function analyzeUART(ir, iface) {
  const out = [];
  const tx = roleNet(iface, 'TX');
  const rx = roleNet(iface, 'RX');
  for (const [role, n] of [['TX', tx], ['RX', rx]]) {
    if (!n) continue;
    const net = netByName(ir, n.name);
    const contexts = netContexts(ir, net);
    const rolePins = contexts.filter((x) => new RegExp(role, 'i').test(x.pin.name));
    if (rolePins.length >= 2) out.push(check('UART', 'warning', `UART_${role}_${role}`, `UART ${role} appears connected to ${role}`, `${n.name} joins ${role}-labelled pins on multiple devices: ${rolePins.map((x) => `${x.comp.ref}.${x.pin.number}`).join(', ')}.`, rolePins.map((x) => x.comp.ref), [n.name]));
    const active = activeRefs(ir, net);
    if (active.length > 2) out.push(check('UART', 'review', 'UART_MULTIDROP', 'UART net has more than two active devices', `${n.name} touches ${active.join(', ')}. Verify that multidrop/bus operation is intended.`, active, [n.name]));
  }
  if (tx && rx) {
    const a = memberSet(ir, tx), b = memberSet(ir, rx);
    if (!sameSet(a, b)) out.push(check('UART', 'warning', 'UART_PAIR_MEMBER_MISMATCH', 'UART TX/RX endpoints do not match', `${tx.name} and ${rx.name} do not connect the same active device set. Verify the pair.`, iface.members, [tx.name, rx.name]));
    else out.push(check('UART', 'pass', 'UART_PAIR_OK', 'UART TX/RX pair endpoints match', `${tx.name} and ${rx.name} connect the same active device set.`, iface.members, [tx.name, rx.name]));
  }
  return out;
}

function analyzeUSB(ir, iface) {
  const out = [];
  const dp = roleNet(iface, 'D+');
  const dm = roleNet(iface, 'D-');
  if (dp && dm) {
    const a = memberSet(ir, dp), b = memberSet(ir, dm);
    if (sameSet(a, b)) out.push(check('USB', 'pass', 'USB_DIFF_PAIR_ENDPOINTS_OK', 'USB D+/D- endpoint sets match', `${dp.name} and ${dm.name} connect the same active devices.`, iface.members, [dp.name, dm.name]));
    else out.push(check('USB', 'warning', 'USB_DIFF_PAIR_ENDPOINT_MISMATCH', 'USB D+/D- endpoint sets differ', `${dp.name} and ${dm.name} do not connect the same active device set. Check missing series parts, connector pins or extraction errors.`, iface.members, [dp.name, dm.name]));
  }

  const typeC = iface.members.map((r) => ir.components.find((c) => c.ref === r)).filter(Boolean).filter((c) => /USB.?C|TYPE.?C/i.test(`${c.value} ${c.mpn} ${c.notes}`));
  if (typeC.length) {
    const cc1 = roleNet(iface, 'CC1'), cc2 = roleNet(iface, 'CC2');
    if (!cc1 || !cc2) out.push(check('USB', 'warning', 'USB_C_CC_INCOMPLETE', 'USB-C CC1/CC2 connectivity incomplete', `${typeC.map((c) => c.ref).join(', ')} looks like USB-C, but ${[!cc1 && 'CC1', !cc2 && 'CC2'].filter(Boolean).join(' and ')} was not associated with the interface.`, typeC.map((c) => c.ref), (iface.nets || []).map((n) => n.name)));
    else out.push(check('USB', 'pass', 'USB_C_CC_PRESENT', 'USB-C CC pins detected', `CC1 and CC2 connectivity are both present for ${typeC.map((c) => c.ref).join(', ')}.`, typeC.map((c) => c.ref), [cc1.name, cc2.name]));
  }
  return out;
}

function analyzeDebug(ir, iface) {
  const out = [];
  const protocol = iface.type;
  const hasConnector = iface.members.some((r) => CONNECTOR_REF.test(r));
  if (!hasConnector) return out;
  const gnd = sharedNamedNet(ir, iface.members, GROUND_NAME);
  const vref = sharedNamedNet(ir, iface.members, /^(VTREF|VREF|VDD|VCC|\+?3\.3V|3V3)$/i);
  if (gnd) out.push(check(protocol, 'pass', `${protocol}_GND_OK`, `${protocol} connector shares ground`, `${gnd.name} connects the debug interface members.`, iface.members, [gnd.name]));
  else out.push(check(protocol, 'warning', `${protocol}_GND_MISSING`, `${protocol} connector ground not detected`, `No shared GND net was reconstructed between the debugger connector and target.`, iface.members));
  if (vref) out.push(check(protocol, 'pass', `${protocol}_VTREF_OK`, `${protocol} target-reference voltage detected`, `${vref.name} can provide target-voltage reference to the debug connector.`, iface.members, [vref.name]));
  else out.push(check(protocol, 'review', `${protocol}_VTREF_MISSING`, `${protocol} target-reference voltage not detected`, `No VTREF/VREF/VDD/VCC/3V3 net was reconstructed between connector and target. Verify level-reference wiring.`, iface.members));
  if (protocol === 'SWD' && !roleNet(iface, 'NRST')) out.push(check('SWD', 'review', 'SWD_NRST_OPTIONAL', 'SWD reset line not detected', 'NRST is optional for some workflows but useful for recovery and connect-under-reset. Verify whether omission is intentional.', iface.members));
  return out;
}

function worstStatus(checks) {
  let worst = 'pass';
  for (const c of checks) if ((sevRank[c.status] || 0) > (sevRank[worst] || 0)) worst = c.status;
  return worst;
}

export function analyzeProtocolLayer(ir, interfaces = []) {
  const augmented = [];
  const allChecks = [];
  for (const iface of interfaces) {
    let checks = [];
    if (iface.type === 'I2C') checks = analyzeI2C(ir, iface);
    else if (iface.type === 'SPI') checks = analyzeSPI(ir, iface);
    else if (iface.type === 'UART') checks = analyzeUART(ir, iface);
    else if (iface.type === 'USB') checks = analyzeUSB(ir, iface);
    else if (iface.type === 'SWD' || iface.type === 'JTAG') checks = analyzeDebug(ir, iface);
    allChecks.push(...checks);
    augmented.push({ ...iface, protocolChecks: checks, protocolStatus: worstStatus(checks) });
  }

  const issues = allChecks.map(issueFromCheck).filter(Boolean);
  const summary = { pass: 0, review: 0, warning: 0, error: 0, total: allChecks.length };
  for (const c of allChecks) summary[c.status] = (summary[c.status] || 0) + 1;
  return { interfaces: augmented, issues, checks: allChecks, summary };
}

export function isSharedBusDriverException(ir, interfaces, netName) {
  for (const iface of interfaces || []) {
    if (iface.type !== 'SPI') continue;
    const n = (iface.nets || []).find((x) => x.name === netName);
    if (n?.role !== 'MISO') continue;
    const d = drivers(ir, n);
    if (d.length > 1) return true;
  }
  return false;
}

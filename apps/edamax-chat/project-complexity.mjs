const CONNECTOR_RE = /(?:connector|header|pin\s*header|排针|排母|接插件|端子|^j\d*$|^p\d*$|^cn\d*$)/i;
const PASSIVE_RE = /(?:resistor|capacitor|inductor|电阻|电容|电感|^r\d*$|^c\d*$|^l\d*$)/i;
const DECORATION_RE = /(?:text|image|arc|circle|rectangle|polygon|canvas|图像|文本|标注|装饰)/i;

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const logScore = (value, scale) => Math.log1p(Math.max(0, value)) * scale;

function walk(value, visit, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value); visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit, seen));
    else walk(child, visit, seen);
  }
}

function textOf(node) {
  return [node.type, node.kind, node.name, node.ref, node.designator, node.symbol, node.device,
    node.libId, node.libraryId, node.package, node.footprint].filter(Boolean).join(' ');
}

function entropy(counts) {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total || counts.size < 2) return 0;
  let h = 0;
  for (const count of counts.values()) { const p = count / total; h -= p * Math.log2(p); }
  return h / Math.log2(counts.size);
}

export function scoreSchematicComplexity(document) {
  const stats = {
    components: 0, connectors: 0, passives: 0, functionalComponents: 0,
    uniqueDeviceKinds: 0, pins: 0, connectedPins: 0, nets: 0, wires: 0,
    sheets: 0, hierarchicalPorts: 0, decorations: 0, duplicateDeviceRatio: 0
  };
  const kinds = new Map(); const nets = new Set();
  walk(document, node => {
    const type = String(node.type || node.kind || '').toLowerCase();
    const text = textOf(node);
    const isComponent = /component|symbol|device|instance/.test(type) || Boolean(node.designator || node.ref);
    if (isComponent) {
      stats.components++;
      const key = String(node.libId || node.libraryId || node.symbol || node.device || node.name || text).toLowerCase();
      kinds.set(key, (kinds.get(key) || 0) + 1);
      if (CONNECTOR_RE.test(text)) stats.connectors++;
      else if (PASSIVE_RE.test(text)) stats.passives++;
      else stats.functionalComponents++;
    }
    if (/wire|segment/.test(type)) stats.wires++;
    if (/sheet|page/.test(type)) stats.sheets++;
    if (/hierarchical|sheetport|sheet_port/.test(type)) stats.hierarchicalPorts++;
    if (DECORATION_RE.test(type) && !isComponent) stats.decorations++;
    const pinList = Array.isArray(node.pins) ? node.pins : [];
    stats.pins += pinList.length;
    stats.connectedPins += pinList.filter(pin => pin.net || pin.netId || pin.wire || pin.connected).length;
    for (const key of ['net', 'netId', 'netName']) if (node[key]) nets.add(String(node[key]));
  });
  stats.nets = nets.size;
  stats.uniqueDeviceKinds = kinds.size;
  const maxKind = Math.max(0, ...kinds.values());
  stats.duplicateDeviceRatio = stats.components ? maxKind / stats.components : 1;
  const connectorRatio = stats.components ? stats.connectors / stats.components : 1;
  const decorationRatio = stats.decorations / Math.max(1, stats.decorations + stats.components + stats.wires);
  const connectionCoverage = stats.pins ? stats.connectedPins / stats.pins : Math.min(1, stats.wires / Math.max(1, stats.components));
  const diversity = entropy(kinds);

  let score = 0;
  score += logScore(stats.functionalComponents, 9);
  score += logScore(stats.nets, 6);
  score += logScore(stats.wires, 3);
  score += logScore(Math.max(0, stats.sheets - 1), 6);
  score += logScore(stats.hierarchicalPorts, 3);
  score += diversity * 18 + connectionCoverage * 14;
  score -= connectorRatio * 28;
  score -= Math.max(0, stats.duplicateDeviceRatio - 0.35) * 35;
  score -= decorationRatio * 25;
  if (stats.components < 5) score -= 25;
  if (stats.functionalComponents < 2) score -= 18;
  if (stats.nets < 3 && stats.wires < 5) score -= 18;

  const flags = [];
  if (connectorRatio > 0.45) flags.push('connector_heavy');
  if (stats.duplicateDeviceRatio > 0.6 && stats.components >= 6) flags.push('repetitive_devices');
  if (decorationRatio > 0.5) flags.push('decoration_heavy');
  if (stats.components < 5) flags.push('too_few_components');
  if (connectionCoverage < 0.25 && stats.components >= 5) flags.push('low_connectivity');
  return { score: Math.round(clamp(score)), confidence: stats.components || stats.wires ? 'structural' : 'none', flags, stats };
}

export function scoreSearchCandidate(project) {
  const count = project.count || {};
  let score = 12 + logScore(count.star, 4.5) + logScore(count.like, 3) + logScore(count.views, 1.2) + logScore(project.comments_count, 2);
  if ((project.introduction || '').trim().length >= 20) score += 7;
  if (project.grade >= 4) score += 8;
  if (project.owner?.team) score += 5;
  const text = `${project.name || ''} ${project.introduction || ''}`;
  if (/(空白|测试|练习|demo空|装饰|logo|排针|转接板|breakout)/i.test(text)) score -= 18;
  return { score: Math.round(clamp(score)), confidence: 'metadata', flags: [], stats: { ...count, grade: project.grade || 0 } };
}

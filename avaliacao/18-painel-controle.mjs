// Painel de controle manual + regra modelo com dois atuadores (07/11). Cria no PAVAP
// (Central de desenvolvimento) três dispositivos simulados "Teste controle · …", as regras
// modelo (campos calculados instalados pela plataforma) e um painel no grupo de painéis do
// PAVAP. O painel FICA para ser visto pelo navegador; para remover tudo:
//   node 18-painel-controle.mjs --limpar
// Regra "umidade da sala":
//   umidificador liga abaixo de limite_min e desliga acima de limite_max;
//   ar-condicionado liga acima de limite_max e desliga abaixo de limite_max − 5;
//   os dois só agem com habilitada = true; parâmetros ficam no umidificador (atributos de servidor).
// Credencial: THINGSBOARD_TOKEN do backend/.env; nunca é impressa.
import crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV = Object.fromEntries(readFileSync(join(HERE, '..', '..', 'backend', '.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
const P = 'Teste controle'
const TITLE = 'Teste controle · Umidade da sala do PAVAP'

const call = async (method, path, auth, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Authorization': auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const T = (m, p, body) => call(m, p, 'ApiKey ' + ENV.THINGSBOARD_TOKEN, body)
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const page = '?pageSize=200&page=0'
const list = r => (r.json && (r.json.data || r.json)) || []

const limpar = async () => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${encodeURIComponent(P)}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const d of list(await T('GET', `/api/dashboards/all${page}&textSearch=${encodeURIComponent(P)}`))) await T('DELETE', `/api/dashboard/${d.id.id}`)
  for (const d of list(await T('GET', `/api/customer/${(await pavap()).customer.id.id}/dashboards${page}&textSearch=${encodeURIComponent(P)}`))) await T('DELETE', `/api/dashboard/${d.id.id}`)
}
const pavap = async () => {
  const customer = list(await T('GET', `/api/customers${page}&textSearch=${encodeURIComponent('Gado de Corte')}`))[0]
  const groups = type => T('GET', `/api/entityGroups/CUSTOMER/${customer.id.id}/${type}`).then(list)
  const devices = (await groups('DEVICE')).find(g => /PAVAP\) · Dispositivos$/.test(g.name))
  const dashboards = (await groups('DASHBOARD')).find(g => /PAVAP\) · Painéis$/.test(g.name))
  return { customer, devices, dashboards }
}

if (process.argv.includes('--limpar')) { await limpar(); console.log('Removido.'); process.exit(0) }

await limpar()
const { devices: gDev, dashboards: gDash } = await pavap()
const dev = async name => must(await T('POST', `/api/device?entityGroupId=${gDev.id.id}`, { name: `${P} · ${name}`, label: `${name} (simulado)`, type: 'default' }), name)
const sensor = await dev('Sensor de umidade da sala'), umid = await dev('Umidificador'), ac = await dev('Ar-condicionado')
const tok = async d => must(await T('GET', `/api/device/${d.id.id}/credentials`), 'cred').credentialsId

// --- regras modelo, uma por atuador (o campo calculado só grava no próprio dispositivo)
const strategy = { type: 'IMMEDIATE', saveAttribute: true, sendWsUpdate: true, processCfs: true, updateAttributesOnlyOnValueChange: true }
const param = (key, def) => ({ refEntityId: umid.id, refEntityKey: { key, type: 'ATTRIBUTE', scope: 'SERVER_SCOPE' }, defaultValue: def })
const args = { h: { refEntityId: sensor.id, refEntityKey: { key: 'humidity', type: 'TS_LATEST' } },
  min: param('limite_min', '45'), max: param('limite_max', '55'), hab: param('habilitada', 'false'),
  estado: { refEntityKey: { key: 'estado', type: 'ATTRIBUTE', scope: 'CLIENT_SCOPE' }, defaultValue: 'false' } }
const guard = 'var lo = toFixed(min, 2); var hi = toFixed(max, 2);' +
  ' if (!(hab == true || hab == "true")) { return {}; } if (!(lo >= 0 && hi <= 100 && lo < hi)) { return {}; }' +
  ' var on = (estado == true || estado == "true");'
must(await T('POST', '/api/calculatedField', { entityId: umid.id, type: 'SCRIPT', name: 'Modelo · Umidade da sala v1 (umidificador)',
  configuration: { type: 'SCRIPT', arguments: args, output: { type: 'ATTRIBUTES', scope: 'SHARED_SCOPE', strategy },
    expression: guard + ' if (h < lo) { on = true; } if (h > hi) { on = false; } return {"ligar": on};' } }), 'cf umid')
must(await T('POST', '/api/calculatedField', { entityId: ac.id, type: 'SCRIPT', name: 'Modelo · Umidade da sala v1 (ar-condicionado)',
  configuration: { type: 'SCRIPT', arguments: args, output: { type: 'ATTRIBUTES', scope: 'SHARED_SCOPE', strategy },
    expression: guard + ' if (h > hi) { on = true; } if (h < hi - 5) { on = false; } return {"ligar": on};' } }), 'cf ac')
must(await T('POST', `/api/plugins/telemetry/DEVICE/${umid.id.id}/SERVER_SCOPE`, { limite_min: 45, limite_max: 55, habilitada: true }), 'params')

// --- painel
const alias = (d, name) => { const id = crypto.randomUUID(); return [id, { id, alias: name, filter: { type: 'singleEntity', resolveMultiple: false, singleEntity: { entityType: 'DEVICE', id: d.id.id } } }] }
const [aS, aliasS] = alias(sensor, 'Sensor'), [aU, aliasU] = alias(umid, 'Umidificador'), [aA, aliasA] = alias(ac, 'Ar-condicionado')
const tpl = async fqn => { const t = must(await T('GET', `/api/widgetType?fqn=${fqn}`), fqn); return { type: t.descriptor.type, config: JSON.parse(t.descriptor.defaultConfig) } }
const getVal = (scope, key) => ({ action: 'GET_ATTRIBUTE', defaultValue: false,
  executeRpc: { method: 'getState', requestTimeout: 5000, requestPersistent: false, persistentPollingInterval: 1000 },
  getAttribute: { key, scope }, getTimeSeries: { key: 'state' }, getAlarmStatus: { severityList: null, typeList: null },
  dataToValue: { type: 'FUNCTION', compareToValue: true, dataToValueFunction: 'return data === true || data === "true";' } })
const setVal = (scope, key, value) => ({ action: 'SET_ATTRIBUTE',
  executeRpc: { method: 'setState', requestTimeout: 5000, requestPersistent: false, persistentPollingInterval: 1000 },
  setAttribute: { key, scope }, putTimeSeries: { key: 'state' },
  valueToData: { type: 'CONSTANT', constantValue: value, valueToDataFunction: 'return value;' } })
const nothing = { action: 'DO_NOTHING', defaultValue: false, getAttribute: { key: 'state', scope: null }, getTimeSeries: { key: 'state' },
  getAlarmStatus: { severityList: null, typeList: null }, dataToValue: { type: 'NONE', compareToValue: true, dataToValueFunction: 'return data;' } }

const widgets = {}, layout = {}
const add = (fqn, base, title, size, pos, config) => {
  const id = crypto.randomUUID()
  widgets[id] = { typeFullFqn: fqn, type: base.type, sizeX: size[0], sizeY: size[1], id, config: { ...base.config, title, showTitle: true, ...config, settings: { ...(base.config.settings || {}), ...(config.settings || {}) } } }
  layout[id] = { sizeX: size[0], sizeY: size[1], row: pos[0], col: pos[1] }
}
const sw = await tpl('system.single_switch')
const switchCfg = (aliasId, label, icon, read, on, off) => ({ targetDevice: { type: 'entity', entityAliasId: aliasId }, datasources: [],
  settings: { initialState: read, onUpdateState: on, offUpdateState: off, disabledState: nothing, layout: 'right', autoScale: true,
    showLabel: true, label, showIcon: true, icon, iconSize: 24, iconSizeUnit: 'px', showOnLabel: true, onLabel: 'Ligado', showOffLabel: true, offLabel: 'Desligado' } })
add('system.single_switch', sw, 'Umidificador (manual)', [8, 3], [0, 0],
  switchCfg(aU, 'Umidificador', 'mdi:air-humidifier', getVal('CLIENT_SCOPE', 'estado'), setVal('SHARED_SCOPE', 'ligar', true), setVal('SHARED_SCOPE', 'ligar', false)))
add('system.single_switch', sw, 'Ar-condicionado (manual)', [8, 3], [0, 8],
  switchCfg(aA, 'Ar-condicionado', 'mdi:air-conditioner', getVal('CLIENT_SCOPE', 'estado'), setVal('SHARED_SCOPE', 'ligar', true), setVal('SHARED_SCOPE', 'ligar', false)))
add('system.single_switch', sw, 'Controle automático', [8, 3], [0, 16],
  switchCfg(aU, 'Automático', 'mdi:robot', getVal('SERVER_SCOPE', 'habilitada'), setVal('SERVER_SCOPE', 'habilitada', true), setVal('SERVER_SCOPE', 'habilitada', false)))

const form = await tpl('system.input_widgets.update_multiple_attributes')
const formKey = (name, label) => ({ name, type: 'attribute', label, color: '#2196f3', _hash: Math.random(),
  settings: { dataKeyType: 'server', dataKeyValueType: 'double', required: true, isEditable: 'editable', step: 1 } })
add('system.input_widgets.update_multiple_attributes', form, 'Limites da regra (%)', [8, 6], [3, 0], {
  datasources: [{ type: 'entity', name: '', entityAliasId: aU, filterId: null, dataKeys: [formKey('limite_min', 'Ligar umidificador abaixo de'), formKey('limite_max', 'Desligar umidificador e ligar o AC acima de')] }],
  settings: { showActionButtons: true, updateAllValues: false, saveButtonLabel: 'Salvar', resetButtonLabel: 'Desfazer', showResultMessage: true, fieldsAlignment: 'column', fieldsInRow: 1 } })

const chart = await tpl('system.time_series_chart')
add('system.time_series_chart', chart, 'Umidade da sala', [16, 6], [3, 8], {
  useDashboardTimewindow: true, units: '%', decimals: 0,
  datasources: [{ type: 'entity', name: '', entityAliasId: aS, filterId: null,
    dataKeys: [{ name: 'humidity', type: 'timeseries', label: 'Umidade', color: '#2196f3', settings: chart.config.datasources?.[0]?.dataKeys?.[0]?.settings || {}, _hash: Math.random() }] }] })

const configuration = {
  description: 'Teste de controle manual e regra modelo (07/11)', widgets, entityAliases: { [aS]: aliasS, [aU]: aliasU, [aA]: aliasA },
  states: { default: { name: TITLE, root: true, layouts: { main: { widgets: layout, gridSettings: { columns: 24, margin: 10, outerMargin: true, backgroundSizeMode: '100%' } } } } },
  timewindow: { realtime: { realtimeType: 0, timewindowMs: 1800000, interval: 10000 }, aggregation: { type: 'NONE', limit: 2000 } },
  settings: { stateControllerId: 'entity', showTitle: true, showDashboardsSelect: false, showEntitiesSelect: false, showDashboardTimewindow: true, showDashboardExport: false }
}
const dash = must(await T('POST', `/api/dashboard?entityGroupId=${gDash.id.id}`, { title: TITLE, configuration }), 'dashboard')

const info = { dashboardId: dash.id.id, sensor: { id: sensor.id.id, token: await tok(sensor) }, umid: { id: umid.id.id, token: await tok(umid) }, ac: { id: ac.id.id, token: await tok(ac) } }
writeFileSync(join(HERE, '.18-painel-controle.private.json'), JSON.stringify(info, null, 2))
console.log('Painel:', dash.id.id, '| dispositivos e regras criados; dados para o simulador em .18-painel-controle.private.json')

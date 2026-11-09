// Widget "Regras do equipamento" (opção 1 do plugin, 07/11). Instala/atualiza no tenant:
//   - o tipo de widget e o pacote "Embrapa · Regras";
//   - o painel "Teste regras · Sala do PAVAP", no grupo de painéis do PAVAP, com os dispositivos
//     simulados do teste 18 (retira deles as regras modelo do 18 e apaga o painel antigo).
// O widget fala com o backend do Embrapa I/O (/iot/rules) usando o token da sessão do ThingsBoard.
//   node 20-widget-regras.mjs            instala ou atualiza
//   node 20-widget-regras.mjs --limpar   apaga o painel de teste e as regras de usuário dos dispositivos de teste
// Credencial: THINGSBOARD_TOKEN do backend/.env; nunca é impressa.
import crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV = Object.fromEntries(readFileSync(join(HERE, '..', '..', 'backend', '.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const info = JSON.parse(readFileSync(join(HERE, '.18-painel-controle.private.json'), 'utf8'))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
const TITLE = 'Teste regras · Sala do PAVAP'
const FQN = 'embrapa_regras_equipamento'
// Endereço público do backend do Embrapa I/O usado pelo widget no navegador (ex.: o nome da Central no
// Tailscale). Defina IO_PUBLIC_URL no ambiente ao rodar; o padrão serve só para uso local.
const API_PUBLIC = process.env.IO_PUBLIC_URL || 'http://localhost:8090'
const API_LOCAL = 'http://localhost:8090'

const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Authorization': 'ApiKey ' + ENV.THINGSBOARD_TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const must = (r, w) => { if (r.status !== 200) throw new Error(w + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const list = r => (r.json && (r.json.data || r.json)) || []
const page = '?pageSize=200&page=0'

const fields = async id => list(await call('GET', `/api/DEVICE/${id}/calculatedFields${page}`))
const dashboardsNamed = async title => {
  const customer = list(await call('GET', `/api/customers${page}&textSearch=${encodeURIComponent('Gado de Corte')}`))[0]
  return list(await call('GET', `/api/customer/${customer.id.id}/dashboards${page}&textSearch=${encodeURIComponent(title)}`)).filter(d => d.title === title)
}

if (process.argv.includes('--limpar')) {
  for (const d of await dashboardsNamed(TITLE)) await call('DELETE', `/api/dashboard/${d.id.id}`)
  for (const id of [info.umid.id, info.ac.id]) for (const f of await fields(id)) if (/^Embrapa I\/O · Regras/.test(f.name)) await call('DELETE', `/api/calculatedField/${f.id.id}`)
  console.log('Painel de teste e campos calculados das regras removidos (o registro das regras no Mongo fica; apague a coleção iotrulesets se quiser).')
  process.exit(0)
}

// --- 1. tira as regras modelo do teste 18 e o painel antigo
for (const id of [info.umid.id, info.ac.id]) {
  for (const f of await fields(id)) if (/^Modelo · /.test(f.name)) { await call('DELETE', `/api/calculatedField/${f.id.id}`); console.log('removida regra modelo:', f.name) }
  await call('POST', `/api/plugins/telemetry/DEVICE/${id}/SERVER_SCOPE`, { regras_ativas: true })
}
for (const d of await dashboardsNamed('Teste controle · Umidade da sala do PAVAP')) { await call('DELETE', `/api/dashboard/${d.id.id}`); console.log('removido painel antigo do teste 18') }

// --- 2. o widget
const templateCss = `
.er-root { height: 100%; overflow: auto; font: 14px Roboto, "Helvetica Neue", sans-serif; color: rgba(0,0,0,.87); }
.er-dev { border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 12px; margin: 0 0 10px; }
.er-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.er-head b { font-size: 15px; }
.er-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #eceff1; color: #455a64; }
.er-switch { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 13px; }
.er-list { list-style: none; margin: 8px 0; padding: 0; }
.er-list li { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; border-top: 1px dashed #eee; }
.er-list li:first-child { border-top: 0; }
.er-dot { width: 8px; height: 8px; border-radius: 50%; background: #2e7d32; margin-top: 6px; flex: none; }
.er-paused .er-dot { background: #bdbdbd; } .er-paused .er-text { color: #9e9e9e; text-decoration: line-through; }
.er-text { flex: 1; }
.er-actions { display: flex; gap: 4px; flex: none; }
.er-btn { font: inherit; font-size: 13px; border: 1px solid #c5cae9; background: #fff; color: #3949ab; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.er-btn:hover { background: #e8eaf6; } .er-btn[disabled] { opacity: .5; cursor: default; }
.er-primary { background: #3949ab; color: #fff; border-color: #3949ab; } .er-primary:hover { background: #303f9f; }
.er-danger { color: #c62828; border-color: #ef9a9a; }
.er-empty, .er-note { color: #757575; font-size: 13px; margin: 6px 0; }
.er-warn { background: #fff8e1; border: 1px solid #ffe082; border-radius: 6px; padding: 6px 8px; font-size: 13px; margin: 6px 0; }
.er-msg { border-radius: 6px; padding: 8px 10px; margin: 0 0 10px; font-size: 13px; }
.er-msg.ok { background: #e8f5e9; color: #1b5e20; } .er-msg.err { background: #ffebee; color: #b71c1c; }
.er-msg ul { margin: 4px 0 0 18px; padding: 0; }
.er-form { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px; margin-top: 8px; }
.er-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0; }
.er-row select, .er-row input { font: inherit; font-size: 13px; padding: 4px 6px; border: 1px solid #bdbdbd; border-radius: 4px; background: #fff; }
.er-row input[type=number] { width: 80px; }
.er-preview { margin: 8px 0 4px; padding: 6px 8px; background: #e8eaf6; border-radius: 6px; font-size: 13px; }
`
const controllerScript = String.raw`
self.onInit = function () {
  var ctx = self.ctx, s = ctx.settings || {};
  var root = ctx.$container[0].querySelector('.er-root');
  var local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  var api = String((local ? s.apiUrlLocal : s.apiUrl) || '').replace(/\/+$/, '');
  var st = { devices: [], sensors: [], loading: true, msg: null, form: null, confirm: null, busy: false, started: false };
  var MSG = {
    IOT_RULE_READ_ONLY: 'Você só pode ver as regras deste equipamento.',
    IOT_RULE_SESSION_EXPIRED: 'Sua sessão expirou. Recarregue a página.',
    IOT_RULE_PLATFORM_CONFLICT: 'Este equipamento já tem uma regra da plataforma.',
    IOT_RULE_INVALID: 'Confira a regra:',
    IOT_RULE_FORBIDDEN: 'Sem permissão no ThingsBoard.'
  };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function req(method, path, body) {
    return fetch(api + path, { method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('jwt_token') }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.code || ('HTTP ' + r.status)); e.code = j.code; e.details = j.details; throw e; } return j; }); });
  }
  function ids() { return (ctx.datasources || []).filter(function (d) { return d.entityType === 'DEVICE' && d.entityId; }).map(function (d) { return d.entityId; }).filter(function (v, i, a) { return a.indexOf(v) === i; }); }
  function fail(e) { st.msg = { type: 'err', text: MSG[e.code] || ('Não foi possível concluir (' + (e.code || e.message) + ').'), details: e.details || [] }; }
  function load() {
    var list = ids(); if (!list.length) { st.loading = false; st.msg = { type: 'err', text: 'Escolha um ou mais equipamentos (atuadores) na fonte de dados do widget.' }; render(); return; }
    req('GET', '/iot/rules?devices=' + list.join(',')).then(function (j) { st.devices = j.devices; st.sensors = j.sensors; st.loading = false; render(); })
      .catch(function (e) { st.loading = false; fail(e); render(); });
  }
  function act(promise, ok) {
    st.busy = true; render();
    promise.then(function (dev) {
      if (dev && dev.id) st.devices = st.devices.map(function (d) { return d.id === dev.id ? dev : d; });
      st.msg = ok ? { type: 'ok', text: ok } : null; st.busy = false; render();
    }).catch(function (e) { st.busy = false; fail(e); render(); });
  }
  function sensor(id) { return st.sensors.filter(function (x) { return x.id === id; })[0]; }
  function formHtml(d) {
    var f = st.form, sen = sensor(f.sensorId) || st.sensors[0] || { keys: [] };
    if (!f.sensorId && sen.id) f.sensorId = sen.id;
    if (sen.keys.indexOf(f.key) < 0) f.key = sen.keys[0] || '';
    var back = (f.action === 'on' ? 'Desligar' : 'Ligar') + ' quando ficar ' + (f.op === 'gt' ? 'abaixo de' : 'acima de');
    function opt(v, t, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(t) + '</option>'; }
    return '<div class="er-form">' +
      '<div class="er-row">Se <select data-f="sensorId">' + st.sensors.map(function (x) { return opt(x.id, x.name, f.sensorId); }).join('') + '</select>' +
      '<select data-f="key">' + sen.keys.map(function (k) { return opt(k, k, f.key); }).join('') + '</select></div>' +
      '<div class="er-row">ficar <select data-f="op">' + opt('gt', 'acima de', f.op) + opt('lt', 'abaixo de', f.op) + '</select>' +
      '<input type="number" step="any" data-f="value" value="' + esc(f.value) + '">, então <select data-f="action">' + opt('on', 'ligar', f.action) + opt('off', 'desligar', f.action) + '</select> este equipamento.</div>' +
      '<div class="er-row">' + esc(back) + ' <input type="number" step="any" data-f="revert" value="' + esc(f.revert) + '"> <span class="er-note">(opcional)</span></div>' +
      (f.preview ? '<div class="er-preview">' + esc(f.preview) + '</div>' : '') +
      '<div class="er-row"><button class="er-btn" data-act="preview" data-dev="' + esc(d.id) + '">Ver prévia</button>' +
      '<button class="er-btn er-primary" data-act="save" data-dev="' + esc(d.id) + '"' + (f.preview ? '' : ' disabled title="Veja a prévia antes"') + '>Salvar regra</button>' +
      '<button class="er-btn" data-act="cancel">Cancelar</button></div></div>';
  }
  function render() {
    var h = '';
    if (st.msg) h += '<div class="er-msg ' + st.msg.type + '">' + esc(st.msg.text) + (st.msg.details && st.msg.details.length ? '<ul>' + st.msg.details.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    if (st.loading) h += '<div class="er-empty">Carregando regras…</div>';
    st.devices.forEach(function (d) {
      if (d.error) { h += '<div class="er-dev"><div class="er-warn">Sem acesso a um dos equipamentos (' + esc(d.error) + ').</div></div>'; return; }
      var ed = d.canEdit && !st.busy;
      h += '<div class="er-dev"><div class="er-head"><b>' + esc(d.name) + '</b>' + (d.canEdit ? '' : '<span class="er-badge">Somente leitura</span>') +
        '<label class="er-switch"><input type="checkbox" data-act="active" data-dev="' + esc(d.id) + '"' + (d.active ? ' checked' : '') + (ed ? '' : ' disabled') + '> Regras ativas</label></div>';
      if (!d.active) h += '<div class="er-note">Regras desligadas: o equipamento fica no manual.</div>';
      if (d.platformRules && d.platformRules.length) h += '<div class="er-warn">Regra da plataforma neste equipamento: ' + esc(d.platformRules.join(', ')) + '</div>';
      h += d.rules.length ? '<ul class="er-list">' + d.rules.map(function (r, i) {
        var c = st.confirm === r.id;
        return '<li class="' + (r.enabled ? '' : 'er-paused') + '"><span class="er-dot"></span><span class="er-text">' + (i + 1) + '. ' + esc(r.text) + '</span>' +
          (d.canEdit ? '<span class="er-actions">' + (c
            ? '<button class="er-btn er-danger" data-act="del" data-dev="' + esc(d.id) + '" data-rule="' + esc(r.id) + '"' + (ed ? '' : ' disabled') + '>Confirmar exclusão</button><button class="er-btn" data-act="nodel">Cancelar</button>'
            : '<button class="er-btn" data-act="toggle" data-dev="' + esc(d.id) + '" data-rule="' + esc(r.id) + '" data-on="' + (r.enabled ? '0' : '1') + '"' + (ed ? '' : ' disabled') + '>' + (r.enabled ? 'Pausar' : 'Retomar') + '</button>' +
              '<button class="er-btn er-danger" data-act="ask" data-rule="' + esc(r.id) + '"' + (ed ? '' : ' disabled') + '>Excluir</button>') + '</span>' : '') + '</li>';
      }).join('') + '</ul>' + (d.rules.length > 1 ? '<div class="er-note">Se duas regras valerem ao mesmo tempo, a de número maior decide.</div>' : '') : '<div class="er-empty">Nenhuma regra.</div>';
      if (d.canEdit) h += st.form && st.form.dev === d.id ? formHtml(d) : '<button class="er-btn" data-act="new" data-dev="' + esc(d.id) + '"' + (ed ? '' : ' disabled') + '>+ Nova regra</button>';
      h += '</div>';
    });
    root.innerHTML = h;
  }
  function readForm() {
    if (!st.form) return;
    root.querySelectorAll('[data-f]').forEach(function (el) { st.form[el.getAttribute('data-f')] = el.value; });
  }
  function spec() { var f = st.form; return { sensorId: f.sensorId, key: f.key, op: f.op, value: f.value, action: f.action, revert: f.revert === '' ? null : f.revert }; }
  root.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.getAttribute('data-act') === 'active') { act(req('PUT', '/iot/rules/' + el.getAttribute('data-dev') + '/active', { active: el.checked }), el.checked ? 'Regras ligadas.' : 'Regras desligadas: equipamento no manual.'); return; }
    if (el.hasAttribute('data-f')) { readForm(); st.form.preview = null; render(); }
  });
  root.addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-act'), dev = b.getAttribute('data-dev'), rule = b.getAttribute('data-rule');
    if (a === 'new') { st.form = { dev: dev, sensorId: '', key: '', op: 'gt', value: '', action: 'on', revert: '', preview: null }; st.msg = null; render(); }
    if (a === 'cancel') { st.form = null; render(); }
    if (a === 'ask') { st.confirm = rule; render(); }
    if (a === 'nodel') { st.confirm = null; render(); }
    if (a === 'preview') { readForm(); req('POST', '/iot/rules/' + dev, { rule: spec(), dryRun: true }).then(function (j) { st.form.preview = j.text; st.msg = null; render(); }).catch(function (e) { st.form.preview = null; fail(e); render(); }); }
    if (a === 'save') { readForm(); var p = req('POST', '/iot/rules/' + dev, { rule: spec() }); st.form = null; act(p, 'Regra salva. Ela já está valendo no equipamento.'); }
    if (a === 'toggle') act(req('PUT', '/iot/rules/' + dev + '/' + rule, { rule: { enabled: b.getAttribute('data-on') === '1' } }), b.getAttribute('data-on') === '1' ? 'Regra retomada.' : 'Regra pausada.');
    if (a === 'del') { st.confirm = null; act(req('DELETE', '/iot/rules/' + dev + '/' + rule), 'Regra excluída.'); }
  });
  render();
  if (ids().length) { st.started = true; load(); }
};
self.typeParameters = function () { return { dataKeysOptional: true, singleEntity: false }; };
self.onDataUpdated = function () { };
self.onDestroy = function () { };
`
const descriptor = {
  type: 'latest', sizeX: 12, sizeY: 8, resources: [],
  templateHtml: '<div class="er-root"></div>', templateCss, controllerScript,
  settingsSchema: '', dataKeySettingsSchema: '{}',
  defaultConfig: JSON.stringify({ datasources: [{ type: 'entity', name: '', dataKeys: [] }], showTitle: true, title: 'Regras do equipamento', settings: { apiUrl: API_PUBLIC, apiUrlLocal: API_LOCAL } })
}
const existing = await call('GET', `/api/widgetType?fqn=tenant.${FQN}`)
const widgetType = must(await call('POST', '/api/widgetType', existing.status === 200 && existing.json
  ? { ...existing.json, descriptor }
  : { name: 'Regras do equipamento', fqn: FQN, description: 'Pesquisador cria regras simples (se sensor acima/abaixo de X, ligar/desligar) nos próprios equipamentos; validação no backend do Embrapa I/O.', descriptor }), 'widgetType')
console.log('widget:', widgetType.fqn, existing.status === 200 ? '(atualizado)' : '(criado)')

let bundle = list(await call('GET', `/api/widgetsBundles${page}&textSearch=${encodeURIComponent('Embrapa · Regras')}`)).find(b => b.title === 'Embrapa · Regras')
if (!bundle) bundle = must(await call('POST', '/api/widgetsBundle', { title: 'Embrapa · Regras', alias: 'embrapa_regras', description: 'Widgets da Embrapa para regras de equipamentos' }), 'bundle')
const linked = await call('POST', `/api/widgetsBundle/${bundle.id.id}/widgetTypeFqns`, [widgetType.fqn])
console.log('pacote "Embrapa · Regras":', linked.status === 200 ? 'ok' : 'HTTP ' + linked.status)

// --- 3. painel
for (const d of await dashboardsNamed(TITLE)) await call('DELETE', `/api/dashboard/${d.id.id}`)
const customer = list(await call('GET', `/api/customers${page}&textSearch=${encodeURIComponent('Gado de Corte')}`))[0]
const gDash = list(await call('GET', `/api/entityGroups/CUSTOMER/${customer.id.id}/DASHBOARD`)).find(g => /PAVAP\) · Painéis$/.test(g.name))
const alias = (id, name) => { const a = crypto.randomUUID(); return [a, { id: a, alias: name, filter: { type: 'singleEntity', resolveMultiple: false, singleEntity: { entityType: 'DEVICE', id } } }] }
const [aS, xS] = alias(info.sensor.id, 'Sensor'), [aU, xU] = alias(info.umid.id, 'Umidificador'), [aA, xA] = alias(info.ac.id, 'Ar-condicionado')
const tpl = async fqn => { const t = must(await call('GET', `/api/widgetType?fqn=${fqn}`), fqn); return { type: t.descriptor.type, config: JSON.parse(t.descriptor.defaultConfig) } }
const widgets = {}, layout = {}
const add = (fqn, base, title, size, pos, config) => {
  const id = crypto.randomUUID()
  widgets[id] = { typeFullFqn: fqn, type: base.type, sizeX: size[0], sizeY: size[1], id, config: { ...base.config, title, showTitle: true, ...config, settings: { ...(base.config.settings || {}), ...(config.settings || {}) } } }
  layout[id] = { sizeX: size[0], sizeY: size[1], row: pos[0], col: pos[1] }
}
const getVal = (scope, key) => ({ action: 'GET_ATTRIBUTE', defaultValue: false, executeRpc: { method: 'getState', requestTimeout: 5000, requestPersistent: false, persistentPollingInterval: 1000 },
  getAttribute: { key, scope }, getTimeSeries: { key: 'state' }, getAlarmStatus: { severityList: null, typeList: null },
  dataToValue: { type: 'FUNCTION', compareToValue: true, dataToValueFunction: 'return data === true || data === "true";' } })
const setVal = value => ({ action: 'SET_ATTRIBUTE', executeRpc: { method: 'setState', requestTimeout: 5000, requestPersistent: false, persistentPollingInterval: 1000 },
  setAttribute: { key: 'ligar', scope: 'SHARED_SCOPE' }, putTimeSeries: { key: 'state' }, valueToData: { type: 'CONSTANT', constantValue: value, valueToDataFunction: 'return value;' } })
const nothing = { action: 'DO_NOTHING', defaultValue: false, getAttribute: { key: 'state', scope: null }, getTimeSeries: { key: 'state' }, getAlarmStatus: { severityList: null, typeList: null }, dataToValue: { type: 'NONE', compareToValue: true, dataToValueFunction: 'return data;' } }
const sw = await tpl('system.single_switch')
const swCfg = (a, label, icon) => ({ targetDevice: { type: 'entity', entityAliasId: a }, datasources: [], settings: { initialState: getVal('CLIENT_SCOPE', 'estado'), onUpdateState: setVal(true), offUpdateState: setVal(false), disabledState: nothing,
  layout: 'right', autoScale: true, showLabel: true, label, showIcon: true, icon, iconSize: 24, iconSizeUnit: 'px', showOnLabel: true, onLabel: 'Ligado', showOffLabel: true, offLabel: 'Desligado' } })
add('system.single_switch', sw, 'Umidificador (estado e manual)', [6, 3], [0, 0], swCfg(aU, 'Umidificador', 'mdi:air-humidifier'))
add('system.single_switch', sw, 'Ar-condicionado (estado e manual)', [6, 3], [0, 6], swCfg(aA, 'Ar-condicionado', 'mdi:air-conditioner'))
const ruleKey = () => ({ name: 'regras_ativas', type: 'attribute', label: 'regras_ativas', color: '#2196f3', settings: {}, _hash: Math.random() })
add('tenant.' + widgetType.fqn, { type: 'latest', config: JSON.parse(descriptor.defaultConfig) }, 'Regras dos equipamentos', [12, 10], [3, 0], {
  datasources: [aU, aA].map(a => ({ type: 'entity', name: '', entityAliasId: a, filterId: null, dataKeys: [] })), settings: { apiUrl: API_PUBLIC, apiUrlLocal: API_LOCAL } })
const chart = await tpl('system.time_series_chart')
add('system.time_series_chart', chart, 'Umidade da sala', [12, 7], [0, 12], { useDashboardTimewindow: true, units: '%', decimals: 0,
  datasources: [{ type: 'entity', name: '', entityAliasId: aS, filterId: null, dataKeys: [{ name: 'humidity', type: 'timeseries', label: 'Umidade', color: '#2196f3', settings: chart.config.datasources?.[0]?.dataKeys?.[0]?.settings || {}, _hash: Math.random() }] }] })
const configuration = {
  description: 'Teste do widget Regras do equipamento (07/11)', widgets, entityAliases: { [aS]: xS, [aU]: xU, [aA]: xA },
  states: { default: { name: TITLE, root: true, layouts: { main: { widgets: layout, gridSettings: { columns: 24, margin: 10, outerMargin: true, backgroundSizeMode: '100%' } } } } },
  timewindow: { realtime: { realtimeType: 0, timewindowMs: 1800000, interval: 10000 }, aggregation: { type: 'NONE', limit: 2000 } },
  settings: { stateControllerId: 'entity', showTitle: true, showDashboardsSelect: false, showEntitiesSelect: false, showDashboardTimewindow: true, showDashboardExport: false }
}
const dash = must(await call('POST', `/api/dashboard?entityGroupId=${gDash.id.id}`, { title: TITLE, configuration }), 'dashboard')
info.dashboardId = dash.id.id
writeFileSync(join(HERE, '.18-painel-controle.private.json'), JSON.stringify(info, null, 2))
console.log('painel:', TITLE, dash.id.id)

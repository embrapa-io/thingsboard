// Widget "Objetivos do ambiente" (07/11), segunda versão do plugin de regras: o pesquisador diz o que
// quer manter ("umidade da sala entre 40 e 60 %") e quais equipamentos aumentam ou diminuem a grandeza.
// Instala/atualiza o tipo de widget (pacote "Embrapa · Regras"), migra a sala de teste do PAVAP (troca
// as regras avulsas do teste 20 por um objetivo) e cria o painel "Teste objetivos · Sala do PAVAP".
//   node 21-widget-objetivos.mjs
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
const IO = 'http://localhost:8090'
const TITLE = 'Teste objetivos · Sala do PAVAP'
const FQN = 'embrapa_objetivos_ambiente'
// Endereço público do backend do Embrapa I/O usado pelo widget no navegador (ex.: o nome da Central no
// Tailscale). Defina IO_PUBLIC_URL no ambiente ao rodar; o padrão serve só para uso local.
const API_PUBLIC = process.env.IO_PUBLIC_URL || 'http://localhost:8090'

const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Authorization': 'ApiKey ' + ENV.THINGSBOARD_TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const must = (r, w) => { if (r.status !== 200) throw new Error(w + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const list = r => (r.json && (r.json.data || r.json)) || []
const page = '?pageSize=200&page=0'

// --- 1. migração da sala de teste, como a fdsfds (Responsável), pelas rotas do backend
const fds = list(await call('GET', `/api/user/users${page}&textSearch=fdsfds`)).find(u => u.email === 'fdsfds@embrapa.br')
const tok = must(await call('GET', `/api/user/${fds.id.id}/token`), 'token').token
const io = async (method, path, body) => { const r = await fetch(IO + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() } }
const old = await io('GET', `/iot/rules?devices=${info.umid.id},${info.ac.id}`)
for (const d of old.json.devices || []) for (const r of d.rules) if (!r.goalId) await io('DELETE', `/iot/rules/${d.id}/${r.id}`)
const goals = await io('GET', `/iot/goals?devices=${info.umid.id},${info.ac.id}`)
if (!(goals.json.goals || []).length) {
  const g = await io('POST', '/iot/goals', { goal: { sensorId: info.sensor.id, key: 'humidity', min: 40, max: 60, actuators: [{ deviceId: info.umid.id, effect: 'raise' }, { deviceId: info.ac.id, effect: 'lower' }] } })
  console.log('objetivo criado:', g.status, JSON.stringify(g.json).slice(0, 160))
} else console.log('objetivo já existe:', goals.json.goals.map(x => x.label + ' ' + x.min + '–' + x.max).join(', '))

// --- 2. o widget
const icons = {
  drop: '<svg viewBox="0 0 24 24"><path d="M12 2.7c-.3 0-.5.1-.7.3C9.4 5.2 5 10.6 5 14.6 5 18.7 8.1 22 12 22s7-3.3 7-7.4c0-4-4.4-9.4-6.3-11.6-.2-.2-.4-.3-.7-.3z"/></svg>',
  therm: '<svg viewBox="0 0 24 24"><path d="M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0zm-3 7a3 3 0 0 1-1.5-5.6l.5-.3V5a1 1 0 0 1 2 0v9.1l.5.3A3 3 0 0 1 12 20z"/></svg>',
  gauge: '<svg viewBox="0 0 24 24"><path d="M12 4a9 9 0 0 0-9 9c0 2.4.9 4.6 2.5 6.2l1.4-1.4A7 7 0 1 1 19 13a7 7 0 0 1-2 4.8l1.4 1.4A9 9 0 0 0 12 4zm4.2 4.4-4.8 3.4a1.6 1.6 0 1 0 1.9 2.4z"/></svg>'
}
const templateCss = `
.eo { --ac:#00796b; --ac2:#26a69a; --soft:#e0f2f1; --ink:#263238; --mut:#78909c; --line:#e7ebee; height:100%; overflow:auto; padding:2px; box-sizing:border-box;
  font:14px/1.4 Roboto,"Helvetica Neue",Arial,sans-serif; color:var(--ink); }
.eo * { box-sizing:border-box; }
.eo-card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin:0 0 12px; }
.eo-top { display:flex; align-items:center; gap:12px; }
.eo-ic { width:40px; height:40px; border-radius:12px; background:var(--soft); display:grid; place-items:center; flex:none; }
.eo-ic svg { width:22px; height:22px; fill:var(--ac); }
.eo-name { font-size:16px; font-weight:500; } .eo-sub { color:var(--mut); font-size:12.5px; }
.eo-auto { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:13px; color:var(--mut); cursor:pointer; user-select:none; }
.eo-auto input { display:none; }
.eo-sw { width:36px; height:20px; border-radius:10px; background:#cfd8dc; position:relative; transition:background .15s; }
.eo-sw::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); transition:left .15s; }
.eo-auto input:checked + .eo-sw { background:var(--ac); } .eo-auto input:checked + .eo-sw::after { left:18px; }
.eo-auto input:disabled + .eo-sw { opacity:.5; }
.eo-mid { display:flex; align-items:center; gap:22px; margin:16px 0 10px; }
.eo-now { flex:none; min-width:92px; } .eo-val { font-size:36px; font-weight:500; letter-spacing:-.5px; } .eo-unit { font-size:16px; color:var(--mut); margin-left:3px; }
.eo-when { font-size:12px; color:var(--mut); }
.eo-rw { flex:1; min-width:0; } .eo-target { font-size:13px; color:var(--mut); margin-bottom:10px; } .eo-target b { color:var(--ink); font-weight:500; }
.eo-bar { position:relative; height:8px; border-radius:4px; background:#eceff1; }
.eo-band { position:absolute; top:0; bottom:0; border-radius:4px; background:#80cbc4; }
.eo-mark { position:absolute; top:50%; width:16px; height:16px; margin:-8px 0 0 -8px; border-radius:50%; background:var(--ink); border:3px solid #fff; box-shadow:0 1px 3px rgba(0,0,0,.35); }
.eo-scale { display:flex; justify-content:space-between; font-size:11px; color:#b0bec5; margin-top:6px; }
.eo-status { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; padding:4px 10px; border-radius:20px; margin:2px 0 8px; }
.eo-status.ok { background:#e8f5e9; color:#2e7d32; } .eo-status.out { background:#fff3e0; color:#e65100; } .eo-status.off { background:#eceff1; color:#546e7a; }
.eo-acts { list-style:none; margin:4px 0 0; padding:0; }
.eo-acts li { display:flex; align-items:center; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
.eo-dir { width:28px; height:28px; border-radius:8px; display:grid; place-items:center; font-weight:700; flex:none; }
.eo-dir.raise { background:#e3f2fd; color:#1565c0; } .eo-dir.lower { background:#fce4ec; color:#ad1457; }
.eo-an { flex:1; min-width:0; } .eo-an b { font-weight:500; } .eo-an div { font-size:12.5px; color:var(--mut); }
.eo-chip { font-size:12px; padding:3px 10px; border-radius:20px; white-space:nowrap; display:inline-flex; align-items:center; gap:6px; }
.eo-chip::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
.eo-chip.on { background:#e8f5e9; color:#2e7d32; } .eo-chip.off { background:#eceff1; color:#78909c; } .eo-chip.na { background:#fff; color:#b0bec5; border:1px dashed #cfd8dc; }
.eo-foot { display:flex; align-items:center; gap:8px; margin-top:12px; }
.eo-ro { font-size:12px; color:var(--mut); background:#f5f7f8; border-radius:20px; padding:3px 10px; }
.eo-btn { font:inherit; font-size:13px; border:0; background:transparent; color:var(--ac); padding:6px 12px; border-radius:8px; cursor:pointer; font-weight:500; }
.eo-btn:hover { background:var(--soft); } .eo-btn[disabled] { opacity:.45; cursor:default; background:transparent; }
.eo-btn.pri { background:var(--ac); color:#fff; } .eo-btn.pri:hover { background:#00695c; }
.eo-btn.dan { color:#c62828; } .eo-btn.dan:hover { background:#ffebee; }
.eo-new { width:100%; border:1.5px dashed #b2dfdb; background:#fafdfc; color:var(--ac); border-radius:14px; padding:14px; font:inherit; font-weight:500; cursor:pointer; }
.eo-new:hover { background:var(--soft); }
.eo-empty { text-align:center; color:var(--mut); padding:22px 10px 14px; } .eo-empty b { display:block; color:var(--ink); font-weight:500; font-size:15px; margin-bottom:4px; }
.eo-msg { border-radius:10px; padding:10px 12px; margin:0 0 12px; font-size:13px; } .eo-msg.ok { background:#e8f5e9; color:#1b5e20; } .eo-msg.err { background:#ffebee; color:#b71c1c; }
.eo-msg ul { margin:4px 0 0 18px; padding:0; }
.eo-ed h3 { margin:0 0 14px; font-size:16px; font-weight:500; }
.eo-f { margin:0 0 16px; } .eo-f > label { display:block; font-size:12px; color:var(--mut); text-transform:uppercase; letter-spacing:.4px; margin-bottom:6px; }
.eo-f select, .eo-f input[type=number] { font:inherit; border:1px solid #cfd8dc; border-radius:8px; padding:8px 10px; background:#fff; color:var(--ink); }
.eo-f select { width:100%; } .eo-f input[type=number] { width:84px; text-align:center; }
.eo-f select:focus, .eo-f input:focus { outline:2px solid #80cbc4; border-color:transparent; }
.eo-ri { display:flex; align-items:center; gap:8px; margin-bottom:12px; color:var(--mut); }
.eo-dev { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--line); border-radius:10px; margin-bottom:6px; }
.eo-dev.sel { border-color:#80cbc4; background:#f7fcfb; }
.eo-dev label { flex:1; display:flex; align-items:center; gap:8px; cursor:pointer; }
.eo-seg { display:inline-flex; border:1px solid #cfd8dc; border-radius:8px; overflow:hidden; }
.eo-seg button { font:inherit; font-size:12.5px; border:0; background:#fff; color:var(--mut); padding:5px 10px; cursor:pointer; }
.eo-seg button + button { border-left:1px solid #cfd8dc; } .eo-seg button.on.raise { background:#e3f2fd; color:#1565c0; } .eo-seg button.on.lower { background:#fce4ec; color:#ad1457; }
.eo-seg button[disabled] { opacity:.4; cursor:default; }
.eo-pv { background:#f5f7f8; border-radius:10px; padding:10px 12px; font-size:13px; } .eo-pv div + div { margin-top:4px; }
.eo-row { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
`
const controllerScript = String.raw`
self.onInit = function () {
  var ctx = self.ctx, s = ctx.settings || {};
  var root = ctx.$container[0].querySelector('.eo');
  var local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  var api = String((local ? s.apiUrlLocal : s.apiUrl) || '').replace(/\/+$/, '');
  var ICONS = ${JSON.stringify(icons)};
  var st = { data: null, msg: null, edit: null, confirm: null, busy: false };
  var MSG = { IOT_RULE_READ_ONLY: 'Você só pode ver este objetivo; quem altera é o Responsável do laboratório.', IOT_RULE_SESSION_EXPIRED: 'Sua sessão expirou. Recarregue a página.', IOT_RULE_INVALID: 'Confira o objetivo:', IOT_RULE_PLATFORM_CONFLICT: 'Um equipamento já tem regra da plataforma.' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return String(Math.round(n * 10) / 10).replace('.', ','); }
  function req(method, path, body) {
    return fetch(api + path, { method: method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('jwt_token') }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.code || 'HTTP ' + r.status); e.code = j.code; e.details = j.details; throw e; } return j; }); });
  }
  function ids() { return (ctx.datasources || []).filter(function (d) { return d.entityType === 'DEVICE' && d.entityId; }).map(function (d) { return d.entityId; }).filter(function (v, i, a) { return a.indexOf(v) === i; }); }
  function fail(e) { st.msg = { type: 'err', text: MSG[e.code] || 'Não foi possível concluir (' + (e.code || e.message) + ').', details: e.details || [] }; }
  function load(quiet) {
    var list = ids();
    if (!list.length) { st.msg = { type: 'err', text: 'Escolha os equipamentos (atuadores) na fonte de dados do widget.' }; render(); return; }
    req('GET', '/iot/goals?devices=' + list.join(',')).then(function (j) { st.data = j; if (!quiet || !st.edit) render(); }).catch(function (e) { if (!quiet) { fail(e); render(); } });
  }
  function icon(key) { return /humid|umid|moist/i.test(key) ? ICONS.drop : /temp/i.test(key) ? ICONS.therm : ICONS.gauge; }
  function scale(g) {
    var w = Math.max(g.max - g.min, 1), lo = g.min - w * 0.75, hi = g.max + w * 0.75;
    if (g.unit === '%') { lo = Math.max(0, lo); hi = Math.min(100, hi); }
    if (g.current && g.current.value < lo) lo = g.current.value; if (g.current && g.current.value > hi) hi = g.current.value;
    return { lo: lo, hi: hi, p: function (v) { return Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); } };
  }
  function guess(name) { return /umidific|aquec|heater|irriga|bomba|nebuli/i.test(name) ? 'raise' : /ar.?cond|desumid|exaust|ventil|resfri|cooler/i.test(name) ? 'lower' : ''; }
  function canEditAny() { return st.data && st.data.devices.some(function (d) { return d.canEdit; }); }
  function goalCard(g) {
    var sc = scale(g), cur = g.current ? g.current.value : null, unit = esc(g.unit);
    var status = !g.enabled ? ['off', 'Automático desligado: os equipamentos ficam no manual'] : cur == null ? ['off', 'Sem leitura do sensor'] : cur < g.min ? ['out', 'Abaixo da faixa'] : cur > g.max ? ['out', 'Acima da faixa'] : ['ok', 'Dentro da faixa'];
    var h = '<div class="eo-card"><div class="eo-top"><div class="eo-ic">' + icon(g.key) + '</div><div><div class="eo-name">' + esc(g.label) + '</div><div class="eo-sub">' + esc(g.sensorName) + '</div></div>' +
      '<label class="eo-auto" title="' + (g.canEdit ? 'Ligar ou desligar o controle automático' : 'Somente o Responsável altera') + '">Automático<input type="checkbox" data-act="enabled" data-goal="' + esc(g.id) + '"' + (g.enabled ? ' checked' : '') + (g.canEdit && !st.busy ? '' : ' disabled') + '><span class="eo-sw"></span></label></div>' +
      '<div class="eo-mid"><div class="eo-now"><span class="eo-val">' + (cur == null ? '–' : num(cur)) + '</span><span class="eo-unit">' + unit + '</span><div class="eo-when">agora</div></div>' +
      '<div class="eo-rw"><div class="eo-target">Manter entre <b>' + num(g.min) + ' ' + unit + '</b> e <b>' + num(g.max) + ' ' + unit + '</b></div>' +
      '<div class="eo-bar"><div class="eo-band" style="left:' + sc.p(g.min) + '%;width:' + (sc.p(g.max) - sc.p(g.min)) + '%"></div>' + (cur == null ? '' : '<div class="eo-mark" style="left:' + sc.p(cur) + '%"></div>') + '</div>' +
      '<div class="eo-scale"><span>' + num(sc.lo) + '</span><span>' + num(sc.hi) + '</span></div></div></div>' +
      '<span class="eo-status ' + status[0] + '">' + esc(status[1]) + '</span><ul class="eo-acts">' +
      g.actuators.map(function (a) {
        var chip = a.state === true ? '<span class="eo-chip on">Ligado</span>' : a.state === false ? '<span class="eo-chip off">Desligado</span>' : '<span class="eo-chip na">sem estado</span>';
        return '<li><span class="eo-dir ' + a.effect + '" title="' + (a.effect === 'raise' ? 'aumenta' : 'diminui') + '">' + (a.effect === 'raise' ? '↑' : '↓') + '</span><div class="eo-an"><b>' + esc(a.name) + '</b><div>' + esc(a.text.replace(a.name + ' ', '')) + '</div></div>' + chip + '</li>';
      }).join('') + '</ul><div class="eo-foot">';
    if (!g.canEdit) h += '<span class="eo-ro">Somente leitura</span>';
    else if (st.confirm === g.id) h += '<span style="font-size:13px">Excluir este objetivo? Os equipamentos ficam como estão.</span><button class="eo-btn dan" data-act="del" data-goal="' + esc(g.id) + '">Sim, excluir</button><button class="eo-btn" data-act="nodel">Cancelar</button>';
    else h += '<button class="eo-btn" data-act="edit" data-goal="' + esc(g.id) + '"' + (st.busy ? ' disabled' : '') + '>Editar</button><button class="eo-btn dan" data-act="ask" data-goal="' + esc(g.id) + '"' + (st.busy ? ' disabled' : '') + '>Excluir</button>';
    return h + '</div></div>';
  }
  function editor() {
    var e = st.edit, d = st.data, metrics = [];
    d.sensors.forEach(function (sn) { sn.keys.forEach(function (k) { metrics.push({ v: sn.id + '|' + k.key, t: k.label + ' — ' + sn.name, unit: k.unit, label: k.label }); }); });
    if (!e.metric && metrics.length) e.metric = (metrics.filter(function (m) { return /humid|umid/i.test(m.v); })[0] || metrics[0]).v;
    var m = metrics.filter(function (x) { return x.v === e.metric; })[0] || { unit: '', label: '' };
    var min = parseFloat(String(e.min).replace(',', '.')), max = parseFloat(String(e.max).replace(',', '.')), ok = isFinite(min) && isFinite(max) && max - min >= 1, mid = ok ? Math.round((min + max) / 2 * 10) / 10 : null;
    var used = d.devices.filter(function (x) { return x.canEdit; });
    var lines = used.filter(function (x) { return e.devs[x.id] && e.devs[x.id].use && e.devs[x.id].effect; }).map(function (x) {
      var f = e.devs[x.id].effect; return ok ? esc(x.name) + (f === 'raise' ? ' liga abaixo de ' + num(min) : ' liga acima de ' + num(max)) + ' ' + esc(m.unit) + ' e desliga ao chegar a ' + num(mid) + ' ' + esc(m.unit) + '.' : '';
    }).filter(Boolean);
    var sc = ok ? scale({ min: min, max: max, unit: m.unit }) : null;
    return '<div class="eo-card eo-ed"><h3>' + (e.id ? 'Editar objetivo' : 'Novo objetivo') + '</h3>' +
      '<div class="eo-f"><label>O que você quer manter</label><select data-f="metric">' + metrics.map(function (x) { return '<option value="' + esc(x.v) + '"' + (x.v === e.metric ? ' selected' : '') + '>' + esc(x.t) + '</option>'; }).join('') + '</select></div>' +
      '<div class="eo-f"><label>Faixa desejada</label><div class="eo-ri">entre <input type="number" step="any" data-f="min" value="' + esc(e.min) + '"> e <input type="number" step="any" data-f="max" value="' + esc(e.max) + '"> ' + esc(m.unit) + '</div>' +
      (sc ? '<div class="eo-bar"><div class="eo-band" style="left:' + sc.p(min) + '%;width:' + (sc.p(max) - sc.p(min)) + '%"></div></div><div class="eo-scale"><span>' + num(sc.lo) + '</span><span>' + num(sc.hi) + '</span></div>' : '<div class="eo-sub">Informe o mínimo e o máximo (o máximo pelo menos 1 acima).</div>') + '</div>' +
      '<div class="eo-f"><label>Equipamentos que ajudam</label>' + used.map(function (x) {
        var dv = e.devs[x.id] || { use: false, effect: guess(x.name) };
        return '<div class="eo-dev' + (dv.use ? ' sel' : '') + '"><label><input type="checkbox" data-use="' + esc(x.id) + '"' + (dv.use ? ' checked' : '') + '> ' + esc(x.name) + '</label>' +
          '<span class="eo-seg"><button class="raise' + (dv.effect === 'raise' ? ' on' : '') + '" data-eff="raise" data-dev="' + esc(x.id) + '"' + (dv.use ? '' : ' disabled') + '>↑ aumenta</button><button class="lower' + (dv.effect === 'lower' ? ' on' : '') + '" data-eff="lower" data-dev="' + esc(x.id) + '"' + (dv.use ? '' : ' disabled') + '>↓ diminui</button></span></div>';
      }).join('') + '<div class="eo-sub">Quem aumenta liga abaixo do mínimo; quem diminui liga acima do máximo. Os dois desligam no meio da faixa.</div></div>' +
      (lines.length ? '<div class="eo-pv">' + lines.map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>' : '') +
      '<div class="eo-row"><button class="eo-btn" data-act="cancel">Cancelar</button><button class="eo-btn pri" data-act="save"' + (ok && lines.length && !st.busy ? '' : ' disabled') + '>Salvar objetivo</button></div></div>';
  }
  function render() {
    var h = '';
    if (st.msg) h += '<div class="eo-msg ' + st.msg.type + '">' + esc(st.msg.text) + (st.msg.details && st.msg.details.length ? '<ul>' + st.msg.details.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    if (!st.data) { root.innerHTML = h + (st.msg ? '' : '<div class="eo-empty">Carregando…</div>'); return; }
    if (!st.edit) st.data.goals.forEach(function (g) { h += goalCard(g); });
    if (st.edit) h += editor();
    else if (!st.data.goals.length) h += '<div class="eo-card eo-empty"><b>Nenhum objetivo ainda</b>Diga o que você quer manter, por exemplo a umidade da sala entre 40 e 60 %, e quais equipamentos ajudam.</div>';
    if (!st.edit && canEditAny()) h += '<button class="eo-new" data-act="new">+ Novo objetivo</button>';
    var editing = !!st.edit, wasEditing = root.getAttribute('data-editing') === '1';
    root.setAttribute('data-editing', editing ? '1' : '0');
    if (editing && !wasEditing) setTimeout(function () { root.scrollTop = 0; }, 0);
    root.innerHTML = h;
  }
  function readForm() { root.querySelectorAll('[data-f]').forEach(function (el) { st.edit[el.getAttribute('data-f')] = el.value; }); }
  function act(p, ok) { st.busy = true; render(); p.then(function () { st.busy = false; st.msg = ok ? { type: 'ok', text: ok } : null; load(); }).catch(function (e) { st.busy = false; fail(e); render(); }); }
  root.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.getAttribute('data-act') === 'enabled') { act(req('PUT', '/iot/goals/' + el.getAttribute('data-goal') + '/enabled', { enabled: el.checked }), el.checked ? 'Automático ligado.' : 'Automático desligado: os equipamentos ficam no manual.'); return; }
    if (el.hasAttribute('data-use')) { readForm(); var id = el.getAttribute('data-use'), dv = st.edit.devs[id] || { effect: '' }; dv.use = el.checked; if (!dv.effect) { var x = st.data.devices.filter(function (d) { return d.id === id; })[0]; dv.effect = guess(x ? x.name : ''); } st.edit.devs[id] = dv; render(); return; }
    if (el.hasAttribute('data-f')) { readForm(); render(); }
  });
  root.addEventListener('input', function (ev) { if (ev.target.hasAttribute('data-f') && ev.target.type === 'number') { st.edit[ev.target.getAttribute('data-f')] = ev.target.value; } });
  root.addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-act'), gid = b.getAttribute('data-goal');
    if (b.hasAttribute('data-eff')) { readForm(); var dev = b.getAttribute('data-dev'); st.edit.devs[dev] = { use: true, effect: b.getAttribute('data-eff') }; render(); return; }
    if (a === 'new') { st.msg = null; st.edit = { id: null, metric: '', min: '', max: '', devs: {} }; render(); }
    if (a === 'edit') { var g = st.data.goals.filter(function (x) { return x.id === gid; })[0], devs = {}; g.actuators.forEach(function (x) { devs[x.deviceId] = { use: true, effect: x.effect }; }); st.msg = null; st.edit = { id: g.id, metric: g.sensorId + '|' + g.key, min: g.min, max: g.max, devs: devs }; render(); }
    if (a === 'cancel') { st.edit = null; render(); }
    if (a === 'ask') { st.confirm = gid; render(); }
    if (a === 'nodel') { st.confirm = null; render(); }
    if (a === 'del') { st.confirm = null; act(req('DELETE', '/iot/goals/' + gid), 'Objetivo excluído.'); }
    if (a === 'save') {
      readForm(); var e = st.edit, parts = String(e.metric).split('|'), acts = [];
      Object.keys(e.devs).forEach(function (k) { if (e.devs[k].use) acts.push({ deviceId: k, effect: e.devs[k].effect }); });
      var body = { goal: { sensorId: parts[0], key: parts[1], min: e.min, max: e.max, actuators: acts } };
      var p = e.id ? req('PUT', '/iot/goals/' + e.id, body) : req('POST', '/iot/goals', body);
      st.busy = true; render();
      p.then(function () { st.busy = false; st.edit = null; st.msg = { type: 'ok', text: 'Objetivo salvo. Ele já está valendo.' }; load(); }).catch(function (err) { st.busy = false; fail(err); render(); });
    }
  });
  render(); load();
  self.timer = setInterval(function () { if (!st.busy) load(true); }, 15000);
};
self.typeParameters = function () { return { dataKeysOptional: true, singleEntity: false }; };
self.onDataUpdated = function () { };
self.onDestroy = function () { if (self.timer) clearInterval(self.timer); };
`
const descriptor = {
  type: 'latest', sizeX: 12, sizeY: 9, resources: [],
  templateHtml: '<div class="eo"></div>', templateCss, controllerScript, settingsSchema: '', dataKeySettingsSchema: '{}',
  defaultConfig: JSON.stringify({ datasources: [{ type: 'entity', name: '', dataKeys: [] }], showTitle: true, title: 'Objetivos do ambiente', settings: { apiUrl: API_PUBLIC, apiUrlLocal: IO } })
}
const existing = await call('GET', `/api/widgetType?fqn=tenant.${FQN}`)
const widgetType = must(await call('POST', '/api/widgetType', existing.status === 200 && existing.json ? { ...existing.json, descriptor }
  : { name: 'Objetivos do ambiente', fqn: FQN, description: 'O pesquisador diz o que quer manter (ex.: umidade entre 40 e 60 %) e quais equipamentos aumentam ou diminuem a grandeza; validação e instalação pelo backend do Embrapa I/O.', descriptor }), 'widgetType')
const bundle = list(await call('GET', `/api/widgetsBundles${page}&textSearch=${encodeURIComponent('Embrapa · Regras')}`)).find(b => b.title === 'Embrapa · Regras')
if (bundle) await call('POST', `/api/widgetsBundle/${bundle.id.id}/widgetTypeFqns`, ['embrapa_regras_equipamento', widgetType.fqn])
console.log('widget:', widgetType.fqn, existing.status === 200 ? '(atualizado)' : '(criado)')

// --- 3. painel (troca o do teste 20)
const customer = list(await call('GET', `/api/customers${page}&textSearch=${encodeURIComponent('Gado de Corte')}`))[0]
for (const t of [TITLE, 'Teste regras · Sala do PAVAP']) for (const d of list(await call('GET', `/api/customer/${customer.id.id}/dashboards${page}&textSearch=${encodeURIComponent(t)}`)).filter(d => d.title === t)) await call('DELETE', `/api/dashboard/${d.id.id}`)
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
const getVal = { action: 'GET_ATTRIBUTE', defaultValue: false, executeRpc: { method: 'getState', requestTimeout: 5000, requestPersistent: false, persistentPollingInterval: 1000 },
  getAttribute: { key: 'estado', scope: 'CLIENT_SCOPE' }, getTimeSeries: { key: 'state' }, getAlarmStatus: { severityList: null, typeList: null },
  dataToValue: { type: 'FUNCTION', compareToValue: true, dataToValueFunction: 'return data === true || data === "true";' } }
const setVal = value => ({ action: 'SET_ATTRIBUTE', executeRpc: { method: 'setState', requestTimeout: 5000, requestPersistent: false, persistentPollingInterval: 1000 },
  setAttribute: { key: 'ligar', scope: 'SHARED_SCOPE' }, putTimeSeries: { key: 'state' }, valueToData: { type: 'CONSTANT', constantValue: value, valueToDataFunction: 'return value;' } })
const nothing = { action: 'DO_NOTHING', defaultValue: false, getAttribute: { key: 'state', scope: null }, getTimeSeries: { key: 'state' }, getAlarmStatus: { severityList: null, typeList: null }, dataToValue: { type: 'NONE', compareToValue: true, dataToValueFunction: 'return data;' } }
const sw = await tpl('system.single_switch')
const swCfg = (a, label, icon) => ({ targetDevice: { type: 'entity', entityAliasId: a }, datasources: [], settings: { initialState: getVal, onUpdateState: setVal(true), offUpdateState: setVal(false), disabledState: nothing,
  layout: 'right', autoScale: true, showLabel: true, label, showIcon: true, icon, iconSize: 24, iconSizeUnit: 'px', showOnLabel: false, showOffLabel: false } })
add('tenant.' + widgetType.fqn, { type: 'latest', config: JSON.parse(descriptor.defaultConfig) }, 'Objetivos do ambiente', [12, 14], [0, 0], {
  datasources: [aU, aA].map(a => ({ type: 'entity', name: '', entityAliasId: a, filterId: null, dataKeys: [] })), settings: { apiUrl: API_PUBLIC, apiUrlLocal: IO } })
const chart = await tpl('system.time_series_chart')
add('system.time_series_chart', chart, 'Umidade da sala', [12, 7], [0, 12], { useDashboardTimewindow: true, units: '%', decimals: 0,
  datasources: [{ type: 'entity', name: '', entityAliasId: aS, filterId: null, dataKeys: [{ name: 'humidity', type: 'timeseries', label: 'Umidade', color: '#00796b', settings: chart.config.datasources?.[0]?.dataKeys?.[0]?.settings || {}, _hash: Math.random() }] }] })
add('system.single_switch', sw, 'Manual · Umidificador', [6, 3], [7, 12], swCfg(aU, 'Umidificador', 'mdi:air-humidifier'))
add('system.single_switch', sw, 'Manual · Ar-condicionado', [6, 3], [7, 18], swCfg(aA, 'Ar-condicionado', 'mdi:air-conditioner'))
const configuration = {
  description: 'Teste do widget Objetivos do ambiente (07/11)', widgets, entityAliases: { [aS]: xS, [aU]: xU, [aA]: xA },
  states: { default: { name: TITLE, root: true, layouts: { main: { widgets: layout, gridSettings: { columns: 24, margin: 10, outerMargin: true, backgroundSizeMode: '100%' } } } } },
  timewindow: { realtime: { realtimeType: 0, timewindowMs: 1800000, interval: 10000 }, aggregation: { type: 'NONE', limit: 2000 } },
  settings: { stateControllerId: 'entity', showTitle: true, showDashboardsSelect: false, showEntitiesSelect: false, showDashboardTimewindow: true, showDashboardExport: false }
}
const dash = must(await call('POST', `/api/dashboard?entityGroupId=${gDash.id.id}`, { title: TITLE, configuration }), 'dashboard')
info.dashboardId = dash.id.id
writeFileSync(join(HERE, '.18-painel-controle.private.json'), JSON.stringify(info, null, 2))
console.log('painel:', TITLE, dash.id.id)

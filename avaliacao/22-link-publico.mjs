// F0 do planejamento da aba Painéis (16/11): o que o "Make public" do ThingsBoard 4.4 expõe no modelo C2.
// Cria uma unidade de teste com duas localidades (grupos de dispositivos e de painéis da unidade), torna
// públicos os grupos da L1, testa pela API com o token público o que dá para ler e escrever, tira prints do
// link numa janela sem login, desfaz e apaga tudo.
//   node 22-link-publico.mjs            (roda e limpa)
//   node 22-link-publico.mjs --manter   (roda e deixa as entidades, para olhar no navegador)
//   node 22-link-publico.mjs --limpar   (só apaga o que sobrou de uma rodada anterior)
// Credencial: THINGSBOARD_TOKEN do backend/.env (ApiKey do tenant); nunca é impressa.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV = Object.fromEntries(readFileSync(join(HERE, '..', '..', 'backend', '.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
const UNIT = 'Teste F0 · Unidade link público'
const L1 = 'LOC · Teste F0 L1', L2 = 'LOC · Teste F0 L2'
const OUT = join(HERE, 'resultados')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const args = process.argv.slice(2)

const req = async (method, path, { body, auth } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (auth === undefined) headers['X-Authorization'] = 'ApiKey ' + ENV.THINGSBOARD_TOKEN
  else if (auth) headers['X-Authorization'] = 'Bearer ' + auth
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }
const data = r => (r.json && (r.json.data || r.json)) || []

// ---------- limpeza ----------
async function cleanup () {
  const found = data(await req('GET', '/api/customers?pageSize=50&page=0&textSearch=' + encodeURIComponent('Teste F0'))).filter(c => c.title === UNIT)
  for (const c of found) {
    const r = await req('DELETE', '/api/customer/' + c.id.id)
    console.log('apagada a unidade de teste', c.id.id, '→', r.status)
  }
  return found.length
}
if (args.includes('--limpar')) { console.log((await cleanup()) ? 'limpo' : 'nada a limpar'); process.exit(0) }
await cleanup()

const results = []
const check = (id, what, got, expected, note = '') => {
  const pass = Array.isArray(expected) ? expected.includes(got) : got === expected
  results.push({ id, what, got, expected, pass, note })
  console.log((pass ? 'PASS ' : 'FAIL ') + id.padEnd(4) + what + ' → ' + got + (note ? '  (' + note + ')' : ''))
}
const finding = (id, what, value) => { results.push({ id, what, got: value, finding: true }); console.log('INFO ' + id.padEnd(4) + what + ' → ' + value) }

// ---------- 1. cenário C2: unidade com duas localidades ----------
const unit = must(await req('POST', '/api/customer', { body: { title: UNIT } }), 'unidade')
const owner = { entityType: 'CUSTOMER', id: unit.id.id }
const group = async (name, type) => must(await req('POST', '/api/entityGroup', { body: { name, type, ownerId: owner } }), 'grupo ' + name)
const g = {
  dev1: await group(L1, 'DEVICE'), dash1: await group('Teste F0 L1 · Painéis', 'DASHBOARD'),
  dev2: await group(L2, 'DEVICE'), dash2: await group('Teste F0 L2 · Painéis', 'DASHBOARD')
}
const device = async (name, grp) => must(await req('POST', '/api/device?entityGroupId=' + grp.id.id, { body: { name, type: 'default', ownerId: owner, customerId: owner } }), 'sensor ' + name)
const dA = await device('Teste F0 · Sensor A (L1, no painel)', g.dev1)
const dA2 = await device('Teste F0 · Sensor A2 (L1, fora do painel)', g.dev1)
const dB = await device('Teste F0 · Sensor B (L2)', g.dev2)

// painel de base: um painel gerado pelo MCP, com os aliases trocados para o sensor A
const tenantDash = data(await req('GET', '/api/tenant/dashboards?pageSize=100&page=0&textSearch=' + encodeURIComponent('Teste')))
const baseInfo = tenantDash.find(d => d.title === 'Teste iot/mcp · Central') || tenantDash.find(d => /PoC MCP|Teste/.test(d.title))
if (!baseInfo) throw new Error('nenhum painel de base encontrado')
const base = must(await req('GET', '/api/dashboard/' + baseInfo.id.id), 'painel de base')
const conf = JSON.parse(JSON.stringify(base.configuration))
delete conf.embrapaIo
const keys = new Set()
for (const alias of Object.values(conf.entityAliases || {})) {
  if (alias.filter && alias.filter.type === 'singleEntity') alias.filter.singleEntity = { entityType: 'DEVICE', id: dA.id.id }
}
for (const w of Object.values(conf.widgets || {})) {
  for (const ds of (w.config && w.config.datasources) || []) for (const k of ds.dataKeys || []) if (k.type === 'timeseries') keys.add(k.name)
}
if (!keys.size) keys.add('temperature')
const dashboard = async (title, grp, configuration) => must(await req('POST', '/api/dashboard?entityGroupId=' + grp.id.id, { body: { title, ownerId: owner, configuration } }), 'painel ' + title)
const D1 = await dashboard('Teste F0 · Painel L1 (o do link)', g.dash1, conf)
const D2 = await dashboard('Teste F0 · Outro painel da L1', g.dash1, conf)
const D3 = await dashboard('Teste F0 · Painel da L2', g.dash2, conf)

// leituras: agora (dentro do período do painel) e 10 dias atrás (fora dele)
const now = Date.now(), old = now - 10 * 24 * 3600e3
for (const d of [dA, dA2, dB]) {
  for (const ts of [old, now - 60e3]) {
    const values = Object.fromEntries([...keys].map((k, i) => [k, ts === old ? 11 + i : 25 + i]))
    must(await req('POST', `/api/plugins/telemetry/DEVICE/${d.id.id}/timeseries/ANY`, { body: { ts, values } }), 'leitura')
  }
  must(await req('POST', `/api/plugins/telemetry/DEVICE/${d.id.id}/attributes/SERVER_SCOPE`, { body: { calibracao: 1.07, observacao: 'atributo de servidor' } }), 'atributo')
}
console.log('cenário criado: chaves', [...keys].join(', '), '· painel de base', baseInfo.title)

// ---------- 2. quem consegue tornar público um grupo da unidade ----------
// pessoas de teste da unidade: um gestor (Customer Administrators) e um Responsável da L1 ("Laboratório · Edição")
const userGroups = must(await req('GET', `/api/entityGroups/CUSTOMER/${unit.id.id}/USER`), 'grupos de usuários')
const admins = userGroups.find(x => x.name === 'Customer Administrators')
const person = async (email, grp) => must(await req('POST', `/api/user?sendActivationMail=false${grp ? '&entityGroupId=' + grp.id.id : ''}`, { body: { email, authority: 'CUSTOMER_USER', customerId: owner, ownerId: owner, firstName: 'Teste F0' } }), 'pessoa ' + email)
const tokenOf = async u => must(await req('GET', `/api/user/${u.id.id}/token`), 'token ' + u.email).token
const gestor = await person('teste.f0.gestor@example.com', admins)
const respGroup = await group('Teste F0 L1 · Responsáveis', 'USER')
const resp = await person('teste.f0.responsavel@example.com', respGroup)
const editRole = data(await req('GET', '/api/roles?pageSize=50&page=0&textSearch=' + encodeURIComponent('Laboratório · Edição'))).find(r => r.name === 'Laboratório · Edição')
for (const target of [g.dev1, g.dash1]) {
  must(await req('POST', '/api/groupPermission', { body: { roleId: editRole.id, userGroupId: respGroup.id, entityGroupId: target.id, entityGroupType: target.type } }), 'permissão do Responsável')
}
const GESTOR = await tokenOf(gestor), RESP = await tokenOf(resp)
const op = async (what, grp, auth) => (await req('POST', `/api/entityGroup/${grp.id.id}/${what}`, auth === undefined ? {} : { auth })).status
check('Q1', 'tenant (chave de serviço do backend) torna público um grupo da unidade', await op('makePublic', g.dash1), [401, 403], 'só funciona em grupo do próprio tenant')
const qResp = await op('makePublic', g.dash1, RESP)
check('Q2', 'Responsável da L1 ("Laboratório · Edição") torna público', qResp, [401, 403])
if (qResp === 200) await op('makePrivate', g.dash1, RESP)
const pubOp = async (what, grp) => { const s = await op(what, grp, GESTOR); if (s !== 200) throw new Error(what + ' pelo gestor em ' + grp.name + ': ' + s); return s }
check('Q3', 'gestor da unidade (Customer Administrators) torna público', await op('makePublic', g.dash1, GESTOR), 200)

// ---------- 3. o que o grupo de painéis público da L1 expõe ----------
const info1 = must(await req('GET', '/api/entityGroup/' + g.dash1.id.id), 'grupo L1')
const publicId = info1.additionalInfo && info1.additionalInfo.publicCustomerId
finding('P0', 'publicCustomerId do grupo de painéis da L1', publicId || '(ausente)')
const publicCustomer = publicId ? must(await req('GET', '/api/customer/' + publicId), 'customer público') : null
if (publicCustomer) finding('P0b', 'customer público criado', `"${publicCustomer.title}", dono ${publicCustomer.ownerId && publicCustomer.ownerId.entityType}${publicCustomer.ownerId && publicCustomer.ownerId.id === unit.id.id ? ' (a unidade de teste)' : ''}`)
const link = `${BASE}/dashboard/${D1.id.id}?publicId=${publicId}`
const pub = must(await req('POST', '/api/auth/login/public', { body: { publicId }, auth: null }), 'login público')
const T = pub.token
const st = async path => (await req('GET', path, { auth: T })).status
const latest = d => `/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries?keys=${[...keys].join(',')}`

check('P1', 'token público lê o painel do link', await st('/api/dashboard/' + D1.id.id), 200)
check('P2', 'lê OUTRO painel do mesmo grupo', await st('/api/dashboard/' + D2.id.id), 200, 'esperado pela documentação: o grupo inteiro fica público')
check('P3', 'lê painel da L2', await st('/api/dashboard/' + D3.id.id), [401, 403])
check('P4', 'lê telemetria do sensor A com o grupo de dispositivos ainda privado', await st(latest(dA)), [401, 403], 'o painel abre vazio')

// print 1: painel público, sensores privados
const shots = []
async function screenshot (name) {
  const PORT = 9336
  const file = join(OUT, `22-${name}-${STAMP}.png`)
  const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ['--headless=new', '--disable-gpu', '--inprivate', '--window-size=1400,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-22-'))}`, 'about:blank'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 40; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break } catch { await sleep(250) } }
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise(r => ws.addEventListener('open', r, { once: true }))
    let n = 0; const pend = new Map()
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
    const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: link })
    await sleep(15000)
    const text = await send('Runtime.evaluate', { returnByValue: true, expression: 'location.pathname + " | " + document.body.innerText.replace(/\\s+/g, " ").slice(0, 400)' })
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
    ws.close()
    const seen = text.result.result ? text.result.result.value : ''
    shots.push({ name, file, seen })
    console.log('print', name, '→', file, '\n     página:', seen.slice(0, 200))
  } catch (e) { console.log('print', name, 'falhou:', e.message) } finally { edge.kill() }
}
mkdirSync(OUT, { recursive: true })
await screenshot('painel-publico-sensores-privados')

// ---------- 4. tornar público também o grupo de dispositivos da L1 ----------
await pubOp('makePublic', g.dev1)
const info2 = must(await req('GET', '/api/entityGroup/' + g.dev1.id.id), 'grupo dispositivos L1')
check('P5', 'grupo de dispositivos usa o mesmo customer público', info2.additionalInfo && info2.additionalInfo.publicCustomerId, publicId)
const perms = await req('GET', `/api/entityGroup/${g.dev1.id.id}/groupPermissions`)
for (const p of (perms.status === 200 ? perms.json : [])) {
  const role = p.roleId ? (await req('GET', '/api/role/' + p.roleId.id)).json : null
  finding('P5b', 'papel aplicado pelo Make public no grupo de sensores', `${p.role ? p.role.name : role && role.name} (${role && role.type}): ${JSON.stringify(role && role.permissions)} · para ${p.userGroupName || (p.userGroupId && p.userGroupId.id)}`)
}
if (perms.status !== 200) finding('P5b', 'permissões do grupo de sensores', 'status ' + perms.status)
check('P6', 'lê a última leitura do sensor A', await st(latest(dA)), 200)
const hist = await req('GET', `/api/plugins/telemetry/DEVICE/${dA.id.id}/values/timeseries?keys=${[...keys][0]}&startTs=${now - 30 * 24 * 3600e3}&endTs=${now}&limit=1000`, { auth: T })
const points = hist.status === 200 ? (hist.json[[...keys][0]] || []).length : 0
check('P7', 'lê histórico de 10 dias atrás, fora do período do painel', hist.status === 200 && points >= 2 ? 'lê' : 'não lê', 'lê', `${points} pontos; o período do painel não limita a API`)
check('P8', 'lê o sensor A2, que está no grupo mas fora do painel', await st(latest(dA2)), 200, 'o grupo inteiro de sensores fica legível')
check('P9', 'lê o sensor B, da L2', await st(latest(dB)), [401, 403])
const attrs = await req('GET', `/api/plugins/telemetry/DEVICE/${dA.id.id}/values/attributes/SERVER_SCOPE`, { auth: T })
check('P10', 'lê atributos de servidor do sensor A', attrs.status === 200 ? 'lê' : 'não lê', 'lê', attrs.status === 200 ? 'inclui ' + (attrs.json || []).map(a => a.key).join(', ') : String(attrs.status))
check('P11', 'lê o token MQTT (credenciais) do sensor A', await st(`/api/device/${dA.id.id}/credentials`), [401, 403])
check('P12', 'grava telemetria no sensor A', (await req('POST', `/api/plugins/telemetry/DEVICE/${dA.id.id}/timeseries/ANY`, { body: { x: 1 }, auth: T })).status, [401, 403])
check('P13', 'grava atributo compartilhado (comando por atributo)', (await req('POST', `/api/plugins/telemetry/DEVICE/${dA.id.id}/attributes/SHARED_SCOPE`, { body: { alvo: 1 }, auth: T })).status, [401, 403])
// RPC: o oneway comum responde 409 quando o sensor está offline, DEPOIS de checar a permissão; o persistente
// é aceito (200 + rpcId) mesmo offline, então mostra se a permissão passou. O sensor B (L2) é o controle.
const rpc = async d => req('POST', `/api/plugins/rpc/oneway/${d.id.id}`, { body: { method: 'setValue', params: true, persistent: true, timeout: 60000 }, auth: T })
const rpcA = await rpc(dA), rpcB = await rpc(dB)
check('P14', 'envia comando RPC (persistente) ao sensor A, do grupo público', rpcA.status, [401, 403], rpcA.status === 200 ? 'aceito, rpcId ' + (rpcA.json && rpcA.json.rpcId) : rpcA.text.slice(0, 120))
check('P14b', 'controle: RPC ao sensor B, de grupo privado', rpcB.status, [401, 403])
if (rpcA.status === 200 && rpcA.json && rpcA.json.rpcId) {
  const queued = await req('GET', `/api/rpc/persistent/${rpcA.json.rpcId}`)
  finding('P14c', 'comando do visitante na fila do sensor A (visto pelo tenant)', queued.status === 200 ? queued.json.status + ', método ' + (queued.json.request && queued.json.request.body && queued.json.request.body.method) : 'status ' + queued.status)
}
// mitigação: tirar RPC_CALL do papel público, só se o papel for da unidade de teste (nunca do tenant)
const pubPerm = (perms.status === 200 ? perms.json : []).find(p => p.role ? /Public/.test(p.role.name) : true)
const pubRole = pubPerm && pubPerm.roleId ? (await req('GET', '/api/role/' + pubPerm.roleId.id)).json : null
const roleOwner = pubRole && pubRole.ownerId ? pubRole.ownerId.entityType + ' ' + (pubRole.ownerId.id === unit.id.id ? '(a unidade de teste)' : pubRole.ownerId.id === publicId ? '(o customer público da unidade)' : pubRole.ownerId.id) : '?'
finding('M0', 'dono do papel "' + (pubRole && pubRole.name) + '"', roleOwner)
if (pubRole && pubRole.ownerId && [unit.id.id, publicId].includes(pubRole.ownerId.id)) {
  const edited = await req('POST', '/api/role', { body: { ...pubRole, permissions: pubRole.permissions.filter(x => x !== 'RPC_CALL') } })
  check('M1', 'tenant tira RPC_CALL do papel público da unidade', edited.status, 200)
  await sleep(1500)
  check('M2', 'depois disso, RPC do visitante ao sensor A', (await rpc(dA)).status, [401, 403])
  check('M3', 'depois disso, o visitante ainda lê os dados', await st(latest(dA)), 200)
  const reread = (await req('GET', '/api/role/' + pubRole.id.id)).json
  finding('M4', 'papel relido depois da edição', JSON.stringify(reread && reread.permissions))
  const fresh = must(await req('POST', '/api/auth/login/public', { body: { publicId }, auth: null }), 'novo login público').token
  const rpcFresh = await req('POST', `/api/plugins/rpc/oneway/${dA.id.id}`, { body: { method: 'setValue', params: true, persistent: true, timeout: 60000 }, auth: fresh })
  check('M5', 'RPC com token público NOVO, emitido depois da edição', rpcFresh.status, [401, 403])
  check('M6', 'token novo ainda lê os dados', (await req('GET', latest(dA), { auth: fresh })).status, 200)
} else finding('M1', 'mitigação não testada', 'o papel não é da unidade de teste; mexer nele afetaria o tenant inteiro')

check('P15', 'altera o painel', (await req('POST', '/api/dashboard', { body: { ...must(await req('GET', '/api/dashboard/' + D1.id.id, { auth: T }), 'ler'), title: 'alterado' }, auth: T })).status, [401, 403])
const users = await req('GET', '/api/user/users?pageSize=50&page=0', { auth: T })
check('P16', 'lista usuários da unidade', users.status === 200 && data(users).some(u => /teste\.f0\.(gestor|responsavel)/.test(u.email)) ? 'vê pessoas da unidade' : 'não vê pessoas da unidade', 'não vê pessoas da unidade',
  users.status === 200 ? 'status 200, lista: ' + (data(users).map(u => u.email).join(', ') || '(vazia)') : 'status ' + users.status)
check('P17', 'lista customers', await st('/api/customers?pageSize=10&page=0'), [401, 403])
check('P18', 'lista sensores do tenant', await st('/api/tenant/devices?pageSize=10&page=0'), [401, 403])
const vis = await req('GET', '/api/user/devices?pageSize=50&page=0', { auth: T })
finding('P19', 'sensores que o token público enumera (/api/user/devices)', vis.status === 200 ? data(vis).map(d => d.name).join(' | ') || '(nenhum)' : 'status ' + vis.status)
const visD = await req('GET', '/api/user/dashboards?pageSize=50&page=0', { auth: T })
finding('P20', 'painéis que o token público enumera (/api/user/dashboards)', visD.status === 200 ? data(visD).map(d => d.title).join(' | ') || '(nenhum)' : 'status ' + visD.status)

// print 2: painel e sensores públicos
await screenshot('painel-e-sensores-publicos')

// ---------- 5. C2: outra localidade da mesma unidade fica pública ----------
await pubOp('makePublic', g.dash2)
const info3 = must(await req('GET', '/api/entityGroup/' + g.dash2.id.id), 'grupo L2')
check('P21', 'L2 usa o MESMO customer público da L1', info3.additionalInfo && info3.additionalInfo.publicCustomerId, publicId, 'um publicId por unidade')
check('P22', 'link da L1 passa a ler o painel da L2', await st('/api/dashboard/' + D3.id.id), 200, 'quem tem um link vê todos os grupos públicos da unidade')
await pubOp('makePrivate', g.dash2)
check('P23', 'L2 volta a privado e o link da L1 perde o painel da L2', await st('/api/dashboard/' + D3.id.id), [401, 403])

// ---------- 6. desfazer (Make private) ----------
await pubOp('makePrivate', g.dash1)
await pubOp('makePrivate', g.dev1)
check('P24', 'token público já emitido perde o painel na hora', await st('/api/dashboard/' + D1.id.id), [401, 403])
check('P25', 'token público já emitido perde os dados na hora', await st(latest(dA)), [401, 403])
const again = await req('POST', '/api/auth/login/public', { body: { publicId }, auth: null })
finding('P26', 'novo login com o mesmo publicId depois de desfazer', again.status === 200 ? 'emite token (o customer público continua existindo), mas sem acesso: ' + (await req('GET', '/api/dashboard/' + D1.id.id, { auth: again.json.token })).status : 'status ' + again.status)

// ---------- resultado ----------
const pass = results.filter(r => !r.finding && r.pass).length, total = results.filter(r => !r.finding).length
const report = { when: new Date().toISOString(), base: BASE, link: link.replace(publicId, '<publicId>'), keys: [...keys], baseDashboard: baseInfo.title, pass, total, results, shots: shots.map(s => ({ name: s.name, file: s.file, seen: s.seen.slice(0, 300) })) }
const file = join(OUT, `22-link-publico-${STAMP}.json`)
writeFileSync(file, JSON.stringify(report, null, 2))
console.log(`\n${pass}/${total} PASS · resultado em ${file}`)

if (args.includes('--manter')) console.log('entidades mantidas; link público desfeito. Para apagar: node 22-link-publico.mjs --limpar')
else { await cleanup(); const left = data(await req('GET', '/api/customers?pageSize=50&page=0&textSearch=' + encodeURIComponent('Teste F0'))).length; console.log('limpeza: restam', left, 'customers "Teste F0"') }

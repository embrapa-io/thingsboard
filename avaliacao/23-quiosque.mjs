// Alternativa à tela fixa por link público (ver 22-link-publico.mjs): uma "conta de quiosque" por tela,
// só com "Laboratório · Leitura" nos grupos de uma localidade, aberta por token emitido pelo backend.
// Testa: (1) sem RPC e só a localidade; (2) a rota /dashboard/<id> mostra só o painel, sem o menu;
// (3) a sessão se renova sozinha (conta ativada) e o refresh desliza; (4) revogar corta na hora.
//   node 23-quiosque.mjs           (roda e limpa)
//   node 23-quiosque.mjs --limpar  (só apaga sobras de uma rodada anterior)
// Credencial: THINGSBOARD_TOKEN do backend/.env (ApiKey do tenant); nunca é impressa.
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV = Object.fromEntries(readFileSync(join(HERE, '..', '..', 'backend', '.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
// endereço que o navegador usa (o mesmo THINGSBOARD_PUBLIC_URL do backend da Central)
const PUB = process.env.TB_PUBLIC_URL || 'http://cpcg-237765.taild317c.ts.net:9090'
const UNIT = 'Teste quiosque · Unidade'
const OUT = join(HERE, 'resultados')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
const jwt = t => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString())
const hours = s => (s / 3600).toFixed(1).replace('.0', '') + ' h'

async function cleanup () {
  const found = data(await req('GET', '/api/customers?pageSize=50&page=0&textSearch=' + encodeURIComponent('Teste quiosque'))).filter(c => c.title === UNIT)
  for (const c of found) console.log('apagada a unidade de teste', c.id.id, '→', (await req('DELETE', '/api/customer/' + c.id.id)).status)
  return found.length
}
if (process.argv.includes('--limpar')) { console.log((await cleanup()) ? 'limpo' : 'nada a limpar'); process.exit(0) }
await cleanup()

const results = []
const check = (id, what, got, expected, note = '') => {
  const pass = Array.isArray(expected) ? expected.includes(got) : got === expected
  results.push({ id, what, got, expected, pass, note })
  console.log((pass ? 'PASS ' : 'FAIL ') + id.padEnd(4) + what + ' → ' + got + (note ? '  (' + note + ')' : ''))
}
const finding = (id, what, value) => { results.push({ id, what, got: value, finding: true }); console.log('INFO ' + id.padEnd(4) + what + ' → ' + value) }

// ---------- cenário: unidade com duas localidades ----------
const unit = must(await req('POST', '/api/customer', { body: { title: UNIT } }), 'unidade')
const owner = { entityType: 'CUSTOMER', id: unit.id.id }
const group = async (name, type) => must(await req('POST', '/api/entityGroup', { body: { name, type, ownerId: owner } }), 'grupo ' + name)
const g = { dev1: await group('LOC · Quiosque L1', 'DEVICE'), dash1: await group('Quiosque L1 · Painéis', 'DASHBOARD'), dev2: await group('LOC · Quiosque L2', 'DEVICE'), dash2: await group('Quiosque L2 · Painéis', 'DASHBOARD') }
const device = async (name, grp) => must(await req('POST', '/api/device?entityGroupId=' + grp.id.id, { body: { name, type: 'default', ownerId: owner, customerId: owner } }), 'sensor ' + name)
const dA = await device('Quiosque · Sensor A (L1)', g.dev1)
const dB = await device('Quiosque · Sensor B (L2)', g.dev2)

const tenantDash = data(await req('GET', '/api/tenant/dashboards?pageSize=100&page=0&textSearch=' + encodeURIComponent('Teste')))
const baseInfo = tenantDash.find(d => d.title === 'Teste iot/mcp · Central') || tenantDash.find(d => /PoC MCP|Teste/.test(d.title))
const conf = JSON.parse(JSON.stringify(must(await req('GET', '/api/dashboard/' + baseInfo.id.id), 'painel de base').configuration))
delete conf.embrapaIo
const keys = new Set()
for (const a of Object.values(conf.entityAliases || {})) if (a.filter && a.filter.type === 'singleEntity') a.filter.singleEntity = { entityType: 'DEVICE', id: dA.id.id }
for (const w of Object.values(conf.widgets || {})) for (const ds of (w.config && w.config.datasources) || []) for (const k of ds.dataKeys || []) if (k.type === 'timeseries') keys.add(k.name)
if (!keys.size) keys.add('temperature')
if (conf.states) for (const st of Object.values(conf.states)) st.name = 'Tela fixa · L1'
const dashboard = async (title, grp) => must(await req('POST', '/api/dashboard?entityGroupId=' + grp.id.id, { body: { title, ownerId: owner, configuration: conf } }), 'painel ' + title)
const D1 = await dashboard('Quiosque · Painel da L1', g.dash1)
const D1b = await dashboard('Quiosque · Outro painel da L1', g.dash1)
const D3 = await dashboard('Quiosque · Painel da L2', g.dash2)
const now = Date.now()
for (const d of [dA, dB]) must(await req('POST', `/api/plugins/telemetry/DEVICE/${d.id.id}/timeseries/ANY`, { body: { ts: now - 60e3, values: Object.fromEntries([...keys].map((k, i) => [k, 25 + i])) } }), 'leitura')

// ---------- conta de quiosque: ativada, senha aleatória, "Laboratório · Leitura" só na L1 ----------
const role = data(await req('GET', '/api/roles?pageSize=50&page=0&textSearch=' + encodeURIComponent('Laboratório · Leitura'))).find(r => r.name === 'Laboratório · Leitura')
finding('K0', 'operações do papel "Laboratório · Leitura"', JSON.stringify(role.permissions))
check('K1', 'o papel não tem RPC_CALL', (role.permissions || []).includes('RPC_CALL') || (role.permissions || []).includes('ALL') ? 'tem' : 'não tem', 'não tem')
const telas = await group('Quiosque L1 · Telas', 'USER')
for (const target of [g.dev1, g.dash1]) must(await req('POST', '/api/groupPermission', { body: { roleId: role.id, userGroupId: telas.id, entityGroupId: target.id, entityGroupType: target.type } }), 'permissão da tela')
const newUser = async (email, grp) => must(await req('POST', `/api/user?sendActivationMail=false&entityGroupId=${grp.id.id}`, { body: { email, authority: 'CUSTOMER_USER', customerId: owner, ownerId: owner, firstName: 'Tela', lastName: 'Porta da sala' } }), 'conta ' + email)
const kiosk = await newUser('tela.quiosque.l1@example.com', telas)
// ativação com senha que ninguém guarda
let activateToken = null
for (const p of [`/api/user/${kiosk.id.id}/activationLinkInfo`, `/api/user/${kiosk.id.id}/activationLink`]) {
  const r = await req('GET', p)
  const txt = r.json && r.json.value ? r.json.value : r.text
  const m = /activateToken=([^&"\s]+)/.exec(txt || '')
  if (r.status === 200 && m) { activateToken = decodeURIComponent(m[1]); break }
}
const act = activateToken ? await req('POST', '/api/noauth/activate?sendActivationMail=false', { body: { activateToken, password: crypto.randomBytes(24).toString('base64url') + 'aA1!' }, auth: null }) : { status: 0 }
check('K2', 'conta da tela ativada com senha aleatória', act.status, 200)
// controle: a mesma conta sem ativar (para a renovação)
const inactive = await newUser('tela.inativa.l1@example.com', telas)

// o que o backend faria ao abrir o link /tela/<código>: token da conta (IMPERSONATE)
const issue = async u => must(await req('GET', `/api/user/${u.id.id}/token`), 'token ' + u.email)
const K = await issue(kiosk)
const st = async (path, t = K.token) => (await req('GET', path, { auth: t })).status
const latest = d => `/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries?keys=${[...keys].join(',')}`

// ---------- 1. alcance e comando ----------
check('A1', 'tela lê o painel da L1', await st('/api/dashboard/' + D1.id.id), 200)
check('A2', 'tela lê os dados do sensor A (L1)', await st(latest(dA)), 200)
check('A3', 'tela lê o painel da L2', await st('/api/dashboard/' + D3.id.id), [401, 403])
check('A4', 'tela lê os dados do sensor B (L2)', await st(latest(dB)), [401, 403])
const rpc = await req('POST', `/api/plugins/rpc/oneway/${dA.id.id}`, { body: { method: 'setValue', params: true, persistent: true, timeout: 60000 }, auth: K.token })
check('A5', 'tela manda comando RPC (persistente) ao sensor A', rpc.status, [401, 403], rpc.status === 200 ? 'aceito!' : '')
check('A6', 'tela grava atributo compartilhado (comando por atributo)', (await req('POST', `/api/plugins/telemetry/DEVICE/${dA.id.id}/attributes/SHARED_SCOPE`, { body: { alvo: 1 }, auth: K.token })).status, [401, 403])
check('A7', 'tela grava telemetria', (await req('POST', `/api/plugins/telemetry/DEVICE/${dA.id.id}/timeseries/ANY`, { body: { x: 1 }, auth: K.token })).status, [401, 403])
check('A8', 'tela lê o token MQTT do sensor', await st(`/api/device/${dA.id.id}/credentials`), [401, 403])
check('A9', 'tela altera o painel', (await req('POST', '/api/dashboard', { body: { ...must(await req('GET', '/api/dashboard/' + D1.id.id, { auth: K.token }), 'ler'), title: 'alterado' }, auth: K.token })).status, [401, 403])
const users = await req('GET', '/api/user/users?pageSize=50&page=0', { auth: K.token })
check('A10', 'tela lista pessoas', users.status === 200 && data(users).length ? 'lista' : 'não lista', 'não lista', 'status ' + users.status)
finding('A11', 'painéis que a tela enumera', data(await req('GET', '/api/user/dashboards?pageSize=50&page=0', { auth: K.token })).map(d => d.title).join(' | '))

// ---------- 2. navegador: /dashboard/<id> (só o painel) e /dashboards/<id> (com menu) ----------
mkdirSync(OUT, { recursive: true })
const shots = []
async function browse (pages) {
  const PORT = 9338
  const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ['--headless=new', '--disable-gpu', '--window-size=1400,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-23-'))}`, 'about:blank'], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 40; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break } catch { await sleep(250) } }
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise(r => ws.addEventListener('open', r, { once: true }))
    let n = 0; const pend = new Map()
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
    const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    for (const p of pages) {
      await send('Page.navigate', { url: p.url })
      await sleep(14000)
      const v = await send('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify({ path: location.pathname, menu: !!document.querySelector("tb-side-menu, mat-sidenav.tb-site-sidenav, .tb-side-menu"), text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 300) })' })
      const info = JSON.parse(v.result.result.value)
      const file = join(OUT, `23-${p.name}-${STAMP}.png`)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      shots.push({ name: p.name, file, ...info })
      console.log('print', p.name, '→', file, '\n     ', JSON.stringify(info).slice(0, 260))
      if (p.after) await p.after(send)
    }
    ws.close()
  } finally { edge.kill() }
}
const B = await issue(kiosk)
await browse([
  { name: 'rota-singular-dashboard', url: `${PUB}/dashboard/${D1.id.id}?accessToken=${B.token}&refreshToken=${B.refreshToken}` },
  { name: 'rota-plural-dashboards', url: `${PUB}/dashboards/${D1.id.id}?accessToken=${B.token}&refreshToken=${B.refreshToken}` }
])
const single = shots.find(s => s.name === 'rota-singular-dashboard'), plural = shots.find(s => s.name === 'rota-plural-dashboards')
check('B1', '/dashboard/<id> abre logado no painel', single && single.path.startsWith('/dashboard/') && !/login/i.test(single.path) ? 'abre' : 'não abre (' + (single && single.path) + ')', 'abre')
check('B2', '/dashboard/<id> sem o menu lateral do ThingsBoard', single && !single.menu && !/Devices & assets|Customers & users/.test(single.text) ? 'sem menu' : 'com menu', 'sem menu')
finding('B3', '/dashboards/<id> (plural), para comparar', plural ? (plural.menu || /Devices & assets/.test(plural.text) ? 'com menu lateral' : 'sem menu') : '?')

// ---------- 3. renovação da sessão ----------
const pa = jwt(K.token), pr = jwt(K.refreshToken)
finding('C0', 'validade do token de acesso / do refresh token', hours(pa.exp - pa.iat) + ' / ' + hours(pr.exp - pr.iat))
await sleep(2000)
const ref = await req('POST', '/api/auth/token', { body: { refreshToken: K.refreshToken }, auth: null })
check('C1', 'conta ativada renova a sessão pelo refresh token', ref.status, 200)
if (ref.status === 200) {
  const nr = jwt(ref.json.refreshToken)
  check('C2', 'o refresh devolve um refresh token novo, com prazo contado de agora (sessão desliza)', nr.exp > pr.exp ? 'desliza' : 'não desliza', 'desliza', `antes vencia ${new Date(pr.exp * 1000).toISOString()}, agora ${new Date(nr.exp * 1000).toISOString()}`)
  check('C3', 'o token renovado continua lendo o painel', await st('/api/dashboard/' + D1.id.id, ref.json.token), 200)
}
const KI = await issue(inactive)
const refI = await req('POST', '/api/auth/token', { body: { refreshToken: KI.refreshToken }, auth: null })
check('C4', 'controle: conta NÃO ativada renova a sessão', refI.status, [401, 403], 'por isso a conta da tela precisa ser ativada')

// ---------- 4. revogar ----------
const K2 = ref.status === 200 ? ref.json : K
must(await req('POST', `/api/entityGroup/${telas.id.id}/deleteEntities`, { body: [kiosk.id.id] }), 'tirar a tela do grupo')
check('R1', 'depois de tirar a conta do grupo: o token já emitido perde o painel', await st('/api/dashboard/' + D1.id.id, K2.token), [401, 403])
check('R2', 'depois de tirar a conta do grupo: perde os dados', await st(latest(dA), K2.token), [401, 403])
const after = await req('POST', '/api/auth/token', { body: { refreshToken: K2.refreshToken }, auth: null })
finding('R3', 'refresh depois de tirar do grupo', after.status === 200 ? 'renova, mas sem acesso: ' + (await st('/api/dashboard/' + D1.id.id, after.json.token)) : 'status ' + after.status)
must(await req('DELETE', '/api/user/' + kiosk.id.id), 'apagar a conta da tela')
check('R4', 'depois de apagar a conta: o token já emitido para de funcionar', await st('/api/dashboard/' + D1.id.id, K2.token), [401, 403])
check('R5', 'depois de apagar a conta: o refresh falha', (await req('POST', '/api/auth/token', { body: { refreshToken: K2.refreshToken }, auth: null })).status, [401, 403])

// ---------- resultado ----------
const pass = results.filter(r => !r.finding && r.pass).length, total = results.filter(r => !r.finding).length
const file = join(OUT, `23-quiosque-${STAMP}.json`)
writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), base: BASE, pub: PUB, pass, total, results, shots }, null, 2))
console.log(`\n${pass}/${total} PASS · resultado em ${file}`)
await cleanup()
console.log('limpeza: restam', data(await req('GET', '/api/customers?pageSize=50&page=0&textSearch=' + encodeURIComponent('Teste quiosque'))).length, 'customers "Teste quiosque"')

// Tela fixa do PAVAP com a conta de quiosque (ver 23-quiosque.mjs), na Central real:
// cria (ou reaproveita) a conta "Tela PAVAP · Porta da sala" num grupo "<PAVAP> · Telas" com
// "Laboratório · Leitura" só nos grupos de dispositivos e de painéis do PAVAP, abre os painéis na rota
// /dashboard/<id> em tamanho de tablet e salva os prints. Não altera os grupos, painéis nem pessoas existentes.
//   node 24-tela-pavap.mjs                 (prints; mantém a conta)
//   node 24-tela-pavap.mjs --abrir         (também abre a tela numa janela InPrivate do Edge, ao vivo)
//   node 24-tela-pavap.mjs --remover       (apaga a conta e o grupo "· Telas")
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
const PUB = process.env.TB_PUBLIC_URL || 'http://cpcg-237765.taild317c.ts.net:9090'
const LAB = 'Laboratório de Parasitologia Veterinária Aplicada (PAVAP)'
const EMAIL = 'tela.pavap.porta@example.com'
const PANELS = ['PAVAP · Monitoramento', 'Sala do PAVAP']
const OUT = join(HERE, 'resultados')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const args = process.argv.slice(2)

const req = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Authorization': 'ApiKey ' + ENV.THINGSBOARD_TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.status + ' ' + r.text.slice(0, 300)); return r.json }

const unit = must(await req('GET', '/api/customers?pageSize=100&page=0&textSearch=' + encodeURIComponent('Gado de Corte')), 'unidade').data.find(c => c.title === 'Embrapa Gado de Corte')
const owner = { entityType: 'CUSTOMER', id: unit.id.id }
const groups = async type => must(await req('GET', `/api/entityGroups/CUSTOMER/${unit.id.id}/${type}`), 'grupos ' + type)
const devGroup = (await groups('DEVICE')).find(x => x.name === LAB + ' · Dispositivos')
const dashGroup = (await groups('DASHBOARD')).find(x => x.name === LAB + ' · Painéis')
let telas = (await groups('USER')).find(x => x.name === LAB + ' · Telas')
const existing = must(await req('GET', '/api/user/users?pageSize=20&page=0&textSearch=' + encodeURIComponent(EMAIL)), 'busca').data.find(u => u.email === EMAIL)

if (args.includes('--remover')) {
  if (existing) console.log('conta da tela apagada →', (await req('DELETE', '/api/user/' + existing.id.id)).status)
  if (telas) console.log('grupo "· Telas" apagado →', (await req('DELETE', '/api/entityGroup/' + telas.id.id)).status)
  if (!existing && !telas) console.log('nada a remover')
  process.exit(0)
}

// grupo "· Telas" com "Laboratório · Leitura" (sem RPC) nos grupos do PAVAP
if (!telas) {
  telas = must(await req('POST', '/api/entityGroup', { name: LAB + ' · Telas', type: 'USER', ownerId: owner }), 'grupo Telas')
  const role = must(await req('GET', '/api/roles?pageSize=50&page=0&textSearch=' + encodeURIComponent('Laboratório · Leitura')), 'papel').data.find(r => r.name === 'Laboratório · Leitura')
  for (const target of [devGroup, dashGroup]) must(await req('POST', '/api/groupPermission', { roleId: role.id, userGroupId: telas.id, entityGroupId: target.id, entityGroupType: target.type }), 'permissão')
  console.log('grupo criado:', telas.name)
}
let kiosk = existing
if (!kiosk) {
  kiosk = must(await req('POST', `/api/user?sendActivationMail=false&entityGroupId=${telas.id.id}`, { email: EMAIL, authority: 'CUSTOMER_USER', customerId: owner, ownerId: owner, firstName: 'Tela PAVAP', lastName: 'Porta da sala' }), 'conta')
  let token = null
  for (const p of [`/api/user/${kiosk.id.id}/activationLinkInfo`, `/api/user/${kiosk.id.id}/activationLink`]) {
    const r = await req('GET', p); const m = /activateToken=([^&"\s]+)/.exec((r.json && r.json.value) || r.text || '')
    if (r.status === 200 && m) { token = decodeURIComponent(m[1]); break }
  }
  const act = await fetch(BASE + '/api/noauth/activate?sendActivationMail=false', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activateToken: token, password: crypto.randomBytes(24).toString('base64url') + 'aA1!' }) })
  console.log('conta criada e ativada:', EMAIL, '→', act.status)
} else console.log('conta já existia:', EMAIL)

// o que o backend faria ao abrir /tela/<código>
const tok = must(await req('GET', `/api/user/${kiosk.id.id}/token`), 'token da tela')
const panels = must(await req('GET', `/api/entityGroup/${dashGroup.id.id}/dashboards?pageSize=50&page=0`), 'painéis').data
const urlOf = d => `${PUB}/dashboard/${d.id.id}?accessToken=${tok.token}&refreshToken=${tok.refreshToken}`

mkdirSync(OUT, { recursive: true })
const PORT = 9339
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-gpu', '--window-size=1280,800', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-24-'))}`, 'about:blank'], { stdio: 'ignore' })
try {
  for (let i = 0; i < 40; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break } catch { await sleep(250) } }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let n = 0; const pend = new Map()
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const sizes = [{ name: 'tablet-horizontal', width: 1280, height: 800 }, { name: 'tablet-vertical', width: 800, height: 1280 }]
  for (const title of PANELS) {
    const d = panels.find(x => x.title === title)
    if (!d) { console.log('painel não encontrado:', title); continue }
    for (const sz of sizes) {
      await send('Emulation.setDeviceMetricsOverride', { width: sz.width, height: sz.height, deviceScaleFactor: 1, mobile: false })
      await send('Page.navigate', { url: urlOf(d) })
      await sleep(15000)
      const v = await send('Runtime.evaluate', { returnByValue: true, expression: 'location.pathname + " | " + document.body.innerText.replace(/\\s+/g, " ").slice(0, 200)' })
      const file = join(OUT, `24-${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${sz.name}-${STAMP}.png`)
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      console.log('print', title, sz.name, '→', file, '\n     ', v.result.result.value)
    }
  }
  ws.close()
} finally { edge.kill() }

if (args.includes('--abrir')) {
  const d = panels.find(x => x.title === PANELS[0])
  spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--inprivate', '--new-window', urlOf(d)], { detached: true, stdio: 'ignore' }).unref()
  console.log('aberto numa janela InPrivate do Edge:', PANELS[0])
}
console.log('\nPara apagar a conta e o grupo: node 24-tela-pavap.mjs --remover')

// Opção 1 de regras sem usuário do tenant (07/11): a PLATAFORMA instala no atuador uma
// regra modelo (campo calculado) e o Responsável, usuário da unidade (CUSTOMER_USER), só
// ajusta os parâmetros (atributos de servidor do atuador). Usa os papéis reais
// "Laboratório · Edição" e "Laboratório · Leitura". Roda na Central, com entidades
// "rbac17" apagadas no fim. A parte do Edge já foi provada no 09 (E1/E2) e no 10.
// Credencial: THINGSBOARD_TOKEN (chave de API do tenant) do backend/.env; nunca é impressa.
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND_ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env')
const ENV = Object.fromEntries(readFileSync(BACKEND_ENV, 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
const P = 'rbac17'
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
const msg = r => r.status + (r.status === 200 ? '' : ' ' + ((r.json && r.json.message) || r.text.slice(0, 140)))
const out = []
const log = (id, ok, text) => { out.push({ id, ok }); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${text}`) }

const limpar = async () => {
  for (const d of list(await T('GET', `/api/deviceInfos/all${page}&includeCustomers=true&textSearch=${P}`))) await T('DELETE', `/api/device/${d.id.id}`)
  for (const u of list(await T('GET', `/api/user/users${page}&textSearch=${P}`))) await T('DELETE', `/api/user/${u.id.id}`)
  for (const c of list(await T('GET', `/api/customers${page}&textSearch=${P}`))) await T('DELETE', `/api/customer/${c.id.id}`)
}

await limpar()
try {
  const roles = list(await T('GET', `/api/roles${page}`))
  const rEdit = roles.find(r => r.name === 'Laboratório · Edição'), rRead = roles.find(r => r.name === 'Laboratório · Leitura')
  if (!rEdit || !rRead) throw new Error('papéis Laboratório · Edição/Leitura não encontrados')

  const A = must(await T('POST', '/api/customer', { title: `${P} Unidade A` }), 'customer')
  const grp = async (name, type) => must(await T('POST', '/api/entityGroup', { name: `${P} ${name}`, type, ownerId: A.id }), name)
  const L1 = await grp('L1 · Dispositivos', 'DEVICE'), L2 = await grp('L2 · Dispositivos', 'DEVICE')
  const dev = async (g, name) => must(await T('POST', `/api/device?entityGroupId=${g.id.id}`, { name: `${P}-${name}`, type: 'default' }), name)
  const sensor = await dev(L1, 'l1-sensor-umidade'), umid = await dev(L1, 'l1-umidificador'), outro = await dev(L2, 'l2-umidificador')
  const tok = async d => must(await T('GET', `/api/device/${d.id.id}/credentials`), 'cred').credentialsId
  const tokSensor = await tok(sensor), tokUmid = await tok(umid)

  const ugR = await grp('L1 · Responsáveis', 'USER'), ugE = await grp('L1 · Equipe', 'USER')
  must(await T('POST', '/api/groupPermission', { roleId: rEdit.id, userGroupId: ugR.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' }), 'gpR')
  must(await T('POST', '/api/groupPermission', { roleId: rRead.id, userGroupId: ugE.id, entityGroupId: L1.id, entityGroupType: 'DEVICE' }), 'gpE')
  const user = async (nome, g) => {
    const u = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${g.id.id}`, { email: `${P}-${nome}@tb44.local`, authority: 'CUSTOMER_USER', customerId: A.id }), nome)
    const link = await T('GET', `/api/user/${u.id.id}/activationLink`)
    const pwd = crypto.randomBytes(12).toString('base64url')
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null, { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: pwd }), 'activate')
    const token = must(await call('POST', '/api/auth/login', null, { username: u.email, password: pwd }), 'login').token
    return (m, p, b) => call(m, p, 'Bearer ' + token, b)
  }
  const resp = await user('responsavel', ugR), equipe = await user('equipe', ugE)

  // --- a plataforma instala a regra modelo no umidificador
  const regra = {
    entityId: umid.id, type: 'SCRIPT', name: 'Modelo · Controle de umidade v1', configuration: {
      type: 'SCRIPT',
      arguments: {
        h: { refEntityId: sensor.id, refEntityKey: { key: 'humidity', type: 'TS_LATEST' } },
        min: { refEntityKey: { key: 'limite_min', type: 'ATTRIBUTE', scope: 'SERVER_SCOPE' }, defaultValue: '45' },
        max: { refEntityKey: { key: 'limite_max', type: 'ATTRIBUTE', scope: 'SERVER_SCOPE' }, defaultValue: '55' },
        hab: { refEntityKey: { key: 'habilitada', type: 'ATTRIBUTE', scope: 'SERVER_SCOPE' }, defaultValue: 'false' },
        estado: { refEntityKey: { key: 'estado', type: 'ATTRIBUTE', scope: 'CLIENT_SCOPE' }, defaultValue: 'false' }
      },
      // Parâmetros inválidos ou regra desabilitada: não mexe no atuador (devolve vazio).
      expression: 'var lo = toFixed(min, 2); var hi = toFixed(max, 2);' +
        ' if (!(hab == true || hab == "true")) { return {}; }' +
        ' if (!(lo >= 0 && hi <= 100 && lo < hi)) { return {}; }' +
        ' var on = (estado == true || estado == "true");' +
        ' if (h < lo) { on = true; } if (h > hi) { on = false; }' +
        ' return {"ligar": on};',
      output: { type: 'ATTRIBUTES', scope: 'SHARED_SCOPE',
        strategy: { type: 'IMMEDIATE', saveAttribute: true, sendWsUpdate: true, processCfs: true, updateAttributesOnlyOnValueChange: true } }
    }
  }
  let r = await T('POST', '/api/calculatedField', regra)
  log('M1', r.status === 200, `plataforma instala a regra modelo no umidificador da L1: HTTP ${msg(r)}`)
  if (r.status !== 200) throw new Error('sem regra, sem teste')
  const cfId = r.json.id

  const ligar = async () => { const a = list(await T('GET', `/api/plugins/telemetry/DEVICE/${umid.id.id}/values/attributes/SHARED_SCOPE?keys=ligar`))[0]; return a ? String(a.value) : '(nada)' }
  // o "dispositivo" confirma o estado que recebeu (atributo de cliente), como um equipamento real faria
  const confirma = async () => { const v = await ligar(); if (v === 'true' || v === 'false') await call('POST', `/api/v1/${tokUmid}/attributes`, null, { estado: v === 'true' }); await sleep(1500) }
  const umidade = async v => { await call('POST', `/api/v1/${tokSensor}/telemetry`, null, { humidity: v }); await sleep(3000); const x = await ligar(); await confirma(); return x }
  const param = async (who, d, body) => { const x = await who('POST', `/api/plugins/telemetry/DEVICE/${d.id.id}/SERVER_SCOPE`, body); await sleep(3000); return x }

  // --- permissões do Responsável e da Equipe
  r = await param(resp, umid, { limite_min: 45, limite_max: 55, habilitada: true })
  log('P1', r.status === 200, `Responsável (usuário da unidade) ajusta limites 45/55 e habilita a regra no umidificador da L1: HTTP ${msg(r)}`)
  r = await param(resp, outro, { limite_min: 10, limite_max: 20, habilitada: true })
  log('P2', r.status !== 200, `Responsável ajusta parâmetros de um umidificador da L2: HTTP ${msg(r)}`)
  r = await param(equipe, umid, { limite_min: 10 })
  log('P3', r.status !== 200, `Equipe ajusta parâmetros: HTTP ${msg(r)}`)
  r = await resp('POST', '/api/calculatedField', { ...regra, name: 'regra do pesquisador' })
  log('P4', r.status !== 200, `Responsável cria uma regra própria: HTTP ${msg(r)}`)
  r = await resp('GET', `/api/calculatedField/${cfId.id}`)
  log('P5', null, `Responsável lê a regra instalada: HTTP ${msg(r)}`)
  r = await resp('DELETE', `/api/calculatedField/${cfId.id}`)
  log('P6', r.status !== 200, `Responsável apaga a regra instalada: HTTP ${msg(r)}`)

  // --- funcionamento (umidificador começa desligado)
  await call('POST', `/api/v1/${tokUmid}/attributes`, null, { estado: false })
  const seq = []
  for (const v of [60, 44, 43, 50, 56, 57]) seq.push(`${v}→${await umidade(v)}`)
  log('F1', seq.join(' ') === '60→false 44→true 43→true 50→true 56→false 57→false', `histerese 45/55: ${seq.join(' ')}`)

  r = await param(resp, umid, { limite_min: 30, limite_max: 40 })
  const f2 = await umidade(35); const f2b = await umidade(25)
  log('F2', f2 === 'false' && f2b === 'true', `Responsável muda para 30/40: 35 → ${f2}, 25 → ${f2b}`)

  await param(resp, umid, { limite_min: 60, limite_max: 40 })
  const f3 = await umidade(70)
  log('F3', f3 === 'true', `limites invertidos (60/40) são ignorados; umidade 70 mantém o estado anterior → ${f3}`)

  await param(resp, umid, { limite_min: 30, limite_max: 40, habilitada: false })
  const f4 = await umidade(80)
  log('F4', f4 === 'true', `regra desabilitada não mexe no atuador; umidade 80 → ${f4}`)

  r = await resp('POST', `/api/plugins/telemetry/DEVICE/${umid.id.id}/SHARED_SCOPE`, { ligar: false })
  log('A1', null, `Responsável grava direto o atributo de saída "ligar" (acionamento manual por atributo): HTTP ${msg(r)}`)
  r = await equipe('POST', `/api/plugins/telemetry/DEVICE/${umid.id.id}/SHARED_SCOPE`, { ligar: true })
  log('A2', r.status !== 200, `Equipe grava o atributo de saída: HTTP ${msg(r)}`)
} finally {
  await limpar()
  console.log('Limpeza feita.')
}
const checked = out.filter(o => o.ok !== null)
console.log(`${checked.filter(o => o.ok).length} PASS de ${checked.length} (+ ${out.length - checked.length} informativos)`)

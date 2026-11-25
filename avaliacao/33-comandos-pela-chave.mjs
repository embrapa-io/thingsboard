// Comandos pela chave de aplicação (24/11): a mesma chave lê e comanda, sem opção na tela.
// Ponta a ponta no projeto do relatório (pecuaria-corte), pela camada pública
// (telemetry-proxy :9090 → telemetry-gateway → backend e ThingsBoard → simulador).
//
//   A. o pesquisador do Cerrado (Maintainer, mas não Responsável no Pantanal) cria uma aplicação
//      com a válvula: a chave lê, mas não comanda (403);
//   B. o pesquisador do Pantanal, Maintainer só durante o teste, cria outra: a chave comanda a
//      válvula (getState e setValve, com a resposta do dispositivo), e cada comando entra no
//      histórico, que qualquer membro do projeto vê;
//   C. validações: corpo inválido, chave revogada.
//
// No fim, revoga as duas aplicações, devolve a válvula ao estado inicial e o papel do Pantanal
// a Developer. Uso: node 33-comandos-pela-chave.mjs
import { login } from './_login.mjs'

const API = 'http://localhost:8090'
const APPS = 'http://localhost:9090/applications'
const UNIX = 'pecuaria-corte'
const CERRADO = 'pesquisador.cerrado@embrapa.br'
const PANTANAL = 'pesquisador.pantanal@embrapa.br'

const tokens = {}
const tokenDe = async email => (tokens[email] ||= (await login(email)).token)
const api = async (email, method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await tokenDe(email) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, json: j }
}
const comando = async (key, device, body) => {
  const r = await fetch(APPS + '/rpc/twoway/' + device, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, json: j }
}
const ler = async (key, path) => (await fetch(path, { headers: { 'X-API-Key': key } })).status

let ok = 0; let falhas = 0
const verifica = (id, texto, cond, extra = '') => {
  if (cond) ok++; else falhas++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} ${texto}${extra ? ' — ' + extra : ''}`)
}

const equipe = async () => {
  const r = await api(CERRADO, 'GET', '/projects')
  const p = (Array.isArray(r.json) ? r.json : []).find(x => x.unix === UNIX)
  return p ? p.team.map(m => ({ email: m.email, role: m.role })) : []
}

const timeOriginal = await equipe()
if (!timeOriginal.some(m => m.email === PANTANAL)) throw new Error('o pesquisador do Pantanal não está no projeto ' + UNIX)

const criadas = []
let estadoInicial = null
let chavePantanal = null
let valvula = null

try {
  const lista = await api(CERRADO, 'GET', '/iot/apps/' + UNIX)
  verifica('E0', 'a aba Aplicações traz o endereço base /applications', lista.json && lista.json.applicationsUrl === APPS, lista.json && lista.json.applicationsUrl)

  const vinculados = (await api(CERRADO, 'GET', '/iot/devices/linked/' + UNIX)).json || []
  const id = d => d.id || d.deviceId
  valvula = vinculados.find(d => d.name === 'Valvula_Agua_Remota_Pantanal_01')
  const nivel = vinculados.find(d => d.name === 'Medidor_Nivel_Reservatorio_Pantanal_02')
  if (!valvula || !nivel) throw new Error('válvula ou medidor de nível do Pantanal não estão vinculados ao projeto')

  // --- A. Cerrado: lê, mas não comanda
  const a = await api(CERRADO, 'POST', '/iot/apps/' + UNIX, { name: 'E2E comandos (Cerrado)', description: 'teste 33', devices: [id(valvula), id(nivel)] })
  if (a.status === 201) criadas.push({ email: CERRADO, id: a.json.app.id })
  verifica('A1', 'Cerrado cria a aplicação com a válvula do Pantanal', a.status === 201, String(a.status))
  verifica('A2', 'a chave do Cerrado não comanda nada (não é Responsável no Pantanal)', a.json && a.json.app.commandDevices.length === 0)
  const chaveCerrado = a.json.key
  verifica('A3', 'a chave do Cerrado lê a válvula por /applications/telemetry', await ler(chaveCerrado, `${APPS}/telemetry/DEVICE/${id(valvula)}/values/timeseries`) === 200)
  verifica('A4', 'o antigo /telemetry não existe mais (404)', await ler(chaveCerrado, `http://localhost:9090/telemetry/DEVICE/${id(valvula)}/values/timeseries`) === 404)
  const negado = await comando(chaveCerrado, id(valvula), { method: 'getState' })
  verifica('A5', 'comando pela chave do Cerrado é recusado (403)', negado.status === 403, String(negado.status))

  // --- B. Pantanal (Maintainer só durante o teste): lê e comanda
  const promovido = await api(CERRADO, 'POST', '/team', { unix: UNIX, team: timeOriginal.map(m => m.email === PANTANAL ? { ...m, role: 'Maintainer' } : m) })
  verifica('B0', 'Pantanal vira Maintainer temporariamente', promovido.status === 200, String(promovido.status))

  const b = await api(PANTANAL, 'POST', '/iot/apps/' + UNIX, { name: 'E2E comandos (Pantanal)', description: 'teste 33', devices: [id(valvula), id(nivel)] })
  if (b.status === 201) criadas.push({ email: PANTANAL, id: b.json.app.id })
  verifica('B1', 'Pantanal cria a aplicação', b.status === 201, String(b.status))
  verifica('B2', 'a chave do Pantanal comanda a válvula', b.json && b.json.app.commandDevices.includes(id(valvula)), JSON.stringify(b.json && b.json.app.commandDevices))
  chavePantanal = b.json.key

  const estado = await comando(chavePantanal, id(valvula), { method: 'getState' })
  estadoInicial = estado.json && estado.json.state && estado.json.state.valveOpen
  verifica('B3', 'getState volta a resposta do dispositivo', estado.status === 200 && typeof estadoInicial === 'boolean', JSON.stringify(estado.json))

  const troca = await comando(chavePantanal, id(valvula), { method: 'setValve', params: { open: !estadoInicial } })
  verifica('B4', 'setValve troca o estado da válvula', troca.status === 200 && troca.json && troca.json.state && troca.json.state.valveOpen === !estadoInicial, JSON.stringify(troca.json))

  const volta = await comando(chavePantanal, id(valvula), { method: 'setValve', params: { open: estadoInicial } })
  verifica('B5', 'setValve devolve o estado inicial', volta.status === 200 && volta.json.state.valveOpen === estadoInicial)
  if (volta.status === 200) estadoInicial = null

  // --- C. validações
  verifica('C1', 'corpo sem method é recusado (400)', (await comando(chavePantanal, id(valvula), { params: {} })).status === 400)
  verifica('C2', 'JSON inválido é recusado (400)', (await comando(chavePantanal, id(valvula), 'não é json')).status === 400)
  verifica('C3', 'chave desconhecida é recusada (401)', (await comando('ioa_' + 'z'.repeat(40), id(valvula), { method: 'getState' })).status === 401)

  // --- histórico
  const historico = await api(CERRADO, 'GET', `/iot/apps/${UNIX}/${b.json.app.id}/commands`)
  const itens = (historico.json && historico.json.commands) || []
  verifica('H1', 'o histórico tem os 3 comandos, do mais recente para o mais antigo', itens.length === 3 && itens[0].method === 'setValve' && itens[2].method === 'getState', itens.map(i => i.method).join(', '))
  verifica('H2', 'cada comando tem o nome do atuador, o resultado e a resposta', itens.every(i => i.ok && i.deviceName && i.response), itens[0] && itens[0].deviceName)
  verifica('H3', 'outro membro do projeto vê o histórico', historico.status === 200)
  const naLista = ((await api(CERRADO, 'GET', '/iot/apps/' + UNIX)).json.apps || []).find(x => x.id === b.json.app.id)
  verifica('H4', 'a lista mostra o total de comandos', naLista && naLista.commandCount === 3, String(naLista && naLista.commandCount))
} finally {
  // devolve a válvula, revoga as aplicações e restaura a equipe
  if (chavePantanal && valvula && typeof estadoInicial === 'boolean') {
    await comando(chavePantanal, valvula.id || valvula.deviceId, { method: 'setValve', params: { open: estadoInicial } })
  }
  for (const c of criadas) {
    const r = await api(c.email === PANTANAL ? CERRADO : c.email, 'DELETE', `/iot/apps/${UNIX}/${c.id}`)
    if (r.status !== 200) console.log('aviso: não revogou', c.id, r.status)
  }
  if (chavePantanal) {
    verifica('C4', 'chave revogada não comanda mais (401)', (await comando(chavePantanal, valvula.id || valvula.deviceId, { method: 'getState' })).status === 401)
  }
  const restaurada = await api(CERRADO, 'POST', '/team', { unix: UNIX, team: timeOriginal })
  verifica('Z1', 'equipe restaurada', restaurada.status === 200 && JSON.stringify(await equipe()) === JSON.stringify(timeOriginal))
}

console.log(`\n${ok}/${ok + falhas} PASS`)
process.exit(falhas ? 1 : 0)

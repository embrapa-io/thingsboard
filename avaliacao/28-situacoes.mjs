// Passo 4 do teste de ponta a ponta (planejamento-teste-ponta-a-ponta.md): situações do dia a dia no projeto
// "pecuaria-corte", pela interface do Embrapa I/O, com prints em relatorio-ponta-a-ponta/img/4*.png.
//   A. o pesquisador do Pampa desvincula um sensor dele e vincula de novo;
//   B. o pesquisador do Pampa não consegue desvincular um sensor do Cerrado (menu e API);
//   C. o pesquisador do Cerrado, Architect do projeto, pode desvincular sensores das outras Unidades;
//   D. um integrante da Equipe do Pantanal (só leitura no ThingsBoard) entra no projeto: o que ele pode fazer;
//   E. o pesquisador do Pampa sai do projeto: ninguém que fica é Responsável pelos sensores dele, que saem do projeto;
//   F. o Architect tira o pesquisador do Pantanal da equipe, havendo outro Responsável da Fazenda Nhumirim no projeto:
//      os vínculos passam para essa pessoa.
// No fim, a equipe e os vínculos voltam ao estado do passo 3. Pode rodar de novo.
//   node 28-situacoes.mjs
import crypto from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { abrir, sleep } from './_navegador.mjs'
import { login } from './_login.mjs'
import { T, call, must, list, page } from '../rbac/lib.mjs'

const UNIX = 'pecuaria-corte'
const API = 'http://localhost:8090'
const CERRADO = 'pesquisador.cerrado@embrapa.br', PAMPA = 'pesquisador.pampa@embrapa.br', PANTANAL = 'pesquisador.pantanal@embrapa.br'
const INTEGRANTE = 'integrante.pantanal@embrapa.br'
const NHUMIRIM = 'Campo experimental Fazenda Nhumirim – Embrapa Pantanal'
const CINCO_CRUZES = 'Campo experimental Fazenda Cinco Cruzes – Bagé/RS'
const HOME = `typeof vm.projectIot === 'function' && typeof vm.projectTeam === 'function'`
const IOT = `typeof vm.handleAssetChange === 'function' && typeof vm.linkSelected === 'function'`

const resultados = []
const verifica = (id, texto, ok, detalhe) => {
  resultados.push({ id, texto, ok, detalhe })
  console.log(`${ok ? 'PASS' : 'FALHA'} ${id} — ${texto}${detalhe ? ' | ' + detalhe : ''}`)
}
const tokens = {}
const tokenDe = async email => (tokens[email] ||= (await login(email)).token)
const api = async (email, method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await tokenDe(email) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {}
  return { status: r.status, json }
}
const vinculados = async email => { const r = await api(email, 'GET', `/iot/devices/linked/${UNIX}`); return r.status === 200 ? (Array.isArray(r.json) ? r.json : r.json.devices || []) : null }
const equipe = async () => { const r = await api(CERRADO, 'GET', '/projects'); const p = (Array.isArray(r.json) ? r.json : []).find(x => x.unix === UNIX); return p ? p.team.map(m => ({ email: m.email, role: m.role })) : [] }
const garantirNaEquipe = async (email, role = 'Developer') => {
  const t = await equipe()
  if (t.some(m => m.email === email)) return 200
  return (await api(CERRADO, 'POST', '/team', { unix: UNIX, team: [...t, { email, role }] })).status
}

// Abre o diálogo "Dispositivos IoT" do projeto na aba indicada (0 Disponíveis, 1 Vinculados, 2 Painéis).
const abrirIot = async (nav, aba) => {
  await nav.vm(HOME, `const p = (vm.projects || []).find(p => p.unix === ${JSON.stringify(UNIX)}); if (!p) return false; vm.projectIot(p); return true`)
  await nav.esperar(`!!document.querySelector('.iot-panel')`)
  await nav.esperar(`(window.__vm(vm => ${IOT}) || {}).loadingAssets === false`, 20000)
  await nav.vm(IOT, `vm.tab = ${aba}; return true`)
  await sleep(3000)
}
// Abre o menu ⋮ do dispositivo na aba Vinculados e devolve os itens (o menu fica aberto para o print).
const abrirMenu = (nav, rotulo) => nav.js(`(async () => {
  const row = [...document.querySelectorAll('.linked-table tbody tr')].find(r => r.querySelector('.device-title') && r.querySelector('.device-title').textContent.trim() === ${JSON.stringify(rotulo)})
  if (!row) return null
  row.scrollIntoView({ block: 'center' })
  const botoes = [...row.querySelectorAll('.linked-actions .v-btn')]; const mais = botoes[botoes.length - 1]
  if (!mais || mais.disabled) return []
  mais.click(); await new Promise(r => setTimeout(r, 500))
  return [...document.querySelectorAll('.menuable__content__active .v-list-item')].map(i => (i.querySelector('.v-list-item__title') || i).textContent.trim())
})()`)
const fecharMenu = nav => nav.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); document.body.click(); true`)
const clicarTexto = (nav, seletor, texto) => nav.js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(seletor)})].find(x => x.offsetParent !== null && x.textContent.replace(/\\s+/g, ' ').includes(${JSON.stringify(texto)}) && !x.disabled); if (!el) return false; el.click(); return true })()`)

// --- A. desvincular e vincular de novo (Pampa, sensor dele)
{
  const nav = await abrir(PAMPA)
  try {
    await nav.inicio(); await abrirIot(nav, 1)
    const itens = await abrirMenu(nav, 'Colar GPS do Pampa 07')
    verifica('A1', 'menu ⋮ do sensor que o pesquisador do Pampa vinculou tem "Desvincular"', (itens || []).includes('Desvincular'), (itens || []).join(' / '))
    await nav.print('40-pampa-menu-sensor-proprio')
    await clicarTexto(nav, '.menuable__content__active .v-list-item', 'Desvincular')
    await sleep(800)
    await nav.print('41-pampa-confirmar-desvincular')
    await clicarTexto(nav, '.v-dialog--active button', 'Desvincular')
    await nav.esperar(`!(window.__vm(vm => ${IOT}) || {}).linked.some(d => d.name === 'Colar_GPS_Pampa_07')`, 15000)
    await sleep(1500)
    verifica('A2', 'o sensor sai de Vinculados', !(await vinculados(PAMPA)).some(d => d.name === 'Colar_GPS_Pampa_07'))
    await nav.vm(IOT, `vm.tab = 0; const a = vm.assetOptions.find(a => a.name === ${JSON.stringify(CINCO_CRUZES)}); vm.handleAssetChange(a.id); return true`)
    await nav.esperar(`(window.__vm(vm => ${IOT}) || {}).available.some(d => d.name === 'Colar_GPS_Pampa_07')`, 20000)
    await sleep(2000)
    verifica('A3', 'o sensor volta para Disponíveis', await nav.vm(IOT, `return vm.available.some(d => d.name === 'Colar_GPS_Pampa_07')`))
    await nav.print('42-pampa-sensor-de-volta-em-disponiveis')
    // a tela vincula pelas caixas de seleção e pelo botão "Vincular" (linkSelected)
    await nav.vm(IOT, `vm.selectedForLink = vm.available.filter(d => d.name === 'Colar_GPS_Pampa_07').map(d => d.deviceId); await vm.linkSelected(); return true`)
    await sleep(1500)
    verifica('A4', 'vinculado de novo', (await vinculados(PAMPA)).some(d => d.name === 'Colar_GPS_Pampa_07'))
  } finally { nav.fechar() }
}

// --- B. o Pampa não desvincula sensor do Cerrado
{
  const nav = await abrir(PAMPA)
  try {
    await nav.inicio(); await abrirIot(nav, 1)
    const itens = await abrirMenu(nav, 'Estação meteorológica do Cerrado 01')
    verifica('B1', 'menu ⋮ de sensor de outra Unidade não tem "Desvincular"', itens !== null && !itens.includes('Desvincular'), itens === null ? 'linha não encontrada' : (itens.join(' / ') || '(menu vazio ou desabilitado)'))
    await nav.print('43-pampa-menu-sensor-do-cerrado')
    await fecharMenu(nav)
    const estacao = (await vinculados(PAMPA)).find(d => d.name === 'Estacao_Meteorologica_Cerrado_01')
    const r = await api(PAMPA, 'DELETE', `/iot/devices/${UNIX}/${encodeURIComponent(estacao.id)}`)
    verifica('B2', 'a API também recusa (403)', r.status === 403, `${r.status} ${r.json && r.json.code}`)
  } finally { nav.fechar() }
}

// --- C. o Architect (Cerrado) pode desvincular sensores das outras Unidades
{
  const nav = await abrir(CERRADO)
  try {
    await nav.inicio(); await abrirIot(nav, 1)
    const itens = await abrirMenu(nav, 'Válvula de água remota do Pantanal 01')
    verifica('C1', 'Architect do projeto vê "Desvincular" em sensor do Pantanal (observação de governança)', (itens || []).includes('Desvincular'), (itens || []).join(' / '))
    await nav.print('44-cerrado-architect-menu-sensor-do-pantanal')
    await fecharMenu(nav)
  } finally { nav.fechar() }
}

// --- D. integrante da Equipe do Pantanal (só leitura no ThingsBoard)
{
  // preparação: o gestor põe a pessoa na Equipe da Fazenda Nhumirim, e o Architect a convida ao projeto
  const unidade = list(await T('GET', `/api/customers${page}`)).find(c => c.title === 'Embrapa Pantanal')
  const asset = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`)).find(a => a.name === NHUMIRIM)
  const grupos = Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${asset.id.id}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value])).laboratorioGrupos
  let pessoa = list(await T('GET', `/api/customer/${unidade.id.id}/users${page}`)).find(u => u.email === INTEGRANTE)
  if (!pessoa) {
    pessoa = must(await T('POST', `/api/user?sendActivationMail=false&entityGroupId=${grupos.equipe}`, { email: INTEGRANTE, authority: 'CUSTOMER_USER', customerId: unidade.id, firstName: 'Integrante', lastName: 'do Pantanal' }), 'criar integrante')
    const link = await T('GET', `/api/user/${pessoa.id.id}/activationLink`)
    must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null, { activateToken: new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken'), password: crypto.randomBytes(18).toString('base64url') + 'aA1!' }), 'ativar integrante')
  }
  const naEquipe = list(await T('GET', `/api/entityGroup/${grupos.equipe}/entities${page}`)).some(m => m.id.id === pessoa.id.id)
  verifica('D0', 'integrante está em "Fazenda Nhumirim · Equipe" no ThingsBoard', naEquipe)
  verifica('D0b', 'integrante convidado ao projeto', await garantirNaEquipe(INTEGRANTE) === 200)

  const sensoresDele = (await (await fetch(API + '/iot/sensors', { headers: { Authorization: 'Bearer ' + await tokenDe(INTEGRANTE) } })).json())
  const nomes = (sensoresDele.sensors || []).map(s => s.name)
  verifica('D1', 'integrante enxerga no ThingsBoard só os sensores da Fazenda Nhumirim', nomes.length === 2 && nomes.every(n => /Pantanal/.test(n)), nomes.join(', '))

  const nav = await abrir(INTEGRANTE)
  try {
    await nav.inicio(); await abrirIot(nav, 1)
    const papel = await nav.vm(IOT, `return vm.currentProjectRoleLabel`)
    const comDesvincular = await nav.vm(IOT, `return vm.linked.filter(d => vm.canUnlink(d)).length`)
    verifica('D2', 'integrante não tem "Desvincular" em nenhum sensor', comDesvincular === 0, `perfil: ${papel}`)
    const itens = await abrirMenu(nav, 'Válvula de água remota do Pantanal 01')
    verifica('D3', 'no sensor da Unidade dele, o menu oferece só abrir no ThingsBoard (sem dados de conexão)', itens !== null && !itens.includes('Dados de conexão') && !itens.includes('Desvincular'), (itens || []).join(' / ') || '(menu vazio ou desabilitado)')
    await nav.print('45-integrante-menu-sensor-da-unidade')
    await fecharMenu(nav)
  } finally { nav.fechar() }

  // Vincular exige Edição (Responsável da localidade): o Pantanal desvincula o medidor, o integrante
  // (só leitura) vê o sensor em Disponíveis com o botão desabilitado e a API recusa; o Responsável vincula.
  const medidor = (await vinculados(PANTANAL)).find(d => d.name === 'Medidor_Nivel_Reservatorio_Pantanal_02')
  await api(PANTANAL, 'DELETE', `/iot/devices/${UNIX}/${encodeURIComponent(medidor.id)}`)
  const nav2 = await abrir(INTEGRANTE)
  try {
    await nav2.inicio(); await abrirIot(nav2, 0)
    await nav2.vm(IOT, `const a = vm.assetOptions.find(a => a.name === ${JSON.stringify(NHUMIRIM)}); if (a) vm.handleAssetChange(a.id); return !!a`)
    await nav2.esperar(`(window.__vm(vm => ${IOT}) || {}).available.length > 0`, 20000)
    await sleep(2000)
    const botoes = await nav2.js(`[...document.querySelectorAll('.v-dialog--active button')].filter(b => b.offsetParent && /Vincular/.test(b.textContent)).map(b => b.disabled)`)
    await nav2.print('46-integrante-vincular-desabilitado')
    const r = await api(INTEGRANTE, 'POST', `/iot/devices/${UNIX}`, { deviceId: medidor.id })
    verifica('D4', 'integrante (só leitura) vê o sensor livre com "Vincular" desabilitado', botoes.length > 0 && botoes.every(Boolean), `botões desabilitados: ${botoes.join(', ')}`)
    verifica('D5', 'a API recusa o vínculo feito pelo integrante (403 THINGSBOARD_DEVICE_MANAGE_DENIED)', r.status === 403 && r.json?.code === 'THINGSBOARD_DEVICE_MANAGE_DENIED', `${r.status} ${r.json?.code || ''}`)
    // volta ao estado do passo 3: o vínculo fica de novo em nome do pesquisador do Pantanal
    if (r.status === 201) await api(INTEGRANTE, 'DELETE', `/iot/devices/${UNIX}/${encodeURIComponent(medidor.id)}`)
    const r2 = await api(PANTANAL, 'POST', `/iot/devices/${UNIX}`, { deviceId: medidor.id })
    verifica('D6', 'o Responsável da localidade vincula o mesmo sensor', r2.status === 201, String(r2.status))
  } finally { nav2.fechar() }
}

// --- E. o pesquisador do Pampa sai do projeto
const SENSORES_PAMPA = ['Balanca_Passagem_Pampa_03', 'Colar_GPS_Pampa_07', 'Sensor_Solo_Pastagem_Pampa_04']
{
  const idsPampa = (await vinculados(CERRADO)).filter(d => SENSORES_PAMPA.includes(d.name)).map(d => ({ id: d.id, name: d.name }))
  const nav = await abrir(PAMPA, { altura: 1000 })
  try {
    await nav.inicio()
    await nav.vm(HOME, `const p = (vm.projects || []).find(p => p.unix === ${JSON.stringify(UNIX)}); vm.projectLeave(p); return true`)
    const SAIR = `typeof vm.leave === 'function' && typeof vm.loadDevices === 'function' && vm.dialog`
    await nav.esperar(`!!window.__vm(vm => ${SAIR})`)
    await nav.esperar(`(window.__vm(vm => ${SAIR}) || {}).loadingDevices === false`, 30000)
    const previa = await nav.vm(SAIR, `return vm.devices ? { unlink: vm.devices.unlink.map(d => d.name), transfer: vm.devices.transfer.map(d => d.name) } : null`)
    verifica('E0', 'a tela de saída avisa que os 3 sensores dele sairão do projeto (ninguém que fica é Responsável por eles)',
      previa && previa.transfer.length === 0 && SENSORES_PAMPA.every(n => previa.unlink.includes(n)), previa ? previa.unlink.join(', ') : 'sem prévia')
    await nav.vm(SAIR, `vm.aware = true; return true`)
    await sleep(800)
    await nav.print('47-pampa-sair-do-projeto')
    await clicarTexto(nav, '.v-dialog--active button', 'Sair')
    await nav.esperar(`!(window.__vm(vm => ${HOME}) || { projects: [] }).projects.some(p => p.unix === ${JSON.stringify(UNIX)})`, 20000)
    await sleep(1500)
    verifica('E1', 'o projeto some da tela inicial do pesquisador do Pampa', !await nav.vm(HOME, `return vm.projects.some(p => p.unix === ${JSON.stringify(UNIX)})`))
    await nav.print('48-pampa-depois-de-sair')
  } finally { nav.fechar() }
  const r = await api(PAMPA, 'GET', `/iot/devices/linked/${UNIX}`)
  verifica('E2', 'o pesquisador do Pampa perde o acesso aos dados do projeto', r.status === 403, `${r.status} ${r.json && r.json.code}`)

  const nav2 = await abrir(CERRADO)
  try {
    await nav2.inicio(); await abrirIot(nav2, 1)
    const restantes = await nav2.vm(IOT, `return vm.linked.map(d => d.name)`)
    verifica('E3', 'os sensores do Pampa saíram do projeto; os das outras Unidades continuam', !restantes.some(n => SENSORES_PAMPA.includes(n)) && restantes.length === 4, restantes.join(', '))
    await nav2.print('49-cerrado-vinculados-depois-da-saida')
  } finally { nav2.fechar() }

  // volta ao estado do passo 3: o Pampa volta à equipe e vincula de novo os próprios sensores
  verifica('E4', 'pesquisador do Pampa convidado de novo (restauração)', await garantirNaEquipe(PAMPA) === 200)
  const religados = await Promise.all(idsPampa.map(d => api(PAMPA, 'POST', `/iot/devices/${UNIX}`, { deviceId: d.id })))
  verifica('E5', 'pesquisador do Pampa vincula de novo os 3 sensores (restauração)', religados.length === 3 && religados.every(x => x.status === 201), religados.map(x => x.status).join(', '))
}

// --- F. o Architect tira o pesquisador do Pantanal da equipe; o integrante, agora também Responsável, assume os vínculos
{
  const asset = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`)).find(a => a.name === NHUMIRIM)
  const grupos = Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${asset.id.id}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value])).laboratorioGrupos
  const unidade = list(await T('GET', `/api/customers${page}`)).find(c => c.title === 'Embrapa Pantanal')
  const pessoa = list(await T('GET', `/api/customer/${unidade.id.id}/users${page}`)).find(u => u.email === INTEGRANTE)
  const SENSORES_PANTANAL = ['Medidor_Nivel_Reservatorio_Pantanal_02', 'Valvula_Agua_Remota_Pantanal_01']
  const idsPantanal = (await vinculados(CERRADO)).filter(d => SENSORES_PANTANAL.includes(d.name)).map(d => d.id)

  // o gestor põe o integrante também em Responsáveis (temporário); o escopo do backend fica 30 s em cache
  must(await T('POST', `/api/entityGroup/${grupos.responsaveis}/addEntities`, [pessoa.id.id]), 'pôr integrante em Responsáveis')
  await sleep(31000)
  try {
    const time = await equipe()
    const r = await api(CERRADO, 'POST', '/team', { unix: UNIX, team: time.filter(m => m.email !== PANTANAL) })
    const passou = ((r.json && r.json.devices && r.json.devices.transfer) || []).map(d => d.name + ' → ' + d.to)
    verifica('F1', 'ao tirar o pesquisador do Pantanal, os 2 vínculos dele passam para o outro Responsável da Fazenda Nhumirim no projeto',
      r.status === 200 && passou.length === 2 && passou.every(x => x.endsWith(INTEGRANTE)) && (r.json.devices.unlink || []).length === 0, passou.join(', ') || JSON.stringify(r.json))
    const agora = (await vinculados(CERRADO)).filter(d => SENSORES_PANTANAL.includes(d.name))
    verifica('F2', 'os 2 sensores do Pantanal continuam no projeto', agora.length === 2, agora.map(d => d.name).join(', '))
  } finally {
    // volta ao estado do passo 3: o integrante desfaz os vínculos (é quem vinculou agora), sai de Responsáveis,
    // e o pesquisador do Pantanal volta à equipe e vincula de novo
    for (const id of idsPantanal) await api(INTEGRANTE, 'DELETE', `/iot/devices/${UNIX}/${encodeURIComponent(id)}`)
    must(await T('POST', `/api/entityGroup/${grupos.responsaveis}/deleteEntities`, [pessoa.id.id]), 'tirar integrante de Responsáveis')
    await garantirNaEquipe(PANTANAL)
    const religados = await Promise.all(idsPantanal.map(id => api(PANTANAL, 'POST', `/iot/devices/${UNIX}`, { deviceId: id })))
    verifica('F3', 'pesquisador do Pantanal de volta à equipe, com os 2 sensores vinculados (restauração)', religados.every(x => x.status === 201), religados.map(x => x.status).join(', '))
  }
}

const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
mkdirSync(pasta, { recursive: true })
writeFileSync(join(pasta, `28-situacoes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(resultados, null, 2))
console.log(`\n${resultados.filter(r => r.ok).length}/${resultados.length} PASS`)

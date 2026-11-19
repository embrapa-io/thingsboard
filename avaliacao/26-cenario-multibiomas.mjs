// Preparação do teste de ponta a ponta (planejamento-teste-ponta-a-ponta.md, passo 1): um pesquisador por
// Unidade da Tabela 3.1 da qualificação, Responsável pelo campo experimental da própria Unidade.
//
// O que o script faz é o papel da equipe técnica e do gestor:
//   1. cria a pessoa como usuária da Unidade (customer) e ativa a conta com uma senha aleatória, que não é
//      guardada nem impressa (o acesso é pelo Embrapa I/O, que gera o token dela no ThingsBoard);
//   2. grava o atributo `responsavel` no asset do campo experimental. Quem põe a pessoa no grupo
//      `· Responsáveis` é a rule chain "Embrapa · Criar laboratório", e não este script.
//
// Sem --aplicar, só mostra o que faria. Pode rodar de novo: reaproveita quem já existe.
//   node 26-cenario-multibiomas.mjs [--aplicar]
import crypto from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { T, call, must, list, page, sleep } from '../rbac/lib.mjs'

const APLICAR = process.argv.includes('--aplicar')
const CENARIO = [
  { email: 'pesquisador.cerrado@embrapa.br', nome: 'Pesquisador', sobrenome: 'do Cerrado', unidade: 'Embrapa Gado de Corte', local: 'Campo experimental da Embrapa Gado de Corte – Campo Grande/MS' },
  { email: 'pesquisador.pampa@embrapa.br', nome: 'Pesquisador', sobrenome: 'do Pampa', unidade: 'Embrapa Pecuária Sul', local: 'Campo experimental Fazenda Cinco Cruzes – Bagé/RS' },
  { email: 'pesquisador.pantanal@embrapa.br', nome: 'Pesquisador', sobrenome: 'do Pantanal', unidade: 'Embrapa Pantanal', local: 'Campo experimental Fazenda Nhumirim – Embrapa Pantanal' }
]

const resultados = []
const verifica = (id, ok, texto) => { resultados.push({ id, ok, texto }); console.log(`${ok ? 'PASS' : 'FALHA'} ${id} ${texto}`) }
const passo = texto => console.log(`${APLICAR ? '→' : '[simulação]'} ${texto}`)

const unidades = list(await T('GET', `/api/customers${page}`))
const assets = list(await T('GET', `/api/assetInfos/all${page}&includeCustomers=true`))
const usuarios = (await Promise.all(unidades.map(async u => list(await T('GET', `/api/customer/${u.id.id}/users${page}`))))).flat()
const atributos = async assetId => Object.fromEntries(list(await T('GET', `/api/plugins/telemetry/ASSET/${assetId}/values/attributes/SERVER_SCOPE`)).map(a => [a.key, a.value]))

for (const p of CENARIO) {
  console.log(`\n# ${p.email} · ${p.unidade}`)
  const unidade = unidades.find(u => u.title === p.unidade)
  const local = assets.find(a => a.name === p.local)
  if (!unidade || !local) { verifica(`${p.email}:base`, false, `Unidade ou localidade não encontrada (${!!unidade}/${!!local})`); continue }

  // 1. a pessoa, usuária da Unidade
  let usuario = usuarios.find(u => u.email.toLowerCase() === p.email)
  if (usuario && usuario.customerId.id !== unidade.id.id) { verifica(`${p.email}:unidade`, false, 'a conta existe, mas em outra Unidade'); continue }
  if (!usuario) {
    passo(`criar ${p.email} como usuária da ${p.unidade} e ativar a conta`)
    if (APLICAR) {
      usuario = must(await T('POST', '/api/user?sendActivationMail=false', { email: p.email, authority: 'CUSTOMER_USER', customerId: unidade.id, firstName: p.nome, lastName: p.sobrenome }), 'criar ' + p.email)
      const link = await T('GET', `/api/user/${usuario.id.id}/activationLink`)
      const activateToken = new URL(link.text.replace(/"/g, '')).searchParams.get('activateToken')
      must(await call('POST', '/api/noauth/activate?sendActivationMail=false', null, { activateToken, password: crypto.randomBytes(18).toString('base64url') + 'aA1!' }), 'ativar ' + p.email)
    }
  } else console.log(`  já existe (${usuario.id.id})`)

  // 2. Responsável pelo campo experimental, pela regra
  const bruto = (await atributos(local.id.id)).laboratorioGrupos
  const grupos = (typeof bruto === 'string' ? JSON.parse(bruto) : bruto) || {}
  const membros = async () => grupos.responsaveis ? list(await T('GET', `/api/entityGroup/${grupos.responsaveis}/entities${page}`)).map(m => m.id.id) : []
  if (!grupos.responsaveis) { verifica(`${p.email}:grupos`, false, 'o asset não tem laboratorioGrupos.responsaveis'); continue }
  if (usuario && (await membros()).includes(usuario.id.id)) { verifica(`${p.email}:responsavel`, true, `já é Responsável de "${p.local}"`); continue }

  passo(`gravar responsavel=${p.email} em "${p.local}" e esperar a regra`)
  if (!APLICAR) continue
  await T('POST', `/api/plugins/telemetry/ASSET/${local.id.id}/attributes/SERVER_SCOPE`, { responsavel: p.email, responsavelStatus: '', responsavelErro: '' })
  let a = {}
  for (let i = 0; i < 30; i++) { await sleep(1000); a = await atributos(local.id.id); if (a.responsavel === p.email && (a.responsavelStatus === 'ok' || a.responsavelErro)) break }
  const noGrupo = (await membros()).includes(usuario.id.id)
  verifica(`${p.email}:responsavel`, a.responsavelStatus === 'ok' && noGrupo,
    `a regra pôs a pessoa em "${p.local} · Responsáveis" (status: ${a.responsavelStatus || 'nenhum em 30 s'}${a.responsavelErro ? ', erro: ' + a.responsavelErro : ''}; no grupo: ${noGrupo})`)
}

if (APLICAR) {
  const pasta = join(dirname(fileURLToPath(import.meta.url)), 'resultados')
  mkdirSync(pasta, { recursive: true })
  writeFileSync(join(pasta, `26-cenario-multibiomas-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(resultados, null, 2))
  console.log(`\n${resultados.filter(r => r.ok).length}/${resultados.length} PASS`)
}

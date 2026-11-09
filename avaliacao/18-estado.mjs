// Mostra parâmetros e estados do teste 18 (pela chave da plataforma).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const ENV = Object.fromEntries(readFileSync(join(HERE, '..', '..', 'backend', '.env'), 'utf8').split(/\r?\n/).map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))
const info = JSON.parse(readFileSync(join(HERE, '.18-painel-controle.private.json'), 'utf8'))
const g = async p => (await fetch('http://127.0.0.1:9095' + p, { headers: { 'X-Authorization': 'ApiKey ' + ENV.THINGSBOARD_TOKEN } })).json()
const attrs = async (id, scope, keys) => Object.fromEntries((await g(`/api/plugins/telemetry/DEVICE/${id}/values/attributes/${scope}?keys=${keys}`)).map(a => [a.key, a.value]))
const h = (await g(`/api/plugins/telemetry/DEVICE/${info.sensor.id}/values/timeseries?keys=humidity`)).humidity?.[0]?.value
const p = await attrs(info.umid.id, 'SERVER_SCOPE', 'limite_min,limite_max,habilitada')
const u = { ...(await attrs(info.umid.id, 'SHARED_SCOPE', 'ligar')), ...(await attrs(info.umid.id, 'CLIENT_SCOPE', 'estado')) }
const a = { ...(await attrs(info.ac.id, 'SHARED_SCOPE', 'ligar')), ...(await attrs(info.ac.id, 'CLIENT_SCOPE', 'estado')) }
console.log(`umidade ${h} | limites ${p.limite_min}/${p.limite_max} habilitada=${p.habilitada} | umidificador pedido=${u.ligar} confirmado=${u.estado} | AC pedido=${a.ligar} confirmado=${a.estado}`)

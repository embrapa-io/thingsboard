'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { customize } = require('../static/embrapa-access-denied')

const createFixture = titleText => {
  const title = { textContent: titleText }
  const content = {
    children: [{ type: 'text', value: 'mensagem original' }],
    get firstChild () {
      return this.children[0]
    },
    removeChild (child) {
      this.children.splice(this.children.indexOf(child), 1)
    },
    appendChild (child) {
      this.children.push(child)
    }
  }
  const cancel = { textContent: 'Cancelar', removed: false, remove () { this.removed = true } }
  const signIn = { textContent: 'Entrar!', removed: false, remove () { this.removed = true } }
  const actions = { querySelectorAll: selector => selector === 'button' ? [cancel, signIn] : [] }
  const attributes = new Set()
  const dialog = {
    hasAttribute: name => attributes.has(name),
    setAttribute: name => attributes.add(name),
    querySelector: selector => ({
      '[mat-dialog-title]': title,
      '[mat-dialog-content]': content,
      '[mat-dialog-actions]': actions
    })[selector]
  }
  const root = { querySelectorAll: selector => selector === 'tb-confirm-dialog' ? [dialog] : [] }
  const documentRef = {
    createTextNode: value => ({ type: 'text', value }),
    createElement: name => ({ type: 'element', name })
  }

  return { root, documentRef, title, content, cancel, signIn }
}

test('transforma o diálogo de acesso proibido em um aviso com um único botão Ok', () => {
  const fixture = createFixture('Acesso proibido')

  customize(fixture.root, fixture.documentRef)

  assert.equal(fixture.title.textContent, 'Acesso negado')
  assert.deepEqual(fixture.content.children, [
    { type: 'text', value: 'Você não tem permissão de acesso a este local!' },
    { type: 'element', name: 'br' },
    { type: 'text', value: 'Tente fazer login com outro usuário se ainda deseja obter acesso a este local' }
  ])
  assert.equal(fixture.cancel.textContent, 'Ok')
  assert.equal(fixture.cancel.removed, false)
  assert.equal(fixture.signIn.removed, true)
})

test('não altera outros diálogos de confirmação', () => {
  const fixture = createFixture('Excluir dispositivo')

  customize(fixture.root, fixture.documentRef)

  assert.equal(fixture.title.textContent, 'Excluir dispositivo')
  assert.equal(fixture.cancel.textContent, 'Cancelar')
  assert.equal(fixture.signIn.removed, false)
})

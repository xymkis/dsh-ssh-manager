/**
 * Throwaway password-auth SSH server used by the Lead's live end-to-end check.
 * Prints `PORT <port>` once listening and runs until killed.
 *
 * Usage: node verify/echo-ssh-server.mjs [password] [username]
 */

import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const password = process.argv[2] ?? 'e2e-pass'
const username = process.argv[3] ?? 'tester'

const hostKey = utils.generateKeyPairSync('ed25519').private
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (auth) => {
    if (auth.method === 'password' && auth.username === username && auth.password === password) return auth.accept()
    if (auth.method === 'none') return auth.reject(['password'])
    return auth.reject()
  })
  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession()
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec()
        const command = typeof info.command === 'string' ? info.command : ''
        if (command.includes('uname')) {
          stream.write('Linux 6.8.0-e2e x86_64\n')
          stream.write('tester\n')
        } else {
          stream.write(`echo:${command}\n`)
          stream.write('Hello from the live end-to-end SSH server\n')
        }
        stream.exit(0)
        stream.end()
      })
    })
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  console.log(`PORT ${address.port}`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))

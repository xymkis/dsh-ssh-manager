/**
 * End-to-end verification of the plugin's ssh2 integration against a local
 * throwaway SSH server (started in this process on 127.0.0.1).
 *
 * Covers password auth, RSA key auth, exec output/exit code, probe output,
 * wrong-password mapping, and the timeout path. Run from the plugin directory:
 * `node verify/ssh-e2e.mjs`
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const { createSshClient } = await import(pathToFileURL(path.join(pluginDir, 'host', 'ssh.js')).href)

const failures = []
function check(name, condition, detail) {
  if (condition) console.log(`ok - ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL - ${name}${detail === undefined ? '' : `: ${detail}`}`)
  }
}

const hostKey = utils.generateKeyPairSync('ed25519').private
const userKey = utils.generateKeyPairSync('rsa', { bits: 2048 })
const PASSWORD = 'e2e-secret-password'
const USERNAME = 'tester'

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (auth) => {
    if (auth.method === 'password' && auth.username === USERNAME && auth.password === PASSWORD) return auth.accept()
    if (auth.method === 'password') return auth.reject()
    if (auth.method === 'publickey' && auth.username === USERNAME) return auth.accept()
    if (auth.method === 'none') return auth.reject(['password', 'publickey'])
    return auth.reject()
  })
  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession()
      session.on('exec', (acceptExec, _rejectExec, info) => {
        const stream = acceptExec()
        if (info.command.includes('hang')) return
        stream.write(`exec:${info.command}\n`)
        stream.stderr.write('stderr-line\n')
        stream.exit(info.command.includes('fail') ? 7 : 0)
        stream.end()
      })
    })
  })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const port = server.address().port
const ssh = createSshClient()

const passwordRecord = { id: 'e2e-1', name: 'e2e-password', host: '127.0.0.1', port, username: USERNAME, authType: 'password', password: PASSWORD }
const keyRecord = { id: 'e2e-2', name: 'e2e-key', host: '127.0.0.1', port, username: USERNAME, authType: 'key', privateKey: userKey.private }

/* password auth */
const probe = await ssh.probe(passwordRecord)
check('probe succeeds with password auth', probe.success === true && /exec:uname/.test(probe.output), JSON.stringify(probe))

const exec = await ssh.exec(passwordRecord, 'echo hello-e2e')
check('exec returns stdout/exit code', exec.exitCode === 0 && exec.stdout.includes('exec:echo hello-e2e') && exec.stderr.includes('stderr-line'), JSON.stringify(exec))
check('exec reports duration', typeof exec.durationMs === 'number' && exec.durationMs >= 0)

const failed = await ssh.exec(passwordRecord, 'fail-command')
check('exec reports non-zero exit code', failed.exitCode === 7, JSON.stringify(failed))

/* key auth */
const keyProbe = await ssh.probe(keyRecord)
check('probe succeeds with RSA private key auth', keyProbe.success === true && /exec:uname/.test(keyProbe.output), JSON.stringify(keyProbe))

/* failure mapping */
const badRecord = { ...passwordRecord, password: 'wrong-password' }
let authError = null
try {
  await ssh.probe(badRecord, { timeoutMs: 8000 })
} catch (error) {
  authError = error
}
check('wrong password maps to auth error', authError !== null && authError.code === 'auth' && !String(authError.message).includes(PASSWORD), String(authError && authError.message))

/* timeout */
const hangRecord = passwordRecord
const started = Date.now()
let timeoutError = null
try {
  await ssh.exec(hangRecord, 'hang-forever', { timeoutMs: 1200 })
} catch (error) {
  timeoutError = error
}
check('exec timeout maps to timeout error', timeoutError !== null && timeoutError.code === 'timeout', String(timeoutError && timeoutError.message))
check('exec timeout settles promptly', Date.now() - started < 6000, `${Date.now() - started}ms`)

/* unreachable network mapping */
let networkError = null
try {
  await ssh.probe({ ...passwordRecord, port: 1 }, { timeoutMs: 3000 })
} catch (error) {
  networkError = error
}
check('refused port maps to network error', networkError !== null && networkError.code === 'network', String(networkError && networkError.message))

server.close()
await new Promise(resolve => setTimeout(resolve, 50))

if (failures.length > 0) {
  console.error(`\nSSH E2E FAILED (${failures.length})`)
  process.exit(1)
}
console.log('\nSSH E2E OK')

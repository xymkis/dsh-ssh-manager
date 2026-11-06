/**
 * SSH execution for the dsh-ssh-manager host half.
 *
 * Uses the pure-JavaScript `ssh2` client (never the OpenSSH binary). The
 * module exposes two operations: `exec` runs one command and reports
 * stdout/stderr/exit code with a bounded capture, and `probe` checks that a
 * configured server is reachable and readable. Error messages are fixed
 * Chinese strings and never contain a password, private key, or passphrase.
 *
 * @module host/ssh
 */

import ssh2 from 'ssh2'

const { Client } = ssh2

/** Stdout capture cap (512 KiB). */
const STDOUT_LIMIT = 512 * 1024
/** Stderr capture cap (256 KiB). */
const STDERR_LIMIT = 256 * 1024
/** Default command timeout (60 s). */
const DEFAULT_TIMEOUT_MS = 60_000
/** Default probe timeout (20 s). */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000
/** Minimum accepted timeout (1 s). */
const MIN_TIMEOUT_MS = 1_000
/** Maximum accepted timeout (10 min). */
const MAX_TIMEOUT_MS = 600_000
/** Default connect timeout (15 s). */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
/** Keepalive interval (10 s). */
const KEEPALIVE_INTERVAL_MS = 10_000
/** Probe command: kernel/arch plus the remote user name. */
const PROBE_COMMAND = "uname -srm; printf '\\n'; id -un"

/**
 * Create one tagged error.
 * @param {string} code - machine-readable error code.
 * @param {string} message - friendly Chinese message (never contains secrets).
 * @param {unknown} [cause] - underlying failure kept off the public message.
 * @returns {Error & { code: string }} the tagged error.
 */
function sshError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

/** @returns {boolean} whether the value is a plain object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Clamp an optional numeric option.
 * @param {unknown} value - caller-supplied value.
 * @param {number} fallback - default when the value is missing or invalid.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped value.
 */
function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Validate and normalize the connection fields of a record.
 * @param {unknown} record - full record (may contain credentials).
 * @returns {{ host: string, port: number, username: string, authType: 'password' | 'key' }} normalized fields.
 */
function normalizeRecord(record) {
  if (!isObject(record)) throw sshError('invalid-input', '连接配置不完整')
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  if (host === '') throw sshError('invalid-input', '主机地址不能为空')
  const username = typeof record.username === 'string' ? record.username.trim() : ''
  if (username === '') throw sshError('invalid-input', '用户名不能为空')
  const port = record.port === undefined || record.port === null ? 22 : Number(record.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw sshError('invalid-input', '端口必须是 1-65535 之间的整数')
  if (record.authType === 'password') {
    if (typeof record.password !== 'string' || record.password.length === 0) throw sshError('invalid-input', '缺少密码凭据')
    return { host, port, username, authType: 'password' }
  }
  if (record.authType === 'key') {
    if (typeof record.privateKey !== 'string' || record.privateKey.length === 0) throw sshError('invalid-input', '缺少私钥凭据')
    return { host, port, username, authType: 'key' }
  }
  throw sshError('invalid-input', '认证方式无效')
}

/**
 * Translate an ssh2/Node connection failure into a friendly tagged error.
 * @param {unknown} error - thrown value from ssh2.
 * @returns {Error & { code: string }} the friendly error.
 */
export function mapSshError(error) {
  const raw = error && typeof error.message === 'string' ? error.message : ''
  const code = error && typeof error.code === 'string' ? error.code : ''
  const level = error && typeof error.level === 'string' ? error.level : ''
  if (level === 'client-authentication' || /all configured authentication methods failed|permission denied|authentication failed/i.test(raw)) {
    return sshError('auth', '认证失败，请检查用户名和凭据', error)
  }
  if (code === 'ECONNREFUSED') return sshError('network', '连接被拒绝：目标主机的端口没有在监听', error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return sshError('network', '无法解析主机名，请检查服务器地址', error)
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return sshError('network', '网络不可达，请检查网络连接', error)
  if (code === 'ECONNRESET' || /reset|socket hang up/i.test(raw)) return sshError('network', '连接被服务器重置', error)
  if (code === 'ETIMEDOUT' || /timed? ?out|timeout/i.test(raw)) return sshError('timeout', '连接超时，请检查服务器地址和网络', error)
  return sshError('unknown', 'SSH 连接失败，请检查主机、端口和认证信息', error)
}

/**
 * Build the ssh2 connection configuration. Host keys are accepted as-is
 * (documented in README); credentials never leave this function.
 * @param {object} record - full record.
 * @param {{ host: string, port: number, username: string, authType: 'password' | 'key' }} fields - normalized fields.
 * @param {number} connectTimeoutMs - ssh2 ready timeout.
 * @returns {object} ssh2 connect configuration.
 */
function connectionConfig(record, fields, connectTimeoutMs) {
  const config = {
    host: fields.host,
    port: fields.port,
    username: fields.username,
    readyTimeout: connectTimeoutMs,
    keepaliveInterval: KEEPALIVE_INTERVAL_MS,
  }
  if (fields.authType === 'key') {
    config.privateKey = record.privateKey
    if (typeof record.passphrase === 'string' && record.passphrase.length > 0) config.passphrase = record.passphrase
  } else {
    config.password = record.password
  }
  return config
}

/**
 * Bounded byte capture for one output stream.
 * @param {number} limit - maximum captured bytes.
 * @returns {{ push: (chunk: unknown) => void, text: () => string, isTruncated: () => boolean }} capture handle.
 */
function createCapture(limit) {
  const chunks = []
  let bytes = 0
  let truncated = false
  return {
    push(chunk) {
      if (truncated) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (buffer.length === 0) return
      const remaining = limit - bytes
      if (remaining <= 0) {
        truncated = true
        return
      }
      const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer
      chunks.push(slice)
      bytes += slice.length
      if (slice.length < buffer.length) truncated = true
    },
    text() {
      return Buffer.concat(chunks).toString('utf8')
    },
    isTruncated() {
      return truncated
    },
  }
}

/**
 * Open one SSH connection with the same auth handling and friendly error
 * mapping as {@link createSshClient}'s exec/probe. The caller owns the returned
 * client and must `client.end()` it (the SFTP client does this in a finally).
 *
 * @param {object} record - full record including credentials.
 * @param {{ timeoutMs?: number, connectTimeoutMs?: number }} [options] - timeout overrides.
 * @returns {Promise<object>} the ready ssh2 Client.
 */
export async function openSshConnection(record, options = {}) {
  const fields = normalizeRecord(record)
  const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const connectTimeoutMs = clampNumber(options.connectTimeoutMs, Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const config = connectionConfig(record, fields, connectTimeoutMs)
  const client = new Client()

  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        /* already closed */
      }
      reject(sshError('timeout', 'SSH 连接超时，请检查服务器地址和网络'))
    }, timeoutMs)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) {
        resolve(client)
        return
      }
      try {
        client.end()
      } catch {
        /* already closed */
      }
      reject(mapSshError(error))
    }
    client.once('ready', () => finish())
    client.once('error', (error) => finish(error))
    client.once('close', () => finish(new Error('连接已关闭')))
    try {
      client.connect(config)
    } catch (error) {
      finish(error)
    }
  })
}

/**
 * Create the SSH client used by the API, the tools, and the smoke test.
 * @returns {{ exec: (record: object, command: string, options?: object) => Promise<object>, probe: (record: object, options?: object) => Promise<object> }} client operations.
 */
export function createSshClient() {
  /**
   * Run one shell command over SSH.
   * @param {object} record - full record including credentials.
   * @param {string} command - shell command to run remotely.
   * @param {{ timeoutMs?: number, connectTimeoutMs?: number }} [options] - timeout overrides.
   * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, durationMs: number, truncated: boolean }>} execution result.
   */
  async function exec(record, command, options = {}) {
    const fields = normalizeRecord(record)
    if (typeof command !== 'string' || command.trim() === '') throw sshError('invalid-input', '命令不能为空')

    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const connectTimeoutMs = clampNumber(options.connectTimeoutMs, Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const config = connectionConfig(record, fields, connectTimeoutMs)
    const startedAt = Date.now()
    const client = new Client()
    let timer

    const execution = new Promise((resolve, reject) => {
      let settled = false
      /** Settle once: clear the timer and hand the outcome to the promise. */
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const stdout = createCapture(STDOUT_LIMIT)
      const stderr = createCapture(STDERR_LIMIT)

      timer = setTimeout(() => {
        finish(sshError('timeout', `SSH 操作超时（${Math.round(timeoutMs / 1000)} 秒）`))
        try {
          client.end()
        } catch {
          /* already closed */
        }
      }, timeoutMs)

      client.on('ready', () => {
        client.exec(command, (error, channel) => {
          if (error) {
            finish(mapSshError(error))
            return
          }
          if (!channel) {
            finish(sshError('unknown', 'SSH 连接失败，请检查主机、端口和认证信息'))
            return
          }
          channel.on('data', (chunk) => {
            if (!settled) stdout.push(chunk)
          })
          channel.on('error', (streamError) => finish(mapSshError(streamError)))
          if (channel.stderr && typeof channel.stderr.on === 'function') {
            channel.stderr.on('data', (chunk) => {
              if (!settled) stderr.push(chunk)
            })
            channel.stderr.on('error', (streamError) => finish(mapSshError(streamError)))
          }
          channel.on('close', (code, signal) => {
            finish(null, {
              exitCode: typeof code === 'number' ? code : null,
              signal: typeof signal === 'string' ? signal : null,
              stdout: stdout.text(),
              stderr: stderr.text(),
              durationMs: Date.now() - startedAt,
              truncated: stdout.isTruncated() || stderr.isTruncated(),
            })
          })
        })
      })
      client.on('error', (error) => finish(mapSshError(error)))
      client.on('close', () => finish(mapSshError(new Error('连接已关闭'))))

      try {
        client.connect(config)
      } catch (error) {
        finish(mapSshError(error))
      }
    })

    try {
      return await execution
    } finally {
      try {
        client.end()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Check that one configured server is reachable and readable.
   * @param {object} record - full record including credentials.
   * @param {{ timeoutMs?: number, connectTimeoutMs?: number }} [options] - timeout overrides.
   * @returns {Promise<{ success: true, latencyMs: number, output: string }>} probe result.
   */
  async function probe(record, options = {}) {
    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const connectTimeoutMs = clampNumber(options.connectTimeoutMs, Math.min(DEFAULT_CONNECT_TIMEOUT_MS, timeoutMs), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const result = await exec(record, PROBE_COMMAND, { timeoutMs, connectTimeoutMs })
    return {
      success: true,
      latencyMs: result.durationMs,
      output: result.stdout.trim(),
    }
  }

  return { exec, probe }
}

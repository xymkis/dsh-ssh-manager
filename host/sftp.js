/**
 * SFTP file transfer for dsh-ssh-manager.
 *
 * One connection per operation (upload or download), reusing the auth and
 * error mapping of {@link module:host/ssh}. Files cross the plugin boundary as
 * base64 in the JSON API: the browser reads a picked file into an ArrayBuffer
 * and posts it; downloads come back the same way and the browser saves them
 * through a Blob URL. Size caps keep one transfer from exhausting memory, and
 * no credential ever appears in a result or an error message.
 *
 * @module host/sftp
 */

import { mapSshError, openSshConnection } from './ssh.js'

/** Maximum accepted upload size (decoded bytes). */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
/** Maximum accepted download size (remote bytes). */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
/** Default whole-operation timeout. */
const DEFAULT_TIMEOUT_MS = 60_000
/** Minimum accepted whole-operation timeout. */
const MIN_TIMEOUT_MS = 5_000
/** Maximum accepted whole-operation timeout. */
const MAX_TIMEOUT_MS = 300_000
/** Basename of a POSIX remote path. */
const REMOTE_BASENAME = /[^/]+$/u

/**
 * Build one tagged SFTP error.
 * @param {string} code - machine-readable code.
 * @param {string} message - friendly Chinese message (never contains credentials).
 * @param {unknown} [cause] - underlying failure kept off the message.
 * @returns {Error & { code: string }} tagged error.
 */
function sftpError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

/**
 * Clamp an optional numeric option.
 * @param {unknown} value - raw option.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
function clampNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/**
 * Validate and normalize one remote path.
 * @param {unknown} value - raw path.
 * @param {string} label - field label for the error message.
 * @returns {string} trimmed path.
 */
function normalizeRemotePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw sftpError('invalid-input', `${label}不能为空`)
  const remotePath = value.trim()
  if (remotePath.includes('\u0000')) throw sftpError('invalid-input', `${label}包含非法字符`)
  return remotePath
}

/**
 * Resolve the final upload target: a path ending with `/` receives the picked
 * file's base name, anything else is used verbatim.
 * @param {string} remotePath - user-entered target.
 * @param {string} fileName - picked local file name.
 * @returns {string} final remote path.
 */
function resolveUploadPath(remotePath, fileName) {
  if (!remotePath.endsWith('/')) return remotePath
  const base = typeof fileName === 'string' && fileName !== '' ? fileName.split(/[\\/]/u).at(-1) : ''
  if (base === undefined || base === '' || base === '.' || base === '..') {
    throw sftpError('invalid-input', '请填写远程文件路径或提供文件名')
  }
  return remotePath + base
}

/**
 * Translate an SFTP subsystem failure into a friendly tagged error.
 * @param {unknown} error - thrown value from ssh2's SFTP methods.
 * @returns {Error & { code: string }} friendly error.
 */
function mapSftpFailure(error) {
  if (error && typeof error.code === 'string') return mapSshError(error)
  const code = error && typeof error.code === 'number' ? error.code : undefined
  if (code === 2) return sftpError('not-found', '远程文件或目录不存在', error)
  if (code === 3) return sftpError('permission', '权限不足，无法访问远程路径', error)
  if (code === 4) return sftpError('failure', '远程文件操作失败', error)
  if (code === 8) return sftpError('permission', '远程操作被拒绝', error)
  return sftpError('unknown', 'SFTP 操作失败，请检查远程路径和服务器权限', error)
}

/**
 * Create the SFTP client used by the HTTP API.
 * @returns {{ upload: (record: object, remotePath: string, data: Buffer, options?: object) => Promise<object>, download: (record: object, remotePath: string, options?: object) => Promise<object> }} transfer operations.
 */
export function createSftpClient() {
  /**
   * Run one SFTP operation on a fresh connection with one overall deadline.
   * @param {object} record - full server record including credentials.
   * @param {{ timeoutMs?: number }} options - timeout override.
   * @param {(sftp: object) => Promise<unknown>} action - operation body.
   * @returns {Promise<unknown>} the operation result.
   */
  async function withSftp(record, options, action) {
    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const client = await openSshConnection(record, {
      timeoutMs: Math.min(15_000, timeoutMs),
      connectTimeoutMs: Math.min(15_000, timeoutMs),
    })
    try {
      const sftp = await new Promise((resolve, reject) => {
        client.sftp((error, session) => {
          if (error) reject(mapSftpFailure(error))
          else resolve(session)
        })
      })
      return await new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            client.end()
          } catch {
            /* already closed */
          }
          reject(sftpError('timeout', `SFTP 操作超时（${Math.round(timeoutMs / 1000)} 秒）`))
        }, timeoutMs)
        Promise.resolve()
          .then(() => action(sftp))
          .then((value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
          }, (error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(mapSftpFailure(error))
          })
      })
    } finally {
      try {
        client.end()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Upload one local buffer to a remote path over SFTP.
   * @param {object} record - full server record including credentials.
   * @param {string} remotePath - remote target path (a trailing `/` appends the file name).
   * @param {Buffer} data - file bytes.
   * @param {{ timeoutMs?: number, fileName?: string }} [options] - timeout and picked file name.
   * @returns {Promise<{ remotePath: string, bytes: number }>} upload outcome.
   */
  async function upload(record, remotePath, data, options = {}) {
    const target = resolveUploadPath(normalizeRemotePath(remotePath, '远程路径'), options.fileName)
    if (!Buffer.isBuffer(data)) throw sftpError('invalid-input', '文件内容无效')
    if (data.length > MAX_UPLOAD_BYTES) {
      throw sftpError('file-too-large', `文件超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB 上限`)
    }
    await withSftp(record, options, (sftp) => new Promise((resolve, reject) => {
      sftp.writeFile(target, data, { mode: 0o644 }, (error) => {
        if (error) reject(error)
        else resolve(undefined)
      })
    }))
    return { remotePath: target, bytes: data.length }
  }

  /**
   * Download one remote file over SFTP.
   * @param {object} record - full server record including credentials.
   * @param {string} remotePath - remote file path.
   * @param {{ timeoutMs?: number }} [options] - timeout override.
   * @returns {Promise<{ remotePath: string, fileName: string, bytes: number, data: string }>} base64 file payload.
   */
  async function download(record, remotePath, options = {}) {
    const target = normalizeRemotePath(remotePath, '远程文件路径')
    const buffer = await withSftp(record, options, (sftp) => new Promise((resolve, reject) => {
      sftp.stat(target, (statError, stats) => {
        if (statError) {
          reject(statError)
          return
        }
        if (!stats || typeof stats.isFile !== 'function' || !stats.isFile()) {
          reject(sftpError('invalid-input', '远程路径不是普通文件'))
          return
        }
        if (typeof stats.size === 'number' && stats.size > MAX_DOWNLOAD_BYTES) {
          reject(sftpError('file-too-large', `远程文件超过 ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB 上限`))
          return
        }
        sftp.readFile(target, (readError, data) => {
          if (readError) reject(readError)
          else resolve(data)
        })
      })
    }))
    const fileName = (target.match(REMOTE_BASENAME) ?? [target])[0] || 'download.bin'
    return {
      remotePath: target,
      fileName,
      bytes: buffer.length,
      data: Buffer.from(buffer).toString('base64'),
    }
  }

  return { upload, download }
}

/**
 * dsh-ssh-manager host entry.
 *
 * Mounts the persistent server store, the SSH client, the Settings HTTP API,
 * the two agent tools (`ssh_servers`, `ssh_exec`), and the `## SSH servers`
 * system-prompt section. Every registration is owned by one `ctx.effect`, so
 * disposing the plugin fiber releases all of them.
 *
 * @module dsh-ssh-manager
 */

import { registerApiRoutes } from './host/api.js'
import { registerPromptSection } from './host/prompt.js'
import { createSftpClient } from './host/sftp.js'
import { createSshClient } from './host/ssh.js'
import { createStore } from './host/store.js'
import { registerTools } from './host/tools.js'

/** Services that must exist before this plugin mounts. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']

/**
 * Log one warning without ever throwing.
 * @param {object} ctx - plugin context.
 * @param {string} message - warning text.
 */
function warn(ctx, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger.warn === 'function') logger.warn(`dsh-ssh-manager: ${message}`)
  } catch {
    /* logging is best effort */
  }
}

/**
 * Register one resource, keeping the plugin tree alive if it fails.
 * @param {object} ctx - plugin context.
 * @param {string} label - resource label for warnings.
 * @param {() => ((() => void) | (() => void)[])} register - registration callback.
 * @param {((() => void) | (() => void)[])[]} collected - disposer accumulator.
 */
function safelyRegister(ctx, label, register, collected) {
  try {
    const registered = register()
    const queue = Array.isArray(registered) ? registered : [registered]
    for (const disposer of queue) {
      if (typeof disposer === 'function') collected.push(disposer)
    }
  } catch (error) {
    warn(ctx, `${label} registration failed: ${error && typeof error.message === 'string' ? error.message : String(error)}`)
  }
}

/**
 * Mount the plugin.
 * @param {object} ctx - host plugin context.
 * @param {object} [_config] - loader config (unused; the bundle passes `{}`).
 */
export function apply(ctx, _config) {
  const store = createStore()
  try {
    store.load()
  } catch (error) {
    warn(ctx, `failed to load the server data file: ${error && typeof error.message === 'string' ? error.message : String(error)}`)
  }
  const ssh = createSshClient()
  const sftp = createSftpClient()

  ctx.effect(() => {
    /** @type {(() => void)[]} */
    const disposers = []
    safelyRegister(ctx, 'HTTP API', () => registerApiRoutes(ctx, { store, ssh, sftp }), disposers)
    safelyRegister(ctx, 'agent tools', () => registerTools(ctx, { store, ssh }), disposers)
    safelyRegister(ctx, 'system prompt section', () => registerPromptSection(ctx, { store }), disposers)
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          warn(ctx, `dispose failed: ${error && typeof error.message === 'string' ? error.message : String(error)}`)
        }
      }
    }
  }, 'dsh-ssh-manager: servers, tools, prompt section, and API')
}

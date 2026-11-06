/**
 * dsh-ssh-manager, browser half.
 *
 * Registers one Settings section (`settings.section`, id `ssh-manager`, order
 * 110) that lists the Linux SSH servers stored by the host half and offers
 * add / edit / delete / per-row connectivity test controls. The section
 * follows the native DSH settings recipes (760px content column, l2-hairline
 * cards, token-driven colors, 13/14px type).
 *
 * The only module the factory may request is `react` (the module loader
 * provides it); every control and style is authored here, with no JSX, no UI
 * primitives and no build step. Secrets (password, private key, passphrase)
 * never appear in rendered copy, DOM text or logs: the values live in
 * component state only and travel in request bodies only.
 * @module @local/dsh-ssh-manager/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ssh-manager',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement
    /** Locale namespace registered for this section. */
    const LOCALE_NS = 'sshManager'
    /** `style` element id for the one stylesheet this module installs. */
    const STYLE_ID = 'dsh-ssh-manager-styles'
    /** API route prefix (the host registers the matching prefix route). */
    const API_PREFIX = 'ssh-manager/api/'

    /** Fill `{name}` placeholders in a translated string. */
    function fmt(t, key, params) {
      const text = t(key)
      if (typeof text !== 'string') return key
      return text.replace(/\{(\w+)\}/g, (match, name) => (
        params !== undefined && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ))
    }

    /** POST one JSON call to the plugin web route (`{ ok, data }` / `{ ok, error }`). */
    async function call(method, body, signal) {
      const url = new URL(API_PREFIX + method, document.baseURI)
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch {
        const offline = new Error('network')
        offline.code = 'network'
        throw offline
      }
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        const failure = payload !== null && typeof payload === 'object' ? payload.error : undefined
        const message = failure !== undefined && typeof failure.message === 'string' && failure.message !== ''
          ? failure.message : 'request-failed'
        const error = new Error(message)
        error.code = failure !== undefined && typeof failure.code === 'string' ? failure.code : 'request-failed'
        throw error
      }
      return payload.data
    }

    /** Host errors are already localized; transport failures use `t`. */
    function errorText(caught, t) {
      if (caught !== null && typeof caught === 'object') {
        const message = caught.message
        if (caught.code !== 'network' && caught.code !== 'request-failed'
          && typeof message === 'string' && message !== '') return message
      }
      return t('requestFailed')
    }

    /** Server list order: name, locale-aware (matches the host store). */
    function sortServers(list) {
      return list.slice().sort((left, right) => String(left.name).localeCompare(String(right.name)))
    }

    /**
     * The composer completion source for both `@` and `/`: it lists the
     * configured SSH servers (filtered by name / host / user / port) and
     * picking one inserts `/<host>` — the slash+IP reference form the system
     * prompt teaches the agent to match against the listed host. The candidate
     * row shows the IP as its primary text with the display name as the
     * description, so what you pick is what the agent will resolve.
     *
     * Registered through the optional `inputTriggers` client service; failures
     * to load the list (offline, auth) yield an empty group instead of an error
     * banner inside the composer.
     */
    function createMentionSource(t, trigger) {
      return {
        trigger,
        name: 'SSH',
        order: 50,
        async candidates(_session, request) {
          const query = request !== null && request !== undefined && typeof request.query === 'string'
            ? request.query.trim()
            : ''
          const signal = request !== null && request !== undefined ? request.signal : undefined
          let servers
          try {
            const data = await call('list', {}, signal)
            servers = data !== null && data !== undefined && Array.isArray(data.servers) ? data.servers : []
          } catch {
            return []
          }
          const needle = query.toLowerCase()
          return servers
            .filter((server) => {
              if (needle === '') return true
              const fields = [server.name, server.host, server.username, String(server.port)]
              return fields.some(field => typeof field === 'string' && field.toLowerCase().includes(needle))
            })
            .map(server => ({
              name: String(server.host),
              description: `${server.username}@${server.port} · ${server.name}`
                + (server.authType === 'key' ? ` · ${t('authKey')}` : ''),
              value: String(server.host),
            }))
        },
        onPick({ candidate }) {
          const raw = candidate !== null && candidate !== undefined && typeof candidate.value === 'string'
            ? candidate.value
            : candidate !== null && candidate !== undefined && typeof candidate.name === 'string' ? candidate.name : ''
          const host = raw.replace(/\s+/g, ' ').trim()
          if (host === '') return undefined
          return { text: `/${host}` }
        },
      }
    }

    /** The canonical blank editor draft (port defaults to 22). */
    function emptyDraft() {
      return {
        id: undefined, name: '', host: '', port: '22', username: '', authType: 'password',
        password: '', privateKey: '', passphrase: '', note: '',
      }
    }

    /** Build an editor draft; secret fields start empty ("keep stored credential"). */
    function draftFrom(server) {
      if (server === null || server === undefined) return emptyDraft()
      return {
        id: server.id, name: server.name === undefined ? '' : server.name,
        host: server.host === undefined ? '' : server.host,
        port: String(server.port === undefined ? 22 : server.port),
        username: server.username === undefined ? '' : server.username,
        authType: server.authType === 'key' ? 'key' : 'password',
        password: '', privateKey: '', passphrase: '',
        note: server.note === undefined || server.note === null ? '' : server.note,
      }
    }

    /**
     * Client-side draft validation (the host validates again). Contract rules:
     * host and username required, port an integer in 1..65535, a credential
     * required unless the stored one is kept, private key for key auth.
     */
    function validateDraft(t, draft, server) {
      const errors = {}
      const portText = String(draft.port).trim()
      const port = Number(portText)
      if (String(draft.host).trim() === '') errors.host = t('validationHost')
      if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) errors.port = t('validationPort')
      if (String(draft.username).trim() === '') errors.username = t('validationUsername')
      const keepsPassword = server !== null && server !== undefined
        && server.authType === 'password' && server.hasPassword === true
      const keepsKey = server !== null && server !== undefined
        && server.authType === 'key' && server.hasKey === true
      if (draft.authType === 'password') {
        if (draft.password === '' && !keepsPassword) errors.password = t('validationPassword')
      } else if (String(draft.privateKey).trim() === '' && !keepsKey) {
        errors.key = t('validationKey')
      }
      return errors
    }

    /** Build the save / test-draft body; empty secrets are omitted ("keep stored"). */
    function saveBody(draft) {
      const body = {
        host: String(draft.host).trim(), port: Number(String(draft.port).trim()),
        username: String(draft.username).trim(), authType: draft.authType, note: draft.note,
      }
      if (draft.id !== undefined) body.id = draft.id
      const name = String(draft.name).trim()
      if (name !== '') body.name = name
      if (draft.authType === 'password') {
        if (draft.password !== '') body.password = draft.password
      } else {
        const key = String(draft.privateKey).trim()
        if (key !== '') body.privateKey = key
        if (draft.passphrase !== '') body.passphrase = draft.passphrase
      }
      return body
    }

    /** Chinese copy (authoritative: every `en` key has a `zh` entry here). */
    const zh = {
      nav: 'SSH 服务器', intro: '管理 Linux SSH 服务器连接。配置好之后，智能体可以通过 SSH 在远端执行命令；这里可以随时测试连通性、上传下载文件。在对话输入框输入 @ 或 / 可快速引用服务器（插入 /服务器IP）。',
      add: '添加服务器', count: '台服务器', loading: '正在加载服务器…', retry: '重新加载',
      emptyTitle: '还没有 SSH 服务器',
      emptyDesc: '添加一台 Linux 服务器后，智能体就能通过 ssh_exec 在远端执行命令。密码和私钥只保存在本机，列表里只显示是否已配置凭据。',
      colUser: '登录用户', authPassword: '密码认证', authKey: '私钥认证',
      hasSecret: '已保存凭据', noSecret: '缺少凭据', test: '测试连接',
      testing: '测试中…', edit: '编辑', delete: '删除',
      confirmDelete: '确认删除', confirmDeleteDesc: '删除后无法恢复，确定删除这台服务器吗？',
      cancel: '取消', save: '保存', saving: '保存中…',
      deleting: '删除中…', formAddTitle: '添加 SSH 服务器', formEditTitle: '编辑 SSH 服务器',
      fieldName: '名称', fieldNameHint: '可选，留空时使用「用户名@主机」',
      fieldHost: '主机地址', fieldPort: '端口', fieldUsername: '用户名',
      fieldAuthType: '认证方式', fieldPassword: '密码', fieldPrivateKey: '私钥',
      fieldPassphrase: '私钥口令', fieldNote: '备注', secretKeepHint: '留空表示保持不变',
      secretRequiredHint: '需要填写认证凭据', testInDialog: '测试连接', testOk: '连接成功',
      testFail: '连接失败', close: '关闭', validationHost: '请填写主机地址',
      validationPort: '端口必须是 1 到 65535 之间的整数', validationUsername: '请填写用户名',
      validationPassword: '请填写密码', validationKey: '请粘贴私钥内容',
      serverCountOne: '共 1 台服务器', serverCountMany: '共 {count} 台服务器',
      requestFailed: '请求失败，请稍后重试', latency: '延迟 {ms} ms', remoteInfo: '远端信息',
      credentialNote: '凭据只保存在本机，不会出现在对话或工具参数中。',
      files: '文件传输', sftpTitle: 'SFTP 文件传输',
      sftpUpload: '上传', sftpDownload: '下载',
      sftpRemotePath: '远程路径', sftpRemotePlaceholder: '/tmp/ 或 /root/文件名',
      sftpChooseFile: '选择本地文件', sftpNoFile: '未选择文件',
      sftpUploading: '上传中…', sftpDownloading: '下载中…',
      sftpUploadDone: '已上传到 {path}（{bytes}）', sftpDownloadDone: '已下载 {path}（{bytes}）',
      sftpNeedPath: '请填写远程路径', sftpNeedFile: '请先选择要上传的本地文件',
    }

    /** English dictionary: mirrors `zh` key for key. */
    const en = {
      nav: 'SSH Servers', intro: 'Manage Linux SSH server connections. Once configured, the agent can run commands over SSH; test connectivity and transfer files here at any time. Type @ or / in the composer to reference a saved server (inserts /<host>).',
      add: 'Add server', count: 'servers', loading: 'Loading servers…', retry: 'Retry',
      emptyTitle: 'No SSH servers yet',
      emptyDesc: 'Add a Linux server and the agent can run commands on it with ssh_exec. Passwords and private keys stay on this machine; the list only shows whether a credential is saved.',
      colUser: 'User', authPassword: 'Password auth', authKey: 'Private key auth',
      hasSecret: 'Credential saved', noSecret: 'Credential missing', test: 'Test',
      testing: 'Testing…', edit: 'Edit', delete: 'Delete',
      confirmDelete: 'Confirm delete', confirmDeleteDesc: 'This cannot be undone. Delete this server?',
      cancel: 'Cancel', save: 'Save', saving: 'Saving…',
      deleting: 'Deleting…', formAddTitle: 'Add SSH server', formEditTitle: 'Edit SSH server',
      fieldName: 'Name', fieldNameHint: 'Optional; defaults to user@host',
      fieldHost: 'Host', fieldPort: 'Port', fieldUsername: 'Username',
      fieldAuthType: 'Authentication', fieldPassword: 'Password', fieldPrivateKey: 'Private key',
      fieldPassphrase: 'Key passphrase', fieldNote: 'Note', secretKeepHint: 'Leave empty to keep the saved credential',
      secretRequiredHint: 'A credential is required', testInDialog: 'Test connection', testOk: 'Connected',
      testFail: 'Connection failed', close: 'Close', validationHost: 'Enter a host address',
      validationPort: 'Port must be an integer between 1 and 65535', validationUsername: 'Enter a username',
      validationPassword: 'Enter a password', validationKey: 'Paste the private key',
      serverCountOne: '1 server', serverCountMany: '{count} servers',
      requestFailed: 'Request failed. Try again.', latency: 'Latency {ms} ms', remoteInfo: 'Remote info',
      credentialNote: 'Credentials stay on this machine and never appear in the conversation or tool arguments.',
      files: 'Files', sftpTitle: 'SFTP file transfer',
      sftpUpload: 'Upload', sftpDownload: 'Download',
      sftpRemotePath: 'Remote path', sftpRemotePlaceholder: '/tmp/ or /root/file',
      sftpChooseFile: 'Choose local file', sftpNoFile: 'No file selected',
      sftpUploading: 'Uploading…', sftpDownloading: 'Downloading…',
      sftpUploadDone: 'Uploaded to {path} ({bytes})', sftpDownloadDone: 'Downloaded {path} ({bytes})',
      sftpNeedPath: 'Enter a remote path', sftpNeedFile: 'Choose a local file first',
    }

    /*
     * One stylesheet: native DSH settings recipes. Each theme token is
     * resolved once into an --ssh-* custom property (with fallback), and the
     * rules consume only those, so the section follows light/dark automatically.
     */
    const CSS = `
.dsh-ssh-section {
  --ssh-fg: var(--dsw-alias-label-primary, inherit); --ssh-fg2: var(--dsw-alias-label-secondary, inherit);
  --ssh-fg3: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit));
  --ssh-bg1: var(--dsw-alias-bg-layer-1, transparent); --ssh-bg2: var(--dsw-alias-bg-layer-2, transparent);
  --ssh-bg3: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, transparent));
  --ssh-b1: var(--dsw-alias-border-l1, transparent); --ssh-b2: var(--dsw-alias-border-l2, transparent);
  --ssh-brand: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary, currentColor));
  --ssh-brand-fill: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary, currentColor));
  --ssh-brand-hover: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-primary, currentColor));
  --ssh-hover: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, transparent));
  --ssh-err: var(--dsw-alias-state-error-primary, inherit);
  --ssh-ok: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary, inherit));
  --ssh-warn: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary, inherit));
  --ssh-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  display: flex; flex-direction: column; gap: 16px;
  width: 100%; max-width: 760px; box-sizing: border-box; padding-bottom: 8px;
  color: var(--ssh-fg); font-size: 13px; line-height: 20px;
}
.dsh-ssh-intro { margin: 0; padding: 0 2px; font-size: 13px; line-height: 20px; color: var(--ssh-fg3); }
.dsh-ssh-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.dsh-ssh-count {
  display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 9px; border: 1px solid var(--ssh-b1);
  border-radius: 999px; background: var(--ssh-bg2); font-size: 11px; line-height: 18px;
  color: var(--ssh-fg2); font-variant-numeric: tabular-nums;
}
.dsh-ssh-count-num { font-size: 12px; font-weight: 600; color: var(--ssh-fg); }
.dsh-ssh-loading { padding: 20px 2px; font-size: 12px; line-height: 18px; color: var(--ssh-fg3); }
.dsh-ssh-error {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 12px 14px; border: 1px solid var(--ssh-b2); border-radius: 12px; background: var(--ssh-bg3);
  color: var(--ssh-err); font-size: 12px; line-height: 18px;
}
.dsh-ssh-error-text { min-width: 0; overflow-wrap: anywhere; }
.dsh-ssh-empty {
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 20px;
  border: 1px solid var(--ssh-b2); border-radius: 16px; background: var(--ssh-bg3); box-sizing: border-box;
}
.dsh-ssh-empty-title { font-size: 14px; line-height: 22px; font-weight: 600; color: var(--ssh-fg); }
.dsh-ssh-empty-desc { margin: 0; max-width: 560px; font-size: 12px; line-height: 18px; color: var(--ssh-fg2); }
.dsh-ssh-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-ssh-card {
  display: flex; flex-direction: column; padding: 14px 16px;
  border: 1px solid var(--ssh-b2); border-radius: 16px; background: var(--ssh-bg3); box-sizing: border-box;
}
.dsh-ssh-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; width: 100%; }
.dsh-ssh-card-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-ssh-card-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dsh-ssh-card-name {
  flex: 0 1 auto; min-width: 0; font-size: 14px; line-height: 22px; font-weight: 600; color: var(--ssh-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-ssh-badge {
  flex: none; padding: 0 8px; border: 1px solid var(--ssh-b1); border-radius: 999px; background: var(--ssh-bg2);
  font-size: 11px; line-height: 18px; color: var(--ssh-fg2); white-space: nowrap;
}
.dsh-ssh-badge-warn { color: var(--ssh-warn); border-color: var(--ssh-warn); }
.dsh-ssh-card-user { font-family: var(--ssh-mono); font-size: 12px; line-height: 18px; color: var(--ssh-fg2); overflow-wrap: anywhere; }
.dsh-ssh-card-note { font-size: 12px; line-height: 18px; color: var(--ssh-fg3); overflow-wrap: anywhere; white-space: pre-wrap; }
.dsh-ssh-card-actions { display: flex; flex: none; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.dsh-ssh-btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  padding: 5px 12px; border: 1px solid transparent; border-radius: 8px; background: transparent;
  font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.dsh-ssh-btn:disabled { cursor: default; opacity: 0.55; }
.dsh-ssh-btn:focus-visible { outline: 2px solid var(--ssh-brand); outline-offset: 1px; }
.dsh-ssh-btn-primary { background: var(--ssh-brand-fill); color: var(--ssh-bg3); }
.dsh-ssh-btn-primary:hover:not(:disabled) { background: var(--ssh-brand-hover); }
.dsh-ssh-btn-secondary { border-color: var(--ssh-b2); background: var(--ssh-bg1); color: var(--ssh-fg2); }
.dsh-ssh-btn-secondary:hover:not(:disabled) { background: var(--ssh-hover); color: var(--ssh-fg); }
.dsh-ssh-btn-danger { border-color: var(--ssh-err); background: transparent; color: var(--ssh-err); }
.dsh-ssh-btn-danger:hover:not(:disabled) { background: var(--ssh-hover); }
.dsh-ssh-btn-ghost { padding: 2px 8px; border-color: transparent; background: transparent; color: var(--ssh-fg2); }
.dsh-ssh-btn-ghost:hover:not(:disabled) { background: var(--ssh-hover); color: var(--ssh-fg); }
.dsh-ssh-icon-btn { width: 28px; height: 28px; padding: 0; font-size: 16px; line-height: 1; }
.dsh-ssh-confirm { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.dsh-ssh-confirm-desc { max-width: 240px; font-size: 12px; line-height: 17px; color: var(--ssh-err); text-align: right; }
.dsh-ssh-confirm-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.dsh-ssh-test {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--ssh-b1);
  border-radius: 8px; background: var(--ssh-bg2); font-size: 12px; line-height: 18px; overflow-wrap: anywhere;
}
.dsh-ssh-test-ok { color: var(--ssh-ok); }
.dsh-ssh-test-fail { color: var(--ssh-err); }
.dsh-ssh-output {
  margin: 0; padding: 0; max-height: 120px; overflow: auto; font-family: var(--ssh-mono); font-size: 11px;
  line-height: 16px; color: var(--ssh-fg2); white-space: pre-wrap; overflow-wrap: anywhere; scrollbar-width: thin;
}
.dsh-ssh-editor {
  display: flex; flex-direction: column; width: 100%; box-sizing: border-box;
  border: 1px solid var(--ssh-b2); border-radius: 14px; background: var(--ssh-bg3);
  animation: dsh-ssh-editor-in 0.14s ease-out; overflow: hidden;
}
@keyframes dsh-ssh-editor-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.dsh-ssh-editor-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 14px 18px 8px;
}
.dsh-ssh-editor-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-ssh-editor-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; color: var(--ssh-fg); }
.dsh-ssh-editor-sub {
  font-size: 11px; line-height: 16px; color: var(--ssh-fg3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-ssh-editor-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 18px 14px; }
.dsh-ssh-editor-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 12px 18px; border-top: 1px solid var(--ssh-b1); background: var(--ssh-bg2);
}
.dsh-ssh-editor-foot-right { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; flex-wrap: wrap; }
/* Fixed-height credential slot: switching 密码 / 私钥 keeps the page height
   stable instead of jumping between a short input and a tall key textarea. */
.dsh-ssh-credential {
  display: flex; flex-direction: column; gap: 12px;
  height: 196px; box-sizing: border-box; overflow-y: auto; padding-right: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, transparent) transparent;
}
.dsh-ssh-credential-note { margin: 0; font-size: 11px; line-height: 16px; color: var(--ssh-fg3); }
.dsh-ssh-sftp {
  display: flex; flex-direction: column; gap: 10px; width: 100%;
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--ssh-b1);
}
.dsh-ssh-sftp-title { font-size: 12px; line-height: 18px; font-weight: 600; color: var(--ssh-fg); }
.dsh-ssh-sftp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ssh-sftp-label { flex: none; min-width: 58px; font-size: 12px; line-height: 18px; color: var(--ssh-fg2); }
.dsh-ssh-sftp-path { flex: 1 1 200px; min-width: 0; }
.dsh-ssh-sftp-file { min-width: 0; font-size: 12px; line-height: 18px; color: var(--ssh-fg3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ssh-sftp-status { font-size: 12px; line-height: 18px; color: var(--ssh-fg2); overflow-wrap: anywhere; }
.dsh-ssh-sftp-status-err { color: var(--ssh-err); }
.dsh-ssh-sftp-status-ok { color: var(--ssh-ok); }
.dsh-ssh-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.dsh-ssh-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dsh-ssh-field-row { display: grid; grid-template-columns: minmax(0, 1fr) 118px; gap: 12px; }
.dsh-ssh-legend { padding: 0; }
.dsh-ssh-label { font-size: 12px; line-height: 17px; font-weight: 500; color: var(--ssh-fg); }
.dsh-ssh-hint { font-size: 11px; line-height: 16px; color: var(--ssh-fg3); }
.dsh-ssh-field-error { font-size: 11px; line-height: 16px; color: var(--ssh-err); }
.dsh-ssh-input {
  width: 100%; box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--ssh-b2);
  border-radius: 8px; background: var(--ssh-bg1); color: var(--ssh-fg); font: inherit; font-size: 13px; line-height: 20px;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.dsh-ssh-input::placeholder { color: var(--ssh-fg3); }
.dsh-ssh-input:hover:not(:focus-visible) { border-color: var(--dsw-alias-border-l3, var(--ssh-b2)); }
.dsh-ssh-input:focus-visible {
  outline: none; border-color: var(--ssh-brand);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ssh-brand) 16%, transparent);
}
.dsh-ssh-input-error { border-color: var(--ssh-err); }
.dsh-ssh-input-error:focus-visible {
  border-color: var(--ssh-err);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ssh-err) 16%, transparent);
}
.dsh-ssh-textarea {
  min-height: 96px; padding: 8px 10px; font-family: var(--ssh-mono); font-size: 12px; line-height: 1.6; resize: vertical;
}
.dsh-ssh-textarea-note {
  min-height: 56px; font-family: inherit; font-size: 13px; line-height: 20px;
}
.dsh-ssh-segment-row {
  display: inline-flex; align-self: flex-start; gap: 2px; padding: 2px;
  border: 1px solid var(--ssh-b2); border-radius: 8px; background: var(--ssh-bg1);
}
.dsh-ssh-segment {
  appearance: none; border: 0; border-radius: 6px; padding: 4px 14px;
  background: transparent; color: var(--ssh-fg2); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.dsh-ssh-segment:hover { color: var(--ssh-fg); }
.dsh-ssh-segment-on {
  background: var(--ssh-bg2); color: var(--ssh-fg); font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}
.dsh-ssh-segment:focus-visible { outline: 2px solid var(--ssh-brand); outline-offset: 1px; }
.dsh-ssh-icon-btn { width: 26px; height: 26px; border-radius: 6px; font-size: 15px; color: var(--ssh-fg3); }
.dsh-ssh-icon-btn:hover:not(:disabled) { color: var(--ssh-fg); }
.dsh-ssh-form-alert {
  padding: 10px 12px; border: 1px solid var(--ssh-b1); border-radius: 8px; background: var(--ssh-bg2);
  color: var(--ssh-err); font-size: 12px; line-height: 18px; overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .dsh-ssh-card-top { flex-direction: column; }
  .dsh-ssh-card-actions { justify-content: flex-start; width: 100%; }
  .dsh-ssh-confirm { align-items: flex-start; } .dsh-ssh-confirm-desc { max-width: none; text-align: left; }
  .dsh-ssh-editor-head, .dsh-ssh-editor-body, .dsh-ssh-editor-foot { padding-left: 16px; padding-right: 16px; }
}
@media (max-width: 520px) {
  .dsh-ssh-field-row { grid-template-columns: 1fr; }
  .dsh-ssh-editor-foot-right { width: 100%; justify-content: flex-end; }
  .dsh-ssh-sftp-label { min-width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-ssh-btn, .dsh-ssh-segment, .dsh-ssh-input { transition: none; }
  .dsh-ssh-editor { animation: none; }
}
`

    /** Install the stylesheet once; returns a disposer. */
    function installStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) return () => {}
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.appendChild(element)
      return () => { element.remove() }
    }

    /**
     * One button with the shared class recipe (native props pass through).
     *
     * Children reach this helper in either of two shapes: the plugin calls it
     * directly as `Btn(props, label)` in most places (so the label is the
     * SECOND argument and must be accepted explicitly), while a createElement
     * render passes it inside `props.children`. Both are supported; without
     * this, every button rendered as an empty box with no visible label.
     */
    function Btn(props, children) {
      const { tone, className, children: declaredChildren } = props
      const rest = Object.assign({}, props)
      delete rest.tone
      delete rest.className
      delete rest.children
      const classes = 'dsh-ssh-btn'
        + (tone === undefined ? '' : ' dsh-ssh-btn-' + tone)
        + (className === undefined ? '' : ' ' + className)
      const content = children === undefined ? declaredChildren : children
      return h('button', Object.assign({ type: 'button', className: classes }, rest), content)
    }

    /** One labelled form control (real `<label htmlFor>`, hint, error). */
    function Field(props) {
      const { id, label, hint, error, children } = props
      return h('div', { className: 'dsh-ssh-field' },
        h('label', { className: 'dsh-ssh-label', htmlFor: id }, label),
        children,
        hint === undefined ? null : h('span', { className: 'dsh-ssh-hint' }, hint),
        error === undefined ? null : h('span', { className: 'dsh-ssh-field-error' }, error),
      )
    }

    /** Inline test result: latency + remote uname output on success, host message on failure. */
    function TestStatus(props) {
      const { t, state } = props
      if (state === null || state === undefined || state.status === 'running') return null
      const ok = state.status === 'ok'
      const latency = typeof state.latencyMs === 'number' ? fmt(t, 'latency', { ms: state.latencyMs }) : ''
      let line = (ok ? '✓ ' : '× ') + (ok ? t('testOk') : t('testFail'))
      if (latency !== '') line += ' · ' + latency
      if (!ok && typeof state.message === 'string' && state.message !== '') line += ': ' + state.message
      return h('div', {
        className: 'dsh-ssh-test ' + (ok ? 'dsh-ssh-test-ok' : 'dsh-ssh-test-fail'),
        role: 'status',
        'aria-live': 'polite',
      },
        h('span', null, line),
        ok && typeof state.output === 'string' && state.output !== ''
          ? h('pre', { className: 'dsh-ssh-output', 'aria-label': t('remoteInfo') }, state.output)
          : null,
      )
    }

    /** Empty-state card with the add button. */
    function EmptyState(props) {
      const { t, onAdd } = props
      return h('div', { className: 'dsh-ssh-empty' },
        h('div', { className: 'dsh-ssh-empty-title' }, t('emptyTitle')),
        h('p', { className: 'dsh-ssh-empty-desc' }, t('emptyDesc')),
        Btn({ tone: 'primary', onClick: onAdd }, t('add')),
      )
    }

    /** Two-step inline delete confirmation (first click reveals it). */
    function ConfirmDelete(props) {
      const { t, deleting, error, onConfirm, onCancel } = props
      return h('div', { className: 'dsh-ssh-confirm' },
        h('span', { className: 'dsh-ssh-confirm-desc' }, t('confirmDeleteDesc')),
        error !== '' ? h('span', { className: 'dsh-ssh-field-error', role: 'alert' }, error) : null,
        h('div', { className: 'dsh-ssh-confirm-actions' },
          Btn({ tone: 'danger', onClick: onConfirm, disabled: deleting },
            deleting ? t('deleting') : t('confirmDelete')),
          Btn({ tone: 'secondary', disabled: deleting, onClick: onCancel }, t('cancel'))))
    }

    /** Human-readable byte size for transfer status lines. */
    function bytesText(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    }

    /** Encode an ArrayBuffer as base64 (chunked so large files do not overflow the call stack). */
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer)
      const chunk = 0x8000
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
      }
      return btoa(binary)
    }

    /** Decode a base64 payload into a Blob for a browser download. */
    function base64ToBlob(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new Blob([bytes], { type: 'application/octet-stream' })
    }

    /**
     * Inline SFTP panel under one server card: upload a local file to a remote
     * path, or download a remote file to the browser. The panel is expanded in
     * place (no dialog), so the settings column stays the only scroll surface.
     */
    function SftpPanel(props) {
      const { t, server } = props
      const tRef = useRef(t); tRef.current = t
      const aliveRef = useRef(true)
      const fileInputRef = useRef(null)
      const uploadRef = useRef(false)
      const downloadRef = useRef(false)
      const [file, setFile] = useState(null)
      const [remotePath, setRemotePath] = useState('/tmp/')
      const [downloadPath, setDownloadPath] = useState('')
      const [busy, setBusy] = useState(null)
      const [status, setStatus] = useState(null)

      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      const pickFile = event => {
        const picked = event.currentTarget.files !== null && event.currentTarget.files !== undefined
          ? event.currentTarget.files[0] : undefined
        setFile(picked === undefined ? null : picked)
        setStatus(null)
      }

      const upload = () => {
        if (uploadRef.current) return
        if (file === null) { setStatus({ kind: 'err', text: t('sftpNeedFile') }); return }
        const target = remotePath.trim()
        if (target === '') { setStatus({ kind: 'err', text: t('sftpNeedPath') }); return }
        uploadRef.current = true
        setBusy('upload')
        setStatus(null)
        file.arrayBuffer().then(buffer => call('sftp-upload', {
          id: server.id, remotePath: target, fileName: file.name, data: arrayBufferToBase64(buffer),
        })).then(data => {
          if (!aliveRef.current) return
          uploadRef.current = false
          setBusy(null)
          setStatus({
            kind: 'ok',
            text: fmt(tRef.current, 'sftpUploadDone', { path: data.remotePath, bytes: bytesText(data.bytes) }),
          })
        }).catch(caught => {
          if (!aliveRef.current) return
          uploadRef.current = false
          setBusy(null)
          setStatus({ kind: 'err', text: errorText(caught, tRef.current) })
        })
      }

      const download = () => {
        if (downloadRef.current) return
        const target = downloadPath.trim()
        if (target === '') { setStatus({ kind: 'err', text: t('sftpNeedPath') }); return }
        downloadRef.current = true
        setBusy('download')
        setStatus(null)
        call('sftp-download', { id: server.id, remotePath: target }).then(data => {
          if (!aliveRef.current) return
          downloadRef.current = false
          setBusy(null)
          const url = URL.createObjectURL(base64ToBlob(data.data))
          const link = document.createElement('a')
          link.href = url
          link.download = typeof data.fileName === 'string' && data.fileName !== '' ? data.fileName : 'download.bin'
          document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
          setStatus({
            kind: 'ok',
            text: fmt(tRef.current, 'sftpDownloadDone', { path: data.remotePath, bytes: bytesText(data.bytes) }),
          })
        }).catch(caught => {
          if (!aliveRef.current) return
          downloadRef.current = false
          setBusy(null)
          setStatus({ kind: 'err', text: errorText(caught, tRef.current) })
        })
      }

      const fileInputId = 'dsh-ssh-file-' + String(server.id)
      return h('div', { className: 'dsh-ssh-sftp' },
        h('div', { className: 'dsh-ssh-sftp-title' }, t('sftpTitle')),
        h('div', { className: 'dsh-ssh-sftp-row' },
          h('span', { className: 'dsh-ssh-sftp-label' }, t('sftpUpload')),
          h('input', {
            id: fileInputId, ref: fileInputRef, type: 'file', className: 'dsh-ssh-file-input',
            onChange: pickFile, 'aria-hidden': 'true', tabIndex: -1,
          }),
          Btn({
            tone: 'secondary',
            onClick: () => {
              const input = fileInputRef.current
              if (input !== null && typeof input.click === 'function') input.click()
            },
          }, t('sftpChooseFile')),
          h('span', { className: 'dsh-ssh-sftp-file', title: file === null ? '' : file.name },
            file === null ? t('sftpNoFile') : file.name),
          h('input', {
            type: 'text', className: 'dsh-ssh-input dsh-ssh-sftp-path', value: remotePath,
            placeholder: t('sftpRemotePlaceholder'), 'aria-label': t('sftpRemotePath'),
            onChange: event => { setRemotePath(event.currentTarget.value) },
          }),
          Btn({ tone: 'primary', disabled: busy !== null, onClick: upload },
            busy === 'upload' ? t('sftpUploading') : t('sftpUpload'))),
        h('div', { className: 'dsh-ssh-sftp-row' },
          h('span', { className: 'dsh-ssh-sftp-label' }, t('sftpDownload')),
          h('input', {
            type: 'text', className: 'dsh-ssh-input dsh-ssh-sftp-path', value: downloadPath,
            placeholder: t('sftpRemotePlaceholder'), 'aria-label': t('sftpRemotePath'),
            onChange: event => { setDownloadPath(event.currentTarget.value) },
          }),
          Btn({ tone: 'secondary', disabled: busy !== null, onClick: download },
            busy === 'download' ? t('sftpDownloading') : t('sftpDownload'))),
        status === null ? null : h('div', {
          className: 'dsh-ssh-sftp-status ' + (status.kind === 'ok' ? 'dsh-ssh-sftp-status-ok' : 'dsh-ssh-sftp-status-err'),
          role: 'status', 'aria-live': 'polite',
        }, status.text),
      )
    }

    /** One server card: identity + badges + note + per-row test result + actions. */
    function ServerCard(props) {
      const { t, server, onEdit, onRemoved } = props
      const tRef = useRef(t)
      tRef.current = t
      const aliveRef = useRef(true)
      const testingRef = useRef(false)
      const deletingRef = useRef(false)
      const [test, setTest] = useState(null)
      const [confirming, setConfirming] = useState(false)
      const [deleting, setDeleting] = useState(false)
      const [deleteError, setDeleteError] = useState('')
      const [sftpOpen, setSftpOpen] = useState(false)

      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      // A record edited elsewhere invalidates any stale per-row test result.
      useEffect(() => {
        setTest(null)
        setConfirming(false)
        setDeleteError('')
      }, [server.id, server.updatedAt])

      const runTest = () => {
        if (testingRef.current) return
        testingRef.current = true
        setTest({ status: 'running' })
        call('test', { id: server.id }).then(data => {
          testingRef.current = false
          if (!aliveRef.current) return
          if (data !== null && data !== undefined && data.success === true) {
            setTest({ status: 'ok', latencyMs: data.latencyMs, output: data.output })
          } else {
            setTest({
              status: 'fail',
              message: data !== null && data !== undefined && typeof data.message === 'string'
                ? data.message
                : tRef.current('testFail'),
            })
          }
        }).catch(caught => {
          testingRef.current = false
          if (!aliveRef.current) return
          setTest({ status: 'fail', message: errorText(caught, tRef.current) })
        })
      }

      const confirmDelete = () => {
        if (deletingRef.current) return
        deletingRef.current = true
        setDeleting(true)
        setDeleteError('')
        call('delete', { id: server.id }).then(() => {
          deletingRef.current = false
          if (!aliveRef.current) return
          setDeleting(false)
          onRemoved(server.id)
        }).catch(caught => {
          deletingRef.current = false
          if (!aliveRef.current) return
          setDeleting(false)
          setDeleteError(errorText(caught, tRef.current))
        })
      }

      const hasSecret = server.hasPassword === true || server.hasKey === true
      const actionButtons = confirming
        ? h(ConfirmDelete, {
          t, deleting, error: deleteError, onConfirm: confirmDelete,
          onCancel: () => { setConfirming(false); setDeleteError('') },
        })
        : [
          Btn({
            key: 'test', tone: 'secondary', disabled: test !== null && test.status === 'running', onClick: runTest,
          }, test !== null && test.status === 'running' ? t('testing') : t('test')),
          Btn({
            key: 'files', tone: 'secondary', onClick: () => { setSftpOpen(open => !open) },
            'aria-expanded': sftpOpen,
          }, t('files')),
          Btn({ key: 'edit', tone: 'secondary', onClick: onEdit }, t('edit')),
          Btn({ key: 'delete', tone: 'danger', onClick: () => { setConfirming(true) } }, t('delete')),
        ]

      return h('div', { className: 'dsh-ssh-card' },
        h('div', { className: 'dsh-ssh-card-top' },
          h('div', { className: 'dsh-ssh-card-main' },
            h('div', { className: 'dsh-ssh-card-title-row' },
              h('span', { className: 'dsh-ssh-card-name', title: String(server.name) }, String(server.name)),
              h('span', { className: 'dsh-ssh-badge' }, server.authType === 'key' ? t('authKey') : t('authPassword')),
              h('span', { className: 'dsh-ssh-badge' + (hasSecret ? '' : ' dsh-ssh-badge-warn') },
                hasSecret ? t('hasSecret') : t('noSecret')),
            ),
            h('span', { className: 'dsh-ssh-card-user', title: t('colUser') },
              String(server.username) + '@' + String(server.host) + ':' + String(server.port)),
            server.note !== undefined && server.note !== null && server.note !== ''
              ? h('div', { className: 'dsh-ssh-card-note' }, String(server.note)) : null,
            h(TestStatus, { t, state: test }),
          ),
          h('div', { className: 'dsh-ssh-card-actions' }, actionButtons),
        ),
        sftpOpen ? h(SftpPanel, { t, server }) : null,
      )
    }

    /**
     * Add / edit inline panel (expanded under the toolbar, not a modal):
     * inline validation, async save and test-draft. Secret fields start empty
     * while editing; the credential slot keeps a fixed height so switching the
     * authentication method never resizes the panel.
     */
    function EditorDialog(props) {
      const { t, server, onSaved, onClose } = props
      const tRef = useRef(t); tRef.current = t
      const isEdit = server !== null && server !== undefined
      const titleId = 'dsh-ssh-editor-title'
      const [draft, setDraft] = useState(() => draftFrom(isEdit ? server : null))
      const [errors, setErrors] = useState({})
      const [formError, setFormError] = useState('')
      const [saving, setSaving] = useState(false)
      const [dialogTest, setDialogTest] = useState(null)
      const aliveRef = useRef(true); const savingRef = useRef(false); const testingRef = useRef(false)
      const testSeqRef = useRef(0); const firstFieldRef = useRef(null)
      const panelRef = useRef(null); const closeRef = useRef(() => {})

      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      // Inline editor: bring the panel into view and focus its first field.
      useEffect(() => {
        const timer = window.setTimeout(() => {
          const panel = panelRef.current
          if (panel !== null && typeof panel.scrollIntoView === 'function') {
            panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          }
          const field = firstFieldRef.current
          if (field !== null && typeof field.focus === 'function') field.focus()
        }, 0)
        return () => { window.clearTimeout(timer) }
      }, [])

      // Escape closes the inline editor only while focus is inside it (unless saving).
      useEffect(() => {
        const onKeyDown = event => {
          if (event.key !== 'Escape') return
          const panel = panelRef.current
          if (panel === null || !panel.contains(document.activeElement)) return
          event.stopPropagation()
          closeRef.current()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [])

      const requestClose = () => { if (!savingRef.current) onClose() }
      closeRef.current = requestClose

      const check = () => {
        const found = validateDraft(tRef.current, draft, isEdit ? server : null)
        if (Object.keys(found).length === 0) return true
        setErrors(found)
        setFormError('')
        return false
      }

      const patch = (key, value) => {
        testSeqRef.current += 1
        setDraft(previous => Object.assign({}, previous, { [key]: value }))
        setDialogTest(null)
        setFormError('')
        setErrors(previous => {
          if (key === 'authType') return {}
          const field = key === 'privateKey' ? 'key' : key
          if (previous[field] === undefined) return previous
          const next = Object.assign({}, previous)
          delete next[field]
          return next
        })
      }

      const submit = () => {
        if (savingRef.current || !check()) return
        setErrors({})
        setFormError('')
        savingRef.current = true
        setSaving(true)
        call('save', saveBody(draft)).then(data => {
          savingRef.current = false
          if (!aliveRef.current) return
          setSaving(false)
          if (data !== null && data !== undefined && data.server !== undefined) onSaved(data.server)
          onClose()
        }).catch(caught => {
          savingRef.current = false
          if (!aliveRef.current) return
          setSaving(false)
          setFormError(errorText(caught, tRef.current))
        })
      }

      const runTest = () => {
        if (testingRef.current || savingRef.current || !check()) return
        setErrors({})
        setFormError('')
        const seq = ++testSeqRef.current
        testingRef.current = true
        setDialogTest({ status: 'running' })
        call('test-draft', saveBody(draft)).then(data => {
          testingRef.current = false
          if (!aliveRef.current || seq !== testSeqRef.current) return
          const ok = data !== null && data !== undefined && data.success === true
          setDialogTest(ok
            ? { status: 'ok', latencyMs: data.latencyMs, output: data.output }
            : {
              status: 'fail',
              message: data !== null && data !== undefined && typeof data.message === 'string'
                ? data.message
                : tRef.current('testFail'),
            })
        }).catch(caught => {
          testingRef.current = false
          if (!aliveRef.current || seq !== testSeqRef.current) return
          setDialogTest({ status: 'fail', message: errorText(caught, tRef.current) })
        })
      }

      const testing = dialogTest !== null && dialogTest.status === 'running'
      const keepsPassword = isEdit && server.authType === 'password' && server.hasPassword === true
      const keepsKey = isEdit && server.authType === 'key' && server.hasKey === true

      const textInput = (id, value, onChange, options) => {
        const opts = options === undefined ? {} : options
        const invalid = opts.invalid === true
        return h('input', {
          id, value, ref: opts.inputRef, spellCheck: false,
          className: 'dsh-ssh-input' + (invalid ? ' dsh-ssh-input-error' : '')
            + (opts.className === undefined ? '' : ' ' + opts.className),
          type: opts.type === undefined ? 'text' : opts.type,
          autoComplete: opts.autoComplete === undefined ? 'off' : opts.autoComplete,
          placeholder: opts.placeholder, inputMode: opts.inputMode, min: opts.min, max: opts.max,
          'aria-invalid': invalid ? true : undefined,
          onChange: event => { onChange(event.currentTarget.value) },
        })
      }

      const textArea = (id, value, onChange, options) => {
        const opts = options === undefined ? {} : options
        const invalid = opts.invalid === true
        return h('textarea', {
          id, value, spellCheck: false,
          className: 'dsh-ssh-input dsh-ssh-textarea'
            + (opts.className === undefined ? '' : ' ' + opts.className)
            + (invalid ? ' dsh-ssh-input-error' : ''),
          rows: opts.rows === undefined ? 4 : opts.rows,
          maxLength: opts.maxLength, placeholder: opts.placeholder,
          'aria-invalid': invalid ? true : undefined,
          onChange: event => { onChange(event.currentTarget.value) },
        })
      }

      const authOption = (value, label) => h('button', {
        key: 'auth-' + value,
        type: 'button',
        role: 'radio',
        'aria-checked': draft.authType === value,
        className: 'dsh-ssh-segment' + (draft.authType === value ? ' dsh-ssh-segment-on' : ''),
        onClick: () => { patch('authType', value) },
      }, label)

      const fields = [
        h(Field, { key: 'name', id: 'dsh-ssh-field-name', label: t('fieldName'), hint: t('fieldNameHint') },
          textInput('dsh-ssh-field-name', draft.name, v => { patch('name', v) }, { inputRef: firstFieldRef })),
        h('div', { key: 'host-port', className: 'dsh-ssh-field-row' },
          h(Field, { id: 'dsh-ssh-field-host', label: t('fieldHost'), error: errors.host },
            textInput('dsh-ssh-field-host', draft.host, v => { patch('host', v) }, {
              invalid: errors.host !== undefined, placeholder: '192.168.1.10',
            })),
          h(Field, { id: 'dsh-ssh-field-port', label: t('fieldPort'), error: errors.port },
            textInput('dsh-ssh-field-port', draft.port, v => { patch('port', v) }, {
              invalid: errors.port !== undefined,
              type: 'number', inputMode: 'numeric', min: 1, max: 65535,
            }))),
        h(Field, { key: 'username', id: 'dsh-ssh-field-username', label: t('fieldUsername'), error: errors.username },
          textInput('dsh-ssh-field-username', draft.username, v => { patch('username', v) }, {
            invalid: errors.username !== undefined, placeholder: 'root',
          })),
        h('div', { key: 'auth', className: 'dsh-ssh-field' },
          h('span', { className: 'dsh-ssh-label', id: 'dsh-ssh-auth-label' }, t('fieldAuthType')),
          h('div', {
            className: 'dsh-ssh-segment-row', role: 'radiogroup', 'aria-labelledby': 'dsh-ssh-auth-label',
          },
            authOption('password', t('authPassword')), authOption('key', t('authKey')))),
      ]

      const credentialFields = []
      if (draft.authType === 'password') {
        credentialFields.push(h(Field, {
          key: 'password', id: 'dsh-ssh-field-password', label: t('fieldPassword'),
          hint: keepsPassword ? t('secretKeepHint') : t('secretRequiredHint'), error: errors.password,
        }, textInput('dsh-ssh-field-password', draft.password, v => { patch('password', v) }, {
          invalid: errors.password !== undefined, type: 'password', autoComplete: 'new-password',
          placeholder: keepsPassword ? t('secretKeepHint') : '',
        })))
        credentialFields.push(h('p', { key: 'credential-note', className: 'dsh-ssh-credential-note' }, t('credentialNote')))
      } else {
        credentialFields.push(h(Field, {
          key: 'privateKey', id: 'dsh-ssh-field-private-key', label: t('fieldPrivateKey'),
          hint: keepsKey ? t('secretKeepHint') : t('secretRequiredHint'), error: errors.key,
        }, textArea('dsh-ssh-field-private-key', draft.privateKey, v => { patch('privateKey', v) }, {
          invalid: errors.key !== undefined, rows: 4, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
        })))
        credentialFields.push(h(Field, {
          key: 'passphrase', id: 'dsh-ssh-field-passphrase', label: t('fieldPassphrase'),
          hint: keepsKey ? t('secretKeepHint') : undefined,
        }, textInput('dsh-ssh-field-passphrase', draft.passphrase, v => { patch('passphrase', v) }, {
          type: 'password', autoComplete: 'new-password',
        })))
      }

      // The credential slot keeps one fixed height, so switching 密码 / 私钥
      // never resizes the inline editor or shifts the rest of the page.
      fields.push(h('div', { key: 'credential', className: 'dsh-ssh-credential' }, credentialFields))

      fields.push(h(Field, { key: 'note', id: 'dsh-ssh-field-note', label: t('fieldNote') },
        textArea('dsh-ssh-field-note', draft.note, v => { patch('note', v) }, {
          rows: 2, maxLength: 500, className: 'dsh-ssh-textarea-note',
        })))

      // Inline (not a modal) editor: it expands inside the settings column, so
      // the surrounding page keeps its own scroll and no overlay covers it.
      return h('div', {
        className: 'dsh-ssh-editor', role: 'region', 'aria-labelledby': titleId, ref: panelRef,
      },
        h('div', { className: 'dsh-ssh-editor-head' },
          h('div', { className: 'dsh-ssh-editor-head-text' },
            h('h2', { className: 'dsh-ssh-editor-title', id: titleId },
              isEdit ? t('formEditTitle') : t('formAddTitle')),
            isEdit
              ? h('span', { className: 'dsh-ssh-editor-sub' },
                String(server.username) + '@' + String(server.host) + ':' + String(server.port))
              : null),
          Btn({
            tone: 'ghost', className: 'dsh-ssh-icon-btn', onClick: requestClose,
            disabled: saving, 'aria-label': t('close'), title: t('close'),
          }, '×'),
        ),
        h('div', { className: 'dsh-ssh-editor-body' },
          fields,
          h(TestStatus, { t, state: dialogTest }),
          formError === '' ? null : h('div', { className: 'dsh-ssh-form-alert', role: 'alert' }, formError),
        ),
        h('div', { className: 'dsh-ssh-editor-foot' },
          Btn({ tone: 'secondary', onClick: runTest, disabled: testing || saving },
            testing ? t('testing') : t('testInDialog')),
          h('div', { className: 'dsh-ssh-editor-foot-right' },
            Btn({ tone: 'secondary', onClick: requestClose, disabled: saving }, t('cancel')),
            Btn({ tone: 'primary', onClick: submit, disabled: saving }, saving ? t('saving') : t('save')),
          ),
        ),
      )
    }

    /** The settings section: header, loading/error/empty/list states, dialog. */
    function Section(props) {
      const t = props.t; const tRef = useRef(t); tRef.current = t
      const [servers, setServers] = useState([])
      const [status, setStatus] = useState('loading')
      const [error, setError] = useState('')
      const [reloadKey, setReloadKey] = useState(0)
      const [dialog, setDialog] = useState(null)
      const triggerRef = useRef(null); const statusRef = useRef(status); statusRef.current = status

      useEffect(() => {
        let active = true
        setStatus('loading')
        setError('')
        call('list', {}).then(data => {
          if (!active) return
          const list = data !== null && data !== undefined ? data.servers : undefined
          setServers(Array.isArray(list) ? list : [])
          setStatus('ready')
        }).catch(caught => {
          if (!active) return
          setError(errorText(caught, tRef.current))
          setStatus('error')
        })
        return () => { active = false }
      }, [reloadKey])

      // Return focus to the control that opened the dialog once it closes.
      useEffect(() => {
        if (dialog !== null) return
        const trigger = triggerRef.current
        if (trigger !== null && document.contains(trigger) && typeof trigger.focus === 'function') trigger.focus()
      }, [dialog])

      const openEditor = server => {
        const active = document.activeElement
        triggerRef.current = active !== null && typeof active.focus === 'function' ? active : null
        setDialog({ server })
      }

      const handleSaved = saved => {
        if (statusRef.current !== 'ready') { setReloadKey(key => key + 1); return }
        setServers(previous => sortServers(previous.filter(item => item.id !== saved.id).concat([saved])))
      }

      const handleRemoved = id => { setServers(previous => previous.filter(item => item.id !== id)) }

      const countLabel = servers.length === 1
        ? t('serverCountOne') : fmt(t, 'serverCountMany', { count: servers.length })

      const children = [
        h('p', { key: 'intro', className: 'dsh-ssh-intro' }, t('intro')),
        h('div', { key: 'toolbar', className: 'dsh-ssh-toolbar' },
          h('span', { className: 'dsh-ssh-count', title: countLabel, 'aria-label': countLabel },
            h('span', { className: 'dsh-ssh-count-num', 'aria-hidden': 'true' }, String(servers.length)),
            h('span', { className: 'dsh-ssh-count-unit', 'aria-hidden': 'true' }, t('count'))),
          Btn({ tone: 'primary', onClick: () => { openEditor(null) } }, t('add'))),
      ]

      // The editor expands inline directly under the toolbar (no modal overlay).
      if (dialog !== null) {
        children.push(h(EditorDialog, {
          key: dialog.server === null ? 'add' : 'edit-' + String(dialog.server.id),
          t, server: dialog.server, onSaved: handleSaved, onClose: () => { setDialog(null) },
        }))
      }
      if (status === 'loading') {
        children.push(h('div', { key: 'loading', className: 'dsh-ssh-loading', role: 'status' }, t('loading')))
      }
      if (status === 'error') {
        children.push(h('div', { key: 'error', className: 'dsh-ssh-error', role: 'alert' },
          h('span', { className: 'dsh-ssh-error-text' }, error),
          Btn({ tone: 'secondary', onClick: () => { setReloadKey(key => key + 1) } }, t('retry'))))
      }
      if (status === 'ready' && servers.length === 0) {
        children.push(h(EmptyState, { key: 'empty', t, onAdd: () => { openEditor(null) } }))
      }
      if (status === 'ready' && servers.length > 0) {
        children.push(h('div', { key: 'list', className: 'dsh-ssh-list' }, servers.map(server => h(ServerCard, {
          key: server.id, t, server, onEdit: () => { openEditor(server) }, onRemoved: handleRemoved,
        }))))
      }

      return h('div', { className: 'dsh-ssh-section' }, children)
    }

    /** Mount the locale dictionary, the stylesheet, the settings section and the mention sources. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-ssh-manager: locale dictionary')
      ctx.effect(installStyles, 'dsh-ssh-manager: stylesheet')
      const translate = ctx.locale.bind(LOCALE_NS)
      const SectionSlot = slotProps => h(Section, {
        t: slotProps !== null && slotProps !== undefined && typeof slotProps.t === 'function'
          ? slotProps.t
          : translate,
      })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'ssh-manager',
        order: 110,
        locale: LOCALE_NS,
        label: () => translate('nav'),
      }, SectionSlot))

      // Composer completion for both `@` and `/`: list the configured SSH
      // servers and insert `/<host>` so the chat text carries the same
      // slash+IP reference the system prompt and ssh_exec understand.
      mountMentionSource(ctx, translate)
    }

    /**
     * Register the SSH mention sources (`@` and `/`) on the composer
     * input-trigger pipeline.
     *
     * `inputTriggers` is an optional client service owned by
     * `@deepseek-ai/dsh-client-ui-input-trigger`; it may already be mounted when
     * this plugin applies or arrive later, so both paths register through a
     * Cordis scope effect. Any failure is contained here: the settings section
     * must keep working even when the composer pipeline cannot take the source.
     *
     * @param ctx - client root context.
     * @param t - the `sshManager` translate function.
     */
    function mountMentionSource(ctx, t) {
      const triggers = ['@', '/']
      const registerOn = owner => owner.effect(() => {
        const disposers = triggers.map(trigger => owner.inputTriggers.registerSource(createMentionSource(t, trigger)))
        return () => { for (const dispose of disposers) dispose() }
      }, 'dsh-ssh-manager: SSH mention sources')
      try {
        const existing = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined
        if (existing !== undefined) {
          ctx.effect(() => {
            const disposers = triggers.map(trigger => existing.registerSource(createMentionSource(t, trigger)))
            return () => { for (const dispose of disposers) dispose() }
          }, 'dsh-ssh-manager: SSH mention sources')
          return
        }
        if (typeof ctx.inject === 'function') {
          ctx.inject(['inputTriggers'], registerOn)
        }
      } catch (error) {
        console.error('[dsh-ssh-manager] SSH mention source registration failed:', error)
      }
    }

    return { inject: ['slots', 'locale'], apply }
  },
})

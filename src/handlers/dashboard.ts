import { Env } from '../types/shared.js';
import {
  ProxyConfig,
  applyDashboardConfigUpdate,
  loadProxyConfigFromPath,
  persistProxyConfigToPath,
  toDashboardConfigPayload,
  clearProxyConfigCache,
} from '../utils/config-loader.js';
import {
  getAgentStatsDesc,
  getModelStatsDesc,
  getRequestEndpointStatsDesc,
  getRequestStatusCodeFromUpstreamStatsDesc,
  getRequestStatusCodeToEndpointStatsDesc,
  getRequestUpstreamStatsDesc,
} from '../utils/dashboard-stats.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isDashboardReadOnly(env: Env): boolean {
  return !!env.PROXY_CONFIG_URL;
}

function getConfigPathForWrite(env: Env): string {
  if (isDashboardReadOnly(env)) {
    throw new Error('Dashboard config editing is disabled when PROXY_CONFIG_URL is configured');
  }

  if (!env.PROXY_CONFIG_PATH) {
    throw new Error('PROXY_CONFIG_PATH is not configured');
  }

  return env.PROXY_CONFIG_PATH;
}

export function handleDashboardPage(): Response {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proxy Dashboard</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
      th { background-color: #f5f5f5; }
      .card { background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
      .badge { display: inline-block; padding: 2px 8px; background: #4caf50; color: white; border-radius: 4px; font-size: 12px; }
      .model-tag { display: inline-block; padding: 2px 6px; background: #e3f2fd; border: 1px solid #90caf9; border-radius: 4px; font-size: 11px; margin: 2px; }
      h3 { margin-top: 0; }
      .api-key-note { font-size: 12px; color: #666; margin-top: 5px; }
      /* Login section */
      #login-providers-list { list-style: none; padding: 0; margin: 0; }
      #login-providers-list li { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #eee; }
      #login-providers-list li:last-child { border-bottom: none; }
      .provider-name { min-width: 140px; font-weight: 500; }
      .login-btn { padding: 4px 14px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
      .login-btn:hover { background: #1565c0; }
      .login-btn:disabled { background: #90a4ae; cursor: default; }
      .login-status { font-size: 12px; color: #555; }
      .login-status.error { color: #c62828; }
      .login-status.success { color: #2e7d32; }
      .login-status a { color: #1565c0; }
      .alias-config-header { margin-bottom: 10px; }
      .alias-add-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
      .alias-add-row input, .alias-add-row select, .alias-name-input, .alias-target-select { padding: 4px 8px; font-size: 13px; }
      .alias-add-row button, .alias-save-btn, .alias-delete-btn { padding: 4px 10px; border: 1px solid #bdbdbd; border-radius: 4px; background: white; cursor: pointer; }
      .alias-delete-btn { color: #c62828; }
      .alias-message { font-size: 12px; color: #555; min-height: 16px; }
      .alias-message.error { color: #c62828; }
      .alias-message.success { color: #2e7d32; }

      .config-block { border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin-top: 10px; }
      .config-row { display: grid; grid-template-columns: 260px 1fr 1fr; gap: 8px; align-items: center; margin-bottom: 8px; }
      .config-row label { font-weight: 600; }
      input[type="text"], input[type="number"], select {
        width: 100%;
        padding: 6px 10px;
        border: 1px solid #bdbdbd;
        border-radius: 6px;
        background: white;
        font-size: 13px;
        box-sizing: border-box;
      }
      input[type="text"]:focus, input[type="number"]:focus, select:focus {
        outline: none;
        border-color: #1976d2;
        box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.15);
      }
      .config-row .wide { grid-column: 2 / span 2; }
      .row-actions { display: flex; gap: 8px; align-items: center; }
      .mini-btn { padding: 4px 8px; font-size: 12px; }
      .danger { background: #fff1f1; border: 1px solid #ffcccc; }
      .section-actions { margin-top: 8px; }
      .config-divider { margin: 14px 0; border-top: 1px solid #ddd; }
      .config-toolbar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
      .request-submodule { margin-top: 18px; }
      .primary-label { font-size: 11px; color: #444; }
      button {
        padding: 8px 14px;
        border: 1px solid #bdbdbd;
        border-radius: 6px;
        background: white;
        cursor: pointer;
        font-size: 13px;
      }
      button:hover { background: #f3f6fb; }
      button:disabled { opacity: 0.6; cursor: default; }
      #configStatus {
        margin-left: 8px;
        font-size: 11px;
        background: #e3f2fd;
        border: 1px solid #bbdefb;
        color: #1565c0;
        border-radius: 6px;
        padding: 3px 8px;
        min-height: 20px;
        display: inline-flex;
        align-items: center;
      }
    </style>
  </head>
  <body>
    <h1>Proxy Dashboard</h1>

    <section class="card">
      <h2>Config Module</h2>
      <p>Edit <code>models.*</code> and <code>composite</code>. <code>api_key</code> fields are hidden and not editable.</p>
      <div id="configForm"></div>
      <div class="config-divider"></div>
      <div class="config-toolbar">
        <button id="reloadConfig">Reload</button>
        <button id="saveConfig">Save</button>
        <span id="configStatus"></span>
      </div>
    </section>

    <section class="card">
      <h2>Model Statistic</h2>
      <table id="modelStats">
        <thead><tr><th>Model</th><th>Requests</th><th>Input Tokens</th><th>Cached Tokens</th><th>Cache Writen Tokens</th><th>Output Tokens</th><th>Total Tokens</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section class="card">
      <h2>Agent Statistic</h2>
      <table id="agentStats">
        <thead><tr><th>Agent / Tool</th><th>Requests</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section class="card">
      <h2>Request Statistic</h2>

      <div class="request-submodule">
        <h3>Requests Numbers</h3>
        <table id="requestEndpointStats">
          <thead><tr><th>Endpoint</th><th>Requests</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <h3>Responses Numbers</h3>
        <table id="requestUpstreamStats">
          <thead><tr><th>Upstream Base URL</th><th>Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <h3>Response (from upstreams)</h3>
        <table id="requestStatusCodeFromUpstreamStats">
          <thead><tr><th>Status Code</th><th>Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <h3>Response (to endpoints)</h3>
        <table id="requestStatusCodeToEndpointStats">
          <thead><tr><th>Status Code</th><th>Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <script>
      const configForm = document.getElementById('configForm');
      const configStatus = document.getElementById('configStatus');
      const saveButton = document.getElementById('saveConfig');
      let currentConfig = { models: {}, composite: {} };
      let isReadOnly = false;

      function escapeHtml(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function upstreamModeSelect(categoryName, currentMode) {
        const options = ['anthropic-messages', 'openai-completions', 'openai-responses', 'gemini-generatecontent', 'gemini-interactions'];
        const optionHtml = options.map((mode) => {
          const selected = mode === currentMode ? ' selected' : '';
          return '<option value="' + escapeHtml(mode) + '"' + selected + '>' + escapeHtml(mode) + '</option>';
        }).join('');

        return '<select class="wide" data-kind="cat-upstream" data-category="' + escapeHtml(categoryName) + '">'
          + optionHtml
          + '</select>';
      }

      function modelEntryRow(categoryName, modelKey, modelValue) {
        const alias = Array.isArray(modelValue) ? modelValue[0] || '' : (modelValue || '');
        const base = Array.isArray(modelValue) ? modelValue[1] || '' : '';
        return '<div class="config-row">'
          + '<label>' + escapeHtml(modelKey) + '</label>'
          + '<input type="text" data-kind="model-alias" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" value="' + escapeHtml(alias) + '" placeholder="model alias" />'
          + '<div class="row-actions">'
            + '<input type="text" data-kind="model-base" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" value="' + escapeHtml(base) + '" placeholder="base_url override" />'
            + '<button type="button" class="mini-btn danger" data-action="remove-model" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '"' + (isReadOnly ? ' disabled' : '') + '>Remove</button>'
          + '</div>'
          + '</div>';
      }

      function compositeEntryRows(aliasName, targets) {
        const keys = Object.keys(targets || {});
        if (keys.length === 0) {
          return '<div class="config-row"><label>' + escapeHtml(aliasName) + '</label><div class="wide">(empty)</div></div>';
        }
        return keys.map((targetName) => {
          const cfg = targets[targetName] || {};
          const share = cfg.share ?? '';
          const fallback = cfg.fallback ?? '';
          const primary = cfg.primary === true ? 'checked' : '';
          return '<div class="config-row">'
            + '<label>' + escapeHtml(targetName) + '</label>'
            + '<input type="number" data-kind="comp-share" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(share) + '" placeholder="share" />'
            + '<div class="row-actions">'
              + '<input type="number" data-kind="comp-fallback" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(fallback) + '" placeholder="fallback" style="width: 120px;" />'
              + '<label class="primary-label"><input type="checkbox" data-kind="comp-primary" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" ' + primary + ' /> primary</label>'
              + '<button type="button" class="mini-btn danger" data-action="remove-composite-target" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + '>Remove</button>'
            + '</div>'
            + '</div>';
        }).join('');
      }

      function renderConfigForm(config) {
        const modelBlocks = Object.entries(config.models || {}).map(([categoryName, category]) => {
          const rows = [];
          rows.push('<div class="config-row"><label>' + escapeHtml(categoryName + '.upstream_mode') + '</label>' + upstreamModeSelect(categoryName, category.upstream_mode || '') + '</div>');
          rows.push('<div class="config-row"><label>' + escapeHtml(categoryName + '.base_url') + '</label><input class="wide" type="text" data-kind="cat-base" data-category="' + escapeHtml(categoryName) + '" value="' + escapeHtml(category.base_url || '') + '" /></div>');

          Object.entries(category).forEach(([key, value]) => {
            if (key === 'upstream_mode' || key === 'base_url') return;
            rows.push(modelEntryRow(categoryName, key, value));
          });

          rows.push('<div class="section-actions"><button type="button" class="mini-btn" data-action="add-model" data-category="' + escapeHtml(categoryName) + '"' + (isReadOnly ? ' disabled' : '') + '>Add model entry</button></div>');

          return '<div class="config-block"><h3>models.' + escapeHtml(categoryName) + '</h3>' + rows.join('') + '</div>';
        }).join('');

        const compositeBlocks = Object.entries(config.composite || {}).map(([aliasName, targets]) => {
          const rows = compositeEntryRows(aliasName, targets)
            + '<div class="section-actions"><button type="button" class="mini-btn" data-action="add-composite-target" data-alias="' + escapeHtml(aliasName) + '"' + (isReadOnly ? ' disabled' : '') + '>Add target</button>'
            + ' <button type="button" class="mini-btn danger" data-action="remove-composite-alias" data-alias="' + escapeHtml(aliasName) + '"' + (isReadOnly ? ' disabled' : '') + '>Remove alias</button></div>';
          return '<div class="config-block"><h3>composite.' + escapeHtml(aliasName) + '</h3>' + rows + '</div>';
        }).join('');

        const compositeGlobalActions = '<div class="section-actions"><button type="button" class="mini-btn" data-action="add-composite-alias"' + (isReadOnly ? ' disabled' : '') + '>Add composite alias</button></div>';

        configForm.innerHTML = modelBlocks + compositeBlocks + compositeGlobalActions;
      }

      function collectConfigPayload() {
        const payload = { models: {}, composite: {} };

        Object.keys(currentConfig.models || {}).forEach((categoryName) => {
          payload.models[categoryName] = {};
        });

        document.querySelectorAll('[data-kind="cat-upstream"]').forEach((el) => {
          const category = el.dataset.category;
          payload.models[category].upstream_mode = el.value;
        });

        document.querySelectorAll('[data-kind="cat-base"]').forEach((el) => {
          const category = el.dataset.category;
          payload.models[category].base_url = el.value;
        });

        document.querySelectorAll('[data-kind="model-alias"]').forEach((el) => {
          const category = el.dataset.category;
          const key = el.dataset.key;
          const alias = el.value;
          const baseEl = document.querySelector('[data-kind="model-base"][data-category="' + category + '"][data-key="' + key + '"]');
          const base = baseEl ? baseEl.value : '';
          payload.models[category][key] = [alias, base];
        });

        const selectedPrimaryByAlias = {};
        document.querySelectorAll('[data-kind="comp-primary"]').forEach((el) => {
          if (el.checked) {
            selectedPrimaryByAlias[el.dataset.alias] = el.dataset.target;
          }
        });

        Object.entries(currentConfig.composite || {}).forEach(([aliasName, targets]) => {
          payload.composite[aliasName] = {};
          Object.keys(targets || {}).forEach((targetName) => {
            const shareEl = document.querySelector('[data-kind="comp-share"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const fallbackEl = document.querySelector('[data-kind="comp-fallback"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const entry = {};
            if (shareEl && shareEl.value !== '') entry.share = Number(shareEl.value);
            if (fallbackEl && fallbackEl.value !== '') entry.fallback = Number(fallbackEl.value);
            if (selectedPrimaryByAlias[aliasName] === targetName) entry.primary = true;
            payload.composite[aliasName][targetName] = entry;
          });
        });

        return payload;
      }

      function ensureCategory(categoryName) {
        if (!currentConfig.models[categoryName]) {
          currentConfig.models[categoryName] = { upstream_mode: '', base_url: '' };
        }
      }

      function ensureSinglePrimary(aliasName, targetName) {
        document.querySelectorAll('[data-kind="comp-primary"][data-alias="' + aliasName + '"]').forEach((el) => {
          el.checked = el.dataset.target === targetName;
        });
      }

      function handleConfigAction(event) {
        if (isReadOnly) {
          return;
        }

        const target = event.target;
        if (!target || !target.dataset) return;

        if (target.dataset.kind === 'comp-primary' && target.checked) {
          ensureSinglePrimary(target.dataset.alias, target.dataset.target);
          return;
        }

        if (!target.dataset.action) return;

        currentConfig = collectConfigPayload();
        const action = target.dataset.action;

        if (action === 'add-model') {
          const category = target.dataset.category;
          if (!category) return;
          ensureCategory(category);
          const key = window.prompt('New model key (e.g. gpt-5-mini):');
          if (!key) return;
          if (currentConfig.models[category][key] !== undefined) {
            window.alert('Model key already exists in this category');
            return;
          }
          currentConfig.models[category][key] = ['', ''];
          renderConfigForm(currentConfig);
          return;
        }

        if (action === 'remove-model') {
          const category = target.dataset.category;
          const key = target.dataset.key;
          if (!category || !key) return;
          if (!window.confirm('Remove models.' + category + '.' + key + '?')) return;
          delete currentConfig.models[category][key];
          renderConfigForm(currentConfig);
          return;
        }

        if (action === 'add-composite-alias') {
          const alias = window.prompt('New composite alias (e.g. gpt-all):');
          if (!alias) return;
          if (currentConfig.composite[alias]) {
            window.alert('Composite alias already exists');
            return;
          }
          currentConfig.composite[alias] = {};
          renderConfigForm(currentConfig);
          return;
        }

        if (action === 'remove-composite-alias') {
          const alias = target.dataset.alias;
          if (!alias) return;
          if (!window.confirm('Remove composite.' + alias + '?')) return;
          delete currentConfig.composite[alias];
          renderConfigForm(currentConfig);
          return;
        }

        if (action === 'add-composite-target') {
          const alias = target.dataset.alias;
          if (!alias) return;
          const targetModel = window.prompt('New target model for composite.' + alias + ':');
          if (!targetModel) return;
          if (!currentConfig.composite[alias]) {
            currentConfig.composite[alias] = {};
          }
          if (currentConfig.composite[alias][targetModel]) {
            window.alert('Composite target already exists');
            return;
          }
          currentConfig.composite[alias][targetModel] = {};
          renderConfigForm(currentConfig);
          return;
        }

        if (action === 'remove-composite-target') {
          const alias = target.dataset.alias;
          const targetModel = target.dataset.target;
          if (!alias || !targetModel) return;
          if (!window.confirm('Remove composite target ' + alias + ' -> ' + targetModel + '?')) return;
          if (currentConfig.composite[alias]) {
            delete currentConfig.composite[alias][targetModel];
          }
          renderConfigForm(currentConfig);
          return;
        }
      }

      async function loadConfig() {
        configStatus.textContent = 'Loading...';
        const res = await fetch('/dashboard/api/config');
        const json = await res.json();
        isReadOnly = json.read_only === true;
        currentConfig = {
          models: json.models || {},
          composite: json.composite || {},
        };
        renderConfigForm(currentConfig);
        saveButton.disabled = isReadOnly;
        configStatus.textContent = isReadOnly ? 'Loaded (read-only: PROXY_CONFIG_URL configured)' : 'Loaded';
      }

      async function saveConfig() {
        if (isReadOnly) {
          configStatus.textContent = 'Read-only mode: config source is PROXY_CONFIG_URL';
          return;
        }

        configStatus.textContent = 'Saving...';
        try {
          const parsed = collectConfigPayload();
          const res = await fetch('/dashboard/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
          });
          const result = await res.json();
          if (!res.ok) {
            throw new Error(result.error || 'Save failed');
          }
          currentConfig = result.config;
          renderConfigForm(currentConfig);
          configStatus.textContent = 'Saved';
        } catch (err) {
          configStatus.textContent = 'Error: ' + err.message;
        }
      }

      function renderRows(tableId, rows, mapper) {
        const tbody = document.querySelector(tableId + ' tbody');
        tbody.innerHTML = rows.map(mapper).join('');
      }

      async function loadModelStats() {
        const res = await fetch('/dashboard/api/stats/models');
        const json = await res.json();
        renderRows('#modelStats', json.data || [], (row) =>
          '<tr><td>' + row.model + '</td><td>' + row.requests + '</td><td>' + row.input_tokens + '</td><td>' + row.cached_tokens + '</td><td>' + row.cache_writen_tokens + '</td><td>' + row.output_tokens + '</td><td>' + row.total_tokens + '</td></tr>'
        );
      }

      async function loadAgentStats() {
        const res = await fetch('/dashboard/api/stats/agents');
        const json = await res.json();
        renderRows('#agentStats', json.data || [], (row) =>
          '<tr><td>' + row.key + '</td><td>' + row.requests + '</td></tr>'
        );
      }

      async function loadRequestStats() {
        const res = await fetch('/dashboard/api/stats/requests');
        const json = await res.json();

        renderRows('#requestEndpointStats', json.endpoints || [], (row) =>
          '<tr><td>' + row.endpoint + '</td><td>' + row.requests + '</td></tr>'
        );

        renderRows('#requestUpstreamStats', json.upstreams || [], (row) =>
          '<tr><td>' + row.upstream_base_url + '</td><td>' + row.responses + '</td></tr>'
        );

        renderRows('#requestStatusCodeFromUpstreamStats', json.status_codes_from_upstreams || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td>' + row.responses + '</td></tr>'
        );

        renderRows('#requestStatusCodeToEndpointStats', json.status_codes_to_endpoints || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td>' + row.responses + '</td></tr>'
        );
      }

      document.getElementById('reloadConfig').addEventListener('click', loadConfig);
      document.getElementById('saveConfig').addEventListener('click', saveConfig);
      configForm.addEventListener('click', handleConfigAction);

      async function refreshAll() {
        await Promise.all([loadConfig(), loadModelStats(), loadAgentStats(), loadRequestStats()]);
      }

      refreshAll();
      setInterval(() => {
        loadModelStats();
        loadAgentStats();
        loadRequestStats();
      }, 5000);
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function handleDashboardGetConfig(proxyConfig: ProxyConfig, env: Env): Response {
  const payload = toDashboardConfigPayload(proxyConfig);
  return jsonResponse({
    ...payload,
    read_only: isDashboardReadOnly(env),
  });
}

export async function handleDashboardPutConfig(request: Request, env: Env, proxyConfig: ProxyConfig): Promise<Response> {
  try {
    const payload = await request.json();
    const configPath = getConfigPathForWrite(env);

    const baseConfig = loadProxyConfigFromPath(configPath);
    const nextConfig = applyDashboardConfigUpdate(baseConfig, payload);

    persistProxyConfigToPath(configPath, nextConfig);
    clearProxyConfigCache();

    return jsonResponse({ status: 'ok', config: toDashboardConfigPayload(nextConfig) });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export function handleDashboardModelStats(): Response {
  return jsonResponse({ data: getModelStatsDesc() });
}

export function handleDashboardAgentStats(): Response {
  return jsonResponse({ data: getAgentStatsDesc() });
}

export function handleDashboardRequestStats(): Response {
  return jsonResponse({
    endpoints: getRequestEndpointStatsDesc(),
    upstreams: getRequestUpstreamStatsDesc(),
    status_codes_from_upstreams: getRequestStatusCodeFromUpstreamStatsDesc(),
    status_codes_to_endpoints: getRequestStatusCodeToEndpointStatsDesc(),
  });
}

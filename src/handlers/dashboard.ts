import { Env } from '../types/shared.js';
import {
  ProxyConfig,
  CompositeTargetPatch,
  applyDashboardConfigUpdate,
  addCompositeAlias,
  getCompositeRouteCandidates,
  getConfiguredModelIds,
  loadProxyConfigFromPath,
  persistProxyConfigToPath,
  removeCompositeAlias,
  removeCompositeTarget,
  toDashboardConfigPayload,
  upsertCompositeAliasLimit,
  upsertCompositeTarget,
  clearProxyConfigCache,
  loadProxyConfig,
} from '../utils/config-loader.js';
import {
  getAgentStatsDesc,
  getModelStatsDesc,
  getRequestEndpointStatsDesc,
  getRequestEndpointTimingStatsDesc,
  getRequestStatusCodeFromUpstreamStatsDesc,
  getRequestStatusCodeToEndpointStatsDesc,
  getRequestUpstreamStatsDesc,
  getTokenHeatmapStatsDesc,
  getToolUsageStatsDesc,
  getUpstreamResponseToolStatsDesc,
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

export interface DashboardSnapshot {
  config: ReturnType<typeof toDashboardConfigPayload> & {
    read_only: boolean;
    config_path: string | null;
  };
  modelStats: ReturnType<typeof getModelStatsDesc>;
  toolStats: ReturnType<typeof getToolUsageStatsDesc>;
  requestStats: {
    endpoints: ReturnType<typeof getRequestEndpointStatsDesc>;
    upstreams: ReturnType<typeof getRequestUpstreamStatsDesc>;
    upstream_response_tools: ReturnType<typeof getUpstreamResponseToolStatsDesc>;
    status_codes_from_upstreams: ReturnType<typeof getRequestStatusCodeFromUpstreamStatsDesc>;
    status_codes_to_endpoints: ReturnType<typeof getRequestStatusCodeToEndpointStatsDesc>;
    endpoint_timings: ReturnType<typeof getRequestEndpointTimingStatsDesc>;
  };
  tokenHeatmap: ReturnType<typeof getTokenHeatmapStatsDesc>;
  compositeResolved: Array<{
    alias: string;
    targets: Array<{
      model: string;
      routeModel: string | undefined;
      upstreamMode: string;
      targetUrl: string;
    }>;
  }>;
}

export function getDashboardSnapshot(proxyConfig: ProxyConfig, env: Env): DashboardSnapshot {
  const config = {
    ...toDashboardConfigPayload(proxyConfig),
    read_only: isDashboardReadOnly(env),
    config_path: env.PROXY_CONFIG_PATH || null,
  };

  const compositeResolved = Object.keys(config.composite)
    .sort((a, b) => a.localeCompare(b))
    .map((alias) => ({
      alias,
      targets: getCompositeRouteCandidates(alias, proxyConfig).map((candidate) => ({
        model: candidate.modelName,
        routeModel: candidate.route.modelAlias,
        upstreamMode: candidate.route.upstreamMode,
        targetUrl: candidate.route.targetUrl,
      })),
    }));

  return {
    config,
    modelStats: getModelStatsDesc(),
    toolStats: getToolUsageStatsDesc(),
    requestStats: {
      endpoints: getRequestEndpointStatsDesc(),
      upstreams: getRequestUpstreamStatsDesc(),
      upstream_response_tools: getUpstreamResponseToolStatsDesc(),
      status_codes_from_upstreams: getRequestStatusCodeFromUpstreamStatsDesc(),
      status_codes_to_endpoints: getRequestStatusCodeToEndpointStatsDesc(),
      endpoint_timings: getRequestEndpointTimingStatsDesc(),
    },
    tokenHeatmap: getTokenHeatmapStatsDesc(),
    compositeResolved,
  };
}

function saveConfigMutation(env: Env, mutate: (baseConfig: ProxyConfig) => ProxyConfig): ReturnType<typeof toDashboardConfigPayload> {
  const configPath = getConfigPathForWrite(env);
  const baseConfig = loadProxyConfigFromPath(configPath);
  const nextConfig = mutate(baseConfig);
  persistProxyConfigToPath(configPath, nextConfig);
  clearProxyConfigCache();
  return toDashboardConfigPayload(nextConfig);
}

export function addCompositeAliasFromDashboard(env: Env, alias: string): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => addCompositeAlias(baseConfig, alias));
}

export function removeCompositeAliasFromDashboard(env: Env, alias: string): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => removeCompositeAlias(baseConfig, alias));
}

export function upsertCompositeTargetFromDashboard(
  env: Env,
  alias: string,
  targetModel: string,
  patch: CompositeTargetPatch,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) =>
    upsertCompositeTarget(baseConfig, alias, targetModel, patch, getConfiguredModelIds(baseConfig)),
  );
}

export function upsertCompositeAliasLimitFromDashboard(
  env: Env,
  alias: string,
  totalTokenLimit: number | null,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => upsertCompositeAliasLimit(baseConfig, alias, totalTokenLimit));
}

export function removeCompositeTargetFromDashboard(
  env: Env,
  alias: string,
  targetModel: string,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => removeCompositeTarget(baseConfig, alias, targetModel));
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
      .num { text-align: right; }
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
      .config-divider { margin: 14px 0; border-top: 3px solid #fff; }
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
      /* Floating side nav */
      .side-nav { position: fixed; top: 50%; right: 0; transform: translateY(-50%); display: flex; flex-direction: column; gap: 2px; z-index: 1000; }
      .side-nav a { display: block; padding: 8px 14px; background: #e0e0e0; color: #333; text-decoration: none; font-size: 13px; border-radius: 6px 0 0 6px; transition: background 0.15s; opacity: 0.7; }
      .side-nav a:hover { opacity: 1; }
      .side-nav a.active { background: white; opacity: 0.9; border: 1px solid #d3d3d3; border-right: none; }
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

    <div class="side-nav" id="sideNav">
      <a href="#section-config">Config</a>
      <a href="#section-model">Model</a>
      <a href="#section-request">Request</a>
      <a href="#section-agent">Agent</a>
    </div>

    <section class="card" id="section-config">
      <h2>Config Module</h2>
      <p>Edit config for <code>models.*</code> and <code>composite.*</code> as models alias. Note the <code>api_key</code> fields are hidden and not editable.</p>
      <div id="configForm"></div>
      <div class="config-divider"></div>
      <div class="config-toolbar">
        <button id="reloadConfig">Reload</button>
        <button id="saveConfig">Save</button>
        <span id="configStatus"></span>
      </div>
    </section>

    <section class="card" id="section-model">
      <h2>Model Statistic <button id="exportModelStatsCsv" class="mini-btn" style="font-size:12px;">Export CSV</button></h2>
      <table id="modelStats">
        <thead><tr><th>Model ID</th><th class="num">Requests</th><th class="num">Failed</th><th class="num">Input Tokens</th><th class="num">Cached Tokens</th><th class="num">Cache Written Tokens</th><th class="num">Output Tokens</th><th class="num">Total Tokens</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section class="card" id="section-request">
      <h2>Request Statistic</h2>

      <div class="request-submodule">
        <h3>Requests Numbers</h3>
        <table id="requestEndpointStats">
          <thead><tr><th>Endpoint</th><th class="num">Requests</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <h3>Status Count</h3>
        <table id="requestUpstreamStats">
          <thead><tr><th>Upstream Base URL</th><th class="num">Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <table id="requestStatusCodeFromUpstreamStats">
          <thead><tr><th>Status Code of Upstreams</th><th class="num">Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <table id="requestStatusCodeToEndpointStats">
          <thead><tr><th>Status Code of Endpoints</th><th class="num">Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <h3>Timing</h3>
        <table id="requestEndpointTimingStats">
          <thead><tr><th>Endpoint</th><th class="num">Min (ms)</th><th class="num">Avg (ms)</th><th class="num">Max (ms)</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <section class="card" id="section-agent">
      <h2>Tool Usage <button id="toggleToolStats" class="mini-btn" style="font-size:12px;">Show all</button></h2>
      <table id="toolStats">
        <thead><tr><th>Tool</th><th class="num">In requests</th><th class="num">In responses</th><th class="num">Total len</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <script>
      const configForm = document.getElementById('configForm');
      const configStatus = document.getElementById('configStatus');
      const saveButton = document.getElementById('saveConfig');
      let currentConfig = { models: {}, composite: {} };
      let isReadOnly = false;
      let configPathHint = '';
      let compositeResolved = [];
      let modelStats = [];

      function getAliasUsed(aliasName) {
        const resolved = compositeResolved.find(r => r.alias === aliasName);
        if (!resolved) return 0;
        return resolved.targets.reduce((sum, t) => {
          const statKey = t.routeModel || t.model;
          const entry = modelStats.find(m => m.model === statKey);
          return sum + (entry ? entry.total_tokens : 0);
        }, 0);
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function upstreamModeSelect(categoryName, currentMode) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const options = ['anthropic-messages', 'openai-completions', 'openai-responses', 'gemini-generatecontent', 'gemini-interactions'];
        const optionHtml = options.map((mode) => {
          const selected = mode === currentMode ? ' selected' : '';
          return '<option value="' + escapeHtml(mode) + '"' + selected + '>' + escapeHtml(mode) + '</option>';
        }).join('');

        return '<select class="wide" data-kind="cat-upstream" data-category="' + escapeHtml(categoryName) + '"' + disabledAttr + '>'
          + optionHtml
          + '</select>';
      }

      function modelEntryRow(categoryName, modelKey, modelValue) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const alias = Array.isArray(modelValue) ? modelValue[0] || '' : (modelValue || '');
        const base = Array.isArray(modelValue) ? modelValue[1] || '' : '';
        return '<div class="config-row">'
          + '<label>' + escapeHtml(modelKey) + '</label>'
          + '<input type="text" data-kind="model-alias" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" value="' + escapeHtml(alias) + '" placeholder="model alias"' + disabledAttr + ' />'
          + '<div class="row-actions">'
            + '<input type="text" data-kind="model-base" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" value="' + escapeHtml(base) + '" placeholder="base_url override"' + disabledAttr + ' />'
            + '<button type="button" class="mini-btn danger" data-action="remove-model" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
          + '</div>'
          + '</div>';
      }

      function compositeEntryRows(aliasName, targets) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const keys = Object.keys(targets || {}).filter((key) => key !== 'total_token_limit');
        const totalTokenLimit = targets.total_token_limit ?? '';
        const aliasUsed = getAliasUsed(aliasName);
        const usageLabel = '<span style="font-size:13px;color:#666;margin-left:6px;">Used: ' + aliasUsed + ' (reset after proxy restarted.)</span>';
        const rows = [
          '<div class="config-row">'
            + '<label>' + escapeHtml(aliasName + '.total_token_limit') + '</label>'
            + '<input type="number" data-kind="comp-total-limit" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(totalTokenLimit) + '" placeholder="token limit"' + disabledAttr + ' />'
            + usageLabel
            + '</div>'
        ];
        if (keys.length === 0) {
          rows.push('<div class="config-row"><label>' + escapeHtml(aliasName) + '</label><div class="wide">(empty)</div></div>');
          return rows.join('');
        }
        return rows.concat(keys.map((targetName) => {
          const cfg = targets[targetName] || {};
          const share = cfg.share ?? '';
          const fallback = cfg.fallback === 0 ? 'no FB' : cfg.fallback ?? '';
          const primary = cfg.primary === true ? 'checked' : '';
          return '<div class="config-row">'
            + '<label>' + escapeHtml(targetName) + '</label>'
            + '<input type="number" data-kind="comp-share" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(share) + '" placeholder="share"' + disabledAttr + ' />'
            + '<div class="row-actions">'
              + '<label class="primary-label"><input type="checkbox" data-kind="comp-primary" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" ' + primary + disabledAttr + ' /> primary</label>'
              + '<input type="number" data-kind="comp-fallback" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(fallback) + '" placeholder="fallback" style="width: 120px;"' + disabledAttr + ' />'
              + '<button type="button" class="mini-btn danger" data-action="remove-composite-target" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
            + '</div>'
            + '</div>';
        })).join('');
      }

      function renderConfigForm(config) {
        const modelBlocks = Object.entries(config.models || {}).map(([categoryName, category]) => {
          const disabledAttr = isReadOnly ? ' disabled' : '';
          const rows = [];
          rows.push('<div class="config-row"><label>' + escapeHtml(categoryName + '.upstream_mode') + '</label>' + upstreamModeSelect(categoryName, category.upstream_mode || '') + '</div>');
          rows.push('<div class="config-row"><label>' + escapeHtml(categoryName + '.base_url') + '</label><input class="wide" type="text" data-kind="cat-base" data-category="' + escapeHtml(categoryName) + '" value="' + escapeHtml(category.base_url || '') + '"' + disabledAttr + ' /></div>');

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

        configForm.innerHTML = modelBlocks + '<div class="config-divider"></div>' + compositeBlocks + compositeGlobalActions;
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
          const totalLimitEl = document.querySelector('[data-kind="comp-total-limit"][data-alias="' + aliasName + '"]');
          if (totalLimitEl && totalLimitEl.value !== '') {
            payload.composite[aliasName].total_token_limit = Number(totalLimitEl.value);
          }
          Object.keys(targets || {}).forEach((targetName) => {
            if (targetName === 'total_token_limit') return;
            const shareEl = document.querySelector('[data-kind="comp-share"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const fallbackEl = document.querySelector('[data-kind="comp-fallback"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const entry = {};
            if (shareEl && shareEl.value !== '') entry.share = Number(shareEl.value);
            if (fallbackEl && fallbackEl.value !== '') {
              const fallbackValue = Number(fallbackEl.value);
              if (fallbackValue !== 0) entry.fallback = fallbackValue;
            }
            const primaryEl = document.querySelector('[data-kind="comp-primary"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            if (primaryEl && primaryEl.checked) entry.primary = true;
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
          saveConfig();
          return;
        }

        if (action === 'remove-model') {
          const category = target.dataset.category;
          const key = target.dataset.key;
          if (!category || !key) return;
          if (!window.confirm('Remove models.' + category + '.' + key + '?')) return;
          delete currentConfig.models[category][key];
          renderConfigForm(currentConfig);
          saveConfig();
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
          saveConfig();
          return;
        }

        if (action === 'remove-composite-alias') {
          const alias = target.dataset.alias;
          if (!alias) return;
          if (!window.confirm('Remove composite.' + alias + '?')) return;
          delete currentConfig.composite[alias];
          renderConfigForm(currentConfig);
          saveConfig();
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
          saveConfig();
          return;
        }

        if (target.dataset.kind === 'comp-total-limit') {
          const alias = target.dataset.alias;
          if (!alias) return;
          const value = target.value.trim();
          if (value !== '' && Number.isNaN(Number(value))) {
            window.alert('Total token limit must be a number or blank');
            return;
          }
          currentConfig.composite[alias].total_token_limit = value === '' ? undefined : Number(value);
          renderConfigForm(currentConfig);
          saveConfig();
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
          saveConfig();
          return;
        }
      }

      async function loadConfig() {
        configStatus.textContent = 'Loading...';
        const res = await fetch('/dashboard/api/config');
        const json = await res.json();
        isReadOnly = json.config.read_only === true;
        currentConfig = {
          models: json.config.models || {},
          composite: json.config.composite || {},
        };
        compositeResolved = json.compositeResolved || [];
        modelStats = json.modelStats || [];
        renderConfigForm(currentConfig);
        saveButton.disabled = isReadOnly;
        configPathHint = json.config.config_path ? ' (' + json.config.config_path + ')' : '';
        if (isReadOnly) {
          configStatus.textContent = 'Loaded (read-only: remote)' + configPathHint;
        } else {
          configStatus.textContent = 'Loaded' + configPathHint;
        }
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
          await loadConfig();
          configStatus.textContent = 'Saved' + configPathHint;
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
          '<tr><td>' + (row.model.split('/').pop() || row.model) + '</td><td class="num">' + row.requests + '</td><td class="num">' + (row.failed_requests || 0) + '</td><td class="num">' + row.input_tokens + '</td><td class="num">' + row.cached_tokens + '</td><td class="num">' + row.cache_written_tokens + '</td><td class="num">' + row.output_tokens + '</td><td class="num">' + row.total_tokens + '</td></tr>'
        );
      }

      let toolStatsExpanded = false;

      function renderToolRows(data) {
        const tbody = document.querySelector('#toolStats tbody');
        const rows = toolStatsExpanded ? data : data.slice(0, 10);
        tbody.innerHTML = rows.map((row) =>
          '<tr><td>' + row.tool_name + '</td><td class="num">' + row.in_requests + '</td><td class="num">' + row.in_responses + '</td><td class="num">' + (row.in_request_chars || 0) + '</td></tr>'
        ).join('');
        const btn = document.getElementById('toggleToolStats');
        if (data.length > 10) {
          btn.style.display = 'inline-block';
          btn.textContent = toolStatsExpanded ? 'Collapse' : 'Show all (' + data.length + ')';
        } else {
          btn.style.display = 'none';
        }
      }

      async function loadToolStats() {
        const res = await fetch('/dashboard/api/stats/agents');
        const json = await res.json();
        renderToolRows(json.data || []);
      }

      document.getElementById('toggleToolStats').addEventListener('click', () => {
        toolStatsExpanded = !toolStatsExpanded;
        loadToolStats();
      });

      document.getElementById('exportModelStatsCsv').addEventListener('click', () => {
        const rows = [
          ['Model', 'Requests', 'Failed', 'Input Tokens', 'Cached Tokens', 'Cache Written Tokens', 'Output Tokens', 'Total Tokens']
        ];
        document.querySelectorAll('#modelStats tbody tr').forEach((tr) => {
          const cols = [];
          tr.querySelectorAll('td').forEach((td) => cols.push(td.textContent.trim()));
          if (cols.length > 0) rows.push(cols);
        });
        const bom = '\\uFEFF';
        const csv = rows.map((r) => r.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',')).join('\\n');
        const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const ts = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0');
        a.download = 'model_stats_' + ts + '.csv';
        a.click();
        URL.revokeObjectURL(url);
      });

      async function loadRequestStats() {
        const res = await fetch('/dashboard/api/stats/requests');
        const json = await res.json();

        renderRows('#requestEndpointStats', json.endpoints || [], (row) =>
          '<tr><td>' + row.endpoint + '</td><td class="num">' + row.requests + '</td></tr>'
        );

        renderRows('#requestUpstreamStats', json.upstreams || [], (row) =>
          '<tr><td>' + row.upstream_base_url + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        renderRows('#requestStatusCodeFromUpstreamStats', json.status_codes_from_upstreams || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        renderRows('#requestStatusCodeToEndpointStats', json.status_codes_to_endpoints || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        renderRows('#requestEndpointTimingStats', json.endpoint_timings || [], (row) =>
          '<tr><td>' + row.endpoint + '</td><td class="num">' + row.min_time_ms + '</td><td class="num">' + row.avg_time_ms + '</td><td class="num">' + row.max_time_ms + '</td></tr>'
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

      setInterval(() => {
        loadConfig();
      }, 30000);

      // Scroll spy for side nav
      const sections = ['section-config', 'section-model', 'section-request', 'section-agent'];
      const navLinks = document.querySelectorAll('.side-nav a');
      const observer = new IntersectionObserver((entries) => {
        let activeId = '';
        for (const entry of entries) {
          if (entry.isIntersecting) activeId = entry.target.id;
        }
        navLinks.forEach((a) => {
          a.classList.toggle('active', a.getAttribute('href') === '#' + activeId);
        });
      }, { rootMargin: '-20% 0px -70% 0px' });
      sections.forEach((id) => observer.observe(document.getElementById(id)));
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function handleDashboardGetConfig(proxyConfig: ProxyConfig, env: Env): Response {
  // Return the full snapshot so the dashboard has modelStats and compositeResolved
  // for computing live token usage alongside config editing.
  return jsonResponse(getDashboardSnapshot(proxyConfig, env));
}

export async function handleDashboardPutConfig(request: Request, env: Env, _proxyConfig: ProxyConfig): Promise<Response> {
  try {
    const payload = await request.json();
    const configPath = getConfigPathForWrite(env);

    const baseConfig = loadProxyConfigFromPath(configPath);
    const nextConfig = applyDashboardConfigUpdate(baseConfig, payload);

    persistProxyConfigToPath(configPath, nextConfig);
    clearProxyConfigCache();

    const reloadedConfig = await loadProxyConfig(env);
    return jsonResponse(getDashboardSnapshot(reloadedConfig, env));
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export function handleDashboardModelStats(): Response {
  return jsonResponse({ data: getModelStatsDesc() });
}

export function handleDashboardAgentStats(): Response {
  return jsonResponse({ data: getToolUsageStatsDesc() });
}

export function handleDashboardRequestStats(): Response {
  return jsonResponse({
    endpoints: getRequestEndpointStatsDesc(),
    upstreams: getRequestUpstreamStatsDesc(),
    upstream_response_tools: getUpstreamResponseToolStatsDesc(),
    status_codes_from_upstreams: getRequestStatusCodeFromUpstreamStatsDesc(),
    status_codes_to_endpoints: getRequestStatusCodeToEndpointStatsDesc(),
    endpoint_timings: getRequestEndpointTimingStatsDesc(),
  });
}

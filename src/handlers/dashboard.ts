import { Env } from '../types/shared.js';
import {
  ProxyConfig,
  CompositeTargetPatch,
  applyDashboardConfigUpdate,
  addCompositeAlias,
  getCompositeRouteCandidates,
  getConfiguredModelIds,
  getModelRouteConfig,
  loadProxyConfigFromPath,
  persistProxyConfigToPath,
  removeCompositeAlias,
  removeCompositeTarget,
  toDashboardConfigPayload,
  upsertCompositeAliasLimit,
  upsertCompositeTarget,
  upsertFusionOptions,
  FusionOptions,
  clearProxyConfigCache,
  loadProxyConfig,
  parseHumanTokenLimit,
  formatTokenLimit,
  validateProxyConfig,
  upsertGlobalTokenLimit,
} from '../utils/config-loader.js';
import {
  getAgentStatsDesc,
  getModelStatsDesc,
  getRequestEndpointStatsDesc,
  getRequestEndpointTimingStatsDesc,
  getRequestModelTimingStatsDesc,
  getCompositeLimitWindowsSnapshot,
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
    model_timings: ReturnType<typeof getRequestModelTimingStatsDesc>;
  };
  tokenHeatmap: ReturnType<typeof getTokenHeatmapStatsDesc>;
  compositeLimitWindows: ReturnType<typeof getCompositeLimitWindowsSnapshot>;
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
    config_path: env.PROXY_CONFIG_PATH ?? null,
  };

  const compositeResolved = Object.keys(config.composite)
    .sort((a, b) => a.localeCompare(b))
    .map((alias) => ({
      alias,
      targets: Object.entries(proxyConfig.composite?.[alias] || {})
        .filter(([key]) => key !== 'token_limit' && key !== 'fusion_options' && !key.startsWith('_'))
        .map(([modelName]) => {
          const route = getModelRouteConfig(modelName, proxyConfig);
          return {
            model: modelName,
            routeModel: route.modelAlias,
            upstreamMode: route.upstreamMode,
            targetUrl: route.targetUrl,
          };
        }),
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
      model_timings: getRequestModelTimingStatsDesc(),
    },
    tokenHeatmap: getTokenHeatmapStatsDesc(),
    compositeLimitWindows: getCompositeLimitWindowsSnapshot(),
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
  rawInput: string | null,
): ReturnType<typeof toDashboardConfigPayload> {
  if (rawInput === null || rawInput.trim() === '') {
    return saveConfigMutation(env, (baseConfig) => upsertCompositeAliasLimit(baseConfig, alias, null));
  }
  const parsed = parseHumanTokenLimit(rawInput);
  if (!parsed) {
    throw new Error(`Invalid token limit format: "${rawInput}". Use: <num> <1h|1d|1w|1m>  (e.g. 50K 1d, 1.5M 1h, 100000 1w)`);
  }
  return saveConfigMutation(env, (baseConfig) => upsertCompositeAliasLimit(baseConfig, alias, parsed));
}

export function upsertGlobalTokenLimitFromDashboard(
  env: Env,
  rawInput: string | null,
): ReturnType<typeof toDashboardConfigPayload> {
  if (rawInput === null || rawInput.trim() === '') {
    return saveConfigMutation(env, (baseConfig) => upsertGlobalTokenLimit(baseConfig, null));
  }
  const parsed = parseHumanTokenLimit(rawInput);
  if (!parsed) {
    throw new Error(`Invalid token limit format: "${rawInput}". Use: <num> <1h|1d|1w|1m>  (e.g. 1.1B 1d, 50K 1h)`);
  }
  return saveConfigMutation(env, (baseConfig) => upsertGlobalTokenLimit(baseConfig, rawInput.trim()));
}

export function upsertFusionOptionsFromDashboard(
  env: Env,
  alias: string,
  options: FusionOptions | null,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => upsertFusionOptions(baseConfig, alias, options));
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
      .test-btn { padding: 4px 8px; font-size: 12px; background: #e8f5e9; border: 1px solid #a5d6a7; color: #2e7d32; }
      .test-btn:hover { background: #c8e6c9; }
      .test-btn.testing { background: #fff9c4; border-color: #fff176; color: #f57f17; }
      .test-btn.error-result { background: #ffebee; border-color: #ef9a9a; color: #c62828; }
      .test-btn.success-result { background: #e8f5e9; border-color: #a5d6a7; color: #2e7d32; }
      .danger { background: #fff1f1; border: 1px solid #ffcccc; }
      .section-actions { margin-top: 8px; }
      .config-divider { margin: 14px 0; border-top: 3px solid #fff; }
      .config-toolbar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
      .global-limit-group { display: flex; align-items: center; gap: 6px; margin-right: auto; }
      .global-limit-group label { font-size: 13px; font-weight: 500; white-space: nowrap; }
      #globalTokenLimitNum { padding: 4px 8px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; }
      #globalTokenLimitDuration { padding: 4px 6px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; }
      #saveGlobalLimit { padding: 4px 10px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; background: white; cursor: pointer; }
      #saveGlobalLimit:hover { background: #f0f0f0; }
      #globalLimitStatus { font-size: 12px; color: #555; }
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
      #configStatus.error {
        background: #ffebee;
        border: 1px solid #ef9a9a;
        color: #c62828;
      }
      #testResultPanel .result-model { font-weight: 600; }
      #testResultPanel.success { background: #e8f5e9; border: 1px solid #a5d6a7; color: #1b5e20; }
      #testResultPanel.error { background: #ffebee; border: 1px solid #ef9a9a; color: #b71c1c; }
      #testResultPanel.testing { background: #fff9c4; border: 1px solid #fff176; color: #e65100; }
      .result-usage { font-size: 12px; opacity: 0.8; }
      .result-clear { float: right; background: none; border: none; cursor: pointer; font-size: 13px; padding: 0; color: inherit; opacity: 0.7; }
      .result-clear:hover { opacity: 1; }
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
        <div class="global-limit-group">
          <label for="globalTokenLimitNum">Total limit:</label>
          <input type="text" id="globalTokenLimitNum" placeholder="e.g. 700M" title="Token amount only, e.g. 50K, 1.5M, 1.1B" style="width:90px;" autocomplete="off" />
          <select id="globalTokenLimitDuration">
            <option value="">(no limit)</option>
            <option value="1h">1 hour</option>
            <option value="1d">1 day</option>
            <option value="1w">1 week</option>
            <option value="1m">1 month</option>
          </select>
          <button id="saveGlobalLimit">Set</button>
          <span id="globalLimitStatus"></span>
        </div>
        <button id="reloadConfig">Reload</button>
        <button id="saveConfig">Save</button>
        <span id="configStatus"></span>
      </div>
    </section>

    <div id="testResultPanel" style="display:none; position:fixed; top:50%; left:0; transform:translateY(-50%); width:240px; border-radius:0 8px 8px 0; padding:14px 16px; z-index:999; font-size:13px; line-height:1.5; word-break:break-all; box-shadow:2px 2px 12px rgba(0,0,0,0.12);"></div>

    <section class="card" id="section-model">
      <h2>Model Statistic <button id="exportModelStatsCsv" class="mini-btn" style="font-size:12px;">Export CSV</button></h2>
      <table id="modelStats">
        <thead><tr><th>Model ID</th><th class="num">Requests</th><th class="num">Failed</th><th class="num">Input Tokens</th><th class="num">Cached Tokens</th><th class="num">Cache Written Tokens</th><th class="num">Output Tokens</th><th class="num">Total Tokens</th><th class="num">min(s)</th><th class="num">avg(s)</th><th class="num">max(s)</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section class="card" id="section-request">
      <h2>Request Statistic</h2>

      
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
        <h3>Requests Timing</h3>
        <table id="requestEndpointTimingStats">
          <thead><tr><th>endpoint</th><th class="num">req</th><th class="num">min(s)</th><th class="num">avg(s)</th><th class="num">max(s)</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <section class="card" id="section-agent">
      <h2>Tools Used <button id="toggleToolStats" class="mini-btn" style="font-size:12px;">Show all</button></h2>
      <table id="toolStats">
        <thead><tr><th>Tool</th><th class="num">in req</th><th class="num">in resp</th><th class="num">total len</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <script>
      const configForm = document.getElementById('configForm');
      const configStatus = document.getElementById('configStatus');
      const saveButton = document.getElementById('saveConfig');
      const globalTokenLimitNum = document.getElementById('globalTokenLimitNum');
      const globalTokenLimitDuration = document.getElementById('globalTokenLimitDuration');
      const globalLimitStatus = document.getElementById('globalLimitStatus');
      let currentConfig = { models: {}, composite: {} };
      let isReadOnly = false;
      let configPathHint = '';
      let compositeResolved = [];
      let modelStats = [];
      let compositeLimitWindowsSnapshot = {};

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

      function formatRemainingMs(ms) {
        if (ms <= 0) return '0s';
        const s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm ' + (s % 60) + 's';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ' + (m % 60) + 'm';
        const d = Math.floor(h / 24);
        return d + 'd ' + (h % 24) + 'h';
      }

      function formatTokenLimitNum(num) {
        if (num >= 1e12) return (num / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
        if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(num);
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
            + '<button type="button" class="test-btn mini-btn" data-action="test-model" data-model="' + escapeHtml(modelKey) + '">t</button>'
            + '<input type="text" data-kind="model-base" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" value="' + escapeHtml(base) + '" placeholder="base_url override"' + disabledAttr + ' />'
            + '<button type="button" class="mini-btn danger" data-action="remove-model" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
          + '</div>'
          + '</div>';
      }

      function compositeEntryRows(aliasName, targets, limitWindow) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const keys = Object.keys(targets || {}).filter((key) => key !== 'token_limit' && key !== 'fusion_options');
        const tokenLimit = targets.token_limit;
        const limitNum = tokenLimit?.num ?? '';
        const limitDuration = tokenLimit?.duration ?? '';
        const usageLabel = limitWindow
          ? '<span style="font-size:13px;color:#666;margin-left:6px;">Window: ' + formatTokenLimitNum(limitWindow.accumulator) + ' / ' + formatTokenLimitNum(limitWindow.limit) + ' (' + limitWindow.duration + ') — ' + formatRemainingMs(limitWindow.remainingMs) + ' left</span>'
          : '<span style="font-size:13px;color:#888;margin-left:6px;">No active window</span>';
        const durationOptions = [
          { value: '', label: '(no limit)' },
          { value: '1h', label: '1 hour' },
          { value: '1d', label: '1 day' },
          { value: '1w', label: '1 week' },
          { value: '1m', label: '1 month' },
        ];
        const durationOptionsHtml = durationOptions.map((o) =>
          '<option value="' + escapeHtml(o.value) + '"' + (limitDuration === o.value ? ' selected' : '') + '>' + o.label + '</option>'
        ).join('');
        const displayNum = typeof limitNum === 'number' && limitNum > 0 ? formatTokenLimitNum(limitNum) : '';

        // Detect fusion alias: has fusion_options or any target with fusion/role field
        const fusionOpts = targets.fusion_options || {};
        const isFusion = !!targets.fusion_options || keys.some((k) => {
          const c = targets[k] || {};
          return c.fusion !== undefined || c.role !== undefined;
        });

        const rows = [
          '<div class="config-row" style="flex-wrap:wrap;gap:6px;align-items:center;">'
            + '<label style="min-width:120px;">' + escapeHtml(aliasName + '.token_limit') + '</label>'
            + '<input type="text" data-kind="comp-limit-num" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(displayNum) + '" placeholder="e.g. 50K, 1.5M, 100000" style="width:140px;"' + disabledAttr + ' />'
            + '<select data-kind="comp-limit-duration" data-alias="' + escapeHtml(aliasName) + '"' + disabledAttr + '>' + durationOptionsHtml + '</select>'
            + usageLabel
            + '</div>'
        ];

        if (isFusion) {
          // fusion_options row
          rows.push(
            '<div class="config-row" style="flex-wrap:wrap;gap:6px;align-items:center;">'
              + '<label style="min-width:120px;">' + escapeHtml(aliasName + '.fusion_options') + '</label>'
              + '<span style="font-size:12px;color:#666;margin-right:4px;">min_panel</span>'
              + '<input type="number" data-kind="comp-fusion-min-panel" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(fusionOpts.min_panel ?? '') + '" placeholder="1" style="width:60px;"' + disabledAttr + ' />'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">panel_timeout_ms</span>'
              + '<input type="number" data-kind="comp-fusion-timeout" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(fusionOpts.panel_timeout_ms ?? '') + '" placeholder="60000" style="width:80px;"' + disabledAttr + ' />'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">judge_required</span>'
              + '<select data-kind="comp-fusion-judge-req" data-alias="' + escapeHtml(aliasName) + '"' + disabledAttr + '>'
                + '<option value=""' + (fusionOpts.judge_required === undefined ? ' selected' : '') + '>(default)</option>'
                + '<option value="true"' + (fusionOpts.judge_required === true ? ' selected' : '') + '>true</option>'
                + '<option value="false"' + (fusionOpts.judge_required === false ? ' selected' : '') + '>false</option>'
              + '</select>'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">expose_metadata</span>'
              + '<select data-kind="comp-fusion-expose-meta" data-alias="' + escapeHtml(aliasName) + '"' + disabledAttr + '>'
                + '<option value=""' + (fusionOpts.expose_metadata === undefined ? ' selected' : '') + '>(default)</option>'
                + '<option value="true"' + (fusionOpts.expose_metadata === true ? ' selected' : '') + '>true</option>'
                + '<option value="false"' + (fusionOpts.expose_metadata === false ? ' selected' : '') + '>false</option>'
              + '</select>'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">max_concurrent</span>'
              + '<input type="number" data-kind="comp-fusion-max-conc" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(fusionOpts.max_concurrent ?? '') + '" placeholder="(all)" style="width:60px;"' + disabledAttr + ' />'
              + '</div>'
          );
        }

        if (keys.length === 0) {
          rows.push('<div class="config-row"><label>' + escapeHtml(aliasName) + '</label><div class="wide">(empty)</div></div>');
          return rows.join('');
        }
        return rows.concat(keys.map((targetName) => {
          const cfg = targets[targetName] || {};
          if (isFusion) {
            // Fusion target: show fusion weight + role instead of share/primary/fallback
            const fusionWeight = cfg.fusion ?? '';
            const roleOptions = ['', 'panel', 'judge', 'synth'];
            const roleHtml = roleOptions.map((r) =>
              '<option value="' + r + '"' + (cfg.role === r || (r === '' && cfg.role === undefined) ? ' selected' : '') + '>' + (r || '(default)') + '</option>'
            ).join('');
            return '<div class="config-row">'
              + '<label>' + escapeHtml(targetName) + '</label>'
              + '<span style="font-size:12px;color:#666;margin-right:4px;">fusion</span>'
              + '<input type="number" data-kind="comp-fusion" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(fusionWeight) + '" placeholder="1" style="width:60px;"' + disabledAttr + ' />'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">role</span>'
              + '<select data-kind="comp-role" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + disabledAttr + '>' + roleHtml + '</select>'
              + '<div class="row-actions">'
                + '<button type="button" class="test-btn mini-btn" data-action="test-model" data-model="' + escapeHtml(targetName) + '">t</button>'
                + '<button type="button" class="mini-btn danger" data-action="remove-composite-target" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
              + '</div>'
              + '</div>';
          }
          const share = cfg.share ?? '';
          const fallback = cfg.fallback === 0 ? 'no FB' : cfg.fallback ?? '';
          const primary = cfg.primary === true ? 'checked' : '';
          return '<div class="config-row">'
            + '<label>' + escapeHtml(targetName) + '</label>'
            + '<input type="number" data-kind="comp-share" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(share) + '" placeholder="share"' + disabledAttr + ' />'
            + '<div class="row-actions">'
            + '<button type="button" class="test-btn mini-btn" data-action="test-model" data-model="' + escapeHtml(targetName) + '">t</button>'
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
          const rows = compositeEntryRows(aliasName, targets, compositeLimitWindowsSnapshot[aliasName])
            + '<div class="section-actions"><button type="button" class="test-btn mini-btn" data-action="test-composite" data-alias="' + escapeHtml(aliasName) + '">test model</button>'
            + ' <button type="button" class="mini-btn" data-action="add-composite-target" data-alias="' + escapeHtml(aliasName) + '"' + (isReadOnly ? ' disabled' : '') + '>Add target</button>'
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
          const limitNumEl = document.querySelector('[data-kind="comp-limit-num"][data-alias="' + aliasName + '"]');
          const limitDurEl = document.querySelector('[data-kind="comp-limit-duration"][data-alias="' + aliasName + '"]');
          const numVal = limitNumEl ? limitNumEl.value.trim() : '';
          const durVal = limitDurEl ? limitDurEl.value.trim() : '';
          if (numVal !== '' && durVal !== '') {
            // Parse human-readable format: "50K", "1.5M", "100000" etc.
            const rawInput = numVal + ' ' + durVal;
            const parsed = parseHumanTokenLimit(rawInput);
            if (parsed) {
              payload.composite[aliasName].token_limit = parsed;
            }
          }

          // Collect fusion_options if present in DOM (fusion alias)
          const minPanelEl = document.querySelector('[data-kind="comp-fusion-min-panel"][data-alias="' + aliasName + '"]');
          if (minPanelEl !== null) {
            const fusionOpts = {};
            if (minPanelEl.value !== '') fusionOpts.min_panel = Number(minPanelEl.value);
            const timeoutEl = document.querySelector('[data-kind="comp-fusion-timeout"][data-alias="' + aliasName + '"]');
            if (timeoutEl && timeoutEl.value !== '') fusionOpts.panel_timeout_ms = Number(timeoutEl.value);
            const judgeReqEl = document.querySelector('[data-kind="comp-fusion-judge-req"][data-alias="' + aliasName + '"]');
            if (judgeReqEl && judgeReqEl.value !== '') fusionOpts.judge_required = judgeReqEl.value === 'true';
            const exposeMetaEl = document.querySelector('[data-kind="comp-fusion-expose-meta"][data-alias="' + aliasName + '"]');
            if (exposeMetaEl && exposeMetaEl.value !== '') fusionOpts.expose_metadata = exposeMetaEl.value === 'true';
            const maxConcEl = document.querySelector('[data-kind="comp-fusion-max-conc"][data-alias="' + aliasName + '"]');
            if (maxConcEl && maxConcEl.value !== '') fusionOpts.max_concurrent = Number(maxConcEl.value);
            if (Object.keys(fusionOpts).length > 0) {
              payload.composite[aliasName].fusion_options = fusionOpts;
            }
          }

          Object.keys(targets || {}).forEach((targetName) => {
            if (targetName === 'token_limit' || targetName === 'fusion_options') return;
            // Fusion target fields
            const fusionEl = document.querySelector('[data-kind="comp-fusion"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            if (fusionEl !== null) {
              const entry = {};
              if (fusionEl.value !== '') entry.fusion = Number(fusionEl.value);
              const roleEl = document.querySelector('[data-kind="comp-role"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
              if (roleEl && roleEl.value !== '') entry.role = roleEl.value;
              payload.composite[aliasName][targetName] = entry;
              return;
            }
            // Normal composite target fields
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

      let testResultClearTimer = null;

      function showTestResult(success, modelId, status, detail, usage) {
        const panel = document.getElementById('testResultPanel');
        if (testResultClearTimer) clearTimeout(testResultClearTimer);
        if (success) {
          panel.className = 'success';
          panel.innerHTML = '<button class="result-clear" onclick="clearTestResult()">✗</button>'
            + '<span class="result-model">✓ ' + escapeHtml(modelId) + '</span> '
            + '<span style="opacity:0.7">(' + status + ')</span>'
            + (usage ? ' <span class="result-usage">usage=' + escapeHtml(usage) + '</span>' : '')
            + (detail ? ' <span style="opacity:0.8">' + escapeHtml(detail) + '</span>' : '');
        } else {
          panel.className = 'error';
          panel.innerHTML = '<button class="result-clear" onclick="clearTestResult()">✗</button>'
            + '<span class="result-model">✗ ' + escapeHtml(modelId) + '</span> '
            + '<span style="opacity:0.7">(' + (status || '?') + ')</span>'
            + (detail ? ' — ' + escapeHtml(detail) : '');
        }
        panel.style.display = 'block';
        // Auto-clear after 20s
        testResultClearTimer = setTimeout(clearTestResult, 20000);
      }

      function clearTestResult() {
        const panel = document.getElementById('testResultPanel');
        panel.style.display = 'none';
        if (testResultClearTimer) { clearTimeout(testResultClearTimer); testResultClearTimer = null; }
      }

      async function testModel(modelId) {
        const isCompositeBtn = document.querySelector('[data-action="test-composite"][data-alias="' + modelId + '"]') !== null;
        const btn = document.querySelector('[data-action="test-model"][data-model="' + modelId + '"]')
          || document.querySelector('[data-action="test-composite"][data-alias="' + modelId + '"]');
        if (btn) {
          btn.disabled = true;
          btn.className = 'test-btn mini-btn testing';
          btn.textContent = '…';
        }
        const panel = document.getElementById('testResultPanel');
        if (testResultClearTimer) clearTimeout(testResultClearTimer);
        panel.className = 'testing';
        panel.innerHTML = '<button class="result-clear" onclick="clearTestResult()">✗</button> Testing ' + escapeHtml(modelId) + '…';
        panel.style.display = 'block';

        try {
          const res = await fetch('/dashboard/api/test-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId }),
          });
          const result = await res.json();
          showTestResult(result.success, result.modelId, result.status, result.detail, result.usage);
        } catch (err) {
          showTestResult(false, modelId, null, err.message, null);
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.className = 'test-btn mini-btn';
            btn.textContent = isCompositeBtn ? 'test' : 't';
          }
        }
      }

      function handleConfigAction(event) {
        const target = event.target;
        if (!target || !target.dataset) return;

        if (target.dataset.action === 'test-model') {
          void testModel(target.dataset.model);
          return;
        }
        if (target.dataset.action === 'test-composite') {
          void testModel(target.dataset.alias);
          return;
        }

        if (isReadOnly) {
          return;
        }

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

        if (target.dataset.kind === 'comp-limit-num' || target.dataset.kind === 'comp-limit-duration') {
          const alias = target.dataset.alias;
          if (!alias) return;
          const numEl = document.querySelector('[data-kind="comp-limit-num"][data-alias="' + alias + '"]');
          const durEl = document.querySelector('[data-kind="comp-limit-duration"][data-alias="' + alias + '"]');
          const numVal = numEl ? numEl.value.trim() : '';
          const durVal = durEl ? durEl.value.trim() : '';
          if (numVal === '' || durVal === '') {
            delete currentConfig.composite[alias].token_limit;
          } else {
            const rawInput = numVal + ' ' + durVal;
            const parsed = parseHumanTokenLimit(rawInput);
            if (!parsed) {
              window.alert('Invalid token limit. Use: <num[K|M|B|T]> <1h|1d|1w|1m>  (e.g. 50K 1d, 1.5M 1h)');
              return;
            }
            currentConfig.composite[alias].token_limit = parsed;
          }
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

      async function loadConfig(forceReload) {
        configStatus.textContent = 'Loading...';
        const res = await fetch(forceReload === true ? '/dashboard/api/config?reload=1' : '/dashboard/api/config');
        const json = await res.json();
        isReadOnly = json.config.read_only === true;
        currentConfig = {
          models: json.config.models || {},
          composite: json.config.composite || {},
        };
        compositeResolved = json.compositeResolved || [];
        modelStats = json.modelStats || [];
        compositeLimitWindowsSnapshot = json.compositeLimitWindows || {};
        const glRaw = (json.config.global_token_limit || '').trim();
        const glParts = glRaw ? glRaw.split(' ') : []; // ' ' is better than /\s+/
        globalTokenLimitNum.value = glParts[0] || '';
        globalTokenLimitDuration.value = (glParts[1] || '').toLowerCase();
        renderConfigForm(currentConfig);
        saveButton.disabled = isReadOnly;
        configPathHint = json.config.config_path ? ' (' + json.config.config_path + ')' : '';

        // Display config validation errors
        const configErrors = json.config.config_errors || [];
        if (configErrors.length > 0) {
          const errorList = configErrors.map((e) => e.path + ': ' + e.message).join('; ');
          configStatus.innerHTML = '<span style="color:#c62828;">Config errors: ' + escapeHtml(errorList) + '</span>';
          configStatus.className = 'error';
        } else if (isReadOnly) {
          configStatus.textContent = 'Loaded (read-only: remote)' + configPathHint;
          configStatus.className = '';
        } else {
          configStatus.textContent = 'Loaded' + configPathHint;
          configStatus.className = '';
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
        const [modelsRes, reqRes] = await Promise.all([
          fetch('/dashboard/api/stats/models'),
          fetch('/dashboard/api/stats/requests'),
        ]);
        const modelsJson = await modelsRes.json();
        const reqJson = await reqRes.json();
        const timingMap = {};
        for (const t of (reqJson.model_timings || [])) {
          timingMap[t.endpoint] = t;
        }
        renderRows('#modelStats', modelsJson.data || [], (row) => {
          const timing = timingMap[row.model];
          const minS = timing ? (timing.min_time_ms / 1000).toFixed(2) : '-';
          const avgS = timing ? (timing.avg_time_ms / 1000).toFixed(2) : '-';
          const maxS = timing ? (timing.max_time_ms / 1000).toFixed(2) : '-';
          return '<tr><td>' + (row.model.split('/').pop() || row.model) + '</td><td class="num">' + fmtStat(row.requests) + '</td><td class="num">' + fmtStat(row.failed_requests || 0) + '</td><td class="num">' + fmtStat(row.input_tokens) + '</td><td class="num">' + fmtStat(row.cached_tokens) + '</td><td class="num">' + fmtStat(row.cache_written_tokens) + '</td><td class="num">' + fmtStat(row.output_tokens) + '</td><td class="num">' + fmtStat(row.total_tokens) + '</td><td class="num">' + minS + '</td><td class="num">' + avgS + '</td><td class="num">' + maxS + '</td></tr>';
        });
      }

      let toolStatsExpanded = false;

      function fmtStat(n) {
        if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
        return String(n);
      }

      function renderToolRows(data) {
        const tbody = document.querySelector('#toolStats tbody');
        const rows = toolStatsExpanded ? data : data.slice(0, 10);
        tbody.innerHTML = rows.map((row) =>
          '<tr><td>' + row.tool_name + '</td><td class="num">' + fmtStat(row.in_requests) + '</td><td class="num">' + fmtStat(row.in_responses) + '</td><td class="num">' + fmtStat(row.in_request_chars || 0) + '</td></tr>'
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
          ['Model', 'Requests', 'Failed', 'Input Tokens', 'Cached Tokens', 'Cache Written', 'Output Tokens', 'Total Tokens', 'min(s)', 'avg(s)', 'max(s)']
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

        renderRows('#requestUpstreamStats', json.upstreams || [], (row) =>
          '<tr><td>' + row.upstream_base_url + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        renderRows('#requestStatusCodeFromUpstreamStats', json.status_codes_from_upstreams || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        renderRows('#requestStatusCodeToEndpointStats', json.status_codes_to_endpoints || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        const endpointReqs = {};
        for (const ep of json.endpoints || []) {
          endpointReqs[ep.endpoint] = ep.requests;
        }
        renderRows('#requestEndpointTimingStats', json.endpoint_timings || [], (row) =>
          '<tr><td>' + row.endpoint + '</td><td class="num">' + fmtStat(endpointReqs[row.endpoint] || 0) + '</td><td class="num">' + ((row.min_time_ms || 0) / 1000).toFixed(2) + '</td><td class="num">' + ((row.avg_time_ms || 0) / 1000).toFixed(2) + '</td><td class="num">' + ((row.max_time_ms || 0) / 1000).toFixed(2) + '</td></tr>'
        );
      }

      document.getElementById('reloadConfig').addEventListener('click', () => loadConfig(true));
      document.getElementById('saveConfig').addEventListener('click', saveConfig);

      async function saveGlobalLimit() {
        const num = globalTokenLimitNum.value.trim();
        const dur = globalTokenLimitDuration.value;
        if (num && !dur) {
          globalLimitStatus.textContent = 'Select a duration';
          return;
        }
        const value = (num && dur) ? num + ' ' + dur : '';
        globalLimitStatus.textContent = 'Saving...';
        try {
          const res = await fetch('/dashboard/api/global-token-limit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Failed');
          globalLimitStatus.textContent = value ? 'Set' : 'Cleared';
          setTimeout(() => { globalLimitStatus.textContent = ''; }, 2000);
        } catch (err) {
          globalLimitStatus.textContent = 'Error: ' + err.message;
        }
      }

      document.getElementById('saveGlobalLimit').addEventListener('click', saveGlobalLimit);
      globalTokenLimitNum.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveGlobalLimit(); });
      configForm.addEventListener('click', handleConfigAction);

      async function refreshAll() {
        await Promise.all([loadConfig(), loadModelStats(), loadRequestStats(), loadToolStats()]);
      }

      refreshAll();
      setInterval(() => {
        loadModelStats();
        loadRequestStats();
        loadToolStats();
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
  try {
    return jsonResponse(getDashboardSnapshot(proxyConfig, env));
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
}

export async function handleDashboardPutConfig(request: Request, env: Env, _proxyConfig: ProxyConfig): Promise<Response> {
  try {
    const payload = await request.json();
    const configPath = getConfigPathForWrite(env);

    const baseConfig = loadProxyConfigFromPath(configPath);
    const nextConfig = applyDashboardConfigUpdate(baseConfig, payload);

    // Reject invalid config before it is persisted — an invalid model entry or
    // composite target would otherwise be written to disk and silently degrade
    // the live config on the next reload.
    const validation = validateProxyConfig(nextConfig);
    if (!validation.valid) {
      return jsonResponse({
        error: 'Invalid config',
        config_errors: validation.errors,
      }, 400);
    }

    persistProxyConfigToPath(configPath, nextConfig);
    clearProxyConfigCache();

    const reloadedConfig = await loadProxyConfig(env);
    return jsonResponse(getDashboardSnapshot(reloadedConfig, env));
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export async function handleDashboardGlobalTokenLimit(request: Request, env: Env): Promise<Response> {
  try {
    const { value } = await request.json() as { value: string };
    upsertGlobalTokenLimitFromDashboard(env, value ?? null);
    return jsonResponse({ ok: true });
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
    model_timings: getRequestModelTimingStatsDesc(),
  });
}

// Test model constants (mirrored from tui.ts)
const TEST_MODEL_ENDPOINT = '/v1/messages';
const TEST_TOOL_NAME = 'test_tool';
const TEST_TOOL_DESCRIPTION = 'test tool';
const TEST_TOOL_PROMPT = 'Use the test_tool and say hi.';
const TEST_TOOL_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};

function buildTestToolRequest(upstreamMode: string): Record<string, unknown> {
  const openaiToolBody = {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 128,
    tools: [{
      type: 'function',
      function: {
        name: TEST_TOOL_NAME,
        description: TEST_TOOL_DESCRIPTION,
        parameters: TEST_TOOL_SCHEMA,
      },
    }],
    tool_choice: { type: 'function', function: { name: TEST_TOOL_NAME } },
  };

  if (upstreamMode === 'openai-completions' ||
      upstreamMode === 'openai-responses' ||
      upstreamMode === 'gemini-generatecontent' ||
      upstreamMode === 'gemini-interactions') {
    return openaiToolBody;
  }

  return {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 128,
    tools: [{ name: TEST_TOOL_NAME, description: TEST_TOOL_DESCRIPTION, input_schema: TEST_TOOL_SCHEMA }],
    tool_choice: { type: 'tool', name: TEST_TOOL_NAME },
  };
}

function extractTestResultDetail(responseBody: unknown): string {
  if (!responseBody || typeof responseBody !== 'object') return String(responseBody);
  const record = responseBody as Record<string, unknown>;
  const lines: string[] = [];

  // Extract error
  const error = record.error;
  if (error) {
    if (typeof error === 'string') lines.push(`error: ${error.trim()}`);
    else if (typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (typeof e.message === 'string' && e.message.trim()) lines.push(`error: ${e.message.trim()}`);
      else if (typeof e.type === 'string' && e.type.trim()) lines.push(`error: ${e.type.trim()}`);
    }
  }

  // Extract text content
  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          lines.push(`msg: ${b.text.trim().slice(0, 120)}`);
        }
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = b.input !== undefined ? compact(b.input) : '';
          lines.push(`tool: ${b.name} ${input}`);
        }
      }
    }
  }

  // OpenAI tool_calls format
  const toolCalls = record.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (call && typeof call === 'object') {
        const c = call as Record<string, unknown>;
        const fn = c.function as Record<string, unknown> | undefined;
        const name = fn && typeof fn.name === 'string' ? fn.name : (typeof c.name === 'string' ? c.name : 'tool');
        const args = fn && fn.arguments !== undefined ? compact(fn.arguments) : (c.arguments !== undefined ? compact(c.arguments) : '');
        lines.push(`tool: ${name} ${args}`);
      }
    }
  }

  // OpenAI outputs format
  const outputs = record.outputs;
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      if (output && typeof output === 'object') {
        const o = output as Record<string, unknown>;
        if (o.type === 'function_call') {
          const name = typeof o.name === 'string' ? o.name : 'tool';
          const args = o.arguments !== undefined ? compact(o.arguments) : '';
          lines.push(`tool: ${name} ${args}`);
        }
      }
    }
  }

  if (lines.length === 0) {
    // Fallback: output_text
    if (typeof record.output_text === 'string' && record.output_text.trim()) {
      lines.push(`msg: ${record.output_text.trim().slice(0, 120)}`);
    }
  }

  return lines.length > 0 ? lines.join(' | ') : JSON.stringify(responseBody).slice(0, 120);
}

function compact(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return String(value);
  }
}

export async function handleDashboardTestModel(
  request: Request,
  env: Env,
  proxyConfig: ProxyConfig,
): Promise<Response> {
  try {
    const { modelId } = await request.json() as { modelId: string };

    if (!modelId) {
      return jsonResponse({ error: 'modelId is required' }, 400);
    }

    const snapshot = getDashboardSnapshot(proxyConfig, env);

    // Resolve config for this model
    let upstreamMode = 'openai-completions';

    // Check composite aliases first
    const alias = snapshot.compositeResolved.find((a) => a.alias === modelId);
    if (alias && alias.targets.length > 0) {
      upstreamMode = alias.targets[0].upstreamMode;
    } else {
      // Check model configs
      for (const categoryConfig of Object.values(snapshot.config.models)) {
        if (Array.isArray(categoryConfig)) continue;
        for (const [key, value] of Object.entries(categoryConfig || {})) {
          if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') continue;
          if (value === undefined) continue;
          if (key !== modelId) continue;
          upstreamMode = categoryConfig.upstream_mode || 'openai-completions';
          break;
        }
      }
    }

    const requestBody = buildTestToolRequest(upstreamMode);
    const fullRequestBody = { ...requestBody, model: modelId };

    const port = env.PORT || '8788';
    const endpoint = `http://127.0.0.1:${port}${TEST_MODEL_ENDPOINT}`;

    // Debug log test request/response to /tmp/test_model.log (LOG_LEVEL=debug)
    if (env.LOG_LEVEL === 'debug') {
      try {
        const fs = await import('fs');
        fs.writeFileSync('/tmp/test_model.log',
          `[${new Date().toISOString()}] test model request\n` +
          `target: ${endpoint}\n` +
          `upstreamMode: ${upstreamMode}\n` +
          `modelId: ${modelId}\n` +
          `request body:\n${JSON.stringify(fullRequestBody, null, 2)}\n`,
        );
      } catch (_e) { /* ignore */ }
    }

    const testResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullRequestBody),
    });

    const contentType = testResponse.headers.get('content-type') || '';
    const responseBody = contentType.includes('application/json')
      ? await testResponse.json()
      : await testResponse.text();

    // Append response to debug log (LOG_LEVEL=debug)
    if (env.LOG_LEVEL === 'debug') {
      try {
        const fs = await import('fs');
        const responseText = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody, null, 2);
        fs.appendFileSync('/tmp/test_model.log',
          `response status: ${testResponse.status}\n` +
          `response body:\n${responseText}\n` +
          `---\n`,
        );
      } catch (_e) { /* ignore */ }
    }

    const usage = typeof responseBody === 'object' && responseBody !== null && 'usage' in responseBody
      ? JSON.stringify((responseBody as Record<string, unknown>).usage ?? {})
      : null;
    const detail = extractTestResultDetail(responseBody);

    if (!testResponse.ok) {
      return jsonResponse({
        success: false,
        modelId,
        status: testResponse.status,
        detail,
        usage,
      });
    }

    return jsonResponse({
      success: true,
      modelId,
      status: testResponse.status,
      detail,
      usage,
    });
  } catch (err) {
    return jsonResponse({ success: false, modelId: '?', error: (err as Error).message }, 500);
  }
}

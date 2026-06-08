/**
 * Model Configuration for Tests
 * Defines test models from various providers
 */

/**
 * Models from api.qnaigc.com (OpenAI-Completions)
 * Fetched from GET /v1/models
 */
const OPENAI_COMPLETIONS_MODELS = [
  // DeepSeek
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-v3.1',
  'deepseek/deepseek-v3.2-exp',
  'deepseek-v3-0324',
  'deepseek/deepseek-v3.2-251201',
  'deepseek-r1',
  'deepseek-r1-0528',

  // Qwen
  'qwen3-32b',
  'qwen3-30b-a3b',
  'qwen3-30b-a3b-instruct-2507',
  'qwen3-30b-a3b-thinking-2507',
  'qwen3-235b-a22b',
  'qwen3-235b-a22b-thinking-2507',
  'qwen3-next-80b-a3b-thinking',
  'qwen3-vl-30b-a3b-thinking',
  'qwen3-max-preview',
  'qwen3-coder-480b-a35b-instruct',
  'qwen-max-2025-01-25',
  'qwen-vl-max-2025-01-25',
  'qwen2.5-vl-72b-instruct',
  'qwen2.5-vl-7b-instruct',
  'qwen-turbo',

  // MiniMax
  'minimax/minimax-m2.1',
  'minimax/minimax-m2.5',
  'minimax/minimax-m2.7',
  'MiniMax-M1',

  // Moonshot/Kimi
  'moonshotai/kimi-k2.5',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2-0905',
  'moonshotai/kimi-k2-thinking',

  // GLM/Z-AI
  'z-ai/glm-4.7',
  'glm-4.5',
  'glm-4.5-air',
  'z-ai/glm-5',

  // Gemini (via OpenAI-completions)
  'gemini-2.5-flash',
  'gemini-3.0-flash-preview',
  'gemini-3.1-pro-preview'
];

/**
 * Thinking/Reasoning models
 */
const THINKING_MODELS = [
  'deepseek-r1',
  'deepseek-r1-0528',
  'deepseek/deepseek-v3.2-exp-thinking',
  'deepseek/deepseek-v3.1-terminus-thinking',
  'qwen3-30b-a3b-thinking-2507',
  'qwen3-235b-a22b-thinking-2507',
  'qwen3-next-80b-a3b-thinking',
  'qwen3-vl-30b-a3b-thinking',
  'moonshotai/kimi-k2-thinking',
  'doubao-seed-1.6-thinking',
  'doubao-1.5-thinking-pro'
];

/**
 * Models with tool/function calling support
 */
const TOOL_CAPABLE_MODELS = [
  'deepseek/deepseek-v3.2',
  'qwen3-32b',
  'qwen-max-2025-01-25',
  'minimax/minimax-m2.5',
  'moonshotai/kimi-k2.5',
  'gemini-2.5-flash',
  'claude-4.6-sonnet'
];

/**
 * Custom models from proxy_config.toml
 */
const CUSTOM_MODELS = {
  deepseek: [
    'deepseek-v4-flash',
    'deepseek/deepseek-v3.2-exp-thinking',
    'deepseek/deepseek-v3.1-terminus-thinking'
  ],
  nvidia: [
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3-super-120b-a12b'
  ]
};

/**
 * Composite aliases from proxy_config.toml
 */
const COMPOSITE_ALIASES = [
  'code-small',
  'gpt-all',
  'gpt-5',
  'max-kimi',
  'llama'
];

/**
 * Models by provider
 */
const MODELS_BY_PROVIDER = {
  deepseek: [
    'deepseek/deepseek-v3.2',
    'deepseek/deepseek-v3.1',
    'deepseek/deepseek-v3.2-exp',
    'deepseek-v3-0324',
    'deepseek/deepseek-v3.2-251201',
    'deepseek-r1',
    'deepseek-r1-0528',
    'deepseek/deepseek-v3.2-exp-thinking',
    'deepseek/deepseek-v3.1-terminus-thinking'
  ],
  qwen: [
    'qwen3-32b',
    'qwen3-30b-a3b',
    'qwen3-30b-a3b-instruct-2507',
    'qwen3-30b-a3b-thinking-2507',
    'qwen3-235b-a22b',
    'qwen3-235b-a22b-thinking-2507',
    'qwen3-next-80b-a3b-thinking',
    'qwen3-vl-30b-a3b-thinking',
    'qwen3-max-preview',
    'qwen3-coder-480b-a35b-instruct',
    'qwen-max-2025-01-25',
    'qwen-vl-max-2025-01-25',
    'qwen2.5-vl-72b-instruct',
    'qwen2.5-vl-7b-instruct',
    'qwen-turbo'
  ],
  minimax: [
    'minimax/minimax-m2.1',
    'minimax/minimax-m2.5',
    'minimax/minimax-m2.7',
    'MiniMax-M1'
  ],
  moonshot: [
    'moonshotai/kimi-k2.5',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2-0905',
    'moonshotai/kimi-k2-thinking'
  ],
  glm: [
    'z-ai/glm-4.7',
    'glm-4.5',
    'glm-4.5-air',
    'z-ai/glm-5'
  ],
  gemini: [
    'gemini-2.5-flash',
    'gemini-3.0-flash-preview',
    'gemini-3.1-pro-preview'
  ],
  nvidia: [
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3-super-120b-a12b'
  ]
};

/**
 * Priority models for quick testing
 */
const PRIORITY_MODELS = {
  tier1: [
    'deepseek/deepseek-v3.2',
    'qwen3-32b',
    'minimax/minimax-m2.1',
    'moonshotai/kimi-k2.5'
  ],
  tier2: [
    'deepseek-r1',
    'qwen-max-2025-01-25',
    'gemini-2.5-flash'
  ],
  tier3: [
    'moonshotai/kimi-k2-thinking',
    'doubao-seed-1.6-thinking'
  ]
};

module.exports = {
  OPENAI_COMPLETIONS_MODELS,
  THINKING_MODELS,
  TOOL_CAPABLE_MODELS,
  CUSTOM_MODELS,
  COMPOSITE_ALIASES,
  MODELS_BY_PROVIDER,
  PRIORITY_MODELS
};
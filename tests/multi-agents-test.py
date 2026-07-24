"""
Multi-agent, multi-model test (Python).

Runs three Python agent SDKs (google-antigravity, langgraph, crewai) against
ten models with diverse prefixes through the local proxy (127.0.0.1:8788).

Each agent receives every task in `USER_TASKS`, and every model is exercised
against every task, producing `len(USER_TASKS) * len(MODELS) * 3` total runs
(modulated by the CLI selection below).

Usage:
    Install:
        # use existing venv: source ~/dev/ainew/bin/activate
        # create a new venv: python3 -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q langgraph langchain-openai langchain-core crewai pydantic google-antigravity
        pip install google-antigravity langgraph crewai langchain-openai langchain-core

    Start the proxy with `DEV_PASS_THROUGH=true DEV_NO_KEY=true` to enable
    `/v1/chat/completions` and permit Antigravity's headerless requests.
    The active proxy TOML must inject the configured upstream key:

        [general]
        auth_passthrough_with = "config_key"

    The selected model route (or applicable default upstream) must define its
    upstream `api_key`.

    export API_KEY=a-valid-key
    # LangGraph/CrewAI read OPENAI_API_KEY; Antigravity uses the proxy config key.
    export OPENAI_API_KEY=$API_KEY

    python tests/multi-agents-test.py                 # all models x agents x tasks
    python tests/multi-agents-test.py 1 1 1           # first model, first agent, first task
    python tests/multi-agents-test.py 2 3 1           # 2nd model, 3rd agent, 1st task
    python tests/multi-agents-test.py 0 0 2           # all models, all agents, 2nd task
    python tests/multi-agents-test.py 9 2 0           # MODELS[(9-1) % len], 2nd agent, all tasks

    CLI selection semantics (three args: model agent task):
      no args                                -> all models x all agents x all tasks
      "0 0 0"                                -> same as no args
      M A T with M,A,T > 0                   -> MODELS[(M-1) % MODELS.length],
                                                AGENTS[(A-1) % AGENTS.length],
                                                USER_TASKS[(T-1) % USER_TASKS.length]
                                                (1-based; out-of-range values wrap with %)
      0 in any position                      -> that dimension runs all entries
                                                (e.g. "0 1 0" = all models, first agent, all tasks)

    Agent order:  1=Antigravity, 2=LangGraph, 3=CrewAI

    To restrict the static task list, comment entries in USER_TASKS below.

Assumptions:
  - google-antigravity uses `LocalOpenAIAgentConfig` pointed at `PROXY_BASE`.
    The SDK appends `/v1/chat/completions` but cannot attach an API key or custom
    headers, so the proxy must use `DEV_NO_KEY=true` and config-key injection.
  - langgraph uses `langchain_openai.ChatOpenAI` pointed at `{PROXY_BASE}/v1`
    and `create_react_agent` for the tool-calling loop. `langgraph` alone is
    a low-level orchestrator (per its own docs), so the LLM wiring is done
    via LangChain.
  - crewai uses the `LLM` class with `model="openai/<id>"` and `base_url=
    {PROXY_BASE}/v1`. This is the documented path for connecting CrewAI to a
    custom OpenAI-compatible endpoint.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROXY_BASE = os.environ.get("PROXY_BASE", "http://127.0.0.1:8788")
WORK_DIR = "./tests/"

MODELS = [
    "max-m3",                     # local test
    "gpt-5.5",                        # gpt
    "deepseek/deepseek-v4-flash",     # deepseek
    "minimax/minimax-m3",             # minimax
    "google/gemini-3.1-flash-lite",   # gemini
    "claude-4.5-haiku",               # claude
    "openai/gpt-5.4-mini",            # gpt
    "qwen3-max-preview",              # qwen3
    "moonshotai/kimi-k2.7-code",      # moonshot-kimi
    "z-ai/glm-5.2",                   # z-ai-glm
]

# Each task targets a different AI-coding / agent capability so model
# differences surface clearly. All tasks operate against ./tests/ (WORK_DIR).
# Tasks are tuned to require real tool use (multi-glob + multi-read) rather
# than a single guess.
USER_TASKS: list[dict[str, str]] = [
    {
        "name": "codebase_layout",
        "prompt": (
            "Analyze the codebase file structure in ./tests/ and report layout suggestions. "
            "Group files by purpose (api handlers, fixtures, scripts, feature suites, etc.) "
            "and flag anything that looks misplaced."
        ),
    },
    {
        "name": "duplicate_helpers",
        "prompt": (
            "Search ./tests/ for helper functions that are duplicated across multiple test files "
            "(e.g. identical curl wrappers, retry loops, or auth-header builders). Read the "
            "suspected duplicates and confirm whether they are truly identical or only superficially "
            "similar. Report a deduplication plan naming the files involved."
        ),
    },
    {
        "name": "stale_or_dead_tests",
        "prompt": (
            "Audit ./tests/ for stale or dead test cases: shell scripts with hard-coded absolute "
            "paths that no longer exist, files referencing removed endpoints, or commented-out "
            "test blocks left behind. Report each finding with the file path and a one-line "
            "recommendation (delete / fix / keep)."
        ),
    },
    {
        "name": "coverage_matrix",
        "prompt": (
            "Build a coverage matrix: for each test file under ./tests/, list which endpoint or "
            "feature it covers (e.g. /v1/messages, streaming, routing). Group similar files and "
            "call out obvious coverage gaps — features mentioned in README.md that have no test "
            "file backing them."
        ),
    },
    {
        "name": "hardcoded_credentials",
        "prompt": (
            "Security review: scan ./tests/ for hard-coded credentials, API keys, tokens, or "
            "secrets that should not be committed to source control. List each finding with file "
            "path, line context, and severity (high if it looks like a real key, low if it is "
            "clearly a placeholder like 'sk-test' or 'YOUR_API_KEY')."
        ),
    },
    {
        "name": "extract_shared_utilities",
        "prompt": (
            "Read a representative sample of test files under ./tests/ and identify utilities that "
            "should be extracted into a shared module (e.g. proxy startup helpers, curl wrappers, "
            "JSON assertion helpers). Propose a small refactor: which functions move, where they "
            "live, and which call sites get simplified."
        ),
    },
    {
        "name": "convention_violations",
        "prompt": (
            "Review naming and structural conventions in ./tests/: file naming (snake_case vs "
            "kebab-case vs camelCase), script header style (shebang + cd / export), and how "
            "test setup is performed. Report inconsistencies grouped by convention type, with "
            "a recommended standard for each."
        ),
    },
    {
        "name": "dependency_audit",
        "prompt": (
            "Find every external package or CLI tool referenced from test scripts under ./tests/ "
            "(e.g. curl, jq, node, npm, tsx). For each, note whether the test assumes a specific "
            "version or path, and flag any that look fragile or undocumented."
        ),
    },
]

SYSTEM_PROMPT = (
    "You are a code-analysis assistant. Use the provided Glob and Read tools to "
    "inspect ./tests/ before answering. Cite file paths and line ranges. Admit "
    "uncertainty rather than fabricating."
)

# ---------------------------------------------------------------------------
# Shared tool implementations
# ---------------------------------------------------------------------------
#
# The three agents are wired with identical Glob/Read tool surfaces so their
# behavior stays comparable. Implementations follow the same regex rules as
# the TS file (tests/multi-agents-test.ts:toolGlobSync).

_SENTINEL = "\x00"


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Convert a glob pattern to a compiled regex.

    ** -> .*, * -> [^/]*, ? -> .. Other characters are literal.
    """
    regex_str = (
        "^"
        + pattern.replace("**", _SENTINEL)
        .replace("*", "[^/]*")
        .replace(_SENTINEL, ".*")
        .replace("?", ".")
        + "$"
    )
    return re.compile(regex_str)


def tool_glob_sync(pattern: str, max_results: int = 100) -> list[str]:
    """Walk WORK_DIR and return file paths matching the glob pattern."""
    regex = _glob_to_regex(pattern)
    results: list[str] = []
    base = Path(WORK_DIR)

    def _walk(directory: Path) -> None:
        if len(results) >= max_results:
            return
        try:
            entries = list(directory.iterdir())
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            return
        for entry in entries:
            if len(results) >= max_results:
                break
            if entry.is_dir():
                if entry.name.startswith("."):
                    continue
                _walk(entry)
            elif entry.is_file() or entry.is_symlink():
                if regex.match(str(entry)):
                    results.append(str(entry))

    if base.exists():
        _walk(base)
    return results[:max_results]


def tool_read(file_path: str) -> str:
    """Read a file's contents. Returns an error string on failure."""
    try:
        return Path(file_path).read_text(encoding="utf-8")
    except Exception as e:  # noqa: BLE001 - surface any read error verbatim
        return f"Error: {e}"


# ---------------------------------------------------------------------------
# Agent 1: Google Antigravity  (docs/agents/google-antigravity.md)
# ---------------------------------------------------------------------------
#
# The proxy exposes an OpenAI-compatible `/v1/chat/completions` endpoint, so
# this runner uses `LocalOpenAIAgentConfig` with `{PROXY_BASE}`. The SDK
# appends `/v1/chat/completions` to that origin but sends no auth header.
# Start the proxy with `DEV_NO_KEY=true`; configure
# `[general] auth_passthrough_with = "config_key"` so it injects the selected
# model route's configured upstream key. `LocalAgentConfig` plus a
# `GeminiAPIEndpoint` is the separate configuration for Gemini-compatible
# endpoints.

async def run_antigravity_agent(prompt: str, model: str) -> None:
    print(f"\n--- Antigravity Agent | model={model} ---")
    try:
        from google.antigravity import Agent, LocalOpenAIAgentConfig
    except ImportError as e:
        print(f"Antigravity skipped: `google-antigravity` not installed ({e})")
        return

    def glob_tool(pattern: str) -> str:
        """List files matching a glob pattern under ./tests/.

        Example: pattern="tests/**/*.ts" or "src/**/*.{ts,js}".
        """
        return json.dumps(tool_glob_sync(pattern), indent=2)

    def read_tool(path: str) -> str:
        """Read the full contents of a file.

        Args:
            path: Absolute file path.
        """
        return tool_read(path)

    try:
        config = LocalOpenAIAgentConfig(
            model=model,
            base_url=PROXY_BASE,
            system_instructions=SYSTEM_PROMPT,
            tools=[glob_tool, read_tool],
        )
    except (TypeError, pydantic.ValidationError) as e:
        print(f"Antigravity config rejected by LocalOpenAIAgentConfig: {e}")
        return

    try:
        async with Agent(config) as agent:
            response = await agent.chat(prompt)
            # The doc shows both `.text()` (awaitable) and direct `async for`
            # streaming. Try the awaitable path first; fall back to async-iter.
            try:
                text = await response.text()
            except AttributeError:
                chunks: list[str] = []
                async for token in response:
                    chunks.append(token)
                text = "".join(chunks)
            if text:
                print("Antigravity output:")
                print(text)
            else:
                print("(no text output)")
    except Exception as e:
        print(f"Antigravity failed: {e}")
        if "401" in str(e):
            print(
                "Antigravity auth hint: start the proxy with DEV_NO_KEY=true "
                "and set [general] auth_passthrough_with = \"config_key\" in "
                "the active proxy TOML with an api_key for the selected model route."
            )


# ---------------------------------------------------------------------------
# Agent 2: LangGraph  (docs/agents/langgraph.md)
# ---------------------------------------------------------------------------
#
# LangGraph is a low-level orchestrator — it does not ship its own chat
# client. The standard pairing for tool-calling agents is
# `langchain.agents.create_agent` (aliased here as `create_react_agent`,
# since it implements the ReAct tool-calling loop; the pre-1.x location
# `langgraph.prebuilt.create_react_agent` is deprecated) with a LangChain
# chat model. We point `langchain_openai.ChatOpenAI` at the proxy's
# OpenAI-compatible endpoint (`{PROXY_BASE}/v1`) which the proxy serves
# when started with `DEV_PASS_THROUGH=true`.

def run_langgraph_agent(prompt: str, model: str) -> None:
    print(f"\n--- LangGraph Agent | model={model} ---")
    try:
        from langchain_core.tools import tool
        from langchain_openai import ChatOpenAI
        from langchain.agents import create_agent as create_react_agent
    except ImportError as e:
        print(f"LangGraph skipped: missing dependency ({e})")
        print("Install with: pip install langgraph langchain langchain-openai langchain-core")
        return

    @tool
    def glob_files(pattern: str) -> str:
        """List files matching a glob pattern under ./tests/.

        Example: pattern="tests/**/*.ts" or "src/**/*.{ts,js}".
        """
        return json.dumps(tool_glob_sync(pattern), indent=2)

    @tool
    def read_file(path: str) -> str:
        """Read the full contents of a file.

        Args:
            path: Absolute file path.
        """
        return tool_read(path)

    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("API_KEY") or "sk-agent-test-key"

    try:
        llm = ChatOpenAI(
            model=model,
            base_url=f"{PROXY_BASE}/v1",
            api_key=api_key,
            temperature=0,
        )
        agent = create_react_agent(llm, tools=[glob_files, read_file])

        result = agent.invoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config={"recursion_limit": 50},
        )
        msgs = result.get("messages", []) if isinstance(result, dict) else []
        # Surface both the last assistant text and the tool-call count so the
        # log shows what the agent actually did (matches the TS file's
        # `tool_calls=N, chars=M` summary).
        last_text = ""
        tool_calls = 0
        for m in msgs:
            tc = getattr(m, "tool_calls", None)
            if tc:
                tool_calls += len(tc)
            content = getattr(m, "content", "")
            if isinstance(content, str):
                last_text = content
            elif isinstance(content, list):
                # ChatOpenAI may return content blocks; concatenate text parts.
                parts = [
                    blk.get("text", "")
                    for blk in content
                    if isinstance(blk, dict) and blk.get("type") == "text"
                ]
                if parts:
                    last_text = "\n".join(parts)
        print(f"LangGraph done. tool_calls={tool_calls}, chars={len(last_text)}")
        if last_text:
            print(last_text)
        else:
            print("(no text output)")
    except Exception as e:
        print(f"LangGraph failed: {e}")


# ---------------------------------------------------------------------------
# Agent 3: CrewAI  (docs/agents/crewai.md)
# ---------------------------------------------------------------------------
#
# CrewAI is built around `Agent` + `Task` + `Crew`. Tools subclass
# `BaseTool` (CrewAI's tool base class). The LLM is configured via the
# `LLM` class; the `openai/` model prefix tells CrewAI to use the
# OpenAI-compatible chat-completions client, which we point at
# `{PROXY_BASE}/v1`.

def run_crewai_agent(prompt: str, model: str) -> None:
    print(f"\n--- CrewAI Agent | model={model} ---")
    try:
        from crewai import Agent, Crew, LLM, Process, Task
        from crewai.tools import BaseTool
        from pydantic import BaseModel, Field
    except ImportError as e:
        print(f"CrewAI skipped: missing dependency ({e})")
        print("Install with: pip install crewai  (and pydantic)")
        return

    class GlobInput(BaseModel):
        pattern: str = Field(..., description='Glob pattern, e.g. "tests/**/*.ts"')

    class ReadInput(BaseModel):
        path: str = Field(..., description="Absolute file path to read")

    class GlobTool(BaseTool):
        name: str = "Glob"
        description: str = "List files matching a glob pattern under ./tests/"

        args_schema: type[BaseModel] = GlobInput

        def _run(self, pattern: str) -> str:
            return json.dumps(tool_glob_sync(pattern), indent=2)

    class ReadTool(BaseTool):
        name: str = "Read"
        description: str = "Read the full contents of a file"

        args_schema: type[BaseModel] = ReadInput

        def _run(self, path: str) -> str:
            return tool_read(path)

    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("API_KEY") or "sk-agent-test-key"

    try:
        llm = LLM(
            model=f"openai/{model}",
            base_url=f"{PROXY_BASE}/v1",
            api_key=api_key,
            temperature=0,
        )

        analyst = Agent(
            role="Codebase Analyst",
            goal="Inspect ./tests/ using Glob/Read and report concrete findings",
            backstory=(
                "You are a meticulous code reviewer who only makes claims backed "
                "by file paths you have personally read."
            ),
            llm=llm,
            tools=[GlobTool(), ReadTool()],
            allow_delegation=False,
            verbose=False,
        )

        analysis_task = Task(
            description=prompt,
            expected_output=(
                "A structured report citing file paths and line ranges from "
                "./tests/, with concrete findings and one-line recommendations."
            ),
            agent=analyst,
        )

        crew = Crew(
            agents=[analyst],
            tasks=[analysis_task],
            process=Process.sequential,
            verbose=False,
        )

        result = crew.kickoff()
        output = getattr(result, "raw", None) or str(result)
        print(f"CrewAI done. chars={len(output)}")
        if output:
            print(output)
        else:
            print("(no text output)")
    except Exception as e:
        print(f"CrewAI failed: {e}")


# ---------------------------------------------------------------------------
# Agent registry (drives the CLI `agent` selector)
# ---------------------------------------------------------------------------

AgentRunner = Callable[[str, str], None]
AsyncAgentRunner = Callable[[str, str], Awaitable[None]]

AGENTS: list[dict[str, AgentRunner | AsyncAgentRunner | str]] = [
    {"name": "Antigravity", "run": run_antigravity_agent, "async": True},
    {"name": "LangGraph",  "run": run_langgraph_agent,  "async": False},
    {"name": "CrewAI",     "run": run_crewai_agent,     "async": False},
]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _select(argv: list[str]) -> tuple[list[str], list[dict[str, Any]], list[dict[str, str]]]:
    """Apply the CLI `model agent task` selection.

    Mirrors the TS file: 1-based picks with wrap; 0 means "all".
    """
    models_to_run: list[str] = list(MODELS)
    agents_to_run: list[dict[str, Any]] = list(AGENTS)
    tasks_to_run: list[dict[str, str]] = list(USER_TASKS)
    if len(argv) >= 3:
        m, a, t = (int(x, 10) for x in argv[:3])
        if m > 0:
            models_to_run = [MODELS[(m - 1) % len(MODELS)]]
        if a > 0:
            agents_to_run = [AGENTS[(a - 1) % len(AGENTS)]]
        if t > 0:
            tasks_to_run = [USER_TASKS[(t - 1) % len(USER_TASKS)]]
    return models_to_run, agents_to_run, tasks_to_run


async def _run_async(agent: dict[str, Any], prompt: str, model: str) -> None:
    runner = agent["run"]
    if agent.get("async"):
        await runner(prompt, model)  # type: ignore[arg-type]
    else:
        runner(prompt, model)  # type: ignore[arg-type]


async def main() -> None:
    models_to_run, agents_to_run, tasks_to_run = _select(sys.argv[1:])
    print(
        f"Selection: {len(models_to_run)} model(s) x "
        f"{len(agents_to_run)} agent(s) x {len(tasks_to_run)} task(s)"
    )
    for m in models_to_run:
        print(f"  model:  {m}")
    for ag in agents_to_run:
        print(f"  agent:  {ag['name']}")
    for t in tasks_to_run:
        print(f"  task:   {t['name']}")

    for task in tasks_to_run:
        for model in models_to_run:
            print(
                f"\n=========== Task: {task['name']} | Model: {model} ==========="
            )
            for agent in agents_to_run:
                try:
                    await _run_async(agent, task["prompt"], model)
                except Exception as e:
                    # Fail loud per CLAUDE.md rule 8 — surface the error and
                    # keep going so one broken agent doesn't mask others.
                    print(f"{agent['name']} crashed: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(130)
    except Exception as e:
        print(f"Fatal: {e}")
        sys.exit(1)

# ** Dump Data Format Difference **
# Old heatmapEvents format (array of plain objects):
#   [{ timestamp: <ms_epoch_int>, values: <int>, model: "<model_name>" }, ...]
#   - timestamp: millisecond Unix epoch (e.g. 1780672565173)
#   - values: token count
#   - model: model name string (inline per entry)
#
# New heatmapEvents format (object with model lookup):
#   {
#     models: { "<hash_id>": "<model_name>" },  # id → model name mapping
#     sequences: [
#       { ts: <sec_epoch_int>, values: <int>, id: "<session_id>" }, ...
#     ]
#   }
#   - ts: second-precision Unix epoch (e.g. 1782129250)
#   - id: references key in models map
#
# toolStats format (new, array of tool call aggregates):
#   [
#     {
#       name: "<tool_name>",      # e.g. "Bash", "Read", "Agent"
#       agent: "<agent_name>",    # e.g. "claude-cli", "undici", "node", "all"
#       req: <int>,               # number of requests
#       resp: <int>,              # number of responses
#       len: <int>,               # total bytes
#       blocked: <int>            # blocked count
#     }, ...
#   ]
#   - agent "all" and name "none"/"Bash"/"Read" appear to be aggregation rows
#
# modelStats format (unchanged between old and new):
#   Per-entry fields: model, requests, failed_requests, input_tokens,
#   cached_tokens, cache_written_tokens, output_tokens, total_tokens
#   - Old: 1 entry per record (single model), timestamp as ISO string
#   - New: 30+ entries per record (all models), timestamp as Unix seconds,
#     plus new top-level fields: lastDumpTs, toolStats, heatmapEvents restructured
#
# -----------------------------------------------------------------------------------
#
# Usage: python transform_dump_data_precise_size.py [input_file]
#   input_file  : path to the dump file (default: model_proxy_tokens.jsonl)
#
# Transforms all heatmapEvents to new {models, sequences} format and normalizes
# timestamps (ms → sec). Converts in-place by writing to .new then renaming.
#

import json
import hashlib
import os
import sys
from datetime import datetime, timezone

MODEL_ID_HEX_LEN = 4


def model_id(model_name: str) -> str:
    """Mirror `createHash('sha256').update(model).digest('hex').slice(0, 4)` in TS."""
    return hashlib.sha256(model_name.encode('utf-8')).hexdigest()[:MODEL_ID_HEX_LEN]


def normalize_ts_to_sec(ts) -> int | None:
    """Convert ms timestamp (>1e12) to sec, pass through sec timestamps as-is."""
    if isinstance(ts, (int, float)):
        if ts > 1e12:
            return int(ts / 1000)   # ms → sec
        return int(ts)              # already sec
    return None


def transform_legacy_to_new(events_list: list) -> dict:
    """Convert [{ timestamp, values, model }, ...] → { models, sequences }."""
    models: dict = {}
    sequences: list = []
    for ev in events_list:
        ts = normalize_ts_to_sec(ev.get('timestamp'))
        values = ev.get('values')
        model = ev.get('model')
        if ts is None or not isinstance(values, (int, float)):
            continue
        id_ = None
        if isinstance(model, str) and model:
            id_ = model_id(model)
            models[id_] = model
        sequences.append({'ts': ts, 'values': int(values), 'id': id_})
    return {'models': models, 'sequences': sequences}


def transform_record(rec: dict) -> dict:
    """Transform a single record: normalize top-level timestamp and heatmapEvents."""
    # Fix 1: top-level timestamp: ISO string → Unix seconds, ms → sec
    raw_ts = rec.get('timestamp')
    if isinstance(raw_ts, str):
        rec['timestamp'] = int(
            datetime.fromisoformat(raw_ts.replace('Z', '+00:00'))
            .timestamp()
        )
    elif isinstance(raw_ts, (int, float)) and raw_ts > 1e12:
        rec['timestamp'] = int(raw_ts / 1000)

    # Fix 2: heatmapEvents — convert old array to new {models, sequences} format
    h = rec.get('heatmapEvents')
    if isinstance(h, list):
        # Legacy array shape → convert to new format
        rec['heatmapEvents'] = transform_legacy_to_new(h)
    elif isinstance(h, dict) and 'sequences' in h:
        # New {models, sequences} shape → just normalize ms→sec in sequences
        for e in h.get('sequences', []):
            ts = normalize_ts_to_sec(e.get('ts'))
            if ts is not None:
                e['ts'] = ts

    return rec


def main():
    input_path = sys.argv[1] if len(sys.argv) > 1 else 'model_proxy_tokens.jsonl'
    output_path = input_path + '.new'

    with open(input_path, 'r') as f:
        lines = f.readlines()

    with open(output_path, 'w') as f:
        for line in lines:
            rec = json.loads(line)
            transform_record(rec)
            f.write(json.dumps(rec) + '\n')

    os.rename(output_path, input_path)
    print(f'Transformed {len(lines)} rows → {input_path}')


if __name__ == '__main__':
    main()

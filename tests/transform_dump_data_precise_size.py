import json
import hashlib

# Must match MODEL_ID_HEX_LEN in src/utils/dashboard-stats.ts (4 hex chars).
MODEL_ID_HEX_LEN = 4


def model_id(model_name: str) -> str:
    # Mirrors `createHash('sha256').update(model).digest('hex').slice(0, 4)` in TS.
    return hashlib.sha256(model_name.encode('utf-8')).hexdigest()[:MODEL_ID_HEX_LEN]


def normalize_ms_to_sec(event: dict, ts_key: str) -> None:
    ts = event.get(ts_key)
    if isinstance(ts, (int, float)) and ts > 1e12:
        event[ts_key] = int(ts / 1000)


def transform_legacy_to_new(events_list: list) -> dict:
    """Convert [{ timestamp, values, model }, ...] → { models, sequences }."""
    models: dict = {}
    sequences: list = []
    for ev in events_list:
        normalize_ms_to_sec(ev, 'timestamp')
        ts = ev.get('timestamp')
        values = ev.get('values')
        model = ev.get('model')
        if not isinstance(ts, (int, float)) or not isinstance(values, (int, float)):
            continue
        id_ = None
        if isinstance(model, str) and model:
            id_ = model_id(model)
            models[id_] = model
        sequences.append({'ts': int(ts), 'values': int(values), 'id': id_})
    return {'models': models, 'sequences': sequences}


with open('model_proxy_tokens.jsonl', 'r') as f:
    lines = f.readlines()
with open('model_proxy_tokens.jsonl', 'w') as f:
    for line in lines:
        rec = json.loads(line)
        if 'heatmapEvents' in rec:
            h = rec['heatmapEvents']
            # Legacy array shape → normalize ms→sec AND convert to {models, sequences}
            if isinstance(h, list):
                rec['heatmapEvents'] = transform_legacy_to_new(h)
            # Current shape → just normalize ms→sec inside sequences
            elif isinstance(h, dict) and 'sequences' in h:
                for e in h['sequences']:
                    normalize_ms_to_sec(e, 'ts')
        f.write(json.dumps(rec) + '\n')
"""Summarize recorded Tau results without changing runtime or benchmark behavior."""
import json
import math
import statistics
import sys
from pathlib import Path


def summarize(path):
    data = json.loads(Path(path).read_text())
    rows = []
    for simulation in data['simulations']:
        messages = simulation['messages']
        logs = [(message.get('raw_data') or {}).get('keeled', {}) for message in messages]
        traces = [trace for log in logs for trace in log.get('trace', [])]
        generations = [trace['detail'] for trace in traces if trace['kind'] == 'generate']
        recovery = [trace for trace in generations if trace.get('purpose') == 'stall_recovery']
        usage = {'model': {}, 'controller': {}}
        for log in logs:
            for bucket, values in log.get('usage', {}).items():
                for key, value in values.items():
                    usage[bucket][key] = usage[bucket].get(key, 0) + value
        # Generation traces survive when a turn is interrupted before its final usage event.
        model_input = sum(trace.get('inputTokens', 0) or 0 for trace in generations)
        model_output = sum(trace.get('outputTokens', 0) or 0 for trace in generations)
        model_input = max(model_input, usage['model'].get('inputTokens', 0))
        model_output = max(model_output, usage['model'].get('outputTokens', 0))
        model_cost = (model_input * .30 + model_output * 1.20) / 1_000_000
        controller_cost = usage['controller'].get('inputTokens', 0) * .042 / 1_000_000
        reward = simulation.get('reward_info') or {}
        writes = [check for check in reward.get('action_checks', []) or [] if check.get('tool_type') == 'write']
        rows.append({
            'task': simulation['task_id'], 'success': reward.get('reward') == 1,
            'duration_s': simulation['duration'], 'termination': simulation['termination_reason'],
            'recovery_calls': len(recovery), 'recovery_ms': sum(trace['ms'] for trace in recovery),
            'recovery_errors': sum(trace.get('status') == 'error' for trace in recovery),
            'generation_errors': sum(trace.get('status') == 'error' for trace in generations),
            'model_calls': len(generations) if generations else usage['model'].get('calls', 0),
            'controller_calls': usage['controller'].get('calls', 0),
            'model_input_tokens': model_input, 'model_output_tokens': model_output,
            'controller_input_tokens': usage['controller'].get('inputTokens', 0),
            'estimated_agent_cost_usd': model_cost + controller_cost,
            'user_cost_usd': simulation.get('user_cost') or 0,
            'missed_reference_writes': sum(not check['action_match'] for check in writes),
            'db_match': (reward.get('db_check') or {}).get('db_match'),
        })
    rows.sort(key=lambda row: int(row['task']))
    durations = sorted(row['duration_s'] for row in rows if row['duration_s'] > 0 and row['termination'] != 'infrastructure_error')
    successes = sum(row['success'] for row in rows)
    total_cost = sum(row['estimated_agent_cost_usd'] + row['user_cost_usd'] for row in rows)
    return {
        'source': str(Path(path).resolve()), 'tasks': rows,
        'successes': successes, 'count': len(rows),
        'latency_sample_count': len(durations),
        'median_s': statistics.median(durations),
        'p90_s_nearest_rank': durations[math.ceil(.9 * len(durations)) - 1],
        'total_recorded_duration_s': sum(durations),
        'recovery_calls': sum(row['recovery_calls'] for row in rows),
        'estimated_recorded_cost_usd': total_cost,
        'estimated_recorded_cost_per_success_usd': total_cost / successes if successes else None,
        'cost_limits': 'Uncached list-rate estimate. Excludes unreported failed-call tokens, interrupted unsaved attempts and controller usage in turns without a final usage event. Not an invoice.',
    }


if __name__ == '__main__':
    print(json.dumps([summarize(path) for path in sys.argv[1:]], indent=2))

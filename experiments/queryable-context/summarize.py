"""Summarize saved Tau trajectories without changing or scoring runtime behavior.

Usage: python3 experiments/queryable-context/summarize.py path/to/results.json
Missing telemetry is reported as null, never as zero model usage or zero cost.
"""
import collections
import json
import math
import statistics
import sys


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def summarize(path):
    with open(path) as handle:
        data = json.load(handle)
    rows = []
    tasks = {str(task['id']): task for task in data['tasks']}
    # Tool types are supplied by Tau's evaluator, not guessed from tool names.
    write_names = {check['action']['name'] for sim in data['simulations']
                   for check in ((sim.get('reward_info') or {}).get('action_checks') or [])
                   if check.get('tool_type') == 'write'}
    totals = collections.Counter()
    purposes = collections.Counter()
    input_sizes = []
    query_durations = []
    model_ids = set()
    cache_traces = []
    for sim in data['simulations']:
        calls, expected = [], (tasks[str(sim['task_id'])].get('evaluation_criteria') or {}).get('actions', [])
        traces = []
        turn_usage = []
        stop_reasons = collections.Counter()
        for message in sim['messages']:
            calls.extend(message.get('tool_calls') or [])
            keeled = (message.get('raw_data') or {}).get('keeled', {})
            traces.extend(keeled.get('trace', []))
            if 'usage' in keeled:
                turn_usage.append(keeled['usage'])
            if 'stop_reason' in keeled:
                stop_reasons[keeled['stop_reason']] += 1
        generated = [trace['detail'] for trace in traces if trace['kind'] == 'generate']
        cache_traces.extend(trace for trace in generated if trace.get('modelId') and trace.get('purpose') != 'context_query')
        queries = [trace for trace in generated if trace.get('purpose') == 'context_query']
        row_usage = collections.Counter()
        for trace in generated:
            purposes[trace.get('purpose', 'unknown')] += 1
            if trace.get('modelId'):
                model_ids.add(trace['modelId'])
            if 'inputTokens' in trace and trace.get('purpose') != 'context_query':
                input_sizes.append(trace['inputTokens'])
            if trace.get('purpose') == 'context_query':
                query_durations.append(trace['ms'])
        for usage in turn_usage:
            for bucket in ('model', 'controller'):
                for key, value in usage[bucket].items():
                    totals[f'{bucket}_{key}'] += value
                    row_usage[f'{bucket}_{key}'] += value
        checks = ((sim.get('reward_info') or {}).get('action_checks') or [])
        expected_writes = [check for check in checks if check.get('tool_type') == 'write']
        writes = [call for call in calls if call.get('name') in write_names]
        signatures = [json.dumps([call.get('name'), call.get('arguments')], sort_keys=True) for call in writes]
        duplicate_attempts = sum(count - 1 for count in collections.Counter(signatures).values())
        def matches(call, reference):
            if call.get('name') != reference['name']:
                return False
            keys = reference.get('compare_args') or reference['arguments'].keys()
            return all(call.get('arguments', {}).get(key) == reference['arguments'].get(key) for key in keys)
        unmatched = sum(not any(matches(call, reference) for reference in expected) for call in writes)
        row = {
            'task': str(sim['task_id']), 'trial': sim.get('trial'),
            'reward': (sim.get('reward_info') or {}).get('reward'),
            'seconds': round(sim['duration'], 3), 'termination': sim.get('termination_reason'),
            'reported_inference_seconds': round(sum(trace.get('ms', 0) for trace in traces
                                                    if trace.get('kind') in ('generate', 'control', 'authorize')) / 1000, 3),
            'external_calls': len(calls), 'write_attempts': len(writes),
            'duplicate_write_attempts': duplicate_attempts, 'writes_unmatched_to_reference': unmatched,
            'expected_writes': len(expected_writes),
            'missed_reference_writes': sum(not check['action_match'] for check in expected_writes),
            'missed_reference_reads': sum(not check['action_match'] for check in checks if check.get('tool_type') == 'read'),
            'query_attempts': len(queries), 'query_ms': sum(query['ms'] for query in queries),
            'query_failures': sum(query['status'] == 'error' for query in queries),
            'query_cache_hits': sum(query.get('detail', {}).get('cacheHit', False) for query in queries),
            'incomplete_queries': sum(not query.get('detail', {}).get('coverage', {}).get('complete', True) for query in queries),
            'generation_failures': (sum(trace.get('status') == 'error' for trace in generated if trace.get('purpose') not in ('context_query', 'runtime_error')) if all('status' in trace for trace in generated) else None),
            'runtime_errors': sum(trace.get('purpose') == 'runtime_error' for trace in generated),
            'stop_reasons': dict(stop_reasons),
            'usage_completed_turns': dict(row_usage),
        }
        rows.append(row)
    expected_simulations = len(tasks) * data['info']['num_trials']
    scored = [row for row in rows if row['reward'] is not None and row['termination'] != 'infrastructure_error']
    complete = (len(scored) == expected_simulations == len(rows)
                and len({(row['task'], row['trial']) for row in rows}) == expected_simulations)
    # Infrastructure failures may be saved with fabricated zero duration and no trajectory.
    # Preserve rows for diagnosis, but never turn those placeholders into performance gains.
    durations = [row['seconds'] for row in rows] if complete else []
    return {
        'source': path, 'tasks': len(rows), 'successes': sum(row['reward'] == 1 for row in rows),
        'expected_simulations': expected_simulations, 'scored_simulations': len(scored),
        'valid_for_comparison': complete,
        'mean_seconds': statistics.mean(durations) if durations else None,
        'median_seconds': statistics.median(durations) if durations else None,
        'p90_seconds': percentile(durations, .9), 'usage_completed_turns': dict(totals),
        'generation_purposes': dict(purposes), 'model_ids': sorted(model_ids),
        'median_generator_input_tokens': statistics.median(input_sizes) if input_sizes else None,
        'p90_generator_input_tokens': percentile(input_sizes, .9),
        'median_query_ms': statistics.median(query_durations) if query_durations else None,
        'p90_query_ms': percentile(query_durations, .9),
        'mean_external_calls': statistics.mean(row['external_calls'] for row in rows) if complete else None,
        'mean_model_output_tokens': totals['model_outputTokens'] / len(rows) if complete else None,
        'actual_cost': None, 'labeled_retrieval_recall': None,
        'cache_telemetry': {
            'calls_with_cache_detail': sum('cacheReadTokens' in trace for trace in cache_traces),
            'calls_without_cache_detail': sum('cacheReadTokens' not in trace for trace in cache_traces),
            'reported_cache_read_tokens': (sum(trace.get('cacheReadTokens', 0) for trace in cache_traces)
                                           if any('cacheReadTokens' in trace for trace in cache_traces) else None),
            'reported_cache_write_tokens': (sum(trace.get('cacheWriteTokens', 0) for trace in cache_traces)
                                            if any('cacheWriteTokens' in trace for trace in cache_traces) else None),
        },
        'rows': sorted(rows, key=lambda row: int(row['task'])),
        'limits': [
            'Write names come from evaluator action_checks across this run; untyped tools are not classified.',
            'Reference matching is not a complete safety or user-intent judgment.',
            'Turn usage excludes work not returned by an interrupted turn; failed requests can lack token usage.',
            'No actual provider invoice or labeled recall is available. Missing cache detail is unknown, not zero.',
            'Semantic filtering is conservatively incomplete; incomplete queries are not necessarily retrieval failures.',
            'Task duration includes user simulation; reported inference time sums returned diagnostic calls and can omit interrupted work.',
        ],
    }


if __name__ == '__main__':
    print(json.dumps(summarize(sys.argv[1]), indent=2))

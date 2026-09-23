"""
Insert an FFmpeg Builder custom-parameters node carrying -movflags +faststart
immediately before every FFmpeg Builder Executor in a flow.

Every branch of these flows ends the same way: ... -> Executor -> Replace/Move.
The builder nodes between Start and Executor mutate the command; the Executor
runs it. So the flag goes in on the last hop before the run, on every branch,
because a branch without it writes another file with its index at the wrong end.

ForceEncode is set false deliberately. It defaults to TRUE, and left alone it
would turn every remux in this pipeline into a re-encode.
"""
import json, sys, uuid, copy

EXEC = 'FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderExecutor'
CUSTOM = 'FileFlows.VideoNodes.FfmpegBuilderNodes.FfmpegBuilderCustomParameters'

def transform(flow):
    parts = flow['Parts']
    execs = [p for p in parts if p.get('FlowElementUid') == EXEC]

    # Already done? Don't stack a second copy on a re-run.
    existing = [p for p in parts if p.get('FlowElementUid') == CUSTOM]
    if existing:
        return flow, 0, len(execs), len(existing)

    added = 0
    for ex in execs:
        node = {
            'Uid': str(uuid.uuid4()),
            'ReadOnly': False,
            'FlowElementUid': CUSTOM,
            'xPos': ex.get('xPos', 0) - 210,
            'yPos': ex.get('yPos', 0),
            'Icon': 'fas fa-cogs',
            'Label': 'Faststart',
            'Inputs': 1,
            'Outputs': 1,
            'OutputConnections': [
                {'Input': 1, 'Output': 1, 'InputNode': ex['Uid']}
            ],
            'Type': 6,
            'Model': {'Parameters': ['-movflags', '+faststart'], 'ForceEncode': False},
        }

        # Everything that fed the executor now feeds the new node instead.
        for p in parts:
            for c in p.get('OutputConnections') or []:
                if c.get('InputNode') == ex['Uid']:
                    c['InputNode'] = node['Uid']

        parts.append(node)
        added += 1

    return flow, added, len(execs), 0

def check(flow):
    """Every executor must be fed only by a faststart node, and nothing else."""
    parts = flow['Parts']
    by_uid = {p['Uid']: p for p in parts}
    problems = []

    for ex in [p for p in parts if p.get('FlowElementUid') == EXEC]:
        feeders = [p for p in parts for c in (p.get('OutputConnections') or [])
                   if c.get('InputNode') == ex['Uid']]
        bad = [f for f in feeders if f.get('FlowElementUid') != CUSTOM]
        if bad:
            problems.append(f"executor {ex['Uid'][:8]} still fed by {[b.get('Label') for b in bad]}")

    for n in [p for p in parts if p.get('FlowElementUid') == CUSTOM]:
        targets = [c['InputNode'] for c in n.get('OutputConnections') or []]
        if len(targets) != 1 or by_uid.get(targets[0], {}).get('FlowElementUid') != EXEC:
            problems.append(f"faststart {n['Uid'][:8]} does not point at exactly one executor")
        if n['Model'].get('ForceEncode') is not False:
            problems.append(f"faststart {n['Uid'][:8]} has ForceEncode on")

    return problems

if __name__ == '__main__':
    path = sys.argv[1]
    flow = json.load(open(path))
    before = len(flow['Parts'])
    flow, added, execs, already = transform(flow)

    if already:
        print(f"  {flow['Name']}: already has {already} custom-parameter nodes — left alone")
        sys.exit(2)

    problems = check(flow)
    if problems:
        print(f"  {flow['Name']}: REFUSING — " + '; '.join(problems[:4]))
        sys.exit(1)

    json.dump(flow, open(path.replace('.json', '.patched.json'), 'w'), indent=1)
    print(f"  {flow['Name']}: {execs} executors, {added} faststart nodes added, parts {before} -> {len(flow['Parts'])}, checks passed")

"""
A flow that does one thing: rewrite the container with the index at the front.

Deliberately NOT the Porn ReEncoding flow. That one scales and converts to
HEVC, and pointing it at a library of 1037 already-finished scenes would
re-encode the lot — which is exactly why the `stash scenes` library has been
sitting disabled all this time.

  VideoFile -> Builder Start -> -movflags +faststart -> Executor -> Replace

No scaler, no encoder, no audio conversion. ForceEncode is false, so ffmpeg
copies the streams and only rewrites the container.
"""
import json
import uuid


def node(elem, x, y, label, model=None, outs=1, ntype=6):
    return {
        'Uid': str(uuid.uuid4()),
        'ReadOnly': False,
        'FlowElementUid': elem,
        'xPos': x,
        'yPos': y,
        'Label': label,
        'Inputs': 0 if ntype == 0 else 1,
        'Outputs': outs,
        'OutputConnections': [],
        'Type': ntype,
        'Model': model or {},
    }


V = 'FileFlows.VideoNodes.'

start = node(V + 'VideoFile', 400, 100, '', ntype=0)
build = node(V + 'FfmpegBuilderNodes.FfmpegBuilderStart', 400, 220, '', ntype=4)
fast = node(
    V + 'FfmpegBuilderNodes.FfmpegBuilderCustomParameters', 400, 340, 'Faststart',
    model={'Parameters': ['-movflags', '+faststart'], 'ForceEncode': False},
)
run = node(
    V + 'FfmpegBuilderNodes.FfmpegBuilderExecutor', 400, 460, '', outs=2, ntype=5,
    model={'HardwareDecoding': 'auto', 'Strictness': 'experimental'},
)
repl = node('FileFlows.BasicNodes.File.ReplaceOriginal', 400, 580, '', ntype=2)

start['OutputConnections'] = [{'Input': 1, 'Output': 1, 'InputNode': build['Uid']}]
build['OutputConnections'] = [{'Input': 1, 'Output': 1, 'InputNode': fast['Uid']}]
fast['OutputConnections'] = [{'Input': 1, 'Output': 1, 'InputNode': run['Uid']}]
# Output 1 is "it ran"; output 2 is "nothing to do". Only the first replaces.
run['OutputConnections'] = [{'Input': 1, 'Output': 1, 'InputNode': repl['Uid']}]

flow = {
    'Uid': str(uuid.uuid4()),
    'Name': 'Faststart Remux',
    'Enabled': True,
    'Type': 0,
    'ReadOnly': False,
    'Default': False,
    'Description': (
        'Rewrites the MP4 container with the index at the front so seeking is '
        'instant. Copies streams - no re-encode, no quality change.'
    ),
    'Icon': 'fas fa-forward',
    'Bridgeable': False,
    'Properties': {'Fields': [], 'Variables': {}},
    'Parts': [start, build, fast, run, repl],
}

with open('faststart-flow.json', 'w') as handle:
    json.dump(flow, handle, indent=1)

print('built Faststart Remux:', len(flow['Parts']), 'parts, uid', flow['Uid'])

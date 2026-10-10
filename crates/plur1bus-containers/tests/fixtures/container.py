#!/usr/bin/env python3
"""Offline fake Apple 1.5.0 CLI. State and call log live beside the copied script."""
import json, pathlib, sys
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as f: f.write(json.dumps(args) + '\n')
state_path = root / 'fake-state.json'
state = json.loads(state_path.read_text()) if state_path.exists() else {'running': True, 'version':'1.5.0', 'containers':{}, 'network':{}, 'volume':{}}
def save(): state_path.write_text(json.dumps(state))
def fail(s): print(s, file=sys.stderr); sys.exit(1)
if state.get('permission'): fail('Permission denied')
if args == ['--version']: print('container CLI version ' + state['version'])
elif args == ['system','status']:
    if not state['running']: fail('system stopped')
    print('status running')
elif args == ['system','start']: state['running'] = True; save()
elif args[:1] in [['network'], ['volume']]:
    kind, op = args[:2]
    if op == 'list': print(json.dumps(list(state[kind].values())))
    elif op == 'create':
        name = args[-1]; state[kind][name] = {'id':name, 'configuration': {'labels':{'app.plur1bus.stack':'distribution'}}}; save()
    elif op == 'delete': state[kind].pop(args[-1],None); save()
elif args[0] == 'image':
    if args[1] == 'list': print('[]')
elif args[0] == 'run': pass # isolated volume init
elif args[0] == 'create':
    name = args[args.index('--name')+1]
    # test images contain no command overrides
    image = args[-1]
    state['containers'][name] = {'configuration': {'id':name, 'labels':{'app.plur1bus.stack':'distribution'}, 'image': {'reference':image}}, 'status': {'state':'stopped', 'networks': [{'network': args[i+1].split(',')[0], 'ipv4Address': '192.168.88.2/24'} for i in range(len(args)-1) if args[i]=='--network']}}; save()
elif args[0] == 'start': state['containers'][args[-1]]['status']['state'] = 'running'; save()
elif args[0] == 'stop': state['containers'][args[-1]]['status']['state'] = 'stopped'; save()
elif args[0] == 'delete': state['containers'].pop(args[-1],None); save()
elif args[0] == 'list': print(json.dumps(list(state['containers'].values())))
elif args[0] == 'exec':
    if 'bad' in state['containers'][args[1]]['configuration']['image']['reference']: fail('unhealthy')
    print('healthy')
elif args[0] == 'logs': print('fake log')
else: fail('unrecognised fake command: '+str(args))

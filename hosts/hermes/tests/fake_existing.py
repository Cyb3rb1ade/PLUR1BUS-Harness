"""Synthetic Hermes client for HM4: attaches to a running core; never starts a process/service."""
import json
import sys
from plur1bus_memory_client import MemoryClient, Caller, RpcError
home, token_file, agent = sys.argv[1:]
with MemoryClient(home, token_path=token_file) as client:
    hello = client.connect()
    assert "hermes.scoped-client" in hello["capabilities"]["features"]
    client.status()
    client.agent_status(agent)
    client.recall(Caller('hermes:cli', 'synthetic'), agent, 'synthetic fact', session_key='hm4-test')
    try:
        client.agent_status('other')
        raise AssertionError('cross-agent access unexpectedly allowed')
    except RpcError as error:
        assert error.code == 'E_DENIED'
print(json.dumps({'attached': True, 'agent': agent}))

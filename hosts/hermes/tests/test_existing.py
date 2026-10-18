import json
import os
import tempfile
import unittest
from unittest.mock import patch
from plur1bus.existing import bound_client, client_token_path

class ExistingHarnessTest(unittest.TestCase):
    def test_full_profile_never_falls_back_to_core_token(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as hermes:
            with open(os.path.join(home, 'manifest.json'), 'w') as f:
                json.dump({'profile': 'full'}, f)
            path = os.path.join(hermes, 'plur1bus-client.token')
            self.assertEqual(client_token_path(hermes, home), path)
            with patch('plur1bus.existing.pmc.MemoryClient') as factory:
                bound_client(hermes, home)
                factory.assert_called_once_with(home, token_path=path)

    def test_host_profile_uses_scoped_token_when_provisioned(self):
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as hermes:
            with open(os.path.join(home, 'manifest.json'), 'w') as f:
                json.dump({'profile': 'host'}, f)
            self.assertIsNone(client_token_path(hermes, home))
            path = os.path.join(hermes, 'plur1bus-client.token')
            with open(path, 'w') as f: f.write('not a credential')
            self.assertEqual(client_token_path(hermes, home), path)

    def test_default_bind_on_full_profile_does_not_invoke_owner_cli(self):
        from plur1bus.cli import bind
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as hermes:
            with open(os.path.join(home, 'manifest.json'), 'w') as f:
                json.dump({'profile': 'full'}, f)
            with patch('subprocess.run') as runner:
                result = bind(hermes, home=home, runner=runner)
                self.assertFalse(result['ok'])
                runner.assert_not_called()

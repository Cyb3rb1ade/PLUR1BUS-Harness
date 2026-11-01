# Thin original MIT Python invocation bridge; no hidden expectations are present.
"""Original MIT invocation/inspection bridge, without reference algorithms or expected results."""
import copy
import importlib.util
import json
import os
import sqlite3
import sys
from unittest import mock
with open(sys.argv[1], encoding='utf-8') as source:
    setup = json.load(source)
data = setup['input']

def sqlite_snapshot(connection):
    """Run the private invocation protocol."""
    columns = connection.execute('PRAGMA table_info(people)').fetchall()
    unique = False
    for index in connection.execute('PRAGMA index_list(people)'):
        name = index[1].replace('"', '""')
        parts = connection.execute('PRAGMA index_info("' + name + '")').fetchall()
        if index[2] and (not index[4]) and ([part[2] for part in parts] == ['slug']):
            unique = True
    return {
        'columns': [column[1] for column in columns],
        'types': [[column[2], column[3], column[5]] for column in columns],
        'rows': connection.execute('SELECT * FROM people ORDER BY id').fetchall(),
        'uniqueSlug': unique,
        'slugNotNull': any(column[1] == 'slug' and column[3] for column in columns),
    }

def containers(value):
    """Run the private invocation protocol."""
    if isinstance(value, dict):
        return {id(value)}.union(*(containers(item) for item in value.values()))
    if isinstance(value, list):
        return {id(value)}.union(*(containers(item) for item in value))
    return set()
if setup.get('operation') in ('sqlite-prepare', 'sqlite-inspect'):
    connection = sqlite3.connect(data['path'])
    try:
        if setup['operation'] == 'sqlite-prepare':
            schema = data['schema']
            name_type = 'INTEGER' if schema == 'incompatible' else 'TEXT'
            extra = ', slug TEXT' if schema == 'partial' else ''
            connection.execute(
                'CREATE TABLE people (id INTEGER PRIMARY KEY, name '
                + name_type + ' NOT NULL' + extra + ')'
            )
            for row in data['rows']:
                if schema == 'partial':
                    connection.execute('INSERT INTO people VALUES (?, ?, NULL)', row)
                else:
                    connection.execute('INSERT INTO people VALUES (?, ?)', row)
            connection.commit()
        output = sqlite_snapshot(connection)
    finally:
        connection.close()
else:
    sys.path.insert(0, os.path.dirname(setup['entry']))
    spec = importlib.util.spec_from_file_location('_coding_subject', setup['entry'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fn = getattr(module, setup['symbol'])
    if setup['id'] == 'easy-python-merge':
        records = data['records']
        before = copy.deepcopy(records)
        try:
            value = fn(records)
            output = {
                'value': value,
                'unchanged': records == before,
                'detached': not bool(containers(value) & containers(records)),
            }
        except BaseException:
            output = {'error': True}
    elif setup['id'] == 'hard-python-cache':
        calls = [0]

        def compute():
            calls[0] += 1
            if data['compute']['kind'] == 'raise':
                raise ValueError('fixture compute failure')
            if data['compute']['kind'] == 'invalid':
                return {object()}
            return data['compute']['value']
        try:
            if data['compute'].get('replaceFailure'):
                with mock.patch('os.replace', side_effect=OSError('fixture replacement failure')):
                    value = fn(data['path'], data['now'], data['ttl'], compute)
            else:
                value = fn(data['path'], data['now'], data['ttl'], compute)
            output = {'state': 'resolved', 'value': value, 'calls': calls[0]}
        except BaseException:
            output = {'state': 'rejected', 'calls': calls[0]}
    elif setup['id'] == 'hard-python-sqlite':
        connection = sqlite3.connect(data['database'])
        try:
            if data.get('denyCommit'):
                connection.set_authorizer(
                    lambda action, first, *_: (
                        sqlite3.SQLITE_DENY
                        if action == sqlite3.SQLITE_TRANSACTION and first == 'COMMIT'
                        else sqlite3.SQLITE_OK
                    )
                )
            try:
                fn(connection)
                output = {'state': 'resolved'}
                if data.get('repeat'):
                    try:
                        fn(connection)
                        output['secondState'] = 'resolved'
                    except BaseException:
                        output['secondState'] = 'rejected'
            except BaseException:
                output = {'state': 'rejected'}
            output['inTransaction'] = connection.in_transaction
        finally:
            connection.close()
    else:
        output = {'bridgeError': True}
print(json.dumps(output, allow_nan=False))

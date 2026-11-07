# Original MIT benchmark fixture; the generated README states the contract.
import re

def BENCH_FN(connection):
    """Implement the generated README contract."""
    columns = connection.execute('PRAGMA table_info(people)').fetchall()
    basic = [(row[1], row[2].upper(), row[3], row[5]) for row in columns]
    expected = [('id', 'INTEGER', 0, 1), ('name', 'TEXT', 1, 0)]
    if basic == expected + [('slug', 'TEXT', 1, 0)]:
        unique = any(
            row[2] and not row[4] and [
                part[2] for part in connection.execute(
                    'PRAGMA index_info("' + row[1].replace('"', '""') + '")'
                )
            ] == ['slug']
            for row in connection.execute('PRAGMA index_list(people)')
        )
        if unique:
            return
    if basic != expected:
        raise ValueError('incompatible schema')
    lower = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
    try:
        connection.execute('BEGIN IMMEDIATE')
        rows = connection.execute('SELECT id, name FROM people ORDER BY id').fetchall()
        connection.execute(
            'CREATE TABLE people_coding_new '
            '(id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE)'
        )
        used = set()
        for identity, name in rows:
            base = re.sub('[^a-z0-9]+', '-', name.translate(lower)).strip('-') or 'person'
            slug, suffix = (base, 2)
            while slug in used:
                slug = base + '-' + str(suffix)
                suffix += 1
            used.add(slug)
            connection.execute(
                'INSERT INTO people_coding_new VALUES (?, ?, ?)', (identity, name, slug)
            )
        connection.execute('DROP TABLE people')
        connection.execute('ALTER TABLE people_coding_new RENAME TO people')
        connection.commit()
    except BaseException:
        connection.rollback()
        raise

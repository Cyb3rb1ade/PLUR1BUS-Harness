"""Materialize the pinned public inputs, with all passage text outside Git."""
import argparse
import hashlib
import json
import pathlib
import tarfile
from collections import defaultdict

import pyarrow.ipc as ipc
import pyarrow.parquet as pq

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=pathlib.Path, help="scratch directory with the pinned payloads")
root = parser.parse_args().directory
manifest = pathlib.Path(__file__).with_name("manifest.json")
for source in json.loads(manifest.read_text(encoding="utf-8"))["sources"]:
    name = source["localName"]
    with (root / name).open("rb") as payload:
        if hashlib.file_digest(payload, "sha256").hexdigest() != source["sha256"]:
            raise ValueError(f"Checksum mismatch for {name}")


def arrow(name):
    return ipc.open_stream(root / name).read_all().to_pylist()


def write(name, cards, queries):
    payload = {"cards": cards, "queries": queries}
    with (root / f"{name}.json").open("w", encoding="utf-8") as output:
        json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
    print(name, len(cards), len(queries))


german = [
    {"id": str(row["_id"]), "text": row["text"], "summary": ""}
    for row in arrow("de-corpus.arrow")
]
targets = defaultdict(list)
for row in arrow("de-qrels.arrow"):
    if row["score"] > 0:
        targets[str(row["query-id"])].append(str(row["corpus-id"]))
german_queries = [
    {"id": str(row["_id"]), "text": row["text"], "expected": targets[str(row["_id"])]}
    for row in arrow("de-queries.arrow")
    if targets[str(row["_id"])]
]
distractors = []
for batch in pq.ParquetFile(root / "de-distractors.parquet").iter_batches(
    batch_size=1000, columns=["text"]
):
    for row in batch.to_pylist():
        if len(distractors) == 5000:
            break
        if row["text"] and row["text"].strip():
            distractors.append({
                "id": f"distractor:{len(distractors)}",
                "text": row["text"][:6144],
                "summary": "",
            })
    if len(distractors) == 5000:
        break
assert len(distractors) == 5000
write("de-with-distractors", german + distractors, german_queries)
write("de", german, german_queries)

english = []
english_queries = []
with tarfile.open(root / "qasper-test.tgz") as archive:
    with archive.extractfile("qasper-test-v0.3.json") as payload:
        papers = json.load(payload)
for paper_id, paper in sorted(papers.items()):
    passages = [paper["abstract"]] + [
        paragraph for section in paper["full_text"] for paragraph in section["paragraphs"]
    ]
    ids_by_text = defaultdict(list)
    for index, text in enumerate(passages):
        if text and text.strip():
            record_id = f"{paper_id}:{index}"
            english.append({"id": record_id, "text": text, "summary": paper["title"]})
            ids_by_text[" ".join(text.split())].append(record_id)
    for qa in paper["qas"]:
        expected = sorted({
            record
            for answer in qa["answers"]
            for passage in answer["answer"]["evidence"]
            for record in ids_by_text[" ".join(passage.split())]
        })
        if expected:
            english_queries.append({"id": qa["question_id"], "text": qa["question"], "expected": expected})
write("en-qasper", english, english_queries)

# Controlled compounds have explicit constituent boundaries. Controls store
# the same constituents as separate words and use an independent prefix set.
prefixes = (
    "Winter Sommer Stadt Berg Tal Wald Garten Dorf Hafen Bahnhof Flughafen "
    "Klinik Schule Werkstatt Fahrzeug Fahrrad Museum Park Kanal Stadion"
).split()
suffixes = (
    "Fahrplan Karte Schlüssel Eingang Liste Prüfung Lampe Öffnung Nummer Tür"
).split()
compound_cards, compound_queries, separated_cards, separated_queries = [], [], [], []
for first in prefixes:
    for second in suffixes:
        identifier = f"{first}-{second}"
        compound_cards.append({
            "id": identifier,
            "text": f"Info zur Anlage: {first}{second.lower()}.",
            "summary": "",
        })
        compound_queries.append({
            "id": identifier,
            "text": f"{first} {second}",
            "expected": [identifier],
            "split": [first, second.lower()],
        })
        separated_cards.append({
            "id": identifier,
            "text": f"Info zur Anlage: {first} {second}.",
            "summary": "",
        })
        separated_queries.append(compound_queries[-1])
write("de-compounds", compound_cards, compound_queries)
write("de-separated", separated_cards, separated_queries)

identifier_cards, identifier_queries = [], []
for index in range(10):
    for token in [
        f"00000000-0000-4000-8000-000000{index:06d}",
        f"fixtures/data/scan_{index:02d}.toml",
        f"v3.21.{index}",
        f"source-{index}@fixture.invalid",
        f"--calibrate-slot-{index}",
        f"FIXTURE_SLOT_{index:02d}_ID",
    ]:
        identifier_cards.append({
            "id": token,
            "text": f"Reference for the synthetic artifact {token}.",
            "summary": "",
        })
        identifier_queries.append({"id": token, "text": token, "expected": [token]})
write("identifiers", identifier_cards, identifier_queries)

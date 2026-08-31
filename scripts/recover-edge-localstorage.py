import json
import pathlib
import sys

from ccl_chromium_reader import ccl_chromium_localstorage


def main() -> None:
    source = pathlib.Path(sys.argv[1]).resolve()
    output = pathlib.Path(sys.argv[2]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = []
    with ccl_chromium_localstorage.LocalStoreDb(source) as local_storage:
        for record in local_storage.iter_all_records(include_deletions=True):
            if record.script_key != "easynote-data-v1" or "localhost:4173" not in record.storage_key:
                continue
            batch = local_storage.find_batch(record.leveldb_seq_number)
            item = {
                "sequence": record.leveldb_seq_number,
                "storageKey": record.storage_key,
                "isValueRecord": record.is_live,
                "sourceFile": record.file,
                "batchTimestamp": batch.timestamp.isoformat() if batch else None,
                "valueLength": len(record.value) if record.value is not None else 0,
            }
            if record.value:
                candidate_path = output / f"easynote-data-v1-seq-{record.leveldb_seq_number}.json"
                candidate_path.write_text(record.value, encoding="utf-8")
                item["candidatePath"] = str(candidate_path)
                try:
                    state = json.loads(record.value)
                    notes = state.get("notes", []) if isinstance(state, dict) else []
                    item["validJson"] = True
                    item["noteCount"] = len(notes) if isinstance(notes, list) else 0
                    item["latestNoteUpdate"] = max(
                        (str(note.get("updatedAt", "")) for note in notes if isinstance(note, dict)),
                        default="",
                    )
                except (TypeError, json.JSONDecodeError) as error:
                    item["validJson"] = False
                    item["error"] = str(error)
            results.append(item)
    summary_path = output / "localstorage-candidates.json"
    summary_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summaryPath": str(summary_path), "candidates": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

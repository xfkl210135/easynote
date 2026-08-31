import datetime
import json
import pathlib
import sys

from ccl_chromium_reader import ccl_chromium_indexeddb


def json_default(value):
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, bytes):
        return {"__bytesHex": value.hex()}
    return str(value)


def summarize_state(value):
    if not isinstance(value, dict):
        return {"isState": False}
    notes = value.get("notes", [])
    if not isinstance(notes, list):
        notes = []
    return {
        "isState": True,
        "noteCount": len(notes),
        "latestNoteUpdate": max(
            (str(note.get("updatedAt", "")) for note in notes if isinstance(note, dict)),
            default="",
        ),
        "taskCount": len(value.get("tasks", [])) if isinstance(value.get("tasks"), list) else 0,
        "scheduleCount": len(value.get("scheduleEntries", [])) if isinstance(value.get("scheduleEntries"), list) else 0,
    }


def main():
    leveldb_path = pathlib.Path(sys.argv[1]).resolve()
    blob_path = pathlib.Path(sys.argv[2]).resolve()
    output_dir = pathlib.Path(sys.argv[3]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    wrapper = ccl_chromium_indexeddb.WrappedIndexDB(leveldb_path, blob_path)
    database = wrapper["easynote-db"]
    report = {"database": database.name, "origin": database.origin, "stores": {}}

    for store_name in ("app-state", "notes", "history", "recovery"):
        store = database[store_name]
        records = []
        for record in store.iterate_records(errors_to_stdout=True):
            entry = {
                "key": record.key.value,
                "sequence": record.ldb_seq_no,
                "isValueRecord": record.is_live,
                "sourceFile": str(record.origin_file),
                "value": record.value,
            }
            if store_name == "app-state":
                entry.update(summarize_state(record.value))
            elif store_name == "notes" and isinstance(record.value, dict):
                entry.update({
                    "noteId": record.value.get("id"),
                    "title": record.value.get("title"),
                    "updatedAt": record.value.get("updatedAt"),
                    "contentLength": len(str(record.value.get("content", ""))),
                })
            elif store_name == "recovery" and isinstance(record.value, dict):
                entry.update(summarize_state(record.value.get("payload")))
                entry["createdAt"] = record.value.get("createdAt")
                entry["label"] = record.value.get("label")
            records.append(entry)
        report["stores"][store_name] = records

    report_path = output_dir / "indexeddb-forensic-records.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=json_default), encoding="utf-8")
    summary = {
        "reportPath": str(report_path),
        "appStateCandidates": [
            {key: item.get(key) for key in ("key", "sequence", "isValueRecord", "noteCount", "latestNoteUpdate", "taskCount", "scheduleCount", "sourceFile")}
            for item in report["stores"]["app-state"]
        ],
        "noteValueRecords": sum(1 for item in report["stores"]["notes"] if item["value"] is not None),
        "uniqueNoteIds": len({item.get("noteId") for item in report["stores"]["notes"] if item.get("noteId")}),
        "noteSequences": [
            {key: item.get(key) for key in ("noteId", "title", "updatedAt", "sequence", "isValueRecord", "contentLength")}
            for item in report["stores"]["notes"]
            if item["value"] is not None
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=json_default))


if __name__ == "__main__":
    main()

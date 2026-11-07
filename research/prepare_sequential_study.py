"""Research-only audit/split/chunk plans. Standard library; no network or AI calls.

Never writes source transcripts, annotations, application files or existing split.
Proposed topic groups are analyst judgements from unlabelled text, not certified
duplicate families. Freeze them after independent review BEFORE model tuning.
"""
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
import re
import unicodedata

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "research" / "sequential-study"
SEED = "cqa-sequential-group-split-v1|2026-11-07"


def read_jsonl(path):
    blob = path.read_bytes()
    return [json.loads(x) for x in blob.decode("utf-8-sig").splitlines() if x.strip()], blob


def write_json(name, value):
    OUT.mkdir(exist_ok=True)
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def ids(lang, values):
    return [f"p1-{lang}-{n:03}" for n in values]


def topic_groups():
    # Deliberately coarse connected topic/template families; do not split by language.
    specs = [
        ("pricing-and-broker-reports", [1, 2, 3, 11, 27, 30], [1, 6], [3, 4], []),
        ("funding-details-fees", [4, 5, 26], [2], [5], []),
        ("deposit-missing", [6], [3], [6], []),
        ("profile-change-withdrawal", [7, 8, 9, 28], [4, 5, 15], [7, 14], []),
        ("portfolio-missing", [10], [], [], []),
        ("tax-form-language", [12], [14], [11], []),
        ("company-reports", [13], [], [12], []),
        ("web-signin", [14, 16, 29], [8], [2, 15], []),
        ("registration-reused-login", [15], [7], [1], [5]),
        ("bonds-app-investment-advice", [17, 22, 23], [13], [13], [1]),
        ("order-rejection-status", [18], [12], [], [2, 3, 4]),
        ("security-search", [19], [9], [8], []),
        ("margin-option", [20], [10], [9], []),
        ("exchange-names", [21], [], [], []),
        ("d-vs-trading-account", [24], [11], [10], []),
        ("operator-request", [25], [], [], []),
    ]
    return [{"group_id": name, "conversation_ids": sorted(
        ids("ru", ru) + ids("kz", kz) + ids("en", en) + [f"p4-ru-{n:03}" for n in voice]
    )} for name, ru, kz, en, voice in specs]


def make_split(records, groups):
    by_id = {r["conversation_id"]: r for r in records}
    grouped = [x for g in groups for x in g["conversation_ids"]]
    assert len(grouped) == len(set(grouped)) == len(records) == 65
    assert set(grouped) == set(by_id)
    target = math.floor(len(records) * 0.30)
    all_lang = Counter(r["language"] for r in records)
    candidates = []
    for mask in range(1, (1 << len(groups)) - 1):
        selected = [g for i, g in enumerate(groups) if mask & (1 << i)]
        if len(selected) < 6 or len(groups) - len(selected) < 6:
            continue
        n = sum(len(g["conversation_ids"]) for g in selected)
        if n != target:
            continue
        test_ids = sorted(x for g in selected for x in g["conversation_ids"])
        lang = Counter(by_id[x]["language"] for x in test_ids)
        calls = sum(by_id[x]["channel"] == "voice call" for x in test_ids)
        if len(lang) != 3 or calls not in (1, 2):
            continue
        # Integer equivalents of distance from 30% language/channel proportions.
        objective = (sum(abs(10 * lang[k] - 3 * v) for k, v in all_lang.items()),
                     abs(10 * calls - 3 * 5),
                     sha256((SEED + "|" + "|".join(g["group_id"] for g in selected)).encode()).hexdigest())
        candidates.append((objective, test_ids, [g["group_id"] for g in selected]))
    assert candidates
    _, test_ids, test_groups = min(candidates)
    train_ids = sorted(set(by_id) - set(test_ids))
    def profile(identifiers):
        return {"count": len(identifiers), "language": dict(Counter(by_id[x]["language"] for x in identifiers)),
                "channel": dict(Counter(by_id[x]["channel"] for x in identifiers))}
    return {"status": "proposed_requires_independent_family_review_before_freeze", "seed": SEED,
            "method": "Exhaustive whole-group subset selection, floor(0.30*N)=19; at least 6 families in each partition; metadata balance then SHA256 tie-break; NO scores/features used",
            "limitations": ["Topic groups are conservative proposals, not certified near-duplicate equivalence classes.",
                            "DEV texts and provisional AI labels were already inspected; this is an internal fixed test, not an unseen official control set.",
                            "Old pilot20/holdout10 manifest is unchanged and must not be pooled with this experiment.",
                            "Independent review may merge groups before freeze; regenerate and version if so. Never repartition in response to performance."],
            "test_group_ids": test_groups, "train_ids": train_ids, "test_ids": test_ids,
            "train_profile": profile(train_ids), "test_profile": profile(test_ids),
            "transcript_hashes": {x: by_id[x]["transcript_hash"] for x in sorted(by_id)}}


def exchange_atoms(messages):
    """New atom when a client turn follows an operator; all messages retained."""
    atoms, current, operator_seen = [], [], False
    for index, message in enumerate(messages):
        if message["speaker"] == "client" and operator_seen and current:
            atoms.append(current)
            current, operator_seen = [], False
        current.append(index)
        operator_seen |= message["speaker"] == "operator"
    if current:
        atoms.append(current)
    return atoms


def chunks(messages, budget=12, overlap=2):
    packed, current = [], []
    for atom in exchange_atoms(messages):
        if current and len(current) + len(atom) > budget:
            packed.append(current)
            current = []
        current.extend(atom)
    if current:
        packed.append(current)
    result = []
    for index, core in enumerate(packed):
        context = list(range(max(0, core[0] - overlap), core[0]))
        result.append({"chunk_id": f"c{index+1:03}",
                       "core_message_ids": [messages[i]["message_id"] for i in core],
                       "context_message_ids": [messages[i]["message_id"] for i in context],
                       "oversized_exchange": len(core) > budget})
    assert [x for c in result for x in c["core_message_ids"]] == [m["message_id"] for m in messages]
    return result


def annotation_audit(records):
    path = ROOT / "data/annotations/dev65.ai-provisional.jsonl"
    annotations, blob = read_jsonl(path)
    lookup = {r["conversation_id"]: r for r in records}
    cells = [c for r in annotations for c in r["criteria"]]
    summary = json.loads((path.parent / "dev65.annotation-summary.json").read_text(encoding="utf-8-sig"))
    return {"captured_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": str(path.relative_to(ROOT)), "sha256": sha256(blob).hexdigest(),
            "concurrent_updates_possible": True, "row_count": len(annotations),
            "unique_ids": len({r["conversation_id"] for r in annotations}),
            "status_counts": dict(Counter(r.get("annotation_status", "missing") for r in annotations)),
            "source_counts": dict(Counter(r.get("annotation_source", "missing") for r in annotations)),
            "language": dict(Counter(r["language"] for r in annotations)),
            "channel": dict(Counter(r["channel"] for r in annotations)),
            "non_null_criterion_values": sum(c.get("value") is not None for c in cells),
            "null_criterion_values": sum(c.get("value") is None for c in cells),
            "needs_review_cells": sum(c.get("needs_review") is True for c in cells),
            "non_null_totals": sum(r.get("total_score") is not None for r in annotations),
            "evidence_entries": sum(len(c.get("evidence", [])) for c in cells),
            "evidence_field_sets": sorted({tuple(sorted(e)) for c in cells for e in c.get("evidence", [])}),
            "rows_explicitly_human_verified": sum(r.get("human_verified") is True for r in annotations),
            "rows_missing_human_verified_field": sum("human_verified" not in r for r in annotations),
            "summary_declares_human_verified": summary.get("human_verified"),
            "summary_processed_count_at_separate_read": summary.get("processed_count"),
            "transcript_hash_mismatches": [r["conversation_id"] for r in annotations
                if r["conversation_id"] not in lookup or r.get("transcript_hash") != lookup[r["conversation_id"]]["transcript_hash"]],
            "data_chat_directory_present": (ROOT / "data_chat").exists() or (ROOT / "data/data_chat").exists(),
            "gold_reference_available": False,
            "conclusion": "AI provisional dialogue labels/evidence only; not human GT, not exhaustive event/span labels; missing human_verified is not itself proof of false."}


def duplicate_audit(records, split):
    """Deterministic checks only; no learned representation fit on full dataset."""
    def signature(record, template=False):
        parts = []
        for m in record["messages"]:
            if m["speaker"] not in ("client", "operator"):
                continue
            normalized = " ".join(unicodedata.normalize("NFKC", m["text"]).casefold().split())
            if template:
                normalized = re.sub(r"\d+", "<NUMBER>", normalized)
            parts.append(m["speaker"] + ":" + normalized)
        return sha256("\n".join(parts).encode("utf-8")).hexdigest()
    result = {"method": "Source transcript hashes; exact normalized human-role text; same text with digit runs replaced. No fitted features/embeddings used.",
              "limitations": "These checks do not detect all paraphrases/translations or certify proposed semantic groups."}
    test = set(split["test_ids"])
    for mode in ("raw_transcript_hash", "normalized_human_text", "digit_template_human_text"):
        groups = {}
        for r in records:
            key = r["transcript_hash"] if mode == "raw_transcript_hash" else signature(r, mode == "digit_template_human_text")
            groups.setdefault(key, []).append(r["conversation_id"])
        duplicates = [v for v in groups.values() if len(v) > 1]
        result[mode] = {"duplicate_groups": duplicates,
            "cross_partition_duplicate_groups": [v for v in duplicates if set(v) & test and set(v) - test]}
    return result


def main():
    records, blob = read_jsonl(ROOT / "data/dev/indexed-transcripts.jsonl")
    groups = topic_groups()
    split = make_split(records, groups)
    write_json("topic-groups.proposed.json", {"status": "analyst_proposed_not_certified_duplicates", "groups": groups})
    write_json("split-70-30.proposed.json", split)
    write_json("duplicate-audit.json", duplicate_audit(records, split))
    write_json("annotation-audit.json", annotation_audit(records))
    plans, stats = {}, {}
    for budget in (8, 12, 20):
        by_id = {r["conversation_id"]: chunks(r["messages"], budget) for r in records}
        plans[str(budget)] = by_id
        stats[str(budget)] = {"all_chunks": sum(map(len, by_id.values())),
            "train_chunks": sum(len(by_id[x]) for x in split["train_ids"]),
            "test_chunks": sum(len(by_id[x]) for x in split["test_ids"]),
            "oversized_exchanges": sum(c["oversized_exchange"] for cs in by_id.values() for c in cs),
            "changed_from_12_test_dialogues": None}
    for budget in (8, 12, 20):
        stats[str(budget)]["changed_from_12_test_dialogues"] = sum(
            [c["core_message_ids"] for c in plans[str(budget)][x]] != [c["core_message_ids"] for c in plans["12"][x]] for x in split["test_ids"])
    write_json("fragment-manifest.json", {"algorithm": "complete exchanges, soft message budget, previous 2 source messages as read-only overlap", "plans": plans})
    write_json("mechanical-summary.json", {"source_sha256": sha256(blob).hexdigest(), "records": len(records),
        "messages": sum(len(r["messages"]) for r in records), "proposed_groups": len(groups),
        "train_profile": split["train_profile"], "test_profile": split["test_profile"], "chunk_plans": stats,
        "no_model_inference_or_training": True, "no_paid_calls": True})
    k, n = stats["12"]["test_chunks"], len(split["test_ids"])
    # Token counts below are assumptions, not observed tokenizer/provider usage.
    cost = {"status": "planning_estimate_NOT_measured", "currency": "USD", "prices_checked_on": "2026-11-07",
        "assumptions": {"C0_astra_input": 6000, "C0_astra_output_including_reasoning": 6000,
            "final_astra_input": 8000, "final_astra_output_including_reasoning": 6000,
            "chunk_sol_input": 3000, "chunk_sol_output_including_reasoning": 3000,
            "astra_usd_per_M_input_output": [10, 50], "sol_usd_per_M_input_output": [2, 10],
            "excludes": ["embedding usage", "retries", "additional reviewers", "tax", "cache/batch discounts"],
            "fixed_input_counts_not_a_cap": True},
        "n_test_dialogues": n, "k_test_chunks_budget12": k,
        "C0_calls": n, "C0_usd": round(n * .36, 4),
        "L_seq_calls": k + n, "L_seq_usd": round(n * .38 + k * .036, 4),
        "H_formula_calls": "n + s verified chunks (0<=s<=k) + embedding HTTP requests if used",
        "H_formula_usd": "0.38*n + 0.036*s + embedding tokens*rate/1e6; s unknown until classifier run",
        "H_visible_additional_calls_reusing_H_hidden_ledger": n,
        "H_visible_additional_usd": round(n * .38, 4),
        "all_test_boundary_L_seq_calls": sum(stats[str(b)]["test_chunks"] + n for b in (8, 12, 20)),
        "all_test_boundary_L_seq_usd": round(sum(n * .38 + stats[str(b)]["test_chunks"] * .036 for b in (8, 12, 20)), 4)}
    write_json("cost-plan.json", cost)
    with (OUT / "event-annotation.blank.jsonl").open("w", encoding="utf-8") as f:
        for r in records:
            for c in plans["12"][r["conversation_id"]]:
                row = {"conversation_id": r["conversation_id"], "transcript_hash": r["transcript_hash"],
                    "partition": "test" if r["conversation_id"] in split["test_ids"] else "train",
                    "chunk_id": c["chunk_id"], "core_message_ids": c["core_message_ids"],
                    "context_message_ids": c["context_message_ids"], "annotation_status": "blank",
                    "reviewed_event_types": [], "events": None, "annotator_id": None,
                    "note": "null is unlabelled; [] means no event only for explicitly reviewed types and range"}
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(json.dumps({"mechanical": json.loads((OUT / "mechanical-summary.json").read_text(encoding="utf-8")),
                      "annotation_audit": json.loads((OUT / "annotation-audit.json").read_text(encoding="utf-8")),
                      "cost": cost}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

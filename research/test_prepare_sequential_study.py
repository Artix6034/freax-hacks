"""Mechanics only. Synthetic examples are not CQA accuracy observations."""
import json
from pathlib import Path
import unittest
from prepare_sequential_study import chunks, exchange_atoms, make_split, topic_groups, read_jsonl, ROOT, OUT


def messages(roles):
    return [{"message_id": f"m{i+1:04}", "speaker": role, "timestamp": f"00:{i:02}", "text": "synthetic"}
            for i, role in enumerate(roles)]


class Mechanics(unittest.TestCase):
    def test_bot_prefix_is_preserved(self):
        ms = messages(["bot", "system", "client", "operator", "client", "operator"])
        self.assertEqual(exchange_atoms(ms), [[0, 1, 2, 3], [4, 5]])

    def test_client_tail_after_close_is_not_discarded(self):
        ms = messages(["client", "operator", "system", "client"])
        result = chunks(ms, 2)
        self.assertEqual(result[-1]["core_message_ids"], ["m0004"])
        self.assertEqual(result[-1]["context_message_ids"], ["m0002", "m0003"])

    def test_messages_before_operator_remain_together(self):
        ms = messages(["client", "client", "bot", "operator", "operator", "client"])
        self.assertEqual(exchange_atoms(ms), [[0, 1, 2, 3, 4], [5]])

    def test_oversized_exchange_is_explicit(self):
        ms = messages(["client", "operator", "operator", "operator"])
        result = chunks(ms, 2)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["oversized_exchange"])
        self.assertEqual(len(result[0]["core_message_ids"]), 4)

    def test_core_and_context_are_disjoint(self):
        ms = messages(["client", "operator"] * 6)
        for c in chunks(ms, 4):
            self.assertFalse(set(c["core_message_ids"]) & set(c["context_message_ids"]))

    def test_all_dev_messages_once_per_plan(self):
        records, _ = read_jsonl(ROOT / "data/dev/indexed-transcripts.jsonl")
        for r in records:
            for budget in (8, 12, 20):
                expected = [m["message_id"] for m in r["messages"]]
                actual = [x for c in chunks(r["messages"], budget) for x in c["core_message_ids"]]
                self.assertEqual(actual, expected)

    def test_proposed_split_whole_groups_and_reproducible(self):
        records, _ = read_jsonl(ROOT / "data/dev/indexed-transcripts.jsonl")
        result = make_split(records, topic_groups())
        saved = json.loads((OUT / "split-70-30.proposed.json").read_text(encoding="utf-8"))
        self.assertEqual(result, saved)
        train, test = set(result["train_ids"]), set(result["test_ids"])
        self.assertEqual((len(train), len(test)), (46, 19))
        self.assertFalse(train & test)
        for g in topic_groups():
            self.assertTrue(set(g["conversation_ids"]) <= train or set(g["conversation_ids"]) <= test)

    def test_blank_annotation_is_not_negative(self):
        records, _ = read_jsonl(OUT / "event-annotation.blank.jsonl")
        self.assertEqual(len(records), 138)
        for r in records:
            self.assertIsNone(r["events"])
            self.assertEqual(r["reviewed_event_types"], [])
            self.assertEqual(r["annotation_status"], "blank")

    def test_contract_distinguishes_pending_na_and_four_checks(self):
        doc = json.loads((OUT / "state-evidence-contract.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["criterion_state"]["status_enum"], ["pending", "provisional", "final"])
        self.assertEqual(len(doc["Evidence_fields"]["event_kind_enum"]), 4)
        self.assertIn("quote_exists", doc["Evidence_fields"]["verification"])
        self.assertIn("factual_truth_status", doc["Evidence_fields"]["verification"])


if __name__ == "__main__":
    unittest.main()

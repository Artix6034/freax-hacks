"""Write research manifests and planning costs only; never call inference or train.

Reuses reviewed source metadata and the proposed group split, not target labels.
The accompanying report distinguishes published results from design judgements.
"""
from pathlib import Path
from decimal import Decimal
from datetime import datetime, timezone
from hashlib import sha256
import json
import re
from prepare_sequential_study import annotation_audit, read_jsonl, ROOT

OUT = ROOT / "research/model-selection"


def write(name, data):
    OUT.mkdir(exist_ok=True)
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    records, _ = read_jsonl(ROOT / "data/dev/indexed-transcripts.jsonl")
    audit = annotation_audit(records)
    forms = []
    for path in sorted((ROOT / "research").glob("*expert-*.blank.jsonl")):
        rows, _ = read_jsonl(path)
        forms.append({"path": str(path.relative_to(ROOT)), "records": len(rows),
                      "non_null_values": sum(c.get("value") is not None for r in rows for c in r.get("criteria", []))})
    audit["expert_forms_checked"] = forms
    audit["audit_scope"] = "data/annotations plus named expert forms; artificial metric fixtures excluded from DEV references"
    write("annotation-audit.json", audit)
    prior = json.loads((ROOT / "research/sequential-study/model-shortlist.json").read_text(encoding="utf-8"))
    candidates = prior["generation_models"]
    primary = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "claude-fable-5-1",
               "Unbabel/M-Prometheus-7B", "jev-1.14.0"]
    for m in candidates:
        m["object_type"] = "general_generative_LLM"
        m["experiment_role"] = {"gpt-6-astra": "expensive final/control candidate, not measured best",
            "gpt-6.1-sol": "balanced final baseline / extraction control", "gpt-6-luna": "cheap fragment analyzer",
            "claude-fable-5-1": "different-family final candidate", "gemini-4-argon": "reserve third family"}[m["api_model_id"]]
        m["KZ_CQA_result"] = None
    specialist_rows = [
        ("prometheus-eval/prometheus-7b-v2.0", "generative_judge", "absolute_and_pairwise", "English", "reserve", 4096, .40, .80),
        ("Unbabel/M-Prometheus-7B", "generative_judge", "absolute_and_pairwise", "multilingual_with_RU_evidence_KZ_unverified", "primary_specialist", 32768, .68, .80),
        ("AtlaAI/Selene-1-Mini-Llama-3.1-8B", "generative_judge", "absolute_classification_pairwise", "primarily_English_RU_KZ_unverified", "reserve_specialist", 32768, .20, .32),
        ("flowaicom/Flow-Judge-v0.1", "generative_judge", "binary_3point_5point", "English_SFT_RU_KZ_unverified", "excluded_first_multilingual_matrix", 4096, None, None),
        ("Skywork/Skywork-Critic-Llama-3.1-8B", "generative_critic", "primarily_pairwise_pointwise_demo_exists", "RU_KZ_unverified", "excluded_first_absolute_matrix", 32768, .20, .32),
        ("WeOpenML/PandaLM-7B-v1", "generative_judge", "pairwise_A_B_tie", "RU_KZ_unverified", "historical_pairwise_not_final", None, None, None),
        ("BAAI/JudgeLM-7B-v1.0", "generative_judge", "primarily_pairwise_extended_single_multiturn", "RU_KZ_unverified", "reserve_no_verified_hosted_endpoint", None, None, None),
        ("Skywork/Skywork-Reward-Llama-3.1-8B-v0.2", "scalar_reward_model", "sequence_classification_scalar", "RU_KZ_unverified", "not_standalone_rubric_judge", None, None, None),
        ("PatronusAI/glider", "generative_judge", "evaluation_explanation", "RU_KZ_CQA_unverified", "former_native_API_retired_external_endpoint_unverified", None, None, None),
    ]
    for ident, kind, task, lang, role, ctx, inp, output in specialist_rows:
        m = {"api_or_weights_id": ident, "object_type": kind, "native_task": task,
             "language_evidence": lang, "experiment_role": role, "KZ_CQA_result": None,
             "account_access_tested": False, "source_urls": ["https://huggingface.co/" + ident],
             "hosted_runtime_context_tokens": ctx,
             "usd_per_million_input_output": None if inp is None else [inp, output],
             "not_final_selection": True}
        if ctx is not None:
            m["catalog_provider"] = "Featherless"
            m["catalog_url"] = "https://featherless.ai/models/" + ident
            m["deployment_quantization"] = "BF16" if ident.startswith("flowaicom") else "FP8"
            m["catalog_does_not_prove_live_access_or_latency"] = True
        candidates.append(m)
    for ident in ("jev-1.14.0", "jev-1.13.0"):
        candidates.append({"api_model_id": ident, "provider": "TypeSafe AI", "object_type": "typed_decision_model",
            "experiment_role": "primary_typed_challenger" if ident == "jev-1.14.0" else "train_version_ablation",
            "endpoint": "https://api.typesafe.ai/v1/systemone", "context_tokens_request_question": [64000, 32000],
            "long_context_experiment_enabled": False, "usd_per_million_input": .042, "output_free": True,
            "generates_explanation_or_quotes": False, "primary_primitive": "choice",
            "score_expectation_must_not_be_used_as_official_discrete_value": True,
            "KZ_CQA_result": None, "account_access_tested": False,
            "source_urls": ["https://docs.typesafe.ai/models", "https://docs.typesafe.ai/changelog", "https://docs.typesafe.ai/primitives/choice", "https://docs.typesafe.ai/primitives/score"]})
    for ident, price in (("pplx-decider-v1.2", .02), ("pplx-decider-flash-v1.2", .01)):
        candidates.append({"api_model_id": ident, "provider": "Perplexity", "object_type": "typed_decision_model",
            "experiment_role": "reserve_not_mandatory_first_matrix", "endpoint": "https://api.perplexity.ai/v1/decisions",
            "context_tokens": 256000, "usd_per_million_input": price, "output_free": True,
            "generates_explanation_or_quotes": False, "state_billing": "once_per_question" if "flash" in ident else "once_per_group",
            "old_id_v1_1_routes_to_v1_2": True, "response_model_field_is_echo_not_resolved_version": True,
            "web_grounding_enabled_in_experiment": False, "KZ_CQA_result": None, "account_access_tested": False,
            "source_urls": ["https://docs.perplexity.ai/docs/decisions/quickstart"]})
    write("candidates.json", {"checked_on": "2026-11-07", "status": "proposed_candidates_not_CQA_rankings",
        "primary_shortlist": primary, "candidates": candidates, "encoders": prior["embedding_candidates"] + [
            {"model_id": "intfloat/multilingual-e5-small", "object_type": "text_encoder", "dimensions": 384, "max_tokens": 512, "role": "optional_CPU_frozen_features", "requires_event_labels_for_supervised_head": True},
            {"model_id": "BAAI/bge-m3", "object_type": "text_encoder", "dimensions": 1024, "max_tokens": 8192, "role": "optional_retrieval_features_not_final_judge", "requires_event_labels_for_supervised_head": True},
            {"model_id": "urchade/gliner_multi-v2.1", "object_type": "prompted_span_extractor", "role": "optional_CPU_local_evidence_candidates", "KZ_event_recall": None},
            {"model_id": "fastino/gliner2-base-v1", "object_type": "schema_extractor_classifier", "parameters_M": 205, "language": "English", "role": "diagnostic_not_verified_RU_KZ"}],
        "fixed_class_CPU_baselines": ["TF-IDF + LogisticRegression", "TF-IDF + LinearSVC", "frozen embedding + LogisticRegression", "small MLP ablation"],
        "JEPA_status": "training_architecture_or_method_not_interchangeable_hosted_judge"})
    evidence = [
        {"id": "B1", "model": "Prometheus-2-7B", "source": "https://arxiv.org/html/2405.01535v2", "date": "2024", "benchmark": "FLASK Table16", "sample_size": {"instructions": 200, "responses": 2000, "rubrics": 12}, "metric": "Pearson correlation", "result_reference_based": .545, "result_reference_free": .425, "reference_origin": "human", "confirms": "absolute rubric grading and reference sensitivity", "does_not_confirm": "exact criterion/NA/evidence/KZ CQA accuracy"},
        {"id": "B2", "model": "Unbabel/M-Prometheus-7B", "source": "https://arxiv.org/html/2504.04953v2", "date": "2025", "benchmark": "MM-Eval; M-RewardBench Table1", "sample_size": None, "sample_size_note": "exact aggregate item count not established in checked report section", "metric": "pairwise accuracy", "results": {"MM-Eval": .6966, "M-RewardBench": .7754}, "reference_origin": "native-speaker preference data versus translated benchmark preferences; not our CQA", "confirms": "multilingual pairwise assessment; not KZ CQA or evidence quality"},
        {"id": "B3", "model": "Atla Selene Mini", "source": "https://arxiv.org/html/2501.17195v1", "date": "2025-01-27", "benchmark": "FinanceBench expert evaluation Table2", "sample_size": None, "sample_size_note": "balanced subset N not stated; full dataset size must not be substituted", "metric": "judgment accuracy", "result": .717, "base_result": .664, "reference_origin": "human domain experts", "confirms": "domain prompted evaluation improves over base in this study; not RU/KZ CQA"},
        {"id": "B4", "model": "flowaicom/Flow-Judge-v0.1", "source": "https://huggingface.co/flowaicom/Flow-Judge-v0.1", "date": "2024-09", "benchmark": "released synthetic heldout sets", "sample_size": {"binary": 316, "likert_3": 300, "likert_5": 274}, "metric": "binary F1 / five-level Pearson", "results": {"binary_F1": .955, "likert_5_Pearson": .919}, "reference_origin": "synthetic dual-evaluation consensus, not independent human GT", "size_verification": "Hugging Face datasets-server /size metadata read 2026-11-07", "confirms": "synthetic rubric reproduction, not human CQA"},
        {"id": "B5", "model": "JudgeLM family", "source": "https://github.com/baaivision/JudgeLM", "date": "2023; ICLR2025", "benchmark": "JudgeLM GPT4-labelled corpus", "sample_size": {"train": 100000, "validation": 5000}, "metric": "teacher agreement", "result": "headline >90% in specific author setting, not assigned to every checkpoint", "reference_origin": "GPT-4", "confirms": "teacher distillation, not >90% human CQA accuracy"},
        {"id": "B6", "model": "WeOpenML/PandaLM-7B-v1", "source": "https://github.com/WeOpenML/PandaLM", "date": "2023; ICLR2024", "benchmark": "filtered human A/B/tie test", "sample_size": {"test": 999, "raters": 3}, "sample_size_note": "999 from published class-count sum 105+422+472, described as about1K", "metric": "pairwise classification evaluation", "result": None, "reference_origin": "human; disagreements filtered", "training_origin": "300K GPT3.5 synthetic", "confirms": "pairwise target, not arbitrary absolute rubric"},
        {"id": "B7", "model": "Jev (main alias unpinned; stability returned1.13.0), Decider1.1", "source": "https://arxiv.org/html/2609.29769v3", "date": "2026-10-13", "benchmark": "9panels from7benchmarks", "sample_size": {"units": 1021, "criterion_pairs": 5003}, "metric": "ordinal exact/QWK, binary accuracy, cascade gain", "result": "Jev-first flash fallback oracle cascade gain <=2.7 percentage points over best single", "reference_origin": "reused human ratings; ordinal panels English", "confirms": "error correlation limits cascade accuracy gains", "limitations": "not Jev1.14/Decider1.2; public-label and alias risks; no KZ evidence"},
        {"id": "B8", "model": "several 2025 multilingual LLMs; not current shortlist", "source": "https://aclanthology.org/2025.acl-long.701/", "date": "2025-07", "benchmark": "KazMMLU", "sample_size": {"total": 23000, "KZ": 10969, "RU": 12031}, "metric": "knowledge multiple-choice QA", "result": None, "reference_origin": "authentic educational materials manually checked by native speakers/educators", "confirms": "need language-specific evaluation; not CQA/evidence ranking"},
    ]
    write("benchmark-evidence.json", {"checked_on": "2026-11-07", "no_results_measured_by_this_research": True,
        "records": evidence, "missing_sample_size_policy": "null means unestablished, not zero; do not use headline as decisive superiority claim"})
    split_path = ROOT / "research/sequential-study/split-70-30.proposed.json"
    split = json.loads(split_path.read_text(encoding="utf-8"))
    plan = {"version": "cqa-model-selection-proposed-1", "date": "2026-11-07", "status": "design_only_no_model_calls",
        "split_path": str(split_path.relative_to(ROOT)), "split_sha256": sha256(split_path.read_bytes()).hexdigest(),
        "train_count": 46, "test_count": 19, "ratio_percent": [round(46 / 65 * 100, 2), round(19 / 65 * 100, 2)],
        "test_languages": split["test_profile"]["language"], "group_review_and_freeze_pending": True,
        "human_reference_labels_available": False, "prerequisites": ["independent family review before freeze", "human/adjudicated criteria labels and evidence review", "event spans for D claims", "configured access and explicit paid-call budget"],
        "primary_models": primary, "analyst_default_for_planned_comparison": "gpt-6-luna", "final_for_architecture_control": "gpt-6-astra",
        "selection_is_not_measured_superiority": True,
        "phases": ["train: generic final-model comparison with identical full original input", "train: generative specialist format/language gate; native percriterion mode matched in generic baseline if used", "train: typed judges with shared score-free evidence-first ledger and full original", "freeze settings/prompts/models/grouping/failures before test", "single preregistered A/B/C1/C2 test; D only with adequate event labels"],
        "test_systems": [
            {"id": "A_astra", "architecture": "single full original call", "model": "gpt-6-astra"},
            {"id": "A_sol", "architecture": "same single full original call", "model": "gpt-6.1-sol"},
            {"id": "A_fable", "architecture": "same single full original call, native transport", "model": "claude-fable-5-1"},
            {"id": "B", "architecture": "sequential Luna extraction, then full original plus ledger", "model": "gpt-6-astra"},
            {"id": "C1", "architecture": "same cached Luna ledger and full original as B, typed final judge", "model": "jev-1.14.0"},
            {"id": "C2", "architecture": "same cached Luna ledger and full original as B, generative specialist", "model": "Unbabel/M-Prometheus-7B", "requires_train_contract_language_gate": True},
            {"id": "D", "architecture": "CPU event detector, contextual verification, same Astra full original final", "status": "not_eligible_until_event_supervision"}],
        "reserves": ["AtlaAI/Selene-1-Mini-Llama-3.1-8B", "pplx-decider-v1.2", "gemini-4-argon"],
        "new_criterion_policy": "update rubric/schema/questions; unsupported fixed-class detector falls back to LLM; no invented NA or scale remapping",
        "primary_metrics": ["percriterion accuracy/macroF1/confusion", "false/missedNA", "08precision/recall", "totalMAE with paircount/completion", "quote existence vs expert sufficiency", "RU/KZ/EN", "all-stage costs and end-to-end latency"],
        "leakage_rules": ["no fragments/families cross train/test", "all fitted features/calibration/threshold tuning inside train group folds", "fewshot train only", "annotation explanations/evidence/target scores never model features", "null/unreviewed not negative", "AI provisional never human GT", "test not reused to select prompts/models/budgets"],
        "typed_model_rules": ["Choice selected enum, not interpolated Score expectation", "evidence/explanation provenance separate from typed label", "unknown/unresolved outside official criterion class", "full original final input even with candidates", "pin grouping and log version routing; echoed model ID not proof of immutable deployment"],
        "boundary_ablation": "preregister budgets8/12/20, same model and state policy; do not pick best on test",
        "limitations": ["DEV already inspected, not unseen official control", "7test families,4KZ,1voice", "specialist hosted FP8 not identical to published BF16", "no controlled CQA results yet"]}
    write("experiment-plan.json", plan)
    dec = Decimal
    n, k = dec(19), dec(33)
    costs = {"status": "illustrative_assumptions_NOT_measured_or_spending_cap", "currency": "USD",
        "assumptions": {"n_test": 19, "k_chunks": 33, "chunk_input_output_incl_reasoning": [3000, 3000], "final_input_output_incl_reasoning": [8000, 6000], "prices_checked_on": "2026-11-07", "excludes": ["extra evidence generation", "repairs/retries/fallback", "embeddings", "tax", "account/subscription overhead"], "no_cache_discount_assumed": True},
        "bundles": {
            "accuracy_priority_not_proven_maximum": {"analyzer": "gpt-6.1-sol", "final": "gpt-6-astra", "usd": float(k * dec('.036') + n * dec('.38')), "with_all19_blind_Fable_reviews_usd": float(k * dec('.036') + n * dec('.38') * 2)},
            "balance": {"analyzer": "gpt-6-luna", "final": "gpt-6.1-sol", "usd": float(k * dec('.0018') + n * dec('.076'))},
            "minimum_generative": {"analyzer": "gpt-6-luna", "final": "gpt-6-luna", "usd": float(k * dec('.0018') + n * dec('.0038'))},
            "exploratory_typed_Jev_excludes_extra_explanation": {"analyzer": "gpt-6-luna", "final": "jev-1.14.0", "usd": float(k * dec('.0018') + n * dec('.000336'))},
            "exploratory_typed_Decider_excludes_extra_explanation": {"analyzer": "gpt-6-luna", "final": "pplx-decider-v1.2", "usd": float(k * dec('.0018') + n * dec('.00016'))}},
        "specialist_final_per_call_estimates": {"M_Prometheus7B": .01024, "Selene_Mini": .00352},
        "specialist_call_count_caveat": "one full call assumed; native8criterion requests cost8x and require matched generic mode",
        "actual_inference_spend_usd": 0}
    write("bundles-and-costs.json", costs)
    report = (ROOT / "research/model-selection-research.txt").read_text(encoding="utf-8")
    urls = sorted({x.rstrip('.,)') for x in re.findall(r'https://[^\s;|]+', report)})
    sources = [{"id": f"S{i+1:03}", "url": url, "checked_on": "2026-11-07", "primary_source": True,
                "scope": "Paper/model card or first-party capability, deployment, API or price documentation; not our measured CQA result"} for i, url in enumerate(urls)]
    # Never call nonofficial Jev lookalike domains an official source.
    sources = [s for s in sources if "jevmodel.org" not in s["url"]]
    write("sources.json", {"checked_on": "2026-11-07", "sources": sources,
        "context7_library_ids": ["/websites/typesafe_ai", "/llmstxt/perplexity_ai_llms_txt", "/websites/featherless_ai", "/websites/developers_openai_api", "/urchade/gliner"],
        "dataset_metadata_urls": ["https://datasets-server.huggingface.co/size?dataset=flowaicom/" + x for x in ["Flow-Judge-v0.1-binary-heldout", "Flow-Judge-v0.1-3-likert-heldout", "Flow-Judge-v0.1-5-likert-heldout"]],
        "not_primary_Jev_domain": "jevmodel.org is explicitly unaffiliated; not used as official source",
        "JEV_term": "user confirmed TypeSafe Jev on2026-11-07"})
    print(json.dumps({"primary_models": len(primary), "candidate_records": len(candidates), "benchmark_records": len(evidence), "source_urls": len(sources), "human_labels_found": False, "no_AI_calls": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()

REVOKE ALL ON SCHEMA knowledge FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA knowledge FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA knowledge TO knowledge_api, knowledge_worker, knowledge_gc;
GRANT SELECT ON
  knowledge.kb_billing_receipts, knowledge.kb_builds, knowledge.kb_chunk_embeddings,
  knowledge.kb_chunk_sources, knowledge.kb_chunks, knowledge.kb_documents,
  knowledge.kb_evidence_items, knowledge.kb_evidence_manifests, knowledge.kb_index_profiles,
  knowledge.kb_metering_events, knowledge.kb_operations, knowledge.kb_quotas,
  knowledge.kb_reservations, knowledge.kb_source_units, knowledge.kb_spaces, knowledge.kb_versions
TO knowledge_api, knowledge_worker, knowledge_gc;
GRANT INSERT (owner_id, id, title), UPDATE (title, updated_at)
ON knowledge.kb_spaces TO knowledge_api;

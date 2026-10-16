CREATE SCHEMA "knowledge";
--> statement-breakpoint
CREATE TABLE "knowledge"."kb_billing_receipts" (
	"owner_id" text NOT NULL,
	"id" uuid NOT NULL,
	"settlement_key" text NOT NULL,
	"product" text DEFAULT 'knowledge_base' NOT NULL,
	"dimension" text NOT NULL,
	"tariff_revision" text NOT NULL,
	"settlement_snapshot" jsonb NOT NULL,
	"snapshot_hash" "bytea" NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"site_receipt_id" uuid,
	"confirmed_at" timestamp with time zone,
	"site_amounts" jsonb,
	"reconciled_at" timestamp with time zone,
	"next_reconcile_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_billing_receipts_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "kb_billing_receipts_settlement_unique" UNIQUE("owner_id","settlement_key"),
	CONSTRAINT "kb_billing_receipts_hash_check" CHECK (octet_length("knowledge"."kb_billing_receipts"."snapshot_hash") = 32),
	CONSTRAINT "kb_billing_receipts_product_check" CHECK ("knowledge"."kb_billing_receipts"."product" = 'knowledge_base'),
	CONSTRAINT "kb_billing_receipts_key_check" CHECK (char_length("knowledge"."kb_billing_receipts"."settlement_key") BETWEEN 1 AND 128 AND char_length("knowledge"."kb_billing_receipts"."tariff_revision") BETWEEN 1 AND 128),
	CONSTRAINT "kb_billing_receipts_status_check" CHECK ("knowledge"."kb_billing_receipts"."status" IN ('pending', 'reconciling', 'reserved', 'settled', 'released') AND "knowledge"."kb_billing_receipts"."dimension" IN ('storage', 'embedding')),
	CONSTRAINT "kb_billing_receipts_confirmation_check" CHECK (("knowledge"."kb_billing_receipts"."status" IN ('pending', 'reconciling') AND "knowledge"."kb_billing_receipts"."site_receipt_id" IS NULL AND "knowledge"."kb_billing_receipts"."confirmed_at" IS NULL AND "knowledge"."kb_billing_receipts"."site_amounts" IS NULL) OR ("knowledge"."kb_billing_receipts"."status" IN ('reserved', 'settled', 'released') AND "knowledge"."kb_billing_receipts"."site_receipt_id" IS NOT NULL AND "knowledge"."kb_billing_receipts"."confirmed_at" IS NOT NULL AND "knowledge"."kb_billing_receipts"."site_amounts" IS NOT NULL AND jsonb_typeof("knowledge"."kb_billing_receipts"."site_amounts") = 'object')),
	CONSTRAINT "kb_billing_receipts_schema_check" CHECK ("knowledge"."kb_billing_receipts"."schema_version" = 1 AND jsonb_typeof("knowledge"."kb_billing_receipts"."settlement_snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_billing_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_builds" (
	"owner_id" text NOT NULL,
	"id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"retry_count" integer NOT NULL,
	"expected_generation" bigint NOT NULL,
	"index_profile_id" uuid NOT NULL,
	"parser_revision" text NOT NULL,
	"parser_snapshot" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"manifest" jsonb,
	"manifest_hash" "bytea",
	"source_unit_count" bigint DEFAULT 0 NOT NULL,
	"chunk_count" bigint DEFAULT 0 NOT NULL,
	"embedding_count" bigint DEFAULT 0 NOT NULL,
	"sealed_at" timestamp with time zone,
	"gc_state" text DEFAULT 'live' NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_builds_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "kb_builds_target_unique" UNIQUE("owner_id","document_id","version_id","id"),
	CONSTRAINT "kb_builds_operation_target_unique" UNIQUE("owner_id","document_id","version_id","operation_id","id"),
	CONSTRAINT "kb_builds_attempt_unique" UNIQUE("owner_id","operation_id","expected_generation","job_id","retry_count"),
	CONSTRAINT "kb_builds_hash_check" CHECK (octet_length("knowledge"."kb_builds"."manifest_hash") = 32),
	CONSTRAINT "kb_builds_counts_check" CHECK ("knowledge"."kb_builds"."retry_count" >= 0 AND "knowledge"."kb_builds"."expected_generation" >= 0 AND "knowledge"."kb_builds"."source_unit_count" >= 0 AND "knowledge"."kb_builds"."chunk_count" >= 0 AND "knowledge"."kb_builds"."embedding_count" >= 0),
	CONSTRAINT "kb_builds_status_check" CHECK ("knowledge"."kb_builds"."status" IN ('building', 'sealed', 'invalidated', 'purged')),
	CONSTRAINT "kb_builds_sealed_check" CHECK (("knowledge"."kb_builds"."status" <> 'sealed' OR ("knowledge"."kb_builds"."sealed_at" IS NOT NULL AND "knowledge"."kb_builds"."manifest_hash" IS NOT NULL AND "knowledge"."kb_builds"."manifest" IS NOT NULL)) AND ("knowledge"."kb_builds"."status" <> 'building' OR ("knowledge"."kb_builds"."sealed_at" IS NULL AND "knowledge"."kb_builds"."manifest_hash" IS NULL AND "knowledge"."kb_builds"."manifest" IS NULL))),
	CONSTRAINT "kb_builds_gc_check" CHECK ("knowledge"."kb_builds"."gc_state" IN ('live', 'pending', 'purged') AND (("knowledge"."kb_builds"."gc_state" = 'purged') = ("knowledge"."kb_builds"."purged_at" IS NOT NULL)) AND (("knowledge"."kb_builds"."status" = 'purged') = ("knowledge"."kb_builds"."gc_state" = 'purged'))),
	CONSTRAINT "kb_builds_schema_check" CHECK ("knowledge"."kb_builds"."schema_version" = 1 AND jsonb_typeof("knowledge"."kb_builds"."parser_snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_builds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_chunk_embeddings" (
	"owner_id" text NOT NULL,
	"build_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedded_text_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_chunk_embeddings_owner_id_build_id_chunk_id_pk" PRIMARY KEY("owner_id","build_id","chunk_id"),
	CONSTRAINT "kb_chunk_embeddings_hash_check" CHECK (octet_length("knowledge"."kb_chunk_embeddings"."embedded_text_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_chunk_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_chunk_sources" (
	"owner_id" text NOT NULL,
	"build_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"span_no" integer NOT NULL,
	"source_unit_id" uuid NOT NULL,
	"start_cp" integer NOT NULL,
	"end_cp" integer NOT NULL,
	"mapping" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "kb_chunk_sources_owner_id_build_id_chunk_id_span_no_pk" PRIMARY KEY("owner_id","build_id","chunk_id","span_no"),
	CONSTRAINT "kb_chunk_sources_offsets_check" CHECK ("knowledge"."kb_chunk_sources"."start_cp" >= 0 AND "knowledge"."kb_chunk_sources"."end_cp" > "knowledge"."kb_chunk_sources"."start_cp"),
	CONSTRAINT "kb_chunk_sources_span_check" CHECK ("knowledge"."kb_chunk_sources"."span_no" >= 0),
	CONSTRAINT "kb_chunk_sources_schema_check" CHECK ("knowledge"."kb_chunk_sources"."schema_version" = 1 AND jsonb_typeof("knowledge"."kb_chunk_sources"."mapping") = 'object')
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_chunk_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_chunks" (
	"owner_id" text NOT NULL,
	"build_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"text_hash" "bytea" NOT NULL,
	"token_count" bigint NOT NULL,
	"search_vector" "tsvector" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_chunks_owner_id_build_id_id_pk" PRIMARY KEY("owner_id","build_id","id"),
	CONSTRAINT "kb_chunks_ordinal_unique" UNIQUE("owner_id","build_id","ordinal"),
	CONSTRAINT "kb_chunks_hash_check" CHECK (octet_length("knowledge"."kb_chunks"."text_hash") = 32),
	CONSTRAINT "kb_chunks_counts_check" CHECK ("knowledge"."kb_chunks"."ordinal" >= 0 AND "knowledge"."kb_chunks"."token_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_documents" (
	"owner_id" text NOT NULL,
	"id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"title" text NOT NULL,
	"purpose" text NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"active_version_id" uuid,
	"active_build_id" uuid,
	"desired_operation_id" uuid,
	"desired_version_id" uuid,
	"generation" bigint DEFAULT 0 NOT NULL,
	"next_version_no" bigint DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_documents_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "kb_documents_title_check" CHECK (char_length("knowledge"."kb_documents"."title") BETWEEN 1 AND 200),
	CONSTRAINT "kb_documents_purpose_check" CHECK ("knowledge"."kb_documents"."purpose" IN ('facts', 'style', 'template')),
	CONSTRAINT "kb_documents_tags_check" CHECK (cardinality("knowledge"."kb_documents"."tags") <= 20 AND array_position("knowledge"."kb_documents"."tags", NULL) IS NULL AND COALESCE(array_length("knowledge"."kb_documents"."tags", 1), 0) = cardinality("knowledge"."kb_documents"."tags") AND char_length(array_to_string("knowledge"."kb_documents"."tags", '')) <= 1000),
	CONSTRAINT "kb_documents_active_check" CHECK (("knowledge"."kb_documents"."active_version_id" IS NULL) = ("knowledge"."kb_documents"."active_build_id" IS NULL)),
	CONSTRAINT "kb_documents_desired_check" CHECK ("knowledge"."kb_documents"."desired_version_id" IS NULL OR "knowledge"."kb_documents"."desired_operation_id" IS NOT NULL),
	CONSTRAINT "kb_documents_deleted_check" CHECK ("knowledge"."kb_documents"."deleted_at" IS NULL OR ("knowledge"."kb_documents"."active_version_id" IS NULL AND "knowledge"."kb_documents"."active_build_id" IS NULL AND "knowledge"."kb_documents"."desired_operation_id" IS NULL AND "knowledge"."kb_documents"."desired_version_id" IS NULL)),
	CONSTRAINT "kb_documents_generation_check" CHECK ("knowledge"."kb_documents"."generation" >= 0),
	CONSTRAINT "kb_documents_version_no_check" CHECK ("knowledge"."kb_documents"."next_version_no" > 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_evidence_items" (
	"owner_id" text NOT NULL,
	"manifest_id" uuid NOT NULL,
	"citation_no" integer NOT NULL,
	"span_no" integer NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"build_id" uuid NOT NULL,
	"source_unit_id" uuid NOT NULL,
	"index_profile_id" uuid NOT NULL,
	"source_hash" "bytea" NOT NULL,
	"text_hash" "bytea" NOT NULL,
	"locator" jsonb NOT NULL,
	"start_cp" integer NOT NULL,
	"end_cp" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "kb_evidence_items_owner_id_manifest_id_citation_no_span_no_pk" PRIMARY KEY("owner_id","manifest_id","citation_no","span_no"),
	CONSTRAINT "kb_evidence_items_source_hash_check" CHECK (octet_length("knowledge"."kb_evidence_items"."source_hash") = 32),
	CONSTRAINT "kb_evidence_items_text_hash_check" CHECK (octet_length("knowledge"."kb_evidence_items"."text_hash") = 32),
	CONSTRAINT "kb_evidence_items_offsets_check" CHECK ("knowledge"."kb_evidence_items"."start_cp" >= 0 AND "knowledge"."kb_evidence_items"."end_cp" > "knowledge"."kb_evidence_items"."start_cp"),
	CONSTRAINT "kb_evidence_items_citation_check" CHECK ("knowledge"."kb_evidence_items"."citation_no" > 0),
	CONSTRAINT "kb_evidence_items_span_check" CHECK ("knowledge"."kb_evidence_items"."span_no" >= 0),
	CONSTRAINT "kb_evidence_items_schema_check" CHECK ("knowledge"."kb_evidence_items"."schema_version" = 1 AND jsonb_typeof("knowledge"."kb_evidence_items"."locator") = 'object')
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_evidence_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_evidence_manifests" (
	"owner_id" text NOT NULL,
	"id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"strategy" text NOT NULL,
	"scope" jsonb NOT NULL,
	"policy_revision" text NOT NULL,
	"decision" jsonb,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"sealed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "kb_evidence_manifests_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "kb_evidence_manifests_mode_check" CHECK ("knowledge"."kb_evidence_manifests"."mode" IN ('strict', 'assisted')),
	CONSTRAINT "kb_evidence_manifests_expiry_check" CHECK ("knowledge"."kb_evidence_manifests"."expires_at" > "knowledge"."kb_evidence_manifests"."created_at"),
	CONSTRAINT "kb_evidence_manifests_schema_check" CHECK ("knowledge"."kb_evidence_manifests"."schema_version" = 1 AND jsonb_typeof("knowledge"."kb_evidence_manifests"."scope") = 'object' AND ("knowledge"."kb_evidence_manifests"."decision" IS NULL OR jsonb_typeof("knowledge"."kb_evidence_manifests"."decision") = 'object'))
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_evidence_manifests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_index_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"config_hash" "bytea" NOT NULL,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"model" text NOT NULL,
	"model_revision" text NOT NULL,
	"dimension" integer NOT NULL,
	"distance" text NOT NULL,
	"normalization" text NOT NULL,
	"pipeline_revisions" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_index_profiles_config_hash_unique" UNIQUE("config_hash"),
	CONSTRAINT "kb_index_profiles_hash_check" CHECK (octet_length("knowledge"."kb_index_profiles"."config_hash") = 32),
	CONSTRAINT "kb_index_profiles_dimension_check" CHECK ("knowledge"."kb_index_profiles"."dimension" > 0 AND "knowledge"."kb_index_profiles"."dimension" <= 16000),
	CONSTRAINT "kb_index_profiles_distance_check" CHECK ("knowledge"."kb_index_profiles"."distance" IN ('cosine', 'l2', 'inner_product')),
	CONSTRAINT "kb_index_profiles_schema_check" CHECK ("knowledge"."kb_index_profiles"."schema_version" = 1 AND jsonb_typeof("knowledge"."kb_index_profiles"."config") = 'object' AND jsonb_typeof("knowledge"."kb_index_profiles"."pipeline_revisions") = 'object')
);
--> statement-breakpoint
CREATE TABLE "knowledge"."kb_metering_events" (
	"owner_id" text NOT NULL,
	"id" uuid NOT NULL,
	"logical_event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"supersedes_event_id" uuid,
	"dimension" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(38, 0),
	"usage_source" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"document_id" uuid,
	"version_id" uuid,
	"operation_id" uuid,
	"build_id" uuid,
	"run_id" uuid,
	"call_id" uuid,
	"attempt_id" uuid,
	"index_profile_id" uuid,
	"purpose" text,
	"call_state" text,
	"completion" text,
	"sequence" bigint,
	"active_bytes_before" bigint,
	"active_bytes_after" bigint,
	"window_id" uuid,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"opening_sequence" bigint,
	"closing_sequence" bigint,
	"event_set_hash" "bytea",
	"tariff_revision" text,
	"payer" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"delivery_state" text DEFAULT 'pending' NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_metering_events_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "kb_metering_events_logical_unique" UNIQUE("owner_id","logical_event_key"),
	CONSTRAINT "kb_metering_events_key_check" CHECK (char_length("knowledge"."kb_metering_events"."logical_event_key") BETWEEN 1 AND 128 AND char_length("knowledge"."kb_metering_events"."subject_key") BETWEEN 1 AND 128),
	CONSTRAINT "kb_metering_events_kind_check" CHECK ("knowledge"."kb_metering_events"."event_type" IN ('observation', 'correction', 'capacity_change') AND "knowledge"."kb_metering_events"."dimension" IN ('storage', 'embedding') AND "knowledge"."kb_metering_events"."usage_source" IN ('unknown', 'estimated', 'provider_reported', 'reconciled') AND "knowledge"."kb_metering_events"."payer" IN ('customer', 'platform') AND "knowledge"."kb_metering_events"."schema_version" = 1),
	CONSTRAINT "kb_metering_events_correction_check" CHECK ((("knowledge"."kb_metering_events"."event_type" = 'correction') = ("knowledge"."kb_metering_events"."supersedes_event_id" IS NOT NULL)) AND ("knowledge"."kb_metering_events"."supersedes_event_id" IS NULL OR "knowledge"."kb_metering_events"."supersedes_event_id" <> "knowledge"."kb_metering_events"."id") AND ("knowledge"."kb_metering_events"."event_type" <> 'correction' OR "knowledge"."kb_metering_events"."usage_source" IN ('provider_reported', 'reconciled'))),
	CONSTRAINT "kb_metering_events_quantity_check" CHECK (
      ("knowledge"."kb_metering_events"."usage_source" = 'unknown' AND "knowledge"."kb_metering_events"."quantity" IS NULL) OR
      ("knowledge"."kb_metering_events"."usage_source" <> 'unknown' AND "knowledge"."kb_metering_events"."quantity" IS NOT NULL AND "knowledge"."kb_metering_events"."quantity" >= 0)
    ),
	CONSTRAINT "kb_metering_events_unit_check" CHECK (
      ("knowledge"."kb_metering_events"."dimension" = 'embedding' AND "knowledge"."kb_metering_events"."unit" = 'tokens'
        AND ("knowledge"."kb_metering_events"."quantity" IS NULL OR "knowledge"."kb_metering_events"."quantity" <= 9223372036854775807)) OR
      ("knowledge"."kb_metering_events"."dimension" = 'storage' AND "knowledge"."kb_metering_events"."event_type" <> 'capacity_change'
        AND "knowledge"."kb_metering_events"."unit" = 'byte_ms' AND "knowledge"."kb_metering_events"."usage_source" <> 'provider_reported') OR
      ("knowledge"."kb_metering_events"."dimension" = 'storage' AND "knowledge"."kb_metering_events"."event_type" = 'capacity_change'
        AND "knowledge"."kb_metering_events"."unit" = 'bytes' AND "knowledge"."kb_metering_events"."quantity" IS NOT NULL
        AND "knowledge"."kb_metering_events"."quantity" <= 9223372036854775807)
    ),
	CONSTRAINT "kb_metering_events_subject_check" CHECK (
      ("knowledge"."kb_metering_events"."subject_kind" = 'operation' AND "knowledge"."kb_metering_events"."dimension" = 'embedding'
        AND "knowledge"."kb_metering_events"."document_id" IS NOT NULL AND "knowledge"."kb_metering_events"."version_id" IS NOT NULL
        AND "knowledge"."kb_metering_events"."operation_id" IS NOT NULL AND "knowledge"."kb_metering_events"."build_id" IS NOT NULL
        AND "knowledge"."kb_metering_events"."run_id" IS NULL AND "knowledge"."kb_metering_events"."call_id" IS NULL) OR
      ("knowledge"."kb_metering_events"."subject_kind" = 'query' AND "knowledge"."kb_metering_events"."dimension" = 'embedding'
        AND "knowledge"."kb_metering_events"."document_id" IS NULL AND "knowledge"."kb_metering_events"."version_id" IS NULL
        AND "knowledge"."kb_metering_events"."operation_id" IS NULL AND "knowledge"."kb_metering_events"."build_id" IS NULL
        AND "knowledge"."kb_metering_events"."run_id" IS NOT NULL AND "knowledge"."kb_metering_events"."call_id" IS NOT NULL) OR
      ("knowledge"."kb_metering_events"."subject_kind" IN ('storage_window', 'capacity_change') AND "knowledge"."kb_metering_events"."dimension" = 'storage'
        AND "knowledge"."kb_metering_events"."document_id" IS NULL AND "knowledge"."kb_metering_events"."version_id" IS NULL
        AND "knowledge"."kb_metering_events"."operation_id" IS NULL AND "knowledge"."kb_metering_events"."build_id" IS NULL
        AND "knowledge"."kb_metering_events"."run_id" IS NULL AND "knowledge"."kb_metering_events"."call_id" IS NULL)
    ),
	CONSTRAINT "kb_metering_events_embedding_check" CHECK (
      ("knowledge"."kb_metering_events"."dimension" = 'storage' AND "knowledge"."kb_metering_events"."attempt_id" IS NULL AND "knowledge"."kb_metering_events"."index_profile_id" IS NULL
        AND "knowledge"."kb_metering_events"."purpose" IS NULL AND "knowledge"."kb_metering_events"."call_state" IS NULL AND "knowledge"."kb_metering_events"."completion" IS NULL) OR
      ("knowledge"."kb_metering_events"."dimension" = 'embedding' AND "knowledge"."kb_metering_events"."event_type" <> 'capacity_change'
        AND "knowledge"."kb_metering_events"."attempt_id" IS NOT NULL AND "knowledge"."kb_metering_events"."index_profile_id" IS NOT NULL
        AND "knowledge"."kb_metering_events"."purpose" IS NOT NULL AND "knowledge"."kb_metering_events"."purpose" IN ('document', 'query', 'user_rebuild', 'platform_rebuild')
        AND "knowledge"."kb_metering_events"."call_state" IS NOT NULL AND "knowledge"."kb_metering_events"."call_state" IN ('intended', 'completed', 'failed', 'unknown', 'not_called')
        AND "knowledge"."kb_metering_events"."completion" IS NOT NULL AND "knowledge"."kb_metering_events"."completion" IN ('published', 'evidence_complete', 'none')
        AND (("knowledge"."kb_metering_events"."subject_kind" = 'query') = ("knowledge"."kb_metering_events"."purpose" = 'query'))
        AND ("knowledge"."kb_metering_events"."call_state" NOT IN ('intended', 'unknown') OR "knowledge"."kb_metering_events"."usage_source" = 'unknown')
        AND ("knowledge"."kb_metering_events"."call_state" <> 'not_called' OR ("knowledge"."kb_metering_events"."usage_source" = 'reconciled' AND "knowledge"."kb_metering_events"."quantity" = 0))
        AND ("knowledge"."kb_metering_events"."call_state" = 'completed' OR "knowledge"."kb_metering_events"."completion" = 'none')
        AND ("knowledge"."kb_metering_events"."subject_kind" <> 'query' OR "knowledge"."kb_metering_events"."completion" <> 'published')
        AND ("knowledge"."kb_metering_events"."subject_kind" <> 'operation' OR "knowledge"."kb_metering_events"."completion" <> 'evidence_complete'))
    ),
	CONSTRAINT "kb_metering_events_capacity_check" CHECK (
      ("knowledge"."kb_metering_events"."event_type" = 'capacity_change' AND "knowledge"."kb_metering_events"."subject_kind" = 'capacity_change'
        AND "knowledge"."kb_metering_events"."sequence" IS NOT NULL AND "knowledge"."kb_metering_events"."active_bytes_before" IS NOT NULL
        AND "knowledge"."kb_metering_events"."active_bytes_after" IS NOT NULL AND "knowledge"."kb_metering_events"."quantity" = "knowledge"."kb_metering_events"."active_bytes_after"
        AND "knowledge"."kb_metering_events"."payer" = 'platform' AND "knowledge"."kb_metering_events"."usage_source" = 'reconciled') OR
      ("knowledge"."kb_metering_events"."event_type" <> 'capacity_change' AND "knowledge"."kb_metering_events"."subject_kind" <> 'capacity_change'
        AND "knowledge"."kb_metering_events"."sequence" IS NULL AND "knowledge"."kb_metering_events"."active_bytes_before" IS NULL AND "knowledge"."kb_metering_events"."active_bytes_after" IS NULL)
    ),
	CONSTRAINT "kb_metering_events_window_check" CHECK (
      ("knowledge"."kb_metering_events"."subject_kind" = 'storage_window' AND "knowledge"."kb_metering_events"."window_id" IS NOT NULL
        AND "knowledge"."kb_metering_events"."window_start" IS NOT NULL AND "knowledge"."kb_metering_events"."window_end" IS NOT NULL
        AND "knowledge"."kb_metering_events"."window_end" > "knowledge"."kb_metering_events"."window_start" AND "knowledge"."kb_metering_events"."window_end" <= "knowledge"."kb_metering_events"."occurred_at"
        AND "knowledge"."kb_metering_events"."opening_sequence" IS NOT NULL AND "knowledge"."kb_metering_events"."closing_sequence" IS NOT NULL
        AND "knowledge"."kb_metering_events"."opening_sequence" <= "knowledge"."kb_metering_events"."closing_sequence" AND "knowledge"."kb_metering_events"."event_set_hash" IS NOT NULL) OR
      ("knowledge"."kb_metering_events"."subject_kind" <> 'storage_window' AND "knowledge"."kb_metering_events"."window_id" IS NULL
        AND "knowledge"."kb_metering_events"."window_start" IS NULL AND "knowledge"."kb_metering_events"."window_end" IS NULL
        AND "knowledge"."kb_metering_events"."opening_sequence" IS NULL AND "knowledge"."kb_metering_events"."closing_sequence" IS NULL AND "knowledge"."kb_metering_events"."event_set_hash" IS NULL)
    ),
	CONSTRAINT "kb_metering_events_payer_check" CHECK (
      "knowledge"."kb_metering_events"."payer" <> 'customer' OR ("knowledge"."kb_metering_events"."tariff_revision" IS NOT NULL
        AND "knowledge"."kb_metering_events"."usage_source" IN ('provider_reported', 'reconciled')
        AND ("knowledge"."kb_metering_events"."dimension" <> 'embedding' OR ("knowledge"."kb_metering_events"."call_state" = 'completed'
          AND "knowledge"."kb_metering_events"."completion" <> 'none' AND "knowledge"."kb_metering_events"."purpose" <> 'platform_rebuild')))
    ),
	CONSTRAINT "kb_metering_events_set_hash_check" CHECK (octet_length("knowledge"."kb_metering_events"."event_set_hash") = 32),
	CONSTRAINT "kb_metering_events_counts_check" CHECK ("knowledge"."kb_metering_events"."sequence" >= 0 AND "knowledge"."kb_metering_events"."active_bytes_before" >= 0 AND "knowledge"."kb_metering_events"."active_bytes_after" >= 0 AND "knowledge"."kb_metering_events"."opening_sequence" >= 0 AND "knowledge"."kb_metering_events"."closing_sequence" >= 0 AND "knowledge"."kb_metering_events"."delivery_attempts" >= 0),
	CONSTRAINT "kb_metering_events_delivery_check" CHECK ("knowledge"."kb_metering_events"."delivery_state" IN ('pending', 'delivered', 'reconciling') AND (("knowledge"."kb_metering_events"."delivery_state" = 'delivered') = ("knowledge"."kb_metering_events"."delivered_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_metering_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_operations" (
	"owner_id" text NOT NULL,
	"id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"kind" text NOT NULL,
	"phase" text NOT NULL,
	"target_version_id" uuid,
	"expected_generation" bigint NOT NULL,
	"upload_expires_at" timestamp with time zone,
	"staging_key" text,
	"declared_bytes" bigint,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_operations_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "kb_operations_idempotency_unique" UNIQUE("owner_id","idempotency_key"),
	CONSTRAINT "kb_operations_document_unique" UNIQUE("owner_id","document_id","id"),
	CONSTRAINT "kb_operations_target_unique" UNIQUE("owner_id","document_id","target_version_id","id"),
	CONSTRAINT "kb_operations_request_hash_check" CHECK (octet_length("knowledge"."kb_operations"."request_hash") = 32),
	CONSTRAINT "kb_operations_key_check" CHECK (char_length("knowledge"."kb_operations"."idempotency_key") BETWEEN 1 AND 128),
	CONSTRAINT "kb_operations_kind_check" CHECK ("knowledge"."kb_operations"."kind" IN ('upload', 'replace', 'rebuild', 'delete')),
	CONSTRAINT "kb_operations_phase_check" CHECK ("knowledge"."kb_operations"."phase" IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing', 'ready', 'failed', 'cancelled', 'deleting', 'deleted')),
	CONSTRAINT "kb_operations_target_check" CHECK ("knowledge"."kb_operations"."phase" NOT IN ('queued', 'parsing', 'indexing', 'publishing', 'ready') OR "knowledge"."kb_operations"."target_version_id" IS NOT NULL),
	CONSTRAINT "kb_operations_error_check" CHECK (("knowledge"."kb_operations"."phase" = 'failed') = ("knowledge"."kb_operations"."error_code" IS NOT NULL)),
	CONSTRAINT "kb_operations_delete_phase_check" CHECK (("knowledge"."kb_operations"."kind" = 'delete' AND "knowledge"."kb_operations"."phase" IN ('deleting', 'deleted', 'failed', 'cancelled')) OR ("knowledge"."kb_operations"."kind" <> 'delete' AND "knowledge"."kb_operations"."phase" NOT IN ('deleting', 'deleted'))),
	CONSTRAINT "kb_operations_counts_check" CHECK ("knowledge"."kb_operations"."expected_generation" >= 0 AND "knowledge"."kb_operations"."declared_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_quotas" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"owner_state" text DEFAULT 'active' NOT NULL,
	"active_index_profile_id" uuid,
	"policy_revision" text,
	"limit_files" bigint,
	"limit_bytes" bigint,
	"limit_chunks" bigint,
	"active_files" bigint DEFAULT 0 NOT NULL,
	"active_bytes" bigint DEFAULT 0 NOT NULL,
	"active_chunks" bigint DEFAULT 0 NOT NULL,
	"reserved_files" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_chunks" bigint DEFAULT 0 NOT NULL,
	"physical_accounted_bytes" bigint DEFAULT 0 NOT NULL,
	"physical_reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"physical_limit_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_quotas_state_check" CHECK ("knowledge"."kb_quotas"."owner_state" IN ('active', 'frozen', 'closed')),
	CONSTRAINT "kb_quotas_policy_check" CHECK ((("knowledge"."kb_quotas"."policy_revision" IS NULL AND "knowledge"."kb_quotas"."limit_files" IS NULL AND "knowledge"."kb_quotas"."limit_bytes" IS NULL AND "knowledge"."kb_quotas"."limit_chunks" IS NULL) OR ("knowledge"."kb_quotas"."policy_revision" IS NOT NULL AND "knowledge"."kb_quotas"."limit_files" IS NOT NULL AND "knowledge"."kb_quotas"."limit_bytes" IS NOT NULL AND "knowledge"."kb_quotas"."limit_chunks" IS NOT NULL AND "knowledge"."kb_quotas"."active_index_profile_id" IS NOT NULL))),
	CONSTRAINT "kb_quotas_counts_check" CHECK ("knowledge"."kb_quotas"."limit_files" >= 0 AND "knowledge"."kb_quotas"."limit_bytes" >= 0 AND "knowledge"."kb_quotas"."limit_chunks" >= 0 AND "knowledge"."kb_quotas"."active_files" >= 0 AND "knowledge"."kb_quotas"."active_bytes" >= 0 AND "knowledge"."kb_quotas"."active_chunks" >= 0 AND "knowledge"."kb_quotas"."reserved_files" >= 0 AND "knowledge"."kb_quotas"."reserved_bytes" >= 0 AND "knowledge"."kb_quotas"."reserved_chunks" >= 0 AND "knowledge"."kb_quotas"."physical_accounted_bytes" >= 0 AND "knowledge"."kb_quotas"."physical_reserved_bytes" >= 0 AND "knowledge"."kb_quotas"."physical_limit_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_quotas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_reservations" (
	"owner_id" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"base_version_id" uuid,
	"base_build_id" uuid,
	"expected_generation" bigint NOT NULL,
	"reserved_files" bigint NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"reserved_chunks" bigint NOT NULL,
	"physical_reserved_bytes" bigint NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_reservations_owner_id_operation_id_pk" PRIMARY KEY("owner_id","operation_id"),
	CONSTRAINT "kb_reservations_base_check" CHECK (("knowledge"."kb_reservations"."base_version_id" IS NULL) = ("knowledge"."kb_reservations"."base_build_id" IS NULL)),
	CONSTRAINT "kb_reservations_state_check" CHECK ("knowledge"."kb_reservations"."state" IN ('held', 'applied', 'released') AND (("knowledge"."kb_reservations"."state" = 'held') = ("knowledge"."kb_reservations"."closed_at" IS NULL))),
	CONSTRAINT "kb_reservations_counts_check" CHECK ("knowledge"."kb_reservations"."expected_generation" >= 0 AND "knowledge"."kb_reservations"."reserved_files" >= 0 AND "knowledge"."kb_reservations"."reserved_bytes" >= 0 AND "knowledge"."kb_reservations"."reserved_chunks" >= 0 AND "knowledge"."kb_reservations"."physical_reserved_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_source_units" (
	"owner_id" text NOT NULL,
	"build_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"parent_id" uuid,
	"ordinal" integer NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" "bytea" NOT NULL,
	"locator" jsonb NOT NULL,
	"coverage" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_source_units_owner_id_build_id_id_pk" PRIMARY KEY("owner_id","build_id","id"),
	CONSTRAINT "kb_source_units_ordinal_unique" UNIQUE("owner_id","build_id","ordinal"),
	CONSTRAINT "kb_source_units_hash_check" CHECK (octet_length("knowledge"."kb_source_units"."text_hash") = 32),
	CONSTRAINT "kb_source_units_ordinal_check" CHECK ("knowledge"."kb_source_units"."ordinal" >= 0),
	CONSTRAINT "kb_source_units_parent_check" CHECK ("knowledge"."kb_source_units"."parent_id" IS NULL OR "knowledge"."kb_source_units"."parent_id" <> "knowledge"."kb_source_units"."id"),
	CONSTRAINT "kb_source_units_schema_check" CHECK ("knowledge"."kb_source_units"."schema_version" = 1 AND jsonb_typeof("knowledge"."kb_source_units"."locator") = 'object' AND jsonb_typeof("knowledge"."kb_source_units"."coverage") = 'object' AND jsonb_typeof("knowledge"."kb_source_units"."warnings") = 'array')
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_source_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_spaces" (
	"owner_id" text NOT NULL,
	"id" uuid NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_spaces_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "kb_spaces_title_check" CHECK (char_length("knowledge"."kb_spaces"."title") BETWEEN 1 AND 200),
	CONSTRAINT "kb_spaces_state_check" CHECK ("knowledge"."kb_spaces"."state" IN ('active', 'frozen', 'deleting', 'deleted')),
	CONSTRAINT "kb_spaces_deleted_check" CHECK (("knowledge"."kb_spaces"."state" = 'deleted') = ("knowledge"."kb_spaces"."deleted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge"."kb_versions" (
	"owner_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"version_no" bigint NOT NULL,
	"upload_operation_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"oss_key" text NOT NULL,
	"file_hash" "bytea" NOT NULL,
	"size_bytes" bigint NOT NULL,
	"format" text NOT NULL,
	"mime" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone,
	"gc_state" text DEFAULT 'live' NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_versions_owner_id_document_id_id_pk" PRIMARY KEY("owner_id","document_id","id"),
	CONSTRAINT "kb_versions_number_unique" UNIQUE("owner_id","document_id","version_no"),
	CONSTRAINT "kb_versions_object_unique" UNIQUE("bucket","oss_key"),
	CONSTRAINT "kb_versions_hash_check" CHECK (octet_length("knowledge"."kb_versions"."file_hash") = 32),
	CONSTRAINT "kb_versions_size_check" CHECK ("knowledge"."kb_versions"."size_bytes" >= 0),
	CONSTRAINT "kb_versions_number_check" CHECK ("knowledge"."kb_versions"."version_no" > 0),
	CONSTRAINT "kb_versions_format_check" CHECK ("knowledge"."kb_versions"."format" IN ('txt', 'md', 'docx', 'pdf', 'xlsx')),
	CONSTRAINT "kb_versions_gc_check" CHECK ("knowledge"."kb_versions"."gc_state" IN ('live', 'pending', 'purged') AND (("knowledge"."kb_versions"."gc_state" = 'purged') = ("knowledge"."kb_versions"."purged_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "knowledge"."kb_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_billing_receipts" ADD CONSTRAINT "kb_billing_receipts_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "knowledge"."kb_quotas"("owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_builds" ADD CONSTRAINT "kb_builds_version_fk" FOREIGN KEY ("owner_id","document_id","version_id") REFERENCES "knowledge"."kb_versions"("owner_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_builds" ADD CONSTRAINT "kb_builds_operation_fk" FOREIGN KEY ("owner_id","document_id","version_id","operation_id") REFERENCES "knowledge"."kb_operations"("owner_id","document_id","target_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_builds" ADD CONSTRAINT "kb_builds_profile_fk" FOREIGN KEY ("index_profile_id") REFERENCES "knowledge"."kb_index_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_chunk_embeddings" ADD CONSTRAINT "kb_chunk_embeddings_chunk_fk" FOREIGN KEY ("owner_id","build_id","chunk_id") REFERENCES "knowledge"."kb_chunks"("owner_id","build_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_chunk_sources" ADD CONSTRAINT "kb_chunk_sources_chunk_fk" FOREIGN KEY ("owner_id","build_id","chunk_id") REFERENCES "knowledge"."kb_chunks"("owner_id","build_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_chunk_sources" ADD CONSTRAINT "kb_chunk_sources_unit_fk" FOREIGN KEY ("owner_id","build_id","source_unit_id") REFERENCES "knowledge"."kb_source_units"("owner_id","build_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_chunks" ADD CONSTRAINT "kb_chunks_build_fk" FOREIGN KEY ("owner_id","build_id") REFERENCES "knowledge"."kb_builds"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_documents" ADD CONSTRAINT "kb_documents_space_fk" FOREIGN KEY ("owner_id","space_id") REFERENCES "knowledge"."kb_spaces"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_documents" ADD CONSTRAINT "kb_documents_active_version_fk" FOREIGN KEY ("owner_id","id","active_version_id") REFERENCES "knowledge"."kb_versions"("owner_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_documents" ADD CONSTRAINT "kb_documents_active_build_fk" FOREIGN KEY ("owner_id","id","active_version_id","active_build_id") REFERENCES "knowledge"."kb_builds"("owner_id","document_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_documents" ADD CONSTRAINT "kb_documents_desired_operation_fk" FOREIGN KEY ("owner_id","id","desired_operation_id") REFERENCES "knowledge"."kb_operations"("owner_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_documents" ADD CONSTRAINT "kb_documents_desired_target_fk" FOREIGN KEY ("owner_id","id","desired_version_id","desired_operation_id") REFERENCES "knowledge"."kb_operations"("owner_id","document_id","target_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_evidence_items" ADD CONSTRAINT "kb_evidence_items_manifest_fk" FOREIGN KEY ("owner_id","manifest_id") REFERENCES "knowledge"."kb_evidence_manifests"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_evidence_manifests" ADD CONSTRAINT "kb_evidence_manifests_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "knowledge"."kb_quotas"("owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_metering_events" ADD CONSTRAINT "kb_metering_events_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "knowledge"."kb_quotas"("owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_metering_events" ADD CONSTRAINT "kb_metering_events_operation_fk" FOREIGN KEY ("owner_id","document_id","version_id","operation_id") REFERENCES "knowledge"."kb_operations"("owner_id","document_id","target_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_metering_events" ADD CONSTRAINT "kb_metering_events_build_fk" FOREIGN KEY ("owner_id","document_id","version_id","operation_id","build_id") REFERENCES "knowledge"."kb_builds"("owner_id","document_id","version_id","operation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_metering_events" ADD CONSTRAINT "kb_metering_events_profile_fk" FOREIGN KEY ("index_profile_id") REFERENCES "knowledge"."kb_index_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_metering_events" ADD CONSTRAINT "kb_metering_events_supersedes_fk" FOREIGN KEY ("owner_id","supersedes_event_id") REFERENCES "knowledge"."kb_metering_events"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_operations" ADD CONSTRAINT "kb_operations_document_fk" FOREIGN KEY ("owner_id","document_id") REFERENCES "knowledge"."kb_documents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_operations" ADD CONSTRAINT "kb_operations_target_fk" FOREIGN KEY ("owner_id","document_id","target_version_id") REFERENCES "knowledge"."kb_versions"("owner_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_quotas" ADD CONSTRAINT "kb_quotas_profile_fk" FOREIGN KEY ("active_index_profile_id") REFERENCES "knowledge"."kb_index_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_reservations" ADD CONSTRAINT "kb_reservations_operation_fk" FOREIGN KEY ("owner_id","document_id","operation_id") REFERENCES "knowledge"."kb_operations"("owner_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_reservations" ADD CONSTRAINT "kb_reservations_base_fk" FOREIGN KEY ("owner_id","document_id","base_version_id","base_build_id") REFERENCES "knowledge"."kb_builds"("owner_id","document_id","version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_source_units" ADD CONSTRAINT "kb_source_units_build_fk" FOREIGN KEY ("owner_id","build_id") REFERENCES "knowledge"."kb_builds"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_source_units" ADD CONSTRAINT "kb_source_units_parent_fk" FOREIGN KEY ("owner_id","build_id","parent_id") REFERENCES "knowledge"."kb_source_units"("owner_id","build_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_spaces" ADD CONSTRAINT "kb_spaces_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "knowledge"."kb_quotas"("owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_versions" ADD CONSTRAINT "kb_versions_document_fk" FOREIGN KEY ("owner_id","document_id") REFERENCES "knowledge"."kb_documents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."kb_versions" ADD CONSTRAINT "kb_versions_upload_fk" FOREIGN KEY ("owner_id","document_id","upload_operation_id") REFERENCES "knowledge"."kb_operations"("owner_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_billing_receipts_reconcile_idx" ON "knowledge"."kb_billing_receipts" USING btree ("next_reconcile_at","owner_id","id") WHERE "knowledge"."kb_billing_receipts"."status" IN ('pending', 'reconciling', 'reserved');--> statement-breakpoint
CREATE INDEX "kb_chunk_sources_unit_idx" ON "knowledge"."kb_chunk_sources" USING btree ("owner_id","build_id","source_unit_id","chunk_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_search_idx" ON "knowledge"."kb_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "kb_documents_listing_idx" ON "knowledge"."kb_documents" USING btree ("owner_id","space_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "knowledge"."kb_documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_metering_events_sequence_unique" ON "knowledge"."kb_metering_events" USING btree ("owner_id","sequence") WHERE "knowledge"."kb_metering_events"."event_type" = 'capacity_change';--> statement-breakpoint
CREATE INDEX "kb_metering_events_time_idx" ON "knowledge"."kb_metering_events" USING btree ("owner_id","occurred_at","sequence","id");--> statement-breakpoint
CREATE INDEX "kb_metering_events_delivery_idx" ON "knowledge"."kb_metering_events" USING btree ("next_attempt_at","owner_id","id") WHERE "knowledge"."kb_metering_events"."delivery_state" IN ('pending', 'reconciling');--> statement-breakpoint
CREATE UNIQUE INDEX "kb_operations_live_unique" ON "knowledge"."kb_operations" USING btree ("owner_id","document_id") WHERE "knowledge"."kb_operations"."kind" IN ('upload', 'replace', 'rebuild') AND "knowledge"."kb_operations"."phase" IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing');--> statement-breakpoint
CREATE INDEX "kb_reservations_held_idx" ON "knowledge"."kb_reservations" USING btree ("expires_at","owner_id","operation_id") WHERE "knowledge"."kb_reservations"."state" = 'held';--> statement-breakpoint
CREATE INDEX "kb_source_units_parent_idx" ON "knowledge"."kb_source_units" USING btree ("owner_id","build_id","parent_id","ordinal");--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_billing_receipts" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_billing_receipts"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_billing_receipts"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_billing_receipts" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_billing_receipts"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_billing_receipts"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_builds" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_builds"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_builds"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_builds" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_builds"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_builds"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_chunk_embeddings" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_chunk_embeddings"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_chunk_embeddings"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_chunk_embeddings" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_chunk_embeddings"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_chunk_embeddings"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_chunk_sources" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_chunk_sources"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_chunk_sources"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_chunk_sources" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_chunk_sources"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_chunk_sources"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_chunks" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_chunks"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_chunks"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_chunks" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_chunks"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_chunks"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_documents" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_documents"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_documents"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_documents" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_documents"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_documents"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_evidence_items" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_evidence_items"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_evidence_items"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_evidence_items" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_evidence_items"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_evidence_items"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_evidence_manifests" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_evidence_manifests"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_evidence_manifests"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_evidence_manifests" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_evidence_manifests"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_evidence_manifests"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_metering_events" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_metering_events"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_metering_events"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_metering_events" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_metering_events"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_metering_events"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_operations" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_operations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_operations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_operations" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_operations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_operations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_quotas" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_quotas"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_quotas"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_quotas" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_quotas"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_quotas"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_reservations" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_reservations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_reservations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_reservations" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_reservations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_reservations"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_source_units" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_source_units"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_source_units"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_source_units" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_source_units"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_source_units"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_spaces" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_spaces"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_spaces"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_spaces" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_spaces"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_spaces"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_access" ON "knowledge"."kb_versions" AS PERMISSIVE FOR ALL TO public USING ("knowledge"."kb_versions"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_versions"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));--> statement-breakpoint
CREATE POLICY "owner_guard" ON "knowledge"."kb_versions" AS RESTRICTIVE FOR ALL TO public USING ("knowledge"."kb_versions"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), ''))) WITH CHECK ("knowledge"."kb_versions"."owner_id" = (SELECT NULLIF(current_setting('knowledge.owner_id', true), '')));
-- 取消后的显式新上传：旧Operation/Reservation不可复活，旧物理负债不抵扣。
-- 独立增量保留首次准入的generation-zero语义，不授予API底表写权。
CREATE FUNCTION knowledge.reserve_retry_capacity(
  requested_operation uuid,
  requested_chunks bigint,
  requested_physical_bytes bigint,
  requested_expiry timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_row knowledge.kb_quotas%ROWTYPE;
  space_row knowledge.kb_spaces%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
  version_row knowledge.kb_versions%ROWTYPE;
  reservation_row knowledge.kb_reservations%ROWTYPE;
  has_reservation boolean;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_operation IS NULL OR requested_chunks IS NULL OR requested_chunks < 0
     OR requested_physical_bytes IS NULL OR requested_physical_bytes < 0
     OR requested_expiry IS NULL OR NOT isfinite(requested_expiry)
     OR requested_expiry <= clock_timestamp() THEN RETURN 'INVALID_REQUEST'; END IF;

  -- 与首次/替换准入及取消共用Quota→Space→Document→Operation→Reservation锁序。
  -- 所有准入判断在等待结束后取当前事实，不能借用取消前的代数或空闲预算。
  SELECT * INTO quota_row FROM knowledge.kb_quotas
    WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF quota_row.owner_state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
  IF quota_row.policy_revision IS NULL OR quota_row.limit_files IS NULL
     OR quota_row.limit_bytes IS NULL OR quota_row.limit_chunks IS NULL
     OR quota_row.active_index_profile_id IS NULL THEN RETURN 'NOT_CONFIGURED'; END IF;

  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = operation_row.document_id;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO space_row FROM knowledge.kb_spaces
    WHERE owner_id = principal_owner AND id = document_row.space_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF space_row.state <> 'active' OR space_row.deleted_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = operation_row.document_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF document_row.deleted_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  IF document_row.space_id <> space_row.id OR document_row.generation = 0
     OR document_row.active_version_id IS NOT NULL OR document_row.active_build_id IS NOT NULL THEN
    RETURN 'VERSION_CONFLICT';
  END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF operation_row.document_id <> document_row.id
     OR operation_row.expected_generation <> document_row.generation THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF operation_row.kind <> 'upload' OR operation_row.phase <> 'queued'
     OR operation_row.target_version_id IS NULL THEN RETURN 'FORBIDDEN'; END IF;

  -- 正代数本身不是取消证明；上一代必须已完整撤意图、关闭预留并封停全部attempt。
  IF NOT EXISTS (
    SELECT 1 FROM knowledge.kb_operations prior_operation
    JOIN knowledge.kb_reservations prior_reservation
      ON prior_reservation.owner_id = prior_operation.owner_id
      AND prior_reservation.operation_id = prior_operation.id
    WHERE prior_operation.owner_id = principal_owner
      AND prior_operation.document_id = document_row.id AND prior_operation.id <> requested_operation
      AND prior_operation.expected_generation = document_row.generation - 1
      AND prior_operation.kind = 'upload' AND prior_operation.phase = 'cancelled'
      AND prior_reservation.document_id = document_row.id
      AND prior_reservation.expected_generation = prior_operation.expected_generation
      AND prior_reservation.state = 'released' AND prior_reservation.closed_at IS NOT NULL
      AND prior_reservation.base_version_id IS NULL AND prior_reservation.base_build_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM knowledge.kb_builds
        WHERE owner_id = principal_owner AND operation_id = prior_operation.id
          AND status IN ('building', 'sealed'))
  ) THEN RETURN 'VERSION_CONFLICT'; END IF;

  SELECT * INTO version_row FROM knowledge.kb_versions
    WHERE owner_id = principal_owner AND document_id = document_row.id
      AND id = operation_row.target_version_id FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF version_row.upload_operation_id <> requested_operation
     OR version_row.gc_state <> 'live' OR version_row.purged_at IS NOT NULL
     OR (version_row.retain_until IS NOT NULL AND version_row.retain_until <= clock_timestamp()) THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF requested_physical_bytes < version_row.size_bytes THEN RETURN 'INVALID_REQUEST'; END IF;

  SELECT * INTO reservation_row FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND operation_id = requested_operation FOR UPDATE;
  has_reservation := FOUND;
  IF has_reservation AND (reservation_row.state <> 'held'
     OR reservation_row.expires_at <= clock_timestamp()) THEN RETURN 'FORBIDDEN'; END IF;
  IF EXISTS (SELECT 1 FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND document_id = document_row.id
      AND operation_id <> requested_operation AND state = 'held') THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF has_reservation THEN
    IF reservation_row.document_id <> document_row.id
       OR reservation_row.expected_generation <> document_row.generation
       OR reservation_row.base_version_id IS NOT NULL OR reservation_row.base_build_id IS NOT NULL
       OR reservation_row.reserved_files <> 1 OR reservation_row.reserved_bytes <> version_row.size_bytes
       OR reservation_row.reserved_chunks <> requested_chunks
       OR reservation_row.projected_chunks IS DISTINCT FROM requested_chunks
       OR reservation_row.physical_reserved_bytes <> requested_physical_bytes
       OR reservation_row.expires_at <> requested_expiry
       OR document_row.desired_operation_id IS DISTINCT FROM requested_operation
       OR document_row.desired_version_id IS DISTINCT FROM version_row.id THEN RETURN 'VERSION_CONFLICT'; END IF;
    RETURN 'REPLAY';
  END IF;
  IF document_row.desired_operation_id IS NOT NULL OR document_row.desired_version_id IS NOT NULL THEN
    RETURN 'VERSION_CONFLICT';
  END IF;

  -- 逻辑全量重新占额；numeric先求和避免bigint溢出，物理预算包含所有旧代负债。
  IF quota_row.active_files::numeric + quota_row.reserved_files + 1 > quota_row.limit_files
     OR quota_row.active_bytes::numeric + quota_row.reserved_bytes + version_row.size_bytes > quota_row.limit_bytes
     OR quota_row.active_chunks::numeric + quota_row.reserved_chunks + requested_chunks > quota_row.limit_chunks
     OR quota_row.physical_accounted_bytes::numeric + quota_row.physical_reserved_bytes
          + requested_physical_bytes > quota_row.physical_limit_bytes THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  IF requested_expiry <= clock_timestamp() THEN RETURN 'INVALID_REQUEST'; END IF;

  UPDATE knowledge.kb_quotas SET reserved_files = reserved_files + 1,
      reserved_bytes = reserved_bytes + version_row.size_bytes,
      reserved_chunks = reserved_chunks + requested_chunks,
      physical_reserved_bytes = physical_reserved_bytes + requested_physical_bytes,
      updated_at = clock_timestamp()
    WHERE owner_id = principal_owner;
  INSERT INTO knowledge.kb_reservations
    (owner_id, operation_id, document_id, expected_generation, reserved_files,
     reserved_bytes, reserved_chunks, projected_chunks, physical_reserved_bytes, expires_at)
    VALUES (principal_owner, requested_operation, document_row.id, document_row.generation, 1,
            version_row.size_bytes, requested_chunks, requested_chunks,
            requested_physical_bytes, requested_expiry);
  UPDATE knowledge.kb_documents
    SET desired_operation_id = requested_operation, desired_version_id = version_row.id
    WHERE owner_id = principal_owner AND id = document_row.id;
  RETURN 'RESERVED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.reserve_retry_capacity(uuid, bigint, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.reserve_retry_capacity(uuid, bigint, bigint, timestamptz)
  TO knowledge_api;

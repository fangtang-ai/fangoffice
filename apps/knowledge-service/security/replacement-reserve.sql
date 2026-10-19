CREATE FUNCTION knowledge.reserve_replacement_capacity(
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
  next_version knowledge.kb_versions%ROWTYPE;
  base_version knowledge.kb_versions%ROWTYPE;
  base_build knowledge.kb_builds%ROWTYPE;
  reservation_row knowledge.kb_reservations%ROWTYPE;
  has_reservation boolean;
  delta_bytes bigint;
  delta_chunks bigint;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_operation IS NULL OR requested_chunks IS NULL OR requested_chunks < 0
     OR requested_physical_bytes IS NULL OR requested_physical_bytes < 0
     OR requested_expiry IS NULL OR NOT isfinite(requested_expiry)
     OR requested_expiry <= clock_timestamp() THEN
    RETURN 'INVALID_REQUEST';
  END IF;

  -- 所有替换信用在同owner的Quota锁下判断，锁序与首次准入一致，Build最后锁定。
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
  IF document_row.space_id <> space_row.id OR document_row.active_build_id IS NULL
     OR document_row.active_version_id IS NULL THEN RETURN 'VERSION_CONFLICT'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF operation_row.document_id <> document_row.id
     OR operation_row.expected_generation <> document_row.generation THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF operation_row.kind <> 'replace' OR operation_row.phase <> 'queued'
     OR operation_row.target_version_id IS NULL
     OR operation_row.target_version_id = document_row.active_version_id THEN RETURN 'FORBIDDEN'; END IF;

  SELECT * INTO reservation_row FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND operation_id = requested_operation FOR UPDATE;
  has_reservation := FOUND;
  IF has_reservation AND (reservation_row.state <> 'held'
     OR reservation_row.expires_at <= clock_timestamp()) THEN RETURN 'FORBIDDEN'; END IF;
  -- live-operation唯一约束不覆盖终态但尚未收敛的held负债，仍须显式拒绝第二份信用。
  IF EXISTS (SELECT 1 FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND document_id = document_row.id
      AND operation_id <> requested_operation AND state = 'held') THEN RETURN 'VERSION_CONFLICT'; END IF;

  SELECT * INTO base_build FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND id = document_row.active_build_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF base_build.document_id <> document_row.id
     OR base_build.version_id <> document_row.active_version_id
     OR base_build.status <> 'sealed' OR base_build.sealed_at IS NULL
     OR base_build.gc_state <> 'live' OR base_build.purged_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO base_version FROM knowledge.kb_versions
    WHERE owner_id = principal_owner AND document_id = document_row.id
      AND id = document_row.active_version_id FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO next_version FROM knowledge.kb_versions
    WHERE owner_id = principal_owner AND document_id = document_row.id
      AND id = operation_row.target_version_id FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF base_version.gc_state <> 'live' OR base_version.purged_at IS NOT NULL
     OR next_version.gc_state <> 'live' OR next_version.purged_at IS NOT NULL
     OR (base_version.retain_until IS NOT NULL AND base_version.retain_until <= clock_timestamp())
     OR (next_version.retain_until IS NOT NULL AND next_version.retain_until <= clock_timestamp()) THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF requested_physical_bytes < next_version.size_bytes THEN RETURN 'INVALID_REQUEST'; END IF;
  IF quota_row.active_files < 1 OR quota_row.active_bytes < base_version.size_bytes
     OR quota_row.active_chunks < base_build.chunk_count THEN RETURN 'VERSION_CONFLICT'; END IF;

  delta_bytes := GREATEST(next_version.size_bytes - base_version.size_bytes, 0::bigint);
  delta_chunks := GREATEST(requested_chunks - base_build.chunk_count, 0::bigint);
  IF has_reservation THEN
    IF reservation_row.document_id <> document_row.id
       OR reservation_row.expected_generation <> document_row.generation
       OR reservation_row.base_version_id IS DISTINCT FROM base_version.id
       OR reservation_row.base_build_id IS DISTINCT FROM base_build.id
       OR reservation_row.reserved_files <> 0 OR reservation_row.reserved_bytes <> delta_bytes
       OR reservation_row.reserved_chunks <> delta_chunks
       OR reservation_row.projected_chunks IS DISTINCT FROM requested_chunks
       OR reservation_row.physical_reserved_bytes <> requested_physical_bytes
       OR reservation_row.expires_at <> requested_expiry
       OR document_row.desired_operation_id IS DISTINCT FROM requested_operation
       OR document_row.desired_version_id IS DISTINCT FROM next_version.id THEN RETURN 'VERSION_CONFLICT'; END IF;
    RETURN 'REPLAY';
  END IF;

  -- 全维不增的整改可以越过降级后的逻辑上限，但绝不能借出负增量或绕过物理硬上限。
  IF ((delta_bytes > 0 OR delta_chunks > 0) AND (
       quota_row.active_files::numeric + quota_row.reserved_files > quota_row.limit_files
       OR quota_row.active_bytes::numeric + quota_row.reserved_bytes + delta_bytes > quota_row.limit_bytes
       OR quota_row.active_chunks::numeric + quota_row.reserved_chunks + delta_chunks > quota_row.limit_chunks))
     OR quota_row.physical_accounted_bytes::numeric + quota_row.physical_reserved_bytes
          + requested_physical_bytes > quota_row.physical_limit_bytes THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  IF requested_expiry <= clock_timestamp() THEN RETURN 'INVALID_REQUEST'; END IF;

  UPDATE knowledge.kb_quotas
    SET reserved_bytes = reserved_bytes + delta_bytes,
        reserved_chunks = reserved_chunks + delta_chunks,
        physical_reserved_bytes = physical_reserved_bytes + requested_physical_bytes,
        updated_at = clock_timestamp()
    WHERE owner_id = principal_owner;
  INSERT INTO knowledge.kb_reservations
    (owner_id, operation_id, document_id, base_version_id, base_build_id, expected_generation,
     reserved_files, reserved_bytes, reserved_chunks, projected_chunks, physical_reserved_bytes, expires_at)
    VALUES (principal_owner, requested_operation, document_row.id, base_version.id, base_build.id,
            document_row.generation, 0, delta_bytes, delta_chunks, requested_chunks,
            requested_physical_bytes, requested_expiry);
  UPDATE knowledge.kb_documents
    SET desired_operation_id = requested_operation, desired_version_id = next_version.id
    WHERE owner_id = principal_owner AND id = document_row.id;
  RETURN 'RESERVED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.reserve_replacement_capacity(uuid, bigint, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.reserve_replacement_capacity(uuid, bigint, bigint, timestamptz)
  TO knowledge_api;

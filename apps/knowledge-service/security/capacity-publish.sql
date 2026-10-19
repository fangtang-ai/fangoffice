-- 成功发布的容量转正与storage事实必须共用一个窄事务入口。
-- 本切片不把物理投影当作实测磁盘量，也不伪造网站资金/queue完成事实。
CREATE FUNCTION knowledge.publish_reserved_build(
  requested_owner text, requested_document uuid, requested_operation uuid,
  requested_version uuid, requested_build uuid, requested_profile uuid
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
  reservation_row knowledge.kb_reservations%ROWTYPE;
  build_row knowledge.kb_builds%ROWTYPE;
  base_build knowledge.kb_builds%ROWTYPE;
  version_row knowledge.kb_versions%ROWTYPE;
  base_version knowledge.kb_versions%ROWTYPE;
  last_event knowledge.kb_metering_events%ROWTYPE;
  base_files bigint := 0;
  base_bytes bigint := 0;
  base_chunks bigint := 0;
  projection bigint;
  next_files numeric;
  next_bytes numeric;
  next_chunks numeric;
  next_sequence bigint := 1;
  event_key text;
  published_at timestamptz;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_owner IS DISTINCT FROM principal_owner THEN RETURN 'NOT_FOUND'; END IF;
  IF requested_document IS NULL OR requested_operation IS NULL OR requested_version IS NULL
     OR requested_build IS NULL OR requested_profile IS NULL THEN RETURN 'INVALID_REQUEST'; END IF;

  -- 与准入/取消共用锁序，不再从Document倒锁Quota；等待后读取最新事实。
  SELECT * INTO quota_row FROM knowledge.kb_quotas
    WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = requested_document;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO space_row FROM knowledge.kb_spaces
    WHERE owner_id = principal_owner AND id = document_row.space_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = requested_document FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF document_row.space_id <> space_row.id THEN RETURN 'VERSION_CONFLICT'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF operation_row.document_id <> requested_document
     OR operation_row.target_version_id IS DISTINCT FROM requested_version THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO reservation_row FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND operation_id = requested_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF reservation_row.document_id <> requested_document
     OR reservation_row.expected_generation <> operation_row.expected_generation THEN RETURN 'VERSION_CONFLICT'; END IF;

  -- 替换基底与新构建按ID排序取锁，保持旧活动快照及派生物不被本操作改写。
  PERFORM id FROM knowledge.kb_builds WHERE owner_id = principal_owner
    AND id IN (requested_build, reservation_row.base_build_id) ORDER BY id FOR UPDATE;
  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND id = requested_build;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF (build_row.document_id, build_row.operation_id, build_row.version_id, build_row.index_profile_id)
     IS DISTINCT FROM (requested_document, requested_operation, requested_version, requested_profile)
     OR build_row.expected_generation <> operation_row.expected_generation THEN RETURN 'NOT_FOUND'; END IF;
  event_key := 'capacity:publish:' || requested_operation::text;

  -- 已提交结果按Operation事件及获胜Build重放；不改后续的新desired/active。
  IF reservation_row.state = 'applied' THEN
    IF operation_row.phase = 'ready' AND EXISTS (
      SELECT 1 FROM knowledge.kb_metering_events WHERE owner_id = principal_owner
        AND id = requested_operation AND logical_event_key = event_key
        AND subject_key = requested_build::text AND event_type = 'capacity_change'
    ) THEN RETURN 'REPLAY'; END IF;
    RETURN 'VERSION_CONFLICT';
  END IF;
  IF reservation_row.state <> 'held' OR reservation_row.expires_at <= clock_timestamp()
     OR operation_row.kind NOT IN ('upload', 'replace')
     OR operation_row.phase NOT IN ('queued', 'parsing', 'indexing', 'publishing') THEN RETURN 'FORBIDDEN'; END IF;
  IF quota_row.owner_state <> 'active' OR space_row.state <> 'active'
     OR space_row.deleted_at IS NOT NULL OR document_row.deleted_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  IF quota_row.policy_revision IS NULL OR quota_row.limit_files IS NULL
     OR quota_row.limit_bytes IS NULL OR quota_row.limit_chunks IS NULL
     OR quota_row.active_index_profile_id IS NULL THEN RETURN 'NOT_CONFIGURED'; END IF;
  IF document_row.generation <> operation_row.expected_generation
     OR document_row.generation = 9223372036854775807
     OR document_row.desired_operation_id IS DISTINCT FROM requested_operation
     OR document_row.desired_version_id IS DISTINCT FROM requested_version
     OR reservation_row.base_version_id IS DISTINCT FROM document_row.active_version_id
     OR reservation_row.base_build_id IS DISTINCT FROM document_row.active_build_id THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF build_row.status <> 'sealed' OR build_row.sealed_at IS NULL OR build_row.manifest_hash IS NULL
     OR build_row.gc_state <> 'live' OR build_row.purged_at IS NOT NULL
     OR requested_profile <> quota_row.active_index_profile_id THEN RETURN 'FORBIDDEN'; END IF;

  SELECT * INTO version_row FROM knowledge.kb_versions
    WHERE owner_id = principal_owner AND document_id = requested_document
      AND id = requested_version FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF version_row.upload_operation_id <> requested_operation OR version_row.gc_state <> 'live'
     OR version_row.purged_at IS NOT NULL
     OR (version_row.retain_until IS NOT NULL AND version_row.retain_until <= clock_timestamp()) THEN RETURN 'FORBIDDEN'; END IF;
  IF reservation_row.base_build_id IS NOT NULL THEN
    IF operation_row.kind <> 'replace' THEN RETURN 'VERSION_CONFLICT'; END IF;
    SELECT * INTO base_build FROM knowledge.kb_builds
      WHERE owner_id = principal_owner AND id = reservation_row.base_build_id;
    IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
    SELECT * INTO base_version FROM knowledge.kb_versions
      WHERE owner_id = principal_owner AND document_id = requested_document
        AND id = reservation_row.base_version_id FOR SHARE;
    IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
    IF base_build.document_id <> requested_document OR base_build.version_id <> base_version.id
       OR base_build.status <> 'sealed' OR base_build.gc_state <> 'live' OR base_build.purged_at IS NOT NULL
       OR base_version.gc_state <> 'live' OR base_version.purged_at IS NOT NULL
       OR (base_version.retain_until IS NOT NULL AND base_version.retain_until <= clock_timestamp()) THEN RETURN 'FORBIDDEN'; END IF;
    base_files := 1;
    base_bytes := base_version.size_bytes;
    base_chunks := base_build.chunk_count;
  ELSIF operation_row.kind <> 'upload' THEN RETURN 'VERSION_CONFLICT';
  END IF;
  projection := COALESCE(reservation_row.projected_chunks, reservation_row.reserved_chunks);
  IF build_row.chunk_count > projection THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  IF reservation_row.reserved_files <> 1 - base_files
     OR reservation_row.reserved_bytes <> GREATEST(version_row.size_bytes - base_bytes, 0::bigint)
     OR reservation_row.reserved_chunks <> GREATEST(projection - base_chunks, 0::bigint)
     OR reservation_row.physical_reserved_bytes < version_row.size_bytes
     OR quota_row.active_files < base_files OR quota_row.active_bytes < base_bytes
     OR quota_row.active_chunks < base_chunks
     OR quota_row.reserved_files < reservation_row.reserved_files
     OR quota_row.reserved_bytes < reservation_row.reserved_bytes
     OR quota_row.reserved_chunks < reservation_row.reserved_chunks
     OR quota_row.physical_reserved_bytes < reservation_row.physical_reserved_bytes THEN RETURN 'VERSION_CONFLICT'; END IF;

  -- 正净增预留不能作为实际活动量；按新实况减旧活动一次交换，余下预留仍计入上限。
  next_files := quota_row.active_files::numeric - base_files + 1;
  next_bytes := quota_row.active_bytes::numeric - base_bytes + version_row.size_bytes;
  next_chunks := quota_row.active_chunks::numeric - base_chunks + build_row.chunk_count;
  IF next_files > 9223372036854775807 OR next_bytes > 9223372036854775807 OR next_chunks > 9223372036854775807
     OR ((base_files = 0 OR version_row.size_bytes > base_bytes OR build_row.chunk_count > base_chunks) AND (
       next_files + quota_row.reserved_files - reservation_row.reserved_files > quota_row.limit_files
       OR next_bytes + quota_row.reserved_bytes - reservation_row.reserved_bytes > quota_row.limit_bytes
       OR next_chunks + quota_row.reserved_chunks - reservation_row.reserved_chunks > quota_row.limit_chunks))
     OR quota_row.physical_accounted_bytes::numeric + quota_row.physical_reserved_bytes > quota_row.physical_limit_bytes THEN
    RETURN 'QUOTA_EXCEEDED';
  END IF;

  -- owner序号在Quota锁下分配；拒绝历史容量断链/溢出，不通过钳零掩盖坏账。
  SELECT * INTO last_event FROM knowledge.kb_metering_events
    WHERE owner_id = principal_owner AND event_type = 'capacity_change' ORDER BY sequence DESC LIMIT 1;
  IF FOUND THEN
    IF last_event.active_bytes_after <> quota_row.active_bytes OR last_event.sequence = 9223372036854775807 THEN
      RETURN 'VERSION_CONFLICT';
    END IF;
    next_sequence := last_event.sequence + 1;
  ELSIF quota_row.active_bytes <> 0 THEN RETURN 'VERSION_CONFLICT';
  END IF;
  IF EXISTS (SELECT 1 FROM knowledge.kb_metering_events WHERE owner_id = principal_owner
    AND (id = requested_operation OR logical_event_key = event_key)) THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF reservation_row.expires_at <= clock_timestamp() THEN RETURN 'FORBIDDEN'; END IF;
  published_at := GREATEST(clock_timestamp(), last_event.occurred_at);

  UPDATE knowledge.kb_operations SET phase = 'publishing', updated_at = published_at
    WHERE owner_id = principal_owner AND id = requested_operation;
  UPDATE knowledge.kb_quotas SET active_files = next_files::bigint, active_bytes = next_bytes::bigint,
      active_chunks = next_chunks::bigint,
      reserved_files = reserved_files - reservation_row.reserved_files,
      reserved_bytes = reserved_bytes - reservation_row.reserved_bytes,
      reserved_chunks = reserved_chunks - reservation_row.reserved_chunks,
      physical_reserved_bytes = physical_reserved_bytes - reservation_row.physical_reserved_bytes,
      physical_accounted_bytes = physical_accounted_bytes + reservation_row.physical_reserved_bytes,
      updated_at = published_at
    WHERE owner_id = principal_owner;
  UPDATE knowledge.kb_reservations SET state = 'applied', closed_at = published_at, updated_at = published_at
    WHERE owner_id = principal_owner AND operation_id = requested_operation;
  INSERT INTO knowledge.kb_metering_events
    (owner_id, id, logical_event_key, event_type, dimension, unit, quantity, usage_source,
     subject_kind, subject_key, sequence, active_bytes_before, active_bytes_after, payer, occurred_at)
    VALUES (principal_owner, requested_operation, event_key, 'capacity_change', 'storage', 'bytes',
            next_bytes, 'reconciled', 'capacity_change', requested_build::text,
            next_sequence, quota_row.active_bytes, next_bytes::bigint, 'platform', published_at);
  UPDATE knowledge.kb_documents SET active_version_id = requested_version, active_build_id = requested_build,
      desired_operation_id = NULL, desired_version_id = NULL, generation = generation + 1, updated_at = published_at
    WHERE owner_id = principal_owner AND id = requested_document;
  UPDATE knowledge.kb_operations SET phase = 'ready', updated_at = published_at
    WHERE owner_id = principal_owner AND id = requested_operation;
  RETURN 'PUBLISHED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.publish_reserved_build(text, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.publish_reserved_build(text, uuid, uuid, uuid, uuid, uuid) TO knowledge_worker;
REVOKE UPDATE (active_version_id, active_build_id, generation) ON knowledge.kb_documents FROM knowledge_worker;

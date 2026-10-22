-- E1仅准备元数据/上传意图；没有Version、队列、模型调用或客户扣费。
CREATE FUNCTION knowledge.create_space(requested_id uuid, requested_title text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_row knowledge.kb_quotas%ROWTYPE;
  existing knowledge.kb_spaces%ROWTYPE;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_id IS NULL OR requested_title IS NULL OR btrim(requested_title) = ''
     OR char_length(requested_title) > 200 THEN RETURN 'INVALID_REQUEST'; END IF;
  SELECT * INTO quota_row FROM knowledge.kb_quotas WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF quota_row.owner_state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
  IF quota_row.policy_revision IS NULL THEN RETURN 'NOT_CONFIGURED'; END IF;
  SELECT * INTO existing FROM knowledge.kb_spaces WHERE owner_id = principal_owner AND id = requested_id;
  IF FOUND THEN
    IF existing.title = requested_title AND existing.state = 'active' THEN RETURN 'REPLAY'; END IF;
    RETURN 'VERSION_CONFLICT';
  END IF;
  INSERT INTO knowledge.kb_spaces(owner_id,id,title) VALUES(principal_owner,requested_id,requested_title);
  RETURN 'CREATED';
END;
$function$;

CREATE FUNCTION knowledge.create_document(requested_id uuid, requested_space uuid,
  requested_title text, requested_tags text[], requested_purpose text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_row knowledge.kb_quotas%ROWTYPE;
  space_row knowledge.kb_spaces%ROWTYPE;
  existing knowledge.kb_documents%ROWTYPE;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_id IS NULL OR requested_space IS NULL OR requested_title IS NULL
     OR btrim(requested_title) = '' OR char_length(requested_title) > 200
     OR requested_purpose IS NULL OR requested_purpose NOT IN ('facts','style','template')
     OR requested_tags IS NULL OR cardinality(requested_tags) > 20
     OR COALESCE(array_length(requested_tags,1),0) <> cardinality(requested_tags)
     OR EXISTS(SELECT 1 FROM unnest(requested_tags) tag WHERE tag IS NULL OR btrim(tag) = '' OR char_length(tag) > 50)
     OR cardinality(requested_tags) <> (SELECT count(DISTINCT tag) FROM unnest(requested_tags) tag)
     THEN RETURN 'INVALID_REQUEST'; END IF;
  -- 元数据和上传均先锁Quota，再按Space→Document推进，不能绕过删除/冻结围栏。
  SELECT * INTO quota_row FROM knowledge.kb_quotas WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF quota_row.owner_state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
  IF quota_row.policy_revision IS NULL THEN RETURN 'NOT_CONFIGURED'; END IF;
  SELECT * INTO space_row FROM knowledge.kb_spaces WHERE owner_id = principal_owner AND id = requested_space FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF space_row.state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO existing FROM knowledge.kb_documents WHERE owner_id = principal_owner AND id = requested_id FOR UPDATE;
  IF FOUND THEN
    IF existing.space_id = requested_space AND existing.title = requested_title
       AND existing.tags = requested_tags AND existing.purpose = requested_purpose
       AND existing.deleted_at IS NULL THEN RETURN 'REPLAY'; END IF;
    RETURN 'VERSION_CONFLICT';
  END IF;
  INSERT INTO knowledge.kb_documents(owner_id,id,space_id,title,tags,purpose)
    VALUES(principal_owner,requested_id,requested_space,requested_title,requested_tags,requested_purpose);
  RETURN 'CREATED';
END;
$function$;

CREATE FUNCTION knowledge.prepare_upload(requested_operation uuid, requested_key text,
  requested_space uuid, requested_document uuid, requested_generation bigint,
  requested_bytes bigint, requested_format text, maximum_file_bytes bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_row knowledge.kb_quotas%ROWTYPE;
  space_row knowledge.kb_spaces%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  existing knowledge.kb_operations%ROWTYPE;
  request_hash bytea;
  staging_count bigint;
  missing_sizes bigint;
  pending_files bigint;
  pending_bytes numeric;
  staging_bytes numeric;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_operation IS NULL OR requested_key IS NULL OR btrim(requested_key) = ''
     OR char_length(requested_key) > 128 OR requested_space IS NULL OR requested_document IS NULL
     OR requested_generation IS NULL OR requested_generation < 0 OR requested_bytes IS NULL OR requested_bytes < 1
     OR requested_format IS NULL OR requested_format NOT IN ('txt','md','docx','pdf','xlsx') THEN RETURN 'INVALID_REQUEST'; END IF;
  IF maximum_file_bytes IS NULL OR maximum_file_bytes < 1 THEN RETURN 'NOT_CONFIGURED'; END IF;
  IF requested_bytes > maximum_file_bytes THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  SELECT * INTO quota_row FROM knowledge.kb_quotas WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF quota_row.owner_state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
  IF quota_row.policy_revision IS NULL THEN RETURN 'NOT_CONFIGURED'; END IF;
  SELECT * INTO space_row FROM knowledge.kb_spaces WHERE owner_id = principal_owner AND id = requested_space FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF space_row.state <> 'active' THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents WHERE owner_id = principal_owner
    AND id = requested_document AND space_id = requested_space FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF document_row.deleted_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  request_hash := sha256(convert_to(jsonb_build_object('space',requested_space,'document',requested_document,
    'generation',requested_generation,'bytes',requested_bytes,'format',requested_format)::text,'UTF8'));
  SELECT * INTO existing FROM knowledge.kb_operations WHERE owner_id = principal_owner AND idempotency_key = requested_key;
  IF FOUND THEN
    IF existing.request_hash <> request_hash THEN RETURN 'VERSION_CONFLICT'; END IF;
    IF existing.phase <> 'uploading' OR existing.upload_expires_at IS NULL
       OR existing.upload_expires_at <= clock_timestamp() OR existing.staging_key IS NULL
       OR document_row.generation <> existing.expected_generation
       OR document_row.desired_operation_id IS DISTINCT FROM existing.id THEN RETURN 'VERSION_CONFLICT'; END IF;
    RETURN 'REPLAY';
  END IF;
  IF document_row.generation <> requested_generation OR document_row.active_version_id IS NOT NULL
     OR document_row.desired_operation_id IS NOT NULL
     OR EXISTS(SELECT 1 FROM knowledge.kb_operations WHERE owner_id = principal_owner
       AND (id = requested_operation OR (document_id = requested_document
         AND phase IN ('uploading','queued','parsing','indexing','publishing')))) THEN RETURN 'VERSION_CONFLICT'; END IF;
  -- staging债务按仍持有key的全部操作计算，包括过期/失败/取消；只改状态绝不假装对象已清理。
  -- 部分索引定位本owner，最多检查1001条元数据，超限保守拒绝而不无界扫描历史操作。
  SELECT count(*), count(*) FILTER(WHERE declared_bytes IS NULL),
    count(*) FILTER(WHERE phase = 'uploading'),
    COALESCE(sum(declared_bytes) FILTER(WHERE phase = 'uploading'),0), COALESCE(sum(declared_bytes),0)
    INTO staging_count,missing_sizes,pending_files,pending_bytes,staging_bytes
    FROM (SELECT declared_bytes,phase FROM knowledge.kb_operations WHERE owner_id = principal_owner
      AND staging_key IS NOT NULL ORDER BY id LIMIT 1001) staged;
  IF staging_count > 1000 OR missing_sizes > 0 THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  IF quota_row.active_files + quota_row.reserved_files + pending_files + 1 > quota_row.limit_files
     OR quota_row.active_bytes + quota_row.reserved_bytes + pending_bytes + requested_bytes > quota_row.limit_bytes
     OR quota_row.physical_accounted_bytes + quota_row.physical_reserved_bytes + staging_bytes + requested_bytes
       > quota_row.physical_limit_bytes THEN RETURN 'QUOTA_EXCEEDED'; END IF;
  INSERT INTO knowledge.kb_operations(owner_id,id,document_id,idempotency_key,request_hash,kind,phase,
    expected_generation,upload_expires_at,staging_key,declared_bytes)
    VALUES(principal_owner,requested_operation,requested_document,requested_key,request_hash,'upload','uploading',
      requested_generation,clock_timestamp() + interval '15 minutes',
      'staging/' || encode(sha256(convert_to(principal_owner,'UTF8')),'hex') || '/' || requested_operation::text,requested_bytes);
  UPDATE knowledge.kb_documents SET desired_operation_id = requested_operation,updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND id = requested_document;
  RETURN 'PREPARED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.create_space(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION knowledge.create_document(uuid,uuid,text,text[],text) FROM PUBLIC;
REVOKE ALL ON FUNCTION knowledge.prepare_upload(uuid,text,uuid,uuid,bigint,bigint,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.create_space(uuid,text) TO knowledge_api;
GRANT EXECUTE ON FUNCTION knowledge.create_document(uuid,uuid,text,text[],text) TO knowledge_api;
GRANT EXECUTE ON FUNCTION knowledge.prepare_upload(uuid,text,uuid,uuid,bigint,bigint,text,bigint) TO knowledge_api;

-- worker短事务与准入/取消/发布共用父锁序；不得在持锁事务内解析文档或调用外部服务。
CREATE FUNCTION knowledge.lock_build_lifecycle(
  requested_owner text, requested_document uuid, requested_operation uuid, requested_build uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  document_row knowledge.kb_documents%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
  base_build uuid;
  locked_space uuid;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_owner IS DISTINCT FROM principal_owner THEN RETURN 'NOT_FOUND'; END IF;
  IF requested_document IS NULL OR requested_operation IS NULL THEN RETURN 'INVALID_REQUEST'; END IF;

  -- 同owner的短写事务串行，第一次就取后续发布所需的最强锁，避免SHARE升级死锁。
  PERFORM owner_id FROM knowledge.kb_quotas WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = requested_document;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT id INTO locked_space FROM knowledge.kb_spaces
    WHERE owner_id = principal_owner AND id = document_row.space_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = requested_document FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF document_row.space_id <> locked_space THEN RETURN 'VERSION_CONFLICT'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF operation_row.document_id <> requested_document THEN RETURN 'NOT_FOUND'; END IF;
  SELECT base_build_id INTO base_build FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND operation_id = requested_operation FOR UPDATE;
  PERFORM id FROM knowledge.kb_builds WHERE owner_id = principal_owner
    AND id IN (base_build, requested_build) ORDER BY id FOR UPDATE;
  RETURN 'LOCKED';
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.lock_build_lifecycle(text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.lock_build_lifecycle(text,uuid,uuid,uuid) TO knowledge_worker;

CREATE OR REPLACE FUNCTION knowledge.guard_build_cancel_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_user = 'knowledge_worker' THEN
    IF knowledge.lock_build_lifecycle(NEW.owner_id, NEW.document_id, NEW.operation_id, NULL) <> 'LOCKED' THEN
      RAISE EXCEPTION 'Build claim requires its locked owner and operation'
        USING ERRCODE = '23514', CONSTRAINT = 'kb_build_cancel_fence';
    END IF;
  END IF;
  PERFORM id FROM knowledge.kb_operations
    WHERE owner_id = NEW.owner_id AND id = NEW.operation_id
      AND phase IN ('queued', 'parsing', 'indexing') FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Build claim requires an uncancelled operation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_cancel_fence';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.guard_build_cancel_fence() FROM PUBLIC;

CREATE OR REPLACE FUNCTION knowledge.guard_build_content()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  parent knowledge.kb_builds%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Build content is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_content_immutable';
  END IF;
  IF current_user = 'knowledge_worker' THEN
    SELECT * INTO parent FROM knowledge.kb_builds
      WHERE owner_id = NEW.owner_id AND id = NEW.build_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Build is not open for content insertion'
        USING ERRCODE = '23514', CONSTRAINT = 'kb_build_writable';
    END IF;
    IF knowledge.lock_build_lifecycle(NEW.owner_id, parent.document_id, parent.operation_id, parent.id) <> 'LOCKED' THEN
      RAISE EXCEPTION 'Build content requires its locked owner and operation'
        USING ERRCODE = '23514', CONSTRAINT = 'kb_build_writable';
    END IF;
    -- 父锁等待后必须重新读取Build状态；先前的无锁快照只用于定位不可变身份。
    SELECT * INTO parent FROM knowledge.kb_builds
      WHERE owner_id = NEW.owner_id AND id = NEW.build_id;
  ELSE
    SELECT * INTO parent FROM knowledge.kb_builds
      WHERE owner_id = NEW.owner_id AND id = NEW.build_id FOR SHARE;
  END IF;
  IF NOT FOUND OR parent.status <> 'building' OR parent.gc_state <> 'live'
     OR parent.sealed_at IS NOT NULL OR parent.manifest IS NOT NULL
     OR parent.manifest_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Build is not open for content insertion'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_writable';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.guard_build_content() FROM PUBLIC;

CREATE FUNCTION knowledge.seal_locked_build(
  requested_owner text, requested_build uuid, requested_manifest jsonb, requested_time timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  build_row knowledge.kb_builds%ROWTYPE;
  lock_status text;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_owner IS DISTINCT FROM principal_owner THEN RETURN 'NOT_FOUND'; END IF;
  IF requested_build IS NULL OR requested_time IS NULL OR requested_manifest IS NULL
     OR jsonb_typeof(requested_manifest) <> 'object' THEN RETURN 'INVALID_REQUEST'; END IF;
  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND id = requested_build;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  lock_status := knowledge.lock_build_lifecycle(
    principal_owner, build_row.document_id, build_row.operation_id, requested_build);
  IF lock_status <> 'LOCKED' THEN RETURN lock_status; END IF;
  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND id = requested_build;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF build_row.status <> 'building' OR build_row.gc_state <> 'live' THEN RETURN 'FORBIDDEN'; END IF;
  UPDATE knowledge.kb_builds SET status = 'sealed', sealed_at = requested_time, manifest = requested_manifest
    WHERE owner_id = principal_owner AND id = requested_build;
  RETURN 'SEALED';
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.seal_locked_build(text,uuid,jsonb,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.seal_locked_build(text,uuid,jsonb,timestamptz) TO knowledge_worker;

-- 行触发器在UPDATE取得行锁后才执行，无法修复调用方已形成的倒序；撤销旁路而非仅加可选helper。
REVOKE UPDATE (manifest, source_unit_count, chunk_count, embedding_count, sealed_at, status)
  ON knowledge.kb_builds FROM knowledge_worker;

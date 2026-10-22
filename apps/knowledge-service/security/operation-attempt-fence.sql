-- 修正已应用的attempt绑定增量，保留原SQL与回执；不依赖pgboss内部表。
CREATE FUNCTION knowledge.has_current_build_attempt(requested_owner text, requested_build uuid)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM knowledge.kb_builds build
    JOIN knowledge.kb_operations operation
      ON operation.owner_id = build.owner_id AND operation.id = build.operation_id
    JOIN knowledge.kb_billing_receipts receipt
      ON receipt.owner_id = operation.owner_id AND receipt.id = operation.current_receipt_id
    WHERE build.owner_id = requested_owner AND build.id = requested_build
      AND operation.current_build_id = build.id AND operation.current_job_id = build.job_id
      AND operation.current_retry_count = build.retry_count
      AND operation.document_id = build.document_id
      AND operation.target_version_id = build.version_id
      AND operation.expected_generation = build.expected_generation
      AND operation.phase IN ('queued', 'parsing', 'indexing', 'publishing')
      AND receipt.status = 'pending'
  );
$function$;
REVOKE ALL ON FUNCTION knowledge.has_current_build_attempt(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.has_current_build_attempt(text,uuid) TO knowledge_worker;

CREATE OR REPLACE FUNCTION knowledge.bind_operation_attempt(
  requested_owner text, requested_operation uuid, requested_build uuid,
  requested_job uuid, requested_retry integer, requested_receipt uuid
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
  receipt_status text;
  lock_status text;
  bound uuid;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_owner IS DISTINCT FROM principal_owner THEN RETURN 'NOT_FOUND'; END IF;
  IF requested_operation IS NULL OR requested_build IS NULL OR requested_job IS NULL
     OR requested_retry IS NULL OR requested_retry < 0 OR requested_receipt IS NULL THEN
    RETURN 'INVALID_REQUEST';
  END IF;
  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND id = requested_build;
  IF NOT FOUND OR build_row.operation_id <> requested_operation THEN RETURN 'NOT_FOUND'; END IF;
  -- 窄入口可被直接调用，必须自行取父锁；无锁读取只定位不可变Build身份。
  lock_status := knowledge.lock_build_lifecycle(
    principal_owner, build_row.document_id, requested_operation, requested_build);
  IF lock_status <> 'LOCKED' THEN RETURN lock_status; END IF;
  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND id = requested_build;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF build_row.status <> 'building' OR build_row.gc_state <> 'live'
     OR build_row.job_id <> requested_job OR build_row.retry_count <> requested_retry THEN
    RETURN 'FORBIDDEN';
  END IF;
  -- Receipt仅是本地同owner待处理事实，不代表网站资金授权或真实扣款。
  SELECT status INTO receipt_status FROM knowledge.kb_billing_receipts
    WHERE owner_id = principal_owner AND id = requested_receipt FOR SHARE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF receipt_status <> 'pending' THEN RETURN 'FORBIDDEN'; END IF;
  UPDATE knowledge.kb_operations
     SET current_job_id = requested_job, current_retry_count = requested_retry,
         current_build_id = requested_build, current_receipt_id = requested_receipt
   WHERE owner_id = principal_owner AND id = requested_operation
     AND document_id = build_row.document_id AND target_version_id = build_row.version_id
     AND expected_generation = build_row.expected_generation
     AND phase IN ('queued', 'parsing', 'indexing')
     AND ((current_job_id IS NULL AND current_retry_count IS NULL
           AND current_build_id IS NULL AND current_receipt_id IS NULL)
       OR (current_job_id = requested_job AND current_retry_count = requested_retry
           AND current_build_id = requested_build AND current_receipt_id = requested_receipt))
  RETURNING current_build_id INTO bound;
  IF bound IS NULL THEN RETURN 'FORBIDDEN'; END IF;
  RETURN 'BOUND';
END;
$function$;

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
    PERFORM id FROM knowledge.kb_operations
      WHERE owner_id = NEW.owner_id AND id = NEW.operation_id
        AND phase IN ('queued', 'parsing', 'indexing')
        AND (current_build_id IS NULL OR (current_build_id = NEW.id
          AND current_job_id = NEW.job_id AND current_retry_count = NEW.retry_count));
  ELSE
    PERFORM id FROM knowledge.kb_operations
      WHERE owner_id = NEW.owner_id AND id = NEW.operation_id
        AND phase IN ('queued', 'parsing', 'indexing') FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Build claim requires an uncancelled, unclaimed operation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_cancel_fence';
  END IF;
  RETURN NEW;
END;
$function$;

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
    SELECT * INTO parent FROM knowledge.kb_builds
      WHERE owner_id = NEW.owner_id AND id = NEW.build_id;
    IF NOT knowledge.has_current_build_attempt(NEW.owner_id, NEW.build_id) THEN
      RAISE EXCEPTION 'Build content requires the current attempt'
        USING ERRCODE = '23514', CONSTRAINT = 'kb_build_current_attempt';
    END IF;
  ELSE
    SELECT * INTO parent FROM knowledge.kb_builds
      WHERE owner_id = NEW.owner_id AND id = NEW.build_id FOR SHARE;
  END IF;
  IF parent.id IS NULL OR parent.status <> 'building' OR parent.gc_state <> 'live'
     OR parent.sealed_at IS NOT NULL OR parent.manifest IS NOT NULL
     OR parent.manifest_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Build is not open for content insertion'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_writable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION knowledge.seal_locked_build(
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
  IF build_row.status <> 'building' OR build_row.gc_state <> 'live'
     OR NOT knowledge.has_current_build_attempt(principal_owner, requested_build) THEN
    RETURN 'FORBIDDEN';
  END IF;
  UPDATE knowledge.kb_builds SET status = 'sealed', sealed_at = requested_time, manifest = requested_manifest
    WHERE owner_id = principal_owner AND id = requested_build;
  RETURN 'SEALED';
END;
$function$;

CREATE OR REPLACE FUNCTION knowledge.guard_document_publish()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  build knowledge.kb_builds%ROWTYPE;
  operation knowledge.kb_operations%ROWTYPE;
  space knowledge.kb_spaces%ROWTYPE;
  quota knowledge.kb_quotas%ROWTYPE;
BEGIN
  IF (NEW.active_version_id, NEW.active_build_id, NEW.generation)
     IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id, OLD.generation) THEN
    RETURN NEW;
  END IF;
  -- 恢复取消的事实分支，不能用旧版发布门覆盖已经验收的撤销协议。
  IF current_user = 'knowledge_migrator'
     AND (NEW.active_version_id, NEW.active_build_id)
         IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     AND NEW.generation = OLD.generation + 1
     AND OLD.desired_operation_id IS NOT NULL AND OLD.desired_version_id IS NOT NULL
     AND NEW.desired_operation_id IS NULL AND NEW.desired_version_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
     AND knowledge.has_cancelled_reservation(
       OLD.owner_id, OLD.id, OLD.desired_operation_id, OLD.desired_version_id, OLD.generation
     ) THEN
    RETURN NEW;
  END IF;
  IF (NEW.active_version_id, NEW.active_build_id)
     IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     OR NEW.generation <> OLD.generation + 1
     OR (NEW.title, NEW.purpose, NEW.tags, NEW.space_id, NEW.next_version_no,
         NEW.deleted_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.title, OLD.purpose, OLD.tags, OLD.space_id, OLD.next_version_no,
         OLD.deleted_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Active pointer changes must publish the desired build'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  IF OLD.desired_operation_id IS NULL OR OLD.desired_version_id IS NULL THEN
    RAISE EXCEPTION 'Publication requires a pending desired operation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO quota FROM knowledge.kb_quotas WHERE owner_id = OLD.owner_id;
  IF NOT FOUND OR quota.owner_state <> 'active' THEN
    RAISE EXCEPTION 'Publication requires an active owner'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO space FROM knowledge.kb_spaces
    WHERE owner_id = OLD.owner_id AND id = OLD.space_id;
  IF NOT FOUND OR space.state <> 'active' OR space.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Publication requires an active space'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO build FROM knowledge.kb_builds
    WHERE owner_id = OLD.owner_id AND id = NEW.active_build_id;
  IF NOT FOUND OR build.document_id <> OLD.id
     OR build.version_id IS DISTINCT FROM NEW.active_version_id
     OR build.operation_id IS DISTINCT FROM OLD.desired_operation_id
     OR build.version_id IS DISTINCT FROM OLD.desired_version_id
     OR build.status <> 'sealed' OR build.sealed_at IS NULL
     OR build.gc_state <> 'live' OR build.purged_at IS NOT NULL
     OR build.expected_generation <> OLD.generation
     OR build.index_profile_id IS DISTINCT FROM quota.active_index_profile_id THEN
    RAISE EXCEPTION 'Publication requires the desired sealed build at the current generation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  SELECT * INTO operation FROM knowledge.kb_operations
    WHERE owner_id = OLD.owner_id AND id = OLD.desired_operation_id;
  IF NOT FOUND OR operation.kind NOT IN ('upload', 'replace', 'rebuild')
     OR operation.phase NOT IN ('indexing', 'publishing') THEN
    RAISE EXCEPTION 'Publication requires the desired operation inside the publish window'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  IF NOT knowledge.has_current_build_attempt(OLD.owner_id, build.id) THEN
    RAISE EXCEPTION 'Publication requires the current attempt and its pending receipt'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;
  RETURN NEW;
END;
$function$;

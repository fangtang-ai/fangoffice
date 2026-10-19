-- B5 受控取消：逻辑释放必须和意图撤销、代数推进及writer封停同事务。
-- 原文/失败构建尚未GC，物理reserved/accounted一律保留，不能当作空闲预算。
CREATE FUNCTION knowledge.cancel_capacity_reservation(requested_operation uuid)
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
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_operation IS NULL THEN RETURN 'INVALID_REQUEST'; END IF;

  -- 与准入统一锁序；冻结/降级不妨碍收敛已有负债，也不要求预留仍未到期。
  SELECT * INTO quota_row FROM knowledge.kb_quotas
    WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = operation_row.document_id;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO space_row FROM knowledge.kb_spaces
    WHERE owner_id = principal_owner AND id = document_row.space_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = principal_owner AND id = operation_row.document_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF document_row.space_id <> space_row.id THEN RETURN 'VERSION_CONFLICT'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO reservation_row FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND operation_id = requested_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF operation_row.document_id <> document_row.id
     OR reservation_row.document_id <> document_row.id THEN RETURN 'VERSION_CONFLICT'; END IF;

  -- 旧取消的精确重放不检查/改写后来建立的新意图，更不能再减一次计数。
  IF reservation_row.state = 'released' AND operation_row.phase = 'cancelled' THEN
    RETURN 'REPLAY';
  END IF;
  IF reservation_row.state <> 'held' OR operation_row.kind NOT IN ('upload', 'replace')
     OR operation_row.phase NOT IN ('queued', 'parsing', 'indexing', 'cancelled') THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF document_row.deleted_at IS NOT NULL THEN RETURN 'FORBIDDEN'; END IF;
  IF document_row.desired_operation_id IS DISTINCT FROM requested_operation
     OR document_row.desired_version_id IS DISTINCT FROM operation_row.target_version_id
     OR operation_row.target_version_id IS NULL
     OR operation_row.expected_generation <> document_row.generation
     OR reservation_row.expected_generation <> document_row.generation
     OR reservation_row.base_version_id IS DISTINCT FROM document_row.active_version_id
     OR reservation_row.base_build_id IS DISTINCT FROM document_row.active_build_id
     OR document_row.generation = 9223372036854775807 THEN RETURN 'VERSION_CONFLICT'; END IF;
  IF quota_row.reserved_files < reservation_row.reserved_files
     OR quota_row.reserved_bytes < reservation_row.reserved_bytes
     OR quota_row.reserved_chunks < reservation_row.reserved_chunks THEN RETURN 'VERSION_CONFLICT'; END IF;

  -- claim持Operation共享锁，产物写持Build共享锁；按ID取独占锁后才封停，
  -- 因而既不会漏掉已认领的attempt，也不会与仍在追加的writer交错释放。
  PERFORM id FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND operation_id = requested_operation
    ORDER BY id FOR UPDATE;
  UPDATE knowledge.kb_builds SET status = 'invalidated'
    WHERE owner_id = principal_owner AND operation_id = requested_operation
      AND status IN ('building', 'sealed');
  UPDATE knowledge.kb_quotas
    SET reserved_files = reserved_files - reservation_row.reserved_files,
        reserved_bytes = reserved_bytes - reservation_row.reserved_bytes,
        reserved_chunks = reserved_chunks - reservation_row.reserved_chunks,
        updated_at = clock_timestamp()
    WHERE owner_id = principal_owner;
  UPDATE knowledge.kb_reservations SET state = 'released', closed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND operation_id = requested_operation AND state = 'held';
  UPDATE knowledge.kb_operations SET phase = 'cancelled', updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND id = requested_operation;
  UPDATE knowledge.kb_documents SET desired_operation_id = NULL, desired_version_id = NULL,
      generation = generation + 1, updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND id = document_row.id;
  RETURN 'CANCELLED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.cancel_capacity_reservation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.cancel_capacity_reservation(uuid) TO knowledge_api;

CREATE FUNCTION knowledge.guard_cancelled_operation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.phase = 'cancelled' AND NEW.phase <> 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled operation cannot reopen'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_operation_cancelled';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.guard_cancelled_operation() FROM PUBLIC;
CREATE TRIGGER kb_operation_cancelled BEFORE UPDATE OF phase ON knowledge.kb_operations
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_cancelled_operation();

CREATE FUNCTION knowledge.guard_build_cancel_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  -- 仅FK存在性不足以防取消竞态；SHARE等待取消提交后重新判断phase。
  -- worker已有发布窗口的phase列UPDATE权，不增授任何底表权限。
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
CREATE TRIGGER kb_build_cancel_fence BEFORE INSERT ON knowledge.kb_builds
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_cancel_fence();

-- 用独立增量扩展原发布门，不重写任何已经应用的SQL或迁移快照。
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

  -- 只有窄definer取消路径可推进代数但保留active；不是可由客户端设置的GUC旁路。
  -- 必须已经关闭逻辑预留、取消operation、封停全部产物，再撤销当前desired。
  IF current_user = 'knowledge_migrator'
     AND (NEW.active_version_id, NEW.active_build_id)
         IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     AND NEW.generation = OLD.generation + 1
     AND OLD.desired_operation_id IS NOT NULL AND OLD.desired_version_id IS NOT NULL
     AND NEW.desired_operation_id IS NULL AND NEW.desired_version_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
     AND EXISTS (SELECT 1 FROM knowledge.kb_operations operation
       JOIN knowledge.kb_reservations reservation ON reservation.owner_id = operation.owner_id
         AND reservation.operation_id = operation.id
       WHERE operation.owner_id = OLD.owner_id AND operation.id = OLD.desired_operation_id
         AND operation.document_id = OLD.id AND operation.target_version_id = OLD.desired_version_id
         AND operation.expected_generation = OLD.generation AND operation.phase = 'cancelled'
         AND operation.kind IN ('upload', 'replace') AND reservation.document_id = OLD.id
         AND reservation.expected_generation = OLD.generation AND reservation.state = 'released'
         AND reservation.closed_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM knowledge.kb_builds
       WHERE owner_id = OLD.owner_id AND operation_id = OLD.desired_operation_id
         AND status IN ('building', 'sealed')) THEN
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
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.guard_document_publish() FROM PUBLIC;

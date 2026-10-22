-- B7 删除墓碑：独立删除意图日志两步确认之后，才允许进入本事务入口。
-- 逻辑计量（active计数与storage事件）在同事务止步；物理负债、原文/版本/
-- 构建对象与派生物全部保留，交由GC与恢复对账清偿，本切片不假装物理删除。
-- 删除操作行与计量事件id由(intent,document)确定性派生，跨节点重放一致；
-- 普通GC/worker没有执行本函数的权限，唯一写入面就是definer本函数。
CREATE FUNCTION knowledge.apply_deletion_intent(
  requested_intent text, requested_scope text,
  requested_space uuid, requested_document uuid
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  quota_row knowledge.kb_quotas%ROWTYPE;
  space_row knowledge.kb_spaces%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  version_row knowledge.kb_versions%ROWTYPE;
  build_row knowledge.kb_builds%ROWTYPE;
  last_event knowledge.kb_metering_events%ROWTYPE;
  scope_kind text := requested_scope;
  scope_space uuid := requested_space;
  scope_document uuid := requested_document;
  raw_bytes bytea;
  request_digest bytea;
  delete_operation uuid;
  delete_idempotency text;
  event_key text;
  now_at timestamptz;
  cur_files bigint;
  cur_bytes bigint;
  cur_chunks bigint;
  cur_res_files bigint;
  cur_res_bytes bigint;
  cur_res_chunks bigint;
  release_files bigint;
  release_bytes bigint;
  release_chunks bigint;
  delete_files bigint;
  delete_bytes bigint;
  delete_chunks bigint;
  event_before bigint;
  event_after bigint;
  next_sequence bigint;
  has_active boolean;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF scope_kind IS NULL OR scope_kind NOT IN ('owner', 'space', 'document')
     OR requested_intent IS NULL
     OR requested_intent !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN 'INVALID_REQUEST';
  END IF;
  IF scope_kind = 'space' AND scope_space IS NULL THEN RETURN 'INVALID_REQUEST'; END IF;
  IF scope_kind = 'document' AND (scope_space IS NULL OR scope_document IS NULL) THEN
    RETURN 'INVALID_REQUEST';
  END IF;

  -- 统一父锁序：Quota→Space→Document→Operation→Reservation→Build。
  SELECT * INTO quota_row FROM knowledge.kb_quotas
    WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;

  IF scope_kind = 'document' THEN
    SELECT * INTO document_row FROM knowledge.kb_documents
      WHERE owner_id = principal_owner AND id = scope_document FOR UPDATE;
    IF NOT FOUND OR document_row.space_id IS DISTINCT FROM scope_space THEN
      RETURN 'NOT_FOUND';
    END IF;
    IF document_row.deleted_at IS NOT NULL THEN RETURN 'REPLAY'; END IF;
    scope_space := document_row.space_id;
  END IF;

  IF scope_kind <> 'owner' THEN
    SELECT * INTO space_row FROM knowledge.kb_spaces
      WHERE owner_id = principal_owner AND id = scope_space FOR UPDATE;
    IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
    IF space_row.deleted_at IS NOT NULL THEN RETURN 'REPLAY'; END IF;
  END IF;

  -- 冻结不妨碍收敛既有事实；已删除空间自然跳过（整体重放为REPLAY已在上面拦截）。
  FOR space_row IN
    SELECT * FROM knowledge.kb_spaces
    WHERE owner_id = principal_owner
      AND (scope_kind = 'owner' OR id = scope_space)
      AND deleted_at IS NULL
    ORDER BY id FOR UPDATE
  LOOP
    FOR document_row IN
      SELECT * FROM knowledge.kb_documents
      WHERE owner_id = principal_owner AND space_id = space_row.id AND deleted_at IS NULL
        AND (scope_kind <> 'document' OR id = scope_document)
      ORDER BY id FOR UPDATE
    LOOP
      -- 该文档全部进行中任务先收敛：撤销operation、释放逻辑预留、封停产物。
      PERFORM id FROM knowledge.kb_operations
        WHERE owner_id = principal_owner AND document_id = document_row.id
          AND kind IN ('upload', 'replace', 'rebuild')
          AND phase IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing')
        ORDER BY id FOR UPDATE;
      UPDATE knowledge.kb_operations SET phase = 'cancelled', updated_at = clock_timestamp()
        WHERE owner_id = principal_owner AND document_id = document_row.id
          AND kind IN ('upload', 'replace', 'rebuild')
          AND phase IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing');
      PERFORM operation_id FROM knowledge.kb_reservations
        WHERE owner_id = principal_owner AND operation_id IN (
          SELECT id FROM knowledge.kb_operations
          WHERE owner_id = principal_owner AND document_id = document_row.id
            AND kind IN ('upload', 'replace', 'rebuild'))
        ORDER BY operation_id FOR UPDATE;
      SELECT COALESCE(SUM(reserved_files), 0::bigint), COALESCE(SUM(reserved_bytes), 0::bigint),
             COALESCE(SUM(reserved_chunks), 0::bigint)
        INTO release_files, release_bytes, release_chunks
        FROM knowledge.kb_reservations
        WHERE owner_id = principal_owner AND operation_id IN (
          SELECT id FROM knowledge.kb_operations
          WHERE owner_id = principal_owner AND document_id = document_row.id
            AND kind IN ('upload', 'replace', 'rebuild'))
          AND state = 'held';
      UPDATE knowledge.kb_reservations SET state = 'released', closed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE owner_id = principal_owner AND operation_id IN (
          SELECT id FROM knowledge.kb_operations
          WHERE owner_id = principal_owner AND document_id = document_row.id
            AND kind IN ('upload', 'replace', 'rebuild'))
          AND state = 'held';
      PERFORM id FROM knowledge.kb_builds
        WHERE owner_id = principal_owner AND document_id = document_row.id
        ORDER BY id FOR UPDATE;
      UPDATE knowledge.kb_builds SET status = 'invalidated'
        WHERE owner_id = principal_owner AND document_id = document_row.id
          AND operation_id IN (
            SELECT id FROM knowledge.kb_operations
            WHERE owner_id = principal_owner AND document_id = document_row.id
              AND kind IN ('upload', 'replace', 'rebuild')
              AND phase IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing'))
          AND status IN ('building', 'sealed');

      -- 逻辑计量止步：只扣已发布的active占用，物理负债原样保留。
      SELECT active_files, active_bytes, active_chunks, reserved_files, reserved_bytes, reserved_chunks
        INTO cur_files, cur_bytes, cur_chunks, cur_res_files, cur_res_bytes, cur_res_chunks
        FROM knowledge.kb_quotas WHERE owner_id = principal_owner;
      IF cur_files < release_files OR cur_bytes < release_bytes OR cur_chunks < release_chunks THEN
        RETURN 'VERSION_CONFLICT';
      END IF;
      delete_files := 0; delete_bytes := 0; delete_chunks := 0;
      has_active := document_row.active_version_id IS NOT NULL;
      IF has_active THEN
        SELECT * INTO version_row FROM knowledge.kb_versions
          WHERE owner_id = principal_owner AND id = document_row.active_version_id FOR SHARE;
        IF NOT FOUND THEN RETURN 'VERSION_CONFLICT'; END IF;
        SELECT * INTO build_row FROM knowledge.kb_builds
          WHERE owner_id = principal_owner AND id = document_row.active_build_id;
        IF NOT FOUND OR build_row.version_id IS DISTINCT FROM version_row.id THEN
          RETURN 'VERSION_CONFLICT';
        END IF;
        delete_files := 1;
        delete_bytes := version_row.size_bytes;
        delete_chunks := build_row.chunk_count;
      END IF;
      IF cur_files < delete_files OR cur_bytes < delete_bytes OR cur_chunks < delete_chunks
         OR cur_res_files < release_files OR cur_res_bytes < release_bytes
         OR cur_res_chunks < release_chunks THEN
        RETURN 'VERSION_CONFLICT';
      END IF;
      event_before := cur_bytes;
      event_after := cur_bytes - delete_bytes;

      -- owner序号在Quota锁下分配；拒绝历史容量断链/溢出，不通过钳零掩盖坏账。
      SELECT * INTO last_event FROM knowledge.kb_metering_events
        WHERE owner_id = principal_owner AND event_type = 'capacity_change'
        ORDER BY sequence DESC LIMIT 1;
      IF FOUND THEN
        IF last_event.active_bytes_after <> event_before
           OR last_event.sequence = 9223372036854775807 THEN
          RETURN 'VERSION_CONFLICT';
        END IF;
        next_sequence := last_event.sequence + 1;
        now_at := GREATEST(clock_timestamp(), last_event.occurred_at);
      ELSE
        IF event_before <> 0 THEN RETURN 'VERSION_CONFLICT'; END IF;
        next_sequence := 1;
        now_at := clock_timestamp();
      END IF;

      -- 删除事实行与事件按意图确定性派生；冲突即视为数据损坏。
      request_digest := sha256(convert_to('kb-delete:' || requested_intent || ':' || document_row.id::text, 'UTF8'));
      raw_bytes := substring(request_digest FROM 1 FOR 16);
      raw_bytes := set_byte(raw_bytes, 6, (get_byte(raw_bytes, 6) & 15) | 80);
      raw_bytes := set_byte(raw_bytes, 8, (get_byte(raw_bytes, 8) & 63) | 128);
      delete_operation := encode(raw_bytes, 'hex')::uuid;
      delete_idempotency := 'kb-delete:' || requested_intent || ':' || document_row.id::text;
      event_key := 'capacity:delete:' || requested_intent || ':' || document_row.id::text;
      IF EXISTS (SELECT 1 FROM knowledge.kb_operations
          WHERE owner_id = principal_owner
            AND (id = delete_operation
              OR knowledge.kb_operations.idempotency_key = delete_idempotency))
         OR EXISTS (SELECT 1 FROM knowledge.kb_metering_events
          WHERE owner_id = principal_owner
            AND (id = delete_operation OR logical_event_key = event_key)) THEN
        RETURN 'VERSION_CONFLICT';
      END IF;

      UPDATE knowledge.kb_quotas
        SET active_files = cur_files - delete_files,
            active_bytes = event_after,
            active_chunks = cur_chunks - delete_chunks,
            reserved_files = cur_res_files - release_files,
            reserved_bytes = cur_res_bytes - release_bytes,
            reserved_chunks = cur_res_chunks - release_chunks,
            updated_at = now_at
        WHERE owner_id = principal_owner;
      INSERT INTO knowledge.kb_metering_events
        (owner_id, id, logical_event_key, event_type, dimension, unit, quantity, usage_source,
         subject_kind, subject_key, sequence, active_bytes_before, active_bytes_after, payer, occurred_at)
        VALUES (principal_owner, delete_operation, event_key, 'capacity_change', 'storage', 'bytes',
                event_after, 'reconciled', 'capacity_change', document_row.id::text,
                next_sequence, event_before, event_after, 'platform', now_at);
      INSERT INTO knowledge.kb_operations
        (owner_id, id, document_id, idempotency_key, request_hash, kind, phase,
         expected_generation, created_at, updated_at)
        VALUES (principal_owner, delete_operation, document_row.id, delete_idempotency,
                request_digest, 'delete', 'deleting', document_row.generation, now_at, now_at);

      -- 墓碑本体：发布门按墓碑分支放行（deleting操作行在场、指针全清、代数+1）。
      UPDATE knowledge.kb_documents SET active_version_id = NULL, active_build_id = NULL,
          desired_operation_id = NULL, desired_version_id = NULL, deleted_at = now_at,
          generation = generation + 1, updated_at = now_at
        WHERE owner_id = principal_owner AND id = document_row.id;
      UPDATE knowledge.kb_operations SET phase = 'deleted', updated_at = now_at
        WHERE owner_id = principal_owner AND id = delete_operation;
    END LOOP;

    -- 空间/注销范围连带把空间置为deleted；文档范围不动空间状态。
    IF scope_kind <> 'document' THEN
      UPDATE knowledge.kb_spaces SET state = 'deleted', deleted_at = now_at, updated_at = now_at
        WHERE owner_id = principal_owner AND id = space_row.id;
    END IF;
  END LOOP;
  RETURN 'DELETED';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.apply_deletion_intent(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.apply_deletion_intent(text, text, uuid, uuid)
  TO knowledge_api, knowledge_worker, knowledge_migrator;

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
  -- 墓碑分支：独立删除意图已确认（deleting删除操作行在场且同代数），指针全清、
  -- deleted_at置位、代数+1，其余业务列不动；全部非删除操作必须已终态。
  -- 只有definer墓碑函数能以migrator身份走到这里，api/worker直写仍被拒绝。
  IF current_user = 'knowledge_migrator'
     AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
     AND NEW.active_version_id IS NULL AND NEW.active_build_id IS NULL
     AND NEW.desired_operation_id IS NULL AND NEW.desired_version_id IS NULL
     AND NEW.generation = OLD.generation + 1
     AND (to_jsonb(NEW) - ARRAY['active_version_id', 'active_build_id', 'desired_operation_id',
          'desired_version_id', 'deleted_at', 'generation', 'updated_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['active_version_id', 'active_build_id', 'desired_operation_id',
          'desired_version_id', 'deleted_at', 'generation', 'updated_at'])
     AND EXISTS (SELECT 1 FROM knowledge.kb_operations
       WHERE owner_id = OLD.owner_id AND document_id = OLD.id
         AND kind = 'delete' AND phase = 'deleting'
         AND expected_generation = OLD.generation)
     AND NOT EXISTS (SELECT 1 FROM knowledge.kb_operations pending
       WHERE pending.owner_id = OLD.owner_id AND pending.document_id = OLD.id
         AND pending.kind <> 'delete'
         AND pending.phase IN ('uploading', 'queued', 'parsing', 'indexing', 'publishing')) THEN
    RETURN NEW;
  END IF;
  IF (NEW.active_version_id, NEW.active_build_id)
     IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     OR NEW.generation <> OLD.generation + 1
     OR (NEW.title, NEW.purpose, NEW.tags, NEW.space_id, NEW.next_version_no,
         NEW.deleted_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.title, NEW.purpose, OLD.tags, NEW.space_id, OLD.next_version_no,
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
REVOKE ALL ON FUNCTION knowledge.guard_document_publish() FROM PUBLIC;
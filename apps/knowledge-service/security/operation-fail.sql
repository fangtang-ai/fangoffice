-- B5：attempt失败权威收敛（失败换绑定理）与owner过期位扫描。
-- 与取消同构：只释放逻辑预留，物理欠账与物理预留字节全部保留，由物理GC统一清算；
-- 失败收敛即证明旧代数不可复活，代数只推进一次，显式重试走reserve_retry_capacity新准入。
-- 独立增量，不修改任何已经应用的SQL或迁移快照。

-- 发布门的失败事实分支需要独立SQL事实函数（触发器表达式在分支选择前就检查EXECUTE权限）。
CREATE FUNCTION knowledge.has_failed_reservation(
  requested_owner text, requested_document uuid, requested_operation uuid,
  requested_version uuid, requested_generation bigint
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM knowledge.kb_operations pending
    JOIN knowledge.kb_reservations reservation ON reservation.owner_id = pending.owner_id
      AND reservation.operation_id = pending.id
    WHERE pending.owner_id = requested_owner AND pending.id = requested_operation
      AND pending.document_id = requested_document AND pending.target_version_id = requested_version
      AND pending.expected_generation = requested_generation AND pending.phase = 'failed'
      AND pending.error_code IS NOT NULL
      AND pending.kind IN ('upload', 'replace') AND reservation.document_id = requested_document
      AND reservation.expected_generation = requested_generation AND reservation.state = 'released'
      AND reservation.closed_at IS NOT NULL
  ) AND NOT EXISTS (
    SELECT 1 FROM knowledge.kb_builds
    WHERE owner_id = requested_owner AND operation_id = requested_operation
      AND status IN ('building', 'sealed')
  );
$function$;
REVOKE ALL ON FUNCTION knowledge.has_failed_reservation(text, uuid, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.has_failed_reservation(text, uuid, uuid, uuid, bigint)
  TO knowledge_worker;

-- worker上报当前attempt失败：只认绑定事实（build/job/retry三方一致），
-- 所有判断在锁定后取当前事实，不信任worker上报的任何陈旧状态。
-- 与取消共用Quota→Space→Document→Operation→Reservation→Builds锁序；
-- 物理计数与receipt一律不动：物理负债留给GC清算，receipt留给队列结算裁决。
CREATE FUNCTION knowledge.fail_current_build_attempt(
  requested_build uuid,
  requested_job uuid,
  requested_retry integer,
  requested_error text
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
  reported_error text := NULLIF(btrim(COALESCE(requested_error, '')), '');
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  IF requested_build IS NULL OR requested_job IS NULL OR requested_retry IS NULL
     OR requested_retry < 0 OR reported_error IS NULL
     OR char_length(reported_error) > 64 THEN RETURN 'INVALID_REQUEST'; END IF;

  SELECT * INTO quota_row FROM knowledge.kb_quotas
    WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = principal_owner AND id = requested_build;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = build_row.operation_id;
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
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = build_row.operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO reservation_row FROM knowledge.kb_reservations
    WHERE owner_id = principal_owner AND operation_id = build_row.operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'FORBIDDEN'; END IF;
  IF reservation_row.state = 'released' AND reservation_row.closed_at IS NOT NULL
     AND operation_row.phase = 'failed' AND operation_row.error_code IS NOT NULL THEN
    RETURN 'REPLAY';
  END IF;

  -- 绑定守卫：只收敛当前attempt，陈旧/未绑定的上报一律拒绝。
  IF operation_row.current_build_id IS DISTINCT FROM build_row.id
     OR operation_row.current_job_id IS DISTINCT FROM requested_job
     OR operation_row.current_retry_count IS DISTINCT FROM requested_retry
     OR operation_row.kind NOT IN ('upload', 'replace')
     OR operation_row.phase NOT IN ('queued', 'parsing', 'indexing')
     OR operation_row.document_id <> document_row.id
     OR operation_row.expected_generation <> document_row.generation THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF document_row.deleted_at IS NOT NULL
     OR document_row.desired_operation_id IS DISTINCT FROM operation_row.id
     OR document_row.desired_version_id IS DISTINCT FROM operation_row.target_version_id THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF reservation_row.state <> 'held'
     OR reservation_row.document_id <> document_row.id
     OR reservation_row.expected_generation <> document_row.generation
     OR reservation_row.base_version_id IS DISTINCT FROM document_row.active_version_id
     OR reservation_row.base_build_id IS DISTINCT FROM document_row.active_build_id THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF build_row.document_id <> document_row.id
     OR build_row.version_id IS DISTINCT FROM operation_row.target_version_id
     OR build_row.status NOT IN ('building', 'sealed')
     OR build_row.gc_state <> 'live' OR build_row.purged_at IS NOT NULL
     OR build_row.expected_generation <> document_row.generation THEN
    RETURN 'FORBIDDEN';
  END IF;

  -- 收敛与取消同构：预留只到released+closed（不 closed前不扣额），逻辑占额全量回吐，
  -- 全部attempt封停，operation.generation不动（重试准入以expected_generation=当前代-1为证）。
  UPDATE knowledge.kb_reservations SET state = 'released', closed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND operation_id = build_row.operation_id AND state = 'held';
  UPDATE knowledge.kb_quotas
    SET reserved_files = reserved_files - reservation_row.reserved_files,
        reserved_bytes = reserved_bytes - reservation_row.reserved_bytes,
        reserved_chunks = reserved_chunks - reservation_row.reserved_chunks,
        updated_at = clock_timestamp()
    WHERE owner_id = principal_owner;
  UPDATE knowledge.kb_builds SET status = 'invalidated'
    WHERE owner_id = principal_owner AND operation_id = build_row.operation_id
      AND status IN ('building', 'sealed');
  UPDATE knowledge.kb_operations SET phase = 'failed', error_code = reported_error,
      updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND id = build_row.operation_id;
  UPDATE knowledge.kb_documents SET desired_operation_id = NULL, desired_version_id = NULL,
      generation = generation + 1, updated_at = clock_timestamp()
    WHERE owner_id = principal_owner AND id = document_row.id;
  RETURN 'FAILED';
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.fail_current_build_attempt(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.fail_current_build_attempt(uuid, uuid, integer, text)
  TO knowledge_worker;

-- owner过期位扫描：只收敛未绑定attempt的过期位（uploading过期/排队解析索引但预留过期）。
-- 已绑定attempt的过期由队列结算(B6)裁决，这里绝不越权收敛。
-- 锁序与取消/失败收敛一致：Quota一次，然后按operation id逐个Space→Document→Operation→
-- Reservation→Builds；并发失败上报先抢Quota，跨连接无死锁。
CREATE FUNCTION knowledge.expire_owner_stale_operations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  converged integer := 0;
  candidate uuid;
  converge_error text;
  space_row knowledge.kb_spaces%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
  reservation_row knowledge.kb_reservations%ROWTYPE;
BEGIN
  IF principal_owner IS NULL THEN RETURN 0; END IF;
  PERFORM 1 FROM knowledge.kb_quotas WHERE owner_id = principal_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR candidate IN
    SELECT operation.id
      FROM knowledge.kb_operations operation
      JOIN knowledge.kb_documents document ON document.owner_id = operation.owner_id
        AND document.id = operation.document_id
      LEFT JOIN knowledge.kb_reservations reservation ON reservation.owner_id = operation.owner_id
        AND reservation.operation_id = operation.id
      WHERE operation.owner_id = principal_owner
        AND document.desired_operation_id = operation.id
        AND document.deleted_at IS NULL
        AND (
          (operation.phase = 'uploading' AND operation.upload_expires_at IS NOT NULL
             AND operation.upload_expires_at <= clock_timestamp())
          OR (operation.phase IN ('queued', 'parsing', 'indexing')
             AND operation.current_build_id IS NULL
             AND reservation.expires_at <= clock_timestamp())
        )
      ORDER BY operation.id
  LOOP
    -- 逐行重取锁定后的事实并复核守卫；任何守卫失配只跳过该行。
    SELECT * INTO space_row FROM knowledge.kb_spaces
      WHERE owner_id = principal_owner AND id = (
        SELECT document_row2.space_id FROM knowledge.kb_documents document_row2
          JOIN knowledge.kb_operations operation_row2
            ON operation_row2.owner_id = document_row2.owner_id
           AND operation_row2.document_id = document_row2.id
          WHERE operation_row2.owner_id = principal_owner AND operation_row2.id = candidate)
      FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO document_row FROM knowledge.kb_documents
      WHERE owner_id = principal_owner AND space_id = space_row.id
        AND id = (
          SELECT document_id FROM knowledge.kb_operations
            WHERE owner_id = principal_owner AND id = candidate)
      FOR UPDATE;
    IF NOT FOUND OR document_row.deleted_at IS NOT NULL THEN CONTINUE; END IF;
    SELECT * INTO operation_row FROM knowledge.kb_operations
      WHERE owner_id = principal_owner AND id = candidate FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF document_row.desired_operation_id IS DISTINCT FROM operation_row.id
       OR operation_row.document_id <> document_row.id
       OR operation_row.expected_generation <> document_row.generation
       OR document_row.desired_version_id IS DISTINCT FROM operation_row.target_version_id THEN
      CONTINUE;
    END IF;
    SELECT * INTO reservation_row FROM knowledge.kb_reservations
      WHERE owner_id = principal_owner AND operation_id = candidate FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF operation_row.phase = 'uploading' THEN
      IF operation_row.current_build_id IS NOT NULL
         OR operation_row.upload_expires_at IS NULL
         OR operation_row.upload_expires_at > clock_timestamp()
         OR reservation_row.state <> 'held' THEN CONTINUE; END IF;
      converge_error := 'UPLOAD_EXPIRED';
    ELSE
      IF operation_row.phase NOT IN ('queued', 'parsing', 'indexing')
         OR operation_row.current_build_id IS NOT NULL
         OR reservation_row.state <> 'held'
         OR reservation_row.expires_at > clock_timestamp() THEN CONTINUE; END IF;
      converge_error := 'RESERVATION_EXPIRED';
    END IF;
    IF reservation_row.document_id <> document_row.id
       OR reservation_row.expected_generation <> document_row.generation
       OR reservation_row.base_version_id IS DISTINCT FROM document_row.active_version_id
       OR reservation_row.base_build_id IS DISTINCT FROM document_row.active_build_id THEN
      CONTINUE;
    END IF;

    PERFORM id FROM knowledge.kb_builds
      WHERE owner_id = principal_owner AND operation_id = candidate
      ORDER BY id FOR UPDATE;
    UPDATE knowledge.kb_reservations SET state = 'released', closed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE owner_id = principal_owner AND operation_id = candidate AND state = 'held';
    UPDATE knowledge.kb_quotas
      SET reserved_files = reserved_files - reservation_row.reserved_files,
          reserved_bytes = reserved_bytes - reservation_row.reserved_bytes,
          reserved_chunks = reserved_chunks - reservation_row.reserved_chunks,
          updated_at = clock_timestamp()
      WHERE owner_id = principal_owner;
    UPDATE knowledge.kb_builds SET status = 'invalidated'
      WHERE owner_id = principal_owner AND operation_id = candidate
        AND status IN ('building', 'sealed');
    UPDATE knowledge.kb_operations SET phase = 'failed', error_code = converge_error,
        updated_at = clock_timestamp()
      WHERE owner_id = principal_owner AND id = candidate;
    UPDATE knowledge.kb_documents SET desired_operation_id = NULL, desired_version_id = NULL,
        generation = generation + 1, updated_at = clock_timestamp()
      WHERE owner_id = principal_owner AND id = document_row.id;
    converged := converged + 1;
  END LOOP;
  RETURN converged;
END;
$function$;
REVOKE ALL ON FUNCTION knowledge.expire_owner_stale_operations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.expire_owner_stale_operations() TO knowledge_worker;

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
  -- 失败分支：attempt失败收敛已确认（failed操作行在场且error_code非空），指针全清、
  -- 代数+1，其余业务列不动；旧代数不可复活，显式重试走reserve_retry_capacity新准入。
  IF current_user = 'knowledge_migrator'
     AND (NEW.active_version_id, NEW.active_build_id)
         IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     AND NEW.generation = OLD.generation + 1
     AND OLD.desired_operation_id IS NOT NULL AND OLD.desired_version_id IS NOT NULL
     AND NEW.desired_operation_id IS NULL AND NEW.desired_version_id IS NULL
     AND (to_jsonb(NEW) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['desired_operation_id', 'desired_version_id', 'generation', 'updated_at'])
     AND knowledge.has_failed_reservation(
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

-- 失败收敛与取消收敛同构（预留released+closed、全部attempt封停、error_code在场），
-- 显式重试准入以同样的事实验证上一代不可复活；旧物理负债仍不抵扣。
CREATE OR REPLACE FUNCTION knowledge.reserve_retry_capacity(
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

  -- 正代数本身不是取消证明；上一代必须已完整撤意图、关闭预留并封停全部attempt
  -- （取消以phase=cancelled在场证明，失败以phase=failed且error_code非空在场证明）。
  IF NOT EXISTS (
    SELECT 1 FROM knowledge.kb_operations prior_operation
    JOIN knowledge.kb_reservations prior_reservation
      ON prior_reservation.owner_id = prior_operation.owner_id
      AND prior_reservation.operation_id = prior_operation.id
    WHERE prior_operation.owner_id = principal_owner
      AND prior_operation.document_id = document_row.id AND prior_operation.id <> requested_operation
      AND prior_operation.expected_generation = document_row.generation - 1
      AND prior_operation.kind = 'upload'
      AND prior_operation.phase IN ('cancelled', 'failed')
      AND (prior_operation.phase = 'cancelled' OR prior_operation.error_code IS NOT NULL)
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
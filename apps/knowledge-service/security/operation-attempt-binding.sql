-- B6.3 current-attempt 持久绑定：把 operation 的当前队列 attempt（job、
-- retry、build、receipt）作为事实持久化在 kb_operations 上，认领路径
-- CAS 绑定，发布路径复核绑定，阻止同一 operation 被第二个 build 认领
-- 或绕过认领直接激活。
-- 绑定唯一窄入口是 bind_operation_attempt：worker 对 kb_operations 没有
-- 任何 UPDATE 权限（build-publish 只授过 phase 且被 worker-phase-lock
-- 收回，本切片不再新授列权限），全部写入经 SECURITY DEFINER 完成。
-- 锁序：调用点在 claim 的 kb_builds INSERT 之后（取消门触发器已按
-- Quota→Space→Document→Operation→Reservation→Build 持有行锁），本函数
-- 只触及已锁定的 operation 行，不新引入锁。

CREATE FUNCTION knowledge.bind_operation_attempt(
  requested_owner text,
  requested_operation uuid,
  requested_build uuid,
  requested_job uuid,
  requested_retry integer,
  requested_receipt uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $function$
DECLARE
  principal_owner text := NULLIF(current_setting('knowledge.owner_id', true), '');
  bound uuid;
BEGIN
  IF principal_owner IS NULL THEN
    RETURN 'UNAUTHENTICATED';
  END IF;
  -- owner 分量错误与行不存在同样返回 NOT_FOUND，不泄露存在性。
  IF requested_owner IS DISTINCT FROM principal_owner THEN
    RETURN 'NOT_FOUND';
  END IF;
  -- CAS：空绑定→绑定本次 attempt；已绑定为同一 attempt→幂等复核；
  -- 绑定其他 attempt→0 行（换绑必须走显式收敛切片，认领路径绝不静默换绑）。
  UPDATE knowledge.kb_operations
     SET current_job_id = requested_job, current_retry_count = requested_retry,
         current_build_id = requested_build, current_receipt_id = requested_receipt,
         updated_at = clock_timestamp()
   WHERE owner_id = principal_owner AND id = requested_operation
     AND phase IN ('queued', 'parsing', 'indexing')
     AND ((current_job_id IS NULL AND current_retry_count IS NULL
           AND current_build_id IS NULL AND current_receipt_id IS NULL)
       OR (current_job_id = requested_job AND current_retry_count = requested_retry
           AND current_build_id = requested_build AND current_receipt_id = requested_receipt))
  RETURNING current_build_id INTO bound;
  IF bound IS NULL THEN
    RETURN 'FORBIDDEN';
  END IF;
  RETURN 'BOUND';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.bind_operation_attempt(text, uuid, uuid, uuid, integer, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.bind_operation_attempt(text, uuid, uuid, uuid, integer, uuid)
  TO knowledge_worker;

-- 发布门（取代 build-publish.sql 首版）：在 attempt 窗口校验之后追加
-- B6.3 绑定校验——desired operation 的 current attempt 必须存在且与
-- 待发布构建一致。正常认领路径在 kb_builds INSERT 后立即绑定，因此
-- 任何到达发布阶段的 operation 都应有绑定；未绑定或指向其他
-- build/job/retry 的发布（绕过认领的直写/未来旁路）一律拒绝。

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
  -- 激活指针与代数都没动：普通元数据写与 desired-only 的 admission 写
  -- （gate 2 未实施前的夹具/未来 API 授权路径）不进入发布门。
  IF (NEW.active_version_id, NEW.active_build_id, NEW.generation)
     IS NOT DISTINCT FROM
     (OLD.active_version_id, OLD.active_build_id, OLD.generation) THEN
    RETURN NEW;
  END IF;

  -- 发布形态：指针必须真实移动，generation 恰好 +1，其余业务列不动
  -- （updated_at 是写入方管理的时间戳，不在约束面内）。
  IF (NEW.active_version_id, NEW.active_build_id)
     IS NOT DISTINCT FROM (OLD.active_version_id, OLD.active_build_id)
     OR NEW.generation <> OLD.generation + 1
     OR (NEW.title, NEW.purpose, NEW.tags, NEW.space_id, NEW.next_version_no,
         NEW.deleted_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.title, NEW.purpose, OLD.tags, OLD.space_id, OLD.next_version_no,
         OLD.deleted_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Active pointer changes must publish the desired build'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;

  -- 没有 admission 排队的发布请求（含重复发布后的残留指针写）不可发布。
  IF OLD.desired_operation_id IS NULL OR OLD.desired_version_id IS NULL THEN
    RAISE EXCEPTION 'Publication requires a pending desired operation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;

  -- 当前 owner/space/document 状态：owner active、space active、文档未删除。
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

  -- 构建有效性：desired 指向的同一构建、封存、live、未清除、同代数、
  -- 同 owner 当前激活的索引 profile。
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

  -- attempt 窗口：desired operation 仍处于可发布阶段且种类合法。
  SELECT * INTO operation FROM knowledge.kb_operations
    WHERE owner_id = OLD.owner_id AND id = OLD.desired_operation_id;
  IF NOT FOUND OR operation.kind NOT IN ('upload', 'replace', 'rebuild')
     OR operation.phase NOT IN ('indexing', 'publishing') THEN
    RAISE EXCEPTION 'Publication requires the desired operation inside the publish window'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;

  -- B6.3 绑定校验：operation 的 current attempt 绑定必须存在且与待发布
  -- 构建一致（同一 job/retry/build 身份）。
  IF operation.current_job_id IS NULL OR operation.current_retry_count IS NULL
     OR operation.current_build_id IS NULL OR operation.current_receipt_id IS NULL
     OR operation.current_build_id <> build.id
     OR operation.current_job_id <> build.job_id
     OR operation.current_retry_count <> build.retry_count THEN
    RAISE EXCEPTION 'Publication requires the operation''s current attempt binding'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_document_publish_gate';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.guard_document_publish() FROM PUBLIC;

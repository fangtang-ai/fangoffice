-- B6.4 队列重试换绑：pg-boss 对同一 job 的失败重投递产生 retryCount+1 的新
-- attempt（B4 既有语义：旧 attempt 结算被拒、租约丢失的 handler 被中止）。
-- 认领路径的取消门（本文件 OR REPLACE 的重试分支）允许 worker 在 operation
-- 仍绑定"同 job 前一重试"时插入新构建行；本文件新增的 rebind_operation_attempt
-- 是唯一的绑定转移入口。不在此作废旧构建行：绑定转移本身冻结其内容写入与
-- 封存（内容门禁/封存都要求 current attempt），遗留构建行与物理欠账由 GC
-- 切片清算。自动重试不释放预留（kb_reservations 保持 held）、不推进
-- generation；业务失败收敛仍走 fail_current_build_attempt，认领路径绝不静默换绑。

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
          AND current_job_id = NEW.job_id AND current_retry_count = NEW.retry_count)
          OR (current_job_id = NEW.job_id
            AND current_retry_count = NEW.retry_count - 1));
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

CREATE FUNCTION knowledge.rebind_operation_attempt(
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
  build_row knowledge.kb_builds%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
  receipt_status text;
  lock_status text;
  moved uuid;
BEGIN
  IF principal_owner IS NULL THEN RETURN 'UNAUTHENTICATED'; END IF;
  -- owner 分量错误与行不存在同样返回 NOT_FOUND，不泄露存在性。
  IF requested_owner IS DISTINCT FROM principal_owner THEN RETURN 'NOT_FOUND'; END IF;
  -- 重投递的 attempt 至少是 retry 1；空绑定/同 attempt 的认领走 bind 入口。
  IF requested_operation IS NULL OR requested_build IS NULL OR requested_job IS NULL
     OR requested_retry IS NULL OR requested_retry < 1 OR requested_receipt IS NULL THEN
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
  -- 行已在父锁序内锁定；读取当前绑定并在同一行锁下分类转移形态。
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = principal_owner AND id = requested_operation;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF operation_row.document_id <> build_row.document_id
     OR operation_row.target_version_id IS DISTINCT FROM build_row.version_id
     OR operation_row.expected_generation <> build_row.expected_generation THEN
    RETURN 'NOT_FOUND';
  END IF;
  IF operation_row.phase NOT IN ('queued', 'parsing', 'indexing') THEN
    RETURN 'FORBIDDEN';
  END IF;
  -- 空绑定（B6.3 check保证四列同空）：没有可转移的旧attempt，走 bind 入口。
  IF operation_row.current_build_id IS NULL THEN RETURN 'FORBIDDEN'; END IF;
  -- 幂等重放：绑定已是本次attempt（唯一键保证同job/retry只有一行构建）。
  IF operation_row.current_build_id = requested_build
     AND operation_row.current_job_id = requested_job
     AND operation_row.current_retry_count = requested_retry THEN
    RETURN 'REPLAYED';
  END IF;
  -- 合法转移：同job、retry恰好-1；其余绑定形态（换job/跳重试/同retry换build）拒绝。
  IF operation_row.current_job_id IS DISTINCT FROM requested_job
     OR operation_row.current_retry_count <> requested_retry - 1 THEN
    RETURN 'FORBIDDEN';
  END IF;
  -- 旧构建必须仍是被队列放弃但未业务收敛的building行；已封存/作废的旧
  -- attempt不允许出现重投递认领。
  IF NOT EXISTS (
    SELECT 1 FROM knowledge.kb_builds
     WHERE owner_id = principal_owner AND id = operation_row.current_build_id
       AND operation_id = requested_operation
       AND job_id = operation_row.current_job_id
       AND retry_count = operation_row.current_retry_count
       AND status = 'building' AND gc_state = 'live'
  ) THEN
    RETURN 'FORBIDDEN';
  END IF;
  UPDATE knowledge.kb_operations
     SET current_job_id = requested_job, current_retry_count = requested_retry,
         current_build_id = requested_build, current_receipt_id = requested_receipt
   WHERE owner_id = principal_owner AND id = requested_operation
     AND document_id = operation_row.document_id
     AND target_version_id = operation_row.target_version_id
     AND expected_generation = operation_row.expected_generation
     AND phase IN ('queued', 'parsing', 'indexing')
     AND current_build_id = operation_row.current_build_id
     AND current_job_id = operation_row.current_job_id
     AND current_retry_count = operation_row.current_retry_count
  RETURNING current_build_id INTO moved;
  IF moved IS NULL THEN RETURN 'FORBIDDEN'; END IF;
  RETURN 'REBOUND';
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.rebind_operation_attempt(text, uuid, uuid, uuid, integer, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.rebind_operation_attempt(text, uuid, uuid, uuid, integer, uuid)
  TO knowledge_worker;
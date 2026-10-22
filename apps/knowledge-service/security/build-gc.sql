-- B7物理GC：终结对象（operation已收敛、build非活动）的封存推进与物理负债清算。
-- 账本不变量：失败/取消/墓碑/过期路径只退逻辑预留，physical_reserved_bytes残留即物理负债；
-- 发布转正把physical_reserved计入physical_accounted。GC确认对象移除后按预留状态分别出账，
-- 幂等重放不重复清算；绝不触碰删除协议事实（documents.deleted_at与delete操作行），
-- 也不推进版本/原文对象的gc_state（对象级对账属后续切片）。
CREATE FUNCTION knowledge.collect_purged_build(
  requested_owner text, requested_build uuid, requested_time timestamp with time zone
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
SET row_security = on
AS $function$
DECLARE
  owner_key text;
  build_row knowledge.kb_builds%ROWTYPE;
  operation_row knowledge.kb_operations%ROWTYPE;
  document_row knowledge.kb_documents%ROWTYPE;
  space_row knowledge.kb_spaces%ROWTYPE;
  reservation_row knowledge.kb_reservations%ROWTYPE;
BEGIN
  -- GC维护路径：收敛owner由授权的knowledge_gc调用给定，事务级本地绑定后RLS照常生效。
  IF requested_owner IS NULL OR btrim(requested_owner) = '' OR requested_build IS NULL
     OR requested_time IS NULL THEN RETURN 'INVALID_REQUEST'; END IF;
  owner_key := btrim(requested_owner);
  PERFORM set_config('knowledge.owner_id', owner_key, true);

  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = owner_key AND id = requested_build;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF build_row.gc_state = 'purged' THEN RETURN 'REPLAY'; END IF;

  -- 与准入/取消统一锁序：Quota→Space→Document→Operation→Reservation→Build。
  PERFORM 1 FROM knowledge.kb_quotas WHERE owner_id = owner_key FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = owner_key AND id = build_row.operation_id;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = owner_key AND id = operation_row.document_id;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO space_row FROM knowledge.kb_spaces
    WHERE owner_id = owner_key AND id = document_row.space_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO document_row FROM knowledge.kb_documents
    WHERE owner_id = owner_key AND id = operation_row.document_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO operation_row FROM knowledge.kb_operations
    WHERE owner_id = owner_key AND id = build_row.operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  SELECT * INTO reservation_row FROM knowledge.kb_reservations
    WHERE owner_id = owner_key AND operation_id = build_row.operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'FORBIDDEN'; END IF;
  SELECT * INTO build_row FROM knowledge.kb_builds
    WHERE owner_id = owner_key AND id = requested_build FOR UPDATE;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  IF build_row.gc_state = 'purged' THEN RETURN 'REPLAY'; END IF;

  -- 只有operation终结后的非活动build才可清算：正在服务的active build与仍在
  -- 上传/解析/索引/发布/删除中的对象一律拒绝，worker认领门也依赖gc_state=live。
  IF operation_row.phase NOT IN ('ready', 'failed', 'cancelled', 'deleted')
     OR build_row.document_id <> document_row.id THEN
    RETURN 'FORBIDDEN';
  END IF;
  IF document_row.deleted_at IS NULL
     AND document_row.active_build_id = build_row.id THEN
    RETURN 'FORBIDDEN';
  END IF;

  -- 防御性收敛：op终结但预留仍held的孤儿先释放（正常路径已由失败/取消/墓碑收敛）。
  IF reservation_row.state = 'held' THEN
    UPDATE knowledge.kb_reservations SET state = 'released', closed_at = requested_time,
        updated_at = requested_time
      WHERE owner_id = owner_key AND operation_id = build_row.operation_id AND state = 'held';
    reservation_row.state := 'released';
  END IF;

  -- 物理出账：发布转正的负债在accounted里，失败/取消/墓碑/过期的负债残留在
  -- physical_reserved里；两条路径互斥且每条预留只清算一次（幂等由REPLAY守卫）。
  IF reservation_row.state = 'applied' THEN
    UPDATE knowledge.kb_quotas
      SET physical_accounted_bytes = physical_accounted_bytes
            - reservation_row.physical_reserved_bytes,
          updated_at = requested_time
      WHERE owner_id = owner_key;
  ELSE
    UPDATE knowledge.kb_quotas
      SET physical_reserved_bytes = physical_reserved_bytes
            - reservation_row.physical_reserved_bytes,
          updated_at = requested_time
      WHERE owner_id = owner_key;
  END IF;

  -- guard_build_state保证单向封存：purged不可回退，封存快照（manifest等）不变。
  UPDATE knowledge.kb_builds SET status = 'purged', gc_state = 'purged',
      purged_at = requested_time
    WHERE owner_id = owner_key AND id = requested_build;
  RETURN 'PURGED';
END;
$function$;

-- GC是独立授权路径：仅knowledge_gc可调用，worker/api/public一律拒绝。
REVOKE ALL ON FUNCTION knowledge.collect_purged_build(text, uuid, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.collect_purged_build(text, uuid, timestamp with time zone)
  TO knowledge_gc;
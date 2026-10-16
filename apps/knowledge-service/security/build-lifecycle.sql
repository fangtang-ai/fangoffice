-- B6 构建生命周期门：认领（INSERT）+ 有效封存（受控 UPDATE）。
-- 内容写入沿用 build-content.sql 的 append-only 触发器；这里新增
-- SECURITY INVOKER 校验触发器与最小列级语句面。任何写都在运行时角色
-- 的 FORCE RLS 视界内发生，函数只做校验，不提权。

CREATE FUNCTION knowledge.guard_build_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  operation knowledge.kb_operations%ROWTYPE;
BEGIN
  IF NEW.status <> 'building' OR NEW.gc_state <> 'live'
     OR NEW.sealed_at IS NOT NULL OR NEW.manifest IS NOT NULL
     OR NEW.manifest_hash IS NOT NULL THEN
    RAISE EXCEPTION 'Claim must insert an open building identity'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_claim_gate';
  END IF;

  -- 认领行必须逐字段落到可信 operation 事实上。不使用 FOR SHARE：
  -- 锁子句要求 UPDATE 特权（PG 文档 ddl-priv.html），会把运行时角色抬到
  -- 写 operation 的位置；认领校验的是 INSERT 时点事实，行间竞争由后续
  -- 封存/发布阶段的 FOR UPDATE 锁处理。
  SELECT * INTO operation FROM knowledge.kb_operations
    WHERE owner_id = NEW.owner_id AND id = NEW.operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim references an unknown operation'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_claim_gate';
  END IF;
  IF NEW.document_id <> operation.document_id
     OR NEW.version_id IS DISTINCT FROM operation.target_version_id
     OR NEW.expected_generation <> operation.expected_generation
     OR operation.phase NOT IN ('queued', 'parsing', 'indexing') THEN
    RAISE EXCEPTION 'Claim does not match the operation facts'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_claim_gate';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.guard_build_claim() FROM PUBLIC;

CREATE FUNCTION knowledge.guard_build_seal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.status = 'building' AND NEW.status = 'sealed' THEN
    -- 初始封存协议：manifest 必须是非空 jsonb 对象，封存时间必须落定；
    -- manifest_hash 与三项计数一律由数据库按实况计算，不接受写入方声明。
    IF NEW.sealed_at IS NULL OR NEW.manifest IS NULL
       OR jsonb_typeof(NEW.manifest) <> 'object' THEN
      RAISE EXCEPTION 'Sealing requires a manifest object and a seal time'
        USING ERRCODE = '23514', CONSTRAINT = 'kb_build_seal_gate';
    END IF;
    NEW.manifest_hash := sha256(convert_to(NEW.manifest::text, 'UTF8'));
    SELECT u.n, c.n, e.n INTO NEW.source_unit_count, NEW.chunk_count, NEW.embedding_count
      FROM (SELECT count(*) AS n FROM knowledge.kb_source_units
             WHERE owner_id = NEW.owner_id AND build_id = NEW.id) u,
           (SELECT count(*) AS n FROM knowledge.kb_chunks
             WHERE owner_id = NEW.owner_id AND build_id = NEW.id) c,
           (SELECT count(*) AS n FROM knowledge.kb_chunk_embeddings
             WHERE owner_id = NEW.owner_id AND build_id = NEW.id) e;
    RETURN NEW;
  END IF;

  -- building 行上除封存转换外的任何快照列改动都是计数/哈希改写，拒绝。
  IF OLD.status = 'building'
     AND (NEW.manifest, NEW.manifest_hash, NEW.sealed_at,
          NEW.source_unit_count, NEW.chunk_count, NEW.embedding_count)
         IS DISTINCT FROM
         (OLD.manifest, OLD.manifest_hash, OLD.sealed_at,
          OLD.source_unit_count, OLD.chunk_count, OLD.embedding_count) THEN
    RAISE EXCEPTION 'Build snapshot columns may only change when sealing'
      USING ERRCODE = '23514', CONSTRAINT = 'kb_build_seal_gate';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.guard_build_seal() FROM PUBLIC;

CREATE TRIGGER kb_build_claim BEFORE INSERT ON knowledge.kb_builds
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_claim();

CREATE TRIGGER kb_build_seal BEFORE UPDATE ON knowledge.kb_builds
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_build_seal();

-- 语句面：worker 只获得认领 INSERT、受控内容 INSERT 与封存 UPDATE；
-- manifest_hash 永远不出现在写入方手里，由 guard_build_seal 计算。
GRANT INSERT (owner_id, id, document_id, version_id, operation_id, job_id, retry_count,
  expected_generation, index_profile_id, parser_revision, parser_snapshot)
  ON knowledge.kb_builds TO knowledge_worker;
GRANT UPDATE (manifest, source_unit_count, chunk_count, embedding_count, sealed_at, status)
  ON knowledge.kb_builds TO knowledge_worker;
GRANT INSERT (owner_id, build_id, id, parent_id, ordinal, type, text, text_hash,
  locator, coverage, warnings)
  ON knowledge.kb_source_units TO knowledge_worker;
GRANT INSERT (owner_id, build_id, id, ordinal, text, text_hash, token_count, search_vector)
  ON knowledge.kb_chunks TO knowledge_worker;
GRANT INSERT (owner_id, build_id, chunk_id, span_no, source_unit_id, start_cp, end_cp, mapping)
  ON knowledge.kb_chunk_sources TO knowledge_worker;
GRANT INSERT (owner_id, build_id, chunk_id, embedding, embedded_text_hash)
  ON knowledge.kb_chunk_embeddings TO knowledge_worker;

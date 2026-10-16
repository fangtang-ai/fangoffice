-- B7 发布门：封存构建的 active-pointer 发布是唯一合法的激活形态。
-- desired 指针的写入属于 admission（gate 2，另门）；这里只约束
-- active_version_id/active_build_id/generation 的变更：必须把指针真实
-- 移动到 desired 指向的封存构建上，owner/space/document 处于 active，
-- profile 与代数仍然匹配。任何写都在运行时角色的 FORCE RLS 视界内
-- 发生，函数只做校验，不提权。

CREATE FUNCTION knowledge.guard_document_publish()
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
        (OLD.title, OLD.purpose, OLD.tags, OLD.space_id, OLD.next_version_no,
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

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION knowledge.guard_document_publish() FROM PUBLIC;

CREATE TRIGGER kb_document_publish BEFORE UPDATE ON knowledge.kb_documents
FOR EACH ROW EXECUTE FUNCTION knowledge.guard_document_publish();

-- 语句面：worker 只获得发布三列的 UPDATE；desired 列永远不在写入方手里
-- （admission 授权属 gate 2），phase 推进只用于发布窗口。
GRANT UPDATE (active_version_id, active_build_id, generation)
  ON knowledge.kb_documents TO knowledge_worker;
GRANT UPDATE (phase) ON knowledge.kb_operations TO knowledge_worker;